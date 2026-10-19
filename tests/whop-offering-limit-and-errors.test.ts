import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WhopNotConfigured } from '@/lib/whop';
import { classifyWhopPublishError } from '@/lib/whop-errors';
import {
  WHOP_MAX_PAYMENT_CENTS,
  WHOP_OVER_LIMIT_MESSAGE,
  WHOP_PUBLISH_ERRORS,
  WHOP_PUBLISH_ERROR_CODES,
  isWhopPublishErrorCode,
} from '@/lib/whop-limits';

/**
 * tsk_eb9ee4d9 item 2. (a) A price over Whop's $2,500 ceiling is refused by the offering editor
 * and by Publish before any Whop call. (b) A Publish that Whop still refuses lands on a short
 * error code with a plain-language message, and the practitioner is emailed the same summary.
 * Whop and Resend are mocked: nothing here reaches either.
 */

const m = vi.hoisted(() => ({
  session: { user: { id: 'u_amy', role: 'PRACTITIONER' } } as unknown,
  offering: null as null | Record<string, unknown>,
  practitioner: { whopCompanyId: 'biz_amy', whopPayoutsEnabled: true } as Record<string, unknown>,
  creates: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  createOfferingCheckout: vi.fn(),
  sendEmail: vi.fn(),
  logged: [] as unknown[],
}));

vi.mock('@/auth', () => ({ auth: async () => m.session }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error(`REDIRECT:${url}`), { url });
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({}));
vi.mock('@/lib/whop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/whop')>()),
  createOfferingCheckout: m.createOfferingCheckout,
  createAccountLink: vi.fn(),
  createConnectedAccount: vi.fn(),
  createSubscriptionCheckout: vi.fn(),
}));
vi.mock('@/lib/typesense-server', () => ({ TYPESENSE_COLLECTION: 'practitioners', getTypesenseAdmin: vi.fn() }));
vi.mock('@/lib/practitioner-indexer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/practitioner-indexer')>()),
  indexPractitioner: vi.fn(async () => undefined),
}));
vi.mock('@/lib/typesense-synonyms', () => ({ syncSpecialtySynonyms: vi.fn() }));
vi.mock('@/lib/onboarding-draft', () => ({ draftProfile: vi.fn() }));
vi.mock('@/lib/email', () => ({
  sendEmail: m.sendEmail,
  normalizeEmail: (s: string) => s,
  escapeHtml: (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
}));
vi.mock('@/lib/rate-limit', () => ({ rateLimit: vi.fn() }));
vi.mock('@/lib/platform-settings', () => ({ loadSettings: vi.fn() }));
vi.mock('@/lib/client-list', () => ({ addClientEntries: vi.fn() }));
vi.mock('@/lib/referrals', () => ({ createEmailReferral: vi.fn(), createReferralLink: vi.fn(), referralUrl: vi.fn() }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    practitioner: {
      findUnique: async (a: { where: { slug?: string; id?: string } }) =>
        a.where.slug === 'amy' ? { id: 'p_amy', userId: 'u_amy' } : a.where.id === 'p_amy' ? m.practitioner : null,
    },
    user: { findUnique: async () => ({ email: 'amy@example.com' }) },
    bookingLink: { findFirst: async () => null },
    bookingIntent: { updateMany: async () => ({ count: 0 }) },
    whopProduct: {
      findFirst: async () => m.offering,
      create: async (a: { data: Record<string, unknown> }) => {
        m.creates.push(a.data);
        return { id: 'o_new' };
      },
      update: async (a: { data: Record<string, unknown> }) => {
        m.updates.push(a.data);
        return {};
      },
      updateMany: async (a: { data: Record<string, unknown> }) => {
        m.updates.push(a.data);
        return { count: 1 };
      },
    },
  },
}));

import { createOffering, publishOffering, updateOffering } from '@/app/practitioners/[slug]/edit/actions';

const AMY_WHOP_400 = new Error(
  'Whop /checkout_configurations failed (400): {"error":{"message":"Failed to create dynamic plan: Purchases over $2500 USD are not enabled for this account unless paid by bank wire on a one-time USD plan."}}',
);

function offering(over: Record<string, unknown> = {}) {
  return {
    id: 'o_1',
    practitionerId: 'p_amy',
    title: 'Six-month program',
    priceUsdCents: 150_000,
    interval: 'ONE_TIME',
    applicationFeeCents: 0,
    ...over,
  };
}

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

const run = (p: Promise<void>) => p.then(() => ({}) as { url?: string }, (e) => e as { url?: string });

beforeEach(() => {
  m.session = { user: { id: 'u_amy', role: 'PRACTITIONER' } };
  m.offering = offering();
  m.practitioner = { whopCompanyId: 'biz_amy', whopPayoutsEnabled: true };
  m.creates = [];
  m.updates = [];
  m.createOfferingCheckout.mockReset();
  m.sendEmail.mockReset().mockResolvedValue({ id: 'em_1' });
  vi.spyOn(console, 'error').mockImplementation((...a) => {
    m.logged.push(a);
  });
});

describe('the $2,500 ceiling is refused before Whop is called', () => {
  it('the limit is $2,500 and the message is the agreed copy', () => {
    expect(WHOP_MAX_PAYMENT_CENTS).toBe(250_000);
    expect(WHOP_OVER_LIMIT_MESSAGE).toBe(
      "Whop doesn't allow a single payment over $2,500. Split this into sessions or a payment plan, or contact us.",
    );
  });

  it.each([
    ['$2,500.01', '2500.01'],
    ['$3,000', '3,000'],
    ['$10,000 monthly', '10000'],
  ])('Publish of a stored %s offering redirects to the in-page message and never calls Whop', async (_l, price) => {
    m.offering = offering({ priceUsdCents: Math.round(parseFloat(price.replace(/,/g, '')) * 100) });
    const out = await run(publishOffering('amy', fd({ offeringId: 'o_1' })));
    expect(out.url).toBe('/practitioners/amy/edit?error=offering-over-whop-limit#offerings');
    expect(m.createOfferingCheckout).not.toHaveBeenCalled();
    expect(m.sendEmail).not.toHaveBeenCalled();
    expect(m.updates).toEqual([]);
  });

  it('exactly $2,500 is allowed through to Whop', async () => {
    m.offering = offering({ priceUsdCents: 250_000 });
    m.createOfferingCheckout.mockResolvedValue({ checkoutConfigId: 'ch_1', planId: 'plan_1', purchaseUrl: 'https://whop.com/c/x' });
    const out = await run(publishOffering('amy', fd({ offeringId: 'o_1' })));
    expect(m.createOfferingCheckout).toHaveBeenCalledTimes(1);
    expect(out.url).toBe('/practitioners/amy/edit?saved=offering#offerings');
  });

  it('saving a new offering over the limit is refused and nothing is written', async () => {
    const out = await run(createOffering('amy', fd({ title: 'Program', price: '2600' })));
    expect(out.url).toBe('/practitioners/amy/edit?error=offering-over-whop-limit#offerings');
    expect(m.creates).toEqual([]);
  });

  it('editing an offering to over the limit is refused and nothing is written', async () => {
    const out = await run(updateOffering('amy', fd({ offeringId: 'o_1', title: 'Program', price: '$2,750.00' })));
    expect(out.url).toBe('/practitioners/amy/edit?error=offering-over-whop-limit#offerings');
    expect(m.updates).toEqual([]);
  });

  it('a free consultation is never caught by it (its price is forced to 0)', async () => {
    const out = await run(createOffering('amy', fd({ title: 'Intro call', price: '9999', isConsult: 'on' })));
    expect(out.url).toBe('/practitioners/amy/edit?saved=offering#offerings');
    expect(m.creates[0]).toMatchObject({ priceUsdCents: 0 });
  });

  it('a price at or under the limit saves as before', async () => {
    const out = await run(createOffering('amy', fd({ title: 'Program', price: '2500' })));
    expect(out.url).toBe('/practitioners/amy/edit?saved=offering#offerings');
    expect(m.creates[0]).toMatchObject({ priceUsdCents: 250_000 });
  });
});

describe('a Whop failure on Publish is explained, never raw', () => {
  it("Amy's 2026-10-17 error maps to over-limit, with the message on the page and one email", async () => {
    m.createOfferingCheckout.mockRejectedValue(AMY_WHOP_400);
    const out = await run(publishOffering('amy', fd({ offeringId: 'o_1' })));
    expect(out.url).toBe('/practitioners/amy/edit?error=whop-over-limit&mailed=1#offerings');
    expect(out.url).not.toMatch(/Purchases|\{|%7B/);
    expect(m.sendEmail).toHaveBeenCalledTimes(1);
    const mail = m.sendEmail.mock.calls[0][0];
    expect(mail.to).toBe('amy@example.com');
    expect(mail.text).toContain(WHOP_PUBLISH_ERRORS['over-limit'].summary);
    expect(mail.text).toContain(WHOP_PUBLISH_ERRORS['over-limit'].nextStep);
    expect(mail.html).toContain(WHOP_PUBLISH_ERRORS['over-limit'].nextStep.replace(/&/g, '&amp;'));
    // Eight retries are one email: the key is per offering and failure kind.
    expect(mail.idempotencyKey).toBe('offering-publish-failed/o_1/over-limit');
    // The raw error is still logged server-side.
    expect(JSON.stringify(m.logged)).toContain('Whop publish offering failed');
  });

  it('an unrecognised Whop error shows the generic plain message', async () => {
    m.createOfferingCheckout.mockRejectedValue(new Error('Whop /checkout_configurations failed (422): {"error":"weird"}'));
    const out = await run(publishOffering('amy', fd({ offeringId: 'o_1' })));
    expect(out.url).toBe('/practitioners/amy/edit?error=whop-unknown&mailed=1#offerings');
    expect(m.sendEmail.mock.calls[0][0].text).toContain(WHOP_PUBLISH_ERRORS.unknown.summary);
  });

  it('when the email cannot be sent the page still explains, without claiming an email went out', async () => {
    m.createOfferingCheckout.mockRejectedValue(new Error('Whop /checkout_configurations failed (503): upstream'));
    m.sendEmail.mockRejectedValue(new Error('Resend 500'));
    const out = await run(publishOffering('amy', fd({ offeringId: 'o_1' })));
    expect(out.url).toBe('/practitioners/amy/edit?error=whop-unavailable#offerings');
  });

  it('a practitioner title with HTML is escaped in the email', async () => {
    m.offering = offering({ title: '<img src=x onerror=alert(1)>' });
    m.createOfferingCheckout.mockRejectedValue(AMY_WHOP_400);
    await run(publishOffering('amy', fd({ offeringId: 'o_1' })));
    expect(m.sendEmail.mock.calls[0][0].html).not.toContain('<img');
  });
});

describe('classifyWhopPublishError', () => {
  it.each([
    [AMY_WHOP_400, 'over-limit'],
    [new WhopNotConfigured('publish offering'), 'not-configured'],
    [new Error('Whop /checkout_configurations failed (429): slow down'), 'busy'],
    [new Error('Whop /checkout_configurations failed (502): bad gateway'), 'unavailable'],
    [new TypeError('fetch failed'), 'unavailable'],
    [new Error('Whop /checkout_configurations failed (400): Payouts are not enabled for this account'), 'account'],
    [new Error('Whop /checkout_configurations failed (403): account requires verification'), 'account'],
    [new Error('Whop /checkout_configurations failed (400): something new'), 'unknown'],
    ['not even an error', 'unknown'],
  ])('%s -> %s', (err, code) => {
    expect(classifyWhopPublishError(err)).toBe(code);
  });

  it('every code has page and email copy, and only known codes are accepted from the URL', () => {
    for (const c of WHOP_PUBLISH_ERROR_CODES) {
      expect(WHOP_PUBLISH_ERRORS[c].summary.length).toBeGreaterThan(10);
      expect(WHOP_PUBLISH_ERRORS[c].nextStep.length).toBeGreaterThan(10);
      expect(isWhopPublishErrorCode(c)).toBe(true);
    }
    for (const bad of ['', 'error', '<script>', 'over-limit ', null, undefined, 'constructor', '__proto__']) {
      expect(isWhopPublishErrorCode(bad)).toBe(false);
    }
  });
});
