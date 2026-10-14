import { describe, it, expect, beforeEach, vi } from 'vitest';
import { signRecruiterCookie, RECRUITER_COOKIE } from '@/lib/recruiter-cookie';

/**
 * Behavioural: renders the real /onboarding page function against mocked I/O.
 * Pins the review-round-1 fixes: (1) the recruiter comes only from the REDEEMING browser's signed
 * cookie, never from whoever requested the invitation; (2) disabling a cohort stops redemption of
 * invitations already issued.
 */

const REAL = 'r'.repeat(32);
const ATTACKER = 'a'.repeat(32);
const SECRET = 'test-secret';

const m = vi.hoisted(() => ({
  session: { user: { id: 'victim-user', email: 'victim@x.com', name: 'Victim' } } as unknown,
  cookie: undefined as string | undefined,
  invitation: null as unknown,
  existingPractitioner: null as unknown,
  recruiterRows: {} as Record<string, { id: string; userId: string; archivedAt: Date | null }>,
  create: vi.fn(),
  findFirst: vi.fn(),
}));

class Redirect extends Error {}
vi.mock('next/navigation', () => ({
  redirect: (u: string) => {
    throw Object.assign(new Redirect(u), { url: u });
  },
}));
vi.mock('next/headers', () => ({ cookies: () => ({ get: () => (m.cookie ? { value: m.cookie } : undefined) }) }));
vi.mock('@/auth', () => ({ auth: async () => m.session }));
vi.mock('@/lib/practitioner-indexer', () => ({ indexPractitioner: async () => undefined }));
vi.mock('@/lib/onboarding-draft', () => ({ isLlmConfigured: () => false }));
vi.mock('@/lib/platform-settings', () => ({ loadSettings: async () => ({ leadAttributionTermMonths: 8 }) }));
vi.mock('@/lib/referral-fees', () => ({ crossReferralRates: () => ({ referrerFeeBps: 2000 }) }));
vi.mock('@/lib/pricing-plans', () => ({
  formatBpsAsPercent: () => '20%',
  planComparison: () => ({ cards: [] }),
}));
vi.mock('@/app/practitioners/[slug]/edit/actions', () => ({ submitOnboarding: () => undefined }));
vi.mock('@/components/practitioners/OnboardingForm', () => ({
  OnboardingForm: (p: unknown) => p,
}));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    invitation: { findUnique: async () => m.invitation, update: async () => ({}) },
    practitioner: {
      findUnique: vi.fn(async (a: { where: { userId?: string; slug?: string } }) =>
        a.where.userId ? m.existingPractitioner : null,
      ),
      findFirst: (a: { where: { recruiterToken: string; archivedAt: null; NOT: { userId: string } } }) => {
        m.findFirst(a);
        const r = m.recruiterRows[a.where.recruiterToken];
        return Promise.resolve(r && !r.archivedAt && r.userId !== a.where.NOT.userId ? { id: r.id } : null);
      },
      create: async (a: { data: Record<string, unknown> }) => {
        m.create(a);
        return {
          id: 'new-p',
          slug: 'victim',
          displayName: 'Victim',
          bio: null,
          headline: null,
          city: null,
          yearsInPractice: null,
          telehealth: false,
          inPerson: false,
          specialties: [],
          recruitedById: a.data.recruitedById ?? null,
          user: { termsAcceptedAt: null },
        };
      },
    },
    user: { update: async () => ({}) },
    specialty: { findMany: async () => [] },
    specialtyAlias: { findMany: async () => [] },
  },
}));

async function render() {
  const { default: Page } = await import('@/app/onboarding/page');
  return Page({ searchParams: { invitation: 'tok' } });
}

function invitation(over: Record<string, unknown> = {}) {
  return {
    id: 'i1',
    token: 'tok',
    email: 'victim@x.com',
    expiresAt: new Date(Date.now() + 86_400_000),
    acceptedAt: null,
    acceptedByUserId: null,
    cohortId: 'c1',
    cohort: { enabled: true },
    // An attacker's token left on a row by an older build must still never be honoured.
    recruiterToken: ATTACKER,
    ...over,
  };
}

beforeEach(() => {
  vi.resetModules();
  process.env.AUTH_SECRET = SECRET;
  m.create.mockReset();
  m.findFirst.mockReset();
  m.cookie = undefined;
  m.existingPractitioner = null;
  m.invitation = invitation();
  m.recruiterRows = {
    [REAL]: { id: 'real-recruiter', userId: 'real-user', archivedAt: null },
    [ATTACKER]: { id: 'attacker-p', userId: 'attacker-user', archivedAt: null },
  };
});

describe('recruiter comes from the redeemer browser, not the requester', () => {
  it('victim email requested with attacker token, redeemed with the real recruiter cookie: real recruiter wins', async () => {
    m.cookie = await signRecruiterCookie(REAL, Date.now(), SECRET);
    await render();
    expect(m.create.mock.calls[0][0].data).toMatchObject({ recruitedById: 'real-recruiter', recruitedVia: 'JOIN_LINK' });
  });

  it('redeemed with no cookie: no recruiter recorded (not the attacker)', async () => {
    await render();
    const data = m.create.mock.calls[0][0].data;
    expect(data.recruitedById).toBeUndefined();
    expect(m.findFirst).not.toHaveBeenCalled();
  });

  it('a forged cookie is ignored', async () => {
    m.cookie = await signRecruiterCookie(REAL, Date.now(), 'other-secret');
    await render();
    expect(m.create.mock.calls[0][0].data.recruitedById).toBeUndefined();
  });

  it('a cookie naming the redeemer themself is ignored (R != Y)', async () => {
    m.recruiterRows[REAL] = { id: 'self-p', userId: 'victim-user', archivedAt: null };
    m.cookie = await signRecruiterCookie(REAL, Date.now(), SECRET);
    await render();
    expect(m.create.mock.calls[0][0].data.recruitedById).toBeUndefined();
  });

  it('an archived recruiter is ignored', async () => {
    m.recruiterRows[REAL].archivedAt = new Date();
    m.cookie = await signRecruiterCookie(REAL, Date.now(), SECRET);
    await render();
    expect(m.create.mock.calls[0][0].data.recruitedById).toBeUndefined();
  });

  it('every new practitioner still gets its own recruiter token', async () => {
    await render();
    expect(m.create.mock.calls[0][0].data.recruiterToken).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('disabling a cohort stops already-issued invitations', () => {
  it('disabled cohort + no practitioner yet: closed state, nothing created', async () => {
    m.invitation = invitation({ cohort: { enabled: false } });
    const out = (await render()) as { props?: unknown };
    expect(JSON.stringify(out)).toContain('Sign-up is closed');
    expect(m.create).not.toHaveBeenCalled();
  });

  it('disabled cohort but the practitioner already exists: not locked out', async () => {
    m.invitation = invitation({ cohort: { enabled: false } });
    m.existingPractitioner = {
      id: 'p1', slug: 'victim', displayName: 'V', bio: null, headline: null, city: null,
      yearsInPractice: null, telehealth: false, inPerson: false, specialties: [],
      recruitedById: null, user: { termsAcceptedAt: null },
    };
    const out = JSON.stringify(await render());
    expect(out).not.toContain('Sign-up is closed');
  });

  it('enabled cohort and admin invites (no cohort) still redeem', async () => {
    await render();
    expect(m.create).toHaveBeenCalledTimes(1);
    m.create.mockReset();
    m.invitation = invitation({ cohortId: null, cohort: null });
    await render();
    expect(m.create).toHaveBeenCalledTimes(1);
  });
});

describe('invite gate regression', () => {
  const expectRedirect = async (to: string) => {
    await expect(render()).rejects.toMatchObject({ url: to });
    expect(m.create).not.toHaveBeenCalled();
  };
  it('expired invitation', async () => {
    m.invitation = invitation({ expiresAt: new Date(Date.now() - 1000) });
    await expectRedirect('/auth/error?error=Verification');
  });
  it('unknown invitation', async () => {
    m.invitation = null;
    await expectRedirect('/auth/error?error=Verification');
  });
  it('signed-in email does not match', async () => {
    m.invitation = invitation({ email: 'someone@else.com' });
    await expectRedirect('/auth/error?error=AccessDenied');
  });
  it('a user with no invitation param is refused', async () => {
    const { default: Page } = await import('@/app/onboarding/page');
    await expect(Page({ searchParams: {} })).rejects.toMatchObject({ url: '/' });
  });
});

void RECRUITER_COOKIE;
