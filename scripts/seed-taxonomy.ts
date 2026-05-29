// Standalone runner: upsert the genesis canonical taxonomy + APPROVED aliases.
// Idempotent + additive (no deletes) — safe to run against any environment.
// Usage: tsx scripts/seed-taxonomy.ts
import { PrismaClient } from '@prisma/client';
import { seedTaxonomy } from '../prisma/taxonomy';

const prisma = new PrismaClient();

async function main() {
  const bySlug = await seedTaxonomy(prisma);
  const aliases = await prisma.specialtyAlias.count({ where: { status: 'APPROVED' } });
  const canonical = await prisma.specialty.count({ where: { status: 'ACTIVE' } });
  console.log(`Genesis taxonomy upserted: ${bySlug.size} canonical nodes, ${canonical} ACTIVE specialties, ${aliases} APPROVED aliases.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
