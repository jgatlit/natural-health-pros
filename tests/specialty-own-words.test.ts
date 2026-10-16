import { describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import {
  isWordingVariant,
  specialtyMatchKey,
  specialtyNameFromLabel,
} from '@/lib/specialty-match';
import { resolveOwnSpecialty } from '@/lib/specialty-resolve';
import { draftProfile } from '@/lib/onboarding-draft';

// Operator ruling 2026-10-15: "Specialties should not be awarded/added by the application."
// Wording may be normalised; the concept may never be substituted.

type Row = {
  id: string;
  slug: string;
  name: string;
  status: 'ACTIVE' | 'PROPOSED' | 'MERGED';
  mergedIntoId?: string | null;
};
type Alias = { id: string; label: string; specialtyId: string; source: string; status: string };

function fakeDb(specialties: Row[], aliases: Omit<Alias, 'id' | 'source' | 'status'>[] = []) {
  const s = [...specialties];
  const a: Alias[] = aliases.map((x, i) => ({ id: `a${i}`, source: 'CURATED', status: 'APPROVED', ...x }));
  const tx = {
    specialty: {
      findMany: async (q: { where: { status: { in: string[] } } }) =>
        s
          .filter((r) => q.where.status.in.includes(r.status))
          .map((r) => ({ mergedIntoId: null, ...r }))
          .sort((x, y) => x.name.localeCompare(y.name)),
      findUnique: async (q: { where: { slug: string } }) => s.find((r) => r.slug === q.where.slug) ?? null,
      create: async (q: { data: { slug: string; name: string; status: Row['status'] } }) => {
        const row = { id: `new_${s.length}`, ...q.data };
        s.push(row);
        return row;
      },
    },
    specialtyAlias: {
      findUnique: async (q: { where: { label: string } }) => a.find((r) => r.label === q.where.label) ?? null,
      create: async (q: { data: Omit<Alias, 'id'> }) => {
        const row = { id: `alias_${a.length}`, ...q.data };
        a.push(row);
        return row;
      },
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, specialties: s, aliases: a };
}

const CATALOG: Row[] = [
  { id: 'fm', slug: 'functional-medicine', name: 'Functional Medicine', status: 'ACTIVE' },
  { id: 'sso', slug: 'stress-sleep-optimization', name: 'Stress / Sleep Optimization', status: 'ACTIVE' },
  { id: 'hhc', slug: 'holistic-health-coaching', name: 'Holistic Health Coaching', status: 'ACTIVE' },
  { id: 'hyp', slug: 'hypnotherapy', name: 'Hypnotherapy', status: 'ACTIVE' },
  { id: 'rei', slug: 'reiki', name: 'Reiki', status: 'ACTIVE' },
  { id: 'em', slug: 'energy-medicine', name: 'Energy Medicine', status: 'ACTIVE' },
];

describe('isWordingVariant', () => {
  it.each([
    ['Holistic Health Coach', 'Holistic Health Coaching'],
    ['Hypnotist', 'Hypnotherapy'],
    ['Hypnotherapist', 'Hypnotherapy'],
    ['Reiki Master', 'Reiki'],
    ['reiki practitioner', 'Reiki'],
    ['Reflexologist', 'Reflexology'],
    ['Nutritionist', 'Nutrition'],
    ['Naturopath', 'Naturopathy'],
    ['  functional   medicine ', 'Functional Medicine'],
    ['Mind Body Coach', 'Mind-Body Coaching'],
    ['Yoga Teachers', 'Yoga'],
  ])('%s ≈ %s', (raw, name) => {
    expect(isWordingVariant(raw, name)).toBe(true);
  });

  it.each([
    ['Root-Cause Chronic Disease', 'Functional Medicine'],
    ['anxiety', 'Stress / Sleep Optimization'],
    ['AO Scan', 'Energy Medicine'],
    ['Certified Crystal Healer', 'Energy Medicine'],
    ['Holistic Health Practitioner', 'Holistic Health Coaching'],
    ['Functional Medicine for Kids', 'Functional Medicine'],
    ['Stress', 'Stress / Sleep Optimization'],
    ['Master', 'Reiki'],
  ])('%s is NOT %s', (raw, name) => {
    expect(isWordingVariant(raw, name)).toBe(false);
  });

  it('never matches on an empty key', () => {
    expect(specialtyMatchKey('  --  ')).toBe('');
    expect(isWordingVariant('--', '..')).toBe(false);
  });
});

describe('specialtyNameFromLabel', () => {
  it('Title Cases the practitioner wording and keeps deliberate capitals', () => {
    expect(specialtyNameFromLabel('mindset and neuroscience to rewire the brain')).toBe(
      'Mindset and Neuroscience to Rewire the Brain',
    );
    expect(specialtyNameFromLabel('anxiety')).toBe('Anxiety');
    expect(specialtyNameFromLabel('AO Scan')).toBe('AO Scan');
    expect(specialtyNameFromLabel('spiritual & chronic-illness support')).toBe(
      'Spiritual & Chronic-Illness Support',
    );
    expect(specialtyNameFromLabel('self-government / relationship mentor')).toBe(
      'Self-Government / Relationship Mentor',
    );
  });
});

describe('resolveOwnSpecialty', () => {
  it('Root-Cause Chronic Disease never resolves to Functional Medicine, even with an alias AND an LLM hint saying so', async () => {
    const db = fakeDb(CATALOG, [
      { label: 'root cause', specialtyId: 'fm' },
      { label: 'root-cause chronic disease', specialtyId: 'fm' },
    ]);
    const r = await resolveOwnSpecialty(db.tx, {
      rawLabel: 'Root-Cause Chronic Disease',
      hint: { slug: 'functional-medicine', name: 'Functional Medicine' },
      aliasSource: 'IMPORT',
      confidence: 0.9,
    });
    expect(r?.specialtyId).not.toBe('fm');
    expect(r?.created).toBe(true);
    const node = db.specialties.find((s) => s.id === r?.specialtyId);
    expect(node).toMatchObject({ name: 'Root-Cause Chronic Disease', status: 'PROPOSED' });
  });

  it("'anxiety' with an alias → Stress / Sleep Optimization creates its own node", async () => {
    const db = fakeDb(CATALOG, [{ label: 'anxiety', specialtyId: 'sso' }]);
    const r = await resolveOwnSpecialty(db.tx, { rawLabel: 'anxiety', aliasSource: 'PRACTITIONER' });
    expect(r?.specialtyId).not.toBe('sso');
    expect(db.specialties.find((s) => s.id === r?.specialtyId)?.name).toBe('Anxiety');
    // The existing search alias is left alone (label is unique), not duplicated or repointed.
    expect(db.aliases.filter((a) => a.label === 'anxiety')).toEqual([
      expect.objectContaining({ specialtyId: 'sso' }),
    ]);
  });

  it.each([
    ['Holistic Health Coach', 'hhc'],
    ['Hypnotist', 'hyp'],
    ['Reiki Master', 'rei'],
    ['functional medicine', 'fm'],
  ])('%s → the existing same-words specialty', async (rawLabel, id) => {
    const db = fakeDb(CATALOG);
    const r = await resolveOwnSpecialty(db.tx, { rawLabel, aliasSource: 'PRACTITIONER' });
    expect(r).toEqual({ specialtyId: id, rawLabel, created: false });
    expect(db.specialties).toHaveLength(CATALOG.length);
  });

  it('an LLM hint to a different concept is ignored', async () => {
    const db = fakeDb(CATALOG);
    const r = await resolveOwnSpecialty(db.tx, {
      rawLabel: 'AO Scan',
      hint: { slug: 'energy-medicine', name: 'Energy Medicine' },
      aliasSource: 'IMPORT',
      confidence: 0.8,
    });
    expect(r?.specialtyId).not.toBe('em');
    expect(db.specialties.find((s) => s.id === r?.specialtyId)?.name).toBe('AO Scan');
    expect(db.aliases).toEqual([
      expect.objectContaining({ label: 'ao scan', source: 'IMPORT', status: 'PENDING', confidence: 0.8 }),
    ]);
  });

  it('a new label is Title Cased and gets a PENDING alias', async () => {
    const db = fakeDb(CATALOG);
    const r = await resolveOwnSpecialty(db.tx, {
      rawLabel: 'mind-body stress release',
      aliasSource: 'PRACTITIONER',
    });
    expect(db.specialties.find((s) => s.id === r?.specialtyId)).toMatchObject({
      name: 'Mind-Body Stress Release',
      slug: 'mind-body-stress-release',
      status: 'PROPOSED',
    });
    expect(r?.rawLabel).toBe('mind-body stress release');
    expect(db.aliases).toEqual([
      expect.objectContaining({ label: 'mind-body stress release', status: 'PENDING' }),
    ]);
  });

  it('a match on a MERGED row follows the admin merge to the surviving specialty', async () => {
    const db = fakeDb([
      ...CATALOG,
      { id: 'tn', slug: 'therapeutic-nutrition', name: 'Therapeutic Nutrition', status: 'ACTIVE' },
      {
        id: 'tnc',
        slug: 'therapeutic-nutritional-counselor',
        name: 'Therapeutic Nutritional Counselor',
        status: 'MERGED',
        mergedIntoId: 'tn',
      },
    ]);
    const r = await resolveOwnSpecialty(db.tx, {
      rawLabel: 'Therapeutic Nutritional Counselor',
      aliasSource: 'PRACTITIONER',
    });
    expect(r).toEqual({ specialtyId: 'tn', rawLabel: 'Therapeutic Nutritional Counselor', created: false });
  });

  it('a live row with the same words beats a merged one', async () => {
    const db = fakeDb([
      { id: 'old', slug: 'reiki-old', name: 'Reiki', status: 'MERGED', mergedIntoId: 'em' },
      ...CATALOG,
    ]);
    const r = await resolveOwnSpecialty(db.tx, { rawLabel: 'reiki', aliasSource: 'PRACTITIONER' });
    expect(r?.specialtyId).toBe('rei');
  });

  it('a broken merge chain is not followed; the label becomes its own node', async () => {
    const db = fakeDb([
      ...CATALOG,
      { id: 'x', slug: 'sound-healing', name: 'Sound Healing', status: 'MERGED', mergedIntoId: 'gone' },
    ]);
    const r = await resolveOwnSpecialty(db.tx, { rawLabel: 'Sound Healing', aliasSource: 'PRACTITIONER' });
    expect(r?.created).toBe(true);
  });

  it('returns null for an empty label', async () => {
    const db = fakeDb(CATALOG);
    expect(await resolveOwnSpecialty(db.tx, { rawLabel: '   ', aliasSource: 'PRACTITIONER' })).toBeNull();
  });
});

describe('template draft (no LLM key)', () => {
  it('never awards a specialty or modality from a mention in the source text', async () => {
    const prev = process.env.ONBOARDING_LLM_API_KEY;
    delete process.env.ONBOARDING_LLM_API_KEY;
    try {
      const { draft } = await draftProfile({
        displayName: 'Test',
        rawSource: "I'm not a yoga teacher and I don't do reiki.",
        canonicalCatalog: [
          ...CATALOG.map(({ slug, name }) => ({ slug, name })),
          { slug: 'yoga', name: 'Yoga' },
        ],
      });
      expect(draft.specialties).toEqual([]);
      expect(draft.modalities).toEqual([]);
    } finally {
      if (prev !== undefined) process.env.ONBOARDING_LLM_API_KEY = prev;
    }
  });

  it('keeps an existing label rather than mapping it to a catalog concept it merely contains', async () => {
    const prev = process.env.ONBOARDING_LLM_API_KEY;
    delete process.env.ONBOARDING_LLM_API_KEY;
    try {
      const { draft, source } = await draftProfile({
        displayName: 'Test',
        rawSource: '',
        existing: { rawLabels: ['Functional Medicine for Kids', 'Holistic Health Coach'] },
        canonicalCatalog: CATALOG.map(({ slug, name }) => ({ slug, name })),
      });
      expect(source).toBe('template');
      expect(draft.specialties).toEqual([
        expect.objectContaining({ rawLabel: 'Functional Medicine for Kids', canonicalName: 'Functional Medicine for Kids' }),
        expect.objectContaining({ rawLabel: 'Holistic Health Coach', canonicalSlug: 'holistic-health-coaching' }),
      ]);
    } finally {
      if (prev !== undefined) process.env.ONBOARDING_LLM_API_KEY = prev;
    }
  });
});
