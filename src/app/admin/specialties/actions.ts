'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { indexAllPractitioners } from '@/lib/practitioner-indexer';
import { syncSpecialtySynonyms } from '@/lib/typesense-synonyms';

async function authorizeAdmin() {
  const session = await auth();
  // ⚠️ TEMP — LOCAL TESTING ONLY: admin gate disabled (matches /admin/*). REVERT BEFORE PUSH.
  // if (!session?.user || session.user.role !== 'ADMIN') {
  //   redirect('/auth/signin?callbackUrl=/admin/specialties');
  // }
  return session;
}

async function resyncSearch(reindex: boolean) {
  if (reindex) {
    await indexAllPractitioners().catch((e) => console.error('reindex failed', e));
  }
  await syncSpecialtySynonyms().catch((e) => console.error('synonym sync failed', e));
  revalidatePath('/admin/specialties');
  revalidatePath('/search');
}

/** Approve a PENDING alias → APPROVED (joins its canonical's synonym group). */
export async function approveAlias(aliasId: string): Promise<void> {
  await authorizeAdmin();
  await prisma.specialtyAlias.update({ where: { id: aliasId }, data: { status: 'APPROVED' } });
  await resyncSearch(false);
}

/** Reject a PENDING alias → REJECTED (excluded from synonyms). */
export async function rejectAlias(aliasId: string): Promise<void> {
  await authorizeAdmin();
  await prisma.specialtyAlias.update({ where: { id: aliasId }, data: { status: 'REJECTED' } });
  await resyncSearch(false);
}

/**
 * Promote a PROPOSED canonical → ACTIVE (optionally under a parent). Its PENDING aliases
 * are approved alongside. The taxonomy grows cleanly through this gate.
 */
export async function promoteSpecialty(specialtyId: string, parentId: string | null): Promise<void> {
  await authorizeAdmin();
  await prisma.$transaction([
    prisma.specialty.update({
      where: { id: specialtyId },
      data: { status: 'ACTIVE', parentId: parentId || null },
    }),
    prisma.specialtyAlias.updateMany({
      where: { specialtyId, status: 'PENDING' },
      data: { status: 'APPROVED' },
    }),
  ]);
  await resyncSearch(true);
}

/**
 * Merge a PROPOSED canonical INTO an existing canonical: repoint practitioner links + aliases
 * to the target, mark the source MERGED. This is the "gut health = digestive disorders" collapse
 * applied to a whole proposed node. The source's name also becomes an APPROVED alias of the
 * target so the original phrasing stays findable.
 */
export async function mergeSpecialty(sourceId: string, targetId: string): Promise<void> {
  await authorizeAdmin();
  if (sourceId === targetId) return;

  await prisma.$transaction(async (tx) => {
    const source = await tx.specialty.findUnique({ where: { id: sourceId } });
    if (!source) return;

    // Repoint practitioner links (skip rows that would collide on the composite PK).
    const links = await tx.practitionerSpecialty.findMany({ where: { specialtyId: sourceId } });
    for (const link of links) {
      const exists = await tx.practitionerSpecialty.findUnique({
        where: { practitionerId_specialtyId: { practitionerId: link.practitionerId, specialtyId: targetId } },
      });
      if (exists) {
        await tx.practitionerSpecialty.delete({
          where: { practitionerId_specialtyId: { practitionerId: link.practitionerId, specialtyId: sourceId } },
        });
      } else {
        await tx.practitionerSpecialty.update({
          where: { practitionerId_specialtyId: { practitionerId: link.practitionerId, specialtyId: sourceId } },
          data: { specialtyId: targetId },
        });
      }
    }

    // Repoint aliases → target, approving them (collapse). Skip label collisions.
    const aliases = await tx.specialtyAlias.findMany({ where: { specialtyId: sourceId } });
    for (const a of aliases) {
      const clash = await tx.specialtyAlias.findFirst({
        where: { label: a.label, specialtyId: targetId },
      });
      if (clash) {
        await tx.specialtyAlias.delete({ where: { id: a.id } });
      } else {
        await tx.specialtyAlias.update({
          where: { id: a.id },
          data: { specialtyId: targetId, status: 'APPROVED' },
        });
      }
    }

    // Keep the source's own name findable as an APPROVED alias of the target.
    const sourceLabel = source.name.trim().toLowerCase().replace(/\s+/g, ' ');
    const existingLabel = await tx.specialtyAlias.findUnique({ where: { label: sourceLabel } });
    if (!existingLabel) {
      await tx.specialtyAlias.create({
        data: { label: sourceLabel, specialtyId: targetId, source: 'CURATED', status: 'APPROVED' },
      });
    }

    await tx.specialty.update({
      where: { id: sourceId },
      data: { status: 'MERGED', mergedIntoId: targetId, parentId: null },
    });
  });

  await resyncSearch(true);
}

// formData wrappers for the moderation forms (selects can't bind args directly)
export async function promoteSpecialtyAction(formData: FormData): Promise<void> {
  const id = String(formData.get('specialtyId') ?? '');
  const parentId = String(formData.get('parentId') ?? '') || null;
  if (id) await promoteSpecialty(id, parentId);
}

export async function mergeSpecialtyAction(formData: FormData): Promise<void> {
  const sourceId = String(formData.get('sourceId') ?? '');
  const targetId = String(formData.get('targetId') ?? '');
  if (sourceId && targetId) await mergeSpecialty(sourceId, targetId);
}
