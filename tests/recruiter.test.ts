import { describe, it, expect, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  RECRUITER_COOKIE_DAYS,
  nextRecruiterCookie,
  signRecruiterCookie,
  verifyRecruiterCookie,
  RECRUITER_PARAM,
  RECRUITER_COOKIE,
} from '@/lib/recruiter-cookie';
import { REFERRAL_PARAM, REFERRAL_COOKIE } from '@/lib/referral-param';
import {
  newRecruiterToken,
  resolveRecruiterId,
  recruitedFields,
  joinLinkFor,
  RECRUITER_DISCLOSURE,
} from '@/lib/recruiter';
import { ensureCohortInvitation, COHORT_SLUG_RE } from '@/lib/join-cohort';
import { signupProgress } from '@/lib/signup-progress';

const SECRET = 'test-secret';
const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const NOW = 1_800_000_000_000;

describe('recruiter token', () => {
  it('is URL-safe, at least 16 bytes (32 hex), unique, and not an id shape', () => {
    const t = newRecruiterToken();
    expect(t).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set(Array.from({ length: 200 }, newRecruiterToken)).size).toBe(200);
  });
});

describe('nhpa cookie: signed, first-wins', () => {
  it('stores the first token, signed and verifiable', async () => {
    const v = await nextRecruiterCookie({ param: A, existingCookie: undefined, secret: SECRET, now: NOW });
    expect(v).toBeTruthy();
    expect(await verifyRecruiterCookie(v, SECRET, NOW)).toBe(A);
  });

  it('does NOT overwrite an existing valid cookie with a different nhpa', async () => {
    const first = await signRecruiterCookie(A, NOW, SECRET);
    const next = await nextRecruiterCookie({ param: B, existingCookie: first, secret: SECRET, now: NOW + 1000 });
    expect(next).toBeNull();
  });

  it('replaces an invalid or expired cookie', async () => {
    const stale = await signRecruiterCookie(A, NOW, SECRET);
    const later = NOW + (RECRUITER_COOKIE_DAYS + 1) * 86_400_000;
    expect(await nextRecruiterCookie({ param: B, existingCookie: stale, secret: SECRET, now: later })).toBeTruthy();
    expect(await nextRecruiterCookie({ param: B, existingCookie: 'garbage.value', secret: SECRET, now: NOW })).toBeTruthy();
  });

  it('rejects tampering and wrong secret', async () => {
    const v = await signRecruiterCookie(A, NOW, SECRET);
    const [p, s] = v.split('.');
    const forged = (await signRecruiterCookie(B, NOW, SECRET)).split('.')[0] + '.' + s;
    expect(await verifyRecruiterCookie(forged, SECRET, NOW)).toBeNull();
    expect(await verifyRecruiterCookie(`${p}.${s}`, 'other', NOW)).toBeNull();
  });

  it('ignores malformed params and an unset secret', async () => {
    for (const param of [null, '', 'short', 'has space ' + 'x'.repeat(20), '<script>'.padEnd(20, 'x')]) {
      expect(await nextRecruiterCookie({ param, existingCookie: null, secret: SECRET, now: NOW })).toBeNull();
    }
    expect(await nextRecruiterCookie({ param: A, existingCookie: null, secret: undefined, now: NOW })).toBeNull();
  });

  it('keeps nhpa distinct from ?ref and nhpr', () => {
    expect(RECRUITER_PARAM).toBe('nhpa');
    expect(RECRUITER_PARAM).not.toBe(REFERRAL_PARAM);
    expect(RECRUITER_PARAM).not.toBe('ref');
    expect(RECRUITER_COOKIE).not.toBe(REFERRAL_COOKIE);
  });
});

describe('resolveRecruiterId', () => {
  const db = (row: { id: string } | null) => ({ practitioner: { findFirst: vi.fn().mockResolvedValue(row) } });

  it('resolves a known active recruiter', async () => {
    const d = db({ id: 'R' });
    expect(await resolveRecruiterId(d, A, 'userY')).toBe('R');
    const where = d.practitioner.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ recruiterToken: A, archivedAt: null, NOT: { userId: 'userY' } });
  });

  it('ignores an unknown token', async () => {
    expect(await resolveRecruiterId(db(null), A, 'u')).toBeNull();
  });

  it('never queries for malformed tokens', async () => {
    const d = db({ id: 'R' });
    expect(await resolveRecruiterId(d, 'nope', 'u')).toBeNull();
    expect(await resolveRecruiterId(d, null, 'u')).toBeNull();
    expect(d.practitioner.findFirst).not.toHaveBeenCalled();
  });

  it('excludes the signer-up themself and archived recruiters in the query (R != Y)', async () => {
    const d = db(null);
    await resolveRecruiterId(d, A, 'me');
    const where = d.practitioner.findFirst.mock.calls[0][0].where;
    expect(where.NOT).toEqual({ userId: 'me' });
    expect(where.archivedAt).toBeNull();
  });

  it('recruitedFields stamps JOIN_LINK and is empty without a recruiter', () => {
    const now = new Date();
    expect(recruitedFields('R', now)).toEqual({ recruitedById: 'R', recruitedAt: now, recruitedVia: 'JOIN_LINK' });
    expect(recruitedFields(null, now)).toEqual({});
  });
});

describe('recruitedById immutability', () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(f)) out.push(p);
    }
    return out;
  }

  it('is written by no code path other than the create at onboarding (via recruitedFields)', () => {
    const offenders = walk(join(__dirname, '..', 'src')).filter((f) => {
      const src = readFileSync(f, 'utf8');
      return /recruitedById\s*:/.test(src) && !/lib\/recruiter\.ts$/.test(f.replace(/\\/g, '/'));
    });
    expect(offenders).toEqual([]);
  });

  it('onboarding writes it only inside practitioner.create, never an update', () => {
    const src = readFileSync(join(__dirname, '..', 'src/app/onboarding/page.tsx'), 'utf8');
    expect(src).toMatch(/practitioner\.create\(\{[\s\S]*recruitedFields\(/);
    expect(src).not.toMatch(/practitioner\.update[\s\S]{0,200}recruit/);
  });
});

describe('cohort invitation', () => {
  const mk = (existing: unknown) => ({
    invitation: {
      findFirst: vi.fn().mockResolvedValue(existing),
      create: vi.fn().mockImplementation(async ({ data }) => ({ id: 'i1', ...data })),
    },
  });

  it('creates a cohort-tagged, expiring invitation that carries NO recruiter data', async () => {
    const d = mk(null);
    const now = new Date('2026-10-15T00:00:00Z');
    const r = await ensureCohortInvitation(d, { cohortId: 'c1', email: 'a@x.com', now });
    expect(r.created).toBe(true);
    const data = d.invitation.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ cohortId: 'c1', email: 'a@x.com' });
    expect(data).not.toHaveProperty('recruiterToken');
    expect(data.invitedById).toBeUndefined();
    expect(data.token.length).toBeGreaterThanOrEqual(24);
    expect(data.expiresAt.getTime()).toBeGreaterThan(now.getTime());
  });

  it('reuses a pending invitation (it holds no recruiter, so nothing stale is carried)', async () => {
    const d = mk({ id: 'old', token: 'tok' });
    const r = await ensureCohortInvitation(d, { cohortId: 'c1', email: 'a@x.com' });
    expect(r).toEqual({ id: 'old', token: 'tok', created: false });
    expect(d.invitation.create).not.toHaveBeenCalled();
  });

  it('cohort slugs are constrained', () => {
    expect(COHORT_SLUG_RE.test('hhe')).toBe(true);
    for (const bad of ['', 'HHE', '../x', 'a b', 'x'.repeat(60)]) expect(COHORT_SLUG_RE.test(bad)).toBe(false);
  });
});

describe('join page and action source invariants', () => {
  const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

  it('action rate-limits by IP and email before touching the database', () => {
    const src = read('src/app/join/[cohort]/actions.ts');
    expect(src).toMatch(/prefix: 'join-ip', by: 'ip'/);
    expect(src).toMatch(/prefix: 'join-email', by: 'email'/);
    expect(src.indexOf('checkBotGuard(')).toBeLessThan(src.indexOf('signupCohort.findUnique'));
  });

  it('action refuses a disabled or unknown cohort before minting an invitation', () => {
    const src = read('src/app/join/[cohort]/actions.ts');
    expect(src).toMatch(/!cohort \|\| !cohort\.enabled/);
    expect(src.indexOf('!cohort.enabled')).toBeLessThan(src.indexOf('ensureCohortInvitation('));
  });

  it('redirectTo is built only from our own minted token (no caller-supplied callbackUrl)', () => {
    const src = read('src/app/join/[cohort]/actions.ts');
    expect(src).toMatch(/redirectTo: `\/onboarding\?invitation=\$\{invite\.token\}`/);
    expect(src).not.toMatch(/callbackUrl/);
  });

  it('response never echoes the email and success is uniform', () => {
    const src = read('src/app/join/[cohort]/actions.ts');
    expect(src).not.toMatch(/redirect\([^)]*email[^)]*\)/);
  });

  it('page 404s for unknown cohorts and shows a closed state for disabled ones', () => {
    const src = read('src/app/join/[cohort]/page.tsx');
    expect(src).toMatch(/if \(!cohort\) notFound\(\)/);
    expect(src).toMatch(/!cohort\.enabled/);
    expect(src).toMatch(/Sign-up is closed/);
  });

  it('disclosure appears only for a resolved recruiter', () => {
    const src = read('src/app/join/[cohort]/page.tsx');
    expect(src).toMatch(/\{recruiter && \(/);
    expect(RECRUITER_DISCLOSURE).toMatch(/3%/);
  });

  it('no loading.tsx under /join (it would turn notFound() into a 200)', () => {
    expect(() => readFileSync(join(__dirname, '..', 'src/app/join/[cohort]/loading.tsx'))).toThrow();
  });
});

describe('admin gating and invite gate', () => {
  const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

  it('signups page and toggle action both require ADMIN', () => {
    expect(read('src/app/admin/signups/page.tsx')).toMatch(/role !== 'ADMIN'/);
    expect(read('src/app/admin/signups/actions.ts')).toMatch(/role !== 'ADMIN'/);
  });

  it('/admin stays middleware-gated and /join is not', () => {
    const mw = read('src/middleware.ts');
    expect(mw).toMatch(/pathname\.startsWith\('\/admin'\)/);
    expect(mw).not.toMatch(/startsWith\('\/join[^']*'\)\) \{\s*if \(!session/);
  });

  it('onboarding still enforces the invitation gate unchanged', () => {
    const src = read('src/app/onboarding/page.tsx');
    expect(src).not.toMatch(/redirect\(\s*'\/'\s*\)/);
    expect(src).toMatch(/invitation\.expiresAt < new Date\(\)/);
    expect(src).toMatch(/invitation\.acceptedByUserId !== session\.user\.id/);
    expect(src).toMatch(/AccessDenied/);
  });

  it('pilot clock is untouched: trialEndsAt still comes only from the onboarding clock flag', () => {
    const src = read('src/app/onboarding/page.tsx');
    expect(src).toMatch(/if \(trialClockEnabled\)/);
    expect(src).not.toMatch(/cohort.*trialEndsAt|trialEndsAt.*cohort/);
  });

  it('there is no cohort-less public sign-up route', () => {
    expect(() => readFileSync(join(__dirname, '..', 'src/app/join/page.tsx'))).toThrow();
  });
});

describe('seeds, link, progress', () => {
  it('builds the shareable link from the canonical origin', () => {
    expect(joinLinkFor('https://naturalhealthpros.com', 'hhe', A)).toBe(`https://naturalhealthpros.com/join/hhe?nhpa=${A}`);
  });

  it('migration seeds hhe idempotently and backfills every practitioner before the unique index', () => {
    const sql = readFileSync(
      join(__dirname, '..', 'prisma/migrations/20261014140000_open_signup_cohort_recruiter_token/migration.sql'),
      'utf8',
    );
    expect(sql).toMatch(/ON CONFLICT \("slug"\) DO NOTHING/);
    expect(sql.indexOf('UPDATE "Practitioner"')).toBeLessThan(sql.indexOf('Practitioner_recruiterToken_key'));
    expect(sql.indexOf('SignupCohort_slug_key')).toBeLessThan(sql.indexOf('INSERT INTO "SignupCohort"'));
    expect(sql).not.toMatch(/DROP /);
  });

  it('progress states', () => {
    expect(signupProgress({ acceptedAt: null, hasPractitioner: false, profileComplete: false })).toBe('requested');
    expect(signupProgress({ acceptedAt: new Date(), hasPractitioner: true, profileComplete: false })).toBe('onboarding-started');
    expect(signupProgress({ acceptedAt: new Date(), hasPractitioner: true, profileComplete: true })).toBe('profile-complete');
  });
});
