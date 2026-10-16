import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { draftProfile, isLlmConfigured } from '@/lib/onboarding-draft';

const ORIGINAL_KEY = process.env.ONBOARDING_LLM_API_KEY;
const ORIGINAL_HEADING = process.env.PROFILE_QUALIFICATIONS_HEADING;

beforeEach(() => {
  // Force the TEMPLATE path — no network, and it is the path every practitioner hits whenever
  // the LLM is unconfigured or errors.
  delete process.env.ONBOARDING_LLM_API_KEY;
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.ONBOARDING_LLM_API_KEY;
  else process.env.ONBOARDING_LLM_API_KEY = ORIGINAL_KEY;
  if (ORIGINAL_HEADING === undefined) delete process.env.PROFILE_QUALIFICATIONS_HEADING;
  else process.env.PROFILE_QUALIFICATIONS_HEADING = ORIGINAL_HEADING;
});

describe('AI draft — qualifications are never fabricated', () => {
  it('the template path returns NO qualifications even from credential-shaped source text', async () => {
    expect(isLlmConfigured()).toBe(false);

    const { draft, source } = await draftProfile({
      displayName: 'Sarah Schindler',
      // Deliberately stuffed with words a keyword matcher would happily promote into credentials,
      // AND phrased so the catalog terms genuinely match — otherwise `modalities` comes back
      // empty and this test passes no matter what the template does with it. (It did exactly
      // that on the first draft: a mutant copying modalities into qualifications survived.)
      rawSource:
        'I practise Herbalism and Functional Medicine. I am a certified herbalist with a degree ' +
        'in nutrition and years of university training. I studied at several institutes.',
      // The template no longer extracts modalities or specialties from mentions (operator ruling
      // 2026-10-15), so the only non-empty derived list is the practitioner's own labels.
      existing: { rawLabels: ['Herbalism', 'Certified Herbalist'] },
      canonicalCatalog: [
        { slug: 'herbalism', name: 'Herbalism' },
        { slug: 'functional-medicine', name: 'Functional Medicine' },
      ],
    });

    expect(source).toBe('template');
    expect(draft.modalities).toEqual([]);
    // Guard the guard: a mutant copying the drafted labels into qualifications must fail below,
    // which needs those labels to be non-empty.
    expect(draft.specialties.length).toBeGreaterThan(0);
    // ⚠️ THE POINT OF THIS TEST. The template path does no extraction, so inferring a credential
    // here would put a qualification the practitioner never formally claimed onto a health
    // directory — a different class of wrong from clumsy wording. Empty is correct.
    expect(draft.qualifications).toEqual([]);
  });

  it('always returns an array, so the profile section can render without a null guard', async () => {
    const { draft } = await draftProfile({
      displayName: 'Ada Lovelace',
      rawSource: 'I help people sleep better.',
      canonicalCatalog: [],
    });
    expect(Array.isArray(draft.qualifications)).toBe(true);
  });
});

describe('QUALIFICATIONS_HEADING — the title Amy has not picked yet', () => {
  // The constant is evaluated at MODULE LOAD, so each case needs a genuinely fresh module.
  // `vi.resetModules()` rather than a `?query` suffix on the specifier: the query resolves at
  // runtime but tsc rejects it as a missing module, so the suite would not typecheck.
  it('defaults to a shippable placeholder', async () => {
    delete process.env.PROFILE_QUALIFICATIONS_HEADING;
    vi.resetModules();
    const mod = await import('@/lib/profile-sections');
    expect(mod.QUALIFICATIONS_HEADING).toBe('Certifications & Education');
  });

  it('is overridable by env, so changing it is not a code change', async () => {
    // e4: Amy floated three variants and picked none. The section must not be held for a string.
    process.env.PROFILE_QUALIFICATIONS_HEADING = 'Education & Experience';
    vi.resetModules();
    const mod = await import('@/lib/profile-sections');
    expect(mod.QUALIFICATIONS_HEADING).toBe('Education & Experience');
  });
});

describe('the qualifications tool schema must keep its exclusion rules', () => {
  // The prompt is the ONLY thing standing between a practitioner's book deal and a heading that
  // reads "Certifications & Education". A live dry run against all 15 practitioners produced
  // "Author of Short-Term Keto", "Host of the Inside Out Health Podcast", "Creator of the Coach
  // Tara App" and "Preparing for NBHWC board certification" — all faithfully extracted, none of
  // them a credential. This asserts the rules that fixed that are still present, because deleting
  // a sentence from a prompt is invisible to every other check in the repo.
  it('excludes accomplishments and in-progress certifications', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync('src/lib/onboarding-draft.ts', 'utf8'),
    );
    const desc = src.slice(src.indexOf('qualifications: {'), src.indexOf('specialties: {'));
    for (const rule of ['books authored', 'podcasts hosted', 'companies founded', 'still in progress']) {
      expect(desc).toContain(rule);
    }
    // And the load-bearing consequence, stated so it cannot be softened into a suggestion.
    expect(desc).toContain('must return an EMPTY array');
  });
});
