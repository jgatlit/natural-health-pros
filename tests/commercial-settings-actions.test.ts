import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SCHEDULE_FORM_FIELDS, toFormValue } from '@/lib/rate-schedule';
import { V1, V1_NUMBERS, V2 } from './helpers/rate-schedule';
import { fakeScheduleDb } from './helpers/fake-schedule-db';

/**
 * THE ADMIN SERVER ACTIONS, end to end against an in-memory database: authorisation, the
 * server-authoritative invariants ("the cap cannot be bypassed via admin"), find-or-create by hash,
 * and the audited cohort migration.
 */

const state = vi.hoisted(() => ({
  role: 'ADMIN' as 'ADMIN' | 'PRACTITIONER',
  db: null as unknown,
}));

vi.mock('@/auth', () => ({
  auth: async () => ({ user: { id: 'usr_admin', role: state.role } }),
}));
vi.mock('@/lib/prisma', () => ({
  get prisma() {
    return state.db;
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));

const formOf = (over: Record<string, string> = {}) => {
  const fd = new FormData();
  for (const f of SCHEDULE_FORM_FIELDS) fd.set(f.name, toFormValue(f.unit, V1_NUMBERS[f.field]));
  for (const [k, v] of Object.entries(over)) fd.set(k, v);
  return fd;
};

let actions: typeof import('@/app/admin/commercial-settings/actions');

beforeEach(async () => {
  state.role = 'ADMIN';
  state.db = fakeScheduleDb({
    schedules: [V1, V2],
    current: V1.id,
    practitioners: [
      { id: 'p1', rateScheduleId: V1.id },
      { id: 'p2', rateScheduleId: V1.id },
    ],
  });
  actions = await import('@/app/admin/commercial-settings/actions');
});

const db = () => state.db as ReturnType<typeof fakeScheduleDb>;

describe('saveRateSchedule', () => {
  it('is admin-only', async () => {
    state.role = 'PRACTITIONER';
    await expect(actions.saveRateSchedule(null, formOf())).rejects.toThrow(/REDIRECT:\/auth\/signin/);
    expect(db().schedules.size).toBe(2);
  });

  it('REJECTS a 35% referral total typed by an admin, server-side, and writes nothing', async () => {
    const result = await actions.saveRateSchedule(null, formOf({ referralTotal: '35' }));

    expect(result?.ok).toBe(false);
    expect(result?.message).toMatch(/referralTotalBps/);
    expect(db().schedules.size).toBe(2);
    expect(db().changes).toEqual([]);
  });

  it('REJECTS raising the cap and a rate together — the platform ceiling is not a form field', async () => {
    const result = await actions.saveRateSchedule(
      null,
      formOf({ maxTotalFee: '40', planBSourced: '35', referralTotal: '35' }),
    );
    expect(result?.ok).toBe(false);
    expect(result?.message).toMatch(/platform ceiling/);
    expect(db().schedules.size).toBe(2);
  });

  it('REJECTS garbage input rather than saving zeros', async () => {
    const result = await actions.saveRateSchedule(null, formOf({ planBSourced: 'thirty', leadTerm: '' }));
    expect(result?.ok).toBe(false);
    expect(db().schedules.size).toBe(2);
  });

  it('saving identical numbers REUSES the existing schedule id', async () => {
    const result = await actions.saveRateSchedule(null, formOf());
    expect(result?.ok).toBe(true);
    expect(result?.message).toMatch(/already exist/);
    expect(db().schedules.size).toBe(2);
    expect(db().settings.get('current_rate_schedule_id')).toBe(V1.id);
  });

  it('saving new numbers creates a NEW schedule for new sign-ups and leaves practitioners where they were', async () => {
    const result = await actions.saveRateSchedule(null, formOf({ planBSourced: '25', label: 'Founding' }));

    expect(result?.ok).toBe(true);
    expect(result?.message).toMatch(/Created schedule/);
    expect(result?.message).toMatch(/\$374\.40/);
    expect(db().schedules.size).toBe(3);
    const current = db().settings.get('current_rate_schedule_id')!;
    expect(current).not.toBe(V1.id);
    expect(db().schedules.get(current)).toMatchObject({ label: 'Founding', planBSourcedBps: 2_500, createdByUserId: 'usr_admin' });
    expect(db().practitioners.get('p1')!.rateScheduleId).toBe(V1.id);
    expect(db().practitioners.get('p2')!.rateScheduleId).toBe(V1.id);
  });
});

describe('migrateRateScheduleCohort', () => {
  const fd = (over: Record<string, string> = {}) => {
    const f = new FormData();
    f.set('fromScheduleId', V1.id);
    f.set('toScheduleId', V2.id);
    f.set('reason', 'Founding cohort');
    for (const [k, v] of Object.entries(over)) f.set(k, v);
    return f;
  };

  it('is admin-only', async () => {
    state.role = 'PRACTITIONER';
    await expect(actions.migrateRateScheduleCohort(null, fd())).rejects.toThrow(/REDIRECT/);
    expect(db().practitioners.get('p1')!.rateScheduleId).toBe(V1.id);
  });

  it('migrates the cohort and audit-logs the reason', async () => {
    const result = await actions.migrateRateScheduleCohort(null, fd());

    expect(result?.ok).toBe(true);
    expect(result?.message).toMatch(/Moved 2 practitioners/);
    expect(db().practitioners.get('p1')!.rateScheduleId).toBe(V2.id);
    expect(db().assignments).toHaveLength(2);
    expect(db().changes).toHaveLength(1);
    expect(JSON.parse(db().changes[0].newValue as string).reason).toBe('Founding cohort');
  });

  it('refuses without a reason and changes nothing', async () => {
    const result = await actions.migrateRateScheduleCohort(null, fd({ reason: '' }));

    expect(result?.ok).toBe(false);
    expect(result?.message).toMatch(/reason/i);
    expect(db().practitioners.get('p1')!.rateScheduleId).toBe(V1.id);
    expect(db().changes).toEqual([]);
  });
});

describe('assignSchedulesToUnassigned / assignScheduleToPractitioner (the in-app remedy for a NULL schedule)', () => {
  beforeEach(() => {
    state.db = fakeScheduleDb({
      schedules: [V1, V2],
      current: V2.id,
      practitioners: [
        { id: 'a', rateScheduleId: null },
        { id: 'b', rateScheduleId: null },
        { id: 'c', rateScheduleId: V1.id },
      ],
    });
  });

  const fd = (over: Record<string, string> = {}) => {
    const f = new FormData();
    f.set('reason', 'deploy-window sign-ups');
    for (const [k, v] of Object.entries(over)) f.set(k, v);
    return f;
  };

  it('is ADMIN only', async () => {
    state.role = 'PRACTITIONER';
    await expect(actions.assignSchedulesToUnassigned(null, fd())).rejects.toThrow(/REDIRECT/);
    await expect(actions.assignScheduleToPractitioner(fd({ practitionerId: 'a' }))).rejects.toThrow(/REDIRECT/);
    expect(db().practitioners.get('a')!.rateScheduleId).toBeNull();
  });

  it('requires a reason and changes nothing without one', async () => {
    const r = await actions.assignSchedulesToUnassigned(null, fd({ reason: '' }));
    expect(r?.ok).toBe(false);
    expect(r?.message).toMatch(/reason/i);
    expect(db().practitioners.get('a')!.rateScheduleId).toBeNull();
    expect(db().changes).toEqual([]);
  });

  it('assigns the current schedule to NULL rows only, audited, and is idempotent', async () => {
    const r = await actions.assignSchedulesToUnassigned(null, fd());
    expect(r?.ok).toBe(true);
    expect(r?.message).toMatch(/2 practitioners/);
    expect(db().practitioners.get('a')!.rateScheduleId).toBe(V2.id);
    expect(db().practitioners.get('c')!.rateScheduleId).toBe(V1.id);
    expect(db().assignments.map((x) => x.reason)).toEqual(['ADMIN_MIGRATION', 'ADMIN_MIGRATION']);
    expect(db().changes).toHaveLength(1);

    const again = await actions.assignSchedulesToUnassigned(null, fd());
    expect(again?.message).toMatch(/nothing changed/);
    expect(db().assignments).toHaveLength(2);
  });

  it('the per-practitioner action assigns exactly that practitioner and never an assigned one', async () => {
    await actions.assignScheduleToPractitioner(fd({ practitionerId: 'a' }));
    expect(db().practitioners.get('a')!.rateScheduleId).toBe(V2.id);
    expect(db().practitioners.get('b')!.rateScheduleId).toBeNull();

    await actions.assignScheduleToPractitioner(fd({ practitionerId: 'c' }));
    expect(db().practitioners.get('c')!.rateScheduleId).toBe(V1.id);
  });

  it('with no current schedule it refuses with a clear message', async () => {
    state.db = fakeScheduleDb({ schedules: [V1], current: null, practitioners: [{ id: 'a', rateScheduleId: null }] });
    const r = await actions.assignSchedulesToUnassigned(null, fd());
    expect(r?.ok).toBe(false);
    expect(r?.message).toMatch(/No rate schedule/);
  });
});
