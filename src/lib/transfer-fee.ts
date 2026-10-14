/**
 * PAYEE ABSORBS WHOP'S TRANSFER FEE (spec v1.5 section 4, operator ruling 2026-10-14).
 *
 * The practitioner receiving a referral or affiliate share is meant to bear Whop's transfer
 * charge. This module is the ONE place that arithmetic lives; the referral settle and the
 * affiliate settle both call `planTransfer()` and nothing else decides an amount.
 *
 * ⚠️ THE GUARANTEE IS CONDITIONAL. NHP is kept whole ONLY IF `WHOP_TRANSFER_FEE_BPS` is at least
 * Whop's real rate AND `WHOP_TRANSFER_FEE_MODE` matches Whop's real behaviour. Neither is known
 * for parent -> sibling (the measured 3% is for non-parent destinations; parent -> sibling is
 * unmeasurable until the parent is business-verified). Examples of how a wrong setting costs NHP:
 *   - charged-to-sender with a configured 3% while Whop really bills 4%: NHP's outlay exceeds the
 *     gross share by the difference;
 *   - deducted-from-recipient while Whop really bills the sender on top: NHP pays the whole fee.
 * So the first real $1 parent -> sibling transfer, measured, is a HARD ACTIVATION GATE. Do not set
 * WHOP_TRANSFERS_ENABLED=true, and do not use the non-default mode, before it.
 *
 * The side Whop charges is ONE explicit config:
 *
 *   WHOP_TRANSFER_FEE_MODE = 'charged-to-sender'          (DEFAULT, the conservative one for NHP)
 *     Whop bills the SENDER on top of the amount sent, so NHP's outlay = S + fee(S). We therefore
 *     send S = the largest amount whose outlay does not exceed the gross share (given the
 *     configured rate). The payee's net is S, and the fee recorded against them is gross - S
 *     (Whop's fee plus any rounding cent we keep).
 *   WHOP_TRANSFER_FEE_MODE = 'deducted-from-recipient'
 *     Whop deducts the fee from what the destination receives. We send the whole gross share; the
 *     payee receives gross - fee. Outlay = gross.
 *
 *   WHOP_TRANSFER_FEE_BPS (DEFAULT 300 = 3%, measured for non-parent destinations; replace after
 *   the first real $1 transfer measures parent -> sibling).
 *
 * ROUNDING: the fee is rounded UP (ceil), in NHP's favour, so a configured rate never under-recovers
 * by a fraction of a cent. Net is always gross - fee exactly, never negative. A share whose net
 * would be <= 0 is NOT sent.
 *
 * UNITS: everything here is CENTS. `/transfers` takes DOLLARS; the conversion is
 * `toTransferDollars()` in referral-payouts.ts, applied to `sendCents` only, at the boundary.
 */

export type TransferFeeMode = 'deducted-from-recipient' | 'charged-to-sender';

export const DEFAULT_TRANSFER_FEE_MODE: TransferFeeMode = 'charged-to-sender';
export const DEFAULT_TRANSFER_FEE_BPS = 300;
/** A fee configuration above this is a typo, not a policy. Fails closed. */
export const MAX_TRANSFER_FEE_BPS = 2_000;

const BPS = 10_000;

export type TransferFeeConfig = { mode: TransferFeeMode; bps: number };

export class TransferFeeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransferFeeConfigError';
  }
}

/** Reads the two env values. Unset means default; set-but-invalid THROWS (a money config fails closed). */
export function loadTransferFeeConfig(env: Record<string, string | undefined> = process.env): TransferFeeConfig {
  const rawMode = env.WHOP_TRANSFER_FEE_MODE?.trim();
  let mode: TransferFeeMode = DEFAULT_TRANSFER_FEE_MODE;
  if (rawMode) {
    if (rawMode !== 'deducted-from-recipient' && rawMode !== 'charged-to-sender') {
      throw new TransferFeeConfigError(
        `WHOP_TRANSFER_FEE_MODE must be 'deducted-from-recipient' or 'charged-to-sender' (got '${rawMode}')`,
      );
    }
    mode = rawMode;
  }
  const rawBps = env.WHOP_TRANSFER_FEE_BPS?.trim();
  let bps = DEFAULT_TRANSFER_FEE_BPS;
  if (rawBps) {
    if (!/^\d+$/.test(rawBps)) {
      throw new TransferFeeConfigError(`WHOP_TRANSFER_FEE_BPS must be a whole number of basis points (got '${rawBps}')`);
    }
    bps = Number(rawBps);
  }
  assertFeeConfig({ mode, bps });
  return { mode, bps };
}

function assertFeeConfig(c: TransferFeeConfig): void {
  if (!Number.isInteger(c.bps) || c.bps < 0 || c.bps > MAX_TRANSFER_FEE_BPS) {
    throw new TransferFeeConfigError(
      `transfer fee bps must be an integer 0..${MAX_TRANSFER_FEE_BPS} (got ${c.bps})`,
    );
  }
}

/** ceil(cents * bps / 10000) in integer arithmetic. */
function feeCeil(cents: number, bps: number): number {
  return Math.ceil((cents * bps) / BPS);
}

export type TransferPlan =
  | {
      sendable: true;
      /** What to hand to /transfers, in CENTS (convert to dollars at the boundary). */
      sendCents: number;
      /** The fee the PAYEE bears. grossCents - feeCents === netCents. */
      feeCents: number;
      netCents: number;
      grossCents: number;
    }
  | {
      sendable: false;
      reason: string;
      grossCents: number;
      feeCents: number;
      netCents: 0;
    };

export const BELOW_FEE_REASON = 'BELOW_TRANSFER_FEE';

export function planTransfer(grossCents: number, config: TransferFeeConfig): TransferPlan {
  if (!Number.isInteger(grossCents)) {
    throw new Error(`gross share must be a whole number of cents (got ${grossCents})`);
  }
  assertFeeConfig(config);
  if (grossCents <= 0) {
    return { sendable: false, reason: `${BELOW_FEE_REASON}: nothing to send (gross ${grossCents})`, grossCents, feeCents: 0, netCents: 0 };
  }

  if (config.mode === 'deducted-from-recipient') {
    const fee = feeCeil(grossCents, config.bps);
    const net = grossCents - fee;
    if (net <= 0) {
      return {
        sendable: false,
        reason: `${BELOW_FEE_REASON}: share ${grossCents}c is consumed by a ${fee}c transfer fee`,
        grossCents,
        feeCents: fee,
        netCents: 0,
      };
    }
    return { sendable: true, sendCents: grossCents, feeCents: fee, netCents: net, grossCents };
  }

  // charged-to-sender: largest S with S + ceil(S * bps / 10000) <= gross.
  let send = Math.floor((grossCents * BPS) / (BPS + config.bps));
  while (send > 0 && send + feeCeil(send, config.bps) > grossCents) send -= 1;
  if (send <= 0) {
    return {
      sendable: false,
      reason: `${BELOW_FEE_REASON}: share ${grossCents}c cannot cover the transfer fee`,
      grossCents,
      feeCents: grossCents,
      netCents: 0,
    };
  }
  return { sendable: true, sendCents: send, feeCents: grossCents - send, netCents: send, grossCents };
}

/** Smallest gross share that yields net > 0 (lets a sweep skip hopeless rows in its query). */
export function minimumSendableShareCents(config: TransferFeeConfig): number {
  let g = 1;
  while (!planTransfer(g, config).sendable) g += 1;
  return g;
}
