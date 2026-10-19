import { describe, it, expect, beforeEach, vi } from 'vitest';
import { signRecruiterCookie, RECRUITER_COOKIE } from '@/lib/recruiter-cookie';
import { V1 } from './helpers/rate-schedule';

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
  /** The schedule `current_rate_schedule_id` points at; null = none configured. */
  currentScheduleId: 'rs_go_forward_2026_10' as string | null,
  enabledCohort: { slug: 'hhe' } as { slug: string } | null,
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
vi.mock('@/lib/pricing-plans', () => ({
  planComparison: () => ({ cards: [], referral: {} }),
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
    // The REAL rate-schedules lib runs against these (spec v1.5 §2): current id, then the row.
    platformSetting: {
      findUnique: async () => (m.currentScheduleId ? { value: m.currentScheduleId } : null),
    },
    rateSchedule: {
      findUnique: async (a: { where: { id: string } }) =>
        a.where.id === m.currentScheduleId ? V1 : null,
    },
    user: { update: async () => ({}) },
    signupCohort: { findFirst: async () => m.enabledCohort },
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
  m.currentScheduleId = V1.id;
  m.existingPractitioner = null;
  m.enabledCohort = { slug: 'hhe' };
  m.session = { user: { id: 'victim-user', email: 'victim@x.com', name: 'Victim' } };
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

  // E11 (lane L2b): FIRST WINS, THROUGH THE REAL CREATION PATH. The Prisma mock below has no
  // `practitioner.update` at all, so any attempt to overwrite a recruiter would throw here.
  const existing = (recruitedById: string | null) => ({
    id: 'p1', slug: 'victim', displayName: 'V', bio: null, headline: null, city: null,
    yearsInPractice: null, telehealth: false, inPerson: false, specialties: [],
    recruitedById, rateScheduleId: V1.id, user: { termsAcceptedAt: null },
  });

  it('a second recruiter cannot overwrite the first: an already-recruited practitioner is not re-written', async () => {
    m.existingPractitioner = existing('first-recruiter');
    m.cookie = await signRecruiterCookie(REAL, Date.now(), SECRET); // a DIFFERENT recruiter's link
    const el = (await render()) as unknown as { props: { recruiterDisclosure: string | null } };
    expect(m.create).not.toHaveBeenCalled();
    expect(m.findFirst).not.toHaveBeenCalled(); // the second token is not even looked up
    expect(el.props.recruiterDisclosure).toMatch(/brought you in/); // still the first recruiter's practitioner
  });

  it('a practitioner who signed up with NO recruiter cannot be recruited afterwards by a later link', async () => {
    m.existingPractitioner = existing(null);
    m.cookie = await signRecruiterCookie(REAL, Date.now(), SECRET);
    const el = (await render()) as unknown as { props: { recruiterDisclosure: string | null } };
    expect(m.create).not.toHaveBeenCalled();
    expect(el.props.recruiterDisclosure).toBeNull();
  });

  it('e13: a recruited sign-up is handed the 3% disclosure for the form; an unrecruited one is not', async () => {
    m.cookie = await signRecruiterCookie(REAL, Date.now(), SECRET);
    const recruited = (await render()) as unknown as { props: { recruiterDisclosure: string | null } };
    expect(recruited.props.recruiterDisclosure).toMatch(/3%/);
    vi.resetModules();
    m.cookie = undefined;
    const plain = (await render()) as unknown as { props: { recruiterDisclosure: string | null } };
    expect(plain.props.recruiterDisclosure).toBeNull();
  });

  it('every new practitioner still gets its own recruiter token', async () => {
    await render();
    expect(m.create.mock.calls[0][0].data.recruiterToken).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('EVERY NEW SIGN-UP IS PRICED: the real creation path assigns the current rate schedule (spec v1.5 §2)', () => {
  // Without this, every practitioner who signs up through /join/<cohort> would fail closed at
  // checkout. The FK and its SIGNUP history row go in the same create.
  const SIGNUP = {
    rateScheduleId: V1.id,
    rateScheduleAssignments: { create: { rateScheduleId: V1.id, reason: 'SIGNUP' } },
  };

  it('an admin-invited practitioner is created with the current schedule and a SIGNUP assignment', async () => {
    m.invitation = invitation({ cohortId: null, cohort: null });
    await render();
    expect(m.create.mock.calls[0][0].data).toMatchObject(SIGNUP);
  });

  it('a cohort sign-up (/join/hhe) is created with the current schedule and a SIGNUP assignment', async () => {
    await render();
    expect(m.create.mock.calls[0][0].data).toMatchObject(SIGNUP);
  });

  it('a recruited sign-up gets BOTH the recruiter and the schedule in one create', async () => {
    m.cookie = await signRecruiterCookie(REAL, Date.now(), SECRET);
    await render();
    expect(m.create).toHaveBeenCalledTimes(1);
    expect(m.create.mock.calls[0][0].data).toMatchObject({ recruitedById: 'real-recruiter', ...SIGNUP });
  });

  it('with NO current schedule configured, sign-up fails loudly and creates NO practitioner', async () => {
    m.currentScheduleId = null;
    await expect(render()).rejects.toThrow(/No rate schedule/);
    expect(m.create).not.toHaveBeenCalled();
  });

  it('a practitioner who already exists is not re-priced by revisiting /onboarding', async () => {
    m.existingPractitioner = {
      id: 'p1', slug: 'victim', displayName: 'V', bio: null, headline: null, city: null,
      yearsInPractice: null, telehealth: false, inPerson: false, specialties: [],
      recruitedById: null, rateScheduleId: 'rs_old', user: { termsAcceptedAt: null },
    };
    await render();
    expect(m.create).not.toHaveBeenCalled();
  });

  it('is the ONLY place app code creates a Practitioner row (so no other path can skip the schedule)', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(f) && /practitioner\s*\.\s*(create|createMany|upsert)\s*\(/.test(readFileSync(p, 'utf8'))) {
          hits.push(p.replace(process.cwd() + '/', ''));
        }
      }
    };
    walk(join(process.cwd(), 'src'));
    expect(hits).toEqual(['src/app/onboarding/page.tsx']);
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
  it('expired invitation, no profile: the sign-up-link page, nothing created', async () => {
    m.invitation = invitation({ expiresAt: new Date(Date.now() - 1000) });
    const out = (await render()) as { props: Record<string, unknown> };
    expect(out.props).toEqual({ expired: true });
    expect(m.create).not.toHaveBeenCalled();
  });
  it('unknown invitation, no profile: the sign-up-link page, nothing created', async () => {
    m.invitation = null;
    const out = (await render()) as { props: { expired?: boolean } };
    expect(out.props.expired).toBe(true);
    expect(m.create).not.toHaveBeenCalled();
  });
  it('an invitation accepted by another account is still refused', async () => {
    m.invitation = invitation({ acceptedAt: new Date(), acceptedByUserId: 'someone-else' });
    const out = (await render()) as { props: { expired?: boolean } };
    expect(out.props.expired).toBe(true);
    expect(m.create).not.toHaveBeenCalled();
  });
  it('expired invitation for someone who already has a profile: their edit page', async () => {
    m.invitation = invitation({ expiresAt: new Date(Date.now() - 1000) });
    m.existingPractitioner = { slug: 'victim' };
    await expect(render()).rejects.toMatchObject({ url: '/practitioners/victim/edit' });
  });
  it('signed-in email does not match', async () => {
    m.invitation = invitation({ email: 'someone@else.com' });
    await expect(render()).rejects.toMatchObject({ url: '/auth/error?error=AccessDenied' });
    expect(m.create).not.toHaveBeenCalled();
  });
});

describe('/onboarding never strands anyone on the homepage (tsk_8cec02e4)', () => {
  const page = async (searchParams: { invitation?: string }) => {
    const { default: Page } = await import('@/app/onboarding/page');
    return Page({ searchParams });
  };

  it('signed out with an invitation: sign-in keeps the token in callbackUrl', async () => {
    m.session = null;
    await expect(page({ invitation: 'tok_ABC-123' })).rejects.toMatchObject({
      url: '/auth/signin?callbackUrl=%2Fonboarding%3Finvitation%3Dtok_ABC-123',
    });
  });
  it('signed out, bare /onboarding: sign-in with callbackUrl=/onboarding', async () => {
    m.session = null;
    await expect(page({})).rejects.toMatchObject({ url: '/auth/signin?callbackUrl=%2Fonboarding' });
  });
  it('signed in with a profile, bare /onboarding: their edit page', async () => {
    m.existingPractitioner = { slug: 'victim' };
    await expect(page({})).rejects.toMatchObject({ url: '/practitioners/victim/edit' });
  });
  it('signed in without a profile, bare /onboarding: the request-to-join page, no cohort link passed', async () => {
    const out = (await page({})) as { props: Record<string, unknown> };
    expect(out.props).toEqual({});
    expect(m.create).not.toHaveBeenCalled();
  });
  it('the page source never redirects to the homepage', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/app/onboarding/page.tsx', 'utf8');
    expect(src).not.toMatch(/redirect\(\s*['"`]\/['"`]\s*\)/);
  });
});

describe('the name is the practitioner\'s own (fix 4)', () => {
  it('a new practitioner is created with a blank name, not one derived from the email', async () => {
    await render();
    expect(m.create.mock.calls[0][0].data.displayName).toBe('');
  });
  it('an untouched shell holding an email-derived name is shown a blank name field', async () => {
    m.invitation = invitation({ email: 'kbbunny81@x.com' });
    m.session = { user: { id: 'victim-user', email: 'kbbunny81@x.com' } };
    m.existingPractitioner = {
      id: 'p1', slug: 'kbbunny81', displayName: 'Kbbunny', bio: null, headline: null, city: null,
      yearsInPractice: null, telehealth: false, inPerson: false, specialties: [],
      recruitedById: null, rateScheduleId: V1.id, user: { termsAcceptedAt: null },
    };
    const out = (await render()) as { props: { values: { displayName: string } } };
    expect(out.props.values.displayName).toBe('');
  });
  it('a name the practitioner typed is kept', async () => {
    m.existingPractitioner = {
      id: 'p1', slug: 'victim', displayName: 'Jordan Lee', bio: null, headline: null, city: null,
      yearsInPractice: null, telehealth: false, inPerson: false, specialties: [],
      recruitedById: null, rateScheduleId: V1.id, user: { termsAcceptedAt: null },
    };
    const out = (await render()) as { props: { values: { displayName: string } } };
    expect(out.props.values.displayName).toBe('Jordan Lee');
  });
});

void RECRUITER_COOKIE;
