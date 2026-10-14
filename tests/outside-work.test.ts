import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

/**
 * L1c: "open to outside work and collaboration". A PRIVATE field: asked once at onboarding,
 * changeable on /edit, filterable by admins, and visible to nobody else.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  userFindUnique: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: mocks.auth }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    practitioner: { findUnique: mocks.findUnique, update: mocks.update },
    user: { findUnique: mocks.userFindUnique },
  },
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({}));
vi.mock('@/lib/whop', () => ({ WHOP_OFFERING_TITLE_MAX: 80 }));
vi.mock('@/lib/typesense-server', () => ({ TYPESENSE_COLLECTION: 'practitioners', getTypesenseAdmin: vi.fn() }));
vi.mock('@/lib/practitioner-indexer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/practitioner-indexer')>()),
  indexPractitioner: vi.fn(),
}));
vi.mock('@/lib/typesense-synonyms', () => ({ syncSpecialtySynonyms: vi.fn() }));
vi.mock('@/lib/onboarding-draft', () => ({ draftProfile: vi.fn() }));
vi.mock('@/lib/email', () => ({
  sendEmail: vi.fn(),
  normalizeEmail: (s: string) => s,
  escapeHtml: (s: string) => s,
}));
vi.mock('@/lib/rate-limit', () => ({ rateLimit: vi.fn() }));
vi.mock('@/lib/platform-settings', () => ({ loadSettings: vi.fn() }));
vi.mock('@/lib/client-list', () => ({ addClientEntries: vi.fn() }));
vi.mock('@/lib/referrals', () => ({
  createEmailReferral: vi.fn(),
  createReferralLink: vi.fn(),
  referralUrl: vi.fn(),
}));

import {
  OUTSIDE_WORK_FIELD,
  OUTSIDE_WORK_HELPER,
  OUTSIDE_WORK_QUESTION,
  matchesOutsideWorkFilter,
  outsideWorkWrite,
  parseOutsideWorkAnswer,
  parseOutsideWorkFilter,
} from '@/lib/outside-work';
import { setOpenToOutsideWork, submitOnboarding } from '@/app/practitioners/[slug]/edit/actions';
import { toTypesenseDoc } from '@/lib/practitioner-indexer';

const SRC = join(__dirname, '..', 'src');
const read = (...p: string[]) => readFileSync(join(SRC, ...p), 'utf8');

const QUESTION = 'Are you open to outside work and collaboration with other clinics and practitioners?';
const HELPER =
  'Turn this on to hear about care-team, contract and collaboration opportunities. You can change it any time.';

describe('exact copy', () => {
  it('question and helper text are verbatim', () => {
    expect(OUTSIDE_WORK_QUESTION).toBe(QUESTION);
    expect(OUTSIDE_WORK_HELPER).toBe(HELPER);
  });

  it('onboarding form and edit toggle render those constants, not their own wording', () => {
    for (const f of [
      read('components', 'practitioners', 'OnboardingForm.tsx'),
      read('components', 'practitioners', 'OutsideWorkToggle.tsx'),
    ]) {
      expect(f).toContain('OUTSIDE_WORK_QUESTION');
      expect(f).toContain('OUTSIDE_WORK_HELPER');
    }
  });
});

describe('onboarding question: required, no preselection', () => {
  const form = read('components', 'practitioners', 'OnboardingForm.tsx');
  const radios = form.match(/<input\s[^>]*type="radio"[^>]*\/>/g) ?? [];

  it('is a Yes/No radio pair, both required', () => {
    expect(radios).toHaveLength(2);
    expect(radios[0]).toContain('value="yes"');
    expect(radios[1]).toContain('value="no"');
    for (const r of radios) {
      expect(r).toContain('required');
      expect(r).toContain('name={OUTSIDE_WORK_FIELD}');
    }
  });

  it('never hard-codes a checked radio; only a stored answer can check one', () => {
    for (const r of radios) {
      expect(r).not.toMatch(/\bchecked\b(?!=)/);
      expect(r).not.toMatch(/defaultChecked\s*(?!=\{values\.openToOutsideWork)/);
    }
    expect(radios[0]).toContain('defaultChecked={values.openToOutsideWork === true}');
    expect(radios[1]).toContain('defaultChecked={values.openToOutsideWork === false}');
  });

  it('page passes null (neither checked) until the practitioner has actually answered', () => {
    const page = read('app', 'onboarding', 'page.tsx');
    expect(page).toMatch(
      /openToOutsideWork:\s*practitioner\.openToOutsideWorkUpdatedAt\s*\?\s*practitioner\.openToOutsideWork\s*:\s*null/,
    );
  });

  it('parseOutsideWorkAnswer treats anything but yes/no as unanswered', () => {
    expect(parseOutsideWorkAnswer('yes')).toBe(true);
    expect(parseOutsideWorkAnswer('no')).toBe(false);
    for (const bad of [null, '', 'on', 'true', 'YES', 'maybe']) {
      expect(parseOutsideWorkAnswer(bad)).toBeNull();
    }
  });
});

describe('submitOnboarding enforces the answer server-side', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: 'u1', role: 'PRACTITIONER' } });
  });

  function ownerForm(answer?: string) {
    const fd = new FormData();
    fd.set('displayName', 'Pat');
    fd.set('termsAccepted', 'on');
    if (answer !== undefined) fd.set(OUTSIDE_WORK_FIELD, answer);
    return fd;
  }

  it('refuses an owner submission with no answer, before touching anything else', async () => {
    mocks.findUnique.mockResolvedValueOnce({ id: 'p1', userId: 'u1' }); // authorizeForSlug
    mocks.userFindUnique.mockResolvedValue({ termsAcceptedAt: new Date() });
    await expect(submitOnboarding('pat', ownerForm())).rejects.toThrow(
      'REDIRECT:/practitioners/pat/edit?error=outside-work-required',
    );
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('refuses a forged value', async () => {
    mocks.findUnique.mockResolvedValueOnce({ id: 'p1', userId: 'u1' });
    mocks.userFindUnique.mockResolvedValue({ termsAcceptedAt: new Date() });
    await expect(submitOnboarding('pat', ownerForm('on'))).rejects.toThrow(
      'error=outside-work-required',
    );
  });

  it('the refusal error is rendered on the edit page', () => {
    expect(read('app', 'practitioners', '[slug]', 'edit', 'page.tsx')).toContain(
      "searchParams.error === 'outside-work-required'",
    );
  });

  it('persists the answer and stamps the timestamp inside the onboarding write', () => {
    const actions = read('app', 'practitioners', '[slug]', 'edit', 'actions.ts');
    const body = actions.slice(actions.indexOf('export async function submitOnboarding'));
    expect(body).toContain('outsideWorkWrite(');
    expect(body).toContain('recordFirstAnswer: true');
  });
});

describe('outsideWorkWrite timestamp semantics', () => {
  const t0 = new Date('2026-10-01T00:00:00Z');
  const now = new Date('2026-10-14T00:00:00Z');

  it('edit toggle: a real change writes the value and a new timestamp', () => {
    expect(
      outsideWorkWrite({ openToOutsideWork: false, openToOutsideWorkUpdatedAt: t0 }, true, now, {
        recordFirstAnswer: false,
      }),
    ).toEqual({ openToOutsideWork: true, openToOutsideWorkUpdatedAt: now });
  });

  it('edit toggle: an unchanged value writes nothing (timestamp untouched)', () => {
    expect(
      outsideWorkWrite({ openToOutsideWork: true, openToOutsideWorkUpdatedAt: t0 }, true, now, {
        recordFirstAnswer: false,
      }),
    ).toBeNull();
    expect(
      outsideWorkWrite({ openToOutsideWork: false, openToOutsideWorkUpdatedAt: null }, false, now, {
        recordFirstAnswer: false,
      }),
    ).toBeNull();
  });

  it('onboarding: a first "No" equals the default but is still recorded as an answer', () => {
    expect(
      outsideWorkWrite({ openToOutsideWork: false, openToOutsideWorkUpdatedAt: null }, false, now, {
        recordFirstAnswer: true,
      }),
    ).toEqual({ openToOutsideWork: false, openToOutsideWorkUpdatedAt: now });
  });

  it('onboarding: re-answering the same value later does not move the timestamp', () => {
    expect(
      outsideWorkWrite({ openToOutsideWork: true, openToOutsideWorkUpdatedAt: t0 }, true, now, {
        recordFirstAnswer: true,
      }),
    ).toBeNull();
  });
});

describe('setOpenToOutsideWork (the /edit toggle action)', () => {
  const t0 = new Date('2026-10-01T00:00:00Z');
  const updatedAt = new Date('2026-10-05T00:00:00Z');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function stored(value: boolean, ts: Date | null = t0) {
    mocks.findUnique.mockImplementation(async (args: { select: Record<string, boolean> }) =>
      'userId' in args.select
        ? { id: 'p1', userId: 'owner' }
        : { openToOutsideWork: value, openToOutsideWorkUpdatedAt: ts, updatedAt },
    );
  }

  it('owner flips the value: writes it, stamps the time, and returns the stored value', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'owner', role: 'PRACTITIONER' } });
    stored(false);
    await expect(setOpenToOutsideWork('pat', true)).resolves.toBe(true);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    const { where, data } = mocks.update.mock.calls[0][0];
    expect(where).toEqual({ id: 'p1' });
    expect(data.openToOutsideWork).toBe(true);
    expect(data.openToOutsideWorkUpdatedAt).toBeInstanceOf(Date);
    expect(data.openToOutsideWorkUpdatedAt.getTime()).toBeGreaterThan(t0.getTime());
  });

  it('keeps updatedAt pinned so the open profile form is not refused as stale', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'owner', role: 'PRACTITIONER' } });
    stored(false);
    await setOpenToOutsideWork('pat', true);
    expect(mocks.update.mock.calls[0][0].data.updatedAt).toBe(updatedAt);
  });

  it('setting the value it already has performs no write at all', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'owner', role: 'PRACTITIONER' } });
    stored(true);
    await expect(setOpenToOutsideWork('pat', true)).resolves.toBe(true);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('a different practitioner is refused with the same response as an unknown slug', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'stranger', role: 'PRACTITIONER' } });
    stored(false);
    const unauthorized = await setOpenToOutsideWork('pat', true).catch((e) => String(e));
    mocks.findUnique.mockResolvedValue(null);
    const missing = await setOpenToOutsideWork('nope', true).catch((e) => String(e));
    expect(unauthorized).toBe('Error: REDIRECT:/auth/error?error=AccessDenied');
    expect(missing).toBe(unauthorized);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('an anonymous caller is sent to sign-in and nothing is written', async () => {
    mocks.auth.mockResolvedValue(null);
    await expect(setOpenToOutsideWork('pat', true)).rejects.toThrow('REDIRECT:/auth/signin');
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('an admin may change it', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'admin', role: 'ADMIN' } });
    stored(true);
    await expect(setOpenToOutsideWork('pat', false)).resolves.toBe(false);
    expect(mocks.update).toHaveBeenCalledTimes(1);
  });

  it('the toggle sits in the #profile card but outside the profile <form>', () => {
    const page = read('app', 'practitioners', '[slug]', 'edit', 'page.tsx');
    const card = page.slice(page.indexOf('<Card id="profile"'));
    const formEnd = card.indexOf('</form>');
    const toggleAt = card.indexOf('<OutsideWorkToggle');
    const cardEnd = card.indexOf('</Card>');
    expect(toggleAt).toBeGreaterThan(formEnd);
    expect(toggleAt).toBeLessThan(cardEnd);
    expect(page).toContain('initial={practitioner.openToOutsideWork}');
  });
});

describe('admin filter', () => {
  it('parses the query param, defaulting to All', () => {
    expect(parseOutsideWorkFilter(undefined)).toBe('all');
    expect(parseOutsideWorkFilter('open')).toBe('open');
    expect(parseOutsideWorkFilter('not-open')).toBe('not-open');
    expect(parseOutsideWorkFilter('garbage')).toBe('all');
  });

  it('All / Open / Not open select the right rows; rows with no profile only match All', () => {
    const open = { openToOutsideWork: true };
    const closed = { openToOutsideWork: false };
    expect(matchesOutsideWorkFilter('all', null)).toBe(true);
    expect(matchesOutsideWorkFilter('open', open)).toBe(true);
    expect(matchesOutsideWorkFilter('open', closed)).toBe(false);
    expect(matchesOutsideWorkFilter('open', null)).toBe(false);
    expect(matchesOutsideWorkFilter('not-open', closed)).toBe(true);
    expect(matchesOutsideWorkFilter('not-open', open)).toBe(false);
    expect(matchesOutsideWorkFilter('not-open', undefined)).toBe(false);
  });

  it('the admin list selects the field, applies the filter, and shows a column', () => {
    const page = read('app', 'admin', 'invites', 'page.tsx');
    expect(page.match(/openToOutsideWork: true/g)).toHaveLength(2);
    expect(page).toContain("parseOutsideWorkFilter(searchParams?.ow)");
    expect(page).toContain('matchesOutsideWorkFilter(');
    for (const label of ['All', 'Open', 'Not open']) expect(page).toContain(`'${label}'`);
    expect(page).toContain("practitioner.openToOutsideWork ? 'Open' : 'Not open'");
  });
});

describe('no public surface', () => {
  const FIELD = /openToOutsideWork|outside-work|OUTSIDE_WORK/;

  it('the Typesense document never carries it, even when the row says open', () => {
    const doc = toTypesenseDoc({
      id: 'p1',
      slug: 's',
      displayName: 'S',
      bio: 'A long enough bio for the index to be happy with.',
      photoUrl: null,
      cityId: 'c1',
      city: { id: 'c1', name: 'Atlanta', state: 'GA', latitude: 1, longitude: 2 },
      specialties: [],
      user: { role: 'PRACTITIONER' },
      acceptedAt: new Date(),
      yearsInPractice: 3,
      searchText: 'x',
      openToOutsideWork: true,
      openToOutsideWorkUpdatedAt: new Date(),
    } as unknown as Parameters<typeof toTypesenseDoc>[0]);
    expect(JSON.stringify(doc)).not.toMatch(FIELD);
    expect(Object.keys(doc)).not.toContain('openToOutsideWork');
  });

  it('indexer, schema, synonyms and the search/directory libs never mention it', () => {
    const files = [
      read('lib', 'practitioner-indexer.ts'),
      read('lib', 'directory.ts'),
      read('lib', 'typesense-client.ts'),
      read('lib', 'typesense-search.ts'),
      read('lib', 'typesense-synonyms.ts'),
      readFileSync(join(__dirname, '..', 'deployment', 'typesense-collection-schema.json'), 'utf8'),
    ];
    for (const f of files) expect(f).not.toMatch(FIELD);
  });

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(ts|tsx)$/.test(name)) out.push(full);
    }
    return out;
  }

  it('every public route and search component is free of it', () => {
    const publicFiles = walk(SRC).filter((f) => {
      const rel = f.slice(SRC.length + 1).split(sep).join('/');
      return (
        rel === 'app/practitioners/[slug]/page.tsx' ||
        rel.startsWith('app/search/') ||
        rel.startsWith('components/search/') ||
        rel.startsWith('components/frontier/') ||
        rel.startsWith('app/api/search') ||
        /PractitionerHero|ProfileCtas|PublicProfile/.test(rel)
      );
    });
    expect(publicFiles).toContain(join(SRC, 'app', 'practitioners', '[slug]', 'page.tsx'));
    for (const f of publicFiles) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(FIELD);
    }
  });

  it('the only readers of the field are the owner edit page, the admin list, onboarding and the lib', () => {
    const readers = walk(SRC)
      .filter((f) => FIELD.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(SRC.length + 1).split(sep).join('/'))
      .sort();
    expect(readers).toEqual(
      [
        'app/admin/invites/page.tsx',
        'app/onboarding/page.tsx',
        'app/practitioners/[slug]/edit/actions.ts',
        'app/practitioners/[slug]/edit/page.tsx',
        'components/practitioners/OnboardingForm.tsx',
        'components/practitioners/OutsideWorkToggle.tsx',
        'lib/outside-work.ts',
      ].sort(),
    );
  });
});
