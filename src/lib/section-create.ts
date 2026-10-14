import type { Prisma } from '@prisma/client';
import type { SectionWrite } from '@/lib/custom-sections';

/**
 * The cap-enforcing create, extracted so its ORDER can be asserted: lock the practitioner row,
 * THEN count, THEN insert. Run it inside an interactive transaction (one connection); the row lock
 * serialises concurrent creates for the same practitioner, so the count each one sees includes
 * every earlier committed create.
 *
 * `FOR NO KEY UPDATE` serialises creators against each other without blocking other transactions
 * that take FOR KEY SHARE on the Practitioner row through their foreign keys.
 *
 * Returns false when the cap is already reached. Real concurrency is not covered by tests (they
 * assert call order against a mock), only the ordering that makes the lock effective.
 */
export async function createSectionWithinCap(
  tx: Prisma.TransactionClient,
  practitionerId: string,
  data: SectionWrite,
  max: number,
): Promise<boolean> {
  await tx.$queryRaw`SELECT id FROM "Practitioner" WHERE id = ${practitionerId} FOR NO KEY UPDATE`;
  const existing = await tx.profileSection.findMany({
    where: { practitionerId },
    select: { sortOrder: true },
    orderBy: { sortOrder: 'desc' },
  });
  if (existing.length >= max) return false;
  await tx.profileSection.create({
    data: { practitionerId, ...data, sortOrder: (existing[0]?.sortOrder ?? -1) + 1 },
  });
  return true;
}
