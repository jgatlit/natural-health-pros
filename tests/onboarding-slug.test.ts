import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Prisma } from '@prisma/client';

/**
 * Fix 4 (tsk_303ec99f item 2): the first onboarding submit names the page after the name the
 * practitioner typed. An existing practitioner's slug is never changed.
 */

const m = vi.hoisted(() => ({
  ownSlug: 'kbbunny81',
  taken: new Set<string>(),
  existing: null as unknown,
  updates: [] as Array<Record<string, unknown>>,
  failFirstUpdateWithSlugCollision: false,
  session: { user: { id: 'u1', role: 'PRACTITIONER' } } as unknown,
  revalidatePath: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: async () => m.session }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error(`REDIRECT:${url}`), { url });
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: m.revalidatePath }));
vi.mock('@sentry/nextjs', () => ({}));
vi.mock('@/lib/whop', () => ({ WHOP_OFFERING_TITLE_MAX: 80 }));
vi.mock('@/lib/typesense-server', () => ({ TYPESENSE_COLLECTION: 'practitioners', getTypesenseAdmin: vi.fn() }));
vi.mock('@/lib/practitioner-indexer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/practitioner-indexer')>()),
  indexPractitioner: vi.fn(async () => undefined),
}));
vi.mock('@/lib/typesense-synonyms', () => ({ syncSpecialtySynonyms: vi.fn(async () => undefined) }));
vi.mock('@/lib/onboarding-draft', () => ({
  draftProfile: vi.fn(async () => ({
    draft: {
      headline: 'Nutrition coach',
      tagline: '',
      whoIHelp: '',
      bio: 'I help busy parents eat well.',
      qualifications: [],
      modalities: [],
      caseStudies: [],
    },
  })),
}));
vi.mock('@/lib/email', () => ({ sendEmail: vi.fn(), normalizeEmail: (s: string) => s, escapeHtml: (s: string) => s }));
vi.mock('@/lib/rate-limit', () => ({ rateLimit: vi.fn() }));
vi.mock('@/lib/platform-settings', () => ({ loadSettings: vi.fn() }));
vi.mock('@/lib/client-list', () => ({ addClientEntries: vi.fn() }));
vi.mock('@/lib/referrals', () => ({ createEmailReferral: vi.fn(), createReferralLink: vi.fn(), referralUrl: vi.fn() }));

vi.mock('@/lib/prisma', () => {
  const tx = {
    user: { updateMany: async () => ({ count: 1 }) },
    practitionerSpecialty: { deleteMany: async () => ({}) },
    specialty: { findMany: async () => [] },
    caseStudy: { deleteMany: async () => ({}), create: async () => ({}) },
    practitioner: {
      update: async (a: { data: Record<string, unknown> }) => {
        if (m.failFirstUpdateWithSlugCollision && m.updates.length === 0) {
          m.updates.push({ failed: a.data.slug });
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
            meta: { target: ['slug'] },
          });
        }
        m.updates.push(a.data);
        return {};
      },
    },
  };
  return {
    prisma: {
      practitioner: {
        findUnique: async (a: { where: { id?: string; slug?: string } }) => {
          if (a.where.id) return m.existing;
          if (a.where.slug === m.ownSlug) return { id: 'p1', userId: 'u1' };
          if (a.where.slug && m.taken.has(a.where.slug)) return { id: 'other', userId: 'u2' };
          return null;
        },
      },
      user: { findUnique: async () => ({ termsAcceptedAt: null, email: 'kbbunny81@hotmail.com' }) },
      specialty: { findMany: async () => [] },
      $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    },
  };
});

import { submitOnboarding } from '@/app/practitioners/[slug]/edit/actions';
import { draftProfile } from '@/lib/onboarding-draft';

function form(name: string) {
  const fd = new FormData();
  fd.set('displayName', name);
  fd.set('termsAccepted', 'on');
  fd.set('openToOutsideWork', 'no');
  fd.set('specialtiesJson', JSON.stringify([{ specialtyId: 's1', rawLabel: 'Gut Health' }]));
  return fd;
}

const shell = (over: Record<string, unknown> = {}) => ({
  headline: null,
  tagline: null,
  whoIHelp: null,
  bio: null,
  openToOutsideWork: false,
  openToOutsideWorkUpdatedAt: null,
  specialties: [],
  displayName: 'Kbbunny',
  plan: null,
  subscriptionStatus: 'NONE',
  whopCompanyId: null,
  whopMembershipId: null,
  whopSubscriptionCheckoutUrl: null,
  _count: { bookingLinks: 0, bookingIntents: 0, whopProducts: 0, profileSections: 0 },
  ...over,
});

const submit = (name: string): Promise<{ url?: string }> =>
  submitOnboarding(m.ownSlug, form(name)).then(
    () => ({}),
    (e) => e as { url?: string },
  );

beforeEach(() => {
  m.ownSlug = 'kbbunny81';
  m.taken = new Set();
  m.existing = shell();
  m.updates = [];
  m.failFirstUpdateWithSlugCollision = false;
  m.session = { user: { id: 'u1', role: 'PRACTITIONER' } };
  m.revalidatePath.mockReset();
});

describe('first onboarding submit names the slug after the typed name', () => {
  it('a never-drafted shell gets a slug from the name and lands on it', async () => {
    const out = await submit('Jordan Lee');
    expect(m.updates[0]).toMatchObject({ slug: 'jordan-lee', displayName: 'Jordan Lee' });
    expect(out.url).toBe('/practitioners/jordan-lee?onboarded=1');
    expect(m.revalidatePath).toHaveBeenCalledWith('/practitioners/kbbunny81');
    expect(m.revalidatePath).toHaveBeenCalledWith('/practitioners/jordan-lee');
  });

  it('a name already taken by someone else gets a numeric suffix', async () => {
    m.taken = new Set(['jordan-lee', 'jordan-lee-1']);
    await submit('Jordan Lee');
    expect(m.updates[0]).toMatchObject({ slug: 'jordan-lee-2' });
  });

  it('accents fold and a name with no usable letters falls back', async () => {
    await submit('Zoë Ñúñez');
    expect(m.updates[0]).toMatchObject({ slug: 'zoe-nunez' });
    m.updates = [];
    await submit('李');
    expect(m.updates[0]).toMatchObject({ slug: 'practitioner' });
  });

  it('a slug collision at write time keeps the current slug instead of failing the submit', async () => {
    m.failFirstUpdateWithSlugCollision = true;
    const out = await submit('Jordan Lee');
    expect(m.updates).toEqual([{ failed: 'jordan-lee' }, expect.objectContaining({ slug: 'kbbunny81' })]);
    expect(out.url).toBe('/practitioners/kbbunny81?onboarded=1');
  });
});

describe('an existing practitioner keeps their slug', () => {
  it.each([
    ['a bio', { bio: 'Already has a page' }],
    ['a headline', { headline: 'Herbalist' }],
    ['specialties', { specialties: [{ rawLabel: 'Gut health' }] }],
    ['a booking link', { _count: { bookingLinks: 1, bookingIntents: 0, whopProducts: 0, profileSections: 0 } }],
    ['a booking intent', { _count: { bookingLinks: 0, bookingIntents: 1, whopProducts: 0, profileSections: 0 } }],
    ['a Whop product', { _count: { bookingLinks: 0, bookingIntents: 0, whopProducts: 1, profileSections: 0 } }],
    ['a custom section', { _count: { bookingLinks: 0, bookingIntents: 0, whopProducts: 0, profileSections: 1 } }],
    ['a connected Whop account', { whopCompanyId: 'biz_1' }],
    ['a chosen plan', { plan: 'A' }],
    ['a started plan checkout', { whopSubscriptionCheckoutUrl: 'https://whop.com/checkout/x' }],
    ['a membership', { whopMembershipId: 'mem_1' }],
    ['a subscription', { subscriptionStatus: 'ACTIVE' }],
    ['a name they already typed', { displayName: 'Kristin Smith' }],
  ])('a profile with %s is not renamed', async (_label, over) => {
    m.existing = shell(over);
    const out = await submit('Jordan Lee');
    expect(m.updates[0]).toMatchObject({ slug: 'kbbunny81', displayName: 'Jordan Lee' });
    expect(out.url).toBe('/practitioners/kbbunny81?onboarded=1');
  });
});

it('a blank placeholder name (rows created after this change) is renamed too', async () => {
  m.existing = shell({ displayName: '' });
  await submit('Jordan Lee');
  expect(m.updates[0]).toMatchObject({ slug: 'jordan-lee' });
});

it("an admin completing someone else's onboarding never renames their slug", async () => {
  m.session = { user: { id: 'admin', role: 'ADMIN' } };
  const out = await submit('Jordan Lee');
  expect(m.updates[0]).toMatchObject({ slug: 'kbbunny81' });
  expect(out.url).toBe('/practitioners/kbbunny81?onboarded=1');
});

describe('at least one specialty is required (tsk_eb9ee4d9 item 1)', () => {
  it.each([
    ['no specialties field', undefined],
    ['an empty list', '[]'],
    ['only blank labels', JSON.stringify([{ specialtyId: null, rawLabel: '   ' }])],
    ['only invisible characters', JSON.stringify([{ specialtyId: null, rawLabel: '\u200b\ufeff ' }])],
    ['unparseable JSON', '{not json'],
  ])('%s is refused before any write or draft call', async (_label, json) => {
    vi.mocked(draftProfile).mockClear();
    const fd = form('Jordan Lee');
    if (json === undefined) fd.delete('specialtiesJson');
    else fd.set('specialtiesJson', json);
    const out = await submitOnboarding(m.ownSlug, fd).then(
      () => ({}) as { url?: string },
      (e) => e as { url?: string },
    );
    expect(out.url).toBe('/practitioners/kbbunny81/edit?error=specialty-required');
    expect(m.updates).toEqual([]);
    expect(draftProfile).not.toHaveBeenCalled();
  });

  it('an admin completing onboarding for someone is held to it too', async () => {
    m.session = { user: { id: 'admin', role: 'ADMIN' } };
    const fd = form('Jordan Lee');
    fd.set('specialtiesJson', '[]');
    const out = await submitOnboarding(m.ownSlug, fd).catch((e) => e as { url?: string });
    expect((out as { url?: string }).url).toBe('/practitioners/kbbunny81/edit?error=specialty-required');
    expect(m.updates).toEqual([]);
  });

  it('one specialty in the practitioner own words is enough, and is written', async () => {
    const fd = form('Jordan Lee');
    await submitOnboarding(m.ownSlug, fd).catch(() => undefined);
    const written = m.updates[0] as { specialties: { create: { rawLabel: string }[] } };
    expect(written.specialties.create.map((c) => c.rawLabel)).toEqual(['Gut Health']);
  });
});
