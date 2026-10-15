import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fakeLedgerDb } from './helpers/fake-ledger-db';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The admin "needs attention" table for shares with no confirmed receipt. Read-only, empty while
 * payouts are off, and fed by the same finder the cron alerts from.
 */

const state = vi.hoisted(() => ({ db: null as any }));
// The component renders forms bound to a server action; the action module needs these at import time.
vi.mock('@/auth', () => ({ auth: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@/lib/prisma', () => ({
  get prisma() {
    return state.db;
  },
}));

const NOW = new Date(Date.UTC(2026, 9, 15, 12, 0, 0));
const OLD = new Date(NOW.getTime() - 2 * 3_600_000);
const wallets = { R: { whopCompanyId: 'biz_R', whopPayoutsEnabled: true } };

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.WHOP_TRANSFERS_ENABLED;
  delete process.env.WHOP_TRANSFERS_ENABLED;
  state.db = fakeLedgerDb({
    practitioners: wallets,
    affiliate: {
      entries: [
        { id: 'afl_stuck', bookingIntentId: 'b1', recruiterPractitionerId: 'R', shareUsdCents: 300, state: 'SENDING', transferUsdCents: 300, transferAttempts: 2, createdAt: OLD },
        { id: 'afl_fine', bookingIntentId: 'b2', recruiterPractitionerId: 'R', shareUsdCents: 300, state: 'SETTLED', settledAt: NOW, createdAt: OLD },
      ],
    },
    referral: {
      entries: [
        { id: 'rfl_retry', bookingIntentId: 'b3', referrerPractitionerId: 'R', referrerShareUsdCents: 2000, state: 'PAYABLE', lastError: 'PARKED: Whop /transfers failed (403): verify your business', createdAt: OLD },
      ],
    },
  });
});
afterEach(() => {
  if (saved === undefined) delete process.env.WHOP_TRANSFERS_ENABLED;
  else process.env.WHOP_TRANSFERS_ENABLED = saved;
});

async function render() {
  const { TransfersNeedingAttention } = await import('@/app/admin/commercial-settings/TransfersNeedingAttention');
  const el = await TransfersNeedingAttention({ now: NOW });
  return el === null ? null : renderToStaticMarkup(el);
}

describe('TransfersNeedingAttention', () => {
  it('renders nothing while payouts are off: no transfer is expected to have moved', async () => {
    expect(await render()).toBeNull();
  });

  it('with payouts on, lists every share without a receipt after 30 minutes, with ledger, state, amount, attempts and last error', async () => {
    process.env.WHOP_TRANSFERS_ENABLED = 'true';
    const html = (await render())!;
    expect(html).toContain('2 shares without a confirmed transfer after 30 minutes');
    expect(html).toContain('afl_stuck');
    expect(html).toContain('rfl_retry');
    expect(html).not.toContain('afl_fine');
    expect(html).toContain('$3.00');
    expect(html).toContain('$20.00');
    expect(html).toContain('verify your business');
    expect(html).toContain('metadata.ledger_entry_id');
    // Only the rows waiting for a person get the audited decision forms.
    expect((html.match(/<form/g) ?? []).length).toBe(0);
  });

  it('a row waiting for a person is listed at once, with both decisions as forms to the admin action', async () => {
    process.env.WHOP_TRANSFERS_ENABLED = 'true';
    state.db = fakeLedgerDb({
      practitioners: wallets,
      affiliate: {
        entries: [
          { id: 'afl_flag', bookingIntentId: 'b9', recruiterPractitionerId: 'R', shareUsdCents: 300, state: 'ACCRUED', transferUsdCents: 300, attentionReason: 'ambiguous-unverified', lastError: 'timeout', createdAt: NOW },
        ],
      },
    });
    const html = (await render())!;
    expect(html).toContain('afl_flag');
    expect(html).toContain('Outcome unknown: decide');
    expect((html.match(/<form/g) ?? []).length).toBe(2);
    expect(html).toContain('It went out (record id)');
    expect(html).toContain('It did not go out (retry)');
    expect(html).toContain('name="outcome" value="went-out"');
    expect(html).toContain('name="outcome" value="did-not-go-out"');
    expect(html).toContain('name="rowId" value="afl_flag"');
  });

  it('renders nothing when every share has a receipt', async () => {
    process.env.WHOP_TRANSFERS_ENABLED = 'true';
    state.db = fakeLedgerDb({ practitioners: wallets });
    expect(await render()).toBeNull();
  });

  it('is mounted only inside the ADMIN-gated page, and carries no write path of its own', () => {
    const page = readFileSync(join(__dirname, '..', 'src/app/admin/commercial-settings/page.tsx'), 'utf8');
    expect(page.indexOf("role !== 'ADMIN'")).toBeLessThan(page.indexOf('<TransfersNeedingAttention'));
    const src = readFileSync(join(__dirname, '..', 'src/app/admin/commercial-settings/TransfersNeedingAttention.tsx'), 'utf8');
    // No direct database writes of its own: the only write path is the audited admin action.
    expect(src).not.toMatch(/\.(update|updateMany|create|createMany|upsert|delete|deleteMany)\(/);
    expect(src).toMatch(/action=\{resolveTransferAttentionAction\}/);
    const actions = readFileSync(join(__dirname, '..', 'src/app/admin/commercial-settings/actions.ts'), 'utf8');
    const fn = actions.slice(actions.indexOf('export async function resolveTransferAttentionAction'));
    expect(fn.indexOf('await authorizeAdmin()')).toBeGreaterThan(-1);
    expect(fn.indexOf('await authorizeAdmin()')).toBeLessThan(fn.indexOf('resolveTransferAttention('));
  });
});
