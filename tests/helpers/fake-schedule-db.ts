import { rateScheduleContentHash } from '@/lib/rate-schedule-hash';
import { scheduleNumbers, type RateSchedule } from '@/lib/rate-schedule';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * An in-memory stand-in for the handful of Prisma delegates the rate-schedule code touches. It
 * honours the behaviours the code relies on (unique `contentHash`, `where` filters on
 * `practitioner.updateMany`), because a fake that ignored them would pass an implementation with
 * no lock at all.
 */
export function fakeScheduleDb(seed: {
  schedules?: RateSchedule[];
  current?: string | null;
  practitioners?: Array<{ id: string; rateScheduleId: string | null }>;
} = {}) {
  const schedules = new Map<string, Record<string, any>>();
  for (const s of seed.schedules ?? []) {
    schedules.set(s.id, { ...s, contentHash: rateScheduleContentHash(scheduleNumbers(s)) });
  }
  const settings = new Map<string, string>();
  if (seed.current) settings.set('current_rate_schedule_id', seed.current);
  const practitioners = new Map((seed.practitioners ?? []).map((p) => [p.id, { ...p }]));
  const changes: Record<string, any>[] = [];
  const assignments: Record<string, any>[] = [];
  let seq = 0;

  const db = {
    schedules,
    settings,
    practitioners,
    changes,
    assignments,
    rateSchedule: {
      async findUnique(args: any) {
        if (args.where.id) return schedules.get(args.where.id) ?? null;
        return Array.from(schedules.values()).find((s) => s.contentHash === args.where.contentHash) ?? null;
      },
      async create(args: any) {
        const dup = Array.from(schedules.values()).some((s) => s.contentHash === args.data.contentHash);
        if (dup) throw new Error('Unique constraint failed on contentHash');
        const row = { id: `rs_${++seq}`, ...args.data };
        schedules.set(row.id, row);
        return row;
      },
    },
    platformSetting: {
      async findUnique(args: any) {
        const v = settings.get(args.where.key);
        return v === undefined ? null : { value: v };
      },
      async upsert(args: any) {
        settings.set(args.where.key, settings.has(args.where.key) ? args.update.value : args.create.value);
        return null;
      },
    },
    platformSettingChange: {
      async create(args: any) {
        changes.push(args.data);
        return args.data;
      },
    },
    practitioner: {
      async findUnique(args: any) {
        const p = practitioners.get(args.where.id);
        if (!p) return null;
        return { ...p, rateSchedule: p.rateScheduleId ? (schedules.get(p.rateScheduleId) ?? null) : null };
      },
      async update(args: any) {
        const p = practitioners.get(args.where.id);
        if (!p) throw new Error('no such practitioner');
        Object.assign(p, args.data);
        return p;
      },
      async findMany(args: any) {
        return Array.from(practitioners.values())
          .filter((p) => p.rateScheduleId === args.where.rateScheduleId)
          .map((p) => ({ id: p.id }));
      },
      async updateMany(args: any) {
        let count = 0;
        for (const p of Array.from(practitioners.values())) {
          if (args.where.id.in.includes(p.id) && p.rateScheduleId === args.where.rateScheduleId) {
            p.rateScheduleId = args.data.rateScheduleId;
            count += 1;
          }
        }
        return { count };
      },
    },
    rateScheduleAssignment: {
      async create(args: any) {
        assignments.push(args.data);
        return args.data;
      },
      async createMany(args: any) {
        assignments.push(...args.data);
        return { count: args.data.length };
      },
    },
    async $transaction(cb: (tx: any) => Promise<any>) {
      return cb(db);
    },
  };
  return db;
}
