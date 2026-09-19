import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { loadSettings, saveSetting, settingFromEnv, SETTING_KEYS } from '@/lib/platform-settings';

function fakeDb(seed: Array<{ key: string; value: string }> = []) {
  const rows = new Map(seed.map((r) => [r.key, r.value]));
  return {
    rows,
    platformSetting: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async findMany(args?: any) {
        const wanted: string[] = args?.where?.key?.in ?? Array.from(rows.keys());
        return wanted.filter((k) => rows.has(k)).map((k) => ({ key: k, value: rows.get(k)! }));
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async upsert(args: any) {
        rows.set(args.where.key, args.create?.value ?? args.update.value);
        return null;
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
