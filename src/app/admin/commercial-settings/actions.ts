'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { saveSetting, SETTING_DEFS } from '@/lib/platform-settings';

async function authorizeAdmin() {
  const session = await auth();
  if (!session?.user || session.user.role !== 'ADMIN') {
    redirect('/auth/signin?callbackUrl=/admin/commercial-settings');
  }
  return session;
}

export type SettingFormState = { ok: boolean; message: string } | null;

/**
 * Save one commercial setting.
 *
 * ⚠️ FORWARD-ONLY, AND THAT IS NOT ENFORCED HERE. Every attribution row snapshots the term at
 * creation and every held ledger row snapshots the hold, so a change made on this screen governs
 * NEW rows only. Nothing in this action needs to backfill, and anything that did would retroprice
 * claims already sold.
 */
export async function saveCommercialSetting(
  _prev: SettingFormState,
  formData: FormData,
): Promise<SettingFormState> {
  const session = await authorizeAdmin();

  const name = String(formData.get('name') ?? '');
  if (name !== 'leadAttributionTermMonths' && name !== 'referralHoldDays') {
    return { ok: false, message: 'Unknown setting.' };
  }
  const def = SETTING_DEFS[name];

  const raw = String(formData.get('value') ?? '').trim();
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    return { ok: false, message: `${def.label} must be a whole number of ${def.unit}.` };
  }

  try {
    await saveSetting(prisma, { name, value, updatedByUserId: session.user.id ?? null });
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Could not save.' };
  }

  revalidatePath('/admin/commercial-settings');
  return {
    ok: true,
    message: `${def.label} is now ${value} ${def.unit}. This applies to new attributions only — existing ones keep the term they were sold.`,
  };
}
