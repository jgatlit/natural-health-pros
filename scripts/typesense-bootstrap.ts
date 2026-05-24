import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CollectionCreateSchema } from 'typesense/lib/Typesense/Collections';
import { getTypesenseAdmin, TYPESENSE_COLLECTION } from '../src/lib/typesense-server';

async function main() {
  const client = getTypesenseAdmin();
  const schemaPath = join(process.cwd(), 'deployment', 'typesense-collection-schema.json');
  const schema = JSON.parse(readFileSync(schemaPath, 'utf-8')) as CollectionCreateSchema;

  let exists = false;
  try {
    const current = await client.collections(TYPESENSE_COLLECTION).retrieve();
    exists = true;
    console.log(
      `Collection "${TYPESENSE_COLLECTION}" already exists (${current.num_documents} docs, ${current.fields.length} fields).`,
    );
  } catch {
    exists = false;
  }

  if (!exists) {
    console.log(`Creating collection "${TYPESENSE_COLLECTION}"…`);
    await client.collections().create(schema);
    console.log('Collection created.');
  } else {
    console.log('Skipping create (idempotent). Run typesense:reset to drop+recreate.');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
