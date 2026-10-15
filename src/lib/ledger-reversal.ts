/**
 * APPLYING A REFUND TO A PAYOUT LEDGER ROW (both ledgers; see `ledger-config.ts`).
 *
 * `totalReversedUsdCents` is the SUM of every append-only reversal marker for the payment, written
 * ABSOLUTELY and MONOTONICALLY (never an increment, never downwards). That is what makes a
 * redelivered refund (or a crash between the marker write and this one, repaired by the retry)
 * harmless, and what keeps two interleaved refunds from losing one.
 *
 * Whether the refund reduces the share or becomes a debit depends on one question: has a transfer
 * been CLAIMED for this row (`transferUsdCents` set, or the row SENDING / SETTLED)?
 *
 *   NOT CLAIMED  The share is simply reduced (`reversedUsdCents` rises), so the transfer is smaller
 *                or never sent. A row reversed to zero becomes REVERSED.
 *   CLAIMED      The amount to transfer is fixed and may already be in the payee's balance, so the
 *                refund is booked, in the same transaction, as a debit against the payee that the
 *                next transfer to them nets off (oldest first, never below zero). Nothing is pulled
 *                back from the payee.
 *
 * The cache raise is a compare-and-swap on (state, reversedUsdCents, transferUsdCents) inside a
 * transaction, and the claim is a compare-and-swap on the same fields, so exactly one of them wins
 * every interleaving:
 *
 *   - refund first: the claim misses, re-reads the larger reversed total and sends a smaller amount;
 *   - claim first: the refund's swap misses, it re-reads a claimed row and books a debit.
 *
 * ONE DEBIT PER TRANSITION. Every cache transition is won by exactly one writer, so two concurrent
 * refunds, or a refund racing a redelivery, can neither debit the same cents twice nor lose one;
 * a redelivery finds total <= cache and transitions nothing. `dedupeKey` is the database-level
 * backstop for the same property.
 */

import type { LedgerConfig } from './ledger-config';

/** A reversal that keeps losing its compare-and-swap race is reported, never spun on forever. */
const MAX_REVERSAL_ATTEMPTS = 8;

/* eslint-disable @typescript-eslint/no-explicit-any */
export type ReversalTx = Record<string, any>;
export type ReversalDb = ReversalTx & {
  /** Interactive transaction: all-or-nothing, so the cache raise and its debit cannot part ways. */
  $transaction<T>(fn: (tx: ReversalTx) => Promise<T>): Promise<T>;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

type Row = {
  id: string;
  state: string;
  transferUsdCents: number | null;
  reversedUsdCents: number;
} & Record<string, unknown>;

/** A transfer has been claimed for this row: the amount is fixed and may have left. */
export function isClaimed(row: { state: string; transferUsdCents: number | null }): boolean {
  return row.transferUsdCents != null || row.state === 'SENDING' || row.state === 'SETTLED';
}

export async function applyLedgerReversal(
  db: ReversalDb,
  cfg: LedgerConfig,
  input: { bookingIntentId: string; payeeId: string; totalReversedUsdCents: number },
): Promise<{ found: boolean; debitRecordedUsdCents: number }> {
  const key = {
    [cfg.uniqueKey]: { bookingIntentId: input.bookingIntentId, [cfg.payeeKey]: input.payeeId },
  };
  const select = { id: true, state: true, [cfg.shareKey]: true, reversedUsdCents: true, transferUsdCents: true };

  for (let attempt = 0; attempt < MAX_REVERSAL_ATTEMPTS; attempt += 1) {
    const row = (await db[cfg.entry].findUnique({ where: key, select })) as Row | null;
    if (!row) return { found: false, debitRecordedUsdCents: 0 };

    // Never above the share, never negative.
    const total = Math.max(0, Math.min(input.totalReversedUsdCents, row[cfg.shareKey] as number));
    // MONOTONE: only ever raises the stored total. Markers are append-only, so the true total never
    // falls; a stale writer holding an older, smaller sum therefore changes nothing.
    if (total <= row.reversedUsdCents) break;

    const delta = total - row.reversedUsdCents;
    const claimed = isClaimed(row);

    const won = await db.$transaction(async (tx) => {
      const moved = await tx[cfg.entry].updateMany({
        where: {
          id: row.id,
          state: row.state,
          reversedUsdCents: row.reversedUsdCents,
          transferUsdCents: row.transferUsdCents ?? null,
        },
        data: { reversedUsdCents: total },
      });
      if (moved.count === 0) return false;
      if (claimed) {
        await tx[cfg.adjustment].createMany({
          data: [
            {
              [cfg.payeeKey]: input.payeeId,
              sourceLedgerEntryId: row.id,
              amountUsdCents: delta,
              appliedUsdCents: 0,
              state: 'OPEN',
              reason: 'REFUND',
              dedupeKey: `${cfg.dedupePrefix}:${row.id}:${total}`,
            },
          ],
          skipDuplicates: true,
        });
      }
      return true;
    });
    if (won) break;
    if (attempt === MAX_REVERSAL_ATTEMPTS - 1) {
      // Loud, not silent: the marker is durable, so the next delivery or sweep repairs it, but the
      // cache is behind the markers until then.
      throw new Error(
        `${cfg.kind} reversal for ledger row ${row.id} lost its compare-and-swap ${MAX_REVERSAL_ATTEMPTS} times`,
      );
    }
  }

  // A never-claimed row that is now fully reversed owes nothing and leaves the payable set. Guarded
  // on the reversed total read and on there being no claim, so it cannot overwrite a row that moved.
  const after = (await db[cfg.entry].findUnique({ where: key, select })) as Row | null;
  if (!after) return { found: false, debitRecordedUsdCents: 0 };
  if (
    after.reversedUsdCents >= (after[cfg.shareKey] as number) &&
    after.transferUsdCents == null &&
    cfg.healFrom.includes(after.state)
  ) {
    await db[cfg.entry].updateMany({
      where: {
        id: after.id,
        state: { in: cfg.healFrom },
        transferUsdCents: null,
        reversedUsdCents: after.reversedUsdCents,
      },
      data: { state: 'REVERSED' },
    });
  }

  const debits = (await db[cfg.adjustment].findMany({
    where: { sourceLedgerEntryId: after.id },
    select: { amountUsdCents: true },
  })) as Array<{ amountUsdCents: number }>;
  return { found: true, debitRecordedUsdCents: debits.reduce((sum, d) => sum + d.amountUsdCents, 0) };
}
