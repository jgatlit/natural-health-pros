'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import type { Prisma } from '@prisma/client';
// ⚠️ TEMP — re-enable this import together with the authorizeForSlug ownership gate.
// import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { indexPractitioner } from '@/lib/practitioner-indexer';
import { syncSpecialtySynonyms } from '@/lib/typesense-synonyms';
import { draftProfile, type DraftSpecialty } from '@/lib/onboarding-draft';

async function authorizeForSlug(slug: string) {
  // ⚠️ TEMP — auth gates disabled for seamless HHE testing (operator request 2026-07-09).
  // Magic-link retained as the auth method; session + ownership gates off.
  // Re-enable per docs/AUTH-GATES-DISABLED-REVERT.md.
  // const session = await auth();
  // if (!session?.user?.id) {
  //   redirect(`/auth/signin?callbackUrl=/practitioners/${slug}/edit`);
  // }
  const practitioner = await prisma.practitioner.findUnique({
    where: { slug },
    select: { id: true, userId: true },
  });
  if (!practitioner) {
    redirect('/auth/error?error=AccessDenied');
  }
  // const isOwner = practitioner.userId === session.user.id;
  // const isAdmin = session.user.role === 'ADMIN';
  // if (!isOwner && !isAdmin) {
  //   redirect('/auth/error?error=AccessDenied');
  // }
  return practitioner;
}

function buildSearchText(parts: (string | null | undefined)[]): string {
  return parts.filter((p) => p && p.trim()).join(' \n ');
}

const normLabel = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'specialty';
}

type RawSelection = { specialtyId: string | null; rawLabel: string };

/**
 * Resolve one combobox selection → a canonical specialtyId + the practitioner's rawLabel.
 * - Picked canonical → use it.
 * - Free-text that matches an existing alias/canonical (normalized) → reuse that canonical.
 * - Genuinely novel free-text → create a PROPOSED canonical + PENDING alias (the
 *   /admin/specialties moderation queue). Practitioner goes live immediately, never blocked.
 * Returns null when the rawLabel is empty.
 */
async function resolveSelection(
  tx: Prisma.TransactionClient,
  sel: RawSelection,
): Promise<{ specialtyId: string; rawLabel: string } | null> {
  const rawLabel = sel.rawLabel.trim();
  if (!rawLabel) return null;
  if (sel.specialtyId) return { specialtyId: sel.specialtyId, rawLabel };

  const label = normLabel(rawLabel);

  const alias = await tx.specialtyAlias.findUnique({ where: { label } });
  if (alias) return { specialtyId: alias.specialtyId, rawLabel };

  const byName = await tx.specialty.findFirst({
    where: { name: { equals: rawLabel, mode: 'insensitive' } },
  });
  if (byName) return { specialtyId: byName.id, rawLabel };

  // Novel — create a PROPOSED canonical (unique slug) + PENDING alias.
  let slug = slugify(rawLabel);
  if (await tx.specialty.findUnique({ where: { slug } })) slug = `${slug}-${Date.now().toString(36)}`;
  const created = await tx.specialty.create({
    data: { slug, name: rawLabel, status: 'PROPOSED' },
  });
  await tx.specialtyAlias.create({
    data: { label, specialtyId: created.id, source: 'PRACTITIONER', status: 'PENDING' },
  });
  return { specialtyId: created.id, rawLabel };
}

function normalizeUrl(raw: string, allowlist: string[]): string | null {
  if (!raw) return null;
  let candidate = raw.trim();
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const knownish = allowlist.some((h) => host === h || host.endsWith(`.${h}`));
    if (!knownish && !host.includes('.')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

const BOOKING_HOSTS = [
  'cal.com',
  'app.cal.com',
  'calendly.com',
  'savvycal.com',
  'tidycal.com',
  'koalendar.com',
  'youcanbookme.com',
  'acuityscheduling.com',
];

function normalizeBookingUrl(raw: string): string | null {
  return normalizeUrl(raw, BOOKING_HOSTS);
}

// Website is an open field (any host) — accept any valid http(s) URL, null when blank/invalid.
function normalizeWebsiteUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return normalizeUrl(trimmed, []);
}

// Approx city centroids for the haversine "near me" index — Phase 2.5 can add
// per-practitioner overrides. Shared by updatePractitioner + submitOnboarding.
const CITY_COORDS: Record<string, [number, number]> = {
  atlanta: [33.749, -84.388],
  savannah: [32.0809, -81.0912],
  athens: [33.9519, -83.3576],
  macon: [32.8407, -83.6324],
  augusta: [33.4735, -82.0105],
  decatur: [33.7748, -84.2963],
  asheville: [35.5951, -82.5515],
  boulder: [40.015, -105.2705],
  austin: [30.2672, -97.7431],
  portland: [45.5152, -122.6784],
  nashville: [36.1627, -86.7816],
  charleston: [32.7765, -79.9311],
  sedona: [34.8697, -111.761],
};

export async function updatePractitioner(slug: string, formData: FormData): Promise<void> {
  const target = await authorizeForSlug(slug);

  const displayName = String(formData.get('displayName') ?? '').trim();
  const bio = String(formData.get('bio') ?? '').trim();
  const headline = String(formData.get('headline') ?? '').trim() || null;
  const whoIHelp = String(formData.get('whoIHelp') ?? '').trim() || null;
  const websiteUrl = normalizeWebsiteUrl(String(formData.get('websiteUrl') ?? ''));
  const telehealth = formData.get('telehealth') === 'on' || formData.get('telehealth') === 'true';
  const inPerson = formData.get('inPerson') === 'on' || formData.get('inPerson') === 'true';
  const cityId = String(formData.get('cityId') ?? '').trim() || null;
  const photoUrl = String(formData.get('photoUrl') ?? '').trim() || null;
  const yearsRaw = String(formData.get('yearsInPractice') ?? '').trim();
  const yearsInPractice = yearsRaw === '' ? null : Math.max(0, parseInt(yearsRaw, 10) || 0);

  let rawSelections: RawSelection[] = [];
  try {
    const parsed = JSON.parse(String(formData.get('specialtiesJson') ?? '[]'));
    if (Array.isArray(parsed)) {
      rawSelections = parsed
        .map((p) => ({
          specialtyId: typeof p.specialtyId === 'string' ? p.specialtyId : null,
          rawLabel: typeof p.rawLabel === 'string' ? p.rawLabel : '',
        }))
        .filter((p) => p.rawLabel.trim());
    }
  } catch {
    rawSelections = [];
  }

  if (!displayName) {
    redirect(`/practitioners/${slug}/edit?error=name-required`);
  }

  // Booking links: paired bookingLabel/bookingUrl rows zipped by index. Skip empty
  // rows, validate each URL against the provider allowlist, dedupe by normalized URL.
  const bookingLabels = formData.getAll('bookingLabel').map((s) => String(s));
  const bookingUrlsRaw = formData.getAll('bookingUrl').map((s) => String(s).trim());
  const bookingLinks: { label: string | null; url: string }[] = [];
  const seenBookingUrls = new Set<string>();
  for (let i = 0; i < bookingUrlsRaw.length; i++) {
    const raw = bookingUrlsRaw[i];
    if (!raw) continue;
    const url = normalizeBookingUrl(raw);
    if (!url) {
      redirect(`/practitioners/${slug}/edit?error=invalid-booking-url`);
    }
    if (seenBookingUrls.has(url)) continue;
    seenBookingUrls.add(url);
    const label = (bookingLabels[i] ?? '').trim() || null;
    bookingLinks.push({ label, url });
  }

  // City coords for haversine
  const city = cityId
    ? await prisma.city.findUnique({ where: { id: cityId } })
    : null;

  const coords = city ? CITY_COORDS[city.slug] ?? null : null;

  let createdNewTaxonomy = false;

  await prisma.$transaction(async (tx) => {
    // Resolve combobox selections → canonical ids (+ create PROPOSED/PENDING for novel terms)
    const resolved: { specialtyId: string; rawLabel: string }[] = [];
    const seen = new Set<string>();
    for (const sel of rawSelections) {
      const before = await tx.specialty.count();
      const r = await resolveSelection(tx, sel);
      if (!r || seen.has(r.specialtyId)) continue;
      if ((await tx.specialty.count()) > before) createdNewTaxonomy = true;
      seen.add(r.specialtyId);
      resolved.push(r);
    }

    // Canonical names (+ parents) for searchText
    const specialtyRows = await tx.specialty.findMany({
      where: { id: { in: resolved.map((r) => r.specialtyId) } },
      include: { parent: true },
    });
    const canonicalNames = Array.from(
      new Set(specialtyRows.flatMap((s) => (s.parent ? [s.name, s.parent.name] : [s.name]))),
    );
    const rawLabels = resolved.map((r) => r.rawLabel);

    await tx.practitionerSpecialty.deleteMany({ where: { practitionerId: target.id } });
    await tx.bookingLink.deleteMany({ where: { practitionerId: target.id } });
    await tx.practitioner.update({
      where: { id: target.id },
      data: {
        displayName,
        bio: bio || null,
        photoUrl,
        headline,
        whoIHelp,
        websiteUrl,
        telehealth,
        inPerson,
        cityId,
        latitude: coords?.[0] ?? null,
        longitude: coords?.[1] ?? null,
        yearsInPractice,
        searchText: buildSearchText([
          displayName,
          headline,
          bio,
          whoIHelp,
          city?.name,
          city?.state,
          ...rawLabels,
          ...canonicalNames,
        ]),
        specialties: {
          create: resolved.map((r) => ({
            rawLabel: r.rawLabel,
            specialty: { connect: { id: r.specialtyId } },
          })),
        },
        bookingLinks: {
          create: bookingLinks.map((b, idx) => ({
            label: b.label,
            url: b.url,
            sortOrder: idx,
          })),
        },
      },
    });
  });

  await indexPractitioner(target.id).catch((err) =>
    console.error('Typesense reindex failed:', err),
  );
  // New rawLabels / proposed canonicals change the synonym groups — resync (cheap, no reindex).
  if (createdNewTaxonomy || rawSelections.length > 0) {
    await syncSpecialtySynonyms().catch((err) =>
      console.error('Typesense synonym sync failed:', err),
    );
  }

  revalidatePath(`/practitioners/${slug}`);
  revalidatePath(`/practitioners/${slug}/edit`);
  revalidatePath('/');
  revalidatePath('/search');
  redirect(`/practitioners/${slug}/edit?saved=1`);
}

/**
 * Resolve one AI-drafted specialty → canonical id, writing the proposed mapping as
 * an IMPORT/PENDING SpecialtyAlias with the LLM confidence (Task B spec). Mirrors
 * resolveSelection but the proposal always lands in the moderation queue (PENDING)
 * with source=IMPORT, and novel canonicals are created PROPOSED.
 */
async function resolveDraftSpecialty(
  tx: Prisma.TransactionClient,
  d: DraftSpecialty,
): Promise<{ specialtyId: string; rawLabel: string } | null> {
  const rawLabel = d.rawLabel.trim();
  if (!rawLabel) return null;
  const label = normLabel(rawLabel);

  // Already-known phrasing → reuse its canonical (don't disturb an approved alias).
  const existingAlias = await tx.specialtyAlias.findUnique({ where: { label } });
  if (existingAlias) return { specialtyId: existingAlias.specialtyId, rawLabel };

  // Map to the proposed canonical: by slug, then by name, else create a PROPOSED node.
  let canonical =
    (await tx.specialty.findUnique({ where: { slug: d.canonicalSlug } })) ||
    (await tx.specialty.findFirst({
      where: { name: { equals: d.canonicalName, mode: 'insensitive' } },
    }));
  if (!canonical) {
    let slug = slugify(d.canonicalSlug || d.canonicalName);
    if (await tx.specialty.findUnique({ where: { slug } })) {
      slug = `${slug}-${Date.now().toString(36)}`;
    }
    canonical = await tx.specialty.create({
      data: { slug, name: d.canonicalName || rawLabel, status: 'PROPOSED' },
    });
  }

  await tx.specialtyAlias.create({
    data: {
      label,
      specialtyId: canonical.id,
      source: 'IMPORT',
      status: 'PENDING',
      confidence: d.confidence,
    },
  });
  return { specialtyId: canonical.id, rawLabel };
}

/**
 * AI onboarding DRAFT step (Task B). Reads the practitioner's raw self-description,
 * drafts profile fields via the LLM (or template fallback), and persists them as a
 * reviewable starting point — the practitioner then edits/overrides each field in the
 * form below and clicks Save to publish. Drafted specialties write IMPORT/PENDING
 * aliases (moderation queue); drafted case studies are persisted for review/removal.
 */
export async function generateDraftAction(slug: string, formData: FormData): Promise<void> {
  const target = await authorizeForSlug(slug);
  const rawSource = String(formData.get('draftSource') ?? '').trim();

  const [practitioner, catalog] = await Promise.all([
    prisma.practitioner.findUnique({
      where: { id: target.id },
      select: {
        displayName: true,
        headline: true,
        whoIHelp: true,
        bio: true,
        specialties: { select: { rawLabel: true } },
      },
    }),
    prisma.specialty.findMany({
      where: { status: { in: ['ACTIVE', 'PROPOSED'] } },
      select: { slug: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ]);
  if (!practitioner) redirect('/auth/error?error=AccessDenied');

  const { draft, source } = await draftProfile({
    displayName: practitioner.displayName,
    rawSource,
    existing: {
      headline: practitioner.headline,
      whoIHelp: practitioner.whoIHelp,
      bio: practitioner.bio,
      rawLabels: practitioner.specialties
        .map((s) => s.rawLabel?.trim())
        .filter((s): s is string => !!s),
    },
    canonicalCatalog: catalog,
  });

  await prisma.$transaction(async (tx) => {
    const resolved: { specialtyId: string; rawLabel: string }[] = [];
    const seen = new Set<string>();
    for (const d of draft.specialties) {
      const r = await resolveDraftSpecialty(tx, d);
      if (!r || seen.has(r.specialtyId)) continue;
      seen.add(r.specialtyId);
      resolved.push(r);
    }

    const specialtyRows = await tx.specialty.findMany({
      where: { id: { in: resolved.map((r) => r.specialtyId) } },
      include: { parent: true },
    });
    const canonicalNames = Array.from(
      new Set(specialtyRows.flatMap((s) => (s.parent ? [s.name, s.parent.name] : [s.name]))),
    );

    await tx.practitionerSpecialty.deleteMany({ where: { practitionerId: target.id } });
    await tx.practitioner.update({
      where: { id: target.id },
      data: {
        headline: draft.headline || null,
        whoIHelp: draft.whoIHelp || null,
        bio: draft.bio || null,
        searchText: buildSearchText([
          practitioner.displayName,
          draft.headline,
          draft.bio,
          draft.whoIHelp,
          ...draft.modalities,
          ...draft.specialties.map((s) => s.rawLabel),
          ...canonicalNames,
        ]),
        specialties: {
          create: resolved.map((r) => ({
            rawLabel: r.rawLabel,
            specialty: { connect: { id: r.specialtyId } },
          })),
        },
      },
    });

    // Replace any prior AI-drafted case studies with the fresh draft (reviewable below).
    await tx.caseStudy.deleteMany({ where: { practitionerId: target.id } });
    for (const cs of draft.caseStudies) {
      await tx.caseStudy.create({
        data: {
          practitionerId: target.id,
          title: cs.title,
          summary: cs.summary,
          outcome: cs.outcome ?? null,
          anonymized: true,
        },
      });
    }
  });

  await indexPractitioner(target.id).catch((err) =>
    console.error('Typesense reindex failed:', err),
  );
  await syncSpecialtySynonyms().catch((err) =>
    console.error('Typesense synonym sync failed:', err),
  );

  revalidatePath(`/practitioners/${slug}/edit`);
  redirect(`/practitioners/${slug}/edit?drafted=1&source=${source}`);
}

/** Remove one AI-drafted case study during review. */
export async function removeCaseStudy(slug: string, caseStudyId: string): Promise<void> {
  const target = await authorizeForSlug(slug);
  await prisma.caseStudy.deleteMany({ where: { id: caseStudyId, practitionerId: target.id } });
  revalidatePath(`/practitioners/${slug}/edit`);
  redirect(`/practitioners/${slug}/edit`);
}

/**
 * Onboarding submit (Phase 1). The onboarding form collects the basics + a free-text
 * "describe your practice", then this action ONE-SHOT generates the landing page:
 * persists the structured basics + user-picked specialties, runs draftProfile() to
 * normalize the description into headline/whoIHelp/bio (+ modalities, case studies),
 * then sends the practitioner to their freshly generated public page. Works for both
 * the pre-filled (revise → regenerate) and blank (fill → generate) invite cases;
 * ongoing field-level edits happen afterward in the admin portal (updatePractitioner).
 */
export async function submitOnboarding(slug: string, formData: FormData): Promise<void> {
  const target = await authorizeForSlug(slug);

  const displayName = String(formData.get('displayName') ?? '').trim();
  if (!displayName) {
    redirect(`/practitioners/${slug}/edit?error=name-required`);
  }
  const cityId = String(formData.get('cityId') ?? '').trim() || null;
  const telehealth = formData.get('telehealth') === 'on' || formData.get('telehealth') === 'true';
  const inPerson = formData.get('inPerson') === 'on' || formData.get('inPerson') === 'true';
  const yearsRaw = String(formData.get('yearsInPractice') ?? '').trim();
  const yearsInPractice = yearsRaw === '' ? null : Math.max(0, parseInt(yearsRaw, 10) || 0);
  const draftSource = String(formData.get('draftSource') ?? '').trim();

  let rawSelections: RawSelection[] = [];
  try {
    const parsed = JSON.parse(String(formData.get('specialtiesJson') ?? '[]'));
    if (Array.isArray(parsed)) {
      rawSelections = parsed
        .map((p) => ({
          specialtyId: typeof p.specialtyId === 'string' ? p.specialtyId : null,
          rawLabel: typeof p.rawLabel === 'string' ? p.rawLabel : '',
        }))
        .filter((p) => p.rawLabel.trim());
    }
  } catch {
    rawSelections = [];
  }

  const city = cityId ? await prisma.city.findUnique({ where: { id: cityId } }) : null;
  const coords = city ? CITY_COORDS[city.slug] ?? null : null;

  const [existing, catalog] = await Promise.all([
    prisma.practitioner.findUnique({
      where: { id: target.id },
      select: { headline: true, whoIHelp: true, bio: true, specialties: { select: { rawLabel: true } } },
    }),
    prisma.specialty.findMany({
      where: { status: { in: ['ACTIVE', 'PROPOSED'] } },
      select: { slug: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ]);

  // One-shot: normalize the practitioner's own words into a polished landing page.
  const { draft } = await draftProfile({
    displayName,
    rawSource: draftSource,
    existing: {
      headline: existing?.headline ?? null,
      whoIHelp: existing?.whoIHelp ?? null,
      bio: existing?.bio ?? null,
      rawLabels: (existing?.specialties ?? [])
        .map((s) => s.rawLabel?.trim())
        .filter((s): s is string => !!s),
    },
    canonicalCatalog: catalog,
  });

  let createdNewTaxonomy = false;

  await prisma.$transaction(async (tx) => {
    const resolved: { specialtyId: string; rawLabel: string }[] = [];
    const seen = new Set<string>();
    for (const sel of rawSelections) {
      const before = await tx.specialty.count();
      const r = await resolveSelection(tx, sel);
      if (!r || seen.has(r.specialtyId)) continue;
      if ((await tx.specialty.count()) > before) createdNewTaxonomy = true;
      seen.add(r.specialtyId);
      resolved.push(r);
    }

    const specialtyRows = await tx.specialty.findMany({
      where: { id: { in: resolved.map((r) => r.specialtyId) } },
      include: { parent: true },
    });
    const canonicalNames = Array.from(
      new Set(specialtyRows.flatMap((s) => (s.parent ? [s.name, s.parent.name] : [s.name]))),
    );
    const rawLabels = resolved.map((r) => r.rawLabel);

    await tx.practitionerSpecialty.deleteMany({ where: { practitionerId: target.id } });
    await tx.practitioner.update({
      where: { id: target.id },
      data: {
        displayName,
        headline: draft.headline || null,
        whoIHelp: draft.whoIHelp || null,
        bio: draft.bio || null,
        cityId,
        telehealth,
        inPerson,
        latitude: coords?.[0] ?? null,
        longitude: coords?.[1] ?? null,
        yearsInPractice,
        searchText: buildSearchText([
          displayName,
          draft.headline,
          draft.bio,
          draft.whoIHelp,
          city?.name,
          city?.state,
          ...draft.modalities,
          ...rawLabels,
          ...canonicalNames,
        ]),
        specialties: {
          create: resolved.map((r) => ({
            rawLabel: r.rawLabel,
            specialty: { connect: { id: r.specialtyId } },
          })),
        },
      },
    });

    // Fresh AI-drafted outcomes (reviewable/removable later in the portal).
    await tx.caseStudy.deleteMany({ where: { practitionerId: target.id } });
    for (const cs of draft.caseStudies) {
      await tx.caseStudy.create({
        data: {
          practitionerId: target.id,
          title: cs.title,
          summary: cs.summary,
          outcome: cs.outcome ?? null,
          anonymized: true,
        },
      });
    }
  });

  await indexPractitioner(target.id).catch((err) =>
    console.error('Typesense reindex failed:', err),
  );
  if (createdNewTaxonomy || rawSelections.length > 0) {
    await syncSpecialtySynonyms().catch((err) =>
      console.error('Typesense synonym sync failed:', err),
    );
  }

  revalidatePath(`/practitioners/${slug}`);
  revalidatePath('/');
  revalidatePath('/search');
  redirect(`/practitioners/${slug}?onboarded=1`);
}
