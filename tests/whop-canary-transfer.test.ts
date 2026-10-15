import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runCanary, type CanaryDeps } from '../scripts/whop-canary-transfer';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The canary script moves $1.00 of real money, so the tests pin what protects the operator: it is a
 * dry run unless `--go` AND today's UTC date in CANARY_CONFIRM are both present, a dry run sends no
 * request of any kind, and the request it makes is the one the app makes. Everything runs against a
 * fake fetch or fake dependencies; nothing here can reach Whop.
 */

const NOW = new Date(Date.UTC(2026, 9, 15, 12, 0, 0));
const TODAY = '2026-10-15';
const ENV = { WHOP_COMPANY_API_KEY: 'k_test', WHOP_PARENT_COMPANY_ID: 'biz_parent' };

let savedEnv: Record<string, string | undefined>;
beforeEach(() => {
  savedEnv = { WHOP_COMPANY_API_KEY: process.env.WHOP_COMPANY_API_KEY, WHOP_PARENT_COMPANY_ID: process.env.WHOP_PARENT_COMPANY_ID, WHOP_API_BASE: process.env.WHOP_API_BASE };
  process.env.WHOP_COMPANY_API_KEY = ENV.WHOP_COMPANY_API_KEY;
  process.env.WHOP_PARENT_COMPANY_ID = ENV.WHOP_PARENT_COMPANY_ID;
  delete process.env.WHOP_API_BASE;
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function fakeDeps(over: Partial<{ firstId: string; repeatId: string; found: boolean; balances: Array<number | Error> }> = {}) {
  const calls: string[] = [];
  const o = { firstId: 'tr_1', repeatId: 'tr_1', found: true, ...over };
  // parent before, sibling before, parent after, sibling after
  const balances = over.balances ?? [100, 10, 98.97, 10.97];
  let b = 0;
  let t = 0;
  const deps: CanaryDeps = {
    balance: vi.fn(async (id: string) => {
      calls.push(`balance:${id}`);
      const v = balances[b++];
      if (v instanceof Error) throw v;
      return { balanceUsd: v as number, pendingUsd: 0 };
    }),
    transfer: vi.fn(async (args: any) => {
      calls.push('transfer');
      void args;
      return { transferId: t++ === 0 ? o.firstId : o.repeatId };
    }),
    find: vi.fn(async (args: any) => {
      calls.push('find');
      const rec = { id: o.firstId, amount: 1, feeAmount: 0.03, metadata: { canary: 'step0' }, createdAt: null };
      return o.found && args.match(rec) ? rec : null;
    }),
  };
  return { deps, calls };
}

const GO = ['--to', 'biz_sibling', '--go'];

describe('dry run (the default): sends nothing', () => {
  it('without --go it prints the plan and makes no balance read, no transfer and no lookup', async () => {
    const { deps } = fakeDeps();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const out = await runCanary({ argv: ['--to', 'biz_sibling'], env: ENV, now: NOW, deps });

    expect(out.kind).toBe('dry-run');
    if (out.kind !== 'dry-run') return;
    const text = out.plan.join('\n');
    expect(text).toMatch(/DRY RUN: nothing is sent/);
    expect(text).toContain('biz_parent');
    expect(text).toContain('biz_sibling');
    expect(text).toContain('$1.00');
    expect(text).toContain('idempotence_key');
    expect(text).toContain('{"canary":"step0"}');
    expect(text).toContain(`CANARY_CONFIRM=${TODAY}`);
    expect(deps.balance).not.toHaveBeenCalled();
    expect(deps.transfer).not.toHaveBeenCalled();
    expect(deps.find).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('even with the REAL dependencies a dry run issues no request of any kind', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const out = await runCanary({ argv: ['--to', 'biz_sibling'], env: ENV, now: NOW });
    expect(out.kind).toBe('dry-run');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a CANARY_CONFIRM in the environment does not turn a dry run into a send', async () => {
    const { deps } = fakeDeps();
    const out = await runCanary({ argv: ['--to', 'biz_sibling'], env: { ...ENV, CANARY_CONFIRM: TODAY }, now: NOW, deps });
    expect(out.kind).toBe('dry-run');
    expect(deps.transfer).not.toHaveBeenCalled();
  });
});

describe('--go needs the confirmation', () => {
  it.each([undefined, '', '2026-10-14', '2026-10-16', 'yes', 'true', TODAY + ' '])(
    'CANARY_CONFIRM=%j: refuses, and nothing is sent',
    async (confirm) => {
      const { deps } = fakeDeps();
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);
      const out = await runCanary({ argv: GO, env: { ...ENV, ...(confirm === undefined ? {} : { CANARY_CONFIRM: confirm }) }, now: NOW, deps });
      expect(out.kind).toBe('refused');
      if (out.kind === 'refused') expect(out.reason).toContain(`CANARY_CONFIRM=${TODAY}`);
      expect(deps.balance).not.toHaveBeenCalled();
      expect(deps.transfer).not.toHaveBeenCalled();
      expect(deps.find).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it('the date is checked in UTC: late evening in the Americas is already tomorrow', async () => {
    const { deps } = fakeDeps();
    const late = new Date(Date.UTC(2026, 9, 16, 1, 30, 0)); // still Oct 15 evening in New York
    const out = await runCanary({ argv: GO, env: { ...ENV, CANARY_CONFIRM: TODAY }, now: late, deps });
    expect(out.kind).toBe('refused');
    expect(deps.transfer).not.toHaveBeenCalled();
  });

  it.each([
    [['--go'], 'a destination'],
    [['--go', '--to'], 'a destination'],
    [['--go', '--to', 'user_123'], 'a destination'],
    [['--go', '--to', 'biz_parent'], 'sibling'],
  ])('%j: refused (%s)', async (argv, word) => {
    const { deps } = fakeDeps();
    const out = await runCanary({ argv: argv as string[], env: { ...ENV, CANARY_CONFIRM: TODAY }, now: NOW, deps });
    expect(out.kind).toBe('refused');
    if (out.kind === 'refused') expect(out.reason).toContain(word === 'a destination' ? '--to biz_' : word);
    expect(deps.transfer).not.toHaveBeenCalled();
  });

  it('refuses without the API key or the parent id, before anything else', async () => {
    const { deps } = fakeDeps();
    expect((await runCanary({ argv: GO, env: { CANARY_CONFIRM: TODAY }, now: NOW, deps })).kind).toBe('refused');
    expect((await runCanary({ argv: GO, env: { WHOP_COMPANY_API_KEY: 'k', CANARY_CONFIRM: TODAY }, now: NOW, deps })).kind).toBe('refused');
    expect(deps.transfer).not.toHaveBeenCalled();
  });
});

describe('--go with the confirmation: the Step 0 sequence', () => {
  const go = (deps: CanaryDeps) => runCanary({ argv: GO, env: { ...ENV, CANARY_CONFIRM: TODAY }, now: NOW, deps });

  it('reads balances, posts the transfer, posts the SAME request again, looks it up, reads balances again — in that order', async () => {
    const { deps, calls } = fakeDeps();
    const out = await go(deps);
    expect(out.kind).toBe('done');
    expect(calls).toEqual([
      'balance:biz_parent',
      'balance:biz_sibling',
      'transfer',
      'transfer',
      'find',
      'balance:biz_parent',
      'balance:biz_sibling',
    ]);
    const [first, second] = (deps.transfer as any).mock.calls.map((c: any[]) => c[0]);
    expect(first).toEqual(second); // the identical request, key included
    expect(first).toMatchObject({
      originId: 'biz_parent',
      destinationId: 'biz_sibling',
      amountUsdDollars: 1, // dollars, not cents
      metadata: { canary: 'step0' },
    });
    expect(first.idempotenceKey).toMatch(/^canary-step0-2026-10-15-[0-9a-f]{8}$/);
  });

  it('the key was honoured: the repeat returns the same id, the lookup finds it, the fee is parent decrease minus sibling increase', async () => {
    const { deps } = fakeDeps();
    const out = await go(deps);
    if (out.kind !== 'done') throw new Error('expected a report');
    expect(out.exitCode).toBe(0);
    expect(out.report).toMatchObject({
      firstTransferId: 'tr_1',
      repeatTransferId: 'tr_1',
      repeatCreatedSecondTransfer: false,
      lookupFoundFirst: true,
      parentDecreaseUsd: 1.03,
      siblingIncreaseUsd: 0.97,
      observedFeeUsd: 0.06,
      amountUsd: 1,
    });
    expect(out.report.transferRecord).toMatchObject({ amountUsd: 1, feeAmountUsd: 0.03, metadata: { canary: 'step0' } });
    expect(JSON.parse(JSON.stringify(out.report))).toEqual(out.report); // plain JSON
  });

  it('the key was IGNORED: the repeat created a second transfer, and the report says so', async () => {
    const { deps } = fakeDeps({ repeatId: 'tr_2' });
    const out = await go(deps);
    if (out.kind !== 'done') throw new Error('expected a report');
    expect(out.report.repeatCreatedSecondTransfer).toBe(true);
    expect(out.report.repeatTransferId).toBe('tr_2');
  });

  it('metadata ignored: the lookup does not find the transfer', async () => {
    const { deps } = fakeDeps({ found: false });
    const out = await go(deps);
    if (out.kind !== 'done') throw new Error('expected a report');
    expect(out.report.lookupFoundFirst).toBe(false);
    expect(out.report.transferRecord).toBeNull();
  });

  it('a balance that cannot be read is recorded, the answers that do not need it are still reported, and the fee is null', async () => {
    const { deps } = fakeDeps({ balances: [new Error('Whop /ledger_accounts/biz_parent failed (404)'), 10, new Error('404'), 10.97] });
    const out = await go(deps);
    if (out.kind !== 'done') throw new Error('expected a report');
    expect(out.report.balancesBefore.parent).toEqual({ error: expect.stringContaining('404') });
    expect(out.report.observedFeeUsd).toBeNull();
    expect(out.report.repeatCreatedSecondTransfer).toBe(false);
    expect(out.report.lookupFoundFirst).toBe(true);
  });

  it('a refused first transfer stops the sequence: no repeat, no lookup, exit code 1, the reason in the report', async () => {
    const { deps } = fakeDeps();
    (deps.transfer as any).mockRejectedValueOnce(new Error('Whop /transfers failed (403): Please verify your business before transferring funds'));
    const out = await go(deps);
    if (out.kind !== 'done') throw new Error('expected a report');
    expect(out.exitCode).toBe(1);
    expect(out.report.firstError).toMatch(/verify your business/);
    expect(out.report.firstTransferId).toBeNull();
    expect(deps.transfer).toHaveBeenCalledTimes(1);
    expect(deps.find).not.toHaveBeenCalled();
  });

  it('a repeat that Whop rejects as a duplicate is recorded as an error, not as a second transfer', async () => {
    const { deps } = fakeDeps();
    (deps.transfer as any).mockResolvedValueOnce({ transferId: 'tr_1' }).mockRejectedValueOnce(new Error('Whop /transfers failed (409): duplicate idempotence key'));
    const out = await go(deps);
    if (out.kind !== 'done') throw new Error('expected a report');
    expect(out.report.repeatError).toMatch(/409/);
    expect(out.report.repeatCreatedSecondTransfer).toBeNull();
    expect(out.exitCode).toBe(0);
  });
});

describe('--go through the REAL whop.ts helpers against a fake fetch: the wire format', () => {
  it('posts dollars with idempotence_key, metadata and the Idempotency-Key header; reads balances and the transfer list', async () => {
    const requests: Array<{ url: string; method: string; headers: Record<string, string>; body: any }> = [];
    const balances = [100, 10, 98.97, 10.97];
    let b = 0;
    const transferBodies: any[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: any = {}) => {
        const method = init.method ?? 'GET';
        const body = init.body ? JSON.parse(init.body) : null;
        requests.push({ url, method, headers: init.headers ?? {}, body });
        if (url.includes('/ledger_accounts/')) {
          return new Response(JSON.stringify({ balances: [{ currency: 'usd', balance: balances[b++], pending_balance: 0 }] }), { status: 200 });
        }
        if (method === 'POST' && url.endsWith('/transfers')) {
          transferBodies.push(body);
          return new Response(JSON.stringify({ id: 'tr_wire' }), { status: 200 });
        }
        if (url.includes('/transfers?')) {
          return new Response(
            JSON.stringify({ data: [{ id: 'tr_wire', amount: 1, fee_amount: 0, metadata: { canary: 'step0' }, created_at: NOW.toISOString() }], page_info: {} }),
            { status: 200 },
          );
        }
        return new Response('unexpected', { status: 500 });
      }),
    );

    const out = await runCanary({ argv: GO, env: { ...ENV, CANARY_CONFIRM: TODAY }, now: NOW });

    if (out.kind !== 'done') throw new Error('expected a report');
    expect(out.report).toMatchObject({ firstTransferId: 'tr_wire', lookupFoundFirst: true, observedFeeUsd: 0.06 });
    expect(transferBodies).toHaveLength(2);
    expect(transferBodies[0]).toEqual(transferBodies[1]);
    expect(transferBodies[0]).toMatchObject({
      origin_id: 'biz_parent',
      destination_id: 'biz_sibling',
      amount: 1,
      currency: 'usd',
      metadata: { canary: 'step0' },
    });
    expect(transferBodies[0].idempotence_key).toMatch(/^canary-step0-2026-10-15-/);
    const post = requests.find((r) => r.method === 'POST')!;
    expect(post.headers['Idempotency-Key']).toBe(transferBodies[0].idempotence_key);
    expect(post.headers.Authorization).toBe('Bearer k_test');
    const list = requests.find((r) => r.url.includes('/transfers?'))!;
    expect(list.url).toContain('origin_id=biz_parent');
    expect(list.url).toContain('destination_id=biz_sibling');
    expect(requests.filter((r) => r.url.includes('/ledger_accounts/'))).toHaveLength(4);
  });
});

describe('the script file', () => {
  it('reads no env file, imports no database client, and has no default that sends', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../scripts/whop-canary-transfer.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/@prisma\/client|PrismaClient|readFileSync|dotenv|\.env['"`]|--env-file/);
    expect(src).toMatch(/if \(!go\)/);
  });
});
