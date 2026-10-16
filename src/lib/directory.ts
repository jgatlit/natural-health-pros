/*
 * The landing page's read model.
 *
 * Replaces the frontier sandbox's generated `src/content/directory-data.ts`
 * fixture with the live query. The shapes below are the sandbox's, minus the
 * fields that existed only to substantiate the four claims held on 2026-08-10
 * (`firstSessionPriceCents`, `bookingLinkCount`, `hheCertified`) — carrying them
 * with no consumer would invite someone to re-render a held claim without
 * checking its acceptance test in docs/brand/2026-08-10-client-landing-copy.md.
 *
 * `listedWhere()` is the only filter. It is the same gate that drives Typesense
 * indexing, so the home page and /search can never disagree about who is listed.
 * No operator-account exclusion is layered on top: the two operator profiles are
 * unlisted at the data layer (no specialties), and a `role: { not: 'ADMIN' }`
 * filter would instead drop Amy Sprouse, who is both an ADMIN and a real
 * practitioner.
 */
import { prisma } from './prisma';
import { listedWhere } from './practitioner-indexer';
import { SPECIALTY_ORDER } from './practitioner-ordering';
import { buildSpecialtyLinks, type SpecialtyLink } from './specialty-graph';

export type DirectorySpecialty = {
  slug: string;
  name: string;
  /** Listed practitioners holding this specialty. Never the raw relation count. */
  count: number;
};

export type DirectoryCity = {
  slug: string;
  name: string;
  state: string;
  count: number;
};

export type DirectoryPractitioner = {
  slug: string;
  displayName: string;
  headline: string | null;
  photoUrl: string | null;
  photoFocalX: number;
  photoFocalY: number;
  photoZoom: number;
  websiteUrl: string | null;
  telehealth: boolean | null;
  specialties: { name: string; slug: string }[];
};

/** Every number the page renders reads from here, so a claim cannot drift from its data. */
export type DirectoryFacts = {
  practitionerCount: number;
  specialtyCount: number;
};

export type Directory = {
  practitioners: DirectoryPractitioner[];
  specialties: DirectorySpecialty[];
  /** Co-occurrence edges between `specialties`, for the specialty field. */
  specialtyLinks: SpecialtyLink[];
  cities: DirectoryCity[];
  facts: DirectoryFacts;
};

export async function getDirectory(): Promise<Directory> {
  const rows = await prisma.practitioner.findMany({
    where: listedWhere(),
    orderBy: { acceptedAt: 'desc' },
    include: {
      city: true,
      // Same order the profile renders — a practitioner's chips shouldn't reshuffle between
      // the directory card and the page it links to.
      specialties: {
        include: { specialty: true },
        orderBy: SPECIALTY_ORDER,
      },
    },
  });

  const practitioners: DirectoryPractitioner[] = rows.map((p) => ({
    slug: p.slug,
    displayName: p.displayName,
    headline: p.headline,
    photoUrl: p.photoUrl,
    photoFocalX: p.photoFocalX,
    photoFocalY: p.photoFocalY,
    photoZoom: p.photoZoom,
    websiteUrl: p.websiteUrl,
    telehealth: p.telehealth,
    specialties: p.specialties.map((ps) => ({
      name: ps.specialty.name,
      slug: ps.specialty.slug,
    })),
  }));

  // PROPOSED and MERGED nodes are held by real practitioners but are not yet
  // curated facets, so they stay out of the two controls that promise a filter
  // (the hero select and the constellation index) while remaining visible as
  // chips on the practitioner's own card.
  const bySlug = new Map<string, DirectorySpecialty>();
  for (const p of rows) {
    for (const ps of p.specialties) {
      if (ps.specialty.status !== 'ACTIVE') continue;
      const existing = bySlug.get(ps.specialty.slug);
      if (existing) {
        existing.count += 1;
      } else {
        bySlug.set(ps.specialty.slug, {
          slug: ps.specialty.slug,
          name: ps.specialty.name,
          count: 1,
        });
      }
    }
  }
  const specialties = Array.from(bySlug.values()).sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name),
  );

  // Derived from the SAME ACTIVE-only rule the index above applies, so an edge can never point
  // at a node that was filtered out.
  const specialtyLinks = buildSpecialtyLinks(
    rows.map((p) =>
      p.specialties.filter((ps) => ps.specialty.status === 'ACTIVE').map((ps) => ps.specialty.slug),
    ),
  );

  const byCity = new Map<string, DirectoryCity>();
  for (const p of rows) {
    if (!p.city) continue;
    const key = `${p.city.slug}|${p.city.state}`;
    const existing = byCity.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      byCity.set(key, { slug: p.city.slug, name: p.city.name, state: p.city.state, count: 1 });
    }
  }
  const cities = Array.from(byCity.values()).sort((a, b) => b.count - a.count);

  return {
    practitioners,
    specialties,
    specialtyLinks,
    cities,
    facts: { practitionerCount: practitioners.length, specialtyCount: specialties.length },
  };
}
