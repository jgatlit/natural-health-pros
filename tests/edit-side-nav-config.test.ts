import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { editNavEntries, flattenEditNav } from '@/app/practitioners/[slug]/edit/edit-nav';

const ROOT = join(__dirname, '..');
const PAGE = join(ROOT, 'src/app/practitioners/[slug]/edit/page.tsx');
const COMPONENTS = join(ROOT, 'src/components/practitioners');

const sources = [PAGE, ...readdirSync(COMPONENTS).filter((f) => f.endsWith('.tsx')).map((f) => join(COMPONENTS, f))].map(
  (f) => readFileSync(f, 'utf8'),
);
const declared = (id: string) =>
  sources.reduce((n, src) => n + (src.match(new RegExp(`\\bid="${id}"`, 'g'))?.length ?? 0), 0);

const ALL = { isSetUp: false, hasCaseStudies: true, showJoinLink: true };

// Ids the setup checklist and external links already rely on.
const EXISTING_IDS = ['profile', 'plan', 'payments', 'offerings', 'booking-links', 'sections', 'clients', 'share-signup', 'brought-in', 'account'];

describe('edit page side navigation config', () => {
  const variants = [
    { isSetUp: false, hasCaseStudies: true, showJoinLink: true },
    { isSetUp: true, hasCaseStudies: false, showJoinLink: false },
    { isSetUp: true, hasCaseStudies: true, showJoinLink: true },
    { isSetUp: false, hasCaseStudies: false, showJoinLink: false },
  ];

  it.each(variants)('has no duplicate ids (%o)', (flags) => {
    const ids = flattenEditNav(editNavEntries(flags)).map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every nav id is declared as an anchor in the page or its cards', () => {
    for (const e of flattenEditNav(editNavEntries(ALL))) {
      expect(declared(e.id), `anchor #${e.id}`).toBeGreaterThan(0);
    }
  });

  it('each anchor is declared once, except #bookings (two mutually exclusive branches) and the pre-existing duplicate textarea id under #clients', () => {
    for (const e of flattenEditNav(editNavEntries(ALL))) {
      expect(declared(e.id), `#${e.id}`).toBe(e.id === 'clients' || e.id === 'bookings' ? 2 : 1);
    }
  });

  it('keeps every id that already existed', () => {
    const ids = flattenEditNav(editNavEntries({ ...ALL, isSetUp: true })).map((e) => e.id);
    for (const id of EXISTING_IDS) expect(ids).toContain(id);
  });

  it('nests the profile sub-sections under Profile', () => {
    const profile = editNavEntries(ALL).find((e) => e.id === 'profile');
    expect(profile?.children?.map((c) => c.label)).toEqual([
      'Photo',
      'Name and bio',
      'Qualifications',
      'Specialties',
      'Open to outside work',
    ]);
  });

  it('follows the page order for both layouts', () => {
    const ids = (flags: typeof ALL) => editNavEntries(flags).map((e) => e.id);
    expect(ids({ ...ALL, isSetUp: true }).slice(0, 3)).toEqual(['bookings', 'clients', 'profile']);
    const setup = ids(ALL);
    expect(setup[0]).toBe('setup');
    expect(setup.indexOf('sections')).toBeLessThan(setup.indexOf('bookings'));
  });

  it('hides entries for cards the viewer does not see', () => {
    const done = flattenEditNav(editNavEntries({ isSetUp: true, hasCaseStudies: false, showJoinLink: false })).map((e) => e.id);
    expect(done).not.toContain('setup');
    expect(done).not.toContain('client-outcomes');
    expect(done).not.toContain('share-signup');
    const midway = flattenEditNav(editNavEntries(ALL)).map((e) => e.id);
    expect(midway).toEqual(expect.arrayContaining(['setup', 'client-outcomes', 'share-signup']));
  });

  it('the nav component uses no router, so a click can never navigate', () => {
    const src = readFileSync(join(COMPONENTS, 'EditSideNav.tsx'), 'utf8');
    expect(src).not.toMatch(/next\/navigation/);
    expect(src).not.toMatch(/router\.(push|replace)/);
  });
});
