'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { saveSetting, SETTING_DEFS } from '@/lib/platform-settings';
import {
  parseScheduleForm,
  RateScheduleInvariantError,
  annualPlanAPriceCents,
  type RateScheduleNumbers,
} from '@/lib/rate-schedule';
import {
  assignCurrentToUnassigned,
  CohortMigrationError,
  migrateCohort,
  saveCurrentSchedule,
} from '@/lib/rate-schedules';
import { NoRateScheduleError } from '@/lib/rate-schedule';

async function authorizeAdmin() {
  const session = await auth();
  if (!session?.user || session.user.role !== 'ADMIN') {
    redirect('/auth/signin?callbackUrl=/admin/commercial-settings');
  }
  return session;
}

export type SettingFormState = { ok: boolean; message: string } | null;

/**
 * Save one commercial setting (today only the referral hold period — rates and terms live in the
 * rate schedule below).
 *
 * ⚠️ FORWARD-ONLY, AND THAT IS NOT ENFORCED HERE. Every held ledger row snapshots the hold at
 * creation, so a change made on this screen governs NEW rows only.
 */
export async function saveCommercialSetting(
  _prev: SettingFormState,
  formData: FormData,
): Promise<SettingFormState> {
  const session = await authorizeAdmin();

  const name = String(formData.get('name') ?? '');
  if (name !== 'referralHoldDays') {
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
    message: `${def.label} is now ${value} ${def.unit}. This applies to new holds only — existing ones keep the hold they were created under.`,
  };
}

/**
 * SAVE THE CURRENT RATE SCHEDULE (spec v1.5 §2).
 *
 * Server-authoritative: the browser's live validation is a courtesy, and `saveCurrentSchedule`
 * re-runs every invariant (including the 30% platform ceiling) before anything is written. A save
 * finds the existing schedule by content hash or creates a new one, then makes it the schedule NEW
 * sign-ups get. It moves NOBODY who already has one, and re-prices no in-flight term.
 */
export async function saveRateSchedule(
  _prev: SettingFormState,
  formData: FormData,
): Promise<SettingFormState> {
  const session = await authorizeAdmin();

  const fields = parseScheduleForm((name) => {
    const v = formData.get(name);
    return typeof v === 'string' ? v : null;
  });
  const labelRaw = String(formData.get('label') ?? '').trim();
  const label = labelRaw.slice(0, 80) || `Custom — ${new Date().toISOString().slice(0, 10)}`;

  let result;
  try {
    result = await prisma.$transaction((tx) =>
      saveCurrentSchedule(tx, fields, { label, byUserId: session.user.id ?? null }),
    );
  } catch (err) {
    if (err instanceof RateScheduleInvariantError) {
      return { ok: false, message: `Not saved. ${err.violations.join('. ')}.` };
    }
    return { ok: false, message: err instanceof Error ? err.message : 'Could not save.' };
  }

  revalidatePath('/admin/commercial-settings');
  const annual = annualPlanAPriceCents(result.schedule as RateScheduleNumbers);
  return {
    ok: true,
    message:
      (result.created
        ? `Created schedule “${result.schedule.label}”.`
        : `These numbers already exist as “${result.schedule.label}” — reused it.`) +
      ` It is now the schedule for NEW sign-ups (yearly Plan A: $${(annual / 100).toFixed(2)}).` +
      ' Nobody who already has a schedule was moved.',
  };
}

/**
 * MIGRATE COHORT X → Y. The only way an existing practitioner changes schedule. Requires a reason;
 * writes one assignment row per practitioner moved and one audit row.
 */
export async function migrateRateScheduleCohort(
  _prev: SettingFormState,
  formData: FormData,
): Promise<SettingFormState> {
  const session = await authorizeAdmin();

  const fromScheduleId = String(formData.get('fromScheduleId') ?? '');
  const toScheduleId = String(formData.get('toScheduleId') ?? '');
  const reason = String(formData.get('reason') ?? '');

  try {
    const { moved } = await prisma.$transaction((tx) =>
      migrateCohort(tx, {
        fromScheduleId,
        toScheduleId,
        reason,
        byUserId: session.user.id ?? null,
      }),
    );
    revalidatePath('/admin/commercial-settings');
    return {
      ok: true,
      message:
        moved === 0
          ? 'Nobody is on the source schedule, so nothing moved.'
          : `Moved ${moved} practitioner${moved === 1 ? '' : 's'}. Clients already attributed keep the rates they were sold under; new clients are priced on the new schedule.`,
    };
  } catch (err) {
    if (err instanceof CohortMigrationError || err instanceof RateScheduleInvariantError) {
      return { ok: false, message: err.message };
    }
    return { ok: false, message: err instanceof Error ? err.message : 'Could not migrate.' };
  }
}

/**
 * ASSIGN THE CURRENT SCHEDULE TO EVERY PRACTITIONER WHO HAS NONE (the in-app deploy-window remedy).
 *
 * Practitioners with no schedule are refused at checkout; this is how an admin fixes that without a
 * manual production write. ADMIN only, reason required, audited, and idempotent: each update is
 * guarded on `rateScheduleId IS NULL`, so it can never move someone who already has a schedule.
 */
export async function assignSchedulesToUnassigned(
  _prev: SettingFormState,
  formData: FormData,
): Promise<SettingFormState> {
  const session = await authorizeAdmin();
  try {
    const { assigned } = await prisma.$transaction((tx) =>
      assignCurrentToUnassigned(tx, {
        reason: String(formData.get('reason') ?? ''),
        byUserId: session.user.id ?? null,
      }),
    );
    revalidatePath('/admin/commercial-settings');
    revalidatePath('/admin/invites');
    return {
      ok: true,
      message:
        assigned === 0
          ? 'Nobody was unassigned, so nothing changed.'
          : `Assigned the current schedule to ${assigned} practitioner${assigned === 1 ? '' : 's'}.`,
    };
  } catch (err) {
    if (err instanceof CohortMigrationError || err instanceof NoRateScheduleError) {
      return { ok: false, message: err.message };
    }
    return { ok: false, message: err instanceof Error ? err.message : 'Could not assign.' };
  }
}

/**
 * The per-practitioner version, for the practitioner's row on /admin/invites. Same guarantees:
 * ADMIN only, reason required, audited, touches the row ONLY if its schedule is still NULL.
 */
export async function assignScheduleToPractitioner(formData: FormData): Promise<void> {
  const session = await authorizeAdmin();
  const practitionerId = String(formData.get('practitionerId') ?? '');
  if (!practitionerId) throw new Error('Missing practitioner.');
  await prisma.$transaction((tx) =>
    assignCurrentToUnassigned(tx, {
      reason: String(formData.get('reason') ?? ''),
      byUserId: session.user.id ?? null,
      practitionerId,
    }),
  );
  revalidatePath('/admin/commercial-settings');
  revalidatePath('/admin/invites');
}
