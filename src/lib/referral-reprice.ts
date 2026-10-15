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
 *      been paid: it is reported (FLAG_SETTLED, with the overpaid amount) and never touched, and
 *      its referrer share stays with the referrer in the money totals (NHP retains collected minus
 *      what was paid, not collected minus the re-priced share).
 *   3. No anchor or no schedule: SKIP with the reason. A guess would move money.
 *   4. A row in SENDING, or whose fee-ledger transfer entry is SENDING or FAILED (a transfer may be
 *      in flight), is SKIPPED with IN_FLIGHT_TRANSFER.
 *   5. THE MONEY IS REPORTED, NEVER REPAIRED. Zeroing a past-term share leaves the old rule's NHP
 *      take AND the former referrer share with NHP, and the practitioner stays charged what the
 *      old rule took (up to 40%, above the 30% cap). Per row: what was collected, what v1.5 would
 *      have charged (in term: referralTotalBps; past the referrer term: the plan's sourced rate;
 *      past the lead term: 0), what NHP retains vs would have kept, the excess, and the
 *      practitioner's overcharge. Whether to refund is an OPERATOR decision (spec section 6).
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
  schedule: {
    referrerBps: number;
    referralTotalBps: number;
    referrerTermMonths: number;
    leadTermMonths: number;
    planASourcedBps: number;
    planBSourcedBps: number;
  } | null;
  /** The serving practitioner's plan ('PLAN_A' | 'PLAN_B'); needed only to price past-referrer-term rows. */
  plan?: string | null;
  /** Status of this row's REFERRER_TRANSFER fee-ledger entry, when one exists. */
  transferStatus?: string | null;
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
  /**
   * THE MONEY, per row. `collected` is what the practitioner was actually charged (old rule).
   * `v15Charge` is what v1.5 would have charged for the same session (null when the plan is needed
   * and unknown). `nhpRetains` is what NHP keeps after the re-priced referrer share
   * (collected - newShare); `v15NhpWouldKeep` is what NHP would have kept under v1.5.
   * `nhpExcess` = nhpRetains - v15NhpWouldKeep and `practitionerOvercharged` = collected - v15Charge,
   * both floored at 0 and null when v15Charge is unknown. Nothing here repays anyone.
   */
  collectedUsdCents: number;
  v15ChargeUsdCents: number | null;
  nhpRetainsUsdCents: number;
  v15NhpWouldKeepUsdCents: number | null;
  nhpExcessUsdCents: number | null;
  practitionerOverchargedUsdCents: number | null;
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

  if (
    input.state === 'SENDING' ||
    (input.transferStatus && input.transferStatus !== 'PENDING' && input.transferStatus !== 'BLOCKED' && input.transferStatus !== 'SETTLED')
  ) {
    return {
      action: 'SKIP',
      id,
      reason: `IN_FLIGHT_TRANSFER: ${input.state === 'SENDING' ? 'the ledger row is SENDING' : `fee-ledger transfer entry is ${input.transferStatus}`}; a transfer may have left, a human must look`,
    };
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

  // What v1.5 would have charged the practitioner for this same session.
  const leadEnds = addMonths(input.anchorAt, lead);
  const inLead = input.paidAt.getTime() < leadEnds.getTime();
  let v15Charge: number | null;
  if (!inLead) v15Charge = 0;
  else if (inReferrerTerm) v15Charge = Math.floor((input.grossUsdCents * s.referralTotalBps) / BPS);
  else if (input.plan === 'PLAN_A') v15Charge = Math.floor((input.grossUsdCents * s.planASourcedBps) / BPS);
  else if (input.plan === 'PLAN_B') v15Charge = Math.floor((input.grossUsdCents * s.planBSourcedBps) / BPS);
  else v15Charge = null;
  // A SETTLED row's referrer was already paid `current`: that money is not NHP's whatever the
  // re-priced share would be, so NHP retains collected minus what was paid, never collected minus 0.
  const nhpRetains = input.collectedFeeUsdCents - (input.state === 'SETTLED' ? current : target);
  const v15NhpWouldKeep =
    v15Charge === null ? null : Math.max(0, v15Charge - (inReferrerTerm ? Math.floor((input.grossUsdCents * s.referrerBps) / BPS) : 0));

  const base = {
    id,
    currentShareUsdCents: current,
    newShareUsdCents: target,
    deltaUsdCents: target - current,
    inReferrerTerm,
    referrerTermEndsAt: endsAt.toISOString(),
    collectedUsdCents: input.collectedFeeUsdCents,
    v15ChargeUsdCents: v15Charge,
    nhpRetainsUsdCents: nhpRetains,
    v15NhpWouldKeepUsdCents: v15NhpWouldKeep,
    nhpExcessUsdCents: v15NhpWouldKeep === null ? null : Math.max(0, nhpRetains - v15NhpWouldKeep),
    practitionerOverchargedUsdCents: v15Charge === null ? null : Math.max(0, input.collectedFeeUsdCents - v15Charge),
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
