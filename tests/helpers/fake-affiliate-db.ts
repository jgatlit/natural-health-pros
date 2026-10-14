/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * An in-memory stand-in for the `affiliateLedgerEntry` delegate. It honours the behaviours the
 * affiliate code relies on, because a fake that ignored them would pass an implementation with no
 * guard at all:
 *
 *   - the UNIQUE (bookingIntentId, recruiterPractitionerId) constraint, via `upsert` (create-only
 *     when `update` is empty);
 *   - `updateMany` is ATOMIC and honours `where` on `state` (equals or `{ in: [...] }`) and on
 *     `reversedUsdCents`, returning the number of rows it actually changed. That count is exactly
 *     what the settle claim and the "REVERSED only from unpaid" guard depend on;
 *   - `findMany` honours the simple filters the settle sweep and the earnings view use, including the
 *     nested `recruiterPractitioner` wallet filter and `holdUntil.lte`.
 */

export type Entry = Record<string, any>;

export function fakeAffiliateDb(opts: {
  /** Recruiters' wallets by practitioner id, for the nested `recruiterPractitioner` filter/select. */
  practitioners?: Record<
    string,
    { whopCompanyId: string | null; whopPayoutsEnabled: boolean; archivedAt?: Date | null; trialEndsAt?: Date | null }
  >;
  entries?: Entry[];
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
    ...e,
  }));
  const wallets = opts.practitioners ?? {};
  let seq = rows.length;

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
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        if ('in' in v) return v.in.includes(r[k]);
        if ('lte' in v) return r[k] != null && r[k].getTime() <= v.lte.getTime();
        if ('lt' in v) return r[k] < v.lt;
        if ('gt' in v) return r[k] > v.gt;
      }
      return r[k] === v;
    });

  const delegate = {
    async upsert(args: any) {
      const k = args.where.bookingIntentId_recruiterPractitionerId;
      const existing = rows.find(
        (r) => r.bookingIntentId === k.bookingIntentId && r.recruiterPractitionerId === k.recruiterPractitionerId,
      );
      if (existing) {
        Object.assign(existing, args.update ?? {});
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
        createdAt: new Date(),
        ...args.create,
      };
      rows.push(row);
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
          Object.assign(r, args.data);
          count += 1;
        }
      }
      return { count };
    },
  };

  return { rows, affiliateLedgerEntry: delegate };
}
