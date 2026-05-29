import type { PrismaClient } from '@prisma/client';

// Genesis canonical specialty taxonomy (V1 dual-label model, Amy 5/29).
// 4 parents + 4 children — the curated, FACETED canonical set. Practitioners' raw
// phrasings map to these via SpecialtyAlias; the LLM onboarding pipeline (step 4)
// proposes new canonicals when a pilot's title doesn't fit. This tree is the seed's
// original taxonomy, KEPT as the genesis set + dual-label/synonym test fixture even
// after the 18 fictional practitioners are removed on cutover.
export const SPECIALTY_TREE: Array<{
  slug: string;
  name: string;
  children: Array<{ slug: string; name: string }>;
}> = [
  {
    slug: 'functional-medicine',
    name: 'Functional Medicine',
    children: [
      { slug: 'hormone-balance', name: 'Hormone Balance' },
      { slug: 'gut-health', name: 'Gut Health' },
    ],
  },
  {
    slug: 'holistic-nutrition',
    name: 'Holistic Nutrition',
    children: [{ slug: 'childrens-holistic-health', name: "Children's Holistic Health" }],
  },
  {
    slug: 'mind-body-coaching',
    name: 'Mind-Body Coaching',
    children: [{ slug: 'stress-sleep-optimization', name: 'Stress / Sleep Optimization' }],
  },
  {
    slug: 'herbal-medicine',
    name: 'Herbal Medicine',
    children: [],
  },
];

// Genesis aliases — APPROVED synonym bridges seeded write-time. Two jobs:
//  1. dual-label test fixture: a practitioner self-labeling "digestive disorders" must be
//     findable under canonical "Gut Health" (Amy's explicit "gut health = digestive disorders").
//  2. SECONDARY-a symptom search (P1d): lay/symptom terms resolve to a canonical via the
//     existing Typesense Synonyms feature — zero query-time LLM.
// `label` is normalized (lowercased, trimmed). These sync to Typesense multi-way synonyms.
export const GENESIS_ALIASES: Array<{ label: string; specialtySlug: string }> = [
  // Gut Health
  { label: 'digestive disorders', specialtySlug: 'gut-health' },
  { label: 'digestion', specialtySlug: 'gut-health' },
  { label: 'bloating', specialtySlug: 'gut-health' },
  { label: 'ibs', specialtySlug: 'gut-health' },
  { label: 'sibo', specialtySlug: 'gut-health' },
  { label: 'leaky gut', specialtySlug: 'gut-health' },
  // Hormone Balance
  { label: 'hormones', specialtySlug: 'hormone-balance' },
  { label: 'pcos', specialtySlug: 'hormone-balance' },
  { label: 'thyroid', specialtySlug: 'hormone-balance' },
  { label: 'perimenopause', specialtySlug: 'hormone-balance' },
  { label: 'menopause', specialtySlug: 'hormone-balance' },
  // Stress / Sleep
  { label: 'anxiety', specialtySlug: 'stress-sleep-optimization' },
  { label: 'stress', specialtySlug: 'stress-sleep-optimization' },
  { label: 'insomnia', specialtySlug: 'stress-sleep-optimization' },
  { label: 'sleep', specialtySlug: 'stress-sleep-optimization' },
  { label: 'burnout', specialtySlug: 'stress-sleep-optimization' },
  { label: 'fatigue', specialtySlug: 'stress-sleep-optimization' },
  // Children's
  { label: 'pediatric', specialtySlug: 'childrens-holistic-health' },
  { label: 'kids', specialtySlug: 'childrens-holistic-health' },
  { label: 'children', specialtySlug: 'childrens-holistic-health' },
  // Nutrition / Herbal / Functional
  { label: 'nutrition', specialtySlug: 'holistic-nutrition' },
  { label: 'diet', specialtySlug: 'holistic-nutrition' },
  { label: 'herbs', specialtySlug: 'herbal-medicine' },
  { label: 'botanical medicine', specialtySlug: 'herbal-medicine' },
  { label: 'root cause', specialtySlug: 'functional-medicine' },
];

// Idempotent upsert of the genesis canonical tree + APPROVED aliases.
// Safe to call from both the seed (test fixture) and the pilot importer (cutover).
export async function seedTaxonomy(prisma: PrismaClient): Promise<Map<string, { id: string; name: string }>> {
  const bySlug = new Map<string, { id: string; name: string }>();

  for (const parent of SPECIALTY_TREE) {
    const parentRow = await prisma.specialty.upsert({
      where: { slug: parent.slug },
      update: { name: parent.name, status: 'ACTIVE' },
      create: { slug: parent.slug, name: parent.name, status: 'ACTIVE' },
    });
    bySlug.set(parent.slug, { id: parentRow.id, name: parentRow.name });

    for (const child of parent.children) {
      const childRow = await prisma.specialty.upsert({
        where: { slug: child.slug },
        update: { name: child.name, status: 'ACTIVE', parentId: parentRow.id },
        create: { slug: child.slug, name: child.name, status: 'ACTIVE', parentId: parentRow.id },
      });
      bySlug.set(child.slug, { id: childRow.id, name: childRow.name });
    }
  }

  for (const alias of GENESIS_ALIASES) {
    const canonical = bySlug.get(alias.specialtySlug);
    if (!canonical) throw new Error(`Genesis alias "${alias.label}" → unknown specialty ${alias.specialtySlug}`);
    await prisma.specialtyAlias.upsert({
      where: { label: alias.label },
      update: { specialtyId: canonical.id, source: 'CURATED', status: 'APPROVED' },
      create: { label: alias.label, specialtyId: canonical.id, source: 'CURATED', status: 'APPROVED' },
    });
  }

  return bySlug;
}
