/**
 * RESOLVING A ROW WHOSE TRANSFER MAY HAVE GONE OUT (see `ledger-transfer.ts`).
 *
 * An attempt ended with an unknown outcome. Unless the operator has recorded a proof that makes a
 * re-send safe (`WHOP_TRANSFERS_IDEMPOTENCE_VERIFIED`, `WHOP_TRANSFERS_LOOKUP_VERIFIED`) the row is
 * flagged and never retried on its own; with a proof recorded it is retried, but a lookup that stays
 * unusable can leave it retrying for a long time. In both cases an admin looks in Whop (a transfer from
 * the parent whose `metadata.ledger_entry_id` is the row id) and records what they found:
 *
 *   went-out         the transfer exists: record its id. The row is SETTLED; nothing is sent. The id
 *                    must not already be recorded on another ledger row.
 *   did-not-go-out   no transfer exists: the row returns to retry. When nothing could have been sent
 *                    before, it is made fresh again (fixed amount cleared, applied debits restored), so
 *                    a refund that arrives before the next claim reduces the share.
 *
 * A row can be resolved when it is not SETTLED, has a fixed transfer amount, and either is flagged,
 * has an attempt with an unknown outcome (`maybeSentAt`), or is a SENDING row whose attempt is stale.
 *
 * Each resolution is ONE transaction: the compare-and-swap on the row (same state, attempt count,
 * fixed amount and flags as when it was read)
 * and an append-only audit row in the fee ledger (who, which outcome, the stated reason, the transfer
 * id). A refused `went-out` for a duplicate transfer id is audited too. It changes no money by itself;
 * sending is still the settle routine's job.
 */

import { AFFILIATE_LEDGER, REFERRAL_LEDGER, type LedgerConfig, type LedgerKind } from './ledger-config';
import {
  STALE_SENDING_AFTER_MS,
  recordFeeLedgerReceipt,
  restoreRowToFresh,
  type LedgerTransferDb,
  type LedgerTx,
} from './ledger-transfer';

export type AttentionOutcome = 'went-out' | 'did-not-go-out';

export type ResolveResult = { ok: true } | { ok: false; message: string };

const TRANSFER_ID_RE = /^[A-Za-z0-9_-]{3,100}$/;

export async function resolveTransferAttention(
  db: LedgerTransferDb,
  input: {
    ledger: LedgerKind;
    rowId: string;
    outcome: AttentionOutcome;
    /** Required for `went-out`: the Whop transfer id. */
    transferId?: string;
    /** Why the admin believes it: required, kept on the audit row. */
    reason: string;
    adminUserId: string | null;
    at: Date;
  },
): Promise<ResolveResult> {
  const cfg: LedgerConfig = input.ledger === 'affiliate' ? AFFILIATE_LEDGER : REFERRAL_LEDGER;
  const reason = input.reason.trim().slice(0, 500);
  if (reason.length < 3) return { ok: false, message: 'A reason is required (what you checked in Whop).' };
  const transferId = input.transferId?.trim() ?? '';
  if (input.outcome === 'went-out' && !TRANSFER_ID_RE.test(transferId)) {
    return { ok: false, message: 'Enter the Whop transfer id that you found.' };
  }

  const row = (await db[cfg.entry].findUnique({
    where: { id: input.rowId },
    select: {
      id: true,
      bookingIntentId: true,
      state: true,
      settledAt: true,
      transferUsdCents: true,
      transferAttempts: true,
      lastAttemptAt: true,
      maybeSentAt: true,
      attentionReason: true,
      [cfg.payeeKey]: true,
    },
  })) as Record<string, any> | null; // eslint-disable-line @typescript-eslint/no-explicit-any
  const staleInFlight =
    row?.state === 'SENDING' &&
    row.lastAttemptAt != null &&
    row.lastAttemptAt.getTime() <= input.at.getTime() - STALE_SENDING_AFTER_MS;
  const resolvable =
    !!row &&
    row.settledAt == null &&
    row.transferUsdCents != null &&
    (row.state === cfg.waiting || row.state === 'SENDING') &&
    (row.attentionReason != null || row.maybeSentAt != null || staleInFlight);
  if (!row || !resolvable) {
    return { ok: false, message: 'That row is not waiting for a decision (it may already have been resolved).' };
  }
  const payeeId = row[cfg.payeeKey] as string;
  const amount = row.transferUsdCents as number;
  const fromState = row.state as string;

  /** What the decision was made on: if any of it moved since the read, the decision loses. */
  const unchanged = {
    transferAttempts: row.transferAttempts as number,
    transferUsdCents: amount,
    maybeSentAt: (row.maybeSentAt as Date | null) ?? null,
    attentionReason: (row.attentionReason as string | null) ?? null,
  };

  const auditNote = (extra: Record<string, unknown>) =>
    JSON.stringify({
      ledger: cfg.kind,
      ledgerEntryId: row.id,
      outcome: input.outcome,
      reason,
      attentionReason: row.attentionReason ?? null,
      adminUserId: input.adminUserId,
      at: input.at.toISOString(),
      ...extra,
    });

  const audit = async (tx: LedgerTx) => {
    const dedupeKey = `TRANSFER_RESOLUTION:${cfg.kind}:${row.id}:a${row.transferAttempts}`;
    await tx.feeLedgerEntry.upsert({
      where: { dedupeKey },
      create: {
        dedupeKey,
        kind: 'TRANSFER_RESOLUTION',
        status: 'SETTLED',
        bookingIntentId: row.bookingIntentId,
        practitionerId: payeeId,
        amountUsdCents: amount,
        whopTransferId: input.outcome === 'went-out' ? transferId : null,
        note: auditNote({}),
      },
      update: {},
    });
  };

  if (input.outcome === 'went-out') {
    for (const other of [AFFILIATE_LEDGER, REFERRAL_LEDGER]) {
      const taken = (await db[other.entry].findMany({
        where: { whopTransferId: transferId },
        select: { id: true },
        take: 2,
      })) as Array<{ id: string }>;
      if (taken.some((t) => t.id !== row.id)) {
        const dedupeKey = `TRANSFER_RESOLUTION_REFUSED:${cfg.kind}:${row.id}:${transferId}`;
        await db.feeLedgerEntry.upsert({
          where: { dedupeKey },
          create: {
            dedupeKey,
            kind: 'TRANSFER_RESOLUTION_REFUSED',
            status: 'FAILED',
            bookingIntentId: row.bookingIntentId,
            practitionerId: payeeId,
            amountUsdCents: amount,
            whopTransferId: transferId,
            note: auditNote({ refusedBecause: 'transfer id already recorded on another ledger row' }),
          },
          update: {},
        });
        return { ok: false, message: 'That transfer id is already recorded on another ledger row.' };
      }
    }

    const done = await db.$transaction(async (tx) => {
      const settled = await tx[cfg.entry].updateMany({
        where: { id: row.id, state: fromState, settledAt: null, ...unchanged },
        data: {
          state: 'SETTLED',
          settledAt: input.at,
          whopTransferId: transferId,
          netPaidUsdCents: amount,
          lastError: null,
          nextAttemptAt: null,
          attentionReason: null,
        },
      });
      if (settled.count === 0) return false;
      await audit(tx);
      return true;
    });
    if (!done) return { ok: false, message: 'That row changed while you were deciding; reload and check it again.' };
    try {
      await recordFeeLedgerReceipt(db, cfg, { id: row.id, bookingIntentId: row.bookingIntentId, payeeId }, { transferId, netCents: amount });
    } catch (err) {
      console.error(`[${cfg.logTag}] FEE LEDGER RECEIPT NOT WRITTEN`, JSON.stringify({ entryId: row.id, error: err instanceof Error ? err.message : String(err) }));
    }
    return { ok: true };
  }

  // did-not-go-out: retry now. Fresh again when nothing else could have been sent; otherwise just unflagged.
  const patch = { lastError: `admin confirmed the transfer did not go out: ${reason}`.slice(0, 500), nextAttemptAt: null };
  const restored = await restoreRowToFresh(db, cfg, {
    rowId: row.id,
    fromState,
    attempts: row.transferAttempts,
    patch,
    afterRestore: audit,
  });
  if (!restored) {
    const cleared = await db.$transaction(async (tx) => {
      const c = await tx[cfg.entry].updateMany({
        where: { id: row.id, state: fromState, settledAt: null, ...unchanged },
        data: { state: cfg.waiting, attentionReason: null, maybeSentAt: null, ...patch },
      });
      if (c.count === 0) return false;
      await audit(tx);
      return true;
    });
    if (!cleared) return { ok: false, message: 'That row changed while you were deciding; reload and check it again.' };
  }
  return { ok: true };
}
