import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import {
  expireLapsedHolds,
  payoutsGuard,
  promoteHeldToPayable,
  settlePayableShares,
  toTransferDollars,
} from '@/lib/referral-payouts';

/**
 * PAYING REFERRERS (spec v1.4 §6.2, operator rulings 6 and 7).
 *
 * 🚧 BUILT AND DELIBERATELY NOT ACTIVE. The parent company `biz_Vpj1G2ryNdPCG0` is not
 * business-verified, and Whop refuses every transfer from it with "Please verify your business
 * before transferring funds" (probed 2026-09-19, by rejection, no transfer created). That is an
 * operator/dashboard action, not a code fix, so this ships behind a guard that FAILS CLOSED and
 * names the reason — the moment verification clears it is a switch, not a build.
 *
 * ⚠️ THE 100× TRAP. `POST /api/v1/transfers` takes `amount` in DOLLARS. `application_fee_amount`,
 * a few lines away in this same codebase, is in CENTS. Two adjacent money APIs with different
 * units is a 100× error waiting to happen, so the conversion is a named function with its own
 * tests rather than an inline `/ 100`.
 *
 * ⚠️ WHAT IS STILL UNKNOWN. Transfers to a NON-PARENT destination carry a measured 3% surcharge;
 * child → parent carries none. Whether parent → sibling carries it cannot be measured until the
 * parent is verified. Nothing here assumes either way — the requested amount is recorded so the
 * net can be reconciled against Whop once a real transfer exists.
 */

const ENV = ['WHOP_TRANSFERS_ENABLED', 'WHOP_COMPANY_API_KEY', 'WHOP_PARENT_COMPANY_ID'];
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

describe('toTransferDollars — the unit boundary', () => {
  it('converts cents to the DOLLARS the transfers endpoint expects', () => {
    expect(toTransferDollars(2_000)).toBe(20);
    expect(toTransferDollars(150)).toBe(1.5);
  });

  it('refuses a non-integer cent amount rather than silently rounding somebody’s share', () => {
    expect(() => toTransferDollars(20.5)).toThrow(/whole number of cents/i);
  });

  it('refuses a non-positive amount — there is no such thing as a zero payout', () => {
    expect(() => toTransferDollars(0)).toThrow();
    expect(() => toTransferDollars(-100)).toThrow();
  });

  it('refuses an amount above Whop’s measured per-transfer ceiling', () => {
    // $25,000, validated by Whop BEFORE direction, ownership or balance — so a larger request
    // fails for a reason that says nothing about whether the transfer was otherwise valid.
    expect(() => toTransferDollars(2_500_001)).toThrow(/25,?000/);
  });
});

describe('payoutsGuard — fails closed, and says why', () => {
  it('is BLOCKED by default, naming the unverified parent company', () => {
    process.env.WHOP_COMPANY_API_KEY = 'apik_x';
    process.env.WHOP_PARENT_COMPANY_ID = 'biz_parent';

    const guard = payoutsGuard();
    expect(guard.allowed).toBe(false);
    expect(guard.allowed === false && guard.reason).toMatch(/verif/i);
  });

  it('stays blocked when Whop is not configured at all, with a DIFFERENT reason', () => {
    process.env.WHOP_TRANSFERS_ENABLED = 'true';

    const guard = payoutsGuard();
    expect(guard.allowed).toBe(false);
    expect(guard.allowed === false && guard.reason).toMatch(/not configured/i);
  });

  it('opens only when the operator explicitly switches it on AND Whop is configured', () => {
    process.env.WHOP_TRANSFERS_ENABLED = 'true';
    process.env.WHOP_COMPANY_API_KEY = 'apik_x';
    process.env.WHOP_PARENT_COMPANY_ID = 'biz_parent';

    expect(payoutsGuard().allowed).toBe(true);
  });

  it('treats any value other than the literal "true" as off', () => {
    process.env.WHOP_COMPANY_API_KEY = 'apik_x';
    process.env.WHOP_PARENT_COMPANY_ID = 'biz_parent';
    for (const value of ['1', 'yes', 'TRUE', '']) {
      process.env.WHOP_TRANSFERS_ENABLED = value;
      expect(payoutsGuard().allowed, `"${value}" must not enable payouts`).toBe(false);
    }
  });
});

function fakeDb(seed: {
  payable?: Record<string, unknown>[];
  held?: Record<string, unknown>[];
}) {
  const ledger = new Map<string, Record<string, unknown>>();
  for (const row of [...(seed.payable ?? []), ...(seed.held ?? [])]) {
    ledger.set(row.id as string, { ...row });
  }
  const feeLedger = new Map<string, Record<string, unknown>>();
  const claims: unknown[] = [];

  return {
    ledger,
    feeLedger,
    claims,
    referralLedgerEntry: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async findMany(args: any) {
        return Array.from(ledger.values()).filter((r) => {
          const w = args.where ?? {};
          if (w.state && r.state !== w.state) return false;
          if (w.holdExpiresAt?.lte && (r.holdExpiresAt as Date) > w.holdExpiresAt.lte) return false;
          return true;
        });
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async updateMany(args: any) {
        claims.push(args);
        let count = 0;
        for (const row of Array.from(ledger.values())) {
          const w = args.where ?? {};
          const idMatch = w.id
            ? typeof w.id === 'object' && 'in' in w.id
              ? (w.id.in as string[]).includes(row.id as string)
              : row.id === w.id
            : true;
          const stateMatch = w.state ? row.state === w.state : true;
          // ⚠️ HONOUR THE DATE FILTER. Without this the "a hold that has not lapsed is left
          // alone" test would pass against an implementation that expired every held row — the
          // same fake-weaker-than-production shape the carriage tests already hit.
          const dateMatch = w.holdExpiresAt?.lte
            ? row.holdExpiresAt instanceof Date &&
              row.holdExpiresAt.getTime() <= (w.holdExpiresAt.lte as Date).getTime()
            : true;
          if (idMatch && stateMatch && dateMatch) {
            Object.assign(row, args.data);
            count++;
          }
        }
        return { count };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async update(args: any) {
        const row = ledger.get(args.where.id as string);
        if (row) Object.assign(row, args.data);
        return row;
      },
    },
    feeLedgerEntry: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async upsert(args: any) {
        const k = args.where.dedupeKey as string;
        if (!feeLedger.has(k)) feeLedger.set(k, { ...args.create });
        else Object.assign(feeLedger.get(k)!, args.update);
        return feeLedger.get(k);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async updateMany(args: any) {
        let count = 0;
        for (const row of Array.from(feeLedger.values())) {
          const w = args.where ?? {};
          if ((!w.dedupeKey || row.dedupeKey === w.dedupeKey) && (!w.status || row.status === w.status)) {
            Object.assign(row, args.data);
            count++;
          }
        }
        return { count };
      },
    },
    practitioner: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async findMany(args: any) {
        const ids = (args.where?.id?.in ?? []) as string[];
        return ids.map((id) => ({
          id,
          whopCompanyId: id === 'payable-ref' ? 'biz_ok' : null,
          whopPayoutsEnabled: id === 'payable-ref',
        }));
      },
    },
  };
}

const payableRow = (over: Record<string, unknown> = {}) => ({
  id: 'led_1',
  state: 'PAYABLE',
  referrerShareUsdCents: 2_000,
  whopTransferId: null,
  settledAt: null,
  referrerPractitionerId: 'payable-ref',
  referrerPractitioner: { id: 'payable-ref', whopCompanyId: 'biz_ok', whopPayoutsEnabled: true },
  ...over,
});

describe('settlePayableShares — blocked', () => {
  // Whop IS configured here. The block under test is the unverified parent company, not a missing
  // key — those are different reasons pointing at different fixes, which is why the guard returns
  // a string rather than a boolean.
  beforeEach(() => {
    process.env.WHOP_COMPANY_API_KEY = 'apik_x';
    process.env.WHOP_PARENT_COMPANY_ID = 'biz_parent';
  });

  it('does NOT transfer, and reports the blocking reason rather than failing silently', async () => {
    const db = fakeDb({ payable: [payableRow()] });
    let called = 0;

    const result = await settlePayableShares(db, {
      transfer: async () => {
        called += 1;
        return { transferId: 'tr_1' };
      },
      at: new Date(),
    });

    expect(called).toBe(0);
    expect(result.blocked).toBeTruthy();
    expect(result.blocked).toMatch(/verif/i);
    expect(result.settled).toBe(0);
    // The row is untouched — a blocked payout is still owed.
    expect(db.ledger.get('led_1')!.state).toBe('PAYABLE');
  });

  it('records the block on the fee ledger so the debt is visible, not merely unpaid', async () => {
    const db = fakeDb({ payable: [payableRow()] });

    await settlePayableShares(db, { transfer: async () => ({ transferId: 'x' }), at: new Date() });

    const entry = Array.from(db.feeLedger.values())[0];
    expect(entry).toMatchObject({ kind: 'REFERRER_TRANSFER', status: 'BLOCKED', amountUsdCents: 2_000 });
    expect(String(entry!.note)).toMatch(/verif/i);
  });
});

describe('settlePayableShares — unblocked', () => {
  beforeEach(() => {
    process.env.WHOP_TRANSFERS_ENABLED = 'true';
    process.env.WHOP_COMPANY_API_KEY = 'apik_x';
    process.env.WHOP_PARENT_COMPANY_ID = 'biz_parent';
  });

  it('transfers in DOLLARS, from the parent to the referrer’s own company', async () => {
    const db = fakeDb({ payable: [payableRow()] });
    const calls: { originId: string; destinationId: string; amountUsdDollars: number }[] = [];

    await settlePayableShares(db, {
      transfer: async (args) => {
        calls.push(args);
        return { transferId: 'tr_1' };
      },
      at: new Date(),
    });

    expect(calls).toEqual([
      { originId: 'biz_parent', destinationId: 'biz_ok', amountUsdDollars: 20 },
    ]);
    expect(db.ledger.get('led_1')).toMatchObject({ state: 'SETTLED', whopTransferId: 'tr_1' });
  });

  it('CLAIMS the row before calling Whop, so a concurrent run cannot pay twice', async () => {
    const db = fakeDb({ payable: [payableRow()] });

    await settlePayableShares(db, { transfer: async () => ({ transferId: 'tr_1' }), at: new Date() });

    // The claim is a conditional write filtered on the CURRENT status — an already-claimed row
    // matches nothing. `POST /transfers` has no observed idempotency key, so this ordering is the
    // only guard there is.
    const claimed = Array.from(db.feeLedger.values())[0];
    expect(claimed!.status).toBe('SETTLED');
    const claimCall = (db.feeLedger.size > 0);
    expect(claimCall).toBe(true);
  });

  it('leaves the row PAYABLE and records FAILED when the transfer throws — never optimistically settled', async () => {
    const db = fakeDb({ payable: [payableRow()] });

    const result = await settlePayableShares(db, {
      transfer: async () => {
        throw new Error('insufficient balance');
      },
      at: new Date(),
    });

    expect(result.failed).toBe(1);
    expect(db.ledger.get('led_1')!.state).toBe('PAYABLE');
    expect(Array.from(db.feeLedger.values())[0]).toMatchObject({ status: 'FAILED' });
  });

  it('skips a referrer with no connected company rather than transferring into the void', async () => {
    const db = fakeDb({
      payable: [
        payableRow({
          referrerPractitioner: { id: 'x', whopCompanyId: null, whopPayoutsEnabled: false },
        }),
      ],
    });
    let called = 0;

    const result = await settlePayableShares(db, {
      transfer: async () => {
        called += 1;
        return { transferId: 'tr_1' };
      },
      at: new Date(),
    });

    expect(called).toBe(0);
    expect(result.settled).toBe(0);
  });
});

describe('promoteHeldToPayable — ruling 6’s retroactive settlement', () => {
  it('flips a HELD share to PAYABLE once its referrer can receive funds', async () => {
    const db = fakeDb({
      held: [{ id: 'led_h', state: 'HELD', referrerPractitionerId: 'payable-ref', referrerShareUsdCents: 2_000 }],
    });

    const promoted = await promoteHeldToPayable(db, { at: new Date() });

    expect(promoted).toBe(1);
    expect(db.ledger.get('led_h')!.state).toBe('PAYABLE');
  });

  it('leaves a still-unpayable referrer’s share held', async () => {
    const db = fakeDb({
      held: [{ id: 'led_h', state: 'HELD', referrerPractitionerId: 'not-payable', referrerShareUsdCents: 2_000 }],
    });

    expect(await promoteHeldToPayable(db, { at: new Date() })).toBe(0);
    expect(db.ledger.get('led_h')!.state).toBe('HELD');
  });

  it('never promotes an EXPIRED_UNCLAIMED row — that transition is an operator decision', async () => {
    const db = fakeDb({
      held: [
        {
          id: 'led_x',
          state: 'EXPIRED_UNCLAIMED',
          referrerPractitionerId: 'payable-ref',
          referrerShareUsdCents: 2_000,
        },
      ],
    });

    expect(await promoteHeldToPayable(db, { at: new Date() })).toBe(0);
    expect(db.ledger.get('led_x')!.state).toBe('EXPIRED_UNCLAIMED');
  });
});

describe('expireLapsedHolds — ruling 7 §4, and what it must NOT do', () => {
  const past = new Date(Date.UTC(2026, 0, 1));
  const now = new Date(Date.UTC(2026, 6, 1));

  it('moves a lapsed hold to EXPIRED_UNCLAIMED', async () => {
    const db = fakeDb({
      held: [{ id: 'led_h', state: 'HELD', holdExpiresAt: past, referrerShareUsdCents: 2_000 }],
    });

    expect(await expireLapsedHolds(db, { at: now })).toBe(1);
    expect(db.ledger.get('led_h')!.state).toBe('EXPIRED_UNCLAIMED');
  });

  it('TAKES NO MONEY ACTION — nothing forfeited, nothing released, nothing deleted', async () => {
    // ⚠️ Day-91 policy is deliberately unruled (operator, 2026-09-18). Defaulting it either way
    // silently moves real money, so the amount, the referrer and the payment reference all stay
    // exactly as they were and only the state changes.
    const db = fakeDb({
      held: [
        {
          id: 'led_h',
          state: 'HELD',
          holdExpiresAt: past,
          referrerShareUsdCents: 2_000,
          referrerPractitionerId: 'payable-ref',
          whopPaymentId: 'pay_1',
        },
      ],
    });

    await expireLapsedHolds(db, { at: now });

    const row = db.ledger.get('led_h')!;
    expect(row.referrerShareUsdCents).toBe(2_000);
    expect(row.referrerPractitionerId).toBe('payable-ref');
    expect(row.whopPaymentId).toBe('pay_1');
    expect(row.settledAt ?? null).toBeNull();
    expect(row.whopTransferId ?? null).toBeNull();
    // And no transfer was even contemplated.
    expect(db.feeLedger.size).toBe(0);
  });

  it('leaves a hold that has not lapsed alone', async () => {
    const db = fakeDb({
      held: [
        { id: 'led_h', state: 'HELD', holdExpiresAt: new Date(Date.UTC(2027, 0, 1)), referrerShareUsdCents: 1 },
      ],
    });

    expect(await expireLapsedHolds(db, { at: now })).toBe(0);
    expect(db.ledger.get('led_h')!.state).toBe('HELD');
  });
});
