import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

import { fakeLedgerDb } from './helpers/fake-ledger-db';

type Row = {
  id: string;
  slug: string;
  whopIdentityProfileId: string | null;
  whopPayoutAccountId: string | null;
  whopPayoutStatus: string;
  whopPayoutsEnabled: boolean;
};

const mocks = vi.hoisted(() => ({
  findMany: vi.fn<() => Promise<Row[]>>(),
  update: vi.fn<(args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>>(),
  getIdentityProfile: vi.fn(),
  getPayoutStatus: vi.fn(),
  isWhopPlatformsReady: vi.fn<() => boolean>(),
  feeUpsert: vi.fn<(args?: unknown) => Promise<unknown>>(),
  createTransfer: vi.fn<(args?: unknown) => Promise<{ transferId: string }>>(),
  findTransfer: vi.fn<(args?: unknown) => Promise<{ transferId: string; amountUsdDollars: number } | null>>(),
  feeFindMany: vi.fn<(args?: unknown) => Promise<unknown[]>>(),
  getPaymentFees: vi.fn<(id: string) => Promise<Array<{ origin: string; amount: number }>>>(),
  /** The two payout ledgers: replaced per test with an in-memory fake that keeps the guarded-update semantics. */
  ledger: { db: null as any }, // eslint-disable-line @typescript-eslint/no-explicit-any
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    practitioner: { findMany: mocks.findMany, update: mocks.update },
    // The payout ledgers (referral and recruiter): a real in-memory fake, not call-recording stubs,
    // so the settle claims, the netting transactions and the alert query all run for real.
    get referralLedgerEntry() {
      return mocks.ledger.db.referralLedgerEntry;
    },
    get referralBalanceAdjustment() {
      return mocks.ledger.db.referralBalanceAdjustment;
    },
    get affiliateLedgerEntry() {
      return mocks.ledger.db.affiliateLedgerEntry;
    },
    get affiliateBalanceAdjustment() {
      return mocks.ledger.db.affiliateBalanceAdjustment;
    },
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => mocks.ledger.db.$transaction(fn),
    feeLedgerEntry: {
      upsert: mocks.feeUpsert,
      findMany: mocks.feeFindMany,
    },
  },
}));

vi.mock('@/lib/whop', () => ({
  WhopNotConfigured: class WhopNotConfigured extends Error {},
  getIdentityProfile: mocks.getIdentityProfile,
  getPayoutStatus: mocks.getPayoutStatus,
  isWhopPlatformsReady: mocks.isWhopPlatformsReady,
  // ⚠️ NEVER the real one. This test must not be one refactor away from posting a live transfer.
  createTransfer: mocks.createTransfer,
  findTransferForLedgerEntry: mocks.findTransfer,
  getPaymentFees: mocks.getPaymentFees,
}));

// Imported inside beforeAll, not at module top level: a top-level await here is valid for
// vitest but trips tsc under this tsconfig's module target. Mirrors trial-sweep.test.ts.
let GET: (req: NextRequest) => Promise<Response>;

beforeAll(async () => {
  ({ GET } = await import('@/app/api/cron/whop-reconcile/route'));
});

function req(auth?: string): NextRequest {
  return new Request('https://example.test/api/cron/whop-reconcile', {
    headers: auth ? { authorization: auth } : {},
  }) as unknown as NextRequest;
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: 'prac_1',
    slug: 'sarah',
    whopIdentityProfileId: 'idpf_L366QzEEVUnVH',
    whopPayoutAccountId: null,
    whopPayoutStatus: 'not_started',
    whopPayoutsEnabled: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CRON_SECRET;
  mocks.isWhopPlatformsReady.mockReturnValue(true);
  mocks.ledger.db = fakeLedgerDb();
  mocks.feeUpsert.mockResolvedValue({});
  mocks.createTransfer.mockResolvedValue({ transferId: 'tr_test' });
  mocks.findTransfer.mockResolvedValue(null);
  mocks.feeFindMany.mockResolvedValue([]);
  mocks.getPaymentFees.mockResolvedValue([]);
  mocks.update.mockResolvedValue({});
  mocks.findMany.mockResolvedValue([]);
});

describe('whop-reconcile — authorization', () => {
  it('rejects a wrong bearer when CRON_SECRET is set', async () => {
    process.env.CRON_SECRET = 's3cret';
    const res = await GET(req('Bearer wrong'));
    expect(res.status).toBe(401);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it('accepts the correct bearer', async () => {
    process.env.CRON_SECRET = 's3cret';
    const res = await GET(req('Bearer s3cret'));
    expect(res.status).toBe(200);
  });

  it('is OPEN when CRON_SECRET is unset — pins the branch rather than leaving it undocumented', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(mocks.findMany).toHaveBeenCalled();
  });
});

describe('whop-reconcile — the payout gate', () => {
  // THE REGRESSION GUARD. A parent-company API key under-reports `payouts_enabled`: Whop's own
  // identity_profile.updated for idpf_f9VEKuIiqGPc2 carried `payouts_enabled: true`, while GET
  // /identity_profiles returns `false` for that same profile. Gating on the polled boolean is
  // what made this sweep structurally unable to open the gate it exists to open.
  it('OPENS the gate on approved + connected even when the polled payouts_enabled is false', async () => {
    mocks.findMany.mockResolvedValue([row()]);
    mocks.getIdentityProfile.mockResolvedValue({
      status: 'approved',
      payoutStatus: 'connected',
      payoutsEnabled: false,
    });

    const res = await GET(req());
    const body = await res.json();

    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'prac_1' },
        data: expect.objectContaining({ whopPayoutsEnabled: true }),
      }),
    );
    expect(body.corrected).toBeGreaterThan(0);
  });

  it('does NOT open the gate when the profile is approved but not yet connected', async () => {
    mocks.findMany.mockResolvedValue([row()]);
    mocks.getIdentityProfile.mockResolvedValue({
      status: 'approved',
      payoutStatus: 'pending_verification',
      payoutsEnabled: false,
    });

    await GET(req());

    const data = mocks.update.mock.calls[0]?.[0]?.data ?? {};
    expect(data).not.toHaveProperty('whopPayoutsEnabled');
  });

  it('is ONE-WAY: never closes a gate that is already open', async () => {
    mocks.findMany.mockResolvedValue([row({ whopPayoutsEnabled: true, whopPayoutStatus: 'connected' })]);
    mocks.getIdentityProfile.mockResolvedValue({
      status: 'approved',
      payoutStatus: 'connected',
      payoutsEnabled: false,
    });

    await GET(req());

    for (const call of mocks.update.mock.calls) {
      expect(call[0].data).not.toHaveProperty('whopPayoutsEnabled');
    }
  });
});

describe('whop-reconcile — honest reporting', () => {
  it('does NOT report drift that was never persisted', async () => {
    mocks.findMany.mockResolvedValue([row()]);
    mocks.getIdentityProfile.mockResolvedValue({
      status: 'approved',
      payoutStatus: 'connected',
      payoutsEnabled: false,
    });
    mocks.update.mockRejectedValue(new Error('P2002 unique constraint'));

    const res = await GET(req());
    const body = await res.json();

    expect(body.corrected).toBe(0);
    expect(body.drift).toEqual([]);
    expect(body.errors.join(' ')).toContain('P2002');
  });

  it('returns 207 when any account failed, so a fully-failed sweep cannot read as healthy', async () => {
    mocks.findMany.mockResolvedValue([row()]);
    mocks.getIdentityProfile.mockRejectedValue(new Error('401 unauthorized'));

    const res = await GET(req());
    const body = await res.json();

    expect(res.status).toBe(207);
    expect(body.ok).toBe(false);
    expect(body.errors).toHaveLength(1);
  });

  it('returns 200 ok:true only on a genuinely clean run', async () => {
    mocks.findMany.mockResolvedValue([row({ whopPayoutStatus: 'connected', whopPayoutsEnabled: true })]);
    mocks.getIdentityProfile.mockResolvedValue({
      status: 'approved',
      payoutStatus: 'connected',
      payoutsEnabled: true,
    });

    const res = await GET(req());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.errors).toEqual([]);
  });

  it('reports an unresolvable identity profile instead of counting it as verified', async () => {
    mocks.findMany.mockResolvedValue([row()]);
    mocks.getIdentityProfile.mockResolvedValue(null);

    const res = await GET(req());
    const body = await res.json();

    expect(res.status).toBe(207);
    expect(body.errors.join(' ')).toContain('no Whop resource resolved');
  });

  it('falls back to the payout account when the identity profile does not resolve', async () => {
    mocks.findMany.mockResolvedValue([
      row({ whopPayoutAccountId: 'poact_SeAGBkatzxjJ' }),
    ]);
    mocks.getIdentityProfile.mockResolvedValue(null);
    mocks.getPayoutStatus.mockResolvedValue({ status: 'connected' });

    await GET(req());

    expect(mocks.getPayoutStatus).toHaveBeenCalledWith('poact_SeAGBkatzxjJ');
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ whopPayoutStatus: 'connected' }) }),
    );
  });

  it('flags a connected account with no Whop resource ids as unpollable, not clean', async () => {
    mocks.findMany.mockResolvedValue([
      row({ whopIdentityProfileId: null, whopPayoutAccountId: null }),
    ]);

    const res = await GET(req());
    const body = await res.json();

    expect(body.unpollable).toEqual(['sarah']);
    expect(res.status).toBe(207);
  });
});

describe('fee reconciliation (spec §7)', () => {
  it('agrees when Whop’s application_fee matches what we recorded collecting', async () => {
    mocks.feeFindMany.mockResolvedValue([
      { bookingIntentId: 'bi_1', whopPaymentId: 'pay_1', amountUsdCents: 4_000 },
    ]);
    mocks.getPaymentFees.mockResolvedValue([{ origin: 'application_fee', amount: 40 }]);

    const res = await GET(req());
    const body = (await res.json()) as { feeMismatches: unknown[] };

    expect(body.feeMismatches).toEqual([]);
  });

  it('reports a mismatch AND refuses to return 200 — a silent success here hides missing money', async () => {
    mocks.feeFindMany.mockResolvedValue([
      { bookingIntentId: 'bi_1', whopPaymentId: 'pay_1', amountUsdCents: 4_000 },
    ]);
    mocks.getPaymentFees.mockResolvedValue([{ origin: 'application_fee', amount: 20 }]);

    const res = await GET(req());
    const body = (await res.json()) as {
      ok: boolean;
      feeMismatches: { expectedUsdCents: number; observedUsdCents: number }[];
    };

    expect(res.status).toBe(207);
    expect(body.ok).toBe(false);
    expect(body.feeMismatches).toEqual([
      { bookingIntentId: 'bi_1', expectedUsdCents: 4_000, observedUsdCents: 2_000 },
    ]);
  });

  it('treats a payment Whop reports NO application fee for as a mismatch, not a skip', async () => {
    mocks.feeFindMany.mockResolvedValue([
      { bookingIntentId: 'bi_1', whopPaymentId: 'pay_1', amountUsdCents: 4_000 },
    ]);
    mocks.getPaymentFees.mockResolvedValue([{ origin: 'payment_processing_fixed_fee', amount: 0.3 }]);

    const res = await GET(req());
    const body = (await res.json()) as { feeMismatches: { observedUsdCents: number }[] };

    expect(body.feeMismatches[0]?.observedUsdCents).toBe(0);
  });
});

const OLD = new Date(Date.UTC(2026, 0, 1)); // far outside the 30-minute window
const ENVS = ['WHOP_TRANSFERS_ENABLED', 'WHOP_TRANSFERS_ALLOWLIST', 'WHOP_PARENT_COMPANY_ID', 'WHOP_COMPANY_API_KEY'];
const enableTransfers = () => {
  process.env.WHOP_TRANSFERS_ENABLED = 'true';
  process.env.WHOP_PARENT_COMPANY_ID = 'biz_parent';
  process.env.WHOP_COMPANY_API_KEY = 'apik_x';
};
const referralRow = (over: Record<string, unknown> = {}) => ({
  id: 'led_1',
  bookingIntentId: 'bi_1',
  referrerPractitionerId: 'prac_x',
  servingPractitionerId: 'prac_y',
  grossUsdCents: 10_000,
  referrerShareUsdCents: 2_000,
  createdAt: OLD,
  ...over,
});
const affiliateRow = (over: Record<string, unknown> = {}) => ({
  id: 'afl_1',
  bookingIntentId: 'bi_2',
  recruiterPractitionerId: 'prac_R',
  recruitedPractitionerId: 'prac_y',
  grossUsdCents: 10_000,
  bps: 300,
  shareUsdCents: 300,
  holdDays: 0,
  holdUntil: OLD,
  createdAt: OLD,
  ...over,
});
const wallets = {
  prac_x: { whopCompanyId: 'biz_x', whopPayoutsEnabled: true },
  prac_R: { whopCompanyId: 'biz_R', whopPayoutsEnabled: true },
};

describe('share transfers: the hourly sweep is the RETRY BACKSTOP (spec v1.4 §6.2, v1.5 §5)', () => {
  beforeEach(() => {
    for (const k of ENVS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENVS) delete process.env[k];
    vi.restoreAllMocks();
  });

  it('does NOT call Whop while payouts are switched off, and says why in the response; nothing is alerted either', async () => {
    mocks.ledger.db = fakeLedgerDb({ practitioners: wallets, referral: { entries: [referralRow()] }, affiliate: { entries: [affiliateRow()] } });

    const res = await GET(req());
    const body = (await res.json()) as {
      ok: boolean;
      referrals: { blocked: string | null; settled: number };
      affiliates: { blocked: string | null };
      transfersUnconfirmed: unknown[];
    };

    expect(mocks.createTransfer).not.toHaveBeenCalled();
    expect(body.referrals.blocked).toBe('skipped: transfers disabled');
    expect(body.affiliates.blocked).toBe('skipped: transfers disabled');
    expect(body.referrals.settled).toBe(0);
    expect(body.transfersUnconfirmed).toEqual([]);
    expect(res.status).toBe(200);
  });

  it('transfers in DOLLARS, in full, once the operator switches payouts on (both ledgers)', async () => {
    enableTransfers();
    mocks.ledger.db = fakeLedgerDb({ practitioners: wallets, referral: { entries: [referralRow()] }, affiliate: { entries: [affiliateRow()] } });

    const res = await GET(req());
    const body = (await res.json()) as { ok: boolean; referrals: { settled: number }; affiliates: { settled: number } };

    // 20 and 3, not 2000 and 300. `application_fee_amount` next door is in CENTS; this endpoint is in DOLLARS.
    expect(mocks.createTransfer).toHaveBeenCalledWith({
      originId: 'biz_parent',
      destinationId: 'biz_x',
      amountUsdDollars: 20,
      metadata: { kind: 'referral', ledger_entry_id: 'led_1', booking_intent_id: 'bi_1' },
      idempotenceKey: 'led_1',
    });
    expect(mocks.createTransfer).toHaveBeenCalledWith({
      originId: 'biz_parent',
      destinationId: 'biz_R',
      amountUsdDollars: 3,
      metadata: { kind: 'affiliate', ledger_entry_id: 'afl_1', booking_intent_id: 'bi_2' },
      idempotenceKey: 'afl_1',
    });
    expect(body.referrals.settled).toBe(1);
    expect(body.affiliates.settled).toBe(1);
    expect(body.ok).toBe(true);
    expect(res.status).toBe(200);
  });

  it('a row whose payee became payable later is settled by the sweep (the backstop for rows the webhook could not pay)', async () => {
    enableTransfers();
    const w = { prac_R: { whopCompanyId: null as string | null, whopPayoutsEnabled: false } };
    mocks.ledger.db = fakeLedgerDb({ practitioners: w, affiliate: { entries: [affiliateRow()] } });
    await GET(req());
    expect(mocks.createTransfer).not.toHaveBeenCalled();
    w.prac_R = { whopCompanyId: 'biz_R', whopPayoutsEnabled: true };
    await GET(req());
    expect(mocks.createTransfer).toHaveBeenCalledTimes(1);
  });

  it('a transfer that fails leaves the row unconfirmed: the cron returns 207, names the row id and logs it loudly', async () => {
    enableTransfers();
    mocks.createTransfer.mockRejectedValue(new Error('fetch failed'));
    mocks.ledger.db = fakeLedgerDb({ practitioners: wallets, affiliate: { entries: [affiliateRow()] } });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await GET(req());
    const body = (await res.json()) as { ok: boolean; errors: string[]; transfersUnconfirmed: Array<{ ledger: string; id: string }> };

    expect(res.status).toBe(207);
    expect(body.ok).toBe(false);
    expect(body.transfersUnconfirmed).toEqual([{ ledger: 'affiliate', id: 'afl_1' }]);
    expect(body.errors.join(' ')).toContain('afl_1');
    expect(body.errors.join(' ')).toMatch(/no confirmed receipt 30\+ minutes/);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('SHARE TRANSFERS WITHOUT A CONFIRMED RECEIPT'), expect.stringContaining('afl_1'));
  });

  it('a row that is only minutes old is not an alert yet', async () => {
    enableTransfers();
    mocks.createTransfer.mockRejectedValue(new Error('fetch failed'));
    mocks.ledger.db = fakeLedgerDb({ practitioners: wallets, referral: { entries: [referralRow({ createdAt: new Date() })] } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET(req());
    const body = (await res.json()) as { transfersUnconfirmed: unknown[] };
    expect(body.transfersUnconfirmed).toEqual([]);
    expect(res.status).toBe(200);
  });

  it('a payee who cannot receive money yet is not an alert (the unclaimed-share window is not a failure)', async () => {
    enableTransfers();
    mocks.ledger.db = fakeLedgerDb({
      practitioners: { prac_x: { whopCompanyId: null, whopPayoutsEnabled: false } },
      referral: { entries: [referralRow({ state: 'HELD' }), referralRow({ id: 'led_2', bookingIntentId: 'bi_9' })] },
    });
    const res = await GET(req());
    const body = (await res.json()) as { transfersUnconfirmed: unknown[] };
    expect(body.transfersUnconfirmed).toEqual([]);
    expect(res.status).toBe(200);
  });

  it('the allowlist is honoured by the sweep: a payee outside it is neither paid nor alerted', async () => {
    enableTransfers();
    process.env.WHOP_TRANSFERS_ALLOWLIST = 'prac_R';
    mocks.ledger.db = fakeLedgerDb({ practitioners: wallets, referral: { entries: [referralRow()] }, affiliate: { entries: [affiliateRow()] } });
    const res = await GET(req());
    const body = (await res.json()) as { transfersUnconfirmed: unknown[] };
    expect(mocks.createTransfer).toHaveBeenCalledTimes(1);
    expect(mocks.createTransfer).toHaveBeenCalledWith(expect.objectContaining({ destinationId: 'biz_R' }));
    expect(body.transfersUnconfirmed).toEqual([]);
  });

  it('an ambiguous attempt is looked up in Whop on the next run and settled from the found transfer', async () => {
    enableTransfers();
    mocks.createTransfer.mockRejectedValueOnce(new Error('The operation was aborted due to timeout'));
    mocks.ledger.db = fakeLedgerDb({ practitioners: wallets, affiliate: { entries: [affiliateRow({ createdAt: new Date() })] } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await GET(req());
    expect(mocks.ledger.db.affiliateRows[0]).toMatchObject({ state: 'ACCRUED', transferAttempts: 1 });

    mocks.findTransfer.mockResolvedValue({ transferId: 'tr_found', amountUsdDollars: 3 });
    mocks.ledger.db.affiliateRows[0].nextAttemptAt = new Date(0); // the backoff has passed
    await GET(req());
    expect(mocks.createTransfer).toHaveBeenCalledTimes(1);
    expect(mocks.ledger.db.affiliateRows[0]).toMatchObject({ state: 'SETTLED', whopTransferId: 'tr_found' });
  });

  it('exports maxDuration so a sweep of transfers is not cut off', async () => {
    const mod = await import('@/app/api/cron/whop-reconcile/route');
    expect(mod.maxDuration).toBeGreaterThanOrEqual(60);
  });
});
