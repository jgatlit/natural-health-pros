/**
 * One-time backfill: derive a `tagline` for practitioners who don't have one yet.
 *
 * SAFETY — this script writes EXACTLY ONE field (`tagline`) and nothing else. The generator
 * returns a full ProfileDraft (headline, bio, whoIHelp, specialties…), and every one of those is
 * DISCARDED here. These are live, public pages belonging to real named practitioners, most of
 * whom have never signed in; silently rewriting their bio while "adding a tagline" would be
 * indefensible. Only the new field lands.
 *
 * The source we compress is the practitioner's already-published copy (whoIHelp + bio). That
 * keeps the extractive guarantee intact: the tagline can only ever restate words already on
 * their page — it cannot introduce a claim that wasn't already there.
 *
 * PROPOSE → REVIEW → APPLY, and --apply NEVER calls the LLM.
 *
 * The first cut of this script regenerated on --apply, which meant the text a human reviewed was
 * not necessarily the text that got written (the model is non-deterministic). That makes review
 * theatre. So propose writes every candidate to a JSON file; --apply reads that file back and
 * writes exactly those strings. Edit or delete lines in the file to curate before applying.
 *
 *   npm run taglines:backfill              # propose -> writes taglines-proposal.json, no DB writes
 *   $EDITOR taglines-proposal.json         # curate: fix wording, delete any you reject
 *   npm run taglines:backfill -- --apply   # writes exactly what the file says
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { draftProfile, isLlmConfigured } from '../src/lib/onboarding-draft';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const PROPOSAL_FILE = 'taglines-proposal.json';

async function main() {
  if (APPLY) return applyFromFile();
  if (!isLlmConfigured()) {
    console.error('ONBOARDING_LLM_API_KEY not set — the template path cannot extract a hook, so this would write nothing but nulls. Aborting.');
    process.exit(1);
  }

  const targets = await prisma.practitioner.findMany({
    where: { tagline: null },
    select: {
      id: true,
      slug: true,
      displayName: true,
      headline: true,
      tagline: true,
      whoIHelp: true,
      bio: true,
      specialties: { select: { rawLabel: true } },
    },
    orderBy: { slug: 'asc' },
  });

  const catalog = await prisma.specialty.findMany({
    where: { status: { in: ['ACTIVE', 'PROPOSED'] } },
    select: { slug: true, name: true },
  });

  console.log(`${targets.length} practitioner(s) without a tagline${APPLY ? '' : '  —  DRY RUN (no writes)'}\n`);

  const results: { slug: string; headline: string | null; tagline: string | null }[] = [];

  for (const p of targets) {
    // Compress only what is ALREADY published on their page.
    const rawSource = [p.whoIHelp, p.bio].filter(Boolean).join('\n\n');
    if (!rawSource.trim()) {
      console.log(`  [${p.slug}]  SKIP — no published copy to compress`);
      results.push({ slug: p.slug, headline: p.headline, tagline: null });
      continue;
    }

    const { draft } = await draftProfile({
      displayName: p.displayName,
      rawSource,
      existing: {
        headline: p.headline,
        tagline: p.tagline,
        whoIHelp: p.whoIHelp,
        bio: p.bio,
        rawLabels: p.specialties.map((s) => s.rawLabel?.trim()).filter((s): s is string => !!s),
      },
      canonicalCatalog: catalog,
    });

    // Everything except draft.tagline is intentionally thrown away.
    const tagline = draft.tagline?.trim() || null;
    results.push({ slug: p.slug, headline: p.headline, tagline });

    console.log(`  [${p.slug}]`);
    console.log(`     headline: ${p.headline ?? '(none)'}`);
    console.log(`     tagline : ${tagline ?? '(null — no usable hook; left blank)'}`);
    if (tagline && p.headline && tagline.toLowerCase() === p.headline.toLowerCase()) {
      console.log('     ⚠️  duplicates the headline — reject this one');
    }
    if (tagline && tagline.length > 70) {
      console.log(`     ⚠️  ${tagline.length} chars — over the 70 limit`);
    }
    console.log('');

  }

  const proposed = results.filter((r) => r.tagline);
  writeFileSync(
    PROPOSAL_FILE,
    JSON.stringify(Object.fromEntries(proposed.map((r) => [r.slug, r.tagline])), null, 2) + '\n',
  );
  console.log(`${proposed.length}/${results.length} produced a tagline; ${results.length - proposed.length} left null.`);
  console.log(`\nWrote ${PROPOSAL_FILE}. Curate it (edit wording, delete any you reject), then:`);
  console.log('  npm run taglines:backfill -- --apply');
}

/** Writes exactly what the curated proposal file says. Deliberately does NOT call the LLM: what
 *  was reviewed is what ships. */
async function applyFromFile() {
  if (!existsSync(PROPOSAL_FILE)) {
    console.error(`${PROPOSAL_FILE} not found — run the propose step first and review it.`);
    process.exit(1);
  }
  const approved: Record<string, string> = JSON.parse(readFileSync(PROPOSAL_FILE, 'utf8'));
  let n = 0;
  for (const [slug, tagline] of Object.entries(approved)) {
    if (!tagline?.trim()) continue;
    const r = await prisma.practitioner.updateMany({ where: { slug }, data: { tagline: tagline.trim() } });
    if (r.count) { n++; console.log(`  ✅ ${slug} → ${tagline}`); }
    else console.log(`  ⚠️  ${slug} — no such practitioner`);
  }
  console.log(`\nApplied ${n} tagline(s) from ${PROPOSAL_FILE}. Tagline only — no other field written.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
