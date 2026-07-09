'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import type { Prisma } from '@prisma/client';
import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { indexPractitioner } from '@/lib/practitioner-indexer';
import { syncSpecialtySynonyms } from '@/lib/typesense-synonyms';

async function authorizeForSlug(slug: string) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect(`/auth/signin?callbackUrl=/practitioners/${slug}/edit`);
  }
  const practitioner = await prisma.practitioner.findUnique({
    where: { slug },
    select: { id: true, userId: true },
  });
  if (!practitioner) {
    redirect('/auth/error?error=AccessDenied');
  }
  const isOwner = practitioner.userId === session.user.id;
  const isAdmin = session.user.role === 'ADMIN';
  if (!isOwner && !isAdmin) {
    redirect('/auth/error?error=AccessDenied');
  }
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

export async function updatePractitioner(slug: string, formData: FormData): Promise<void> {
  const target = await authorizeForSlug(slug);

  const displayName = String(formData.get('displayName') ?? '').trim();
  const bio = String(formData.get('bio') ?? '').trim();
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

  // Existing landing-page fields (not edited by this form) — preserve in searchText.
  const existing = await prisma.practitioner.findUnique({
    where: { id: target.id },
    select: { headline: true, whoIHelp: true },
  });

  // Approx city centroids — Phase 2.5 can add per-practitioner override
  const cityCoords: Record<string, [number, number]> = {
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
  const coords = city ? cityCoords[city.slug] ?? null : null;

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
        cityId,
        latitude: coords?.[0] ?? null,
        longitude: coords?.[1] ?? null,
        yearsInPractice,
        searchText: buildSearchText([
          displayName,
          existing?.headline,
          bio,
          existing?.whoIHelp,
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
