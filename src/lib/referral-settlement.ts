/**
 * WHAT `payment.succeeded` COMMITS (spec v1.4 §6.2, operator rulings 6 and 7).
 *
 * By the time this runs the money has already moved. The mint decided the split and folded our
 * take and the referrer's take into ONE `application_fee_amount` collected on the parent company —
 * Whop has no second application fee and no account-level split. This step does three things and
 * deliberately no more:
 *
 *   1. commits the attribution decision the MINT took (never re-derives it);
 *   2. records the referrer's share as a ledger debt, so it can be settled later by a parent →
 *      sibling transfer and reconciled against `GET /api/v1/payments/{id}/fees`;
 *   3. records the application fee itself, which is what makes the ledger checkable rather than
 *      decorative.
 *
 * ⚠️ NOTHING HERE SENDS EMAIL AND NOTHING HERE CALLS WHOP. Whop retries a webhook 3× over ~70 s
 * and then drops the event permanently, so the handler must acknowledge fast. The referrer's
 * "you have money waiting" notice and the transfer itself both fire from the sweep.
 *
 * ⚠️ EVERY WRITE IS AN UPSERT ON A UNIQUE KEY. Whop redelivers this event; a second ledger row is
 * a second payout. The database refuses it rather than the handler remembering to check.
 */

import { holdExpiry } from './attribution-term';
import { hashClientEmail, recordAttributedClient } from './attributed-clients';

/** STRUCTURAL — see the note on `attributed-clients.ts`'s `Db`. */
export type SettlementDb = {
  attributedClient: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    upsert(args: any): Promise<unknown>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findUnique(args: any): Promise<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateMany(args: any): Promise<{ count: number }>;
  };
  bookingFeeSnapshot: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findUnique(args: any): Promise<any>;
  };
  practitioner: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findUnique(args: any): Promise<any>;
  };
  referralLedgerEntry: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    upsert(args: any): Promise<any>;
  };
  feeLedgerEntry: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    upsert(args: any): Promise<any>;
  };
  referralTouch: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateMany(args: any): Promise<{ count: number }>;
  };
};

type FeeSnapshotRow = {
  attributionOwner: string;
  isCrossReferral: boolean;
  priceUsdCents: number;
  nhpFeeUsdCents: number;
  referrerFeeBps: number;
  referrerShareUsdCents: number;
  referrerPractitionerId: string | null;
  applicationFeeUsdCents: number;
} | null;

export type CommitResult = {
  owner: 'PRACTITIONER' | 'NHP';
  referrerShareUsdCents: number;
  /** PAYABLE | HELD, or null when nothing was owed to a referrer. */
  referralState: 'PAYABLE' | 'HELD' | null;
};

/**
 * Can this referrer actually receive money today?
 *
 * Both halves are required. A connected company with payouts disabled cannot be transferred to,
 * and `whopPayoutsEnabled` is the WEBHOOK-authoritative value — Whop's REST read under-reports it,
 * so re-deriving this from a live API call would hold money that is perfectly payable.
 */
function isPayable(referrer: { whopCompanyId?: string | null; whopPayoutsEnabled?: boolean | null } | null): boolean {
  return !!referrer?.whopCompanyId && referrer.whopPayoutsEnabled === true;
}

export async function commitPaymentAttribution(
  db: SettlementDb,
  input: {
    bookingIntentId: string;
    practitionerId: string;
    email: string;
    party?: 'PRACTITIONER' | 'NHP' | null;
    source?: string | null;
    referralTouchId?: string | null;
    termMonths: number;
    holdDays: number;
    /** The term's anchor — the first booked session's scheduled start, or the payment instant. */
    sessionStartsAt: Date;
    paidAt: Date;
    whopPaymentId?: string | null;
  },
): Promise<CommitResult> {
  const emailHash = hashClientEmail(input.email);

  const snapshot = (await db.bookingFeeSnapshot.findUnique({
    where: { bookingIntentId: input.bookingIntentId },
    select: {
      attributionOwner: true,
      isCrossReferral: true,
      priceUsdCents: true,
      nhpFeeUsdCents: true,
      referrerFeeBps: true,
      referrerShareUsdCents: true,
      referrerPractitionerId: true,
      applicationFeeUsdCents: true,
    },
  })) as FeeSnapshotRow;

  // A missing snapshot is REACHABLE, not a bug: the §8 hosted-checkout fallback mints no
  // per-booking configuration, so a real payment can arrive with nothing recorded at mint. The
  // claim must still be written — without it the term never starts and the client is charged the
  // platform share indefinitely — so this degrades to "NHP-sourced, no referrer" rather than
  // skipping. Nothing is paid out on a fee we cannot prove was collected.
  const owner: 'PRACTITIONER' | 'NHP' =
    snapshot?.attributionOwner === 'PRACTITIONER' ? 'PRACTITIONER' : 'NHP';
  const referrerPractitionerId = snapshot?.referrerPractitionerId ?? null;
  const referrerShareUsdCents = snapshot?.referrerShareUsdCents ?? 0;

  await recordAttributedClient(db, {
    practitionerId: input.practitionerId,
    email: input.email,
    party: input.party ?? null,
    source: input.source ?? null,
    bookingIntentId: input.bookingIntentId,
    termMonths: input.termMonths,
    sessionStartsAt: input.sessionStartsAt,
    referrerPractitionerId,
    owner,
    decidedByRule: snapshot ? 'MINT_SNAPSHOT' : 'NHP_SOURCED_NO_SNAPSHOT',
    referralTouchId: input.referralTouchId ?? null,
    at: input.paidAt,
  });

  // ATTACH THE CLIENT TO THE TOUCH. A copied link is opened by an anonymous visitor, so the touch
  // exists with no email. Filtering on `clientEmailHash: null` is the lock: one link can reach
  // several clients, and the FIRST one to pay through a given touch owns it. Without the filter a
  // later buyer on the same touch row would overwrite whose booking it recorded.
  if (input.referralTouchId) {
    await db.referralTouch.updateMany({
      where: { id: input.referralTouchId, clientEmailHash: null },
      // `receivedAt` is NOT set here. It was written when the link was opened (§5.4: "received_at
      // = opened_at", because a copied link is tied to nobody until somebody opens it) and it is
      // immutable — the earliest-touch lock compares Y's list entry against it, so moving it
      // forward at payment time would retro-exempt a client Y listed after the introduction.
      data: {
        clientEmail: input.email,
        clientEmailHash: emailHash,
        status: 'BOOKED',
      },
    });
  }

  let referralState: 'PAYABLE' | 'HELD' | null = null;

  if (referrerPractitionerId && referrerShareUsdCents > 0) {
    const referrer = await db.practitioner.findUnique({
      where: { id: referrerPractitionerId },
      select: { id: true, whopCompanyId: true, whopPayoutsEnabled: true },
    });
    const payable = isPayable(referrer);
    referralState = payable ? 'PAYABLE' : 'HELD';

    // RULING 6 — an unpayable referrer changes WHERE the money sits, never HOW MUCH was collected.
    // The full 40% was already charged at mint; dropping to our 20% here would make the §8.1
    // disclosure vary invisibly with a third party's KYC state, and an under-collection cannot be
    // recovered afterwards while an over-collection can.
    const create = {
      bookingIntentId: input.bookingIntentId,
      whopPaymentId: input.whopPaymentId ?? null,
      referrerPractitionerId,
      servingPractitionerId: input.practitionerId,
      clientEmailHash: emailHash,
      grossUsdCents: snapshot?.priceUsdCents ?? 0,
      referrerShareUsdCents,
      referrerRateBps: snapshot?.referrerFeeBps ?? 0,
      collectedFeeUsdCents: snapshot?.applicationFeeUsdCents ?? 0,
      state: referralState,
      // Deliberately NULL. Notification is out-of-band with its own durable marker; stamping it
      // here would record the referrer as told before anything was sent.
      notifiedAt: null,
      // RULING 7 — the hold clock is PER ROW, from the moment the share could not be paid. A
      // referrer owed five shares has five clocks, because each was owed on a different day.
      holdCreatedAt: payable ? null : input.paidAt,
      holdExpiresAt: payable ? null : holdExpiry(input.paidAt, input.holdDays),
      holdDays: payable ? null : input.holdDays,
    };

    await db.referralLedgerEntry.upsert({
      where: {
        bookingIntentId_referrerPractitionerId: {
          bookingIntentId: input.bookingIntentId,
          referrerPractitionerId,
        },
      },
      create,
      // CREATE-ONLY. A redelivery must not reset a hold clock that has been running, nor walk a
      // row that has already SETTLED back to PAYABLE.
      update: {},
    });
  }

  // The fee we actually collected, recorded so §7's reconciliation can line it up against Whop's
  // own itemisation. Written even when it is zero: "we charged nothing here" is a fact worth
  // being able to prove, and its absence is indistinguishable from a lost write.
  await db.feeLedgerEntry.upsert({
    where: { dedupeKey: `APPLICATION_FEE:${input.bookingIntentId}` },
    create: {
      dedupeKey: `APPLICATION_FEE:${input.bookingIntentId}`,
      kind: 'APPLICATION_FEE',
      // SETTLED, not PENDING: Whop took this off the top of the payment that triggered this event.
      // There is nothing left for us to do to collect it.
      status: 'SETTLED',
      bookingIntentId: input.bookingIntentId,
      practitionerId: input.practitionerId,
      counterpartyPractitionerId: referrerPractitionerId,
      amountUsdCents: snapshot?.applicationFeeUsdCents ?? 0,
      whopPaymentId: input.whopPaymentId ?? null,
      whopFeeOrigin: 'application_fee',
      note: snapshot
        ? null
        : 'No mint-time fee snapshot for this payment — paid through the hosted checkout fallback.',
    },
    update: {},
  });

  return { owner, referrerShareUsdCents, referralState };
}
