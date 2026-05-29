// Standalone runner: sync Neon's dual-label taxonomy → Typesense multi-way synonyms.
// Idempotent; no reindex needed. Usage: npm run typesense:synonyms
import { prisma } from '../src/lib/prisma';
import { syncSpecialtySynonyms } from '../src/lib/typesense-synonyms';

async function main() {
  const { groups } = await syncSpecialtySynonyms();
  console.log(`Synced ${groups} synonym groups.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
