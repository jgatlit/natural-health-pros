import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SCHEDULE_FORM_FIELDS, parseScheduleForm, toFormValue } from '@/lib/rate-schedule';
import { V1, V1_NUMBERS } from './helpers/rate-schedule';
import { fakeScheduleDb } from './helpers/fake-schedule-db';

/**
 * E12: THE AFFILIATE RATE IS EDITABLE IN ADMIN, THROUGH THE RATE SCHEDULE, DEFAULTING TO 3%.
 *
 * Shipped by L1's /admin/commercial-settings schedule form; this lane only proves the claim end to
 * end, because the affiliate ledger stores whatever `affiliateBps` the booking was PRICED under and
 * a field that cannot actually be changed would make the stored `bps` decorative.
 */

const state = vi.hoisted(() => ({ role: 'ADMIN' as 'ADMIN' | 'PRACTITIONER', db: null as unknown }));

vi.mock('@/auth', () => ({ auth: async () => ({ user: { id: 'usr_admin', role: state.role } }) }));
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
const db = () => state.db as ReturnType<typeof fakeScheduleDb>;

beforeEach(async () => {
  state.role = 'ADMIN';
  state.db = fakeScheduleDb({ schedules: [V1], current: V1.id, practitioners: [{ id: 'p1', rateScheduleId: V1.id }] });
  actions = await import('@/app/admin/commercial-settings/actions');
});

describe('the affiliate share on the schedule form', () => {
  const field = SCHEDULE_FORM_FIELDS.find((f) => f.field === 'affiliateBps');

  it('is a field of the form, in percent, labelled for the recruiting affiliate', () => {
    expect(field).toMatchObject({ name: 'affiliate', unit: 'percent' });
    expect(field!.label).toMatch(/affiliate/i);
  });

  it('defaults to 3%: the current schedule is 300 bps and the form shows "3"', () => {
    expect(V1.affiliateBps).toBe(300);
    expect(toFormValue('percent', V1.affiliateBps)).toBe('3');
    expect(parseScheduleForm((n) => (n === 'affiliate' ? '3' : '0')).affiliateBps).toBe(300);
  });

  it('saving a new rate creates a NEW schedule for new sign-ups; the old one is untouched', async () => {
    const result = await actions.saveRateSchedule(null, formOf({ affiliate: '5' }));

    expect(result?.ok).toBe(true);
    const current = db().settings.get('current_rate_schedule_id')!;
    expect(current).not.toBe(V1.id);
    expect(db().schedules.get(current)).toMatchObject({ affiliateBps: 500, createdByUserId: 'usr_admin' });
    expect(db().schedules.get(V1.id)).toMatchObject({ affiliateBps: 300 });
    expect(db().practitioners.get('p1')!.rateScheduleId).toBe(V1.id);
  });

  it('is admin-only', async () => {
    state.role = 'PRACTITIONER';
    await expect(actions.saveRateSchedule(null, formOf({ affiliate: '5' }))).rejects.toThrow(/REDIRECT:\/auth\/signin/);
    expect(db().schedules.size).toBe(1);
  });

  it('cannot be set above what the fee cap or NHP’s own rates can absorb (server-side)', async () => {
    // 31% breaks the cap; 11% exceeds the 10% NHP keeps on Plan A (the deduction would run short).
    for (const bad of ['31', '11']) {
      const result = await actions.saveRateSchedule(null, formOf({ affiliate: bad }));
      expect(result?.ok).toBe(false);
      expect(result?.message).toMatch(/affiliateBps|cover affiliateBps/);
    }
    expect(db().schedules.size).toBe(1);
  });
});
