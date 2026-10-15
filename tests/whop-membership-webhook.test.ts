import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Layer X webhook (`/api/whop/webhook`): a membership on EITHER Plan A plan activates the
 * practitioner's listing subscription, and the plan id records which interval was bought.
 */
const payload = vi.hoisted(() => ({ current: {} as unknown }));
const db = vi.hoisted(() => ({
  whopWebhookEvent: { upsert: vi.fn(), update: vi.fn() },
  practitioner: { findUnique: vi.fn(), update: vi.fn() },
  user: { findUnique: vi.fn() },
  platformSetting: { findMany: vi.fn() },
}));

vi.mock('@whop/api', () => ({ makeWebhookValidator: () => async () => payload.current }));
vi.mock('@/lib/prisma', () => ({ prisma: db }));
vi.mock('@/lib/practitioner-indexer', () => ({ indexPractitioner: vi.fn(async () => undefined) }));

process.env.WHOP_WEBHOOK_SECRET = 'ws_test';
let POST: typeof import('@/app/api/whop/webhook/route').POST;
beforeAll(async () => {
  ({ POST } = await import('@/app/api/whop/webhook/route'));
});

const deliver = async (body: unknown) => {
  payload.current = body;
  const res = await POST(new Request('https://x.test/api/whop/webhook', { method: 'POST' }) as never);
  expect(res.status).toBe(200);
};

beforeEach(() => {
  vi.clearAllMocks();
  db.whopWebhookEvent.upsert.mockResolvedValue({ id: 'evt_1' });
  db.whopWebhookEvent.update.mockResolvedValue({});
  db.practitioner.findUnique.mockResolvedValue({ id: 'prac_1', whopMembershipId: null });
  db.practitioner.update.mockResolvedValue({});
  db.platformSetting.findMany.mockResolvedValue([
    { key: 'whop_plan_a_monthly_plan_id', value: 'plan_month' },
    { key: 'whop_plan_a_annual_plan_id', value: 'plan_year' },
  ]);
});

const went_valid = (plan: Record<string, unknown>, metadata: Record<string, string> = { practitioner_id: 'prac_1' }) => ({
  action: 'membership.went_valid',
  data: { id: 'mem_1', metadata, ...plan },
});

describe('Layer X membership webhook', () => {
  it.each([
    ['monthly', { plan: { id: 'plan_month' } }],
    ['annual', { plan: { id: 'plan_year' } }],
    ['annual', { plan_id: 'plan_year' }],
  ])('activates on the %s plan and records the interval', async (interval, plan) => {
    await deliver(went_valid(plan));
    expect(db.practitioner.update).toHaveBeenCalledWith({
      where: { id: 'prac_1' },
      data: { subscriptionStatus: 'ACTIVE', whopMembershipId: 'mem_1', subscriptionInterval: interval },
    });
  });

  it('falls back to the checkout metadata when the payload names no plan', async () => {
    await deliver(went_valid({}, { practitioner_id: 'prac_1', nhp_billing_interval: 'annual' }));
    expect(db.practitioner.update.mock.calls[0][0].data.subscriptionInterval).toBe('annual');
  });

  it('activates but leaves the interval alone for an unrecognised plan', async () => {
    await deliver(went_valid({ plan: { id: 'plan_other' } }, { practitioner_id: 'prac_1', nhp_billing_interval: 'weekly' }));
    expect(db.practitioner.update).toHaveBeenCalledWith({
      where: { id: 'prac_1' },
      data: { subscriptionStatus: 'ACTIVE', whopMembershipId: 'mem_1' },
    });
  });

  it('does not touch the interval when a membership lapses', async () => {
    await deliver({ action: 'membership.went_invalid', data: { id: 'mem_1', plan: { id: 'plan_year' }, metadata: { practitioner_id: 'prac_1' } } });
    expect(db.practitioner.update).toHaveBeenCalledWith({
      where: { id: 'prac_1' },
      data: { subscriptionStatus: 'PAST_DUE', whopMembershipId: 'mem_1' },
    });
    expect(db.platformSetting.findMany).not.toHaveBeenCalled();
  });
});
