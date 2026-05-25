'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { indexPractitioner } from '@/lib/practitioner-indexer';

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

function buildSearchText(
  displayName: string,
  bio: string,
  cityName: string,
  cityState: string,
  specialtyNames: string[],
): string {
  return [displayName, bio, cityName, cityState, ...specialtyNames].join(' ');
}

function normalizeBookingUrl(raw: string): string | null {
  if (!raw) return null;
  let candidate = raw.trim();
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    // Light allowlist of known scheduling providers (forward-compat).
    const knownHosts = [
      'cal.com',
      'app.cal.com',
      'calendly.com',
      'savvycal.com',
      'tidycal.com',
      'koalendar.com',
      'youcanbookme.com',
      'acuityscheduling.com',
    ];
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const knownish = knownHosts.some((h) => host === h || host.endsWith(`.${h}`));
    if (!knownish) {
      // Allow custom domains too — operator can flag abuse manually.
      // But require at least a TLD.
      if (!host.includes('.')) return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export async function updatePractitioner(slug: string, formData: FormData): Promise<void> {
  const target = await authorizeForSlug(slug);

  const displayName = String(formData.get('displayName') ?? '').trim();
  const bio = String(formData.get('bio') ?? '').trim();
  const cityId = String(formData.get('cityId') ?? '').trim() || null;
  const yearsRaw = String(formData.get('yearsInPractice') ?? '').trim();
  const yearsInPractice = yearsRaw === '' ? null : Math.max(0, parseInt(yearsRaw, 10) || 0);
  const specialtyIds = formData.getAll('specialtyIds').map((s) => String(s));
  const bookingUrlRaw = String(formData.get('bookingUrl') ?? '').trim();
  const bookingUrl = normalizeBookingUrl(bookingUrlRaw);

  if (!displayName) {
    redirect(`/practitioners/${slug}/edit?error=name-required`);
  }
  if (bookingUrlRaw && !bookingUrl) {
    redirect(`/practitioners/${slug}/edit?error=invalid-booking-url`);
  }

  // City coords for haversine
  const city = cityId
    ? await prisma.city.findUnique({ where: { id: cityId } })
    : null;

  // Lookup specialty names for search-text composition
  const specialtyRows = await prisma.specialty.findMany({
    where: { id: { in: specialtyIds } },
    include: { parent: true },
  });
  const specialtyDisplayNames = Array.from(
    new Set(
      specialtyRows.flatMap((s) => (s.parent ? [s.name, s.parent.name] : [s.name])),
    ),
  );

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

  await prisma.$transaction(async (tx) => {
    await tx.practitionerSpecialty.deleteMany({ where: { practitionerId: target.id } });
    await tx.practitioner.update({
      where: { id: target.id },
      data: {
        displayName,
        bio: bio || null,
        cityId,
        latitude: coords?.[0] ?? null,
        longitude: coords?.[1] ?? null,
        yearsInPractice,
        bookingUrl,
        searchText: buildSearchText(
          displayName,
          bio,
          city?.name ?? '',
          city?.state ?? '',
          specialtyDisplayNames,
        ),
        specialties: {
          create: specialtyIds.map((id) => ({ specialty: { connect: { id } } })),
        },
      },
    });
  });

  await indexPractitioner(target.id).catch((err) =>
    console.error('Typesense reindex failed:', err),
  );

  revalidatePath(`/practitioners/${slug}`);
  revalidatePath(`/practitioners/${slug}/edit`);
  revalidatePath('/');
  revalidatePath('/search');
  redirect(`/practitioners/${slug}/edit?saved=1`);
}
