'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import * as Sentry from '@sentry/nextjs';
import { del } from '@vercel/blob';
import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { buildSectionWrite, maxSections, ownedBlobUrls, validateReorder } from '@/lib/custom-sections';

/**
 * Custom profile sections (L1b). Every action authorises the SLUG, then scopes every query by the
 * authorised practitioner's id, so a forged section id can never read, edit, reorder or delete
 * another practitioner's row. "Not found" and "not yours" collapse into the same response.
 */

async function authorizeForSlug(slug: string) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect(`/auth/signin?callbackUrl=/practitioners/${slug}/edit`);
  }
  const practitioner = await prisma.practitioner.findUnique({
    where: { slug },
    select: { id: true, userId: true },
  });
  const isOwner = practitioner?.userId === session.user.id;
  const isAdmin = session.user.role === 'ADMIN';
  if (!practitioner || (!isOwner && !isAdmin)) {
    redirect('/auth/error?error=AccessDenied');
  }
  return practitioner;
}

function backTo(slug: string, error?: string): never {
  revalidatePath(`/practitioners/${slug}`);
  revalidatePath(`/practitioners/${slug}/edit`);
  redirect(`/practitioners/${slug}/edit${error ? `?error=${error}` : ''}#sections`);
}

function inputFrom(formData: FormData) {
  return {
    title: formData.get('title'),
    bodyHtml: formData.get('bodyHtml'),
    caption: formData.get('caption'),
    mediaMode: formData.get('mediaMode'),
    embedUrl: formData.get('embedUrl'),
    mediaUrl: formData.get('mediaUrl'),
    posterUrl: formData.get('posterUrl'),
    published: formData.get('published') != null,
    attested: formData.get('attested') != null,
  };
}

/**
 * Delete Blob objects this practitioner owns. Each URL is re-validated against the practitioner's
 * own upload prefix first (never trusting that the stored value is clean), and a URL still used by
 * another section of theirs is kept. Best effort: a Blob failure is reported to Sentry but never
 * blocks the DB change, and never throws into the action.
 */
async function deleteOwnedBlobs(urls: string[], practitionerId: string, exceptSectionId: string | null) {
  for (const url of Array.from(new Set(urls))) {
    try {
      const stillUsed = await prisma.profileSection.count({
        where: {
          practitionerId,
          ...(exceptSectionId ? { id: { not: exceptSectionId } } : {}),
          OR: [{ mediaUrl: url }, { posterUrl: url }],
        },
      });
      if (stillUsed > 0) continue;
      await del(url, { token: process.env.BLOB_READ_WRITE_TOKEN });
    } catch (e) {
      Sentry.captureException(e, { tags: { area: 'profile-sections', op: 'blob-delete' } });
    }
  }
}

export async function createSection(slug: string, formData: FormData): Promise<void> {
  const target = await authorizeForSlug(slug);
  const built = buildSectionWrite(inputFrom(formData), target.id);
  if (!built.ok) backTo(slug, `section-${built.error}`);

  const created = await prisma.$transaction(async (tx) => {
    // Serialise concurrent creates for one practitioner so the cap cannot be raced past.
    await tx.$queryRaw`SELECT id FROM "Practitioner" WHERE id = ${target.id} FOR UPDATE`;
    const existing = await tx.profileSection.findMany({
      where: { practitionerId: target.id },
      select: { sortOrder: true },
      orderBy: { sortOrder: 'desc' },
    });
    if (existing.length >= maxSections()) return false;
    await tx.profileSection.create({
      data: {
        practitionerId: target.id,
        ...built.data,
        sortOrder: (existing[0]?.sortOrder ?? -1) + 1,
      },
    });
    return true;
  });
  if (!created) backTo(slug, 'section-cap');
  backTo(slug);
}

export async function updateSection(slug: string, formData: FormData): Promise<void> {
  const target = await authorizeForSlug(slug);
  const id = String(formData.get('sectionId') ?? '');
  const current = id
    ? await prisma.profileSection.findFirst({
        where: { id, practitionerId: target.id },
        select: { id: true, mediaKind: true, mediaUrl: true, posterUrl: true },
      })
    : null;
  if (!current) backTo(slug, 'section-not-found');

  const built = buildSectionWrite(inputFrom(formData), target.id);
  if (!built.ok) backTo(slug, `section-${built.error}`);

  await prisma.profileSection.updateMany({
    where: { id: current.id, practitionerId: target.id },
    data: built.data,
  });

  const keep = new Set(
    [built.data.mediaUrl, built.data.posterUrl].filter((u): u is string => typeof u === 'string'),
  );
  const orphaned = ownedBlobUrls(current, target.id).filter((u) => !keep.has(u));
  await deleteOwnedBlobs(orphaned, target.id, current.id);
  backTo(slug);
}

export async function deleteSection(slug: string, formData: FormData): Promise<void> {
  const target = await authorizeForSlug(slug);
  const id = String(formData.get('sectionId') ?? '');
  const current = id
    ? await prisma.profileSection.findFirst({
        where: { id, practitionerId: target.id },
        select: { id: true, mediaKind: true, mediaUrl: true, posterUrl: true },
      })
    : null;
  if (!current) backTo(slug, 'section-not-found');

  await prisma.profileSection.deleteMany({ where: { id: current.id, practitionerId: target.id } });
  await deleteOwnedBlobs(ownedBlobUrls(current, target.id), target.id, current.id);
  backTo(slug);
}

/**
 * Persist an order. The posted list must be EXACTLY this practitioner's own section ids, once
 * each - a foreign id, a duplicate, or a missing id rejects the whole request.
 */
export async function reorderSections(slug: string, formData: FormData): Promise<void> {
  const target = await authorizeForSlug(slug);
  let posted: unknown = null;
  try {
    posted = JSON.parse(String(formData.get('orderJson') ?? 'null'));
  } catch {
    posted = null;
  }
  const own = await prisma.profileSection.findMany({
    where: { practitionerId: target.id },
    select: { id: true },
  });
  const ids = validateReorder(posted, own.map((s) => s.id));
  if (!ids) redirect(`/practitioners/${slug}/edit?error=section-reorder-failed#sections`);

  await prisma.$transaction(
    ids.map((id, sortOrder) =>
      prisma.profileSection.updateMany({ where: { id, practitionerId: target.id }, data: { sortOrder } }),
    ),
  );
  revalidatePath(`/practitioners/${slug}`);
  revalidatePath(`/practitioners/${slug}/edit`);
}
