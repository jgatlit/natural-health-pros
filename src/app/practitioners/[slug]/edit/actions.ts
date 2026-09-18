'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import * as Sentry from '@sentry/nextjs';
import type { Prisma } from '@prisma/client';
import { auth } from '@/auth';
import { normalizeFraming } from '@/lib/photo-framing';
import { prisma } from '@/lib/prisma';
import { isPlanKey } from '@/lib/pricing-plans';
import { sendEmail, normalizeEmail, escapeHtml } from '@/lib/email';
import { SITE_URL } from '@/lib/site';
import { newToken } from '@/lib/tokens';
import { indexPractitioner } from '@/lib/practitioner-indexer';
import { syncSpecialtySynonyms } from '@/lib/typesense-synonyms';
import { draftProfile, type DraftSpecialty } from '@/lib/onboarding-draft';
import { parseBookingLinkRows, MAX_BOOKING_LINKS } from '@/lib/booking-links';
import { detectProvider, extractUrlFromEmbed } from '@/lib/booking-providers';
import { normalizeOfferingFields } from '@/lib/offering-fields';
import { findPlace, findPlacesByName, splitCityEntry, VIRTUAL_PLACE, type Place } from '@/lib/city-catalog';
import {
  createAccountLink,
  createConnectedAccount,
  createOfferingCheckout,
  createSubscriptionCheckout,
  WHOP_OFFERING_TITLE_MAX,
} from '@/lib/whop';

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
  // Additive — every existing caller ignores the new field, so this doesn't touch their behavior.
  // Exists for callers (currently just submitOnboarding) that need to distinguish "the profile
  // owner, acting for themselves" from "an admin acting on their behalf" — an ADMIN reaching a
  // slug they don't own is an intentional, existing capability (support workflows), but some
  // decisions — recording consent, not just editing fields — must never be attributable to the
  // wrong person regardless of who is authorized to make the edit.
  return { ...practitioner, isOwner };
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
  // Advisory, NOT an allowlist: normalizeUrl accepts any dotted host. Practitioners bring their
  // own scheduler and the null adapter handles whatever is not listed here.
  'as.me',
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

/**
 * Find-or-create a City from free-text input, and hand back coordinates for the haversine index.
 *
 * The form used to post a `cityId` chosen from a fixed 14-row `<select>`, which locked out every
 * practitioner outside those 14 — and a missing city fails isProfileComplete() → isListed(), so
 * the lockout was silent invisibility, not a visible error. See CityField for the full note.
 *
 * Normalization is the whole job. `cityName`/`cityState` are Typesense facets, so "chicago",
 * "Chicago" and "CHICAGO " must converge on one row or the facet list fragments. Matching is on
 * City's (slug, state) unique key with a slugified name and an upper-cased state, while the
 * stored `name` keeps Census casing (or the practitioner's, for a place the catalog doesn't know).
 *
 * Coordinates come from the Census catalog rather than CITY_COORDS. That hand-maintained map has
 * 14 entries, so before this every practitioner-created city had no lat/long and silently dropped
 * out of the "near me" ranking. CITY_COORDS is still consulted as a fallback so the original
 * seeded cities keep the exact coordinates they were tuned with.
 */
async function resolveCity(
  rawName: string,
): Promise<{ id: string; name: string; state: string; coords: [number, number] | null } | 'invalid' | null> {
  const raw = rawName.trim().replace(/\s+/g, ' ');
  if (!raw) return null;

  // ONE field, "Chicago, IL". splitCityEntry only treats a trailing token as a state when it is a
  // REAL state code, so "Santa Fe" keeps both words. A separate state box used to supply this and
  // produced three defects: a blank box defaulted to the virtual sentinel, the sentinel then
  // captured the NAME as well, and a stale prefilled box beat the state in the suggestion just
  // picked. One value cannot disagree with itself.
  const { name, state: parsedState } = splitCityEntry(raw);
  if (!name) return null;

  const slug = slugify(name);
  if (!slug || slug === 'specialty') return 'invalid'; // slugify's fallback: nothing usable survived

  // Resolve against the catalog. Without a state we can still resolve when the name is
  // unambiguous; with several matches we need the practitioner to disambiguate rather than guess —
  // guessing is how someone ends up listed in the wrong state.
  const candidates = parsedState ? [findPlace(name, parsedState)].filter(Boolean) : findPlacesByName(name);
  const known = (candidates.length === 1 ? candidates[0] : null) as Place | null;

  // Never invent a state. "Online" is the virtual sentinel and must be chosen, not fallen into.
  const state = known?.state ?? parsedState;
  if (!state) return 'invalid';

  const city = await prisma.city.upsert({
    where: { slug_state: { slug, state } },
    create: { slug, name: known?.name ?? name, state },
    update: {},
  });

  const seeded = CITY_COORDS[city.slug];
  const coords: [number, number] | null =
    seeded ?? (known && known !== VIRTUAL_PLACE ? [known.lat, known.lon] : null);
  return { id: city.id, name: city.name, state: city.state, coords };
}

export async function updatePractitioner(slug: string, formData: FormData): Promise<void> {
  const target = await authorizeForSlug(slug);

  // ---- Optimistic-concurrency guard. Runs FIRST, before anything writes. ----
  //
  // This form is a last-write-wins document: it rewrites child collections wholesale, so a client
  // holding a stale view destroys rows it never knew existed. The realistic second editor is not a
  // second tab — `authorizeForSlug` lets any ADMIN save any practitioner's profile, so an operator
  // fixing someone's profile in support while they have it open is the case that matters.
  //
  // It sits at the very top because `resolveCity()` further down performs a `city.upsert`: a save
  // that is about to be refused as stale must not have already written a City row.
  //
  // ⚠️ ABSENT TOKEN IS A CONFLICT, not a skip. A form with no token is one rendered by a previous
  // deploy — precisely the staleness this exists to catch — so treating it as "nothing to compare"
  // would disable the guard exactly in the window it matters most.
  const postedVersion = String(formData.get('profileUpdatedAt') ?? '');
  const currentVersion = (
    await prisma.practitioner.findUnique({
      where: { id: target.id },
      select: { updatedAt: true },
    })
  )?.updatedAt.toISOString();

  if (!postedVersion || (currentVersion && currentVersion !== postedVersion)) {
    // ⚠️ The posted token is echoed back, and that is load-bearing. This redirect is a SOFT
    // navigation, so the form subtree stays MOUNTED (the same trap documented on the `?saved=1`
    // path) — the practitioner's typed text and the client islands' state all survive. But the
    // hidden token is a controlled `value`, which React WOULD refresh from the server. It would
    // then match, so a second click on Save — the natural response to an error — would sail
    // through the guard and write the stale collections it just blocked. Fires once, then disarms.
    //
    // Echoing keeps the form armed: every retry is refused until a real reload re-seeds it. That
    // also preserves their work, which matters because a false positive is reachable (see below).
    redirect(
      `/practitioners/${slug}/edit?error=profile-changed-elsewhere&v=${encodeURIComponent(postedVersion)}`,
    );
  }

  const displayName = String(formData.get('displayName') ?? '').trim();
  const bio = String(formData.get('bio') ?? '').trim();
  const headline = String(formData.get('headline') ?? '').trim() || null;
  const tagline = String(formData.get('tagline') ?? '').trim() || null;
  const whoIHelp = String(formData.get('whoIHelp') ?? '').trim() || null;
  // ONE CREDENTIAL PER LINE. A textarea rather than a repeatable row editor because these are
  // unordered free-text lines with no per-row state — the least technical cohort in the product
  // can paste a list from their CV and be done. Blank lines dropped; order preserved as typed.
  const qualifications = String(formData.get('qualifications') ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 40);
  const websiteUrl = normalizeWebsiteUrl(String(formData.get('websiteUrl') ?? ''));
  const telehealth = formData.get('telehealth') === 'on' || formData.get('telehealth') === 'true';
  const inPerson = formData.get('inPerson') === 'on' || formData.get('inPerson') === 'true';
  // An unresolvable city is an ERROR, not a silent null. Falling through to null clears cityId,
  // which fails isProfileComplete() -> isListed() and DELETES the practitioner from the search
  // index — while the save reports success. That is the exact silent-invisibility failure this
  // whole workstream exists to remove, so it has to surface the way the displayName check does.
  const resolved = await resolveCity(String(formData.get('cityName') ?? ''));
  if (resolved === 'invalid') {
    redirect(`/practitioners/${slug}/edit?error=invalid-city`);
  }
  const resolvedCity = resolved;
  const cityId = resolvedCity?.id ?? null;
  const photoUrl = String(formData.get('photoUrl') ?? '').trim() || null;
  // Framing is normalised, never trusted. These arrive as three free Floats from a hidden input,
  // and an out-of-range value would reach the browser as `object-position: 137%`, which quietly
  // renders as a blank edge rather than erroring — indistinguishable from "the photo is broken".
  // normalizeFraming() clamps and falls back to dead-centre, i.e. exactly the pre-feature render.
  const framing = normalizeFraming({
    photoFocalX: Number(formData.get('photoFocalX')),
    photoFocalY: Number(formData.get('photoFocalY')),
    photoZoom: Number(formData.get('photoZoom')),
  });
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

  // Booking links: bookingId/bookingLabel/bookingUrl triples zipped by index. `bookingId` carries
  // each row's existing identity back to us so links can be updated IN PLACE; a row with no id is
  // new. Zip/dedupe rules live in parseBookingLinkRows so they can be tested directly.
  const bookingIds = formData.getAll('bookingId').map((s) => String(s).trim());
  const bookingLabels = formData.getAll('bookingLabel').map((s) => String(s));
  const bookingUrlsRaw = formData
    .getAll('bookingUrl')
    // §6 input tolerance: several providers' "share" dialogs give embed markup, not a link.
    .map((s) => extractUrlFromEmbed(String(s)));
  const bookingCtaLabels = formData.getAll('bookingCtaLabel').map((s) => String(s));
  // §14.3 — which row owns the hero slot, as an INDEX into the posted rows (a new row has no id
  // yet). Mapped to the real BookingLink id after the reconcile below.
  const rawPrimaryIndex = String(formData.get('primaryBookingIndex') ?? '').trim();
  const primaryIndex = rawPrimaryIndex ? Number.parseInt(rawPrimaryIndex, 10) : NaN;
  // Refuse rather than truncate. Silently keeping the first N would drop links the practitioner
  // can still see in their own form, which is the failure mode this whole workstream exists to
  // remove; and the row count directly multiplies how long the reconcile holds its transaction.
  if (bookingUrlsRaw.length > MAX_BOOKING_LINKS) {
    redirect(`/practitioners/${slug}/edit?error=too-many-booking-links`);
  }

  const bookingLinks = parseBookingLinkRows(
    { ids: bookingIds, labels: bookingLabels, urls: bookingUrlsRaw, ctaLabels: bookingCtaLabels },
    normalizeBookingUrl,
  );
  if (bookingLinks === null) {
    redirect(`/practitioners/${slug}/edit?error=invalid-booking-url`);
  }

  // City coords for haversine — resolved alongside the city itself, so a practitioner-created
  // city gets Census coordinates instead of silently having none.
  const coords = resolvedCity?.coords ?? null;

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
    await tx.practitioner.update({
      where: { id: target.id },
      data: {
        displayName,
        bio: bio || null,
        photoUrl,
        ...framing,
        headline,
        tagline,
        whoIHelp,
        qualifications,
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
          // Credentials are a real search term ("Bastyr", "certified herbalist"), so they belong
          // in the index rather than being display-only.
          ...qualifications,
          resolvedCity?.name,
          resolvedCity?.state,
          ...rawLabels,
          ...canonicalNames,
        ]),
        specialties: {
          // Index IS the order: `resolved` follows specialtiesJson, which follows the order the
          // practitioner arranged the chips in. Persisting it here is what makes drag-to-sort
          // work without a separate reorder action.
          create: resolved.map((r, idx) => ({
            rawLabel: r.rawLabel,
            sortOrder: idx,
            specialty: { connect: { id: r.specialtyId } },
          })),
        },
      },
    });

    // Booking links are reconciled IN PLACE — never deleted and recreated.
    //
    // The original Wedge 2B implementation deleted every link and recreated them from the posted
    // rows. That was reasonable while BookingLink was a leaf table nobody referenced: order came
    // from submission order, so recreating from scratch made `sortOrder: idx` trivially correct.
    // It stops being reasonable the moment anything points at BookingLink.id — a delete-recreate
    // mints a fresh cuid on EVERY profile save, so an offering's link, or a designated hero CTA,
    // would be severed by a practitioner merely editing their bio.
    //
    // Reconciling costs one extra hidden field and this block, and it is what makes the id a
    // durable identity rather than a per-save accident.
    const keptIds = bookingLinks.map((b) => b.id).filter((id): id is string => !!id);
    // Index → persisted BookingLink id, so the posted primary index can be resolved after rows
    // are created or updated in place.
    const resolvedIds: (string | null)[] = [];

    // ⚠️ MUST precede the delete. `WhopProduct.bookingLinkId` is ON DELETE SET NULL, and the CHECK
    // `listingVisibility <> 'LINK_ONLY' OR bookingLinkId IS NOT NULL` is evaluated on the row the
    // FK action just nulled. So deleting a link that any LINK_ONLY Offering points at raises a
    // constraint violation INSIDE this interactive transaction — which unwinds the entire profile
    // save. The practitioner would lose their bio, specialties and city edits too, see only a
    // generic error, and retrying would never work.
    //
    // Reverting to LISTED is the same rule the editor applies when the link is cleared there
    // (§2: clearing the link reverts to LISTED); it simply has to hold for the other route into
    // the same state, which is deleting the link itself.
    await tx.whopProduct.updateMany({
      where: {
        practitionerId: target.id,
        listingVisibility: 'LINK_ONLY',
        bookingLinkId: keptIds.length > 0 ? { notIn: keptIds } : { not: null },
      },
      data: { listingVisibility: 'LISTED' },
    });

    await tx.bookingLink.deleteMany({
      where: {
        practitionerId: target.id,
        ...(keptIds.length > 0 && { id: { notIn: keptIds } }),
      },
    });
    for (let idx = 0; idx < bookingLinks.length; idx++) {
      const b = bookingLinks[idx];
      // updateMany scoped by practitionerId IS the ownership check: a forged or stale id matches
      // nothing and updates zero rows, rather than retargeting another practitioner's link.
      const updated = b.id
        ? ((resolvedIds[idx] = b.id), await tx.bookingLink.updateMany({
            where: { id: b.id, practitionerId: target.id },
            data: {
              label: b.label,
              url: b.url,
              sortOrder: idx,
              ctaLabel: b.ctaLabel,
              // Derived, never practitioner-supplied (§6). Recomputed on every save so a
              // corrected URL cannot leave a stale provider behind driving the wrong adapter.
              provider: detectProvider(b.url),
            },
          }))
        : { count: 0 };
      // An id that resolved to nothing falls through to a create, so the practitioner's row is
      // still saved. Dropping it silently would lose a link they can see in the form.
      if (updated.count === 0) {
        // A posted id that matches nothing is the signature of a STALE CLIENT: the browser is
        // holding an id the database no longer has, which means something is recreating rows
        // that were supposed to be updated in place. It is never expected in normal use, and
        // saying so is the difference between noticing that and not — an earlier revision of
        // this code churned ids on every save and the silent create is precisely what hid it.
        if (b.id) {
          // Sentry, not just console: the comment above claims this is how the id-churn class
          // gets NOTICED, and a warn line in Vercel function logs with no alert on it is a
          // forensic breadcrumb rather than a detector. Two opaque cuids, no PII.
          // It also gives the forged-id path an audit trail, which the ownership check alone
          // (updateMany scoped by practitionerId) does not produce.
          Sentry.captureMessage('booking-links: posted id matched no row', {
            level: 'warning',
            extra: { practitionerId: target.id, postedId: b.id },
          });
          console.warn(
            '[booking-links] posted id matched no row; creating instead',
            JSON.stringify({ practitionerId: target.id, postedId: b.id }),
          );
        }
        const created = await tx.bookingLink.create({
          data: {
            practitionerId: target.id,
            label: b.label,
            url: b.url,
            sortOrder: idx,
            ctaLabel: b.ctaLabel,
            provider: detectProvider(b.url),
          },
        });
        resolvedIds[idx] = created.id;
      }
    }

    // Resolve the posted index to a real id and persist it. Cleared when the designated row was
    // removed, which correctly returns the practitioner to §14.3's suppressed-hero state rather
    // than silently promoting an arbitrary other calendar.
    const designated =
      Number.isInteger(primaryIndex) && primaryIndex >= 0 ? (resolvedIds[primaryIndex] ?? null) : null;
    await tx.practitioner.update({
      where: { id: target.id },
      data: { primaryBookingLinkId: designated },
    });
    },
    // Raised from Prisma's 5s default. This transaction is a chain of SEQUENTIAL round trips
    // whose length scales with the practitioner's own data — roughly five per specialty
    // (resolveSelection plus two counts) and one to two per booking link. At Neon-pooler
    // latency a well-filled profile can approach the default, and a timeout here is not a
    // partial write but total loss of the save: P2028 unwinds every statement and the redirect
    // never runs, so the practitioner sees only a generic error.
    { timeout: 15_000 },
  );

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
        tagline: true,
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
      tagline: practitioner.tagline,
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
        tagline: draft.tagline || null,
        whoIHelp: draft.whoIHelp || null,
        bio: draft.bio || null,
        // A DRAFT the practitioner then edits, exactly like headline/tagline/bio above — never
        // presented as authoritative. Empty is a correct outcome: the extraction is strictly
        // extractive, so a source that names no credentials yields none rather than inventing
        // one, and an invented credential on a health directory is a different class of wrong
        // from clumsy wording.
        qualifications: draft.qualifications,
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
          // Index IS the order: `resolved` follows specialtiesJson, which follows the order the
          // practitioner arranged the chips in. Persisting it here is what makes drag-to-sort
          // work without a separate reorder action.
          create: resolved.map((r, idx) => ({
            rawLabel: r.rawLabel,
            sortOrder: idx,
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

  // authorizeForSlug lets an ADMIN act on any slug — a deliberate, existing capability for
  // support workflows. Consent is different: a click has to be the PRACTITIONER'S OWN, or the
  // record is false on its face. `target.isOwner` (not merely "authorized") is what gates it, so
  // an admin completing onboarding on someone else's behalf can still create/update the profile
  // (the existing support capability, untouched) without ever having their own click recorded as
  // that practitioner's personal acceptance of the Terms.
  //
  // Required only the first time, and only for the practitioner themselves — accepting on
  // revisit (finishing an incomplete profile) isn't re-asked, and an admin acting on someone
  // else's behalf is never asked at all (nothing here blocks their edit, it just never sets
  // termsAcceptedAt on someone else's say-so). The HTML `required` attribute on the checkbox
  // already blocks a client-side submit while unaccepted; this is the server-side backstop a
  // hand-crafted POST can't skip.
  const existingUser = await prisma.user.findUnique({
    where: { id: target.userId },
    select: { termsAcceptedAt: true },
  });
  const alreadyAcceptedTerms = !!existingUser?.termsAcceptedAt;
  if (target.isOwner && !alreadyAcceptedTerms && formData.get('termsAccepted') !== 'on') {
    redirect(`/practitioners/${slug}/edit?error=terms-required`);
  }

  const displayName = String(formData.get('displayName') ?? '').trim();
  if (!displayName) {
    redirect(`/practitioners/${slug}/edit?error=name-required`);
  }
  // An unresolvable city is an ERROR, not a silent null. Falling through to null clears cityId,
  // which fails isProfileComplete() -> isListed() and DELETES the practitioner from the search
  // index — while the save reports success. That is the exact silent-invisibility failure this
  // whole workstream exists to remove, so it has to surface the way the displayName check does.
  const resolved = await resolveCity(String(formData.get('cityName') ?? ''));
  if (resolved === 'invalid') {
    redirect(`/practitioners/${slug}/edit?error=invalid-city`);
  }
  const resolvedCity = resolved;
  const cityId = resolvedCity?.id ?? null;
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

  const coords = resolvedCity?.coords ?? null;

  const [existing, catalog] = await Promise.all([
    prisma.practitioner.findUnique({
      where: { id: target.id },
      select: { headline: true, tagline: true, whoIHelp: true, bio: true, specialties: { select: { rawLabel: true } } },
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
      tagline: existing?.tagline ?? null,
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

    if (target.isOwner && !alreadyAcceptedTerms) {
      // updateMany + a `termsAcceptedAt: null` guard, not update(): alreadyAcceptedTerms was read
      // outside this transaction, before the (potentially slow — city resolution, an LLM draft
      // call) work above. Two concurrent submits (double-click, a retry) could both read it as
      // false and both reach here; the guard makes the second one a no-op instead of silently
      // overwriting the first acceptance's timestamp with its own, later one.
      await tx.user.updateMany({
        where: { id: target.userId, termsAcceptedAt: null },
        data: { termsAcceptedAt: new Date() },
      });
    }

    await tx.practitionerSpecialty.deleteMany({ where: { practitionerId: target.id } });
    await tx.practitioner.update({
      where: { id: target.id },
      data: {
        displayName,
        headline: draft.headline || null,
        tagline: draft.tagline || null,
        whoIHelp: draft.whoIHelp || null,
        bio: draft.bio || null,
        // A DRAFT the practitioner then edits, exactly like headline/tagline/bio above — never
        // presented as authoritative. Empty is a correct outcome: the extraction is strictly
        // extractive, so a source that names no credentials yields none rather than inventing
        // one, and an invented credential on a health directory is a different class of wrong
        // from clumsy wording.
        qualifications: draft.qualifications,
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
          resolvedCity?.name,
          resolvedCity?.state,
          ...draft.modalities,
          ...rawLabels,
          ...canonicalNames,
        ]),
        specialties: {
          // Index IS the order: `resolved` follows specialtiesJson, which follows the order the
          // practitioner arranged the chips in. Persisting it here is what makes drag-to-sort
          // work without a separate reorder action.
          create: resolved.map((r, idx) => ({
            rawLabel: r.rawLabel,
            sortOrder: idx,
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

// ---- Offerings (Phase 2) ----
// Practitioner-configured offerings stored locally in WhopProduct. Payments are wired in
// Layer Y (whopProductId/purchaseUrl stay null until then), so no Typesense reindex here.

function parsePriceToCents(raw: FormDataEntryValue | null): number {
  const s = String(raw ?? '').replace(/[^0-9.]/g, '').trim();
  const dollars = parseFloat(s);
  if (!s || !Number.isFinite(dollars) || dollars < 0) return 0;
  // Clamp under Postgres INT4 max ($21.47M) so an oversized price can't overflow the column.
  return Math.min(Math.round(dollars * 100), 2_000_000_00);
}

function offeringInterval(raw: FormDataEntryValue | null): 'ONE_TIME' | 'MONTHLY' {
  return raw === 'MONTHLY' ? 'MONTHLY' : 'ONE_TIME';
}

/**
 * Resolve the §12 offering controls from a posted form.
 *
 * ⚠️ `bookingLinkId` is a user-supplied identifier used in a write, so it is resolved against THIS
 * practitioner's links and dropped otherwise — a crafted POST cannot attach an Offering to another
 * practitioner's booking link. D6 makes that a single scoped query: a BookingLink is always
 * practitioner-scoped, and a shared scheduler URL is a second row, not a shared entity.
 *
 * Everything after the lookup is pure and lives in `normalizeOfferingFields` so the invariants can
 * be tested without a database.
 */
async function offeringFieldsFrom(formData: FormData, practitionerId: string) {
  const requested = String(formData.get('bookingLinkId') ?? '').trim();
  const owned = requested
    ? await prisma.bookingLink.findFirst({
        where: { id: requested, practitionerId },
        select: { id: true },
      })
    : null;

  return normalizeOfferingFields({
    isConsult: formData.get('isConsult') != null,
    acceptsPayments: formData.get('acceptsPayments') != null,
    showOnProfile: formData.get('showOnProfile') != null,
    rawDuration: String(formData.get('duration') ?? ''),
    ownedBookingLinkId: owned?.id ?? null,
  });
}

export async function createOffering(slug: string, formData: FormData): Promise<void> {
  const target = await authorizeForSlug(slug);
  const title = String(formData.get('title') ?? '').trim();
  if (!title) redirect(`/practitioners/${slug}/edit?error=offering-title#offerings`);
  const extra = await offeringFieldsFrom(formData, target.id);
  await prisma.whopProduct.create({
    data: {
      practitionerId: target.id,
      title,
      description: String(formData.get('description') ?? '').trim() || null,
      category: String(formData.get('category') ?? '').trim() || null,
      interval: offeringInterval(formData.get('interval')),
      priceUsdCents: extra.priceOverride ?? parsePriceToCents(formData.get('price')),
      isConsult: extra.isConsult,
      acceptsPayments: extra.acceptsPayments,
      duration: extra.duration,
      bookingLinkId: extra.bookingLinkId,
      listingVisibility: extra.listingVisibility,
    },
  });
  revalidatePath(`/practitioners/${slug}`);
  revalidatePath(`/practitioners/${slug}/edit`);
  redirect(`/practitioners/${slug}/edit?saved=offering#offerings`);
}

export async function updateOffering(slug: string, formData: FormData): Promise<void> {
  const target = await authorizeForSlug(slug);
  const id = String(formData.get('offeringId') ?? '');
  const title = String(formData.get('title') ?? '').trim();
  if (!id || !title) redirect(`/practitioners/${slug}/edit?error=offering-title#offerings`);
  // updateMany scoped by practitionerId = the ownership check (no cross-practitioner edits).
  const extra = await offeringFieldsFrom(formData, target.id);
  const priceUsdCents = extra.priceOverride ?? parsePriceToCents(formData.get('price'));

  // §9 — "never render a Buy CTA that cannot transact."
  //
  // The public profile shows a price only when priceUsdCents > 0 but renders the Book button
  // whenever purchaseUrl is set. So turning a PUBLISHED offering into a free consultation, with no
  // further action, produces a card that reads "free" above a checkout that still charges the old
  // price — and the dashboard keeps reporting "Live — patients can buy this", because PublishRow
  // also keys off purchaseUrl. Clearing the Whop fields is what makes the two agree.
  //
  // Only the local pointers are cleared; there is no Whop delete endpoint for a checkout
  // configuration, which is exactly how unpublishOffering already works.
  const becomesFree = extra.isConsult || priceUsdCents <= 0;

  await prisma.whopProduct.updateMany({
    where: { id, practitionerId: target.id },
    data: {
      title,
      description: String(formData.get('description') ?? '').trim() || null,
      category: String(formData.get('category') ?? '').trim() || null,
      // Preserved rather than re-read when the control is disabled: a disabled <select> submits
      // nothing, so reading the form here would silently rewrite a MONTHLY offering to ONE_TIME
      // the moment someone ticks "Free consultation".
      ...(extra.isConsult ? {} : { interval: offeringInterval(formData.get('interval')) }),
      priceUsdCents,
      isConsult: extra.isConsult,
      acceptsPayments: extra.acceptsPayments,
      duration: extra.duration,
      bookingLinkId: extra.bookingLinkId,
      listingVisibility: extra.listingVisibility,
      ...(becomesFree
        ? { whopPlanId: null, whopCheckoutConfigId: null, purchaseUrl: null }
        : {}),
    },
  });
  revalidatePath(`/practitioners/${slug}`);
  revalidatePath(`/practitioners/${slug}/edit`);
  redirect(`/practitioners/${slug}/edit?saved=offering#offerings`);
}

export async function deleteOffering(slug: string, formData: FormData): Promise<void> {
  const target = await authorizeForSlug(slug);
  const id = String(formData.get('offeringId') ?? '');
  if (id) await prisma.whopProduct.deleteMany({ where: { id, practitionerId: target.id } });
  revalidatePath(`/practitioners/${slug}`);
  revalidatePath(`/practitioners/${slug}/edit`);
  redirect(`/practitioners/${slug}/edit#offerings`);
}

/**
 * Persist a practitioner's chosen offering order.
 *
 * Offerings need an explicit action where specialties and booking links do not: those two ride
 * along in the profile form, so their submission order IS their sortOrder. Offerings are separate
 * rows behind their own create/update/delete actions, with no containing form to carry an order.
 *
 * `updateMany` per id is scoped by practitionerId as well, so a forged id in the posted list
 * cannot renumber somebody else's offerings — the ownership check on the action authorises the
 * practitioner, not each id they send.
 */
export async function reorderOfferings(slug: string, formData: FormData): Promise<void> {
  const target = await authorizeForSlug(slug);
  // A malformed or empty payload must SURFACE — redirecting with `?error=` is what makes
  // OfferingsEditor's caller (a direct call, not a form submission) actually see the failure
  // rather than believing a locally-reordered list saved when the public profile disagrees.
  let ids: string[] = [];
  try {
    const parsed = JSON.parse(String(formData.get('orderJson') ?? '[]'));
    if (Array.isArray(parsed)) ids = parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    redirect(`/practitioners/${slug}/edit?error=reorder-failed#offerings`);
  }
  if (ids.length === 0) {
    redirect(`/practitioners/${slug}/edit?error=reorder-failed#offerings`);
  }

  await prisma.$transaction(
    ids.map((id, sortOrder) =>
      prisma.whopProduct.updateMany({
        where: { id, practitionerId: target.id },
        data: { sortOrder },
      }),
    ),
  );

  revalidatePath(`/practitioners/${slug}`);
  revalidatePath(`/practitioners/${slug}/edit`);
}

// ---- Whop payments (Layer X subscription + Layer Y connected-account offerings) ----
// Every Whop call below can throw (WhopNotConfigured, network, API error). redirect() itself
// works by throwing, so each action does its Whop/DB work inside try/catch capturing a result
// or error flag, then calls redirect() AFTER the try/catch — never inside it, or a success
// would get caught by its own catch and reported back as a failure.

/**
 * Record the practitioner'''s Plan A / Plan B choice.
 *
 * Writes only `plan` + `planChosenAt`, and only for a plan key we recognise — an unrecognised
 * value is dropped rather than stored, because this column feeds the platform fee on every
 * subsequent checkout and an unknown plan there would either throw in a webhook or charge nothing
 * silently.
 *
 * Switching plans is allowed and deliberately unguarded: it changes future checkouts only. Fees
 * already charged were computed at mint time and are not retroactive.
 */
export async function choosePlan(slug: string, formData: FormData): Promise<void> {
  const target = await authorizeForSlug(slug);
  const plan = formData.get('plan');
  if (!isPlanKey(plan)) {
    redirect(`/practitioners/${slug}/edit?plan=error#payments`);
  }
  await prisma.practitioner.update({
    where: { id: target.id },
    data: { plan, planChosenAt: new Date() },
  });
  redirect(`/practitioners/${slug}/edit?plan=saved#payments`);
}

export async function startSubscriptionCheckout(slug: string): Promise<void> {
  const target = await authorizeForSlug(slug);

  let redirectUrl: string | null = null;
  try {
    // Mint-once-and-reuse: never mint a second checkout config for the same practitioner.
    const practitioner = await prisma.practitioner.findUnique({
      where: { id: target.id },
      select: { whopSubscriptionCheckoutUrl: true },
    });
    if (practitioner?.whopSubscriptionCheckoutUrl) {
      redirectUrl = practitioner.whopSubscriptionCheckoutUrl;
    } else {
      const { purchaseUrl } = await createSubscriptionCheckout({ practitionerId: target.id, slug });
      await prisma.practitioner.update({
        where: { id: target.id },
        data: { whopSubscriptionCheckoutUrl: purchaseUrl },
      });
      redirectUrl = purchaseUrl;
    }
  } catch (err) {
    console.error('Whop subscription checkout failed:', err);
  }

  redirect(redirectUrl ?? `/practitioners/${slug}/edit?whop=error#payments`);
}

export async function startWhopOnboarding(slug: string): Promise<void> {
  const target = await authorizeForSlug(slug);

  let linkUrl: string | null = null;
  try {
    const practitioner = await prisma.practitioner.findUnique({
      where: { id: target.id },
      select: { displayName: true, whopCompanyId: true, user: { select: { email: true } } },
    });

    // companies.create is NOT idempotent — Whop will happily mint a second connected company
    // for the same practitioner. Re-read whopCompanyId right here and only ever create when
    // it's still unset, then persist the new id immediately (before minting the account link,
    // which can itself fail) so a retry after a partial failure never creates a second one.
    let companyId = practitioner?.whopCompanyId ?? null;
    if (!companyId && practitioner?.user.email) {
      const created = await createConnectedAccount({
        practitionerId: target.id,
        slug,
        displayName: practitioner.displayName || slug,
        email: practitioner.user.email,
      });
      companyId = created.companyId;
      await prisma.practitioner.update({
        where: { id: target.id },
        data: { whopCompanyId: companyId, whopCompanyCreatedAt: new Date() },
      });
    }

    if (companyId) {
      const link = await createAccountLink({ companyId, slug, useCase: 'account_onboarding' });
      linkUrl = link.url;
    }
  } catch (err) {
    console.error('Whop onboarding failed:', err);
  }

  redirect(linkUrl ?? `/practitioners/${slug}/edit?whop=error#payments`);
}

export async function openPayoutPortal(slug: string): Promise<void> {
  const target = await authorizeForSlug(slug);

  let linkUrl: string | null = null;
  try {
    const practitioner = await prisma.practitioner.findUnique({
      where: { id: target.id },
      select: { whopCompanyId: true },
    });
    if (practitioner?.whopCompanyId) {
      const link = await createAccountLink({
        companyId: practitioner.whopCompanyId,
        slug,
        useCase: 'payouts_portal',
      });
      linkUrl = link.url;
    }
  } catch (err) {
    console.error('Whop payout portal failed:', err);
  }

  redirect(linkUrl ?? `/practitioners/${slug}/edit?whop=error#payments`);
}

/**
 * Drop stored checkout sessions for an offering whose Whop configuration just changed.
 *
 * A stored session is pinned to the configuration it was minted against, so once that
 * configuration is replaced (re-publish) or retired (unpublish) the session is a live payment path
 * the practitioner believes is gone — at the old price, after a price edit. Nulling it makes the
 * flow re-mint against whatever is current.
 *
 * Scoped to UNSETTLED intents only. A paid intent's session id is a historical record of how money
 * moved and must not be rewritten.
 */
async function clearStaleCheckoutSessions(offeringId: string): Promise<void> {
  await prisma.bookingIntent.updateMany({
    where: { offeringId, paidAt: null, whopCheckoutSessionId: { not: null } },
    data: {
      whopCheckoutSessionId: null,
      whopCheckoutPurchaseUrl: null,
      whopCheckoutSessionExpiresAt: null,
    },
  });
}

export async function publishOffering(slug: string, formData: FormData): Promise<void> {
  const target = await authorizeForSlug(slug);
  const offeringId = String(formData.get('offeringId') ?? '');

  const [practitioner, offering] = await Promise.all([
    prisma.practitioner.findUnique({
      where: { id: target.id },
      select: { whopCompanyId: true, whopPayoutsEnabled: true },
    }),
    // Ownership check, scoped by practitionerId — mirrors the updateMany scoping above; never
    // trust the id alone.
    prisma.whopProduct.findFirst({ where: { id: offeringId, practitionerId: target.id } }),
  ]);
  if (!practitioner || !offering) {
    redirect(`/practitioners/${slug}/edit?error=offering-not-found#offerings`);
  }

  // HARD GATE, not advisory: letting a patient pay into an account that cannot withdraw is the
  // worst possible failure, so no Whop call happens below until Whop itself has confirmed
  // payouts are enabled for this practitioner.
  if (!practitioner.whopPayoutsEnabled) {
    redirect(`/practitioners/${slug}/edit?error=payouts-not-ready#offerings`);
  }
  if (!practitioner.whopCompanyId || offering.priceUsdCents <= 0) {
    redirect(`/practitioners/${slug}/edit?error=offering-not-ready#offerings`);
  }
  // Whop 422s the whole checkout-config create over this (verified live 2026-07-29) — catch it
  // here with a specific, actionable redirect instead of letting it fall into the generic
  // Whop-error banner below, which gives the practitioner no idea what to fix.
  if (offering.title.length > WHOP_OFFERING_TITLE_MAX) {
    redirect(`/practitioners/${slug}/edit?error=offering-title-too-long#offerings`);
  }

  let ok = false;
  let noPlan = false;
  try {
    const result = await createOfferingCheckout({
      companyId: practitioner.whopCompanyId,
      offeringId: offering.id,
      practitionerId: target.id,
      slug,
      title: offering.title,
      priceUsdCents: offering.priceUsdCents,
      interval: offering.interval,
      applicationFeeCents: offering.applicationFeeCents,
    });
    // ALWAYS persist what Whop created, even when the plan id is missing. The product, plan and
    // checkout configuration already exist on the practitioner's connected account by this point;
    // discarding the ids would orphan them beyond the reach of unpublishOffering (which only
    // nulls local columns), and every retry would mint another orphan set.
    await prisma.whopProduct.update({
      where: { id: offering.id },
      data: {
        whopCheckoutConfigId: result.checkoutConfigId,
        whopPlanId: result.planId,
        purchaseUrl: result.purchaseUrl,
        // §22-B: Publish IS "set up payments" now — a separate manual "Accept payments" tick
        // was the exact trap Sarah and Jonathan hit live on the 2026-09-03 call (checked the
        // box, saved, nothing was purchasable, because Publish is the step that actually calls
        // Whop). The checkbox stays editable afterward, for pausing checkout on a published
        // item without unpublishing it — this only removes the now-pointless manual tick
        // BEFORE anything exists to toggle.
        acceptsPayments: true,
      },
    });

    // A null plan id is a PUBLISH FAILURE. `createOfferingCheckout` returns `cfg.plan?.id ?? null`
    // and Whop does not contractually guarantee it — and since §17.3c's embedded checkout is
    // addressed BY plan id, treating null as success would move the problem to buyer time: a
    // listed offering with a live Buy CTA and no renderable checkout.
    //
    // Signalled with a specific error CODE, matching every other failure in this action. A
    // `USER:`-prefixed throw would have been swallowed by the catch below and surfaced as the
    // generic ?whop=error banner in a different section — extractError() is never involved here,
    // because publishOffering is not wrapped by anything that reads the convention.
    //
    // Set a FLAG rather than redirecting here. `redirect()` signals by throwing NEXT_REDIRECT, so
    // calling it inside this try would have it caught by the catch two lines below, logged as a
    // Whop failure, and converted into the generic banner in the wrong section — making the
    // dedicated one unreachable. Same rule as the comment 160 lines above: redirect AFTER the
    // try/catch, never inside it.
    noPlan = !result.planId;
    ok = !noPlan;
  } catch (err) {
    console.error('Whop publish offering failed:', err);
  }
  if (noPlan) redirect(`/practitioners/${slug}/edit?error=offering-no-plan#offerings`);
  if (!ok) redirect(`/practitioners/${slug}/edit?whop=error#offerings`);

  // A re-publish mints a FRESH checkout configuration (createOfferingCheckout treats the result as
  // derived and disposable), so any session already minted against the old one now points at a
  // superseded configuration — and would charge the OLD price after a price edit. Drop them; the
  // flow re-mints on next render. Settled intents are left alone: their session is history, not a
  // live payment path.
  await clearStaleCheckoutSessions(offering.id);

  revalidatePath(`/practitioners/${slug}`);
  revalidatePath(`/practitioners/${slug}/edit`);
  redirect(`/practitioners/${slug}/edit?saved=offering#offerings`);
}

export async function unpublishOffering(slug: string, formData: FormData): Promise<void> {
  const target = await authorizeForSlug(slug);
  const id = String(formData.get('offeringId') ?? '');
  // No Whop call — there is no delete endpoint for a checkout configuration, it simply stops
  // being surfaced once the public Buy button's fields are cleared.
  if (id) {
    const cleared = await prisma.whopProduct.updateMany({
      where: { id, practitionerId: target.id },
      data: { whopCheckoutConfigId: null, whopPlanId: null, purchaseUrl: null },
    });
    // Only after the ownership-scoped update actually matched — otherwise an id belonging to
    // someone else would let a practitioner wipe another practitioner's in-flight sessions.
    if (cleared.count > 0) await clearStaleCheckoutSessions(id);
  }
  revalidatePath(`/practitioners/${slug}`);
  revalidatePath(`/practitioners/${slug}/edit`);
  redirect(`/practitioners/${slug}/edit?saved=offering#offerings`);
}

const EMAIL_CHANGE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * PRACTITIONER (or an admin acting for them): request a change to the account email.
 *
 * Does NOT write `User.email` directly. Magic-link is the only authentication this app has, so
 * writing the new address immediately means a typo is a total, unrecoverable-without-admin
 * lockout — the old behavior accepted that risk (see git history) with an ADMIN correction path
 * as the safety net. This is the verify-before-switch flow that safety net was standing in for:
 * the address only takes effect once its owner clicks the link mailed to it, proving they
 * control that inbox before the sign-in identity moves.
 *
 * One pending request per user — any prior row for this userId is replaced, so requesting again
 * (a typo in the first request, or just impatience) is idempotent rather than accumulating rows.
 */
export async function requestAccountEmailChange(slug: string, formData: FormData): Promise<void> {
  const target = await authorizeForSlug(slug);

  const raw = normalizeEmail(String(formData.get('email') ?? ''));
  if (!raw) {
    redirect(`/practitioners/${slug}/edit?error=bad-email#account`);
  }

  const practitioner = await prisma.practitioner.findUnique({
    where: { id: target.id },
    select: { userId: true, user: { select: { email: true } } },
  });
  if (!practitioner) redirect('/auth/error?error=AccessDenied');

  if (practitioner.user.email.toLowerCase() === raw) {
    // A genuine no-op — nothing was requested, so no "check your inbox" or "updated" banner is
    // accurate here. `email` (unchanged) reads correctly with no query param at all.
    redirect(`/practitioners/${slug}/edit#account`);
  }

  // Refuse on collision rather than merging accounts. Merging would hand this profile to
  // whoever controls the other address. `mode: 'insensitive'` rather than trusting every row to
  // already be lowercase — normalizeEmail lowercases on WRITE, but a row written before that
  // convention existed (or by a path that doesn't call it) would otherwise slip past an exact
  // match and let two accounts share what every real mail system treats as one mailbox.
  // Re-checked again at confirm time, since the interim (up to 24h) leaves room for the address
  // to be claimed by someone else in between.
  const collision = await prisma.user.findFirst({
    where: { email: { equals: raw, mode: 'insensitive' } },
    select: { id: true },
  });
  if (collision) {
    redirect(`/practitioners/${slug}/edit?error=email-taken#account`);
  }

  const token = newToken();
  const oldEmail = practitioner.user.email;

  // upsert on the userId unique constraint, not delete-then-create: two concurrent requests
  // (a double-submit, a retried POST) could otherwise both see zero rows before either insert
  // commits, leaving two live tokens for one account pointing at two different addresses.
  await prisma.emailChangeRequest.upsert({
    where: { userId: practitioner.userId },
    create: {
      token,
      userId: practitioner.userId,
      newEmail: raw,
      expiresAt: new Date(Date.now() + EMAIL_CHANGE_TTL_MS),
    },
    update: {
      token,
      newEmail: raw,
      expiresAt: new Date(Date.now() + EMAIL_CHANGE_TTL_MS),
    },
  });

  const confirmUrl = `${SITE_URL}/auth/confirm-email-change/${token}`;
  const safeRaw = escapeHtml(raw);

  // The two sends are independent of each other (the old-address notice doesn't depend on the
  // new-address confirmation's outcome), so they run concurrently rather than back-to-back.
  const [confirmResult, noticeResult] = await Promise.allSettled([
    sendEmail({
      to: raw,
      subject: 'Confirm your new email — Natural Health Pros',
      text: `Confirm this is your email to finish changing your Natural Health Pros sign-in address: ${confirmUrl}\n\nThis link expires in 24 hours. If you didn't request this, you can ignore it — your sign-in address will not change.`,
      html: `<p>Confirm this is your email to finish changing your Natural Health Pros sign-in address.</p>
<p><a href="${confirmUrl}">Confirm email change</a></p>
<p>This link expires in 24 hours. If you didn&rsquo;t request this, you can ignore it — your sign-in address will not change.</p>`,
      // Keyed on the token so a form double-submit or a retry cannot double-send.
      idempotencyKey: `email-change-confirm/${token}`,
      tags: [{ name: 'type', value: 'email-change-confirm' }],
    }),
    // Best-effort heads-up to the OLD address, so a hijack attempt (someone else with access to
    // this account requesting a change to an address the real owner doesn't control) is visible.
    // Its own failure must never block the request — the confirmation link above is what
    // actually gates the change.
    sendEmail({
      to: oldEmail,
      subject: 'Email change requested on your Natural Health Pros account',
      text: `A change to ${raw} was requested on your Natural Health Pros account. It only takes effect if that address confirms it. If this wasn't you, no action is needed — nothing changes unless ${raw} confirms.`,
      html: `<p>A change to <strong>${safeRaw}</strong> was requested on your Natural Health Pros account. It only takes effect if that address confirms it.</p>
<p>If this wasn&rsquo;t you, no action is needed — nothing changes unless ${safeRaw} confirms.</p>`,
      idempotencyKey: `email-change-notice/${token}`,
      tags: [{ name: 'type', value: 'email-change-notice' }],
    }),
  ]);

  if (noticeResult.status === 'rejected') {
    Sentry.captureException(noticeResult.reason);
  }

  if (confirmResult.status === 'rejected') {
    // The PRIMARY send failed — the pending row must not outlive the email that was supposed to
    // deliver its token, or the practitioner is left with a request they have no way to complete
    // and no visible error explaining why nothing arrived.
    await prisma.emailChangeRequest.deleteMany({ where: { userId: practitioner.userId, token } });
    Sentry.captureException(confirmResult.reason);
    redirect(`/practitioners/${slug}/edit?error=email-send-failed#account`);
  }

  revalidatePath(`/practitioners/${slug}/edit`);
  redirect(`/practitioners/${slug}/edit?saved=email-pending#account`);
}
