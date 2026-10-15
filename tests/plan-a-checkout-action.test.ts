import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The edit page's Plan A server actions, against mocked I/O: each interval sells its own plan id
 * from PlatformSetting, an ACTIVE subscriber is never sold a second one, and choosing Plan A lands
 * on the billing card.
 */
const m = vi.hoisted(() => ({
  session: { user: { id: 'usr_owner', role: 'PRACTITIONER' } } as unknown,
  status: 'NONE',
  createSubscriptionCheckout: vi.fn(),
  update: vi.fn(),
}));

class Redirect extends Error {
  constructor(public url: string) {
    super(url);
  }
}
vi.mock('next/navigation', () => ({
  redirect: (u: string) => {
    throw new Redirect(u);
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({}));
vi.mock('@/auth', () => ({ auth: async () => m.session }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    practitioner: {
      findUnique: vi.fn(async (a: { where: { slug?: string; id?: string } }) =>
        a.where.slug ? { id: 'prac_1', userId: 'usr_owner' } : { subscriptionStatus: m.status },
      ),
      update: m.update,
    },
    platformSetting: {
      findMany: vi.fn(async () => [
        { key: 'whop_plan_a_monthly_plan_id', value: 'plan_month' },
        { key: 'whop_plan_a_annual_plan_id', value: 'plan_year' },
      ]),
    },
  },
}));
vi.mock('@/lib/whop', () => ({
  WHOP_OFFERING_TITLE_MAX: 80,
  createSubscriptionCheckout: m.createSubscriptionCheckout,
}));
vi.mock('@/lib/typesense-server', () => ({ TYPESENSE_COLLECTION: 'practitioners', getTypesenseAdmin: vi.fn() }));
vi.mock('@/lib/practitioner-indexer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/practitioner-indexer')>()),
  indexPractitioner: vi.fn(),
}));
vi.mock('@/lib/typesense-synonyms', () => ({ syncSpecialtySynonyms: vi.fn() }));
vi.mock('@/lib/onboarding-draft', () => ({ draftProfile: vi.fn() }));
vi.mock('@/lib/email', () => ({ sendEmail: vi.fn(), normalizeEmail: (s: string) => s, escapeHtml: (s: string) => s }));
vi.mock('@/lib/rate-limit', () => ({ rateLimit: vi.fn() }));
vi.mock('@/lib/client-list', () => ({ addClientEntries: vi.fn() }));
vi.mock('@/lib/referrals', () => ({ createEmailReferral: vi.fn(), createReferralLink: vi.fn(), referralUrl: vi.fn() }));

import { choosePlan, startSubscriptionCheckout } from '@/app/practitioners/[slug]/edit/actions';

async function redirectOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Redirect) return e.url;
    throw e;
  }
  throw new Error('expected a redirect');
}

beforeEach(() => {
  vi.clearAllMocks();
  m.session = { user: { id: 'usr_owner', role: 'PRACTITIONER' } };
  m.status = 'NONE';
  m.createSubscriptionCheckout.mockImplementation(async (p: { planId: string }) => ({
    checkoutConfigId: 'ch_1',
    purchaseUrl: `https://whop.com/checkout/${p.planId}`,
  }));
});

describe('startSubscriptionCheckout', () => {
  it.each([
    ['monthly', 'plan_month'],
    ['annual', 'plan_year'],
  ])('sells the %s plan id from PlatformSetting', async (interval, planId) => {
    expect(await redirectOf(startSubscriptionCheckout('sarah', interval))).toBe(`https://whop.com/checkout/${planId}`);
    expect(m.createSubscriptionCheckout).toHaveBeenCalledWith({
      practitionerId: 'prac_1',
      slug: 'sarah',
      interval,
      planId,
    });
  });

  it('refuses an unknown interval without minting anything', async () => {
    expect(await redirectOf(startSubscriptionCheckout('sarah', 'weekly'))).toBe(
      '/practitioners/sarah/edit?subscription=error#billing',
    );
    expect(m.createSubscriptionCheckout).not.toHaveBeenCalled();
  });

  it('never sells an ACTIVE subscriber a second subscription', async () => {
    m.status = 'ACTIVE';
    expect(await redirectOf(startSubscriptionCheckout('sarah', 'annual'))).toBe('/practitioners/sarah/edit#billing');
    expect(m.createSubscriptionCheckout).not.toHaveBeenCalled();
  });

  it('reports a failed mint on the billing card', async () => {
    m.createSubscriptionCheckout.mockRejectedValueOnce(new Error('scope'));
    expect(await redirectOf(startSubscriptionCheckout('sarah', 'monthly'))).toBe(
      '/practitioners/sarah/edit?subscription=error#billing',
    );
  });

  it('refuses a signed-in stranger', async () => {
    m.session = { user: { id: 'usr_other', role: 'PRACTITIONER' } };
    expect(await redirectOf(startSubscriptionCheckout('sarah', 'monthly'))).toBe('/auth/error?error=AccessDenied');
    expect(m.createSubscriptionCheckout).not.toHaveBeenCalled();
  });
});

describe('choosePlan', () => {
  const form = (plan: string) => {
    const f = new FormData();
    f.set('plan', plan);
    return f;
  };

  it('Plan A lands on the billing card; Plan B goes on to client payments', async () => {
    expect(await redirectOf(choosePlan('sarah', form('PLAN_A')))).toBe('/practitioners/sarah/edit?plan=saved#billing');
    expect(await redirectOf(choosePlan('sarah', form('PLAN_B')))).toBe('/practitioners/sarah/edit?plan=saved#payments');
  });
});
