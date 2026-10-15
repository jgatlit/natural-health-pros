import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TRANSFER_TIMEOUT_MS,
  WhopNotConfigured,
  createTransfer,
  findTransferForLedgerEntry,
  getAccountBalanceUsd,
  isConnectedAccountOfParent,
} from '@/lib/whop';
import { classifyTransferFailure } from '@/lib/ledger-transfer';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The transfer calls on the wire, against a fake fetch: dollars, the duplicate-protection fields,
 * the lookup that runs before any re-send, and the error text the failure classifier depends on.
 */

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = { k: process.env.WHOP_COMPANY_API_KEY, p: process.env.WHOP_PARENT_COMPANY_ID, b: process.env.WHOP_API_BASE };
  process.env.WHOP_COMPANY_API_KEY = 'k_test';
  process.env.WHOP_PARENT_COMPANY_ID = 'biz_parent';
  delete process.env.WHOP_API_BASE;
});
afterEach(() => {
  if (saved.k === undefined) delete process.env.WHOP_COMPANY_API_KEY;
  else process.env.WHOP_COMPANY_API_KEY = saved.k;
  if (saved.p === undefined) delete process.env.WHOP_PARENT_COMPANY_ID;
  else process.env.WHOP_PARENT_COMPANY_ID = saved.p;
  if (saved.b === undefined) delete process.env.WHOP_API_BASE;
  else process.env.WHOP_API_BASE = saved.b;
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('createTransfer', () => {
  it('posts DOLLARS with idempotence_key and metadata in the body only (no header), and a timeout', async () => {
    const f = vi.fn<(url: string, init: any) => Promise<Response>>(async () => json({ id: 'tr_1' }));
    vi.stubGlobal('fetch', f);

    const out = await createTransfer({
      originId: 'biz_parent',
      destinationId: 'biz_x',
      amountUsdDollars: 0.3,
      metadata: { kind: 'affiliate', ledger_entry_id: 'afl_1', booking_intent_id: 'bi_1' },
      idempotenceKey: 'afl_1',
    });

    expect(out).toEqual({ transferId: 'tr_1' });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://api.whop.com/api/v1/transfers');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      origin_id: 'biz_parent',
      destination_id: 'biz_x',
      amount: 0.3,
      currency: 'usd',
      metadata: { kind: 'affiliate', ledger_entry_id: 'afl_1', booking_intent_id: 'bi_1' },
      idempotence_key: 'afl_1',
    });
    expect(init.headers).not.toHaveProperty('Idempotency-Key');
    expect(Object.keys(init.headers).sort()).toEqual(['Authorization', 'Content-Type']);
    expect(init.headers.Authorization).toBe('Bearer k_test');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(TRANSFER_TIMEOUT_MS).toBeLessThan(60_000); // inside the webhook route's maxDuration
  });

  it('without an idempotence key it sends no such field', async () => {
    const f = vi.fn<(url: string, init: any) => Promise<Response>>(async () => json({ id: 'tr_1' }));
    vi.stubGlobal('fetch', f);
    await createTransfer({ originId: 'biz_parent', destinationId: 'biz_x', amountUsdDollars: 1 });
    const init = f.mock.calls[0]![1];
    expect(JSON.parse(init.body)).not.toHaveProperty('idempotence_key');
  });

  it('honours WHOP_API_BASE (the preview harness points it at a mock transfer server)', async () => {
    process.env.WHOP_API_BASE = 'http://localhost:4010/api/v1';
    const f = vi.fn<(url: string, init: any) => Promise<Response>>(async () => json({ id: 'tr_1' }));
    vi.stubGlobal('fetch', f);
    await createTransfer({ originId: 'a', destinationId: 'b', amountUsdDollars: 1 });
    expect(f.mock.calls[0]![0]).toBe('http://localhost:4010/api/v1/transfers');
  });

  it('a refusal throws the text the classifier reads; a timeout is not a refusal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Please verify your business before transferring funds', { status: 403 })));
    const err = await createTransfer({ originId: 'a', destinationId: 'b', amountUsdDollars: 1 }).catch((e) => e);
    expect(err.message).toBe('Whop /transfers failed (403): Please verify your business before transferring funds');
    expect(classifyTransferFailure(err)).toBe('PARKED');

    vi.stubGlobal('fetch', vi.fn(async () => new Response('insufficient available balance', { status: 402 })));
    expect(classifyTransferFailure(await createTransfer({ originId: 'a', destinationId: 'b', amountUsdDollars: 1 }).catch((e) => e))).toBe('RETRY');

    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))));
    expect(classifyTransferFailure(await createTransfer({ originId: 'a', destinationId: 'b', amountUsdDollars: 1 }).catch((e) => e))).toBe('AMBIGUOUS');
  });

  it('is a WhopNotConfigured error (a parked refusal) when the key is missing', async () => {
    delete process.env.WHOP_COMPANY_API_KEY;
    const err = await createTransfer({ originId: 'a', destinationId: 'b', amountUsdDollars: 1 }).catch((e) => e);
    expect(err).toBeInstanceOf(WhopNotConfigured);
    expect(classifyTransferFailure(err)).toBe('PARKED');
  });
});

describe('findTransferForLedgerEntry: found / not-found / unknown', () => {
  const rows = (ids: string[], entry?: string) =>
    ids.map((id) => ({ id, amount: 3, metadata: id === entry ? { ledger_entry_id: 'afl_1' } : { ledger_entry_id: `other_${id}` } }));
  const look = () => findTransferForLedgerEntry({ originId: 'o', destinationId: 'd', ledgerEntryId: 'afl_1' });

  it('lists by origin and destination, bounded by creation time, and matches metadata.ledger_entry_id', async () => {
    const f = vi.fn<(url: string) => Promise<Response>>(async () => json({ data: rows(['t1', 't2'], 't2'), page_info: {} }));
    vi.stubGlobal('fetch', f);
    const found = await findTransferForLedgerEntry({
      originId: 'biz_parent',
      destinationId: 'biz_x',
      ledgerEntryId: 'afl_1',
      createdAfter: new Date('2026-10-15T00:00:00Z'),
    });
    expect(found).toEqual({ kind: 'found', transferId: 't2', amountUsdDollars: 3 });
    const url = new URL(f.mock.calls[0]![0] as string);
    expect(url.pathname).toBe('/api/v1/transfers');
    expect(url.searchParams.get('origin_id')).toBe('biz_parent');
    expect(url.searchParams.get('destination_id')).toBe('biz_x');
    expect(url.searchParams.get('created_after')).toBe('2026-10-15T00:00:00.000Z');
  });

  it('NOT-FOUND is positive evidence: a usable list (rows expose metadata) that ends without a match', async () => {
    const full = Array.from({ length: 100 }, (_, i) => `t${i}`);
    const f = vi
      .fn()
      .mockResolvedValueOnce(json({ data: rows(full), page_info: { end_cursor: 'c1' } }))
      .mockResolvedValueOnce(json({ data: rows(['last']), page_info: {} }));
    vi.stubGlobal('fetch', f);
    expect(await look()).toEqual({ kind: 'not-found' });
    expect(new URL(f.mock.calls[1]![0] as string).searchParams.get('after')).toBe('c1');
  });

  it('an EMPTY list with the expected envelope is not-found (nothing was listed that metadata could hide)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: [], page_info: {} })));
    expect(await look()).toEqual({ kind: 'not-found' });
  });

  it('rows with metadata: null (transfers made without any) still count as a usable list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: [{ id: 't1', amount: 1, metadata: null }], page_info: {} })));
    expect(await look()).toEqual({ kind: 'not-found' });
  });

  it.each([
    ['an unfamiliar envelope key', { transfers: [{ id: 't1', metadata: { ledger_entry_id: 'afl_1' } }] }],
    ['a bare array', [{ id: 't1', metadata: { ledger_entry_id: 'afl_1' } }]],
    ['data that is not a list', { data: { id: 't1' } }],
    ['null', null],
  ])('%s is UNKNOWN, never not-found', async (_n, body) => {
    vi.stubGlobal('fetch', vi.fn(async () => json(body)));
    expect(await look()).toMatchObject({ kind: 'unknown', reason: expect.stringMatching(/envelope/) });
  });

  it('rows that carry no metadata field at all (metadata is not returned) are UNKNOWN, never not-found', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: [{ id: 't1', amount: 3 }, { id: 't2', amount: 3 }], page_info: {} })));
    expect(await look()).toMatchObject({ kind: 'unknown', reason: expect.stringMatching(/no metadata field/) });
  });

  it('a list too long to scan within the page budget is UNKNOWN', async () => {
    const full = Array.from({ length: 100 }, (_, i) => `t${i}`);
    vi.stubGlobal('fetch', vi.fn(async () => json({ data: rows(full), page_info: { end_cursor: 'more' } })));
    expect(await look()).toMatchObject({ kind: 'unknown', reason: expect.stringMatching(/page budget/) });
  });

  it('THROWS when the request fails: that is never "no transfer exists"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
    await expect(look()).rejects.toThrow(/lookup failed \(503\)/);
  });
});

describe('isConnectedAccountOfParent', () => {
  it('compares parent_company_id when the company exposes it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ id: 'biz_sib', parent_company_id: 'biz_parent' })));
    await expect(isConnectedAccountOfParent('biz_sib')).resolves.toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => json({ id: 'biz_other', parent_company_id: 'biz_someone_else' })));
    await expect(isConnectedAccountOfParent('biz_other')).resolves.toBe(false);
  });

  it('falls back to the parent\u2019s connected-account list when the company does not expose its parent', async () => {
    const f = vi.fn(async (url: string) =>
      url.includes('/companies?')
        ? json({ data: [{ id: 'biz_a' }, { id: 'biz_sib' }], page_info: {} })
        : json({ id: 'biz_sib', title: 'X' }),
    );
    vi.stubGlobal('fetch', f);
    await expect(isConnectedAccountOfParent('biz_sib')).resolves.toBe(true);
    await expect(isConnectedAccountOfParent('biz_stranger')).resolves.toBe(false);
    expect((f.mock.calls.find((c) => String(c[0]).includes('/companies?'))![0] as string)).toContain('parent_company_id=biz_parent');
  });

  it('throws when it cannot read the company, rather than guessing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    await expect(isConnectedAccountOfParent('biz_sib')).rejects.toThrow(/failed \(404\)/);
  });
});

describe('getAccountBalanceUsd', () => {
  it('reads the USD balance and pending balance in dollars', async () => {
    const f = vi.fn<(url: string) => Promise<Response>>(async () =>
      json({ balances: [{ currency: 'eur', balance: 9, pending_balance: 9 }, { currency: 'usd', balance: 12.5, pending_balance: 3 }] }),
    );
    vi.stubGlobal('fetch', f);
    await expect(getAccountBalanceUsd('biz_x')).resolves.toEqual({ balanceUsd: 12.5, pendingUsd: 3 });
    expect(f.mock.calls[0]![0]).toBe('https://api.whop.com/api/v1/ledger_accounts/biz_x');
  });

  it('throws on a non-2xx answer (the canary records it per read)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not found', { status: 404 })));
    await expect(getAccountBalanceUsd('biz_x')).rejects.toThrow(/failed \(404\)/);
  });
});
