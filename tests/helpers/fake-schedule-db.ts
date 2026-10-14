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
  clients?: Array<{ id: string; practitionerId: string; rateScheduleId: string | null }>;
} = {}) {
  const schedules = new Map<string, Record<string, any>>();
  for (const s of seed.schedules ?? []) {
    schedules.set(s.id, { ...s, contentHash: rateScheduleContentHash(scheduleNumbers(s)) });
  }
  const settings = new Map<string, string>();
  if (seed.current) settings.set('current_rate_schedule_id', seed.current);
  const practitioners = new Map((seed.practitioners ?? []).map((p) => [p.id, { ...p }]));
  const clients = new Map((seed.clients ?? []).map((c) => [c.id, { ...c }]));
  const changes: Record<string, any>[] = [];
  const assignments: Record<string, any>[] = [];
  let seq = 0;

  /** Test hook: runs once, just before the NEXT guarded updateMany, to simulate a concurrent writer. */
  const hooks: { beforeUpdate?: () => void } = {};
  const db = {
    hooks,
    clients,
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
      // NO `create`: a plain create that loses the unique-hash race aborts a Postgres transaction
      // (25P02), so the code under test must use INSERT ... ON CONFLICT DO NOTHING (createMany with
      // skipDuplicates). A fake that offered `create` would let a regression pass silently.
      async createMany(args: any) {
        let count = 0;
        for (const data of args.data) {
          const dup = Array.from(schedules.values()).some((x) => x.contentHash === data.contentHash);
          if (dup) {
            if (args.skipDuplicates) continue;
            throw new Error('Unique constraint failed on contentHash');
          }
          const row = { id: `rs_${++seq}`, ...data };
          schedules.set(row.id, row);
          count += 1;
        }
        return { count };
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
          .filter(
            (p) =>
              p.rateScheduleId === args.where.rateScheduleId && (!args.where.id || p.id === args.where.id),
          )
          .map((p) => ({ id: p.id }));
      },
      async count(args: any) {
        return Array.from(practitioners.values()).filter((p) => p.rateScheduleId === args.where.rateScheduleId)
          .length;
      },
      async updateMany(args: any) {
        if (hooks.beforeUpdate) {
          const h = hooks.beforeUpdate;
          hooks.beforeUpdate = undefined;
          h();
        }
        const ids: string[] | null = args.where.id?.in ?? (typeof args.where.id === 'string' ? [args.where.id] : null);
        let count = 0;
        for (const p of Array.from(practitioners.values())) {
          // Honours the guard (`rateScheduleId` must still equal the expected value), including NULL.
          if ((!ids || ids.includes(p.id)) && p.rateScheduleId === args.where.rateScheduleId) {
            p.rateScheduleId = args.data.rateScheduleId;
            count += 1;
          }
        }
        return { count };
      },
    },
    attributedClient: {
      async updateMany(args: any) {
        let count = 0;
        for (const c of Array.from(clients.values())) {
          if (args.where.practitionerId.in.includes(c.practitionerId) && c.rateScheduleId === args.where.rateScheduleId) {
            c.rateScheduleId = args.data.rateScheduleId;
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
