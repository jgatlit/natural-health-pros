import type { Practitioner, City, Specialty, PractitionerSpecialty } from '@prisma/client';
import { prisma } from './prisma';
import { getTypesenseAdmin, TYPESENSE_COLLECTION } from './typesense-server';

type SpecialtyWithParent = Specialty & { parent: Specialty | null };
type PractitionerForIndex = Practitioner & {
  city: City | null;
  specialties: (PractitionerSpecialty & { specialty: SpecialtyWithParent })[];
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
} as const;

export async function indexPractitioner(id: string): Promise<void> {
  if (!process.env.TYPESENSE_ADMIN_API_KEY) return;
  const p = await prisma.practitioner.findUnique({
    where: { id },
    include: PRACTITIONER_INCLUDE,
  });
  if (!p) return;
  await getTypesenseAdmin()
    .collections(TYPESENSE_COLLECTION)
    .documents()
    .upsert(toTypesenseDoc(p));
}

export async function indexAllPractitioners(): Promise<{ indexed: number }> {
  const practitioners = await prisma.practitioner.findMany({ include: PRACTITIONER_INCLUDE });
  const docs = practitioners.map(toTypesenseDoc);
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
