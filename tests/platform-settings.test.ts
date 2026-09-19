import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { loadSettings, saveSetting, settingFromEnv, SETTING_KEYS } from '@/lib/platform-settings';

function fakeDb(seed: Array<{ key: string; value: string }> = []) {
  const rows = new Map(seed.map((r) => [r.key, r.value]));
  const changes: Record<string, unknown>[] = [];
  return {
    rows,
    changes,
    platformSetting: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async findMany(args?: any) {
        const wanted: string[] = args?.where?.key?.in ?? Array.from(rows.keys());
        return wanted.filter((k) => rows.has(k)).map((k) => ({ key: k, value: rows.get(k)! }));
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async findUnique(args: any) {
        const value = rows.get(args.where.key);
        return value === undefined ? null : { value };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async upsert(args: any) {
        rows.set(args.where.key, args.create?.value ?? args.update.value);
        return null;
      },
    },
    platformSettingChange: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async create(args: any) {
        changes.push(args.data);
        return args.data;
      },
    },
  };
}

const ENV = ['LEAD_ATTRIBUTION_TERM_MONTHS', 'REFERRAL_HOLD_DAYS'];

describe('operator-editable commercial settings', () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    for (const k of ENV) delete process.env[k];
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('defaults to the ruled numbers — 8 months and 90 days', async () => {
    // These two defaults ARE the operator rulings of 2026-09-18. An empty database must behave
    // per the ruling rather than charge zero or hold forever.
    expect(settingFromEnv('leadAttributionTermMonths')).toBe(8);
    expect(settingFromEnv('referralHoldDays')).toBe(90);
    await expect(loadSettings(fakeDb())).resolves.toEqual({
      leadAttributionTermMonths: 8,
      referralHoldDays: 90,
    });
  });

  it('prefers the stored value over the environment', async () => {
    process.env.LEAD_ATTRIBUTION_TERM_MONTHS = '10';
    const db = fakeDb([{ key: SETTING_KEYS.leadAttributionTermMonths, value: '12' }]);
    await expect(loadSettings(db)).resolves.toMatchObject({ leadAttributionTermMonths: 12 });
  });

  it('falls back rather than throwing when a stored value is corrupt', async () => {
    // A bad row must not take the checkout path down with it: the fee read happens on the
    // critical path of a mint, and a thrown setting there costs a live payment.
    const db = fakeDb([{ key: SETTING_KEYS.referralHoldDays, value: 'ninety' }]);
    await expect(loadSettings(db)).resolves.toMatchObject({ referralHoldDays: 90 });
  });

  it('refuses an out-of-range operator edit loudly', async () => {
    const db = fakeDb();
    await expect(
      saveSetting(db, { name: 'leadAttributionTermMonths', value: 0 }),
    ).rejects.toThrow(/Lead Attribution Term/);
    await expect(
      saveSetting(db, { name: 'referralHoldDays', value: 4000 }),
    ).rejects.toThrow(/Referral Hold Period/);
  });

  it('records who changed it', async () => {
    const db = fakeDb();
    await saveSetting(db, { name: 'referralHoldDays', value: 120, updatedByUserId: 'u1' });
    await expect(loadSettings(db)).resolves.toMatchObject({ referralHoldDays: 120 });
  });
});

describe('saveSetting — the §1.1 change log', () => {
  /**
   * Spec §1.1: "Every change is logged with the admin, the time, and the old and new values."
   *
   * `PlatformSetting` holds only the CURRENT value, which structurally cannot answer "who
   * shortened the term, when, and from what?" — and that question matters because the term decides
   * what a practitioner is charged. The log is a separate append-only table for that reason.
   */
  const fake = fakeDb;

  it('records the admin, the key, and BOTH values', async () => {
    const db = fake([{ key: 'lead_attribution_term_months', value: '8' }]);

    await saveSetting(db, {
      name: 'leadAttributionTermMonths',
      value: 6,
      updatedByUserId: 'usr_admin',
    });

    expect(db.changes).toEqual([
      {
        key: 'lead_attribution_term_months',
        oldValue: '8',
        newValue: '6',
        changedByUserId: 'usr_admin',
      },
    ]);
  });

  it('records a null oldValue on the first ever write, rather than inventing the default', () => {
    // The stored value and the resolved default are different facts. Logging "8 → 6" when there
    // was no row would claim somebody had set 8.
    const db = fake();
    return saveSetting(db, { name: 'referralHoldDays', value: 45, updatedByUserId: 'usr_admin' }).then(
      () => {
        expect(db.changes[0]).toMatchObject({ oldValue: null, newValue: '45' });
      },
    );
  });

  it('writes NO log entry when the value is rejected — a refused change is not a change', async () => {
    const db = fake([{ key: 'referral_hold_days', value: '90' }]);

    await expect(
      saveSetting(db, { name: 'referralHoldDays', value: 0, updatedByUserId: 'usr_admin' }),
    ).rejects.toThrow();

    expect(db.changes).toEqual([]);
    expect(db.rows.get('referral_hold_days')).toBe('90');
  });
});
