import { describe, expect, it } from 'vitest';

import {
  assignCurrentScheduleAtSignup,
  CohortMigrationError,
  findOrCreateSchedule,
  getCurrentSchedule,
  getScheduleForCopy,
  getScheduleForPractitioner,
  migrateCohort,
  requireCurrentSchedule,
  resolvePaymentTerms,
  saveCurrentSchedule,
  signupScheduleData,
} from '@/lib/rate-schedules';
import { NoRateScheduleError, RateScheduleInvariantError } from '@/lib/rate-schedule';
import { rateScheduleContentHash } from '@/lib/rate-schedule-hash';
import { V1, V1_NUMBERS, V2 } from './helpers/rate-schedule';
import { fakeScheduleDb } from './helpers/fake-schedule-db';

const seeded = () =>
  fakeScheduleDb({
    schedules: [V1],
    current: V1.id,
    practitioners: [
      { id: 'p1', rateScheduleId: V1.id },
      { id: 'p2', rateScheduleId: V1.id },
      { id: 'p3', rateScheduleId: null },
    ],
  });

describe('saving a schedule: find-by-hash or create (immutable rows)', () => {
  it('an identical combination REUSES the existing schedule id and creates nothing', async () => {
    const db = seeded();
    const { schedule, created } = await findOrCreateSchedule(db, V1_NUMBERS, { label: 'Anything' });

    expect(created).toBe(false);
    expect(schedule.id).toBe(V1.id);
    expect(db.schedules.size).toBe(1);
  });

  it('a new combination creates a NEW row and never edits the old one', async () => {
    const db = seeded();
    const before = { ...db.schedules.get(V1.id)! };
    const { schedule, created } = await findOrCreateSchedule(
      db,
      { ...V1_NUMBERS, planBSourcedBps: 2_000 },
      { label: 'Founding', createdByUserId: 'usr_admin' },
    );

    expect(created).toBe(true);
    expect(schedule.id).not.toBe(V1.id);
    expect(db.schedules.size).toBe(2);
    expect(db.schedules.get(V1.id)).toEqual(before);
    expect(db.schedules.get(schedule.id)).toMatchObject({
      label: 'Founding',
      createdByUserId: 'usr_admin',
      contentHash: rateScheduleContentHash({ ...V1_NUMBERS, planBSourcedBps: 2_000 }),
    });
  });

  it('loses a create race gracefully: the unique-hash loser returns the winner’s row', async () => {
    const db = seeded();
    const fields = { ...V1_NUMBERS, planASourcedBps: 900 };
    // Simulate "someone else created it between my lookup and my create".
    const realFind = db.rateSchedule.findUnique;
    let lookups = 0;
    db.rateSchedule.findUnique = async (args: unknown) => {
      lookups += 1;
      return lookups === 1 ? null : realFind(args);
    };
    await db.rateSchedule.create({ data: { contentHash: rateScheduleContentHash(fields), label: 'Winner', ...fields } });

    const { schedule, created } = await findOrCreateSchedule(db, fields, { label: 'Loser' });
    expect(created).toBe(false);
    expect(schedule.label).toBe('Winner');
  });

  it('REFUSES an invalid schedule before touching the database — the cap cannot be bypassed', async () => {
    const db = seeded();
    await expect(
      findOrCreateSchedule(db, { ...V1_NUMBERS, referralTotalBps: 3_500 }, { label: 'x' }),
    ).rejects.toBeInstanceOf(RateScheduleInvariantError);
    await expect(
      findOrCreateSchedule(db, { ...V1_NUMBERS, maxTotalFeeBps: 5_000, planBSourcedBps: 4_000 }, { label: 'x' }),
    ).rejects.toBeInstanceOf(RateScheduleInvariantError);
    expect(db.schedules.size).toBe(1);
  });
});

describe('admin save: makes a schedule current for NEW sign-ups only', () => {
  it('creates the schedule, points sign-ups at it, audits the change — and moves NOBODY', async () => {
    const db = seeded();
    const { schedule, created } = await saveCurrentSchedule(
      db,
      { ...V1_NUMBERS, planBSourcedBps: 2_000 },
      { label: 'Founding', byUserId: 'usr_admin' },
    );

    expect(created).toBe(true);
    expect(db.settings.get('current_rate_schedule_id')).toBe(schedule.id);
    expect(db.changes).toEqual([
      {
        key: 'current_rate_schedule_id',
        oldValue: V1.id,
        newValue: schedule.id,
        changedByUserId: 'usr_admin',
      },
    ]);
    // Existing practitioners keep what they had.
    expect(db.practitioners.get('p1')!.rateScheduleId).toBe(V1.id);
    expect(db.practitioners.get('p2')!.rateScheduleId).toBe(V1.id);
    expect(db.assignments).toEqual([]);
  });

  it('an existing practitioner’s fee is unchanged by the save (they still resolve to the old schedule)', async () => {
    const db = seeded();
    await saveCurrentSchedule(db, { ...V1_NUMBERS, planBSourcedBps: 2_000 }, { label: 'Founding', byUserId: 'a' });

    expect((await getScheduleForPractitioner(db, 'p1'))!.planBSourcedBps).toBe(3_000);
    expect((await getCurrentSchedule(db))!.planBSourcedBps).toBe(2_000);
  });

  it('saving numbers that already exist reuses the id and does not duplicate', async () => {
    const db = seeded();
    const { schedule, created } = await saveCurrentSchedule(db, V1_NUMBERS, { label: 'x', byUserId: 'a' });
    expect(created).toBe(false);
    expect(schedule.id).toBe(V1.id);
    expect(db.schedules.size).toBe(1);
  });

  it('a rejected save writes nothing at all', async () => {
    const db = seeded();
    await expect(
      saveCurrentSchedule(db, { ...V1_NUMBERS, planASourcedBps: 4_000 }, { label: 'x', byUserId: 'a' }),
    ).rejects.toThrow();
    expect(db.changes).toEqual([]);
    expect(db.settings.get('current_rate_schedule_id')).toBe(V1.id);
    expect(db.schedules.size).toBe(1);
  });
});

describe('new sign-ups', () => {
  it('are assigned the CURRENT schedule in the same create, with a SIGNUP history row', async () => {
    const db = seeded();
    expect(await signupScheduleData(db)).toEqual({
      rateScheduleId: V1.id,
      rateScheduleAssignments: { create: { rateScheduleId: V1.id, reason: 'SIGNUP' } },
    });
  });

  it('after an admin save, a NEW sign-up gets the new schedule', async () => {
    const db = seeded();
    const { schedule } = await saveCurrentSchedule(db, { ...V1_NUMBERS, planBSourcedBps: 2_000 }, { label: 'F', byUserId: 'a' });
    expect((await signupScheduleData(db)).rateScheduleId).toBe(schedule.id);
  });

  it('fails LOUDLY when no schedule is current, rather than creating a practitioner who cannot be charged', async () => {
    const db = fakeScheduleDb({ schedules: [V1], current: null });
    await expect(signupScheduleData(db)).rejects.toBeInstanceOf(NoRateScheduleError);
    await expect(requireCurrentSchedule(db)).rejects.toBeInstanceOf(NoRateScheduleError);
  });

  it('assignCurrentScheduleAtSignup writes the FK and the history row', async () => {
    const db = seeded();
    await assignCurrentScheduleAtSignup(db, 'p3', 'usr_admin');
    expect(db.practitioners.get('p3')!.rateScheduleId).toBe(V1.id);
    expect(db.assignments).toEqual([
      { practitionerId: 'p3', rateScheduleId: V1.id, reason: 'SIGNUP', byUserId: 'usr_admin' },
    ]);
  });
});

describe('fail-closed lookups', () => {
  it('a practitioner with no schedule resolves to null — never to the current one', async () => {
    const db = seeded();
    expect(await getScheduleForPractitioner(db, 'p3')).toBeNull();
    expect(await getScheduleForPractitioner(db, 'ghost')).toBeNull();
  });

  it('COPY may fall back to the current schedule (words only); the fee path never calls this', async () => {
    const db = seeded();
    expect((await getScheduleForCopy(db, null)).id).toBe(V1.id);
    expect((await getScheduleForCopy(db, 'rs_unknown')).id).toBe(V1.id);
  });
});

describe('migrate cohort X → Y', () => {
  const withV2 = () =>
    fakeScheduleDb({
      schedules: [V1, V2],
      current: V1.id,
      practitioners: [
        { id: 'p1', rateScheduleId: V1.id },
        { id: 'p2', rateScheduleId: V1.id },
        { id: 'p3', rateScheduleId: V2.id },
      ],
    });

  it('moves exactly the source cohort, writes one assignment per practitioner and one audit row', async () => {
    const db = withV2();
    const { moved } = await migrateCohort(db, {
      fromScheduleId: V1.id,
      toScheduleId: V2.id,
      reason: 'October cohort moves to the founding card',
      byUserId: 'usr_admin',
    });

    expect(moved).toBe(2);
    expect(db.practitioners.get('p1')!.rateScheduleId).toBe(V2.id);
    expect(db.practitioners.get('p2')!.rateScheduleId).toBe(V2.id);
    expect(db.practitioners.get('p3')!.rateScheduleId).toBe(V2.id);
    expect(db.assignments).toEqual([
      { practitionerId: 'p1', rateScheduleId: V2.id, reason: 'ADMIN_MIGRATION', byUserId: 'usr_admin' },
      { practitionerId: 'p2', rateScheduleId: V2.id, reason: 'ADMIN_MIGRATION', byUserId: 'usr_admin' },
    ]);
    expect(db.changes).toHaveLength(1);
    expect(db.changes[0]).toMatchObject({
      key: 'rate_schedule_cohort_migration',
      oldValue: V1.id,
      changedByUserId: 'usr_admin',
    });
    expect(JSON.parse(db.changes[0].newValue)).toEqual({
      to: V2.id,
      moved: 2,
      reason: 'October cohort moves to the founding card',
    });
  });

  it('REQUIRES a reason — and writes nothing without one', async () => {
    const db = withV2();
    for (const reason of ['', '  ', 'ab']) {
      await expect(
        migrateCohort(db, { fromScheduleId: V1.id, toScheduleId: V2.id, reason, byUserId: 'a' }),
      ).rejects.toBeInstanceOf(CohortMigrationError);
    }
    expect(db.changes).toEqual([]);
    expect(db.assignments).toEqual([]);
    expect(db.practitioners.get('p1')!.rateScheduleId).toBe(V1.id);
  });

  it('refuses a same-schedule move and unknown schedules', async () => {
    const db = withV2();
    await expect(
      migrateCohort(db, { fromScheduleId: V1.id, toScheduleId: V1.id, reason: 'because', byUserId: 'a' }),
    ).rejects.toBeInstanceOf(CohortMigrationError);
    await expect(
      migrateCohort(db, { fromScheduleId: V1.id, toScheduleId: 'rs_nope', reason: 'because', byUserId: 'a' }),
    ).rejects.toBeInstanceOf(CohortMigrationError);
    await expect(
      migrateCohort(db, { fromScheduleId: 'rs_nope', toScheduleId: V2.id, reason: 'because', byUserId: 'a' }),
    ).rejects.toBeInstanceOf(CohortMigrationError);
  });

  it('an empty source cohort moves nobody and records nothing', async () => {
    const db = fakeScheduleDb({ schedules: [V1, V2], current: V1.id, practitioners: [] });
    const { moved } = await migrateCohort(db, {
      fromScheduleId: V1.id,
      toScheduleId: V2.id,
      reason: 'nobody here',
      byUserId: 'a',
    });
    expect(moved).toBe(0);
    expect(db.changes).toEqual([]);
  });
});

describe('resolvePaymentTerms — which schedule starts the clock', () => {
  const withSnapshot = (rateScheduleId: string | null) => {
    const db = fakeScheduleDb({
      schedules: [V1, V2],
      current: V1.id,
      practitioners: [
        { id: 'p1', rateScheduleId: V2.id },
        { id: 'p3', rateScheduleId: null },
      ],
    });
    return Object.assign(db, {
      bookingFeeSnapshot: { findUnique: async () => (rateScheduleId ? { rateScheduleId } : null) },
    });
  };

  it('prefers the schedule that PRICED the booking (the snapshot’s), over the practitioner’s current one', async () => {
    const terms = await resolvePaymentTerms(withSnapshot(V1.id), { bookingIntentId: 'bi', practitionerId: 'p1' });
    expect(terms.rateScheduleId).toBe(V1.id);
  });

  it('then the practitioner’s own schedule', async () => {
    const terms = await resolvePaymentTerms(withSnapshot(null), { bookingIntentId: 'bi', practitionerId: 'p1' });
    expect(terms.rateScheduleId).toBe(V2.id);
  });

  it('then the current schedule — recording WHEN a clock starts, never what anyone is charged', async () => {
    const terms = await resolvePaymentTerms(withSnapshot(null), { bookingIntentId: 'bi', practitionerId: 'p3' });
    expect(terms).toEqual({ rateScheduleId: V1.id, leadTermMonths: 8, referrerTermMonths: 4 });
  });
});
