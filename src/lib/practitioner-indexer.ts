import type {
  Practitioner,
  City,
  Specialty,
  PractitionerSpecialty,
  SubscriptionStatus,
  Role,
  Prisma,
} from '@prisma/client';
import { prisma } from './prisma';
import { getTypesenseAdmin, TYPESENSE_COLLECTION } from './typesense-server';

type SpecialtyWithParent = Specialty & { parent: Specialty | null };
type PractitionerForIndex = Practitioner & {
  city: City | null;
  specialties: (PractitionerSpecialty & { specialty: SpecialtyWithParent })[];
  user: { role: Role };
};

export type PractitionerDoc = {
  id: string;
  slug: string;
  displayName: string;
  bio?: string;
  photoUrl?: string;
  cityName: string;
  cityState: string;
  location?: [number, number];
  specialtyNames: string[];
  specialtySlugs: string[];
  // Dual-label model: the practitioner's own phrasing (rawLabel). Searchable so their
  // voice is findable, but kept OUT of the facet list (specialtyNames stays the curated facet).
  specialtyLabels: string[];
  acceptedAt: number;
  yearsInPractice?: number;
  searchText?: string;
  isComplete: boolean;
};

const MIN_BIO_LENGTH = 20;

/**
 * Completeness gate (Phase 2.5): the four signals that make a profile
 * worth showing on public discovery surfaces. Direct profile URLs still
 * work for incomplete practitioners (shareability preserved) — they're
 * just hidden from /search + / recently-joined until the practitioner
 * fills these in.
 */
export type CompletenessSignals = {
  hasDisplayName: boolean;
  hasCity: boolean;
  hasBio: boolean;
  hasSpecialty: boolean;
};

export function profileCompletenessSignals(p: {
  displayName: string | null;
  cityId: string | null;
  bio: string | null;
  specialties: { specialtyId: string }[];
}): CompletenessSignals {
  return {
    hasDisplayName: !!p.displayName && p.displayName.trim().length > 0,
    hasCity: !!p.cityId,
    hasBio: !!p.bio && p.bio.trim().length >= MIN_BIO_LENGTH,
    hasSpecialty: p.specialties.length >= 1,
  };
}

export function isProfileComplete(p: Parameters<typeof profileCompletenessSignals>[0]): boolean {
  const s = profileCompletenessSignals(p);
  return s.hasDisplayName && s.hasCity && s.hasBio && s.hasSpecialty;
}

/**
 * Listing gate (Layer X + 90-day trial clock — see
 * docs/superpowers/specs/2026-07-16-pilot-trial-design.md): a profile is publicly
 * discoverable only when it's complete AND one of:
 *   - subscriptionStatus is ACTIVE or PAST_DUE (Whop's dunning window — grace for
 *     payers, so a failed card doesn't delist someone instantly)
 *   - trialEndsAt is null (pre-trial, operator-seeded, never onboarded — the 12
 *     existing pilots) or still in the future (trial running)
 *   - the owning user is ADMIN (staff/client are not customers; read server-side
 *     from the DB so the stale-JWT gap can't affect listing)
 * Direct profile URLs still resolve for everyone — this only controls /search +
 * recently-joined + the home page's featured list.
 *
 * `comped` is DEPRECATED and no longer read here — see the schema comment on that column.
 */
export function isListed(
  p: Parameters<typeof profileCompletenessSignals>[0] & {
    subscriptionStatus: SubscriptionStatus;
    trialEndsAt: Date | null;
    user: { role: Role };
  },
): boolean {
  const trialActive = p.trialEndsAt === null || p.trialEndsAt > new Date();
  return (
    isProfileComplete(p) &&
    (p.subscriptionStatus === 'ACTIVE' ||
      p.subscriptionStatus === 'PAST_DUE' ||
      trialActive ||
      p.user.role === 'ADMIN')
  );
}

/**
 * The same rule as isListed(), expressed as a Prisma `where` clause so callers can
 * filter inside a query instead of fetching every practitioner and filtering in memory
 * (the home page's featured + count queries). Single source of truth: consumers import
 * this rather than re-deriving the OR — isListed() and listedWhere() must never drift, in code OR in time.
 */
export function listedWhere(): Prisma.PractitionerWhereInput {
  // MUST be a function, not a module-level const. `new Date()` in a const is evaluated once,
  // at module load, and then frozen — and Vercel's Fluid Compute reuses function instances
  // across requests, so the module stays resident and the trial cutoff would never advance.
  // Every practitioner whose trial expired after boot would linger on the home page while
  // isListed() (which calls new Date() per invocation) correctly dropped them from Typesense.
  // That is exactly the drift this pair exists to prevent — just in time rather than in code.
  return {
    displayName: { not: '' },
    cityId: { not: null },
    bio: { not: null },
    specialties: { some: {} },
    OR: [
      { subscriptionStatus: 'ACTIVE' },
      { subscriptionStatus: 'PAST_DUE' },
      { trialEndsAt: null },
      { trialEndsAt: { gt: new Date() } },
      { user: { role: 'ADMIN' } },
    ],
  };
}

export function toTypesenseDoc(p: PractitionerForIndex): PractitionerDoc {
  const specialtyNames = new Set<string>();
  const specialtySlugs = new Set<string>();
  const specialtyLabels = new Set<string>();
  for (const ps of p.specialties) {
    specialtyNames.add(ps.specialty.name);
    specialtySlugs.add(ps.specialty.slug);
    if (ps.specialty.parent) {
      specialtyNames.add(ps.specialty.parent.name);
      specialtySlugs.add(ps.specialty.parent.slug);
    }
    if (ps.rawLabel && ps.rawLabel.trim()) specialtyLabels.add(ps.rawLabel.trim());
  }

  const location: [number, number] | undefined =
    p.latitude != null && p.longitude != null ? [p.latitude, p.longitude] : undefined;

  return {
    id: p.id,
    slug: p.slug,
    displayName: p.displayName,
    bio: p.bio ?? undefined,
    photoUrl: p.photoUrl ?? undefined,
    cityName: p.city?.name ?? '',
    cityState: p.city?.state ?? '',
    location,
    specialtyNames: Array.from(specialtyNames),
    specialtySlugs: Array.from(specialtySlugs),
    specialtyLabels: Array.from(specialtyLabels),
    acceptedAt: p.acceptedAt ? Math.floor(p.acceptedAt.getTime() / 1000) : 0,
    yearsInPractice: p.yearsInPractice ?? undefined,
    searchText: p.searchText ?? undefined,
    isComplete: isProfileComplete(p),
  };
}

const PRACTITIONER_INCLUDE = {
  city: true,
  specialties: { include: { specialty: { include: { parent: true } } } },
  user: { select: { role: true } },
} as const;

export async function indexPractitioner(id: string): Promise<void> {
  if (!process.env.TYPESENSE_ADMIN_API_KEY) return;
  const p = await prisma.practitioner.findUnique({
    where: { id },
    include: PRACTITIONER_INCLUDE,
  });
  if (!p) return;
  // Listing gate: an unsubscribed/incomplete practitioner is removed from discovery.
  if (!isListed(p)) {
    await deleteFromIndex(id);
    return;
  }
  await getTypesenseAdmin()
    .collections(TYPESENSE_COLLECTION)
    .documents()
    .upsert(toTypesenseDoc(p));
}

export async function indexAllPractitioners(): Promise<{ indexed: number }> {
  const practitioners = await prisma.practitioner.findMany({ include: PRACTITIONER_INCLUDE });
  // Listing gate: only index listed practitioners; drop any that are no longer listed.
  await Promise.all(
    practitioners.filter((p) => !isListed(p)).map((p) => deleteFromIndex(p.id).catch(() => {})),
  );
  const docs = practitioners.filter(isListed).map(toTypesenseDoc);
  if (docs.length === 0) return { indexed: 0 };
  const result = await getTypesenseAdmin()
    .collections(TYPESENSE_COLLECTION)
    .documents()
    .import(docs, { action: 'upsert' });
  const failed = result.filter((r: { success: boolean }) => !r.success);
  if (failed.length > 0) {
    console.error('Typesense indexing errors:', failed.slice(0, 5));
    throw new Error(`Typesense indexing failed for ${failed.length}/${docs.length} documents`);
  }
  return { indexed: docs.length };
}

export async function deleteFromIndex(id: string): Promise<void> {
  if (!process.env.TYPESENSE_ADMIN_API_KEY) return;
  try {
    await getTypesenseAdmin().collections(TYPESENSE_COLLECTION).documents(id).delete();
  } catch {
    // Doc may not exist; safe to swallow.
  }
}
