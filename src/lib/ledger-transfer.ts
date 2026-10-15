/**
 * MOVING A SHARE TO THE PAYEE'S WHOP BALANCE (referral and recruiter shares; lane R4).
 *
 * Every internal NHP, practitioner, referral, affiliate and recruiting fee is computed on the full
 * purchase price and moved by an internal Whop-to-Whop transfer as soon as the client's payment
 * clears. The transfer is sent for the share's full amount: Whop's payout (withdrawal) fee is taken
 * from each person's own balance when THEY withdraw, so it appears nowhere here.
 *
 * 🚧 `WHOP_TRANSFERS_ENABLED` does not exist in production. While it is not exactly 'true' every
 * function in this file reads nothing, writes nothing and calls nothing, and reports
 * `skipped: transfers disabled`.
 *
 * STATE MACHINE (one per ledger row; `ledger-config.ts` names the states):
 *
 *   waiting --claim--> SENDING --receipt--> SETTLED
 *      ^                  |
 *      +--- release ------+   (an attempt without a receipt: back to waiting)
 *
 *   `waiting` is ACCRUED (recruiter) / PAYABLE (referrer): owed to a payee who can receive money,
 *   or waiting to retry. A payee who cannot receive money yet is not selected and loses nothing.
 *
 * THE TWO TRIGGERS. The payment webhook (the sole writer of PAID) settles the one row its payment
 * just accrued, in the same run via `waitUntil`; the hourly whop-reconcile cron is the retry backstop
 * for every row with no confirmed receipt, including rows whose payee became payable later.
 * Both go through the same guarded claim, so exactly one of them sends.
 *
 * NO DOUBLE PAYMENT:
 *   - CLAIM, THEN CALL. One guarded `UPDATE ... WHERE id = ? AND state = <waiting> AND
 *     reversedUsdCents = ? AND transferUsdCents IS NULL` moves the row to SENDING and fixes the
 *     amount. The loser of a race matches nothing and skips.
 *   - THE AMOUNT IS FIXED WHILE A TRANSFER MAY EXIST (`transferUsdCents`). Every retry sends that
 *     amount with the same `idempotence_key` (the ledger row id). A refund while the amount is fixed
 *     is a debit against the payee's next transfer (`ledger-reversal.ts`), never a change to it.
 *   - AN ATTEMPT WITH AN UNKNOWN OUTCOME (timeout, 5xx, network error after the request was sent) is
 *     NEVER blindly re-sent. "No row matched" is not "no transfer exists": the lookup can only say so
 *     when its list is usable (`findTransfer` answers found / not-found / unknown) AND the operator has
 *     recorded that the canary proved the key or the metadata lookup works
 *     (`WHOP_TRANSFERS_IDEMPOTENCE_VERIFIED=true`). Until then such a row waits for a person
 *     (`attentionReason = ambiguous-unverified`): the retry selection excludes it, the cron returns
 *     207, the admin table lists it, and an admin records "it went out (transfer id)" or "it did not go
 *     out" (`transfer-attention.ts`). A transfer found in Whop settles the row either way, because a
 *     found transfer is positive evidence. Once the gate is true an unknown outcome is retried with
 *     backoff, the lookup first, the same key and the same amount.
 *
 * A FAILED ATTEMPT IS CLASSIFIED (`classifyTransferFailure`):
 *   RETRY      Whop answered "no" for a reason that passes (insufficient available balance, rate
 *              limit): nothing exists.
 *   PARKED     Whop answered "no" for a reason that retrying will not fix (not verified, not allowed,
 *              invalid): nothing exists, long retry delay, an alert.
 *   AMBIGUOUS  Timeout, network error, 5xx: the transfer may exist (see above).
 *   After a RETRY or PARKED answer to an attempt that no earlier unknown outcome preceded, the row is
 *   made fresh again (`restoreRowToFresh`): the fixed amount is cleared and the debits the claim
 *   applied are restored, so a refund that arrives before the next claim reduces the share.
 *
 * REFUND NETTING. Claiming a row first nets the payee's open debits against it, oldest first, in the
 * SAME transaction as the claim and with a compare-and-swap on each debit, so two settles that read
 * the same debit cannot both apply it. A share the debits swallow whole is SETTLED with nothing
 * sent; the unpaid remainder of a debit carries to later transfers, and a payout is never negative.
 *
 * AMOUNTS (cents). gross = the share payable at claim (share - reversed). net = what was transferred
 * (gross minus the debit applied). The two are identical when no debit applied.
 */

import { isWhopPlatformsReady, WhopNotConfigured, type LedgerTransferLookup } from './whop';
import { RETIREMENT_SENTINEL, bookableWhere } from './practitioner-indexer';
import { AFFILIATE_LEDGER, REFERRAL_LEDGER, type LedgerConfig } from './ledger-config';
import { isPayable } from './referral-settlement';

export const TRANSFERS_DISABLED_REASON = 'skipped: transfers disabled';

/** Whop validates this BEFORE direction, ownership or balance — measured 2026-09-19. */
export const MAX_TRANSFER_USD_CENTS = 2_500_000;

/** A SENDING row whose attempt has not finished this long after it was claimed is looked up in Whop. */
export const STALE_SENDING_AFTER_MS = 10 * 60 * 1000;
/** A row with no confirmed receipt this long after accrual raises an alert. */
export const UNCONFIRMED_AFTER_MS = 30 * 60 * 1000;
/** Retry delay for a definitive refusal that retrying will not fix by itself. */
export const PARKED_RETRY_MS = 6 * 60 * 60 * 1000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;
/** The `attentionReason` of a row whose transfer outcome is unknown and cannot be verified. */
export const AMBIGUOUS_UNVERIFIED = 'ambiguous-unverified';
/** A netting transaction that loses its compare-and-swap is re-read and retried this many times. */
const MAX_NETTING_ATTEMPTS = 4;
const BATCH = 50;

/**
 * Convert an internal cent amount to the DOLLARS the transfers endpoint expects.
 *
 * ⚠️ THE 100× TRAP. Whop takes DOLLARS on every money field, while our ledgers hold CENTS. The
 * validation is the point: a fractional cent means an upstream rounding bug reached the payout
 * boundary, and silently rounding it would hand somebody a different share than the ledger says
 * they are owed — on the one call that cannot be undone.
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
 * May we move money right now? FAILS CLOSED and returns a REASON rather than a boolean, because the
 * two ways this can be off need different actions: one is a dashboard verification and the other is
 * a missing API key.
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
        'Payouts are switched off. The parent company is not business-verified, and Whop refuses ' +
        'every transfer from it ("Please verify your business before transferring funds"). ' +
        'Complete verification in the Whop dashboard, then set WHOP_TRANSFERS_ENABLED=true.',
    };
  }
  return { allowed: true };
}

/**
 * `WHOP_TRANSFERS_ALLOWLIST`: comma-separated practitioner ids. Unset means no restriction. When it
 * is set, ONLY those payees are ever transferred to; every other row stays waiting. A value that
 * names nobody (blank, or only commas) is an empty allowlist: it pays nobody.
 */
export function transfersAllowlist(env: Record<string, string | undefined> = process.env): Set<string> | null {
  const raw = env.WHOP_TRANSFERS_ALLOWLIST;
  if (raw === undefined) return null;
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * `WHOP_TRANSFERS_IDEMPOTENCE_VERIFIED`, exactly 'true': the operator's record that the canary
 * (scripts/whop-canary-transfer.ts, Step 0) showed Whop honours the idempotence key or that the
 * metadata lookup finds a transfer. Only then may an attempt with an unknown outcome be re-sent.
 */
export function idempotenceVerified(env: Record<string, string | undefined> = process.env): boolean {
  return env.WHOP_TRANSFERS_IDEMPOTENCE_VERIFIED === 'true';
}

/** The transfer call itself, injected so nothing in the test suite can reach the live API. */
export type TransferFn = (args: {
  originId: string;
  destinationId: string;
  /** DOLLARS. See `toTransferDollars`. */
  amountUsdDollars: number;
  metadata?: Record<string, string>;
  idempotenceKey?: string;
}) => Promise<{ transferId: string }>;

/**
 * Looks for the transfer made for a ledger row. `not-found` is positive evidence of absence only (see
 * `findTransfer`); a list that cannot answer is `unknown`, and so is a lookup that throws.
 */
export type LookupFn = (args: {
  originId: string;
  destinationId: string;
  ledgerEntryId: string;
  createdAfter?: Date;
}) => Promise<LedgerTransferLookup>;

export type TransferFailure = 'RETRY' | 'AMBIGUOUS' | 'PARKED';

/**
 * Classify a failed `POST /transfers`. `whopPost` throws `Whop /transfers failed (<status>): ...`
 * for a non-2xx answer; anything else (timeout, DNS, reset) never produced an answer at all.
 */
export function classifyTransferFailure(err: unknown): TransferFailure {
  if (err instanceof WhopNotConfigured) return 'PARKED';
  const message = err instanceof Error ? err.message : String(err);
  const m = /^Whop \/transfers failed \((\d{3})\)/.exec(message);
  if (!m) return 'AMBIGUOUS';
  const status = Number(m[1]);
  if (status === 429) return 'RETRY';
  if (status === 408 || status === 409 || status >= 500) return 'AMBIGUOUS';
  if (status >= 400) {
    return /insufficient|available balance|not enough/i.test(message) ? 'RETRY' : 'PARKED';
  }
  return 'AMBIGUOUS';
}

/** Exponential backoff: 1, 2, 4 ... minutes, capped at an hour. `attempts` counts claims so far. */
export function retryDelayMs(attempts: number): number {
  const minutes = 2 ** Math.max(0, Math.min(attempts, 12) - 1);
  return Math.min(MAX_BACKOFF_MS, minutes * 60 * 1000);
}

/**
 * "While both are active" (spec section 5), checked again at the moment of payment: the same
 * `bookableWhere()` predicate the fee path uses to accept the recruiter at mint (not archived, not
 * retired). The share was earned and is NOT dropped when a recruiter goes inactive: the row simply
 * stays waiting, and pays if they are reinstated.
 */
function isActivePayee(p: { archivedAt?: Date | null; trialEndsAt?: Date | null } | null): boolean {
  if (!p || p.archivedAt != null) return false;
  return p.trialEndsAt == null || p.trialEndsAt.getTime() > RETIREMENT_SENTINEL.getTime();
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export type LedgerTx = Record<string, any>;
export type LedgerTransferDb = LedgerTx & {
  $transaction<T>(fn: (tx: LedgerTx) => Promise<T>): Promise<T>;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

export type LedgerSettlementSummary = {
  matched: number;
  /** Rows that reached SETTLED this run (transferred, recovered by lookup, or swallowed by debits). */
  settled: number;
  skipped: number;
  /** Attempts that did not produce a receipt this run. */
  failed: number;
  /** Failed attempts that went back to waiting for a retry. */
  retrying: number;
  /** Rows parked after a definitive refusal that retrying will not fix. */
  parked: number;
  /** Rows settled from a transfer Whop already had, without sending. */
  recovered: number;
  /** Attempts with an unknown outcome parked for a person (the lookup is not verified). */
  needsAttention: number;
  /** The wall-clock budget ran out: the remaining rows were left for the next run. */
  budgetExhausted: boolean;
  /** How many rows that left untouched. */
  deferred: number;
  /** Rows on which at least one refund debit was netted this run. */
  netted: number;
  /** Total cents of refund debits netted this run. */
  debitAppliedUsdCents: number;
  /** Set when nothing ran, with the reason. Null when settlement ran. */
  blocked: string | null;
};

const emptySummary = (): LedgerSettlementSummary => ({
  matched: 0,
  settled: 0,
  skipped: 0,
  failed: 0,
  retrying: 0,
  parked: 0,
  recovered: 0,
  needsAttention: 0,
  budgetExhausted: false,
  deferred: 0,
  netted: 0,
  debitAppliedUsdCents: 0,
  blocked: null,
});

type Payee = {
  whopCompanyId: string | null;
  whopPayoutsEnabled: boolean;
  archivedAt?: Date | null;
  trialEndsAt?: Date | null;
};

type Candidate = {
  id: string;
  bookingIntentId: string;
  state: string;
  payeeId: string;
  share: number;
  reversed: number;
  transferUsdCents: number | null;
  attempts: number;
  createdAt: Date;
  /** An earlier attempt ended with an unknown outcome: a transfer may exist. */
  maybeSentAt: Date | null;
  payee: Payee | null;
};

function selectFor(cfg: LedgerConfig) {
  return {
    id: true,
    bookingIntentId: true,
    state: true,
    createdAt: true,
    [cfg.payeeKey]: true,
    [cfg.shareKey]: true,
    reversedUsdCents: true,
    transferUsdCents: true,
    transferAttempts: true,
    maybeSentAt: true,
    [cfg.payeeRel]: {
      select: { whopCompanyId: true, whopPayoutsEnabled: true, archivedAt: true, trialEndsAt: true },
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toCandidate(cfg: LedgerConfig, raw: any): Candidate {
  return {
    id: raw.id,
    bookingIntentId: raw.bookingIntentId,
    state: raw.state,
    payeeId: raw[cfg.payeeKey],
    share: raw[cfg.shareKey],
    reversed: raw.reversedUsdCents ?? 0,
    transferUsdCents: raw.transferUsdCents ?? null,
    attempts: raw.transferAttempts ?? 0,
    createdAt: raw.createdAt,
    maybeSentAt: raw.maybeSentAt ?? null,
    payee: raw[cfg.payeeRel] ?? null,
  };
}

function payeeFilter(cfg: LedgerConfig) {
  return {
    whopCompanyId: { not: null },
    whopPayoutsEnabled: true,
    ...(cfg.activePayeeOnly ? bookableWhere() : {}),
  };
}

/** Thrown inside a netting or restoring transaction to roll it back when a debit moved under it. */
class NettingConflict extends Error {}

type Allocation = { id: string; amountUsdCents: number };

function parseAllocations(raw: unknown): Allocation[] {
  if (typeof raw !== 'string' || raw === '') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (a): a is Allocation => !!a && typeof a.id === 'string' && Number.isInteger(a.amountUsdCents) && a.amountUsdCents > 0,
        )
      : [];
  } catch {
    return [];
  }
}

type Fresh =
  /** The claim missed: the row moved (another run, or a refund). Nothing was written. */
  | { kind: 'MISSED' }
  /** The amount is not a valid transfer amount. Nothing was written. */
  | { kind: 'BAD_AMOUNT'; message: string }
  /** Claimed SENDING (and debits applied, atomically). The caller now makes the transfer. */
  | { kind: 'SEND'; amountCents: number; debitApplied: number }
  /** Debits swallowed the whole share: SETTLED with nothing sent. */
  | { kind: 'SWALLOWED'; debitApplied: number };

/**
 * The atomic heart: read the payee's open debits, decide what to net, CLAIM the row (fixing its
 * transfer amount and recording how the netting was split) and apply the debits, all in one
 * transaction. See the module docstring.
 */
async function claimFresh(db: LedgerTransferDb, cfg: LedgerConfig, row: Candidate, at: Date): Promise<Fresh> {
  return db.$transaction(async (tx): Promise<Fresh> => {
    const gross = row.share - row.reversed;

    // Oldest debit first, with the id as the tie-break so concurrent settles lock in the same order.
    const debits = ((await tx[cfg.adjustment].findMany({
      where: { [cfg.payeeKey]: row.payeeId, state: 'OPEN' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, amountUsdCents: true, appliedUsdCents: true },
    })) as Array<{ id: string; amountUsdCents: number; appliedUsdCents: number }>).filter(
      (d) => d.amountUsdCents - d.appliedUsdCents > 0,
    );
    const openBalance = debits.reduce((sum, d) => sum + (d.amountUsdCents - d.appliedUsdCents), 0);

    // Never more than the share is worth, never more than is owed: the payout cannot go negative.
    const debitApplied = Math.min(gross, openBalance);
    const net = gross - debitApplied;

    if (net > 0) {
      try {
        toTransferDollars(net);
      } catch (err) {
        return { kind: 'BAD_AMOUNT', message: err instanceof Error ? err.message : String(err) };
      }
    }

    // How much of each debit this claim takes, decided before the claim so it is recorded on the row.
    const plan: Array<{ d: (typeof debits)[number]; take: number }> = [];
    let left = debitApplied;
    for (const d of debits) {
      if (left <= 0) break;
      const take = Math.min(left, d.amountUsdCents - d.appliedUsdCents);
      plan.push({ d, take });
      left -= take;
    }

    // The claim names the state, the refund total AND the absence of an earlier claim, so none of
    // the three can have moved since this row was read.
    const claimed = await tx[cfg.entry].updateMany({
      where: { id: row.id, state: cfg.waiting, reversedUsdCents: row.reversed, transferUsdCents: null },
      data: {
        grossShareUsdCents: gross,
        transferUsdCents: net,
        adjustmentAppliedUsdCents: debitApplied > 0 ? debitApplied : null,
        adjustmentAllocations:
          plan.length > 0 ? JSON.stringify(plan.map((p) => ({ id: p.d.id, amountUsdCents: p.take }))) : null,
        lastError: null,
        nextAttemptAt: null,
        ...(net > 0
          ? { state: 'SENDING', netPaidUsdCents: null, transferAttempts: row.attempts + 1, lastAttemptAt: at }
          : { state: 'SETTLED', netPaidUsdCents: 0, settledAt: at }),
      },
    });
    if (claimed.count === 0) return { kind: 'MISSED' };

    for (const { d, take } of plan) {
      const nowApplied = d.appliedUsdCents + take;
      const swapped = await tx[cfg.adjustment].updateMany({
        // The CAS: still OPEN and still at the applied total we read. Another settle that took any
        // of this debit in between makes it miss, and the whole transaction (claim included) rolls back.
        where: { id: d.id, state: 'OPEN', appliedUsdCents: d.appliedUsdCents },
        data: { appliedUsdCents: nowApplied, state: nowApplied >= d.amountUsdCents ? 'APPLIED' : 'OPEN' },
      });
      if (swapped.count === 0) throw new NettingConflict();
    }

    return net > 0 ? { kind: 'SEND', amountCents: net, debitApplied } : { kind: 'SWALLOWED', debitApplied };
  });
}

/**
 * A DEFINITIVE refusal (Whop answered "no": nothing was created) of an attempt that could not have
 * been preceded by one with an unknown outcome: make the row fresh again. The fixed transfer amount
 * is cleared and the debits the claim applied are restored exactly (from the recorded allocations),
 * all in one transaction, so a refund that arrives before the next claim REDUCES the share instead
 * of becoming a debit on a transfer that never left.
 *
 * Not done (returns false, and the caller keeps the fixed amount) when a refund landed while the
 * attempt was in flight: that refund is already a debit and its reduction is already on the row, and
 * un-fixing the amount would charge it twice.
 */
export async function restoreRowToFresh(
  db: LedgerTransferDb,
  cfg: LedgerConfig,
  input: {
    rowId: string;
    fromState: string;
    patch: Record<string, unknown>;
    /** Runs inside the same transaction once the row is fresh (e.g. an audit row). */
    afterRestore?: (tx: LedgerTx) => Promise<void>;
  },
): Promise<boolean> {
  try {
    return await db.$transaction(async (tx) => {
      const cur = await tx[cfg.entry].findUnique({
        where: { id: input.rowId },
        select: {
          state: true,
          transferUsdCents: true,
          reversedUsdCents: true,
          grossShareUsdCents: true,
          adjustmentAllocations: true,
          [cfg.shareKey]: true,
        },
      });
      if (!cur || cur.state !== input.fromState || cur.transferUsdCents == null) return false;
      const share = cur[cfg.shareKey] as number;
      const reversedAtClaim = share - (cur.grossShareUsdCents ?? share);
      if (cur.reversedUsdCents !== reversedAtClaim) return false;

      for (const a of parseAllocations(cur.adjustmentAllocations)) {
        const [d] = (await tx[cfg.adjustment].findMany({
          where: { id: a.id },
          select: { id: true, appliedUsdCents: true },
        })) as Array<{ id: string; appliedUsdCents: number }>;
        if (!d || d.appliedUsdCents < a.amountUsdCents) throw new NettingConflict();
        const restored = await tx[cfg.adjustment].updateMany({
          where: { id: d.id, appliedUsdCents: d.appliedUsdCents },
          data: { appliedUsdCents: d.appliedUsdCents - a.amountUsdCents, state: 'OPEN' },
        });
        if (restored.count === 0) throw new NettingConflict();
      }

      const fresh = await tx[cfg.entry].updateMany({
        where: {
          id: input.rowId,
          state: input.fromState,
          transferUsdCents: cur.transferUsdCents,
          reversedUsdCents: cur.reversedUsdCents,
        },
        data: {
          state: cfg.waiting,
          transferUsdCents: null,
          grossShareUsdCents: share,
          netPaidUsdCents: null,
          adjustmentAppliedUsdCents: null,
          adjustmentAllocations: null,
          maybeSentAt: null,
          attentionReason: null,
          ...input.patch,
        },
      });
      if (fresh.count === 0) throw new NettingConflict();
      await input.afterRestore?.(tx);
      return true;
    });
  } catch (err) {
    if (err instanceof NettingConflict) return false;
    throw err;
  }
}

type ReleaseMode = 'retry' | 'parked' | 'ambiguous' | 'attention';

/**
 * Put a SENDING row back to waiting after an attempt that produced no receipt.
 *
 *   retry / parked  Whop answered "no". When no earlier attempt could have created a transfer, the row
 *                   is made fresh again (`restoreRowToFresh`); otherwise it keeps its fixed amount.
 *   ambiguous       the outcome is unknown: the amount stays fixed, `maybeSentAt` is set and the row is
 *                   retried with backoff (lookup first), which is only allowed once the lookup is verified.
 *   attention       the outcome is unknown and the lookup is not verified: the row waits for a person
 *                   (`attentionReason`) and the retry selection excludes it.
 */
async function releaseAttempt(
  db: LedgerTransferDb,
  cfg: LedgerConfig,
  row: Candidate,
  attemptsNow: number,
  mode: ReleaseMode,
  message: string,
  at: Date,
  canRestore: boolean,
): Promise<void> {
  const parked = mode === 'parked';
  const lastError = (parked ? `PARKED: ${message}` : message).slice(0, 500);
  const nextAttemptAt =
    mode === 'attention' ? null : new Date(at.getTime() + (parked ? PARKED_RETRY_MS : retryDelayMs(attemptsNow)));

  if ((mode === 'retry' || mode === 'parked') && canRestore) {
    const restored = await restoreRowToFresh(db, cfg, {
      rowId: row.id,
      fromState: 'SENDING',
      patch: { lastError, nextAttemptAt },
    });
    if (restored) return;
  }

  await db[cfg.entry].updateMany({
    where: { id: row.id, state: 'SENDING' },
    data: {
      state: cfg.waiting,
      lastError,
      nextAttemptAt,
      ...(mode === 'ambiguous' || mode === 'attention' ? { maybeSentAt: row.maybeSentAt ?? at } : {}),
      ...(mode === 'attention' ? { attentionReason: AMBIGUOUS_UNVERIFIED } : {}),
    },
  });
}

/** The referral path also keeps its append-only fee-ledger receipt for the transfer. */
export async function recordFeeLedgerReceipt(
  db: LedgerTransferDb,
  cfg: LedgerConfig,
  row: { id: string; bookingIntentId: string; payeeId: string },
  info: { transferId: string; netCents: number },
): Promise<void> {
  if (cfg.kind !== 'referral' || !db.feeLedgerEntry) return;
  const dedupeKey = `REFERRER_TRANSFER:${row.id}`;
  await db.feeLedgerEntry.upsert({
    where: { dedupeKey },
    create: {
      dedupeKey,
      kind: 'REFERRER_TRANSFER',
      status: 'SETTLED',
      bookingIntentId: row.bookingIntentId,
      practitionerId: row.payeeId,
      amountUsdCents: info.netCents,
      whopTransferId: info.transferId,
      note: 'Referral share transferred to the referrer’s Whop balance.',
    },
    update: { status: 'SETTLED', whopTransferId: info.transferId, amountUsdCents: info.netCents },
  });
}

export type SettleOptions = {
  transfer: TransferFn;
  lookup: LookupFn;
  at: Date;
  /** Restrict the run to ONE ledger row (the post-payment trigger). Same rules, same guards. */
  only?: { bookingIntentId: string; payeeId: string };
  /**
   * A wall-clock budget (epoch ms). Rows are processed oldest first; once it passes, the run stops
   * cleanly, reports `budgetExhausted` and leaves the remaining rows untouched for the next run.
   */
  deadlineMs?: number;
};

export async function settleLedger(
  db: LedgerTransferDb,
  cfg: LedgerConfig,
  opts: SettleOptions,
): Promise<LedgerSettlementSummary> {
  const summary = emptySummary();

  // The literal string, not a truthy check: "false" or "0" must not open a money path. Checked
  // BEFORE any read so a disabled run is provably inert.
  if (process.env.WHOP_TRANSFERS_ENABLED !== 'true') {
    summary.blocked = TRANSFERS_DISABLED_REASON;
    return summary;
  }
  const guard = payoutsGuard();
  if (!guard.allowed) {
    summary.blocked = guard.reason;
    return summary;
  }

  const at = opts.at;
  const originId = process.env.WHOP_PARENT_COMPANY_ID!;
  const allowlist = transfersAllowlist();
  const scope = opts.only ? { bookingIntentId: opts.only.bookingIntentId, [cfg.payeeKey]: opts.only.payeeId } : {};
  const allowScope = allowlist ? { [cfg.payeeKey]: { in: Array.from(allowlist) } } : {};
  const select = selectFor(cfg);

  // Waiting rows whose payee can receive money and whose retry time has come. A payee who cannot
  // receive money yet is simply not selected and stays waiting, forfeiting nothing. Rows waiting for
  // a person (`attentionReason`) are never selected.
  const due = (await db[cfg.entry].findMany({
    where: {
      ...scope,
      ...allowScope,
      state: cfg.waiting,
      settledAt: null,
      attentionReason: null,
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: at } }],
      [cfg.payeeRel]: payeeFilter(cfg),
    },
    select,
    orderBy: { createdAt: 'asc' },
    take: BATCH,
  })) as unknown[];

  // SENDING rows whose attempt never finished (the run died, or the receipt could not be recorded).
  const stale = (await db[cfg.entry].findMany({
    where: {
      ...scope,
      ...allowScope,
      state: 'SENDING',
      settledAt: null,
      lastAttemptAt: { lte: new Date(at.getTime() - STALE_SENDING_AFTER_MS) },
      [cfg.payeeRel]: { whopCompanyId: { not: null } },
    },
    select,
    orderBy: { createdAt: 'asc' },
    take: BATCH,
  })) as unknown[];

  // Rows waiting for a person: only ever LOOKED UP here (a transfer found is positive evidence and
  // settles the row); nothing is sent for them.
  const flagged = (await db[cfg.entry].findMany({
    where: {
      ...scope,
      ...allowScope,
      state: cfg.waiting,
      settledAt: null,
      attentionReason: { not: null },
      [cfg.payeeRel]: { whopCompanyId: { not: null } },
    },
    select,
    orderBy: { createdAt: 'asc' },
    take: BATCH,
  })) as unknown[];

  const toSend = [...due, ...stale]
    .map((r) => toCandidate(cfg, r))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const toCheck = flagged.map((r) => toCandidate(cfg, r));
  summary.matched = toSend.length + toCheck.length;

  const work: Array<() => Promise<void>> = [
    ...toCheck.map((row) => () => recoverFlaggedRow(db, cfg, row, { ...opts, originId }, summary)),
    ...toSend.map((row) => () => processRow(db, cfg, row, { ...opts, originId, allowlist }, summary)),
  ];
  const ids = [...toCheck, ...toSend].map((r) => r.id);

  for (let i = 0; i < work.length; i += 1) {
    if (opts.deadlineMs !== undefined && Date.now() >= opts.deadlineMs) {
      summary.budgetExhausted = true;
      summary.deferred = work.length - i;
      break;
    }
    try {
      await work[i]();
    } catch (err) {
      summary.failed += 1;
      console.error(
        `[${cfg.logTag}] ROW FAILED`,
        JSON.stringify({ entryId: ids[i], error: err instanceof Error ? err.message : String(err) }),
      );
    }
  }
  return summary;
}

/** The lookup result for a row, with a thrown failure folded into `unknown`. */
async function lookupRow(
  lookup: LookupFn,
  args: { originId: string; destinationId: string; row: Candidate },
): Promise<LedgerTransferLookup> {
  try {
    return await lookup({
      originId: args.originId,
      destinationId: args.destinationId,
      ledgerEntryId: args.row.id,
      createdAfter: args.row.createdAt,
    });
  } catch (err) {
    return { kind: 'unknown', reason: `transfer lookup failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function foundNet(
  cfg: LedgerConfig,
  row: Candidate,
  found: { transferId: string; amountUsdDollars: number },
  claimedCents: number,
): number {
  const foundCents = Math.round(found.amountUsdDollars * 100);
  if (Number.isInteger(foundCents) && foundCents !== claimedCents) {
    console.error(
      `[${cfg.logTag}] FOUND TRANSFER DIFFERS FROM THE CLAIMED AMOUNT`,
      JSON.stringify({ entryId: row.id, transferId: found.transferId, claimedUsdCents: claimedCents, foundUsdCents: foundCents }),
    );
    return foundCents;
  }
  return claimedCents;
}

/** A row waiting for a person: settle it only if Whop shows its transfer. */
async function recoverFlaggedRow(
  db: LedgerTransferDb,
  cfg: LedgerConfig,
  row: Candidate,
  ctx: { lookup: LookupFn; at: Date; originId: string },
  summary: LedgerSettlementSummary,
): Promise<void> {
  const destination = row.payee?.whopCompanyId;
  if (!destination || row.transferUsdCents == null) {
    summary.skipped += 1;
    return;
  }
  const result = await lookupRow(ctx.lookup, { originId: ctx.originId, destinationId: destination, row });
  if (result.kind !== 'found') {
    summary.skipped += 1;
    return;
  }
  const netCents = foundNet(cfg, row, result, row.transferUsdCents);
  const done = await db[cfg.entry].updateMany({
    where: { id: row.id, state: cfg.waiting, attentionReason: { not: null }, settledAt: null },
    data: {
      state: 'SETTLED',
      settledAt: ctx.at,
      whopTransferId: result.transferId,
      netPaidUsdCents: netCents,
      lastError: null,
      nextAttemptAt: null,
      attentionReason: null,
    },
  });
  if (done.count === 0) {
    summary.skipped += 1;
    return;
  }
  summary.settled += 1;
  summary.recovered += 1;
  try {
    await recordFeeLedgerReceipt(db, cfg, row, { transferId: result.transferId, netCents });
  } catch (err) {
    console.error(
      `[${cfg.logTag}] FEE LEDGER RECEIPT NOT WRITTEN`,
      JSON.stringify({ entryId: row.id, transferId: result.transferId, error: err instanceof Error ? err.message : String(err) }),
    );
  }
}

async function processRow(
  db: LedgerTransferDb,
  cfg: LedgerConfig,
  row: Candidate,
  ctx: { transfer: TransferFn; lookup: LookupFn; at: Date; originId: string; allowlist: Set<string> | null },
  summary: LedgerSettlementSummary,
): Promise<void> {
  const { at } = ctx;
  const destination = row.payee?.whopCompanyId ?? null;
  const mayPay = () =>
    isPayable(row.payee) &&
    (!cfg.activePayeeOnly || isActivePayee(row.payee)) &&
    (!ctx.allowlist || ctx.allowlist.has(row.payeeId));

  if (!destination) {
    summary.skipped += 1;
    return;
  }

  let amountCents: number;
  let attemptsNow: number;
  /** A transfer for this row may already exist in Whop: look before any send. */
  let needsLookup: boolean;
  /** No earlier attempt could have created a transfer, so a definitive refusal leaves nothing behind. */
  let canRestore: boolean;

  if (row.transferUsdCents == null) {
    // A FRESH row: nothing has been claimed for it yet.
    if (!mayPay()) {
      summary.skipped += 1;
      return;
    }
    const owed = row.share - row.reversed;
    if (owed <= 0) {
      // HEAL, don't just skip: a fully reversed row that the refund path did not get to flip would
      // otherwise sit at the front of the oldest-first batch forever and starve the rows behind it.
      await db[cfg.entry].updateMany({
        where: { id: row.id, state: cfg.waiting, reversedUsdCents: row.reversed, transferUsdCents: null },
        data: { state: 'REVERSED' },
      });
      summary.skipped += 1;
      return;
    }

    let outcome: Fresh | null = null;
    for (let attempt = 0; attempt < MAX_NETTING_ATTEMPTS && !outcome; attempt += 1) {
      try {
        outcome = await claimFresh(db, cfg, row, at);
      } catch (err) {
        if (!(err instanceof NettingConflict)) throw err;
        // Another settle took a debit we were about to apply; our transaction rolled back whole.
        // Re-read and try again (the claim will simply miss if that run took this row too).
      }
    }
    if (!outcome) {
      summary.skipped += 1;
      console.error(`[${cfg.logTag}] NETTING CONFLICT, left for the next run`, JSON.stringify({ entryId: row.id }));
      return;
    }
    if (outcome.kind === 'MISSED') {
      summary.skipped += 1;
      return;
    }
    if (outcome.kind === 'BAD_AMOUNT') {
      // A malformed amount reached the payout boundary: an upstream bug, not a transient fault.
      await db[cfg.entry].updateMany({
        where: { id: row.id, state: cfg.waiting, transferUsdCents: null },
        data: {
          lastError: `PARKED: ${outcome.message}`.slice(0, 500),
          nextAttemptAt: new Date(at.getTime() + PARKED_RETRY_MS),
        },
      });
      summary.parked += 1;
      summary.failed += 1;
      console.error(`[${cfg.logTag}] BAD AMOUNT`, JSON.stringify({ entryId: row.id, error: outcome.message }));
      return;
    }
    if (outcome.debitApplied > 0) {
      summary.netted += 1;
      summary.debitAppliedUsdCents += outcome.debitApplied;
    }
    if (outcome.kind === 'SWALLOWED') {
      summary.settled += 1;
      return;
    }
    amountCents = outcome.amountCents;
    attemptsNow = row.attempts + 1;
    needsLookup = false;
    canRestore = true;
  } else {
    // A row that was claimed before: a retry of an attempt, or a SENDING row whose run died. The
    // amount is the one fixed at the first claim.
    if (row.state !== 'SENDING' && !mayPay()) {
      summary.skipped += 1;
      return;
    }
    const reclaimed = await db[cfg.entry].updateMany({
      where: {
        id: row.id,
        state: row.state,
        transferUsdCents: row.transferUsdCents,
        transferAttempts: row.attempts,
        attentionReason: null,
      },
      data: { state: 'SENDING', transferAttempts: row.attempts + 1, lastAttemptAt: at },
    });
    if (reclaimed.count === 0) {
      summary.skipped += 1;
      return;
    }
    amountCents = row.transferUsdCents;
    attemptsNow = row.attempts + 1;
    // A SENDING row's run died mid-flight, and a waiting row with `maybeSentAt` ended an attempt with an
    // unknown outcome: either may have created a transfer. A waiting row without it was refused outright.
    needsLookup = row.state === 'SENDING' || row.maybeSentAt != null;
    canRestore = !needsLookup;
  }

  const verified = idempotenceVerified();

  const release = async (mode: ReleaseMode, message: string) => {
    summary.failed += 1;
    if (mode === 'parked') summary.parked += 1;
    else if (mode === 'attention') summary.needsAttention += 1;
    else summary.retrying += 1;
    await releaseAttempt(db, cfg, row, attemptsNow, mode, message, at, canRestore);
    console.error(
      `[${cfg.logTag}] TRANSFER ${mode === 'parked' ? 'PARKED' : mode === 'attention' ? 'NEEDS ATTENTION' : 'FAILED'}`,
      JSON.stringify({ entryId: row.id, mode, attempt: attemptsNow, error: message }),
    );
  };
  /** An unknown outcome: retry (lookup first) once the lookup is verified, otherwise wait for a person. */
  const unknownOutcome = (message: string) => release(verified ? 'ambiguous' : 'attention', message);

  let transferId: string | null = null;
  let netCents = amountCents;

  if (needsLookup) {
    const result = await lookupRow(ctx.lookup, { originId: ctx.originId, destinationId: destination, row });
    if (result.kind === 'found') {
      transferId = result.transferId;
      netCents = foundNet(cfg, row, result, amountCents);
      summary.recovered += 1;
    } else if (result.kind === 'unknown') {
      // The lookup could not see the transfer: "no row matched" is not evidence it does not exist.
      await unknownOutcome(result.reason);
      return;
    } else if (!verified) {
      // The list looks usable, but nothing has proven it would show our transfer.
      await unknownOutcome('ambiguous-unverified: no transfer found, but the transfer lookup has not been verified');
      return;
    } else if (!mayPay()) {
      // Nothing was sent and the payee cannot be paid now: back to waiting, with the reason.
      await release('retry', 'payee cannot receive transfers right now');
      return;
    }
  }

  if (!transferId) {
    try {
      ({ transferId } = await ctx.transfer({
        originId: ctx.originId,
        destinationId: destination,
        amountUsdDollars: toTransferDollars(amountCents),
        metadata: { kind: cfg.kind, ledger_entry_id: row.id, booking_intent_id: row.bookingIntentId },
        idempotenceKey: row.id,
      }));
    } catch (err) {
      const failure = classifyTransferFailure(err);
      const message = err instanceof Error ? err.message : String(err);
      if (failure === 'AMBIGUOUS') await unknownOutcome(message);
      else await release(failure === 'PARKED' ? 'parked' : 'retry', message);
      return;
    }
  }

  // The money has moved. If recording it fails, the row stays SENDING and the next run finds the
  // transfer by lookup; the worst case is a delayed receipt, never a second payment.
  try {
    const done = await db[cfg.entry].updateMany({
      where: { id: row.id, state: 'SENDING' },
      data: {
        state: 'SETTLED',
        settledAt: at,
        whopTransferId: transferId,
        netPaidUsdCents: netCents,
        lastError: null,
        nextAttemptAt: null,
      },
    });
    if (done.count === 0) {
      summary.failed += 1;
      console.error(
        `[${cfg.logTag}] TRANSFER SENT BUT ROW NOT SENDING`,
        JSON.stringify({ entryId: row.id, transferId }),
      );
      return;
    }
    summary.settled += 1;
  } catch (err) {
    summary.failed += 1;
    console.error(
      `[${cfg.logTag}] TRANSFER SENT BUT NOT RECORDED`,
      JSON.stringify({ entryId: row.id, transferId, error: err instanceof Error ? err.message : String(err) }),
    );
    return;
  }

  try {
    await recordFeeLedgerReceipt(db, cfg, row, { transferId, netCents });
  } catch (err) {
    console.error(
      `[${cfg.logTag}] FEE LEDGER RECEIPT NOT WRITTEN`,
      JSON.stringify({ entryId: row.id, transferId, error: err instanceof Error ? err.message : String(err) }),
    );
  }
}

/**
 * The post-payment trigger: settle ONE just-accrued row right away, best effort.
 *
 * Contract, because it runs on the payment webhook's path:
 *   - the flag is checked FIRST and literally: not exactly 'true' means zero reads, zero writes,
 *     zero calls, and it returns null;
 *   - it NEVER throws and never rejects: every failure is logged loudly with the row's ids and the
 *     hourly whop-reconcile cron (which runs the same function over every eligible row) is the
 *     backstop. A webhook ack must never wait on, or fail because of, a payout;
 *   - it is safe to run concurrently with the cron or a webhook redelivery: the guarded claim lets
 *     exactly one of them pay.
 */
export async function settleLedgerEntryBestEffort(
  db: LedgerTransferDb,
  cfg: LedgerConfig,
  input: { bookingIntentId: string; payeeId: string },
  deps: { transfer: TransferFn; lookup: LookupFn; at?: Date },
): Promise<LedgerSettlementSummary | null> {
  if (process.env.WHOP_TRANSFERS_ENABLED !== 'true') return null;
  try {
    const summary = await settleLedger(db, cfg, {
      transfer: deps.transfer,
      lookup: deps.lookup,
      at: deps.at ?? new Date(),
      only: input,
    });
    if (summary.blocked) {
      console.error(`[${cfg.logTag}] IMMEDIATE SETTLE BLOCKED (cron will retry)`, JSON.stringify({ ...input, reason: summary.blocked }));
    } else if (summary.failed > 0) {
      console.error(`[${cfg.logTag}] IMMEDIATE SETTLE FAILED (cron will retry)`, JSON.stringify({ ...input, summary }));
    }
    return summary;
  } catch (err) {
    console.error(
      `[${cfg.logTag}] IMMEDIATE SETTLE THREW (cron will retry)`,
      JSON.stringify({ ...input, error: err instanceof Error ? err.message : String(err) }),
    );
    return null;
  }
}

export type UnconfirmedReason =
  /** A person must decide whether the transfer went out (`attentionReason`). */
  | 'needs-attention'
  /** SENDING for 30+ minutes after accrual. */
  | 'sending'
  /** Waiting for a payee who can receive money, 30+ minutes after accrual. */
  | 'waiting'
  /** Waiting, but the recruiter is archived or retired: nothing will move until they are reinstated. */
  | 'payee-inactive'
  /** A transfer was claimed (it may exist) and the payee can no longer receive money. */
  | 'payee-unpayable';

export type UnconfirmedTransfer = {
  ledger: LedgerConfig['kind'];
  id: string;
  payeeId: string;
  state: string;
  reason: UnconfirmedReason;
  amountUsdCents: number;
  attempts: number;
  lastError: string | null;
  attentionReason: string | null;
  createdAt: Date;
};

/**
 * Rows that should have a receipt by now and do not. A row is listed when it
 *   - is waiting for a person (`attentionReason`), at once; or
 *   - is older than `UNCONFIRMED_AFTER_MS` since accrual and is SENDING, or waiting with a payee who
 *     can receive money (an inactive recruiter included, listed as `payee-inactive`), or waiting with a
 *     transfer already claimed whatever the payee's state now (`payee-unpayable`: it may exist).
 * The cron turns a non-empty result into a 207 and a console.error naming the ids, and the admin page
 * lists them.
 *
 * Empty unless transfers are enabled (while they are off nothing is expected to move), and it
 * respects the allowlist (a row for a payee outside it is not expected to move either). An unclaimed
 * row whose payee cannot receive money yet is not a failure and is not listed.
 */
export async function findUnconfirmedTransfers(
  db: LedgerTransferDb,
  opts: { at: Date },
): Promise<UnconfirmedTransfer[]> {
  if (process.env.WHOP_TRANSFERS_ENABLED !== 'true') return [];
  const allowlist = transfersAllowlist();
  const out: UnconfirmedTransfer[] = [];
  for (const cfg of [AFFILIATE_LEDGER, REFERRAL_LEDGER]) {
    const allowScope = allowlist ? { [cfg.payeeKey]: { in: Array.from(allowlist) } } : {};
    const rows = (await db[cfg.entry].findMany({
      where: {
        ...allowScope,
        settledAt: null,
        OR: [
          { attentionReason: { not: null } },
          {
            createdAt: { lte: new Date(opts.at.getTime() - UNCONFIRMED_AFTER_MS) },
            OR: [
              { state: 'SENDING' },
              { state: cfg.waiting, transferUsdCents: { not: null } },
              { state: cfg.waiting, [cfg.payeeRel]: { whopCompanyId: { not: null }, whopPayoutsEnabled: true } },
            ],
          },
        ],
      },
      select: {
        id: true,
        state: true,
        createdAt: true,
        [cfg.payeeKey]: true,
        [cfg.shareKey]: true,
        reversedUsdCents: true,
        transferUsdCents: true,
        transferAttempts: true,
        lastError: true,
        attentionReason: true,
        [cfg.payeeRel]: { select: { whopCompanyId: true, whopPayoutsEnabled: true, archivedAt: true, trialEndsAt: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: 200,
    })) as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const r of rows) {
      const payee = (r[cfg.payeeRel] ?? null) as Payee | null;
      let reason: UnconfirmedReason;
      if (r.attentionReason) reason = 'needs-attention';
      else if (r.state === 'SENDING') reason = 'sending';
      else if (!isPayable(payee)) reason = 'payee-unpayable';
      else if (cfg.activePayeeOnly && !isActivePayee(payee)) reason = 'payee-inactive';
      else reason = 'waiting';
      out.push({
        ledger: cfg.kind,
        id: r.id,
        payeeId: r[cfg.payeeKey],
        state: r.state,
        reason,
        amountUsdCents: r.transferUsdCents ?? Math.max(0, r[cfg.shareKey] - (r.reversedUsdCents ?? 0)),
        attempts: r.transferAttempts ?? 0,
        lastError: r.lastError ?? null,
        attentionReason: r.attentionReason ?? null,
        createdAt: r.createdAt,
      });
    }
  }
  return out.filter((r) => r.amountUsdCents > 0 || r.state === 'SENDING' || r.reason === 'needs-attention');
}
