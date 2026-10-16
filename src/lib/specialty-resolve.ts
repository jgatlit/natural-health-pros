import type { Prisma } from '@prisma/client';
import { isWordingVariant, normalizeAliasLabel, specialtyNameFromLabel } from './specialty-match';

export type ResolvedSpecialty = { specialtyId: string; rawLabel: string; created: boolean };

type Candidate = { id: string; slug: string; name: string };

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
    where: { status: { in: ['ACTIVE', 'PROPOSED'] } },
    select: { id: true, slug: true, name: true },
    orderBy: { name: 'asc' },
  });

  const exact = candidates.find((c) => c.name.toLowerCase() === rawLabel.toLowerCase());
  if (exact) return { specialtyId: exact.id, rawLabel, created: false };

  const variants = candidates.filter((c) => isWordingVariant(rawLabel, c.name));
  if (variants.length > 0) {
    const hinted = variants.find(
      (c) =>
        (input.hint?.slug && c.slug === input.hint.slug) ||
        (input.hint?.name && c.name.toLowerCase() === input.hint.name.trim().toLowerCase()),
    );
    return { specialtyId: (hinted ?? variants[0]).id, rawLabel, created: false };
  }

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
