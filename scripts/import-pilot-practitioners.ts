/**
 * Pilot practitioner importer — the single ingestion pass for Amy's 12-practitioner V1 list.
 *
 * Reads amy-assets/pilot-normalized.json (the LLM-onboarding output — see P1c; produced
 * write-time by Claude standing in for the programmatic per-practitioner LLM call until an
 * AI Gateway key is provisioned). Source xlsx provenance lives beside it. Both are gitignored
 * (real PII). Idempotent: safe to re-run (upserts by slug/email).
 *
 * Pipeline (P1c):
 *   1. ensure "Virtual Practice" city (operator decision: no location data → placeholder)
 *   2. CUTOVER                  — remove the 18 fictional @example.com practitioners
 *   3. upsert 12 practitioners  — visible records (acceptedAt set) + claimable Invitations (hybrid);
 *                                 each rawLabel resolves to the SAME WORDS via resolveOwnSpecialty
 *   4. reindex Typesense + sync multi-way synonyms
 *
 * Specialties are the practitioners' own words (operator ruling 2026-10-15). The JSON's
 * `canonicalSlug`, `newCanonicals` (with parents) and `laySynonyms` were an LLM's concept mapping
 * ('AO Scan' → Energy Medicine and the like); they are deliberately NOT applied. canonicalSlug is
 * passed only as a tie-break hint between wording variants of the practitioner's own label.
 *
 * Prereq when the Typesense schema changed (added specialtyLabels): run `npm run typesense:reset`
 * BEFORE this so the collection carries the new field (schema-change-needs-reset gotcha).
 *
 * Usage: tsx scripts/import-pilot-practitioners.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { PrismaClient, Role } from '@prisma/client';
import { resolveOwnSpecialty } from '../src/lib/specialty-resolve';
import { indexAllPractitioners } from '../src/lib/practitioner-indexer';
import { syncSpecialtySynonyms } from '../src/lib/typesense-synonyms';

const prisma = new PrismaClient();

const DATA_PATH = join(process.cwd(), 'amy-assets', 'pilot-normalized.json');
const INVITATION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

type SpecialtyEntry = { rawLabel: string; canonicalSlug: string; confidence: number };
type PilotPractitioner = {
  slug: string;
  displayName: string;
  email: string;
  headline: string | null;
  bio: string;
  whoIHelp: string;
  modalities: string[];
  websiteUrl: string | null;
  bookingLink: { url: string; label?: string; provider?: string } | null;
  photoUrl: string | null;
  telehealth: boolean | null;
  inPerson: boolean | null;
  itemId: string;
  specialties: SpecialtyEntry[];
};
type NormalizedData = {
  /** Present in the JSON; intentionally ignored (see the header). */
  newCanonicals?: unknown;
  /** Present in the JSON; intentionally ignored (see the header). */
  laySynonyms?: unknown;
  practitioners: PilotPractitioner[];
};

function newToken(): string {
  return randomBytes(24).toString('base64url');
}

function buildSearchText(p: PilotPractitioner, canonicalNames: string[]): string {
  const rawLabels = p.specialties.map((s) => s.rawLabel);
  return [
    p.displayName,
    p.headline ?? '',
    p.bio,
    p.whoIHelp,
    ...p.modalities,
    ...rawLabels,
    ...canonicalNames,
  ]
    .filter(Boolean)
    .join(' \n ');
}

async function main() {
  const data = JSON.parse(readFileSync(DATA_PATH, 'utf-8')) as NormalizedData;
  console.log(`Loaded ${data.practitioners.length} pilot practitioners from ${DATA_PATH}`);

  // 1. "Virtual Practice" placeholder city (operator decision — no location data in source)
  const city = await prisma.city.upsert({
    where: { slug_state: { slug: 'virtual-practice', state: 'Online' } },
    update: { name: 'Virtual Practice' },
    create: { slug: 'virtual-practice', name: 'Virtual Practice', state: 'Online' },
  });

  // 2. CUTOVER — remove the 18 fictional seed practitioners (cascade drops their practitioner rows)
  const removed = await prisma.user.deleteMany({ where: { email: { endsWith: '@example.com' } } });
  console.log(`Cutover: removed ${removed.count} fictional seed users (+ practitioners via cascade)`);

  // 3. upsert the 12 — visible records (acceptedAt set) + claimable Invitations (hybrid decision)
  const now = new Date();
  for (const p of data.practitioners) {
    const resolved: { specialtyId: string; rawLabel: string }[] = [];
    for (const s of p.specialties) {
      const r = await resolveOwnSpecialty(prisma, {
        rawLabel: s.rawLabel,
        hint: { slug: s.canonicalSlug },
        aliasSource: 'IMPORT',
        confidence: s.confidence,
      });
      if (r && !resolved.some((x) => x.specialtyId === r.specialtyId)) resolved.push(r);
    }
    const specialtyRows = await prisma.specialty.findMany({
      where: { id: { in: resolved.map((r) => r.specialtyId) } },
      select: { name: true },
    });
    const canonicalNames = Array.from(new Set(specialtyRows.map((s) => s.name)));

    const user = await prisma.user.upsert({
      where: { email: p.email },
      update: { name: p.displayName, role: Role.PRACTITIONER },
      create: { email: p.email, name: p.displayName, role: Role.PRACTITIONER },
    });

    const practitioner = await prisma.practitioner.upsert({
      where: { slug: p.slug },
      update: {
        userId: user.id,
        displayName: p.displayName,
        bio: p.bio,
        headline: p.headline,
        whoIHelp: p.whoIHelp,
        websiteUrl: p.websiteUrl,
        // Preserve photos wired by scripts/wire-pilot-photos.ts — only set when the
        // normalized JSON actually carries a photoUrl (null = don't clobber).
        ...(p.photoUrl ? { photoUrl: p.photoUrl } : {}),
        telehealth: p.telehealth ?? undefined,
        inPerson: p.inPerson ?? undefined,
        cityId: city.id,
        searchText: buildSearchText(p, canonicalNames),
        acceptedAt: now, // visible + searchable now (demo); Invitation lets them claim later
        invitedAt: now,
      },
      create: {
        userId: user.id,
        slug: p.slug,
        displayName: p.displayName,
        bio: p.bio,
        headline: p.headline,
        whoIHelp: p.whoIHelp,
        websiteUrl: p.websiteUrl,
        photoUrl: p.photoUrl,
        telehealth: p.telehealth ?? undefined,
        inPerson: p.inPerson ?? undefined,
        cityId: city.id,
        searchText: buildSearchText(p, canonicalNames),
        acceptedAt: now,
        invitedAt: now,
      },
    });

    // specialties (dual-label): rebuild the join with rawLabel preserved
    await prisma.practitionerSpecialty.deleteMany({ where: { practitionerId: practitioner.id } });
    for (let idx = 0; idx < resolved.length; idx++) {
      const r = resolved[idx];
      await prisma.practitionerSpecialty.create({
        data: {
          practitionerId: practitioner.id,
          specialtyId: r.specialtyId,
          rawLabel: r.rawLabel,
          sortOrder: idx,
        },
      });
    }

    // booking link (only Emily's calendly matched the allowlist in normalization)
    await prisma.bookingLink.deleteMany({ where: { practitionerId: practitioner.id } });
    if (p.bookingLink) {
      await prisma.bookingLink.create({
        data: {
          practitionerId: practitioner.id,
          url: p.bookingLink.url,
          label: p.bookingLink.label ?? 'Book a session',
        },
      });
    }

    // claimable Invitation (hybrid): visible now, can self-claim/edit via 2A magic-link later
    const existingInvite = await prisma.invitation.findFirst({
      where: { email: p.email, acceptedAt: null },
    });
    if (!existingInvite) {
      await prisma.invitation.create({
        data: {
          token: newToken(),
          email: p.email,
          expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
        },
      });
    }
  }
  const total = await prisma.practitioner.count();
  console.log(`Upserted ${data.practitioners.length} pilot practitioners (DB total: ${total})`);

  // 4. reindex + synonyms
  if (process.env.TYPESENSE_ADMIN_API_KEY) {
    const { indexed } = await indexAllPractitioners();
    const { groups } = await syncSpecialtySynonyms();
    console.log(`Typesense: reindexed ${indexed} docs, synced ${groups} synonym groups`);
  } else {
    console.log('Typesense skipped (no TYPESENSE_ADMIN_API_KEY)');
  }

  console.log('\n✅ Pilot import complete.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
