'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { extractError } from '@/lib/action-utils';
import { overrideAttribution } from '@/lib/attribution-override';

async function authorizeAdmin() {
  const session = await auth();
  if (!session?.user || session.user.role !== 'ADMIN') {
    redirect('/auth/signin?callbackUrl=/admin/attributions');
  }
  return session;
}

export type OverrideFormState = { ok: boolean; message: string } | null;

/**
 * Override who owns a client, or who referred them (spec §3.2, §7).
 *
 * DOUBLE-GATED on purpose: middleware's `/admin` rule reads the role from a 30-day JWT, and the
 * stale-role gap is a known open item, so the action checks again against the live session rather
 * than trusting the edge. The same belt-and-braces the commercial settings screen uses.
 */
export async function overrideAttributionAction(
  _prev: OverrideFormState,
  formData: FormData,
): Promise<OverrideFormState> {
  const session = await authorizeAdmin();

  const attributionId = String(formData.get('attributionId') ?? '').trim();
  const ownerRaw = String(formData.get('owner') ?? '').trim();
  const referrerRaw = String(formData.get('referrerPractitionerId') ?? '').trim();
  const note = String(formData.get('note') ?? '');

  if (!attributionId) return { ok: false, message: 'No attribution selected.' };

  try {
    await overrideAttribution(prisma, {
      attributionId,
      ...(ownerRaw === 'PRACTITIONER' || ownerRaw === 'NHP' ? { owner: ownerRaw } : {}),
      // An empty box means "clear the referrer"; an ABSENT field would mean "leave it alone", and
      // the two are different intents that a bare string cannot express. The form always submits
      // the field, so an empty value is always deliberate.
      ...(formData.has('referrerPractitionerId')
        ? { referrerPractitionerId: referrerRaw || null }
        : {}),
      note,
      adminUserId: session.user.id!,
    });
  } catch (err) {
    return { ok: false, message: extractError(err, 'Could not apply that override.') };
  }

  revalidatePath('/admin/attributions');
  return { ok: true, message: 'Override applied and written to the ledger.' };
}
