import type { Prisma } from '@prisma/client';
import { isWordingVariant, normalizeAliasLabel, specialtyNameFromLabel } from './specialty-match';

export type ResolvedSpecialty = { specialtyId: string; rawLabel: string; created: boolean };

type Candidate = {
  id: string;
  slug: string;
  name: string;
  status: 'ACTIVE' | 'PROPOSED' | 'MERGED';
  mergedIntoId: string | null;
};

export function specialtySlug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'specialty'
  );
}

/**
 * Resolve a practitioner's own specialty wording to a Specialty row WITHOUT ever substituting a
 * different concept (operator ruling 2026-10-15):
 *   1. an existing specialty whose name is the label, case-insensitively;
 *   2. an existing specialty whose name is the label in other wording (plural, role suffix…);
 *   3. otherwise a new PROPOSED specialty named from the label, plus a PENDING alias.
 *
 * Aliases are never followed: 'anxiety' → Stress / Sleep Optimization or 'root cause' →
 * Functional Medicine are synonyms for search, not a specialty the practitioner claimed. The same
 * goes for `hint` (an LLM's proposed canonical): it is only honoured when it is itself a wording
 * variant of the label, and then only to choose between equally valid matches.
 *
 * A match on a MERGED row follows its `mergedIntoId`: an admin merge is a human decision, so the
 * surviving specialty stands in for the merged one. A live row of the same words wins over a
 * merged one.
 */
export async function resolveOwnSpecialty(
  tx: Prisma.TransactionClient,
  input: {
    rawLabel: string;
    hint?: { slug?: string | null; name?: string | null };
    aliasSource: 'PRACTITIONER' | 'IMPORT';
    confidence?: number | null;
  },
): Promise<ResolvedSpecialty | null> {
  const rawLabel = input.rawLabel.trim().replace(/\s+/g, ' ');
  if (!rawLabel) return null;

  const candidates: Candidate[] = await tx.specialty.findMany({
    where: { status: { in: ['ACTIVE', 'PROPOSED', 'MERGED'] } },
    select: { id: true, slug: true, name: true, status: true, mergedIntoId: true },
    orderBy: { name: 'asc' },
  });
  const byId = new Map(candidates.map((c) => [c.id, c]));

  /** Follows a merge chain to the surviving row; null if the chain is broken or cyclic. */
  const surviving = (c: Candidate): Candidate | null => {
    let row: Candidate | undefined = c;
    for (let hops = 0; row && row.status === 'MERGED'; hops++) {
      if (hops > 10 || !row.mergedIntoId) return null;
      row = byId.get(row.mergedIntoId);
    }
    return row ?? null;
  };
  /** Live rows first, then merged ones (followed); the first that resolves wins. */
  const pick = (matches: Candidate[]): Candidate | null => {
    for (const c of matches.filter((m) => m.status !== 'MERGED')) return c;
    for (const c of matches) {
      const s = surviving(c);
      if (s) return s;
    }
    return null;
  };

  const exact = pick(candidates.filter((c) => c.name.toLowerCase() === rawLabel.toLowerCase()));
  if (exact) return { specialtyId: exact.id, rawLabel, created: false };

  const variants = candidates.filter((c) => isWordingVariant(rawLabel, c.name));
  const hinted = variants.filter(
    (c) =>
      (input.hint?.slug && c.slug === input.hint.slug) ||
      (input.hint?.name && c.name.toLowerCase() === input.hint.name.trim().toLowerCase()),
  );
  const variant = pick(hinted) ?? pick(variants);
  if (variant) return { specialtyId: variant.id, rawLabel, created: false };

  const name = specialtyNameFromLabel(rawLabel);
  let slug = specialtySlug(name);
  if (await tx.specialty.findUnique({ where: { slug } })) slug = `${slug}-${Date.now().toString(36)}`;
  const created = await tx.specialty.create({ data: { slug, name, status: 'PROPOSED' } });

  // The label is unique. An existing alias for it (pointing at some other concept) is left as the
  // search synonym it is; it just no longer decides what this practitioner holds.
  const label = normalizeAliasLabel(rawLabel);
  if (!(await tx.specialtyAlias.findUnique({ where: { label } }))) {
    await tx.specialtyAlias.create({
      data: {
        label,
        specialtyId: created.id,
        source: input.aliasSource,
        status: 'PENDING',
        confidence: input.confidence ?? null,
      },
    });
  }
  return { specialtyId: created.id, rawLabel, created: true };
}
