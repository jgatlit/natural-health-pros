import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkApplyGuards, runReconcile, type PgLike } from '../scripts/reconcile-referral-v15';

/* eslint-disable @typescript-eslint/no-explicit-any */

const WRITE = /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT|COPY)\b/i;

type Row = Record<string, any>;

/** A fake pg client that records every statement and models just enough state to prove idempotency. */
function fakeClient(opts: { readOnlyAnswer?: string; staleSelect?: boolean } = {}) {
  const statements: string[] = [];
  const markers = new Set<string>();
  const ledger = new Map<string, Row>([
    ['led_over', { id: 'led_over', share: 2500 }],
    ['led_term', { id: 'led_term', share: 2000 }],
  ]);
  const seed = (id: string, share: number, paidAt: string): Row => ({
    id,
    bookingIntentId: `bi_${id}`,
    referrerPractitionerId: 'ref',
    state: 'PAYABLE',
    grossUsdCents: 10_000,
    referrerShareUsdCents: share,
    collectedFeeUsdCents: share + 2000,
    paidAt: new Date(paidAt),
    anchorAt: new Date('2026-09-01T00:00:00Z'),
    storedReferrerTermMonths: null,
    storedLeadTermMonths: null,
    schedReferrerBps: 2000,
    schedTotalBps: 3000,
    schedReferrerTermMonths: 4,
    schedLeadTermMonths: 8,
  });
  const initial = [seed('led_over', 2500, '2026-10-01T00:00:00Z'), seed('led_term', 2000, '2027-02-01T00:00:00Z')];
  const staleRows = initial.map((r) => ({ ...r }));
  let inTx = false;
  let readWrite = false;

  const client: PgLike = {
    async query(text: string, values: unknown[] = []) {
      statements.push(text);
      const t = text.trim();
      if (/^SET default_transaction_read_only/i.test(t)) return { rows: [], rowCount: 0 };
      if (/^SHOW default_transaction_read_only/i.test(t)) {
        return { rows: [{ default_transaction_read_only: opts.readOnlyAnswer ?? 'on' }], rowCount: 1 };
      }
      if (/^SELECT/i.test(t)) {
        return { rows: (opts.staleSelect ? staleRows : initial).map((r) => ({ ...r })), rowCount: 2 };
      }
      if (/^BEGIN READ WRITE/i.test(t)) {
        inTx = true;
        readWrite = true;
        return { rows: [], rowCount: 0 };
      }
      if (/^(COMMIT|ROLLBACK)/i.test(t)) {
        inTx = false;
        return { rows: [], rowCount: 0 };
      }
      if (!inTx || !readWrite) throw new Error(`write outside a READ WRITE transaction: ${t.slice(0, 40)}`);
      if (/^INSERT INTO "FeeLedgerEntry"/i.test(t)) {
        const key = values[4] as string;
        if (markers.has(key)) return { rows: [], rowCount: 0 };
        markers.add(key);
        return { rows: [{ id: 'm' }], rowCount: 1 };
      }
      if (/^UPDATE "ReferralLedgerEntry"/i.test(t)) {
        const row = initial.find((r) => r.id === values[0]);
        if (!row || row.referrerShareUsdCents !== values[2]) return { rows: [], rowCount: 0 };
        row.referrerShareUsdCents = values[1] as number;
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected statement: ${t.slice(0, 60)}`);
    },
  };
  return { client, statements, markers, initial, ledger };
}

const NOW = new Date('2027-03-01T00:00:00Z');
const collect = () => {
  const lines: Record<string, unknown>[] = [];
  return { lines, log: (l: Record<string, unknown>) => lines.push(l) };
};

describe('reconcile script: DRY RUN (the default)', () => {
  it('makes the connection read-only FIRST, and issues no write statement', async () => {
    const f = fakeClient();
    const { log } = collect();
    const summary = await runReconcile(f.client, { apply: false, now: NOW, log });

    expect(f.statements[0]).toBe('SET default_transaction_read_only = on');
    expect(f.statements[1]).toBe('SHOW default_transaction_read_only');
    for (const s of f.statements.slice(2)) expect(s.trim()).toMatch(/^SELECT/i);
    for (const s of f.statements) {
      if (!/^SET default_transaction_read_only/.test(s.trim())) expect(s).not.toMatch(WRITE);
    }
    expect(summary).toMatchObject({ mode: 'dry-run', rows: 2, reprice: 2, applied: 0 });
    expect(f.initial[0]!.referrerShareUsdCents).toBe(2500); // untouched
    expect(f.markers.size).toBe(0);
  });

  it('logs one JSON line per row decision, plus a summary', async () => {
    const f = fakeClient();
    const { lines, log } = collect();
    await runReconcile(f.client, { apply: false, now: NOW, log });
    const rows = lines.filter((l) => l.event === 'row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 'led_over', action: 'REPRICE', newShareUsdCents: 2000 });
    expect(rows[1]).toMatchObject({ id: 'led_term', action: 'REPRICE', newShareUsdCents: 0 });
    for (const l of lines) expect(() => JSON.parse(JSON.stringify(l))).not.toThrow();
    expect(lines.at(-1)).toMatchObject({ event: 'summary' });
  });

  it('aborts, before reading anything, when the server does not confirm read-only', async () => {
    const f = fakeClient({ readOnlyAnswer: 'off' });
    await expect(runReconcile(f.client, { apply: false, now: NOW, log: () => {} })).rejects.toThrow(/read_only/);
    expect(f.statements.some((s) => /^SELECT/i.test(s.trim()))).toBe(false);
  });
});

describe('reconcile script: --apply', () => {
  it('applies in one READ WRITE transaction with an audit marker per row', async () => {
    const f = fakeClient();
    const summary = await runReconcile(f.client, { apply: true, now: NOW, log: () => {} });
    expect(summary).toMatchObject({ mode: 'apply', applied: 2, alreadyApplied: 0 });
    expect(f.initial.map((r) => r.referrerShareUsdCents)).toEqual([2000, 0]);
    expect(Array.from(f.markers).sort()).toEqual(['REPRICE_V15:led_over', 'REPRICE_V15:led_term']);
    expect(f.statements).toContain('BEGIN READ WRITE');
    expect(f.statements.at(-1)).toBe('COMMIT');
  });

  it('is idempotent: a second run decides NOOP and writes nothing', async () => {
    const f = fakeClient();
    await runReconcile(f.client, { apply: true, now: NOW, log: () => {} });
    const before = f.statements.length;
    const second = await runReconcile(f.client, { apply: true, now: NOW, log: () => {} });
    expect(second).toMatchObject({ reprice: 0, applied: 0, noop: 2 });
    expect(f.statements.slice(before).some((s) => WRITE.test(s) && !/default_transaction_read_only/.test(s))).toBe(false);
  });

  it('is idempotent even against a stale read: the unique marker stops a second change', async () => {
    const f = fakeClient({ staleSelect: true });
    await runReconcile(f.client, { apply: true, now: NOW, log: () => {} });
    const again = await runReconcile(f.client, { apply: true, now: NOW, log: () => {} });
    expect(again).toMatchObject({ applied: 0, alreadyApplied: 2 });
    expect(f.initial.map((r) => r.referrerShareUsdCents)).toEqual([2000, 0]);
  });
});

describe('apply guards', () => {
  const now = new Date('2027-03-01T10:00:00Z');
  it('dry run needs nothing', () => {
    expect(checkApplyGuards({ argv: [], env: {}, host: 'x.neon.tech', now })).toBeNull();
  });
  it('--apply needs RECONCILE_CONFIRM equal to today (UTC)', () => {
    expect(checkApplyGuards({ argv: ['--apply'], env: {}, host: 'localhost', now })).toMatch(/RECONCILE_CONFIRM=2027-03-01/);
    expect(checkApplyGuards({ argv: ['--apply'], env: { RECONCILE_CONFIRM: '2027-02-28' }, host: 'localhost', now })).not.toBeNull();
    expect(checkApplyGuards({ argv: ['--apply'], env: { RECONCILE_CONFIRM: '2027-03-01' }, host: 'localhost', now })).toBeNull();
  });
  it('a *.neon.tech host additionally needs --i-know-this-is-production', () => {
    const env = { RECONCILE_CONFIRM: '2027-03-01' };
    expect(checkApplyGuards({ argv: ['--apply'], env, host: 'ep-x.c-7.us-east-1.aws.neon.tech', now })).toMatch(/i-know-this-is-production/);
    expect(
      checkApplyGuards({ argv: ['--apply', '--i-know-this-is-production'], env, host: 'ep-x.aws.neon.tech', now }),
    ).toBeNull();
  });
});

describe('the script source', () => {
  const src = readFileSync(path.join(__dirname, '..', 'scripts', 'reconcile-referral-v15.ts'), 'utf8');
  it('contains no write keyword at all (the write statements live in the apply file)', () => {
    expect(src).not.toMatch(WRITE);
  });
  it('reads only RECONCILE_DATABASE_URL, never an env file or a production variable', () => {
    expect(src).toMatch(/process\.env\.RECONCILE_DATABASE_URL/);
    expect(src).not.toMatch(/DATABASE_URL_UNPOOLED|hhe_directory|dotenv|['"`]\.env|\.env\.local|readFile/);
  });
});
