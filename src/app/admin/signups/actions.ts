'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';

async function requireAdmin() {
  const session = await auth();
  if (!session?.user || session.user.role !== 'ADMIN') {
    redirect('/auth/signin?callbackUrl=/admin/signups');
  }
  return session;
}

/** Enable or disable a cohort. Disabled => /join/<slug> shows a closed state and mints nothing. */
export async function setCohortEnabled(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = String(formData.get('id') ?? '');
  const enabled = String(formData.get('enabled') ?? '') === 'true';
  if (!id) return;
  await prisma.signupCohort.updateMany({ where: { id }, data: { enabled } });
  revalidatePath('/admin/signups');
  revalidatePath('/join/[cohort]', 'page');
}
