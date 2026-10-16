import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Action-level proof of the own-words rule (operator ruling 2026-10-15), through the real server
 * actions and the real resolver, against an in-memory database:
 *   - a free-text save never follows an alias to a different concept (resolveSelection);
 *   - "Generate draft" keeps every specialty the practitioner already holds on the node it is on.
 */

type Spec = { id: string; slug: string; name: string; status: string; mergedIntoId: string | null };
type Alias = { id: string; label: string; specialtyId: string; source: string; status: string };
type Link = { specialtyId: string; rawLabel: string | null };

const db = vi.hoisted(() => ({
  specialties: [] as Spec[],
  aliases: [] as Alias[],
  held: [] as Link[],
  updates: [] as Record<string, unknown>[],
  draft: null as unknown,
}));

const UPDATED_AT = new Date('2026-10-15T12:00:00.000Z');

const fake = vi.hoisted(() => {
  const client = {
    practitioner: {
      findUnique: async () => ({
        id: 'p_kj',
        userId: 'u_kj',
        slug: 'kellie-johnston',
        displayName: 'Kellie Johnston',
        headline: null,
        tagline: null,
        whoIHelp: null,
        bio: null,
        updatedAt: new Date('2026-10-15T12:00:00.000Z'),
        specialties: db.held.map((h) => ({ ...h })),
      }),
      update: async (q: { data: Record<string, unknown> }) => {
        db.updates.push(q.data);
        return {};
      },
    },
    specialty: {
      findMany: async (q: { where: { status?: { in: string[] }; id?: { in: string[] } } }) =>
        db.specialties.filter(
          (s) =>
            (!q.where.status || q.where.status.in.includes(s.status)) &&
            (!q.where.id || q.where.id.in.includes(s.id)),
        ),
      findUnique: async (q: { where: { slug: string } }) =>
        db.specialties.find((s) => s.slug === q.where.slug) ?? null,
      create: async (q: { data: { slug: string; name: string; status: string } }) => {
        const row = { id: `new_${q.data.slug}`, mergedIntoId: null, ...q.data };
        db.specialties.push(row);
        return row;
      },
    },
    specialtyAlias: {
      findUnique: async (q: { where: { label: string } }) =>
        db.aliases.find((a) => a.label === q.where.label) ?? null,
      create: async (q: { data: Omit<Alias, 'id'> }) => {
        const row = { id: `alias_${db.aliases.length}`, ...q.data };
        db.aliases.push(row);
        return row;
      },
    },
    practitionerSpecialty: { deleteMany: async () => ({ count: 0 }) },
    caseStudy: { deleteMany: async () => ({ count: 0 }), create: async () => ({}) },
    whopProduct: { updateMany: async () => ({ count: 0 }) },
    bookingLink: {
      deleteMany: async () => ({ count: 0 }),
      updateMany: async () => ({ count: 0 }),
      create: async () => ({ id: 'bl' }),
    },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(client),
  };
  return client;
});

vi.mock('@/auth', () => ({ auth: async () => ({ user: { id: 'u_kj', role: 'PRACTITIONER' } }) }));
vi.mock('@/lib/prisma', () => ({ prisma: fake }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureMessage: vi.fn() }));
vi.mock('@/lib/whop', () => ({ WHOP_OFFERING_TITLE_MAX: 80 }));
vi.mock('@/lib/typesense-server', () => ({ TYPESENSE_COLLECTION: 'practitioners', getTypesenseAdmin: vi.fn() }));
vi.mock('@/lib/practitioner-indexer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/practitioner-indexer')>()),
  indexPractitioner: vi.fn(async () => undefined),
}));
vi.mock('@/lib/typesense-synonyms', () => ({ syncSpecialtySynonyms: vi.fn(async () => undefined) }));
vi.mock('@/lib/onboarding-draft', () => ({ draftProfile: vi.fn(async () => db.draft) }));
vi.mock('@/lib/email', () => ({ sendEmail: vi.fn(), normalizeEmail: (s: string) => s, escapeHtml: (s: string) => s }));
vi.mock('@/lib/rate-limit', () => ({ rateLimit: vi.fn() }));
vi.mock('@/lib/platform-settings', () => ({ loadSettings: vi.fn() }));
vi.mock('@/lib/client-list', () => ({ addClientEntries: vi.fn() }));
vi.mock('@/lib/referrals', () => ({ createEmailReferral: vi.fn(), createReferralLink: vi.fn(), referralUrl: vi.fn() }));

import { generateDraftAction, updatePractitioner } from '@/app/practitioners/[slug]/edit/actions';

const spec = (id: string, slug: string, name: string, status = 'ACTIVE', mergedIntoId: string | null = null): Spec => ({
  id,
  slug,
  name,
  status,
  mergedIntoId,
});

/** The specialty links written by the (single) practitioner.update that carries them. */
function writtenLinks(): { specialtyId: string; rawLabel: string | null; sortOrder: number }[] {
  const withLinks = db.updates.find((u) => u.specialties) as
    | { specialties: { create: { rawLabel: string | null; sortOrder: number; specialty: { connect: { id: string } } }[] } }
    | undefined;
  if (!withLinks) throw new Error('no specialty write');
  return withLinks.specialties.create.map((c) => ({
    specialtyId: c.specialty.connect.id,
    rawLabel: c.rawLabel,
    sortOrder: c.sortOrder,
  }));
}

beforeEach(() => {
  db.specialties = [
    spec('s_sso', 'stress-sleep-optimization', 'Stress / Sleep Optimization'),
    spec('s_hhc', 'holistic-health-coaching', 'Holistic Health Coaching'),
    spec('s_hhp', 'holistic-health-practitioner', 'Holistic Health Practitioner'),
    spec('s_tn', 'therapeutic-nutrition', 'Therapeutic Nutrition'),
    spec('s_em', 'energy-medicine', 'Energy Medicine'),
  ];
  db.aliases = [
    { id: 'a1', label: 'anxiety', specialtyId: 's_sso', source: 'CURATED', status: 'APPROVED' },
    { id: 'a2', label: 'ao scan', specialtyId: 's_em', source: 'IMPORT', status: 'APPROVED' },
  ];
  db.held = [];
  db.updates = [];
  db.draft = null;
});

describe('updatePractitioner (free-text save → resolveSelection)', () => {
  function form(selections: { specialtyId: string | null; rawLabel: string }[]) {
    const f = new FormData();
    f.set('profileUpdatedAt', UPDATED_AT.toISOString());
    f.set('displayName', 'Kellie Johnston');
    f.set('specialtiesJson', JSON.stringify(selections));
    return f;
  }

  it("does not follow the alias 'anxiety' → Stress / Sleep Optimization; the practitioner gets her own node", async () => {
    await expect(
      updatePractitioner('kellie-johnston', form([{ specialtyId: null, rawLabel: 'anxiety' }])),
    ).rejects.toThrow('REDIRECT:/practitioners/kellie-johnston/edit?saved=1');
    const [link] = writtenLinks();
    expect(link.specialtyId).not.toBe('s_sso');
    expect(db.specialties.find((s) => s.id === link.specialtyId)).toMatchObject({
      name: 'Anxiety',
      status: 'PROPOSED',
    });
    expect(link.rawLabel).toBe('anxiety');
  });

  it('an explicit pick of an existing specialty is kept as picked', async () => {
    await expect(
      updatePractitioner(
        'kellie-johnston',
        form([{ specialtyId: 's_sso', rawLabel: 'Stress / Sleep Optimization' }]),
      ),
    ).rejects.toThrow('saved=1');
    expect(writtenLinks()).toEqual([
      { specialtyId: 's_sso', rawLabel: 'Stress / Sleep Optimization', sortOrder: 0 },
    ]);
  });
});

describe('generateDraftAction keeps held specialties where they are', () => {
  it("Kellie's BC-HHP → holistic-health-practitioner and 'Therapeutic Nutritional Counselor' → therapeutic-nutrition survive a draft regeneration", async () => {
    db.held = [
      { specialtyId: 's_hhp', rawLabel: 'Board Certified Holistic Health Practitioner (BC-HHP)' },
      { specialtyId: 's_tn', rawLabel: 'Therapeutic Nutritional Counselor' },
    ];
    db.draft = {
      source: 'llm',
      draft: {
        headline: 'h',
        tagline: null,
        whoIHelp: 'w',
        bio: 'b',
        modalities: [],
        qualifications: [],
        caseStudies: [],
        // The LLM echoes the held labels back (one with a misleading hint) and adds a new one.
        specialties: [
          {
            rawLabel: 'Board Certified Holistic Health Practitioner (BC-HHP)',
            canonicalSlug: 'holistic-health-coaching',
            canonicalName: 'Holistic Health Coaching',
            confidence: 0.9,
          },
          {
            rawLabel: 'therapeutic nutritional counselor',
            canonicalSlug: 'therapeutic-nutritional-counselor',
            canonicalName: 'Therapeutic Nutritional Counselor',
            confidence: 0.7,
          },
          { rawLabel: 'AO Scan', canonicalSlug: 'energy-medicine', canonicalName: 'Energy Medicine', confidence: 0.8 },
        ],
      },
    };
    const before = db.specialties.length;

    await expect(generateDraftAction('kellie-johnston', new FormData())).rejects.toThrow(
      'REDIRECT:/practitioners/kellie-johnston/edit?drafted=1',
    );

    const links = writtenLinks();
    expect(links.slice(0, 2)).toEqual([
      { specialtyId: 's_hhp', rawLabel: 'Board Certified Holistic Health Practitioner (BC-HHP)', sortOrder: 0 },
      { specialtyId: 's_tn', rawLabel: 'Therapeutic Nutritional Counselor', sortOrder: 1 },
    ]);
    // Only the genuinely new label is resolved: its own node, not the alias/LLM's Energy Medicine.
    expect(links).toHaveLength(3);
    expect(links[2].specialtyId).not.toBe('s_em');
    expect(db.specialties.find((s) => s.id === links[2].specialtyId)?.name).toBe('AO Scan');
    expect(db.specialties.length).toBe(before + 1);
  });

  it('a held specialty the draft omits is not deleted', async () => {
    db.held = [{ specialtyId: 's_tn', rawLabel: 'Therapeutic Nutritional Counselor' }];
    db.draft = {
      source: 'template',
      draft: {
        headline: 'h', tagline: null, whoIHelp: 'w', bio: 'b',
        modalities: [], qualifications: [], caseStudies: [], specialties: [],
      },
    };
    await expect(generateDraftAction('kellie-johnston', new FormData())).rejects.toThrow('drafted=1');
    expect(writtenLinks()).toEqual([
      { specialtyId: 's_tn', rawLabel: 'Therapeutic Nutritional Counselor', sortOrder: 0 },
    ]);
  });
});
