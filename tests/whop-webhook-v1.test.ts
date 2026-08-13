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
