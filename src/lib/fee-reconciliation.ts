/**
 * CHECKING OUR LEDGER AGAINST WHOP (spec v1.4 §7).
 *
 * Whop remains the source of truth for money; this is what makes that checkable rather than
 * merely asserted. `GET /api/v1/payments/{id}/fees` itemises every line with an `origin` —
 * validated live on `pay_JOaWdCx7xc37VJ`, where a $10.00 payment carried `application_fee` $5.00
 * alongside Whop's own processing lines. An earlier claim that only `amount_after_fees` was
 * exposed was wrong and is retracted.
 *
 * ⚠️ WHOP'S FEE AMOUNTS ARE IN DOLLARS. `amount: 40` is $40.00, not 40 cents — the same unit trap
 * as `POST /transfers`, and reading it as cents would report a 100× mismatch on every payment and
 * turn the whole reconciliation into noise somebody switches off.
 */

export type WhopFeeLine = { origin: string; amount: number };

export type ReconciliationResult = {
  ok: boolean;
  observedUsdCents: number;
  expectedUsdCents: number;
};

/**
 * One cent of slack.
 *
 * Whop's amounts arrive as floats, so a sum can land a hair off an exact cent. A reconciliation
 * that cried wolf over a cent would be ignored within a week, which is strictly worse than the
 * cent — and a real discrepancy is never one cent, because our fees are whole basis points of
 * whole-cent prices.
 */
const TOLERANCE_USD_CENTS = 1;

export function reconcileFeeLines(input: {
  expectedUsdCents: number;
  whopFees: WhopFeeLine[];
}): ReconciliationResult {
  // SUMMED, not first-matched: nothing in the contract promises a single application_fee line.
  // A missing line contributes zero, which is a real observation — "no fee arrived" — rather than
  // an unknown to be skipped. Skipping it is how a fee that never arrived stays invisible.
  const observedUsdCents = Math.round(
    input.whopFees
      .filter((f) => f.origin === 'application_fee')
      .reduce((sum, f) => sum + f.amount * 100, 0),
  );

  return {
    ok: Math.abs(observedUsdCents - input.expectedUsdCents) <= TOLERANCE_USD_CENTS,
    observedUsdCents,
    expectedUsdCents: input.expectedUsdCents,
  };
}
