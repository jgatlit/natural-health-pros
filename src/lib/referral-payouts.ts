/**
 * PAYING REFERRERS (spec v1.4 §6.2, operator rulings 6 and 7).
 *
 * 🚧 BUILT AND DELIBERATELY NOT ACTIVE. The parent company is not business-verified, and Whop
 * refuses every transfer originating from it:
 *
 *     origin=<parent> → any sibling, any amount
 *     → "Please verify your business before transferring funds."
 *
 * Probed 2026-09-19 by incremental rejection; no transfer was created. That is an operator action
 * in the Whop dashboard, not a code fix, so this ships behind a guard that FAILS CLOSED and names
 * the reason. When verification clears, `WHOP_TRANSFERS_ENABLED=true` is the whole change.
 *
 * ⚠️ THE 100× TRAP, STATED ONCE AND ENFORCED IN ONE PLACE. `POST /api/v1/transfers` takes `amount`
 * in **DOLLARS**. `application_fee_amount`, a few hundred lines away in `whop.ts`, is in **CENTS**.
 * Two adjacent money APIs with different units will eventually be confused by somebody, so the
 * conversion is `toTransferDollars()` — a named, validated, separately tested boundary rather than
 * an inline `/ 100` that reviews as obviously correct in both directions.
 *
 * ⚠️ `POST /transfers` HAS NO OBSERVED IDEMPOTENCY KEY. The claim-then-call ordering below is the
 * ONLY guard against paying twice, and a crash between the call and the confirmation must be
 * reconciled against `GET /transfers?origin_id=` — never retried blind.
 *
 * ⚠️ WHAT REMAINS UNMEASURED. Transfers to a NON-parent destination carry a 3% surcharge (measured
 * across three amounts and two destinations); child → parent carries none. Whether parent →
 * sibling carries it is UNKNOWN and unmeasurable until the parent is verified. Nothing here
 * assumes either way; the requested amount is recorded so the net can be reconciled against Whop's
 * own fee itemisation once a real transfer exists.
 */

import { isWhopPlatformsReady } from './whop';

/** Whop validates this BEFORE direction, ownership or balance — measured 2026-09-19. */
export const MAX_TRANSFER_USD_CENTS = 2_500_000;

/**
 * Convert an internal cent amount to the DOLLARS the transfers endpoint expects.
 *
 * The validation is the point. A fractional cent means an upstream rounding bug reached the payout
 * boundary, and silently rounding it here would hand somebody a different share than the ledger
 * says they are owed — on the one call that cannot be undone.
 */
export function toTransferDollars(amountUsdCents: number): number {
  if (!Number.isInteger(amountUsdCents)) {
    throw new Error(
      `transfer amount must be a whole number of cents (got ${amountUsdCents}) — a fractional ` +
        'cent here means a rounding bug upstream, not something to round away',
    );
  }
  if (amountUsdCents <= 0) {
    throw new Error(`transfer amount must be positive (got ${amountUsdCents})`);
  }
  if (amountUsdCents > MAX_TRANSFER_USD_CENTS) {
    throw new Error(
      `transfer amount exceeds Whop's $25,000 per-transfer ceiling (got ${amountUsdCents} cents)`,
    );
  }
  return amountUsdCents / 100;
}

export type PayoutsGuard = { allowed: true } | { allowed: false; reason: string };

/**
 * May we move money to referrers right now?
 *
 * FAILS CLOSED and returns a REASON rather than a boolean, because the two ways this can be off
 * need different actions: one is a dashboard verification and the other is a missing API key. A
 * bare `false` would send someone to look in the wrong place.
 */
export function payoutsGuard(): PayoutsGuard {
  if (!isWhopPlatformsReady()) {
    return {
      allowed: false,
      reason:
        'Whop is not configured (WHOP_COMPANY_API_KEY / WHOP_PARENT_COMPANY_ID), so no transfer ' +
        'can be made.',
    };
  }
  // The literal string, not a truthy check: an env var accidentally set to "false" or "0" must
  // not open a money path.
  if (process.env.WHOP_TRANSFERS_ENABLED !== 'true') {
    return {
      allowed: false,
      reason:
        'Referrer payouts are switched off. The parent company is not business-verified, and Whop ' +
        'refuses every transfer from it ("Please verify your business before transferring funds"). ' +
        'Complete verification in the Whop dashboard, then set WHOP_TRANSFERS_ENABLED=true.',
    };
  }
  return { allowed: true };
}

/** The transfer call itself, injected so nothing in the test suite can reach the live API. */
export type TransferFn = (args: {
  originId: string;
  destinationId: string;
  /** DOLLARS. See `toTransferDollars`. */
  amountUsdDollars: number;
}) => Promise<{ transferId: string }>;

export type PayoutsDb = {
  referralLedgerEntry: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany(args: any): Promise<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateMany(args: any): Promise<{ count: number }>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update(args: any): Promise<any>;
  };
  feeLedgerEntry: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    upsert(args: any): Promise<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateMany(args: any): Promise<{ count: number }>;
  };
  practitioner: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany(args: any): Promise<any>;
  };
};

export type SettlementSummary = {
  matched: number;
  settled: number;
  skipped: number;
  failed: number;
  /** Set when the guard refused. Null when payouts ran (whether or not any succeeded). */
  blocked: string | null;
};

const TRANSFER_BATCH = 50;

export async function settlePayableShares(
  db: PayoutsDb,
  opts: { transfer: TransferFn; at: Date },
): Promise<SettlementSummary> {
  const summary: SettlementSummary = { matched: 0, settled: 0, skipped: 0, failed: 0, blocked: null };

  const rows = (await db.referralLedgerEntry.findMany({
    where: { state: 'PAYABLE', settledAt: null },
    select: {
      id: true,
      referrerShareUsdCents: true,
      referrerPractitionerId: true,
      referrerPractitioner: { select: { id: true, whopCompanyId: true, whopPayoutsEnabled: true } },
    },
    take: TRANSFER_BATCH,
  })) as Array<{
    id: string;
    referrerShareUsdCents: number;
    referrerPractitionerId: string;
    referrerPractitioner: { whopCompanyId: string | null; whopPayoutsEnabled: boolean } | null;
  }>;
  summary.matched = rows.length;

  const guard = payoutsGuard();

  for (const row of rows) {
    const dedupeKey = `REFERRER_TRANSFER:${row.id}`;
    const destination = row.referrerPractitioner?.whopCompanyId ?? null;

    if (!guard.allowed) {
      // RECORDED, NOT MERELY UNPAID. A debt that exists only as the ABSENCE of a transfer is
      // invisible; this row is what makes "we owe N referrers M dollars and here is why it has
      // not moved" answerable from the database rather than from somebody's memory.
      summary.blocked = guard.reason;
      await db.feeLedgerEntry.upsert({
        where: { dedupeKey },
        create: {
          dedupeKey,
          kind: 'REFERRER_TRANSFER',
          status: 'BLOCKED',
          practitionerId: row.referrerPractitionerId,
          amountUsdCents: row.referrerShareUsdCents,
          note: guard.reason,
        },
        update: { status: 'BLOCKED', note: guard.reason },
      });
      continue;
    }

    if (!destination) {
      // Should not happen — an unpayable referrer's share is HELD, not PAYABLE — but a row can be
      // promoted and then have its account disconnected. Skipped rather than transferred into the
      // void, and left PAYABLE so the next run retries.
      summary.skipped += 1;
      continue;
    }

    // CLAIM, THEN CALL. `POST /transfers` has no idempotency key, so this conditional write is the
    // only thing standing between a concurrent run and a double payout: the filter names the
    // CURRENT status, so an already-claimed row matches nothing.
    await db.feeLedgerEntry.upsert({
      where: { dedupeKey },
      create: {
        dedupeKey,
        kind: 'REFERRER_TRANSFER',
        status: 'PENDING',
        practitionerId: row.referrerPractitionerId,
        amountUsdCents: row.referrerShareUsdCents,
      },
      update: {},
    });
    const claimed = await db.feeLedgerEntry.updateMany({
      where: { dedupeKey, status: 'PENDING' },
      data: { status: 'SENDING' },
    });
    if (claimed.count === 0) {
      summary.skipped += 1;
      continue;
    }

    try {
      const { transferId } = await opts.transfer({
        originId: process.env.WHOP_PARENT_COMPANY_ID!,
        destinationId: destination,
        amountUsdDollars: toTransferDollars(row.referrerShareUsdCents),
      });

      await db.referralLedgerEntry.update({
        where: { id: row.id },
        data: { state: 'SETTLED', settledAt: opts.at, whopTransferId: transferId },
      });
      await db.feeLedgerEntry.updateMany({
        where: { dedupeKey },
        data: {
          status: 'SETTLED',
          whopTransferId: transferId,
          // The REQUESTED amount is already on the row. Whether parent → sibling carries the 3%
          // surcharge measured on child → sibling is unknown until a real transfer exists, so the
          // net is reconciled against Whop rather than predicted here.
          note: 'Requested amount; net after any Whop transfer surcharge to be reconciled against the transfer record.',
        },
      });
      summary.settled += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // NEVER OPTIMISTICALLY SETTLED. The row stays PAYABLE so the next run retries, and the
      // failure is recorded rather than swallowed — a transfer that failed for insufficient
      // parent balance looks identical to one that never ran.
      await db.feeLedgerEntry.updateMany({
        where: { dedupeKey },
        data: { status: 'FAILED', note: message.slice(0, 500) },
      });
      summary.failed += 1;
      console.error('[referral-payouts] TRANSFER FAILED', JSON.stringify({ entryId: row.id, error: message }));
    }
  }

  return summary;
}

/**
 * Ruling 6 — a held share settles RETROACTIVELY once its referrer becomes payable.
 *
 * Driven by a sweep rather than by the `identity_profile.approved` webhook on purpose: Whop drops
 * an event permanently after ~70 s of retries, and a referrer whose approval webhook was lost
 * would otherwise stay held forever with nothing reporting it.
 */
export async function promoteHeldToPayable(
  db: PayoutsDb,
  opts: { at: Date },
): Promise<number> {
  const held = (await db.referralLedgerEntry.findMany({
    where: { state: 'HELD' },
    select: { id: true, referrerPractitionerId: true },
    take: 500,
  })) as Array<{ id: string; referrerPractitionerId: string }>;
  if (held.length === 0) return 0;

  const referrerIds = Array.from(new Set(held.map((r) => r.referrerPractitionerId)));
  const referrers = (await db.practitioner.findMany({
    where: { id: { in: referrerIds } },
    select: { id: true, whopCompanyId: true, whopPayoutsEnabled: true },
  })) as Array<{ id: string; whopCompanyId: string | null; whopPayoutsEnabled: boolean }>;

  const payable = new Set(
    referrers.filter((p) => p.whopCompanyId && p.whopPayoutsEnabled).map((p) => p.id),
  );
  const ids = held.filter((r) => payable.has(r.referrerPractitionerId)).map((r) => r.id);
  if (ids.length === 0) return 0;

  // Filtered on `state: 'HELD'` as well as the ids: an EXPIRED_UNCLAIMED row must never be swept
  // back into the payable set by this, because leaving that state is an operator decision.
  const { count } = await db.referralLedgerEntry.updateMany({
    where: { id: { in: ids }, state: 'HELD' },
    data: { state: 'PAYABLE', notifiedAt: undefined },
  });
  void opts;
  return count;
}

/**
 * Ruling 7 §4 — a hold that runs out becomes EXPIRED_UNCLAIMED, and NOTHING ELSE HAPPENS.
 *
 * ⚠️ NO MONEY ACTION, IN EITHER DIRECTION. Nothing is forfeited to the platform, nothing is
 * released, nothing is deleted. The amount, the referrer and the payment reference are all left
 * exactly as they were, so the balance stays reconcilable and settleable by an explicit operator
 * action. Day-91 policy is deliberately unruled; defaulting it either way silently moves real
 * money, and this transition exists so that the question is asked against real numbers rather
 * than answered by a default nobody chose.
 */
export async function expireLapsedHolds(db: PayoutsDb, opts: { at: Date }): Promise<number> {
  const { count } = await db.referralLedgerEntry.updateMany({
    where: { state: 'HELD', holdExpiresAt: { lte: opts.at } },
    data: { state: 'EXPIRED_UNCLAIMED' },
  });
  return count;
}
