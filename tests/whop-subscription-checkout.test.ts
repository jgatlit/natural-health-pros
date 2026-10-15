import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSubscriptionCheckout } from '@/lib/whop';

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  process.env.WHOP_COMPANY_API_KEY = 'test-key';
  process.env.WHOP_PARENT_COMPANY_ID = 'biz_test';
});
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function mockFetch() {
  const spy = vi.fn(
    async () =>
      new Response(JSON.stringify({ id: 'ch_sub_1', purchase_url: 'https://whop.com/checkout/plan_y/?session=ch_sub_1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

describe('createSubscriptionCheckout', () => {
  it('mints a configuration for the given plan carrying practitioner_id and the interval', async () => {
    const spy = mockFetch();
    const out = await createSubscriptionCheckout({
      practitionerId: 'prac_1',
      slug: 'sarah',
      interval: 'annual',
      planId: 'plan_y',
    });
    expect(out).toEqual({ checkoutConfigId: 'ch_sub_1', purchaseUrl: 'https://whop.com/checkout/plan_y/?session=ch_sub_1' });
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.plan_id).toBe('plan_y');
    expect(body.metadata).toEqual({ practitioner_id: 'prac_1', nhp_billing_interval: 'annual' });
    expect(body.redirect_url).toMatch(/\/practitioners\/sarah\/edit\?subscription=success#billing$/);
  });

  it('refuses without a plan id and calls nothing', async () => {
    const spy = mockFetch();
    await expect(
      createSubscriptionCheckout({ practitionerId: 'prac_1', slug: 'sarah', interval: 'annual', planId: null }),
    ).rejects.toThrow(/annual Plan A/);
    expect(spy).not.toHaveBeenCalled();
  });
});
