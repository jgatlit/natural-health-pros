import type { PrismaClient } from '@prisma/client';
import { specialtyNameFromLabel } from '../src/lib/specialty-match';
import { specialtySlug } from '../src/lib/specialty-resolve';

// Specialties are flat and come only from practitioners' own labels (operator ruling 2026-10-15:
// "Specialties should not be awarded/added by the application"). There is no curated tree, no
// parent grouping and no seeded concept-substituting alias; the former genesis tree and its
// symptom aliases ('anxiety' → Stress / Sleep Optimization, 'root cause' → Functional Medicine)
// are gone for that reason.

/** Idempotent upsert of one flat ACTIVE specialty named from a practitioner's own label. */
export async function ensureFlatSpecialty(
  prisma: PrismaClient,
  label: string,
): Promise<{ id: string; name: string }> {
  const name = specialtyNameFromLabel(label);
  const slug = specialtySlug(name);
  const row = await prisma.specialty.upsert({
    where: { slug },
    update: { parentId: null },
    create: { slug, name, status: 'ACTIVE' },
  });
  return { id: row.id, name: row.name };
}
