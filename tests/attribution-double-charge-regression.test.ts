import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { recordAttributedClient, attributionTermState } from '@/lib/attributed-clients';
import { sessionFeeCents } from '@/lib/pricing-plans';

/**
 * REGRESSION — THE DOUBLE-CHARGE.
 *
 * The shipped behaviour could charge ONE client relationship a first-session fee TWICE, through
 * the interaction of two separate pieces:
 *
 *   1. `recordAttributedClient` pushed `expiresAt` forward on every repeat booking, so the claim
 *      was a rolling window rather than a fixed term; and
 *   2. `sessionFeeBps` read an EXPIRED row as "no live claim", which is the same branch as a
 *      never-seen client — a FIRST SESSION — and charged the full first-session share again.
 *
 * So a client we introduced, were paid for, and then did not see for a while came back as a brand
 * new introduction and was billed at 40% a second time. Both halves are fixed: the term is locked
 * at earliest touch, and OUT_OF_TERM is 0% on both plans with no flag that can override it.
 *
 * This test is deliberately written as the MONEY story rather than as unit assertions on either
 * half, because either half alone looks defensible.
 */
describe('regression: a client relationship is never charged a second first-session fee', () => {
  const ENV = ['PLAN_B_FIRST_SESSION_FEE_ONCE', 'PLAN_A_FIRST_SESSION_FEE_ONCE'];
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    for (const k of ENV) delete process.env[k];
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function fakeDb() {
    const rows = new Map<string, Record<string, unknown>>();
    const key = (p: string, h: string) => `${p}|${h}`;
    return {
      rows,
      attributedClient: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async upsert(args: any) {
          const { practitionerId, emailHash } = args.where.practitionerId_emailHash;
          const k = key(practitionerId, emailHash);
          const existing = rows.get(k);
          rows.set(k, existing ? { ...existing, ...args.update } : { ...args.create });
          return rows.get(k);
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async updateMany(args: any) {
          // Honours the conditional filter the real query carries — a fake that ignored it would
          // pass an implementation with no lock at all, which is the bug under test.
          let count = 0;
          for (const [k, row] of Array.from(rows.entries())) {
            const r = row as Record<string, unknown>;
            const matches = Object.entries(args.where).every(
              ([field, want]) => (r[field] ?? null) === want,
            );
            if (!matches) continue;
            rows.set(k, { ...row, ...args.data });
            count += 1;
          }
          return { count };
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async findUnique(args: any) {
          const { practitionerId, emailHash } = args.where.practitionerId_emailHash;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (rows.get(key(practitionerId, emailHash)) as any) ?? null;
        },
      },
    };
  }

  const SESSION_PRICE = 10_000; // $100

  it('bills the introduction once, then nothing at all after the term — even years later', async () => {
    const db = fakeDb();
    const p = { practitionerId: 'p1', email: 'client@x.com' };
    const introSession = new Date('2026-01-15T00:00:00Z');

    // Session 1 — we introduce them. Chargeable at the Plan B rate.
    const firstState = await attributionTermState(db, { ...p, asOf: introSession });
    expect(firstState).toBe('NONE');
    const firstFee = sessionFeeCents({ plan: 'PLAN_B', term: firstState, priceUsdCents: SESSION_PRICE });
    expect(firstFee).toBe(4_000);
    await recordAttributedClient(db, { ...p, termMonths: 8, sessionStartsAt: introSession, at: introSession });

    // Session 2, inside the term — still chargeable (the recurrence ruling).
    const month3 = new Date('2026-04-15T00:00:00Z');
    const midState = await attributionTermState(db, { ...p, asOf: month3 });
    expect(midState).toBe('IN_TERM');
    expect(sessionFeeCents({ plan: 'PLAN_B', term: midState, priceUsdCents: SESSION_PRICE })).toBe(4_000);
    await recordAttributedClient(db, { ...p, termMonths: 8, sessionStartsAt: month3, at: month3 });

    // …and that repeat booking must NOT have extended the term. This is half one of the bug.
    const row = Array.from(db.rows.values())[0] as { termEndsAt: Date };
    expect(row.termEndsAt.toISOString()).toBe('2026-09-15T00:00:00.000Z');

    // Session 3, two years later. The old code called this a first session and charged $40 again.
    const muchLater = new Date('2028-06-01T00:00:00Z');
    const lateState = await attributionTermState(db, { ...p, asOf: muchLater });
    expect(lateState).toBe('OUT_OF_TERM');
    expect(sessionFeeCents({ plan: 'PLAN_B', term: lateState, priceUsdCents: SESSION_PRICE })).toBe(0);

    // And it stays 0 on Plan A too (ruling 5), and cannot be flipped back by the old env flags.
    process.env.PLAN_B_FIRST_SESSION_FEE_ONCE = 'false';
    process.env.PLAN_A_FIRST_SESSION_FEE_ONCE = 'false';
    expect(sessionFeeCents({ plan: 'PLAN_B', term: lateState, priceUsdCents: SESSION_PRICE })).toBe(0);
    expect(sessionFeeCents({ plan: 'PLAN_A', term: lateState, priceUsdCents: SESSION_PRICE })).toBe(0);
  });

  it('charges the whole 8-month term and not one session beyond it', async () => {
    const db = fakeDb();
    const p = { practitionerId: 'p2', email: 'other@x.com' };
    const anchor = new Date('2026-01-15T00:00:00Z');
    await recordAttributedClient(db, { ...p, termMonths: 8, sessionStartsAt: anchor, at: anchor });

    const billed: number[] = [];
    for (const when of ['2026-01-15', '2026-04-15', '2026-07-15', '2026-09-15', '2026-10-15']) {
      const term = await attributionTermState(db, { ...p, asOf: new Date(`${when}T00:00:00Z`) });
      billed.push(sessionFeeCents({ plan: 'PLAN_B', term, priceUsdCents: SESSION_PRICE }));
    }
    // months 0, 3, 6 charge; month 8 exactly and month 9 do not (spec §9 test 3).
    expect(billed).toEqual([4_000, 4_000, 4_000, 0, 0]);
  });
});
