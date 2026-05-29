/**
 * Wire pilot practitioner photos from a local image folder → public/ → DB → Typesense.
 *
 * The pilot images live in Amy's Drive folder (jonathan@aichemist.agency, same folder as
 * HHE_Health_Network_Professionals_V1.xlsx). The google-tools MCP can't deliver binary bytes
 * to disk (drive_read returns a placeholder; no download/save-path/permission tool; OAuth is
 * server-side). So the bytes must be staged locally first, then this script wires them.
 *
 * STAGE THE IMAGES (pick one):
 *   A) Drag/download the Drive image folder into amy-assets/images/ (like the xlsx was staged).
 *   B) Link-share the 12 in Drive, then curl each into amy-assets/images/.
 *
 * Then run:  tsx scripts/wire-pilot-photos.ts [imagesDir=amy-assets/images]
 *
 * Match rule (same as the importer): basename of each practitioner's photoSourceUrl, lowercased
 * + extension-stripped, matched against the staged filenames (also lowercased + stripped). Copies
 * to public/practitioners/<slug>.<ext>, sets photoUrl=/practitioners/<slug>.<ext>, reindexes.
 * HEIC (Jill) is skipped → stays initials until a JPG/PNG is provided.
 */
import { readFileSync, readdirSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { indexAllPractitioners } from '../src/lib/practitioner-indexer';

const prisma = new PrismaClient();
const DATA_PATH = join(process.cwd(), 'amy-assets', 'pilot-normalized.json');
const IMAGES_DIR = process.argv[2] || join(process.cwd(), 'amy-assets', 'images');
const PUBLIC_DIR = join(process.cwd(), 'public', 'practitioners');

const RENDERABLE = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const stem = (f: string) => basename(f, extname(f)).toLowerCase().replace(/\s+/g, ' ').trim();

async function main() {
  if (!existsSync(IMAGES_DIR)) {
    console.error(`Images dir not found: ${IMAGES_DIR}\nStage the Drive image folder there first (see header).`);
    process.exit(1);
  }
  mkdirSync(PUBLIC_DIR, { recursive: true });

  const data = JSON.parse(readFileSync(DATA_PATH, 'utf-8')) as {
    practitioners: Array<{ slug: string; displayName: string; photoSourceUrl?: string }>;
  };

  // Index staged files by normalized stem.
  const staged = new Map<string, string>();
  for (const f of readdirSync(IMAGES_DIR)) {
    if (RENDERABLE.has(extname(f).toLowerCase())) staged.set(stem(f), f);
  }
  console.log(`Staged renderable images: ${staged.size} in ${IMAGES_DIR}`);

  let wired = 0;
  const misses: string[] = [];
  for (const p of data.practitioners) {
    if (!p.photoSourceUrl) continue;
    const wantStem = stem(decodeURIComponent(p.photoSourceUrl.split('/').pop() || ''));
    const ext = extname(p.photoSourceUrl).toLowerCase();
    if (ext === '.heic') {
      misses.push(`${p.displayName} (source is .heic — needs JPG/PNG)`);
      continue;
    }
    const file = staged.get(wantStem);
    if (!file) {
      misses.push(`${p.displayName} (no staged file matching “${wantStem}”)`);
      continue;
    }
    const outExt = extname(file).toLowerCase();
    const outName = `${p.slug}${outExt}`;
    copyFileSync(join(IMAGES_DIR, file), join(PUBLIC_DIR, outName));
    await prisma.practitioner.update({
      where: { slug: p.slug },
      data: { photoUrl: `/practitioners/${outName}` },
    });
    wired++;
    console.log(`  ✓ ${p.displayName} → /practitioners/${outName}`);
  }

  if (misses.length) {
    console.log(`\nUnwired (${misses.length}):`);
    for (const m of misses) console.log(`  - ${m}`);
  }

  if (wired > 0 && process.env.TYPESENSE_ADMIN_API_KEY) {
    const { indexed } = await indexAllPractitioners();
    console.log(`\nReindexed ${indexed} docs.`);
  }
  console.log(`\n✅ Wired ${wired} photos.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
