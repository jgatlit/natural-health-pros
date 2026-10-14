/**
 * The ONLY file of the v1.5 reconcile that writes. Loaded by reconcile-referral-v15.ts after the
 * apply guards (flag, date confirmation, production acknowledgement) have passed.
 *
 * One transaction. For each repriced row it first inserts an audit marker keyed
 * `REPRICE_V15:<ledger id>` (a unique key, so a second run inserts nothing) and only when that
 * insert took effect does it change the share, guarded on the share and state it read. Any
 * unexpected row count rolls the whole batch back.
 *
 * `BEGIN READ WRITE` is what lets this through the session's read-only default; nothing else in
 * the reconcile can write.
 */

import type { PgLike, LedgerRow } from './reconcile-referral-v15';
import type { RepriceChange } from '../src/lib/referral-reprice';

export async function applyRepricing(
  client: PgLike,
  items: Array<{ row: LedgerRow; decision: RepriceChange }>,
  now: Date,
): Promise<{ applied: number; alreadyApplied: number }> {
  let applied = 0;
  let alreadyApplied = 0;
  await client.query('BEGIN READ WRITE');
  try {
    for (const { row, decision } of items) {
      const marker = await client.query(
        `INSERT INTO "FeeLedgerEntry"
           ("id", "kind", "status", "bookingIntentId", "practitionerId", "amountUsdCents", "note", "dedupeKey", "updatedAt")
         VALUES ('repr_' || replace(gen_random_uuid()::text, '-', ''), 'ADMIN_ADJUSTMENT', 'SETTLED', $1, $2, $3, $4, $5, $6)
         ON CONFLICT ("dedupeKey") DO NOTHING
         RETURNING "id"`,
        [
          row.bookingIntentId,
          row.referrerPractitionerId,
          decision.deltaUsdCents,
          JSON.stringify({
            reason: 'fee rule v1.5 re-price',
            ledgerEntryId: row.id,
            from: decision.currentShareUsdCents,
            to: decision.newShareUsdCents,
            detail: decision.reason,
          }),
          `REPRICE_V15:${row.id}`,
          now,
        ],
      );
      if (marker.rows.length === 0) {
        alreadyApplied += 1;
        continue;
      }
      const changed = await client.query(
        `UPDATE "ReferralLedgerEntry"
            SET "referrerShareUsdCents" = $2, "grossShareUsdCents" = $2, "updatedAt" = $4
          WHERE "id" = $1 AND "referrerShareUsdCents" = $3 AND "state" IN ('PAYABLE', 'HELD', 'EXPIRED_UNCLAIMED')`,
        [row.id, decision.newShareUsdCents, decision.currentShareUsdCents, now],
      );
      if (changed.rowCount !== 1) {
        throw new Error(`ledger row ${row.id} changed under the reconcile (rowCount ${changed.rowCount}); rolled back`);
      }
      applied += 1;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
  return { applied, alreadyApplied };
}
