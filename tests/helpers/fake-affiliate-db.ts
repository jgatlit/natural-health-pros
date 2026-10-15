/* eslint-disable @typescript-eslint/no-explicit-any */
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * An in-memory stand-in for the `affiliateLedgerEntry` and `affiliateBalanceAdjustment` delegates
 * and for `$transaction`. It honours the behaviours the affiliate code relies on, because a fake
 * that ignored them would pass an implementation with no guard at all:
 *
 *   - the UNIQUE (bookingIntentId, recruiterPractitionerId) constraint, via `upsert` (create-only
 *     when `update` is empty), and the UNIQUE `dedupeKey` on adjustments (`createMany` with
 *     `skipDuplicates` is a no-op for a key that exists);
 *   - `updateMany` is ATOMIC and honours `where` on `state` (equals or `{ in: [...] }`), on
 *     `reversedUsdCents`, on `appliedUsdCents` and on a literal `null`, returning the number of rows
 *     it actually changed. That count is exactly what the settle claim, the debit compare-and-swap
 *     and the "REVERSED only from unpaid" guard depend on;
 *   - `findMany` honours the simple filters the settle sweep and the earnings view use, including the
 *     nested `recruiterPractitioner` wallet filter and `holdUntil.lte`;
 *   - `$transaction(fn)` runs `fn` against the same delegates and, if `fn` THROWS, undoes every write
 *     it made (and only those): the rollback the netting transaction relies on. The undo log is
 *     tracked per transaction with AsyncLocalStorage, so two transactions interleaving at await
 *     points each roll back their own writes. Because the transaction client IS this object, a
 *     test that wraps `affiliateLedgerEntry.updateMany` to pause or inspect writes sees the writes
 *     made inside a transaction too.
 *
 * A write is only observable to other callers at the instant it runs (JS is single-threaded between
 * awaits), which models READ COMMITTED well enough for the compare-and-swap properties under test;
 * it does NOT model row locks, so a test cannot rely on a second writer BLOCKING behind a first.
 */

export type Entry = Record<string, any>;

export function fakeAffiliateDb(opts: {
  /** Recruiters' wallets by practitioner id, for the nested `recruiterPractitioner` filter/select. */
  practitioners?: Record<
    string,
    { whopCompanyId: string | null; whopPayoutsEnabled: boolean; archivedAt?: Date | null; trialEndsAt?: Date | null }
  >;
  entries?: Entry[];
  adjustments?: Entry[];
} = {}) {
  const rows: Entry[] = (opts.entries ?? []).map((e, i) => ({
    id: e.id ?? `afl_${i + 1}`,
    state: 'ACCRUED',
    reversedUsdCents: 0,
    transferAttempts: 0,
    transferUsdCents: null,
    settledAt: null,
    whopTransferId: null,
    lastError: null,
    adjustmentAppliedUsdCents: null,
    ...e,
  }));
  let adjSeq = 0;
  const adjustments: Entry[] = (opts.adjustments ?? []).map((a) => {
    const n = ++adjSeq;
    return {
      id: `adj_${n}`,
      appliedUsdCents: 0,
      state: 'OPEN',
      reason: 'REFUND',
      // Strictly increasing in seed order, so "oldest first" means the order they were listed in.
      createdAt: new Date(Date.UTC(2026, 0, 1) + n * 1000),
      dedupeKey: `seed:${n}`,
      ...a,
    };
  });
  const wallets = opts.practitioners ?? {};
  let seq = rows.length;

  /** The undo log of the transaction the current async call chain is inside, if any. */
  const als = new AsyncLocalStorage<Array<() => void>>();
  const journal = (undo: () => void) => als.getStore()?.push(undo);

  const matches = (r: Entry, where: Record<string, any> = {}): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'OR') return (v as Record<string, any>[]).some((sub) => matches(r, sub));
      if (k === 'recruiterPractitioner') {
        const w = wallets[r.recruiterPractitionerId];
        if (!w) return false;
        return (
          (v.whopCompanyId?.not === null ? w.whopCompanyId !== null : true) &&
          (v.whopPayoutsEnabled === undefined || w.whopPayoutsEnabled === v.whopPayoutsEnabled) &&
          (v.archivedAt === undefined || (w.archivedAt ?? null) === v.archivedAt)
        );
      }
      if (v === null) return r[k] == null;
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        if ('in' in v) return v.in.includes(r[k]);
        if ('lte' in v) return r[k] != null && r[k].getTime() <= v.lte.getTime();
        if ('lt' in v) return r[k] < v.lt;
        if ('gt' in v) return r[k] > v.gt;
        if ('gte' in v) return r[k] >= v.gte;
      }
      return r[k] === v;
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

  const affiliateLedgerEntry = {
    async upsert(args: any) {
      const k = args.where.bookingIntentId_recruiterPractitionerId;
      const existing = rows.find(
        (r) => r.bookingIntentId === k.bookingIntentId && r.recruiterPractitionerId === k.recruiterPractitionerId,
      );
      if (existing) {
        patch(existing, args.update ?? {});
        return existing;
      }
      const row = {
        id: `afl_${++seq}`,
        state: 'ACCRUED',
        reversedUsdCents: 0,
        transferAttempts: 0,
        transferUsdCents: null,
        settledAt: null,
        whopTransferId: null,
        lastError: null,
        adjustmentAppliedUsdCents: null,
        createdAt: new Date(),
        ...args.create,
      };
      rows.push(row);
      journal(() => rows.splice(rows.indexOf(row), 1));
      return row;
    },
    async findUnique(args: any) {
      const k = args.where.bookingIntentId_recruiterPractitionerId;
      const r = k
        ? rows.find(
            (x) => x.bookingIntentId === k.bookingIntentId && x.recruiterPractitionerId === k.recruiterPractitionerId,
          )
        : rows.find((x) => x.id === args.where.id);
      return r ? { ...r } : null;
    },
    async findMany(args: any = {}) {
      let out = rows.filter((r) => matches(r, args.where));
      if (args.orderBy?.updatedAt === 'asc') {
        out = [...out].sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
      }
      if (args.orderBy?.holdUntil === 'asc') {
        out = [...out].sort((a, b) => a.holdUntil.getTime() - b.holdUntil.getTime());
      }
      if (args.take) out = out.slice(0, args.take);
      return out.map((r) => ({
        ...r,
        recruiterPractitioner: wallets[r.recruiterPractitionerId] ?? null,
      }));
    },
    async updateMany(args: any) {
      let count = 0;
      for (const r of rows) {
        if (matches(r, args.where)) {
          patch(r, args.data);
          count += 1;
        }
      }
      return { count };
    },
  };

  const affiliateBalanceAdjustment = {
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
          createdAt: new Date(Date.UTC(2026, 0, 1) + adjSeq * 1000),
          ...d,
        };
        adjustments.push(row);
        journal(() => adjustments.splice(adjustments.indexOf(row), 1));
        count += 1;
      }
      return { count };
    },
    async findMany(args: any = {}) {
      let out = adjustments.filter((a) => matches(a, args.where));
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
        if (matches(a, args.where)) {
          patch(a, args.data);
          count += 1;
        }
      }
      return { count };
    },
  };

  const fake = {
    rows,
    adjustments,
    hooks,
    affiliateLedgerEntry,
    affiliateBalanceAdjustment,
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
