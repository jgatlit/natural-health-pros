import { prisma } from './prisma';
import { getTypesenseAdmin, TYPESENSE_COLLECTION } from './typesense-server';

// Typesense 30 reworked synonyms into named "Synonym Sets" (the legacy per-collection
// /synonyms endpoint is gone — returns 404). We keep ONE set and attach it to the collection.
export const SYNONYM_SET_NAME = 'hhe-specialties';

/**
 * Sync Neon's dual-label taxonomy → a Typesense Synonym Set.
 *
 * For each canonical specialty we build ONE multi-way synonym item containing:
 *   - the canonical name (e.g. "Gut Health")
 *   - every APPROVED SpecialtyAlias label mapped to it (e.g. "digestive disorders",
 *     and SECONDARY-a symptom terms like "bloating", "ibs")
 *   - every practitioner rawLabel mapped to it (their own voice)
 *
 * Result: a query for any term in the group matches docs containing any other —
 * the "gut health ⇄ digestive disorders" collapse + the zero-query-time-LLM symptom
 * bridge (P1d SECONDARY-a). Decoupled from indexing: rewriting the set is one API call,
 * no reindex (Amy 5/29). Idempotent — safe after every moderation action. The set is
 * attached to the collection so ALL queries (server + InstantSearch) apply it automatically.
 */
export async function syncSpecialtySynonyms(): Promise<{ groups: number }> {
  if (!process.env.TYPESENSE_ADMIN_API_KEY) return { groups: 0 };

  const specialties = await prisma.specialty.findMany({
    where: { status: { in: ['ACTIVE', 'PROPOSED'] } },
    include: {
      aliases: { where: { status: 'APPROVED' } },
      practitioners: { select: { rawLabel: true } },
    },
  });

  const items: Array<{ id: string; synonyms: string[] }> = [];
  for (const s of specialties) {
    const terms = new Set<string>();
    terms.add(s.name);
    for (const a of s.aliases) terms.add(a.label);
    for (const ps of s.practitioners) {
      const raw = ps.rawLabel?.trim();
      if (raw) terms.add(raw);
    }
    const synonyms = Array.from(terms).filter((t) => t && t.trim().length > 0);
    // A 1-term group collapses nothing — skip it.
    if (synonyms.length < 2) continue;
    items.push({ id: `spec-${s.slug}`, synonyms });
  }

  const client = getTypesenseAdmin();
  // Replace the whole set (upsert is a full rewrite of items).
  await client.synonymSets(SYNONYM_SET_NAME).upsert({ items });
  // Attach the set to the collection so every query uses it (no per-query param needed).
  await client.collections(TYPESENSE_COLLECTION).update({ synonym_sets: [SYNONYM_SET_NAME] });

  return { groups: items.length };
}
