import { describe, expect, it } from 'vitest';

import { commitPaymentAttribution } from '@/lib/referral-settlement';
import { hashClientEmail } from '@/lib/attributed-clients';

/**
 * WHAT `payment.succeeded` COMMITS (spec v1.4 §6.2, operator rulings 6 and 7).
 *
 * The mint already decided the money and folded our take and the referrer's take into ONE
 * `application_fee_amount` collected on the parent. This step records what that fee was made of,
 * so the referrer's 20% can be settled by a later parent → sibling transfer and reconciled against
 * `GET /api/v1/payments/{id}/fees`.
 *
 * ⚠️ IDEMPOTENCE IS THE WHOLE TEST. Whop redelivers `payment.succeeded` 3× over ~70 s. A second
 * ledger row is a second payout, so the assertions below replay the event deliberately rather than
 * trusting that the caller guards it.
 *
 * ⚠️ AN UNPAYABLE REFERRER CHANGES WHERE THE MONEY SITS, NEVER HOW MUCH WAS COLLECTED (ruling 6).
 * We already charged the full 40%; falling back to collecting our 20% only would make the §8.1
 * disclosure vary invisibly by a third party's KYC state. Over-collecting is recoverable,
 * under-collecting is not.
 */

const P = 'practitioner-Y';
const X = 'practitioner-X';
const EMAIL = 'client@example.com';
const HASH = hashClientEmail(EMAIL);
const PAID_AT = new Date(Date.UTC(2026, 5, 1));

function db(seed: {
  snapshot?: Record<string, unknown> | null;
  referrer?: Record<string, unknown> | null;
  touch?: Record<string, unknown> | null;
  /** The reads the attribution resolver makes when there is no snapshot to read the owner from. */
  listEntry?: { addedAt: Date } | null;
  firstBooking?: { createdAt: Date } | null;
  touches?: Record<string, unknown>[];
}) {
  const referralLedger = new Map<string, Record<string, unknown>>();
  const feeLedger = new Map<string, Record<string, unknown>>();
  const attributed = new Map<string, Record<string, unknown>>();
  const touchUpdates: Record<string, unknown>[] = [];
  const listUpserts: Record<string, unknown>[] = [];

  return {
    referralLedger,
    feeLedger,
    attributed,
    touchUpdates,
    listUpserts,
    bookingFeeSnapshot: {
      async findUnique() {
        return seed.snapshot ?? null;
      },
    },
    practitioner: {
      async findUnique() {
        return seed.referrer ?? null;
      },
    },
    attributedClient: {
      async findUnique() {
        return null;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async upsert(args: any) {
        const { practitionerId, emailHash } = args.where.practitionerId_emailHash;
        const k = `${practitionerId}|${emailHash}`;
        if (!attributed.has(k)) attributed.set(k, { ...args.create });
        return attributed.get(k);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async updateMany(args: any) {
        let count = 0;
        for (const row of Array.from(attributed.values())) {
          const ok = Object.entries(args.where).every(
            ([f, want]) => (row[f] ?? null) === want,
          );
          if (ok) {
            Object.assign(row, args.data);
            count++;
          }
        }
        return { count };
      },
    },
    referralLedgerEntry: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async upsert(args: any) {
        const { bookingIntentId, referrerPractitionerId } =
          args.where.bookingIntentId_referrerPractitionerId;
        const k = `${bookingIntentId}|${referrerPractitionerId}`;
        if (!referralLedger.has(k)) referralLedger.set(k, { ...args.create });
        return referralLedger.get(k);
      },
    },
    feeLedgerEntry: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async upsert(args: any) {
        const k = args.where.dedupeKey as string;
        if (!feeLedger.has(k)) feeLedger.set(k, { ...args.create });
        return feeLedger.get(k);
      },
    },
    referralTouch: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async updateMany(args: any) {
        touchUpdates.push(args);
        return { count: 1 };
      },
      async findUnique() {
        return seed.touch ?? null;
      },
      async findMany() {
        return seed.touches ?? [];
      },
    },
    clientListEntry: {
      async findFirst() {
        return seed.listEntry ?? null;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async upsert(args: any) {
        listUpserts.push(args);
        return { id: 'entry_1' };
      },
    },
    bookingIntent: {
      async findFirst() {
        return seed.firstBooking ?? null;
      },
    },
  };
}

const snapshot = (over: Record<string, unknown> = {}) => ({
  attributionOwner: 'NHP',
  isCrossReferral: true,
  priceUsdCents: 10_000,
  nhpFeeUsdCents: 2_000,
  referrerFeeBps: 2_000,
  referrerShareUsdCents: 2_000,
  referrerPractitionerId: X,
  applicationFeeUsdCents: 4_000,
  ...over,
});

const commit = (fake: ReturnType<typeof db>) =>
  commitPaymentAttribution(fake, {
    bookingIntentId: 'bi_1',
    practitionerId: P,
    email: EMAIL,
    party: 'NHP',
    source: 'DIRECTORY',
    referralTouchId: 't1',
    termMonths: 8,
    holdDays: 90,
    sessionStartsAt: PAID_AT,
    paidAt: PAID_AT,
    whopPaymentId: 'pay_1',
  });

describe('commitPaymentAttribution — the referral ledger', () => {
  it('records the referrer’s share as PAYABLE when they can receive funds', async () => {
    const fake = db({
      snapshot: snapshot(),
      referrer: { id: X, whopCompanyId: 'biz_x', whopPayoutsEnabled: true },
    });

    await commit(fake);

    const [entry] = Array.from(fake.referralLedger.values());
    expect(entry).toMatchObject({
      referrerPractitionerId: X,
      servingPractitionerId: P,
      clientEmailHash: HASH,
      grossUsdCents: 10_000,
      referrerShareUsdCents: 2_000,
      referrerRateBps: 2_000,
      collectedFeeUsdCents: 4_000,
      state: 'PAYABLE',
      whopPaymentId: 'pay_1',
    });
    expect(entry.holdExpiresAt).toBeNull();
  });

  it('ruling 6/7 — an unpayable referrer’s share is HELD with a 90-day per-row clock, not forfeited', async () => {
    const fake = db({
      snapshot: snapshot(),
      referrer: { id: X, whopCompanyId: null, whopPayoutsEnabled: false },
    });

    await commit(fake);

    const [entry] = Array.from(fake.referralLedger.values());
    expect(entry.state).toBe('HELD');
    expect(entry.referrerShareUsdCents).toBe(2_000);
    expect(entry.holdDays).toBe(90);
    expect(entry.holdCreatedAt).toEqual(PAID_AT);
    expect(entry.holdExpiresAt).toEqual(new Date(PAID_AT.getTime() + 90 * 86_400_000));
    // Notification is a separate, out-of-band step with its own durable marker. Setting it here
    // would mark the referrer as told before anything had been sent.
    expect(entry.notifiedAt).toBeNull();
  });

  it('holds the SAME amount an payable referrer would have been owed — never a reduced fallback', async () => {
    const payable = db({ snapshot: snapshot(), referrer: { id: X, whopCompanyId: 'biz_x', whopPayoutsEnabled: true } });
    const held = db({ snapshot: snapshot(), referrer: { id: X, whopCompanyId: null, whopPayoutsEnabled: false } });

    await commit(payable);
    await commit(held);

    const a = Array.from(payable.referralLedger.values())[0]!;
    const b = Array.from(held.referralLedger.values())[0]!;
    expect(b.referrerShareUsdCents).toBe(a.referrerShareUsdCents);
    expect(b.collectedFeeUsdCents).toBe(a.collectedFeeUsdCents);
  });

  it('holds when the referrer row has vanished entirely — a deleted practitioner is not a free session', async () => {
    const fake = db({ snapshot: snapshot(), referrer: null });

    await commit(fake);

    expect(Array.from(fake.referralLedger.values())[0]!.state).toBe('HELD');
  });

  it('is IDEMPOTENT under a Whop redelivery — replaying the event writes one row, not two', async () => {
    const fake = db({
      snapshot: snapshot(),
      referrer: { id: X, whopCompanyId: 'biz_x', whopPayoutsEnabled: true },
    });

    await commit(fake);
    await commit(fake);
    await commit(fake);

    expect(fake.referralLedger.size).toBe(1);
    expect(fake.feeLedger.size).toBe(1);
  });

  it('writes NO referral row when nothing is owed to anybody', async () => {
    const fake = db({
      snapshot: snapshot({ isCrossReferral: false, referrerPractitionerId: null, referrerShareUsdCents: 0, nhpFeeUsdCents: 4_000, applicationFeeUsdCents: 4_000 }),
    });

    await commit(fake);

    expect(fake.referralLedger.size).toBe(0);
    expect(fake.feeLedger.size).toBe(1);
  });
});

describe('commitPaymentAttribution — the attribution row', () => {
  it('commits the owner the MINT decided, not a fresh derivation', async () => {
    const fake = db({ snapshot: snapshot({ attributionOwner: 'PRACTITIONER', isCrossReferral: false, referrerPractitionerId: null, referrerShareUsdCents: 0, nhpFeeUsdCents: 0, applicationFeeUsdCents: 0 }) });

    await commit(fake);

    const row = Array.from(fake.attributed.values())[0]!;
    expect(row.owner).toBe('PRACTITIONER');
    expect(row.decidedAt).toEqual(PAID_AT);
  });

  it('still records an attribution when no snapshot exists — a booking paid through the hosted fallback', async () => {
    // The §8 hosted-checkout fallback mints no per-booking configuration, so there is no snapshot.
    // The claim must still be recorded or the term never starts and the client is charged forever.
    const fake = db({ snapshot: null });

    await commit(fake);

    const row = Array.from(fake.attributed.values())[0]!;
    expect(row.owner).toBe('NHP');
    expect(row.termMonths).toBe(8);
    expect(fake.referralLedger.size).toBe(0);
  });

  it('attaches the carried referral touch to the client so a link referral stops being anonymous', async () => {
    const fake = db({
      snapshot: snapshot(),
      referrer: { id: X, whopCompanyId: 'biz_x', whopPayoutsEnabled: true },
    });

    await commit(fake);

    expect(fake.touchUpdates).toHaveLength(1);
    const update = fake.touchUpdates[0] as { where: Record<string, unknown>; data: Record<string, unknown> };
    expect(update.where).toMatchObject({ id: 't1', clientEmailHash: null });
    expect(update.data).toMatchObject({ clientEmailHash: HASH, status: 'BOOKED' });
  });
});

describe('commitPaymentAttribution — the fee ledger', () => {
  it('records the single application fee actually collected, keyed so a replay cannot duplicate it', async () => {
    const fake = db({
      snapshot: snapshot(),
      referrer: { id: X, whopCompanyId: 'biz_x', whopPayoutsEnabled: true },
    });

    await commit(fake);

    const [entry] = Array.from(fake.feeLedger.values());
    expect(entry).toMatchObject({
      kind: 'APPLICATION_FEE',
      status: 'SETTLED',
      amountUsdCents: 4_000,
      whopPaymentId: 'pay_1',
      practitionerId: P,
    });
    expect(entry.dedupeKey).toBe('APPLICATION_FEE:bi_1');
  });
});

describe('commitPaymentAttribution — the referrer’s own client list (§5.4.4)', () => {
  it('adds the client to the REFERRER’s list, dated when the link was OPENED', async () => {
    // §5.4.4: "C is added to X's list if not already there (source = referral_made, added_at =
    // opened_at)". The date matters commercially: it is the earliest-touch lock for X's OWN future
    // fees on this person, so dating it at payment instead of at the open would silently shorten
    // the exemption X earned by making the introduction.
    const opened = new Date(Date.UTC(2026, 4, 20));
    const fake = db({
      snapshot: snapshot(),
      referrer: { id: X, whopCompanyId: 'biz_x', whopPayoutsEnabled: true },
      touch: { id: 't1', openedAt: opened, referral: { referrerId: X } },
    });

    await commit(fake);

    const [upsert] = fake.listUpserts as { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }[];
    expect(upsert!.create).toMatchObject({
      practitionerId: X,
      email: EMAIL,
      emailHash: HASH,
      source: 'REFERRAL_MADE',
      addedAt: opened,
    });
    // §5.6: if C was already on X's list, this must not move the lock they already had.
    expect(upsert!.update).toEqual({});
  });

  it('adds nothing when no referral carried the booking', async () => {
    const fake = db({
      snapshot: snapshot({ isCrossReferral: false, referrerPractitionerId: null, referrerShareUsdCents: 0 }),
      touch: null,
    });

    await commitPaymentAttribution(fake, {
      bookingIntentId: 'bi_1',
      practitionerId: P,
      email: EMAIL,
      referralTouchId: null,
      termMonths: 8,
      holdDays: 90,
      sessionStartsAt: PAID_AT,
      paidAt: PAID_AT,
    });

    expect(fake.listUpserts).toHaveLength(0);
  });
});

describe('commitPaymentAttribution — AUDIT: a payment with no mint-time snapshot', () => {
  /**
   * 🚨 THE OVER-CHARGE THIS CATCHES.
   *
   * A snapshot is missing whenever the per-booking checkout configuration was never minted — the
   * §8 hosted-checkout fallback is the reachable case. The commit then has to decide the owner
   * from scratch, and defaulting it to NHP is not a safe default here: the decision is written
   * with `decidedAt`, so it is FINAL. A practitioner's own client who happened to pay through
   * that path would be recorded as platform-sourced permanently, and charged the platform share
   * on every session for the whole term — for a client the practitioner brought themselves.
   *
   * Defaulting to NHP is right for the AMOUNT (a fee we cannot prove was collected is not paid
   * out) and wrong for the DECISION. They are different questions and were briefly answered by
   * the same line.
   */
  it('resolves the owner from the client list instead of defaulting to NHP', async () => {
    const opened = new Date(Date.UTC(2026, 0, 1));
    // C was on Y's OWN list before ever booking — R4/R5 make them the practitioner's own.
    const fake = db({ snapshot: null, listEntry: { addedAt: opened }, firstBooking: { createdAt: PAID_AT } });

    await commitPaymentAttribution(fake, {
      bookingIntentId: 'bi_1',
      practitionerId: P,
      email: EMAIL,
      referralTouchId: null,
      termMonths: 8,
      holdDays: 90,
      sessionStartsAt: PAID_AT,
      paidAt: PAID_AT,
    });

    const row = Array.from(fake.attributed.values())[0]!;
    expect(row.owner).toBe('PRACTITIONER');
  });

  it('still records NHP when nothing suggests the client was theirs', async () => {
    const fake = db({ snapshot: null, listEntry: null, firstBooking: { createdAt: PAID_AT } });

    await commitPaymentAttribution(fake, {
      bookingIntentId: 'bi_1',
      practitionerId: P,
      email: EMAIL,
      referralTouchId: null,
      termMonths: 8,
      holdDays: 90,
      sessionStartsAt: PAID_AT,
      paidAt: PAID_AT,
    });

    expect(Array.from(fake.attributed.values())[0]!.owner).toBe('NHP');
  });

  it('pays out NOTHING even if a referral exists — no snapshot means no proven collection', async () => {
    // The two questions are separate: the OWNER is resolved from our own records, but the AMOUNT
    // comes only from a fee we can prove Whop collected. A referrer share invented here would be
    // money transferred out against a fee that may never have been charged.
    const fake = db({
      snapshot: null,
      referrer: { id: X, whopCompanyId: 'biz_x', whopPayoutsEnabled: true },
      listEntry: null,
      firstBooking: { createdAt: PAID_AT },
      touches: [
        {
          id: 't1',
          receivedAt: PAID_AT,
          referral: { referrerId: X, referredId: P, expiresAt: new Date(Date.UTC(2027, 0, 1)) },
        },
      ],
    });

    await commitPaymentAttribution(fake, {
      bookingIntentId: 'bi_1',
      practitionerId: P,
      email: EMAIL,
      referralTouchId: 't1',
      termMonths: 8,
      holdDays: 90,
      sessionStartsAt: PAID_AT,
      paidAt: PAID_AT,
    });

    expect(fake.referralLedger.size).toBe(0);
  });
});
