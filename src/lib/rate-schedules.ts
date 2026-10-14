/**
 * RATE SCHEDULES — the database half (spec v1.5 §2). Pure rules live in `rate-schedule.ts`.
 *
 * What lives here: reading a schedule, saving one (find-by-hash or create), making one current for
 * NEW sign-ups, assigning one to a practitioner with history, and the audited "migrate cohort
 * X → Y" action.
 *
 * Three rules this file exists to enforce:
 *
 *  1. IMMUTABLE ROWS. Nothing here ever updates a `RateSchedule`. "Saving" in admin is
 *     find-by-`contentHash` or create, so the same numbers are always the same id and an edit can
 *     never re-price a practitioner who is already on the old card.
 *  2. CURRENT IS FOR NEW SIGN-UPS ONLY. `current_rate_schedule_id` is read at practitioner
 *     creation and by the onboarding copy. Changing it moves nobody. Existing practitioners move
 *     ONLY through `migrateCohort`, which requires a reason and is audited.
 *  3. FAIL CLOSED. `getScheduleForPractitioner` returns null for a practitioner with none and the
 *     fee path turns that into a refusal (`NoRateScheduleError`). Nothing here supplies a default.
 *
 * STRUCTURAL db types, as everywhere else in this codebase (see attributed-clients.ts): a unit
 * test stubs the handful of calls a function makes instead of a sixteen-method Prisma delegate.
 */

import {
  assertRateScheduleValid,
  NoRateScheduleError,
  scheduleNumbers,
  type RateSchedule,
  type RateScheduleNumbers,
} from './rate-schedule';
import { rateScheduleContentHash } from './rate-schedule-hash';

/** PlatformSetting key holding the schedule new sign-ups are assigned. */
export const CURRENT_RATE_SCHEDULE_KEY = 'current_rate_schedule_id';
/** PlatformSettingChange key for the audited cohort migration. */
export const COHORT_MIGRATION_AUDIT_KEY = 'rate_schedule_cohort_migration';

export type AssignmentReason = 'SIGNUP' | 'COHORT_LINK' | 'ADMIN_MIGRATION' | 'CUSTOM_DEAL';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type RateScheduleDb = {
  rateSchedule: {
    findUnique(args: any): Promise<any>;
    createMany(args: any): Promise<{ count: number }>;
  };
  platformSetting: {
    findUnique(args: any): Promise<any>;
    upsert(args: any): Promise<unknown>;
  };
  platformSettingChange: {
    create(args: any): Promise<unknown>;
  };
};

export type PractitionerScheduleDb = {
  practitioner: {
    findUnique(args: any): Promise<any>;
    update(args: any): Promise<unknown>;
  };
  rateScheduleAssignment: {
    create(args: any): Promise<unknown>;
  };
};

export type CohortMigrationDb = RateScheduleDb & {
  attributedClient: {
    updateMany(args: any): Promise<{ count: number }>;
  };
  practitioner: {
    findMany(args: any): Promise<Array<{ id: string }>>;
    updateMany(args: any): Promise<{ count: number }>;
  };
  rateScheduleAssignment: {
    createMany(args: any): Promise<unknown>;
  };
};
/* eslint-enable @typescript-eslint/no-explicit-any */

type ScheduleRow = RateScheduleNumbers & { id: string; label: string; contentHash?: string };

/** A stored row → the shape the fee path and the copy take. Extra columns are dropped. */
export function toRateSchedule(row: ScheduleRow): RateSchedule & { contentHash?: string } {
  return {
    id: row.id,
    label: row.label,
    ...scheduleNumbers(row),
    ...(row.contentHash ? { contentHash: row.contentHash } : {}),
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type FindScheduleDb = { rateSchedule: { findUnique(args: any): Promise<any> } };
type FindPractitionerDb = { practitioner: { findUnique(args: any): Promise<any> } };
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function getScheduleById(db: FindScheduleDb, id: string | null | undefined) {
  if (!id) return null;
  const row = (await db.rateSchedule.findUnique({ where: { id } })) as ScheduleRow | null;
  return row ? toRateSchedule(row) : null;
}

/** The schedule NEW sign-ups are assigned. Null when none is configured (fail closed upstream). */
export async function getCurrentSchedule(db: RateScheduleDb) {
  const setting = (await db.platformSetting.findUnique({
    where: { key: CURRENT_RATE_SCHEDULE_KEY },
    select: { value: true },
  })) as { value: string } | null;
  return getScheduleById(db, setting?.value);
}

export async function requireCurrentSchedule(db: RateScheduleDb) {
  const schedule = await getCurrentSchedule(db);
  if (!schedule) throw new NoRateScheduleError(null, 'no current schedule is configured');
  return schedule;
}

/**
 * The schedule a practitioner is priced under, or null. Null is a REFUSAL signal, never a prompt
 * to look for a default — see the fee path.
 */
export async function getScheduleForPractitioner(db: FindPractitionerDb, practitionerId: string) {
  const row = (await db.practitioner.findUnique({
    where: { id: practitionerId },
    select: { rateSchedule: true },
  })) as { rateSchedule: ScheduleRow | null } | null;
  return row?.rateSchedule ? toRateSchedule(row.rateSchedule) : null;
}

/**
 * The schedule to quote in COPY (plan cards, referral sentences, emails): the practitioner's own if
 * they have one, otherwise the current one. COPY ONLY. This is the single place a fallback to
 * "current" is allowed, because words on a page move no money — the fee path never uses it.
 */
export async function getScheduleForCopy(
  db: RateScheduleDb,
  rateScheduleId: string | null | undefined,
): Promise<RateSchedule> {
  return (await getScheduleById(db, rateScheduleId)) ?? (await requireCurrentSchedule(db));
}

/**
 * Save a combination: find the existing row by content hash or create it. Validation runs FIRST,
 * so there is no way to store a schedule that has not passed every invariant (including the 30%
 * ceiling) — the admin form's live checks are a courtesy, this is the authority.
 *
 * Race: two admins saving the same new combination both miss the lookup and one `create` loses the
 * unique `contentHash` race. The loser re-reads and returns the winner's row.
 */
export async function findOrCreateSchedule(
  db: Pick<RateScheduleDb, 'rateSchedule'>,
  fields: Partial<RateScheduleNumbers>,
  meta: { label: string; createdByUserId?: string | null },
): Promise<{ schedule: RateSchedule; created: boolean }> {
  assertRateScheduleValid(fields);
  const numbers = scheduleNumbers(fields);
  const contentHash = rateScheduleContentHash(numbers);

  const existing = (await db.rateSchedule.findUnique({ where: { contentHash } })) as ScheduleRow | null;
  if (existing) return { schedule: toRateSchedule(existing), created: false };

  // INSERT ... ON CONFLICT DO NOTHING (`createMany` + `skipDuplicates`), then SELECT. A plain
  // `create` that loses the unique-`contentHash` race raises a constraint violation, and inside the
  // admin action's `$transaction` Postgres ABORTS the whole transaction on it (25P02) - so a
  // catch-and-re-read cannot work there. `ON CONFLICT DO NOTHING` does not raise, so it is valid
  // inside a transaction; `count` says whether this call inserted the row.
  const { count } = await db.rateSchedule.createMany({
    data: [
      {
        contentHash,
        label: meta.label,
        ...numbers,
        createdByUserId: meta.createdByUserId ?? null,
      },
    ],
    skipDuplicates: true,
  });
  const row = (await db.rateSchedule.findUnique({ where: { contentHash } })) as ScheduleRow | null;
  if (!row) throw new Error('Rate schedule vanished between insert and read');
  return { schedule: toRateSchedule(row), created: count > 0 };
}

/** Make a stored schedule the one new sign-ups get, and audit the change. */
export async function setCurrentSchedule(
  db: RateScheduleDb,
  scheduleId: string,
  byUserId: string | null,
): Promise<void> {
  const target = await getScheduleById(db, scheduleId);
  if (!target) throw new Error(`Unknown rate schedule ${scheduleId}`);

  const previous = (await db.platformSetting.findUnique({
    where: { key: CURRENT_RATE_SCHEDULE_KEY },
    select: { value: true },
  })) as { value: string } | null;

  await db.platformSetting.upsert({
    where: { key: CURRENT_RATE_SCHEDULE_KEY },
    create: { key: CURRENT_RATE_SCHEDULE_KEY, value: scheduleId, updatedByUserId: byUserId },
    update: { value: scheduleId, updatedByUserId: byUserId },
  });
  await db.platformSettingChange.create({
    data: {
      key: CURRENT_RATE_SCHEDULE_KEY,
      oldValue: previous?.value ?? null,
      newValue: scheduleId,
      changedByUserId: byUserId,
    },
  });
}

/**
 * The admin "save": validate → find-or-create by hash → make it current for NEW sign-ups.
 * Moves no existing practitioner and re-prices no in-flight term.
 */
export async function saveCurrentSchedule(
  db: RateScheduleDb,
  fields: Partial<RateScheduleNumbers>,
  meta: { label: string; byUserId: string | null },
): Promise<{ schedule: RateSchedule; created: boolean }> {
  const result = await findOrCreateSchedule(db, fields, {
    label: meta.label,
    createdByUserId: meta.byUserId,
  });
  await setCurrentSchedule(db, result.schedule.id, meta.byUserId);
  return result;
}

/** Put a practitioner on a schedule and record why. History is append-only. */
export async function assignSchedule(
  db: PractitionerScheduleDb,
  input: { practitionerId: string; scheduleId: string; reason: AssignmentReason; byUserId?: string | null },
): Promise<void> {
  await db.practitioner.update({
    where: { id: input.practitionerId },
    data: { rateScheduleId: input.scheduleId },
  });
  await db.rateScheduleAssignment.create({
    data: {
      practitionerId: input.practitionerId,
      rateScheduleId: input.scheduleId,
      reason: input.reason,
      byUserId: input.byUserId ?? null,
    },
  });
}

/**
 * NEW SIGN-UPS: assign whatever schedule is current at the moment the practitioner row is
 * created. Throws if none is configured — a practitioner created without a schedule would sit at
 * "checkout refuses" until an admin noticed, so creation fails loudly instead.
 */
export async function assignCurrentScheduleAtSignup(
  db: RateScheduleDb & PractitionerScheduleDb,
  practitionerId: string,
  byUserId: string | null = null,
): Promise<RateSchedule> {
  const current = await requireCurrentSchedule(db);
  await assignSchedule(db, { practitionerId, scheduleId: current.id, reason: 'SIGNUP', byUserId });
  return current;
}

/**
 * The `data` fragment for CREATING a practitioner under the current schedule: the foreign key and
 * its SIGNUP history row, in the same `create`, so the two cannot disagree and there is no window
 * in which a new practitioner exists without a schedule. Throws if no schedule is current.
 */
export async function signupScheduleData(db: RateScheduleDb) {
  const current = await requireCurrentSchedule(db);
  return {
    rateScheduleId: current.id,
    rateScheduleAssignments: { create: { rateScheduleId: current.id, reason: 'SIGNUP' as const } },
  };
}

export class CohortMigrationError extends Error {}

/**
 * MIGRATE COHORT X → Y: move every practitioner currently on schedule X to schedule Y.
 *
 * The only path by which an EXISTING practitioner changes schedule, so it demands a reason and
 * leaves two records: one `RateScheduleAssignment` per practitioner moved (reason
 * ADMIN_MIGRATION) and one `PlatformSettingChange` row carrying the admin, the from/to ids, the
 * count and the reason. Wrap the call in a transaction.
 *
 * Clients already attributed keep the schedule snapshot on their `AttributedClient` row: a
 * migration changes what NEW clients cost, never what an in-flight term was sold at.
 */
export async function migrateCohort(
  db: CohortMigrationDb,
  input: { fromScheduleId: string; toScheduleId: string; reason: string; byUserId: string | null },
): Promise<{ moved: number }> {
  const reason = input.reason.trim();
  if (reason.length < 3) throw new CohortMigrationError('A reason is required to migrate a cohort.');
  if (input.fromScheduleId === input.toScheduleId) {
    throw new CohortMigrationError('The source and destination schedules are the same.');
  }
  const [from, to] = await Promise.all([
    getScheduleById(db, input.fromScheduleId),
    getScheduleById(db, input.toScheduleId),
  ]);
  if (!from) throw new CohortMigrationError(`Unknown source schedule ${input.fromScheduleId}.`);
  if (!to) throw new CohortMigrationError(`Unknown destination schedule ${input.toScheduleId}.`);
  // A stored row is trusted to have been validated at creation, but the destination is about to be
  // applied to real money, so re-check it rather than assume.
  assertRateScheduleValid(to);

  const members = await db.practitioner.findMany({
    where: { rateScheduleId: from.id },
    select: { id: true },
  });
  const moved = await moveGuarded(db, members.map((m) => m.id), from.id, to.id, input.byUserId);
  if (moved.length === 0) return { moved: 0 };

  await db.platformSettingChange.create({
    data: {
      key: COHORT_MIGRATION_AUDIT_KEY,
      oldValue: from.id,
      newValue: JSON.stringify({ to: to.id, moved: moved.length, reason }),
      changedByUserId: input.byUserId,
    },
  });
  return { moved: moved.length };
}

/**
 * Move each practitioner from `fromId` (a schedule id, or null = unassigned) to `toId`, ONE GUARDED
 * UPDATE EACH, and write an `ADMIN_MIGRATION` assignment row ONLY for those whose update actually
 * matched. A practitioner who changed schedule between the read and the write (a concurrent
 * migration, an assignment) matches nothing and gets neither a move nor a history row, so the
 * history, the audit count and the data cannot disagree.
 */
async function moveGuarded(
  db: CohortMigrationDb,
  ids: string[],
  fromId: string | null,
  toId: string,
  byUserId: string | null,
): Promise<string[]> {
  const moved: string[] = [];
  for (const id of ids) {
    const { count } = await db.practitioner.updateMany({
      where: { id, rateScheduleId: fromId },
      data: { rateScheduleId: toId },
    });
    if (count > 0) moved.push(id);
  }
  if (moved.length > 0) {
    await db.rateScheduleAssignment.createMany({
      data: moved.map((practitionerId) => ({
        practitionerId,
        rateScheduleId: toId,
        reason: 'ADMIN_MIGRATION',
        byUserId,
      })),
    });
  }
  return moved;
}

/** How many practitioners have no schedule (and are therefore refused at checkout). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function countUnassigned(db: { practitioner: { count(args: any): Promise<number> } }) {
  return db.practitioner.count({ where: { rateScheduleId: null } });
}

export const UNASSIGNED_AUDIT_KEY = 'rate_schedule_unassigned_assignment';

/**
 * ASSIGN THE CURRENT SCHEDULE TO EVERY UNASSIGNED PRACTITIONER (the in-app deploy-window remedy).
 *
 * Touches ONLY rows whose `rateScheduleId` is NULL - each update is guarded on that, so it is
 * idempotent and can never move a practitioner who already has a schedule. Reason required;
 * writes one `ADMIN_MIGRATION` assignment per practitioner actually assigned and one audit row.
 * Pass `practitionerId` to assign a single practitioner (the per-row action).
 */
export async function assignCurrentToUnassigned(
  db: CohortMigrationDb,
  input: { reason: string; byUserId: string | null; practitionerId?: string },
): Promise<{ assigned: number; scheduleId: string }> {
  const reason = input.reason.trim();
  if (reason.length < 3) {
    throw new CohortMigrationError('A reason is required to assign a schedule.');
  }
  const current = await requireCurrentSchedule(db);
  assertRateScheduleValid(current);

  const unassigned = await db.practitioner.findMany({
    where: { rateScheduleId: null, ...(input.practitionerId ? { id: input.practitionerId } : {}) },
    select: { id: true },
  });
  const moved = await moveGuarded(db, unassigned.map((p) => p.id), null, current.id, input.byUserId);
  if (moved.length > 0) {
    // Their existing clients have no schedule snapshot either (nothing could be pinned while the
    // practitioner had none). Pin them to the schedule just assigned - the same one the fee path
    // would fall back to - so a later cohort migration cannot re-price them. NULL rows only.
    await db.attributedClient.updateMany({
      where: { practitionerId: { in: moved }, rateScheduleId: null },
      data: { rateScheduleId: current.id },
    });
    await db.platformSettingChange.create({
      data: {
        key: UNASSIGNED_AUDIT_KEY,
        oldValue: null,
        newValue: JSON.stringify({
          to: current.id,
          assigned: moved.length,
          reason,
          ...(input.practitionerId ? { practitionerId: input.practitionerId } : {}),
        }),
        changedByUserId: input.byUserId,
      },
    });
  }
  return { assigned: moved.length, scheduleId: current.id };
}

/**
 * The terms to SNAPSHOT onto a client's attribution row when their first payment lands.
 *
 * Preference order: the schedule that PRICED this booking (its fee snapshot's `rateScheduleId`),
 * then the practitioner's own, then the current schedule. The last step is allowed here — and only
 * here — because this records WHEN A CLOCK STARTS, not what anyone is charged: a payment can reach
 * us through the hosted-checkout fallback with no fee snapshot at all, and the claim must still be
 * written or the term never starts (see `commitPaymentAttribution`). A row recorded under the
 * current schedule cannot over-charge anyone, because the fee path refuses a practitioner with no
 * schedule before it ever reads the row.
 */
export async function resolvePaymentTerms(
  db: RateScheduleDb &
    Pick<PractitionerScheduleDb, 'practitioner'> & {
      bookingFeeSnapshot: { findUnique(args: any): Promise<any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
    },
  input: { bookingIntentId: string; practitionerId: string },
): Promise<{ rateScheduleId: string; leadTermMonths: number; referrerTermMonths: number }> {
  const snapshot = (await db.bookingFeeSnapshot.findUnique({
    where: { bookingIntentId: input.bookingIntentId },
    select: { rateScheduleId: true },
  })) as { rateScheduleId?: string | null } | null;

  const schedule =
    (await getScheduleById(db, snapshot?.rateScheduleId)) ??
    (await getScheduleForPractitioner(db, input.practitionerId)) ??
    (await requireCurrentSchedule(db));

  return {
    rateScheduleId: schedule.id,
    leadTermMonths: schedule.leadTermMonths,
    referrerTermMonths: schedule.referrerTermMonths,
  };
}
