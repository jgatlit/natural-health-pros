import { prisma } from '../src/lib/prisma';
import { indexAllPractitioners } from '../src/lib/practitioner-indexer';

async function main() {
  console.log('Indexing all practitioners to Typesense…');
  const { indexed } = await indexAllPractitioners();
  console.log(`Indexed ${indexed} practitioners.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
