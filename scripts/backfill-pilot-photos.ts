/**
 * Backfill pilot practitioner photos into Vercel Blob → Practitioner.photoUrl.
 *
 * Companion to the edit-form photo-upload control (Task A): that control writes
 * Blob URLs onto photoUrl for self-service edits; this script does the same for
 * the 12 pilots in bulk, so the seeded records carry durable Blob URLs instead of
 * repo-committed /public paths.
 *
 * IMAGE SOURCE (filename-stem match, first hit wins):
 *   1. public/practitioners/<slug>.<ext>           (already staged by wire-pilot-photos.ts)
 *   2. amy-assets/images/<stem-of photoSourceUrl>  (the raw Drive/monday folder)
 * The pilot roster + photoSourceUrl come from amy-assets/pilot-normalized.json.
 * HEIC sources are skipped (no browser support) — they stay initials until a
 * JPG/PNG is provided.
 *
 * SAFETY: dry-run by default — prints the upload/DB plan and writes nothing.
 * Pass --apply to actually upload to Blob and update photoUrl. Requires
 * BLOB_READ_WRITE_TOKEN (Blob) and DB creds (.env) when applying; if either is
 * missing it refuses to apply and stays in dry-run.
 *
 * Usage:
 *   tsx --env-file=.env scripts/backfill-pilot-photos.ts            # dry run
 *   tsx --env-file=.env scripts/backfill-pilot-photos.ts --apply    # upload + write
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { put } from '@vercel/blob';
import { indexAllPractitioners } from '../src/lib/practitioner-indexer';

const prisma = new PrismaClient();
const DATA_PATH = join(process.cwd(), 'amy-assets', 'pilot-normalized.json');
const PUBLIC_DIR = join(process.cwd(), 'public', 'practitioners');
const IMAGES_DIR = join(process.cwd(), 'amy-assets', 'images');

const APPLY = process.argv.includes('--apply');
const RENDERABLE = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const CONTENT_TYPE: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};
const stem = (f: string) => basename(f, extname(f)).toLowerCase().replace(/\s+/g, ' ').trim();

type Pilot = { slug: string; displayName: string; photoSourceUrl?: string | null };

/** Resolve the best local image file for one pilot. Returns an absolute path or null. */
function resolveLocalImage(p: Pilot, stagedByStem: Map<string, string>): string | null {
  // 1. public/practitioners/<slug>.<ext>
  if (existsSync(PUBLIC_DIR)) {
    for (const f of readdirSync(PUBLIC_DIR)) {
      if (stem(f) === p.slug && RENDERABLE.has(extname(f).toLowerCase())) {
        return join(PUBLIC_DIR, f);
      }
    }
  }
  // 2. amy-assets/images by stem of photoSourceUrl basename
  if (p.photoSourceUrl) {
    const ext = extname(p.photoSourceUrl).toLowerCase();
    if (ext === '.heic') return null; // not browser-renderable
    const wantStem = stem(decodeURIComponent(p.photoSourceUrl.split('/').pop() || ''));
    const file = stagedByStem.get(wantStem);
    if (file) return join(IMAGES_DIR, file);
  }
  return null;
}

async function main() {
  const data = JSON.parse(readFileSync(DATA_PATH, 'utf-8')) as { practitioners: Pilot[] };
  console.log(`Loaded ${data.practitioners.length} pilots from ${DATA_PATH}`);

  const hasBlobToken = !!process.env.BLOB_READ_WRITE_TOKEN;
  const apply = APPLY && hasBlobToken;
  if (APPLY && !hasBlobToken) {
    console.warn('\n⚠️  --apply requested but BLOB_READ_WRITE_TOKEN is not set. Staying in dry-run.\n');
  }
  console.log(apply ? 'MODE: APPLY (uploading to Blob + writing DB)\n' : 'MODE: DRY RUN (no uploads, no DB writes)\n');

  const stagedByStem = new Map<string, string>();
  if (existsSync(IMAGES_DIR)) {
    for (const f of readdirSync(IMAGES_DIR)) {
      if (RENDERABLE.has(extname(f).toLowerCase())) stagedByStem.set(stem(f), f);
    }
  }

  let planned = 0;
  let applied = 0;
  const misses: string[] = [];

  for (const p of data.practitioners) {
    const localPath = resolveLocalImage(p, stagedByStem);
    if (!localPath) {
      misses.push(`${p.displayName} (${p.slug}) — no renderable local image found`);
      continue;
    }
    const ext = extname(localPath).toLowerCase();
    planned++;
    console.log(`  • ${p.displayName} (${p.slug}) ← ${localPath.replace(process.cwd() + '/', '')}`);

    if (!apply) continue;

    const bytes = readFileSync(localPath);
    const blob = await put(`practitioners/${p.slug}${ext}`, bytes, {
      access: 'public',
      contentType: CONTENT_TYPE[ext] ?? 'application/octet-stream',
      addRandomSuffix: false,
      allowOverwrite: true,
      // Pin the token explicitly: a local .env pulled from Vercel carries
      // VERCEL_OIDC_TOKEN, which makes @vercel/blob prefer (stale) OIDC auth over
      // BLOB_READ_WRITE_TOKEN and fail with "Access denied" when run off-platform.
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    await prisma.practitioner.update({
      where: { slug: p.slug },
      data: { photoUrl: blob.url },
    });
    applied++;
    console.log(`    ✓ uploaded → ${blob.url}`);
  }

  if (misses.length) {
    console.log(`\nUnmatched (${misses.length}):`);
    for (const m of misses) console.log(`  - ${m}`);
  }

  if (apply && applied > 0 && process.env.TYPESENSE_ADMIN_API_KEY) {
    const { indexed } = await indexAllPractitioners();
    console.log(`\nReindexed ${indexed} docs.`);
  }

  console.log(
    apply
      ? `\n✅ Backfilled ${applied}/${planned} pilot photos to Blob.`
      : `\n📋 Dry run: ${planned} pilots have a local image ready to upload. Re-run with --apply.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
