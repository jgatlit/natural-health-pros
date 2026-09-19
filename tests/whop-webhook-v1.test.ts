import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { Practitioner } from '@prisma/client';
import { signedRequest, signWebhook, TEST_SECRET } from './helpers/whop-webhook';

const CHILD_SECRET = 'ws_test_child_secret_for_offline_signature_verification_9876543210';

type FindUniqueArgs = { where: { id?: string; whopCompanyId?: string } };
type UpdateArgs = { where: { id: string }; data: Record<string, unknown> };
type UpsertArgs = {
  where: { whopEventId: string };
  update: Record<string, unknown>;
  create: Record<string, unknown>;
};

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn<(args: FindUniqueArgs) => Promise<Practitioner | null>>(),
  update: vi.fn<(args: UpdateArgs) => Promise<Practitioner>>(),
  upsert: vi.fn<(args: UpsertArgs) => Promise<{ id: string } | null>>(),
  eventUpdate: vi.fn<(args: unknown) => Promise<unknown>>(),
  indexPractitioner: vi.fn<(id: string) => Promise<void>>(),
  intentUpdateMany: vi.fn<(args: unknown) => Promise<{ count: number }>>(),
  intentFindUnique: vi.fn<
    (args: unknown) => Promise<{
      id: string;
      practitionerId: string;
      paidAt: Date | null;
      email?: string | null;
      scheduledAt?: Date | null;
      referralTouchId?: string | null;
    } | null>
  >(),
  // The attribution write was invisible here until 2026-09-19: neither `platformSetting` nor
  // `attributedClient` existed on this mock, so `loadSettings` threw on every payment event, the
  // handler's bare catch swallowed it, and the whole ledger path was unexercised while every test
  // in this file passed. A mock weaker than production asserts nothing.
  settingFindMany: vi.fn<(args?: unknown) => Promise<Array<{ key: string; value: string }>>>(),
  attributedUpsert: vi.fn<(args: unknown) => Promise<unknown>>(),
  attributedUpdateMany: vi.fn<(args: unknown) => Promise<{ count: number }>>(),
  attributedFindUnique: vi.fn<(args: unknown) => Promise<unknown>>(),
  // Stage 3's referral ledger. Added here the moment the handler reached them, for the reason
  // stated above: a mock that lacks a model the handler calls makes the handler's bare catch
  // swallow a TypeError, and the whole path then passes while doing nothing.
  feeSnapshotFindUnique: vi.fn<(args: unknown) => Promise<unknown>>(),
  referralLedgerUpsert: vi.fn<(args: unknown) => Promise<unknown>>(),
  feeLedgerUpsert: vi.fn<(args: unknown) => Promise<unknown>>(),
  touchUpdateMany: vi.fn<(args: unknown) => Promise<{ count: number }>>(),
  touchFindUnique: vi.fn<(args: unknown) => Promise<unknown>>(),
  clientListUpsert: vi.fn<(args: unknown) => Promise<unknown>>(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    practitioner: {
      findUnique: mocks.findUnique,
      update: mocks.update,
    },
    whopWebhookEvent: {
      upsert: mocks.upsert,
      update: mocks.eventUpdate,
    },
    bookingIntent: {
      updateMany: mocks.intentUpdateMany,
      findUnique: mocks.intentFindUnique,
    },
    platformSetting: {
      findMany: mocks.settingFindMany,
    },
    attributedClient: {
      upsert: mocks.attributedUpsert,
      updateMany: mocks.attributedUpdateMany,
      findUnique: mocks.attributedFindUnique,
    },
    bookingFeeSnapshot: {
      findUnique: mocks.feeSnapshotFindUnique,
    },
    referralLedgerEntry: {
      upsert: mocks.referralLedgerUpsert,
    },
    feeLedgerEntry: {
      upsert: mocks.feeLedgerUpsert,
    },
    referralTouch: {
      updateMany: mocks.touchUpdateMany,
      findUnique: mocks.touchFindUnique,
    },
    clientListEntry: {
      upsert: mocks.clientListUpsert,
    },
  },
}));

vi.mock('@/lib/practitioner-indexer', () => ({
  indexPractitioner: mocks.indexPractitioner,
}));

function fakePractitioner(overrides: Partial<Practitioner> = {}): Practitioner {
  return {
    id: 'prac_1',
    whopCompanyId: null,
    whopPayoutStatus: 'not_started',
    whopPayoutsEnabled: false,
    ...overrides,
  } as unknown as Practitioner;
}

type PostHandler = (request: NextRequest) => Promise<Response>;
let POST: PostHandler;

beforeAll(async () => {
  process.env.WHOP_COMPANY_API_KEY = 'apik_test';
  process.env.WHOP_PARENT_COMPANY_ID = 'biz_test';
  process.env.WHOP_V1_WEBHOOK_SECRET = TEST_SECRET;
  ({ POST } = await import('@/app/api/whop/webhook/v1/route'));
});

beforeEach(() => {
  process.env.WHOP_COMPANY_API_KEY = 'apik_test';
  process.env.WHOP_PARENT_COMPANY_ID = 'biz_test';
  process.env.WHOP_V1_WEBHOOK_SECRET = TEST_SECRET;
  delete process.env.WHOP_V1_WEBHOOK_SECRET_CHILD;

  mocks.findUnique.mockResolvedValue(null);
  mocks.update.mockResolvedValue(fakePractitioner());
  mocks.upsert.mockResolvedValue({ id: 'evt_row_1' });
  mocks.eventUpdate.mockResolvedValue(undefined);
  mocks.indexPractitioner.mockResolvedValue(undefined);
  mocks.settingFindMany.mockResolvedValue([{ key: 'lead_attribution_term_months', value: '8' }]);
  mocks.attributedUpsert.mockResolvedValue(undefined);
  mocks.attributedUpdateMany.mockResolvedValue({ count: 1 });
  mocks.attributedFindUnique.mockResolvedValue(null);
  mocks.feeSnapshotFindUnique.mockResolvedValue(null);
  mocks.referralLedgerUpsert.mockResolvedValue(undefined);
  mocks.feeLedgerUpsert.mockResolvedValue(undefined);
  mocks.touchUpdateMany.mockResolvedValue({ count: 1 });
  mocks.touchFindUnique.mockResolvedValue(null);
  mocks.clientListUpsert.mockResolvedValue(undefined);
});

describe('signature verification & configuration', () => {
  it('accepts a validly signed, recognized event', async () => {
    const req = signedRequest({ type: 'payment.succeeded', data: { id: 'pay_1' } });
    const res = await POST(req as unknown as NextRequest);
    expect(res.status).toBe(200);
  });

  it('rejects a forged signature and never touches the database', async () => {
    const req = signedRequest(
      { type: 'identity_profile.approved', data: { metadata: { practitioner_id: 'prac_1' } } },
      { secret: 'ws_totally_wrong_secret_0000000000000000000000000000' },
    );
    const res = await POST(req as unknown as NextRequest);
    expect(res.status).toBe(401);
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when no webhook secret is configured', async () => {
    delete process.env.WHOP_V1_WEBHOOK_SECRET;
    delete process.env.WHOP_V1_WEBHOOK_SECRET_CHILD;
    const req = signedRequest({ type: 'payment.succeeded', data: { id: 'pay_1' } });
    const res = await POST(req as unknown as NextRequest);
    expect(res.status).toBe(503);
  });

  it('accepts a delivery signed with the CHILD secret when it is the only one configured', async () => {
    // The platform needs two registrations (child_resource_events is exclusive, not additive),
    // each with its own signing secret, and both post to this same route.
    delete process.env.WHOP_V1_WEBHOOK_SECRET;
    process.env.WHOP_V1_WEBHOOK_SECRET_CHILD = CHILD_SECRET;
    const req = signedRequest({ type: 'payment.succeeded', data: { id: 'pay_2' } }, { secret: CHILD_SECRET });
    const res = await POST(req as unknown as NextRequest);
    expect(res.status).toBe(200);
  });
});

describe('payout state transitions', () => {
  beforeEach(() => {
    mocks.findUnique.mockImplementation(async ({ where }) =>
      where.id === 'prac_1' ? fakePractitioner({ id: 'prac_1' }) : null,
    );
  });

  it('identity_profile.approved enables payouts, marks connected, and reindexes', async () => {
    const req = signedRequest({
      type: 'identity_profile.approved',
      data: { metadata: { practitioner_id: 'prac_1' } },
    });
    const res = await POST(req as unknown as NextRequest);
    expect(res.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: 'prac_1' },
      data: expect.objectContaining({
        whopPayoutsEnabled: true,
        whopPayoutStatus: 'connected',
        whopKycStatus: 'VERIFIED', // legacy mirror, kept one release for expand/contract
      }),
    });
    expect(mocks.indexPractitioner).toHaveBeenCalledWith('prac_1');
  });

  it('identity_profile.rejected disables payouts and marks verification_failed', async () => {
    const req = signedRequest({
      type: 'identity_profile.rejected',
      data: { metadata: { practitioner_id: 'prac_1' } },
    });
    const res = await POST(req as unknown as NextRequest);
    expect(res.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: 'prac_1' },
      data: {
        whopPayoutsEnabled: false,
        whopPayoutStatus: 'verification_failed',
        whopKycStatus: 'REJECTED',
      },
    });
  });

  it('identity_profile.needs_action disables payouts and marks action_required', async () => {
    const req = signedRequest({
      type: 'identity_profile.needs_action',
      data: { metadata: { practitioner_id: 'prac_1' } },
    });
    const res = await POST(req as unknown as NextRequest);
    expect(res.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: 'prac_1' },
      data: {
        whopPayoutsEnabled: false,
        whopPayoutStatus: 'action_required',
        whopKycStatus: 'PENDING',
      },
    });
  });

  it('persists an unrecognised payout_account status verbatim without throwing', async () => {
    // whopPayoutStatus is a String column, not a DB enum, precisely so a value Whop invents
    // after this code ships can't throw inside the handler and poison the retry.
    const req = signedRequest({
      type: 'payout_account.status_updated',
      data: { metadata: { practitioner_id: 'prac_1' }, status: 'some_future_status' },
    });
    const res = await POST(req as unknown as NextRequest);
    expect(res.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith({
      where: { id: 'prac_1' },
      data: { whopPayoutStatus: 'some_future_status' },
    });
  });
});

describe('practitioner resolution', () => {
  it('resolves via data.metadata.practitioner_id even when a company id is also present', async () => {
    mocks.findUnique.mockResolvedValueOnce(fakePractitioner({ id: 'prac_meta' }));
    const req = signedRequest({
      type: 'identity_profile.approved',
      data: { metadata: { practitioner_id: 'prac_meta' }, company: { id: 'biz_other' } },
    });
    const res = await POST(req as unknown as NextRequest);
    expect(res.status).toBe(200);
    expect(mocks.findUnique).toHaveBeenCalledTimes(1);
    expect(mocks.findUnique).toHaveBeenCalledWith({ where: { id: 'prac_meta' } });
  });

  it('falls back to data.company.id when metadata is absent', async () => {
    mocks.findUnique.mockImplementation(async ({ where }) =>
      where.whopCompanyId === 'biz_abc' ? fakePractitioner({ id: 'prac_by_company' }) : null,
    );
    const req = signedRequest({ type: 'identity_profile.approved', data: { company: { id: 'biz_abc' } } });
    const res = await POST(req as unknown as NextRequest);
    expect(res.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'prac_by_company' } }));
  });

  it('falls back to data.company_id when metadata is absent', async () => {
    mocks.findUnique.mockImplementation(async ({ where }) =>
      where.whopCompanyId === 'biz_abc' ? fakePractitioner({ id: 'prac_by_company' }) : null,
    );
    const req = signedRequest({ type: 'identity_profile.approved', data: { company_id: 'biz_abc' } });
    const res = await POST(req as unknown as NextRequest);
    expect(res.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'prac_by_company' } }));
  });

  it('falls back to data.account_id when metadata is absent (identity_profile payloads may carry only this)', async () => {
    mocks.findUnique.mockImplementation(async ({ where }) =>
      where.whopCompanyId === 'biz_abc' ? fakePractitioner({ id: 'prac_by_company' }) : null,
    );
    const req = signedRequest({ type: 'identity_profile.approved', data: { account_id: 'biz_abc' } });
    const res = await POST(req as unknown as NextRequest);
    expect(res.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'prac_by_company' } }));
  });

  it('acks with 200 and records the event when the practitioner cannot be resolved', async () => {
    const req = signedRequest({ type: 'identity_profile.approved', data: {} });
    const res = await POST(req as unknown as NextRequest);
    expect(res.status).toBe(200);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
  });
});

describe('delivery semantics (money-safety)', () => {
  it('dedupes on the webhook-id header, not a synthesised type:id composite', async () => {
    const body = JSON.stringify({ type: 'payment.succeeded', data: { id: 'pay_dup' } });
    const headers = signWebhook(body, { id: 'msg_dup_1' });
    const req1 = new Request('https://naturalhealthpros.com/api/whop/webhook/v1', { method: 'POST', headers, body });
    const req2 = new Request('https://naturalhealthpros.com/api/whop/webhook/v1', { method: 'POST', headers, body });

    await POST(req1 as unknown as NextRequest);
    await POST(req2 as unknown as NextRequest);

    expect(mocks.upsert).toHaveBeenCalledTimes(2);
    for (const call of mocks.upsert.mock.calls) {
      expect(call[0].where).toEqual({ whopEventId: 'msg_dup_1' });
    }
  });

  it('returns 2xx even when the handler throws, so a DB hiccup never drops the event', async () => {
    // Whop retries only 3x over ~70s then drops the delivery for good — a 5xx here is a
    // permanent, silent loss of a real payout-state change, not a retryable delay.
    mocks.findUnique.mockResolvedValueOnce(fakePractitioner({ id: 'prac_1' }));
    mocks.update.mockRejectedValueOnce(new Error('db unavailable'));
    const req = signedRequest({
      type: 'identity_profile.approved',
      data: { metadata: { practitioner_id: 'prac_1' } },
    });
    const res = await POST(req as unknown as NextRequest);
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
  });

  it('acknowledges an unknown event type without mutating state', async () => {
    const req = signedRequest({ type: 'some.unrecognised.event', data: { id: 'x' } });
    const res = await POST(req as unknown as NextRequest);
    expect(res.status).toBe(200);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

/**
 * Regression: these are VERBATIM payloads captured from production deliveries for Sarah
 * Schindler's connected company (biz_xExE1eUWG4ZMeR, 2026-08-11). Every pre-existing fixture in
 * this file invents a company reference INSIDE `data`; Whop actually puts `company_id` on the
 * ENVELOPE, as a sibling of `data`/`type`. Because handleEvent() was called with only `data`,
 * resolution returned null and every one of these events silently no-opped — logged, marked
 * processedAt, error null, practitioner row untouched. Sarah stayed on "not_started" and kept
 * being sent back through a KYC flow she had already passed.
 */
describe('envelope-level company_id (real production payload shape)', () => {
  const SARAH_CO = 'biz_xExE1eUWG4ZMeR';

  it('resolves identity_profile.approved from a THIN data payload via envelope company_id', async () => {
    mocks.findUnique.mockResolvedValueOnce(
      fakePractitioner({ id: 'prac_sarah', whopCompanyId: SARAH_CO }),
    );
    const req = signedRequest({
      id: 'msg_LqbB5y5u65IdO0gEOvwuaifs',
      type: 'identity_profile.approved',
      data: { id: 'idpf_L366QzEEVUnVH' },
      timestamp: '2026-08-11T17:25:25.114Z',
      company_id: SARAH_CO,
      api_version: 'v1',
    });
    const res = await POST(req as unknown as NextRequest);

    expect(res.status).toBe(200);
    expect(mocks.findUnique).toHaveBeenCalledWith({ where: { whopCompanyId: SARAH_CO } });
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'prac_sarah' } }),
    );
  });

  it('resolves payout_account.status_updated via envelope company_id and records the status', async () => {
    mocks.findUnique.mockResolvedValueOnce(
      fakePractitioner({ id: 'prac_sarah', whopCompanyId: SARAH_CO }),
    );
    const req = signedRequest({
      id: 'msg_ffKfNrMY8Gy33f2w5avqsHq4',
      type: 'payout_account.status_updated',
      // Note: this payload has a FAT data object, but still carries no company reference
      // anywhere inside it — so this event type has never once resolved in production.
      data: {
        id: 'poact_SeAGBkatzxjJ',
        email: 'sarah@wild-rooted.com',
        status: 'connected',
        latest_verification: { id: 'verf_48hAxWVQSjOhf', status: 'approved' },
      },
      timestamp: '2026-08-11T17:25:35.441Z',
      company_id: SARAH_CO,
      api_version: 'v1',
    });
    const res = await POST(req as unknown as NextRequest);

    expect(res.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'prac_sarah' },
        data: expect.objectContaining({ whopPayoutStatus: 'connected' }),
      }),
    );
  });

  it('prefers the envelope company_id over a linked_companies[0] guess', async () => {
    // linked_companies is an ARRAY and reads back EMPTY for API-key callers (verified against
    // /identity_profiles live, 2026-08-13). Guessing [0] can attribute an event to the wrong
    // practitioner; the envelope names the company Whop is actually notifying about.
    mocks.findUnique.mockResolvedValueOnce(
      fakePractitioner({ id: 'prac_sarah', whopCompanyId: SARAH_CO }),
    );
    const req = signedRequest({
      type: 'identity_profile.approved',
      data: { id: 'idpf_x', linked_companies: [{ id: 'biz_SOMEONE_ELSE' }] },
      company_id: SARAH_CO,
    });
    await POST(req as unknown as NextRequest);

    expect(mocks.findUnique).toHaveBeenCalledWith({ where: { whopCompanyId: SARAH_CO } });
  });
});

/**
 * Reconciliation can only poll a practitioner it has Whop ids for, and the webhook is the only
 * place those ids can be learned: the REST list endpoints return the profiles, but
 * linked_companies reads back empty for parent-company API keys, so a listed profile cannot be
 * attributed to one of our practitioners. Drop the id here and the cron is permanently blind.
 */
describe('captures Whop resource ids for reconciliation', () => {
  it('stores the idpf_ id off identity_profile.approved', async () => {
    mocks.findUnique.mockResolvedValueOnce(
      fakePractitioner({ id: 'prac_s', whopCompanyId: 'biz_s', whopIdentityProfileId: null }),
    );
    const req = signedRequest({
      type: 'identity_profile.approved',
      data: { id: 'idpf_L366QzEEVUnVH' },
      company_id: 'biz_s',
    });
    await POST(req as unknown as NextRequest);

    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ whopIdentityProfileId: 'idpf_L366QzEEVUnVH' }),
      }),
    );
  });

  it('stores the poact_ id off payout_account.status_updated', async () => {
    mocks.findUnique.mockResolvedValueOnce(
      fakePractitioner({ id: 'prac_s', whopCompanyId: 'biz_s', whopPayoutAccountId: null }),
    );
    const req = signedRequest({
      type: 'payout_account.status_updated',
      data: { id: 'poact_SeAGBkatzxjJ', status: 'connected' },
      company_id: 'biz_s',
    });
    await POST(req as unknown as NextRequest);

    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ whopPayoutAccountId: 'poact_SeAGBkatzxjJ' }),
      }),
    );
  });

  it('does not confuse the two id types', async () => {
    mocks.findUnique.mockResolvedValueOnce(
      fakePractitioner({ id: 'prac_s', whopCompanyId: 'biz_s' }),
    );
    const req = signedRequest({
      type: 'identity_profile.approved',
      data: { id: 'idpf_abc' },
      company_id: 'biz_s',
    });
    await POST(req as unknown as NextRequest);

    const data = mocks.update.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.whopIdentityProfileId).toBe('idpf_abc');
    expect(data.whopPayoutAccountId).toBeUndefined();
  });
});

describe('unattributable events must not look healthy', () => {
  it('records an error on the audit row when no practitioner resolves', async () => {
    mocks.findUnique.mockResolvedValue(null); // nothing matches this company
    const req = signedRequest({
      type: 'identity_profile.approved',
      data: { id: 'idpf_orphan' },
      company_id: 'biz_unknown_to_us',
    });
    await POST(req as unknown as NextRequest);

    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.eventUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          processedAt: expect.any(Date),
          error: expect.stringContaining('biz_unknown_to_us'),
        }),
      }),
    );
  });

  it('leaves error null when the handler actually applied a change', async () => {
    mocks.findUnique.mockResolvedValueOnce(
      fakePractitioner({ id: 'prac_ok', whopCompanyId: 'biz_ok' }),
    );
    const req = signedRequest({
      type: 'identity_profile.approved',
      data: { id: 'idpf_ok' },
      company_id: 'biz_ok',
    });
    await POST(req as unknown as NextRequest);

    expect(mocks.eventUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ error: null }) }),
    );
  });
});

describe('payment.succeeded — the AUTHORITY for payment (§17.3c)', () => {
  // Until this existed the handler returned null and the ONLY writer of PAID was a public
  // unauthenticated server action taking the two values printed in the booking URL. Three
  // docstrings claimed "the webhook is the authority" while it was an explicit no-op.
  // The payer MUST resolve here. An earlier version of this block left the default
  // `findUnique -> null` in place, so resolvePractitioner returned null, the ownership check was
  // skipped in every single test, and the whole describe passed identically whether that check
  // worked or was deleted. A stub weaker than production asserts nothing.
  beforeEach(() => {
    mocks.intentUpdateMany.mockResolvedValue({ count: 1 });
    // `email` is NOT NULL in the schema, so omitting it here would be a fixture that production
    // cannot produce — and it would make the ledger commit throw on every test in this block,
    // hiding real assertions behind a manufactured failure.
    mocks.intentFindUnique.mockResolvedValue({
      id: 'int_1',
      practitionerId: 'prac_1',
      paidAt: null,
      email: 'client@example.com',
      scheduledAt: null,
      referralTouchId: null,
    });
    mocks.findUnique.mockResolvedValue(fakePractitioner({ id: 'prac_1', whopCompanyId: 'biz_1' }));
  });

  function errorRecorded(fragment: string): boolean {
    return mocks.eventUpdate.mock.calls.some((c) => JSON.stringify(c[0]).includes(fragment));
  }

  it('marks the intent PAID from the session metadata', async () => {
    const res = await POST(
      signedRequest({
        type: 'payment.succeeded',
        data: { id: 'pay_1', metadata: { booking_intent_id: 'int_1' } },
        company_id: 'biz_1',
      }) as unknown as NextRequest,
    );
    expect(res.status).toBe(200);
    const args = mocks.intentUpdateMany.mock.calls[0]![0] as {
      where: { id: string; paidAt: null };
      data: { status: string };
    };
    expect(args.where.id).toBe('int_1');
    expect(args.data.status).toBe('PAID');
    // paidAt: null is the IDEMPOTENCY guard — Whop retries 3x over ~70s.
    expect(args.where.paidAt).toBeNull();
  });

  it.each([
    ['checkout_session', { checkout_session: { metadata: { booking_intent_id: 'int_2' } } }],
    ['membership', { membership: { metadata: { booking_intent_id: 'int_2' } } }],
  ])('finds the id nested under %s — a miss here fails SILENTLY', async (_where, data) => {
    await POST(
      signedRequest({
        type: 'payment.succeeded',
        data: { id: 'pay_1', ...data },
        company_id: 'biz_1',
      }) as unknown as NextRequest,
    );
    const args = mocks.intentUpdateMany.mock.calls[0]![0] as { where: { id: string } };
    expect(args.where.id).toBe('int_2');
  });

  it('ignores a payment with no booking intent — Layer X subscriptions legitimately have none', async () => {
    const res = await POST(
      signedRequest({
        type: 'payment.succeeded',
        data: { id: 'pay_1' },
        company_id: 'biz_1',
      }) as unknown as NextRequest,
    );
    expect(res.status).toBe(200);
    expect(mocks.intentUpdateMany).not.toHaveBeenCalled();
    expect(errorRecorded('attributable to no booking')).toBe(false);
  });

  // The §8 hosted-checkout fallback is minted from the offering's checkout CONFIGURATION, whose
  // metadata carries practitioner_id and offering_id but never booking_intent_id. So a real buyer
  // can pay for real and reconcile to nothing. `offering_id` is what tells this apart from a
  // Layer X subscription — without the distinction the row shows healthy green with error null,
  // which is the exact silent failure `unresolved()` exists to prevent, on the event that moves
  // the most money.
  it('reports a Layer Y payment that carried no booking_intent_id — it is NOT a benign Layer X row', async () => {
    const res = await POST(
      signedRequest({
        type: 'payment.succeeded',
        data: { id: 'pay_1', metadata: { offering_id: 'off_1', practitioner_id: 'prac_1' } },
        company_id: 'biz_1',
      }) as unknown as NextRequest,
    );
    expect(res.status).toBe(200);
    expect(mocks.intentUpdateMany).not.toHaveBeenCalled();
    expect(errorRecorded('attributable to no booking')).toBe(true);
  });

  // booking_intent_id is attacker-chosen metadata on a checkout session, and intent ids are
  // timestamp-prefixed cuids. Without this check a connected practitioner could pay $1 against a
  // rival's intent id, flip it to PAID, and permanently dead-end that buyer (the flow's settled
  // branch gates the whole render) while the real practitioner never collects.
  it('REFUSES to mark PAID when the paying company is not the intent’s practitioner', async () => {
    mocks.findUnique.mockResolvedValue(fakePractitioner({ id: 'prac_ATTACKER', whopCompanyId: 'biz_evil' }));
    const res = await POST(
      signedRequest({
        type: 'payment.succeeded',
        data: { id: 'pay_1', metadata: { booking_intent_id: 'int_1' } },
        company_id: 'biz_evil',
      }) as unknown as NextRequest,
    );
    expect(res.status).toBe(200);
    expect(mocks.intentUpdateMany).not.toHaveBeenCalled();
    expect(errorRecorded('belongs to a different practitioner')).toBe(true);
  });

  // Deliberate, and the reason the check is conditional: this guard must never become a way to
  // DROP a real payment. An event we cannot attribute to any company is passed through and paid.
  it('still records payment when the payer cannot be resolved at all', async () => {
    mocks.findUnique.mockResolvedValue(null);
    await POST(
      signedRequest({
        type: 'payment.succeeded',
        data: { id: 'pay_1', metadata: { booking_intent_id: 'int_1' } },
        company_id: 'biz_unknown',
      }) as unknown as NextRequest,
    );
    expect(mocks.intentUpdateMany).toHaveBeenCalled();
  });

  it('reports LOUDLY when money moved against an intent we do not have', async () => {
    mocks.intentFindUnique.mockResolvedValue(null);
    await POST(
      signedRequest({
        type: 'payment.succeeded',
        data: { id: 'pay_1', metadata: { booking_intent_id: 'ghost' } },
        company_id: 'biz_1',
      }) as unknown as NextRequest,
    );
    expect(mocks.intentUpdateMany).not.toHaveBeenCalled();
    // Recorded on the audit row's `error` column rather than swallowed.
    expect(errorRecorded('unknown booking intent')).toBe(true);
  });

  it('does NOT re-record an already-paid intent (a Whop retry is expected, not an error)', async () => {
    mocks.intentUpdateMany.mockResolvedValue({ count: 0 });
    const res = await POST(
      signedRequest({
        type: 'payment.succeeded',
        data: { id: 'pay_1', metadata: { booking_intent_id: 'int_1' } },
        company_id: 'biz_1',
      }) as unknown as NextRequest,
    );
    expect(res.status).toBe(200);
    expect(errorRecorded('unknown booking intent')).toBe(false);
  });
});

describe('payment.succeeded — the attribution term is ANCHORED, once, and always starts', () => {
  beforeEach(() => {
    mocks.intentUpdateMany.mockResolvedValue({ count: 1 });
    mocks.findUnique.mockResolvedValue(fakePractitioner({ id: 'prac_1', whopCompanyId: 'biz_1' }));
  });

  function paid(intent: { scheduledAt: Date | null }) {
    mocks.intentFindUnique.mockResolvedValue({
      id: 'int_1',
      practitionerId: 'prac_1',
      paidAt: null,
      email: 'client@example.com',
      scheduledAt: intent.scheduledAt,
    });
    return POST(
      signedRequest({
        type: 'payment.succeeded',
        data: { id: 'pay_1', metadata: { booking_intent_id: 'int_1' } },
        company_id: 'biz_1',
      }) as unknown as NextRequest,
    );
  }

  function createArgs(): Record<string, unknown> {
    const call = mocks.attributedUpsert.mock.calls[0]?.[0] as { create: Record<string, unknown> };
    return call.create;
  }

  it('anchors on the SCHEDULED session start, not on the payment', async () => {
    // A January payment for a March session is attributed from March. Anchoring at payment would
    // shorten every term by the booking lead time.
    const session = new Date('2026-03-10T15:00:00Z');
    await paid({ scheduledAt: session });
    const create = createArgs();
    expect((create.termAnchorAt as Date).toISOString()).toBe('2026-03-10T15:00:00.000Z');
    expect((create.termEndsAt as Date).toISOString()).toBe('2026-11-10T15:00:00.000Z');
    expect(create.termMonths).toBe(8);
  });

  it('STILL starts the clock when no session was ever scheduled', async () => {
    // ⚠️ THE REGRESSION THIS EXISTS FOR. Falling back to a null anchor leaves the row
    // PENDING_ANCHOR, which is chargeable and has no end date — and nothing ever back-fills it,
    // because `sessionStartsAt` is only supplied on this once-per-intent transition. A null anchor
    // therefore does not mean "the clock has not started yet", it means the clock NEVER starts and
    // the client is charged the platform share forever. It would have hit every practitioner with
    // no scheduler link, where `scheduledAt` is always null.
    await paid({ scheduledAt: null });
    const create = createArgs();
    expect(create.termAnchorAt).toBeInstanceOf(Date);
    expect(create.termEndsAt).toBeInstanceOf(Date);
    const ends = (create.termEndsAt as Date).getTime();
    const anchor = (create.termAnchorAt as Date).getTime();
    expect(ends).toBeGreaterThan(anchor);
  });

  it('reads the term from the admin setting, not from a literal', async () => {
    mocks.settingFindMany.mockResolvedValue([{ key: 'lead_attribution_term_months', value: '6' }]);
    await paid({ scheduledAt: new Date('2026-03-10T00:00:00Z') });
    const create = createArgs();
    expect(create.termMonths).toBe(6);
    expect((create.termEndsAt as Date).toISOString()).toBe('2026-09-10T00:00:00.000Z');
  });

  it('records a FAILED ledger write on the event row instead of swallowing it', async () => {
    // The handler must still ack (Whop retries 3x then drops the event, and the PAID transition is
    // the one thing here that cannot be reconstructed) — but a silent failure here now means the
    // client is billed forever, so it has to reach /admin/whop-webhooks.
    mocks.attributedUpsert.mockRejectedValue(new Error('ledger offline'));
    const res = await paid({ scheduledAt: new Date('2026-03-10T00:00:00Z') });
    expect(res.status).toBe(200);
    const recorded = mocks.eventUpdate.mock.calls.some((c) =>
      JSON.stringify(c[0]).includes('ledger write FAILED'),
    );
    expect(recorded).toBe(true);
    // The payment itself still landed.
    expect(mocks.intentUpdateMany).toHaveBeenCalled();
  });

  it('RE-RUNS the ledger commit on a redelivery, because skipping it made a lost write permanent', async () => {
    // ⚠️ DELIBERATE REVERSAL of the previous behaviour, which skipped the whole ledger block
    // whenever the intent was already paid. That made a transient failure PERMANENT: the retry
    // found `paidAt` set, counted zero, wrote nothing, and the client was then billed the platform
    // share forever with nothing recording why. Idempotence now lives in the database — every
    // write below is an upsert on a unique key — so re-running is safe and skipping is not.
    mocks.intentUpdateMany.mockResolvedValue({ count: 0 });
    mocks.intentFindUnique.mockResolvedValue({
      id: 'int_1',
      practitionerId: 'prac_1',
      paidAt: new Date('2026-02-01T00:00:00Z'),
      email: 'client@example.com',
      scheduledAt: null,
      referralTouchId: null,
    });

    await POST(
      signedRequest({
        type: 'payment.succeeded',
        data: { id: 'pay_1', metadata: { booking_intent_id: 'int_1' } },
        company_id: 'biz_1',
      }) as unknown as NextRequest,
    );

    expect(mocks.attributedUpsert).toHaveBeenCalled();
  });

  it('anchors a redelivery on the intent’s STORED paidAt, so a retry cannot move a running clock', async () => {
    mocks.intentUpdateMany.mockResolvedValue({ count: 0 });
    mocks.intentFindUnique.mockResolvedValue({
      id: 'int_1',
      practitionerId: 'prac_1',
      paidAt: new Date('2026-02-01T00:00:00Z'),
      email: 'client@example.com',
      scheduledAt: null,
      referralTouchId: null,
    });

    await POST(
      signedRequest({
        type: 'payment.succeeded',
        data: { id: 'pay_1', metadata: { booking_intent_id: 'int_1' } },
        company_id: 'biz_1',
      }) as unknown as NextRequest,
    );

    const create = createArgs();
    expect((create.termAnchorAt as Date).toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });
});

describe('payment.succeeded — the referral ledger (stage 3)', () => {
  beforeEach(() => {
    mocks.intentUpdateMany.mockResolvedValue({ count: 1 });
    mocks.findUnique.mockResolvedValue(fakePractitioner({ id: 'prac_1', whopCompanyId: 'biz_1' }));
    mocks.intentFindUnique.mockResolvedValue({
      id: 'int_1',
      practitionerId: 'prac_1',
      paidAt: null,
      email: 'client@example.com',
      scheduledAt: new Date('2026-03-10T00:00:00Z'),
      referralTouchId: 'touch_1',
    });
  });

  function deliver() {
    return POST(
      signedRequest({
        type: 'payment.succeeded',
        data: { id: 'pay_1', metadata: { booking_intent_id: 'int_1' } },
        company_id: 'biz_1',
      }) as unknown as NextRequest,
    );
  }

  it('turns the mint-time snapshot into a referrer debt, keyed so a redelivery cannot duplicate it', async () => {
    mocks.feeSnapshotFindUnique.mockResolvedValue({
      attributionOwner: 'NHP',
      isCrossReferral: true,
      priceUsdCents: 10_000,
      nhpFeeUsdCents: 2_000,
      referrerFeeBps: 2_000,
      referrerShareUsdCents: 2_000,
      referrerPractitionerId: 'prac_X',
      applicationFeeUsdCents: 4_000,
    });
    // ⚠️ The payer check and the referrer lookup BOTH go through practitioner.findUnique, so this
    // has to dispatch on the id. Returning the referrer unconditionally makes the payer check see
    // a company that is not the intent's practitioner, and the handler then REFUSES the payment —
    // a green-looking test that exercised none of the ledger.
    mocks.findUnique.mockImplementation(async (args) => {
      const id = (args as { where?: { id?: string } })?.where?.id;
      if (id === 'prac_X') {
        return fakePractitioner({ id: 'prac_X', whopCompanyId: 'biz_x', whopPayoutsEnabled: true });
      }
      return fakePractitioner({ id: 'prac_1', whopCompanyId: 'biz_1' });
    });

    await deliver();

    const args = mocks.referralLedgerUpsert.mock.calls[0]?.[0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(args.create).toMatchObject({
      referrerPractitionerId: 'prac_X',
      servingPractitionerId: 'prac_1',
      referrerShareUsdCents: 2_000,
      collectedFeeUsdCents: 4_000,
      state: 'PAYABLE',
      whopPaymentId: 'pay_1',
    });
    // CREATE-ONLY on conflict: a redelivery must not reset a hold clock or un-settle a paid row.
    expect(args.update).toEqual({});
  });

  it('records the application fee even when no referrer is involved', async () => {
    mocks.feeSnapshotFindUnique.mockResolvedValue({
      attributionOwner: 'NHP',
      isCrossReferral: false,
      priceUsdCents: 10_000,
      nhpFeeUsdCents: 4_000,
      referrerFeeBps: 0,
      referrerShareUsdCents: 0,
      referrerPractitionerId: null,
      applicationFeeUsdCents: 4_000,
    });

    await deliver();

    expect(mocks.referralLedgerUpsert).not.toHaveBeenCalled();
    const args = mocks.feeLedgerUpsert.mock.calls[0]?.[0] as { create: Record<string, unknown> };
    expect(args.create).toMatchObject({ kind: 'APPLICATION_FEE', amountUsdCents: 4_000 });
  });

  it('still records the claim when the hosted-checkout fallback left no snapshot', async () => {
    // Reachable, not hypothetical: the §8 fallback mints no per-booking configuration. Skipping
    // the claim here would mean the term never starts for that client.
    mocks.feeSnapshotFindUnique.mockResolvedValue(null);

    await deliver();

    expect(mocks.attributedUpsert).toHaveBeenCalled();
    expect(mocks.referralLedgerUpsert).not.toHaveBeenCalled();
  });
});
