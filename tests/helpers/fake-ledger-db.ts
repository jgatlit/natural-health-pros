/* eslint-disable @typescript-eslint/no-explicit-any */
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * An in-memory stand-in for the two payout ledgers (`affiliateLedgerEntry` /
 * `affiliateBalanceAdjustment` and `referralLedgerEntry` / `referralBalanceAdjustment`), the
 * `feeLedgerEntry` receipts and `$transaction`. It honours the behaviours the payout code relies on,
 * because a fake that ignored them would pass an implementation with no guard at all:
 *
 *   - the UNIQUE (bookingIntentId, payee) constraint, via `upsert` (create-only when `update` is
 *     empty), and the UNIQUE `dedupeKey` on adjustments and fee-ledger rows;
 *   - `updateMany` is ATOMIC and honours `where` on equality, a literal `null`, `{ in }`, `{ not }`,
 *     `{ lt, lte, gt, gte }` (Dates compared by time; null never satisfies a range) and `OR`,
 *     returning the number of rows it actually changed. That count is exactly what the claim, the
 *     debit compare-and-swap and the reversal compare-and-swap depend on;
 *   - `findMany` honours the same filters, including the nested payee-wallet relation filter (the
 *     practitioner fields `whopCompanyId`, `whopPayoutsEnabled`, `archivedAt`, `trialEndsAt`), and
 *     orders by `createdAt` / `updatedAt` / `holdUntil`;
 *   - `$transaction(fn)` runs `fn` against the same delegates and, if `fn` THROWS, undoes every write
 *     it made (and only those). The undo log is tracked per transaction with AsyncLocalStorage, so
 *     two transactions interleaving at await points each roll back their own writes.
 *
 * A write is only observable to other callers at the instant it runs (JS is single-threaded between
 * awaits), which models READ COMMITTED well enough for the compare-and-swap properties under test;
 * it does NOT model row locks, so a test cannot rely on a second writer BLOCKING behind a first.
 */

export type Entry = Record<string, any>;
export type Wallet = {
  whopCompanyId: string | null;
  whopPayoutsEnabled: boolean;
  archivedAt?: Date | null;
  trialEndsAt?: Date | null;
};

type TableOpts = { entries?: Entry[]; adjustments?: Entry[] };

export type FakeLedgerDb = {
  affiliateRows: Entry[];
  affiliateAdjustments: Entry[];
  referralRows: Entry[];
  referralAdjustments: Entry[];
  /** The fee-ledger rows written so far (receipts, reversal markers, anything a test seeds). */
  fees: Entry[];
  hooks: { afterAdjustmentRead?: () => Promise<void> | void };
  $transaction<T>(fn: (tx: any) => Promise<T>): Promise<T>;
  // The delegates are deliberately loose: the code under test types them structurally.
  affiliateLedgerEntry: any;
  affiliateBalanceAdjustment: any;
  referralLedgerEntry: any;
  referralBalanceAdjustment: any;
  feeLedgerEntry: any;
  /** Not provided by the fake; tests that need a booking snapshot assign one. */
  bookingFeeSnapshot: any;
  [delegate: string]: any;
};

const T0 = Date.UTC(2026, 0, 1);

export function fakeLedgerDb(
  opts: {
    practitioners?: Record<string, Wallet>;
    affiliate?: TableOpts;
    referral?: TableOpts;
  } = {},
): FakeLedgerDb {
  const wallets = opts.practitioners ?? {};
  const als = new AsyncLocalStorage<Array<() => void>>();
  const journal = (undo: () => void) => als.getStore()?.push(undo);

  const matchValue = (actual: any, expected: any): boolean => {
    if (expected === null) return actual == null;
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
      const cmp = (a: any) => (a instanceof Date ? a.getTime() : a);
      if ('in' in expected) return expected.in.includes(actual);
      if ('not' in expected) return expected.not === null ? actual != null : actual !== expected.not;
      const ranged = ['lt', 'lte', 'gt', 'gte'].filter((k) => k in expected);
      if (ranged.length) {
        if (actual == null) return false;
        return ranged.every((k) => {
          const e = cmp(expected[k]);
          const a = cmp(actual);
          return k === 'lt' ? a < e : k === 'lte' ? a <= e : k === 'gt' ? a > e : a >= e;
        });
      }
    }
    if (expected instanceof Date) return actual instanceof Date && actual.getTime() === expected.getTime();
    return actual === expected;
  };

  const matchWhere = (r: Entry, where: Record<string, any> = {}, relations: Record<string, Entry | null> = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'OR') return (v as Record<string, any>[]).some((sub) => matchWhere(r, sub, relations));
      if (k === 'NOT') return !matchWhere(r, v as Record<string, any>, relations);
      if (k in relations) {
        const rel = relations[k];
        return !!rel && matchWhere(rel, v);
      }
      return matchValue(r[k], v);
    });

  const patch = (target: Entry, data: Record<string, any>) => {
    const previous: Record<string, any> = {};
    for (const k of Object.keys(data)) previous[k] = target[k];
    Object.assign(target, data);
    journal(() => Object.assign(target, previous));
  };

  const hooks: {
    /** Runs after a debit read has been taken, before the caller sees it: lets a test interleave. */
    afterAdjustmentRead?: () => Promise<void> | void;
  } = {};

  function ledger(
    kind: 'affiliate' | 'referral',
    seed: TableOpts,
  ) {
    const payeeKey = kind === 'affiliate' ? 'recruiterPractitionerId' : 'referrerPractitionerId';
    const payeeRel = kind === 'affiliate' ? 'recruiterPractitioner' : 'referrerPractitioner';
    const uniqueKey = kind === 'affiliate' ? 'bookingIntentId_recruiterPractitionerId' : 'bookingIntentId_referrerPractitionerId';
    const idPrefix = kind === 'affiliate' ? 'afl' : 'rfl';
    const waiting = kind === 'affiliate' ? 'ACCRUED' : 'PAYABLE';

    const defaults = (): Entry => ({
      state: waiting,
      reversedUsdCents: 0,
      transferAttempts: 0,
      transferUsdCents: null,
      settledAt: null,
      whopTransferId: null,
      lastError: null,
      adjustmentAppliedUsdCents: null,
      grossShareUsdCents: null,
      netPaidUsdCents: null,
      transferFeeUsdCents: null,
      lastAttemptAt: null,
      nextAttemptAt: null,
      maybeSentAt: null,
      attentionReason: null,
      adjustmentAllocations: null,
    });

    const rows: Entry[] = (seed.entries ?? []).map((e, i) => ({
      id: e.id ?? `${idPrefix}_${i + 1}`,
      createdAt: new Date(T0 + i * 1000),
      ...defaults(),
      ...e,
    }));
    let adjSeq = 0;
    const adjustments: Entry[] = (seed.adjustments ?? []).map((a) => {
      const n = ++adjSeq;
      return {
        id: `adj_${n}`,
        appliedUsdCents: 0,
        state: 'OPEN',
        reason: 'REFUND',
        // Strictly increasing in seed order, so "oldest first" means the order they were listed in.
        createdAt: new Date(T0 + n * 1000),
        dedupeKey: `seed:${kind}:${n}`,
        ...a,
      };
    });
    let seq = rows.length;

    const relationsOf = (r: Entry) => ({ [payeeRel]: wallets[r[payeeKey]] ?? null });

    const entry = {
      async upsert(args: any) {
        const k = args.where[uniqueKey];
        const existing = rows.find((r) => r.bookingIntentId === k.bookingIntentId && r[payeeKey] === k[payeeKey]);
        if (existing) {
          patch(existing, args.update ?? {});
          return existing;
        }
        const row = { id: `${idPrefix}_${++seq}`, createdAt: new Date(T0 + seq * 1000), ...defaults(), ...args.create };
        rows.push(row);
        journal(() => rows.splice(rows.indexOf(row), 1));
        return row;
      },
      async findUnique(args: any) {
        const k = args.where[uniqueKey];
        const r = k
          ? rows.find((x) => x.bookingIntentId === k.bookingIntentId && x[payeeKey] === k[payeeKey])
          : rows.find((x) => x.id === args.where.id);
        return r ? { ...r } : null;
      },
      async findFirst(args: any = {}) {
        const r = rows.find((x) => matchWhere(x, args.where, relationsOf(x)));
        return r ? { ...r } : null;
      },
      async findMany(args: any = {}) {
        let out = rows.filter((r) => matchWhere(r, args.where, relationsOf(r)));
        const field = args.orderBy ? Object.keys(args.orderBy)[0] : null;
        if (field) {
          const dir = args.orderBy[field] === 'desc' ? -1 : 1;
          out = [...out].sort((a, b) => {
            const av = a[field] instanceof Date ? a[field].getTime() : a[field];
            const bv = b[field] instanceof Date ? b[field].getTime() : b[field];
            return (av < bv ? -1 : av > bv ? 1 : 0) * dir;
          });
        }
        if (args.take) out = out.slice(0, args.take);
        return out.map((r) => ({ ...r, ...relationsOf(r) }));
      },
      async updateMany(args: any) {
        let count = 0;
        for (const r of rows) {
          if (matchWhere(r, args.where, relationsOf(r))) {
            patch(r, args.data);
            count += 1;
          }
        }
        return { count };
      },
      async update(args: any) {
        const r = rows.find((x) => x.id === args.where.id);
        if (!r) throw new Error(`no ${kind} ledger row ${args.where.id}`);
        patch(r, args.data);
        return r;
      },
    };

    const adjustment = {
      async createMany(args: any) {
        let count = 0;
        for (const d of args.data as Entry[]) {
          if (adjustments.some((a) => a.dedupeKey === d.dedupeKey)) {
            if (args.skipDuplicates) continue;
            throw new Error(`Unique constraint failed on dedupeKey ${d.dedupeKey}`);
          }
          const row = {
            id: `adj_${++adjSeq}`,
            appliedUsdCents: 0,
            state: 'OPEN',
            reason: 'REFUND',
            // Strictly increasing, so "oldest first" is well defined.
            createdAt: new Date(T0 + adjSeq * 1000),
            ...d,
          };
          adjustments.push(row);
          journal(() => adjustments.splice(adjustments.indexOf(row), 1));
          count += 1;
        }
        return { count };
      },
      async findMany(args: any = {}) {
        let out = adjustments.filter((a) => matchWhere(a, args.where));
        const order = ([] as any[]).concat(args.orderBy ?? []);
        for (const o of [...order].reverse()) {
          const [[field, dir]] = Object.entries(o) as [[string, string]];
          out = [...out].sort((a, b) => {
            const av = a[field] instanceof Date ? a[field].getTime() : a[field];
            const bv = b[field] instanceof Date ? b[field].getTime() : b[field];
            return (av < bv ? -1 : av > bv ? 1 : 0) * (dir === 'desc' ? -1 : 1);
          });
        }
        if (args.take) out = out.slice(0, args.take);
        const snapshot = out.map((a) => ({ ...a }));
        await hooks.afterAdjustmentRead?.();
        return snapshot;
      },
      async updateMany(args: any) {
        let count = 0;
        for (const a of adjustments) {
          if (matchWhere(a, args.where)) {
            patch(a, args.data);
            count += 1;
          }
        }
        return { count };
      },
    };

    return { rows, adjustments, entry, adjustment };
  }

  const affiliate = ledger('affiliate', opts.affiliate ?? {});
  const referral = ledger('referral', opts.referral ?? {});

  // Fee-ledger receipts and reversal markers (append-only; unique on dedupeKey).
  const fees: Entry[] = [];
  const feeLedgerEntry = {
    async upsert(args: any) {
      const existing = fees.find((f) => f.dedupeKey === args.where.dedupeKey);
      if (existing) {
        patch(existing, args.update ?? {});
        return existing;
      }
      const row = { id: `fee_${fees.length + 1}`, createdAt: new Date(T0 + fees.length * 1000), ...args.create };
      fees.push(row);
      journal(() => fees.splice(fees.indexOf(row), 1));
      return row;
    },
    async findMany(args: any = {}) {
      return fees.filter((f) => matchWhere(f, args.where)).map((f) => ({ ...f }));
    },
    async findFirst(args: any = {}) {
      const f = fees.find((x) => matchWhere(x, args.where));
      return f ? { ...f } : null;
    },
  };

  const fake: FakeLedgerDb = {
    affiliateRows: affiliate.rows,
    affiliateAdjustments: affiliate.adjustments,
    referralRows: referral.rows,
    referralAdjustments: referral.adjustments,
    fees,
    hooks,
    affiliateLedgerEntry: affiliate.entry,
    affiliateBalanceAdjustment: affiliate.adjustment,
    referralLedgerEntry: referral.entry,
    referralBalanceAdjustment: referral.adjustment,
    feeLedgerEntry,
    bookingFeeSnapshot: { findUnique: async () => null },
    async $transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      const undo: Array<() => void> = [];
      try {
        return await als.run(undo, () => fn(fake));
      } catch (err) {
        for (const u of undo.reverse()) u();
        throw err;
      }
    },
  };
  return fake;
}
