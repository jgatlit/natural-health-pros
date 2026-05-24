import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CollectionCreateSchema } from 'typesense/lib/Typesense/Collections';
import { getTypesenseAdmin, TYPESENSE_COLLECTION } from '../src/lib/typesense-server';

async function main() {
  const client = getTypesenseAdmin();
  const schemaPath = join(process.cwd(), 'deployment', 'typesense-collection-schema.json');
  const schema = JSON.parse(readFileSync(schemaPath, 'utf-8')) as CollectionCreateSchema;

  try {
    await client.collections(TYPESENSE_COLLECTION).delete();
    console.log(`Dropped collection "${TYPESENSE_COLLECTION}".`);
  } catch (e) {
    if ((e as Error).message?.includes('Not Found')) {
      console.log('Collection did not exist; proceeding.');
    } else {
      throw e;
    }
  }

  await client.collections().create(schema);
  console.log(`Re-created collection "${TYPESENSE_COLLECTION}".`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
