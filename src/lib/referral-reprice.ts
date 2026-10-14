/**
 * RE-PRICING OF PRE-v1.5 REFERRAL LEDGER ROWS (spec v1.5 section 4: "Reconcile every ledger row
 * minted before fee rule v1.5 before enabling").
 *
 * PURE: no I/O. The standalone script `scripts/reconcile-referral-v15.ts` feeds it rows and acts on
 * the decision; this file is where the rule lives and is unit-tested.
 *
 * WHAT CHANGED BETWEEN THE OLD RULE AND v1.5
 *   old  referral = 20% referrer + 20% NHP (40% in all), referrer paid for the whole 8-month lead term
 *   v1.5 referral = 20% referrer + 10% NHP (30% in all), referrer paid for the 4-month REFERRER term
 *        (schedule `referrerTermMonths`, measured from the client's anchor, exclusive at the end)
 *
 * THE RULE (per `ReferralLedgerEntry` whose `BookingFeeSnapshot.rateScheduleId` is NULL, i.e. priced
 * before the schedule existed):
 *
 *   1. The referrer's rate stays the schedule's `referrerBps` (2000). The new share is
 *        in referrer term (paidAt < anchor + referrerTermMonths):  min(current share, floor(gross x referrerBps / 10000))
 *        past the referrer term:                                     0
 *      It NEVER rises: a share already reduced in place by a refund stays reduced, and a row whose
 *      old rate was above the schedule's is clamped down to it.
 *   2. Only rows still owed can change: PAYABLE, HELD, EXPIRED_UNCLAIMED. A SETTLED row has already
 *      been paid: it is reported (FLAG_SETTLED, with the overpaid amount) and never touched.
 *   3. No anchor or no schedule: SKIP with the reason. A guess would move money.
 *   4. Over-collection from the practitioner is REPORTED, never repaired here. The old rule charged
 *      NHP's 20% where v1.5 charges 10%; for an in-term row the difference
 *      (collected - oldShare) - floor(gross x (totalBps - referrerBps) / 10000) is
 *      `nhpOverCollectedUsdCents`. Whether and how to refund it is an operator decision (spec 6).
 *      Past-term rows depend on the practitioner's plan, which the ledger row does not carry, so
 *      theirs is reported as null.
 *
 * IDEMPOTENT: a repriced row's share equals its target, so a second pass decides NOOP.
 */

import { addMonths } from './attribution-term';

const BPS = 10_000;

export type RepriceableState = 'PAYABLE' | 'HELD' | 'EXPIRED_UNCLAIMED' | 'SETTLED';

export type RepriceInput = {
  id: string;
  state: string;
  grossUsdCents: number;
  referrerShareUsdCents: number;
  collectedFeeUsdCents: number;
  /** When the payment was recorded (the ledger row's createdAt). */
  paidAt: Date;
  /** The client's anchor with the serving practitioner; null when no attribution row exists. */
  anchorAt: Date | null;
  /** The schedule's v1.5 numbers; null when the practitioner has no schedule. */
  schedule: { referrerBps: number; referralTotalBps: number; referrerTermMonths: number; leadTermMonths: number } | null;
  /** Term lengths stored on the client's attribution row win over the schedule (forward-only). */
  storedReferrerTermMonths?: number | null;
  storedLeadTermMonths?: number | null;
};

type RepriceDetail = {
  id: string;
  currentShareUsdCents: number;
  newShareUsdCents: number;
  deltaUsdCents: number;
  inReferrerTerm: boolean;
  referrerTermEndsAt: string;
  nhpOverCollectedUsdCents: number | null;
  reason: string;
};

export type RepriceChange = RepriceDetail & { action: 'REPRICE' };

export type RepriceDecision =
  | RepriceChange
  | (RepriceDetail & { action: 'NOOP' | 'FLAG_SETTLED' })
  | { action: 'SKIP'; id: string; reason: string };

export function repriceReferralRow(input: RepriceInput): RepriceDecision {
  const { id } = input;
  if (!input.schedule) return { action: 'SKIP', id, reason: 'NO_SCHEDULE: serving practitioner has no rate schedule' };
  if (!input.anchorAt) return { action: 'SKIP', id, reason: 'NO_ANCHOR: no attributed-client row for this client and practitioner' };
  if (![input.grossUsdCents, input.referrerShareUsdCents, input.collectedFeeUsdCents].every(Number.isInteger)) {
    return { action: 'SKIP', id, reason: 'MALFORMED: non-integer cents' };
  }

  const s = input.schedule;
  const lead = input.storedLeadTermMonths && input.storedLeadTermMonths > 0 ? input.storedLeadTermMonths : s.leadTermMonths;
  const refRaw =
    input.storedReferrerTermMonths && input.storedReferrerTermMonths > 0
      ? input.storedReferrerTermMonths
      : s.referrerTermMonths;
  const referrerMonths = Math.min(refRaw, lead);
  const endsAt = addMonths(input.anchorAt, referrerMonths);
  const inReferrerTerm = input.paidAt.getTime() < endsAt.getTime();

  const current = input.referrerShareUsdCents;
  const ceiling = Math.floor((input.grossUsdCents * s.referrerBps) / BPS);
  const target = inReferrerTerm ? Math.min(current, ceiling) : 0;

  const nhpOverCollected = inReferrerTerm
    ? Math.max(
        0,
        input.collectedFeeUsdCents -
          current -
          Math.floor((input.grossUsdCents * (s.referralTotalBps - s.referrerBps)) / BPS),
      )
    : null;

  const base = {
    id,
    currentShareUsdCents: current,
    newShareUsdCents: target,
    deltaUsdCents: target - current,
    inReferrerTerm,
    referrerTermEndsAt: endsAt.toISOString(),
    nhpOverCollectedUsdCents: nhpOverCollected,
  };

  if (target === current) return { action: 'NOOP', ...base, reason: 'ALREADY_AT_V15_SHARE' };
  if (input.state === 'SETTLED') {
    return {
      action: 'FLAG_SETTLED',
      ...base,
      reason: `SETTLED_OVERPAID: ${current - target}c already paid beyond the v1.5 share; recovery is an operator decision`,
    };
  }
  if (input.state !== 'PAYABLE' && input.state !== 'HELD' && input.state !== 'EXPIRED_UNCLAIMED') {
    return { action: 'SKIP', id, reason: `UNKNOWN_STATE: ${input.state}` };
  }
  return {
    action: 'REPRICE',
    ...base,
    reason: inReferrerTerm
      ? 'IN_TERM_CLAMPED_TO_SCHEDULE_REFERRER_BPS'
      : 'PAST_REFERRER_TERM: v1.5 pays the referrer for the referrer term only',
  };
}
