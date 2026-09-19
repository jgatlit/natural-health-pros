/**
 * REFUNDS (spec v1.4 §6.2, §9 test 17).
 *
 * Whop reverses the APPLICATION FEE itself, proportionally — that half needs no code from us. The
 * referrer's share does: it is a separate object settled onto a separate account by a separate
 * transfer, and it does not auto-reverse.
 *
 * The behaviour splits on one question — has it been paid out yet?
 *
 *   NOT YET PAID (PAYABLE / HELD) — the debt is still a proposal. Reduce it; nothing has moved.
 *   ALREADY PAID (SETTLED)        — the money is in the referrer's own Whop account. Recovering it
 *                                   means pulling funds back OUT of a third party's account, and
 *                                   that is NEVER done automatically here. It is recorded as a
 *                                   recovery owed, for a human. Whop's child → parent direction is
 *                                   structurally permitted (probed) but needs that child to be
 *                                   holding a balance at the time, so even the mechanism is not
 *                                   guaranteed — let alone the judgement.
 *
 * ⚠️ WHOP SENDS REFUND AMOUNTS IN DOLLARS. The SDK's own type says so in as many words: "The
 * refunded amount as a decimal in the specified currency, such as 10.43 for $10.43 USD"
 * (`RefundCreatedWebhookEvent.Data.amount`). Read as cents, a full refund would look like a 1%
 * refund and the referrer would keep their whole share on a session the client got back in full.
 */

export type RefundDb = {
  referralLedgerEntry: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findFirst(args: any): Promise<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update(args: any): Promise<any>;
  };
  feeLedgerEntry: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    upsert(args: any): Promise<any>;
  };
};

export type RefundOutcome = {
  /** Reduced from an unpaid debt. No money moved. */
  reversedUsdCents: number;
  /** Already transferred to the referrer and now owed back. Surfaced, never auto-clawed. */
  recoveryOwedUsdCents: number;
  matched: boolean;
};

export async function reverseReferralOnRefund(
  db: RefundDb,
  input: {
    whopPaymentId: string;
    /** DOLLARS, as Whop sends it. See the module docstring. */
    refundAmountUsdDollars: number;
    refundId: string;
    at: Date;
  },
): Promise<RefundOutcome> {
  const none: RefundOutcome = { reversedUsdCents: 0, recoveryOwedUsdCents: 0, matched: false };
  if (!(input.refundAmountUsdDollars > 0)) return none;

  const row = (await db.referralLedgerEntry.findFirst({
    where: { whopPaymentId: input.whopPaymentId },
    select: {
      id: true,
      state: true,
      grossUsdCents: true,
      referrerShareUsdCents: true,
      referrerPractitionerId: true,
      servingPractitionerId: true,
    },
  })) as {
    id: string;
    state: string;
    grossUsdCents: number;
    referrerShareUsdCents: number;
    referrerPractitionerId: string;
    servingPractitionerId: string;
  } | null;

  // Most refunds are of payments that owed nobody a referral share. Silence is the right answer.
  if (!row || row.referrerShareUsdCents <= 0) return none;

  const refundUsdCents = Math.round(input.refundAmountUsdDollars * 100);
  // PROPORTIONAL, and capped at what is owed. A refund can only ever take money back, so the
  // reversal is bounded by the share — an over-large or mis-parsed refund amount must not produce
  // a negative balance the settlement sweep would then try to transfer.
  const proportion =
    row.grossUsdCents > 0 ? Math.min(1, refundUsdCents / row.grossUsdCents) : 1;
  const reversal = Math.min(
    row.referrerShareUsdCents,
    Math.round(row.referrerShareUsdCents * proportion),
  );
  if (reversal <= 0) return none;

  const alreadyPaid = row.state === 'SETTLED';
  const dedupeKey = `REFUND_REVERSAL:${input.refundId}:${row.id}`;

  if (!alreadyPaid) {
    await db.referralLedgerEntry.update({
      where: { id: row.id },
      data: { referrerShareUsdCents: row.referrerShareUsdCents - reversal },
    });
  }

  await db.feeLedgerEntry.upsert({
    where: { dedupeKey },
    create: {
      dedupeKey,
      kind: 'REFUND_REVERSAL',
      // SETTLED when nothing had moved — the reduction IS the whole action. PENDING when it had,
      // because something a human must do is still outstanding.
      status: alreadyPaid ? 'PENDING' : 'SETTLED',
      bookingIntentId: null,
      practitionerId: row.servingPractitionerId,
      counterpartyPractitionerId: row.referrerPractitionerId,
      // NEGATIVE. The ledger is append-only, so a reversal is an entry with the opposite sign
      // rather than an edit to the entry it reverses.
      amountUsdCents: -reversal,
      whopPaymentId: input.whopPaymentId,
      note: alreadyPaid
        ? 'Referrer share was ALREADY PAID OUT when this refund arrived. Nothing was clawed back ' +
          'automatically — recover it by an explicit action, or offset it against a future share.'
        : 'Referrer share reduced before payout; no money moved.',
    },
    update: {},
  });

  return {
    reversedUsdCents: alreadyPaid ? 0 : reversal,
    recoveryOwedUsdCents: alreadyPaid ? reversal : 0,
    matched: true,
  };
}
