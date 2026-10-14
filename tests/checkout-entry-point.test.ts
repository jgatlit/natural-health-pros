import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { V1 } from './helpers/rate-schedule';

/**
 * THE REAL CHECKOUT ENTRY POINT (spec v1.5 §2 — FAIL CLOSED; §1 — the $100 table through the real
 * code path).
 *
 * `/practitioners/[slug]/book/[token]` is where a fee is decided and a Whop checkout configuration
 * is minted, so this drives the actual page component — through the real `resolveBookingFee`, the
 * real attribution decision, the real schedule lookup and the real fee rule — and mocks only the
 * edges: the database, Whop, and the client components. A pure-function test of `resolveSessionFee`
 * could pass while this page quietly charged a default; this one cannot.
 */

const mocks = vi.hoisted(() => ({
  createBookingCheckoutConfig: vi.fn(),
  snapshotUpsert: vi.fn(),
  intentFindFirst: vi.fn(),
  practitionerFindUnique: vi.fn(),
  scheduleFindUnique: vi.fn(),
  attributedFindUnique: vi.fn(),
  listFindFirst: vi.fn(),
  touchFindMany: vi.fn(),
  intentUpdateMany: vi.fn(),
  intentFindUnique: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('next/headers', () => ({
  headers: () => new Headers({ host: 'naturalhealthpros.com', 'x-forwarded-proto': 'https' }),
}));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    bookingIntent: {
      findFirst: mocks.intentFindFirst,
      updateMany: mocks.intentUpdateMany,
      findUnique: mocks.intentFindUnique,
    },
    practitioner: { findUnique: mocks.practitionerFindUnique },
    rateSchedule: { findUnique: mocks.scheduleFindUnique },
    attributedClient: { findUnique: mocks.attributedFindUnique },
    clientListEntry: { findFirst: mocks.listFindFirst },
    referralTouch: { findMany: mocks.touchFindMany },
    bookingFeeSnapshot: { upsert: mocks.snapshotUpsert },
  },
}));
vi.mock('@/lib/practitioner-indexer', () => ({ bookableWhere: () => ({}) }));
vi.mock('@/lib/whop', () => ({ createBookingCheckoutConfig: mocks.createBookingCheckoutConfig }));
vi.mock('@/app/practitioners/[slug]/book/[token]/actions', () => ({ recordScheduleSignal: vi.fn() }));
vi.mock('@/components/booking/CheckoutStep', async () => {
  const React = await import('react');
  return {
    CheckoutStep: (p: { checkoutConfigId: string; fallbackUrl: string | null }) =>
      React.createElement('div', { 'data-checkout': p.checkoutConfigId, 'data-fallback': p.fallbackUrl ?? '' }),
  };
});
vi.mock('@/components/booking/SchedulerStep', async () => {
  const React = await import('react');
  return {
    SchedulerStep: (p: { checkoutUrl: string | null }) =>
      React.createElement('div', { 'data-scheduler': 'yes', 'data-hosted': p.checkoutUrl ?? '' }),
  };
});

const HOSTED_URL = 'https://whop.test/hosted-checkout-at-some-other-fee';

const NOW = new Date();
const DAY = 86_400_000;

function intent(over: { rateScheduleId?: string | null; plan?: string | null; touchId?: string | null } = {}) {
  return {
    id: 'bi_1',
    publicToken: 'tok_1',
    name: 'Dana Reed',
    status: 'CAPTURED',
    practitionerId: 'prac_Y',
    practitioner: {
      slug: 'dr-y',
      displayName: 'Dr Y',
      whopPayoutsEnabled: true,
      whopCompanyId: 'biz_y',
      plan: over.plan === undefined ? 'PLAN_A' : over.plan,
      rateScheduleId: over.rateScheduleId === undefined ? V1.id : over.rateScheduleId,
    },
    email: 'dana@example.com',
    whopCheckoutSessionId: null,
    whopCheckoutPurchaseUrl: null,
    paidAt: null,
    createdAt: new Date(NOW.getTime() - 2 * DAY),
    scheduledAt: null,
    referralTouchId: over.touchId ?? null,
    offering: {
      id: 'off_1',
      title: 'First session',
      description: null,
      archived: false,
      acceptsPayments: true,
      whopPlanId: 'plan_1',
      whopCheckoutConfigId: 'cfg_1',
      purchaseUrl: HOSTED_URL,
      priceUsdCents: 10_000,
    },
    bookingLink: null,
  };
}

async function render(i: ReturnType<typeof intent>): Promise<string> {
  mocks.intentFindFirst.mockImplementation(async (args: { where: Record<string, unknown> }) =>
    // The page's own lookup is keyed on publicToken; the attribution resolver's "earliest booking"
    // lookup is not.
    'publicToken' in args.where ? i : { createdAt: i.createdAt },
  );
  const { default: Page } = await import('@/app/practitioners/[slug]/book/[token]/page');
  const el = await Page({ params: { slug: 'dr-y', token: 'tok_1' } });
  return renderToStaticMarkup(el);
}

let errors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.createBookingCheckoutConfig.mockResolvedValue({
    checkoutConfigId: 'ch_minted',
    purchaseUrl: 'https://whop.test/per-intent',
  });
  mocks.snapshotUpsert.mockResolvedValue(undefined);
  mocks.intentUpdateMany.mockResolvedValue({ count: 1 });
  mocks.intentFindUnique.mockResolvedValue(null);
  mocks.attributedFindUnique.mockResolvedValue(null);
  mocks.listFindFirst.mockResolvedValue(null);
  mocks.touchFindMany.mockResolvedValue([]);
  mocks.practitionerFindUnique.mockResolvedValue({ rateSchedule: V1 });
  mocks.scheduleFindUnique.mockImplementation(async (args: { where: { id: string } }) =>
    args.where.id === V1.id ? V1 : null,
  );
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('FAIL CLOSED — a practitioner with no rate schedule never reaches a charge', () => {
  it('refuses up front: no mint, no snapshot, no hosted-link fallback, a logged error, and a message', async () => {
    const html = await render(intent({ rateScheduleId: null }));

    expect(mocks.createBookingCheckoutConfig).not.toHaveBeenCalled();
    expect(mocks.snapshotUpsert).not.toHaveBeenCalled();
    expect(html).not.toContain('data-checkout');
    expect(html).not.toContain(HOSTED_URL);
    expect(html).toContain('Online payment isn&#x27;t available');
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('REFUSING payment'),
      expect.objectContaining({ practitionerId: 'prac_Y' }),
    );
  });

  it('refuses at the MINT too, when the id is set but the schedule cannot be read (second line of defence)', async () => {
    mocks.practitionerFindUnique.mockResolvedValue({ rateSchedule: null });
    const html = await render(intent());

    expect(mocks.createBookingCheckoutConfig).not.toHaveBeenCalled();
    expect(mocks.snapshotUpsert).not.toHaveBeenCalled();
    expect(html).not.toContain('data-checkout');
    expect(html).not.toContain(HOSTED_URL);
    expect(html).toContain('Online payment isn&#x27;t available');
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('REFUSING payment'),
      expect.objectContaining({ error: expect.stringContaining('No rate schedule') }),
    );
  });

  it('a schedule that breaks the 30% cap is refused at the mint, not charged', async () => {
    mocks.practitionerFindUnique.mockResolvedValue({ rateSchedule: { ...V1, planASourcedBps: 3_500 } });
    const html = await render(intent());

    expect(mocks.createBookingCheckoutConfig).not.toHaveBeenCalled();
    expect(html).toContain('Online payment isn&#x27;t available');
  });

  it('control: the same page WITH a schedule mints and embeds the checkout', async () => {
    const html = await render(intent());

    expect(mocks.createBookingCheckoutConfig).toHaveBeenCalledTimes(1);
    expect(html).toContain('data-checkout="ch_minted"');
  });
});

describe('the spec v1.5 §1 $100 table, through the real checkout page', () => {
  const minted = () => mocks.createBookingCheckoutConfig.mock.calls[0]?.[0] as { applicationFeeCents: number };
  const snapshot = () => mocks.snapshotUpsert.mock.calls[0]?.[0].create as Record<string, unknown>;

  it('NHP-sourced, Plan A: $10 application fee', async () => {
    await render(intent({ plan: 'PLAN_A' }));
    expect(minted().applicationFeeCents).toBe(1_000);
    expect(snapshot()).toMatchObject({
      rateScheduleId: V1.id,
      nhpFeeUsdCents: 1_000,
      nhpNetUsdCents: 1_000,
      referrerTermState: 'NOT_REFERRED',
      applicationFeeUsdCents: 1_000,
      practitionerNetUsdCents: 9_000,
    });
  });

  it('NHP-sourced, Plan B: $30 application fee', async () => {
    await render(intent({ plan: 'PLAN_B' }));
    expect(minted().applicationFeeCents).toBe(3_000);
    expect(snapshot()).toMatchObject({ nhpFeeUsdCents: 3_000, practitionerNetUsdCents: 7_000 });
  });

  it('an unchosen plan resolves to Plan B: $30', async () => {
    await render(intent({ plan: null }));
    expect(minted().applicationFeeCents).toBe(3_000);
  });

  it('own client (on the practitioner’s list BEFORE the first booking): $0 and no application fee', async () => {
    mocks.listFindFirst.mockResolvedValue({ addedAt: new Date(NOW.getTime() - 30 * DAY) });
    await render(intent({ plan: 'PLAN_B' }));
    expect(minted().applicationFeeCents).toBe(0);
    expect(snapshot()).toMatchObject({ attributionOwner: 'PRACTITIONER', applicationFeeUsdCents: 0 });
  });

  it('referred, inside the referrer term, EITHER plan: $30 = $10 NHP + $20 referrer', async () => {
    mocks.touchFindMany.mockResolvedValue([
      {
        id: 'touch_1',
        receivedAt: new Date(NOW.getTime() - 3 * DAY),
        referral: { referrerId: 'prac_X', referredId: 'prac_Y', expiresAt: new Date(NOW.getTime() + 200 * DAY) },
      },
    ]);
    for (const plan of ['PLAN_A', 'PLAN_B']) {
      mocks.createBookingCheckoutConfig.mockClear();
      mocks.snapshotUpsert.mockClear();
      await render(intent({ plan, touchId: 'touch_1' }));
      expect(minted().applicationFeeCents, plan).toBe(3_000);
      expect(snapshot(), plan).toMatchObject({
        isCrossReferral: true,
        referrerPractitionerId: 'prac_X',
        nhpFeeUsdCents: 1_000,
        referrerShareUsdCents: 2_000,
        referrerTermState: 'IN_REFERRER_TERM',
        practitionerNetUsdCents: 7_000,
      });
    }
  });

  it('a stored client past the 8-month term: $0', async () => {
    mocks.attributedFindUnique.mockResolvedValue({
      owner: 'NHP',
      decidedAt: new Date(NOW.getTime() - 400 * DAY),
      referrerPractitionerId: null,
      termAnchorAt: new Date(NOW.getTime() - 300 * DAY),
      termEndsAt: new Date(NOW.getTime() - 60 * DAY),
      termMonths: 8,
      rateScheduleId: V1.id,
    });
    await render(intent({ plan: 'PLAN_B' }));
    expect(minted().applicationFeeCents).toBe(0);
  });

  it('a stored referred client in month 5 pays the PLAN rate, not the referral split', async () => {
    mocks.attributedFindUnique.mockResolvedValue({
      owner: 'NHP',
      decidedAt: new Date(NOW.getTime() - 200 * DAY),
      referrerPractitionerId: 'prac_X',
      termAnchorAt: new Date(NOW.getTime() - 150 * DAY),
      termEndsAt: new Date(NOW.getTime() + 90 * DAY),
      termMonths: 8,
      referrerTermMonths: 4,
      rateScheduleId: V1.id,
    });
    await render(intent({ plan: 'PLAN_A' }));
    expect(minted().applicationFeeCents).toBe(1_000);
    expect(snapshot()).toMatchObject({ referrerShareUsdCents: 0, referrerTermState: 'PAST_REFERRER_TERM' });
  });
});
