import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { loadSettings, saveSetting, settingFromEnv, SETTING_DEFS, SETTING_KEYS } from '@/lib/platform-settings';

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

const ENV = ['REFERRAL_HOLD_DAYS'];

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

  it('defaults to the ruled 90-day hold', async () => {
    // This default IS the operator ruling of 2026-09-18. An empty database must behave per the
    // ruling rather than hold for zero days or forever.
    expect(settingFromEnv('referralHoldDays')).toBe(90);
    await expect(loadSettings(fakeDb())).resolves.toEqual({ referralHoldDays: 90 });
  });

  it('prefers the stored value over the environment', async () => {
    process.env.REFERRAL_HOLD_DAYS = '30';
    const db = fakeDb([{ key: SETTING_KEYS.referralHoldDays, value: '45' }]);
    await expect(loadSettings(db)).resolves.toMatchObject({ referralHoldDays: 45 });
  });

  it('the lead attribution term is RETIRED as a setting (it lives in the rate schedule now)', async () => {
    // Spec v1.5 §2: `lead_attribution_term_months` seeded schedule v1 and was then retired. A stale
    // row or env var must not resurrect it on the fee path.
    process.env.LEAD_ATTRIBUTION_TERM_MONTHS = '3';
    const db = fakeDb([{ key: 'lead_attribution_term_months', value: '3' }]);
    expect(Object.keys(SETTING_KEYS)).toEqual(['referralHoldDays']);
    await expect(loadSettings(db)).resolves.toEqual({ referralHoldDays: 90 });
    delete process.env.LEAD_ATTRIBUTION_TERM_MONTHS;
  });

  it('falls back rather than throwing when a stored value is corrupt', async () => {
    // A bad row must not take the checkout path down with it: the fee read happens on the
    // critical path of a mint, and a thrown setting there costs a live payment.
    const db = fakeDb([{ key: SETTING_KEYS.referralHoldDays, value: 'ninety' }]);
    await expect(loadSettings(db)).resolves.toMatchObject({ referralHoldDays: 90 });
  });

  it('refuses an out-of-range operator edit loudly', async () => {
    const db = fakeDb();
    await expect(saveSetting(db, { name: 'referralHoldDays', value: 0 })).rejects.toThrow(
      /Referral Hold Period/,
    );
    await expect(saveSetting(db, { name: 'referralHoldDays', value: 4000 })).rejects.toThrow(
      /Referral Hold Period/,
    );
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
    const db = fake([{ key: 'referral_hold_days', value: '90' }]);

    await saveSetting(db, {
      name: 'referralHoldDays',
      value: 60,
      updatedByUserId: 'usr_admin',
    });

    expect(db.changes).toEqual([
      {
        key: 'referral_hold_days',
        oldValue: '90',
        newValue: '60',
        changedByUserId: 'usr_admin',
        reason: null,
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

describe('the recruiter payout hold does not exist', () => {
  it('is not a setting: recruiters are paid as each client payment clears', () => {
    expect(Object.keys(SETTING_KEYS)).toEqual(['referralHoldDays']);
    expect(Object.keys(SETTING_DEFS)).toEqual(['referralHoldDays']);
  });

  it('a stray affiliate_hold_days row (or env var) is inert: it is neither read nor returned', async () => {
    process.env.AFFILIATE_HOLD_DAYS = '30';
    try {
      const db = fakeDb([{ key: 'affiliate_hold_days', value: '7' }]);
      await expect(loadSettings(db)).resolves.toEqual({ referralHoldDays: 90 });
    } finally {
      delete process.env.AFFILIATE_HOLD_DAYS;
    }
  });

  it('the referral hold does not demand a reason', async () => {
    const db = fakeDb();
    await expect(
      saveSetting(db, { name: 'referralHoldDays', value: 45, updatedByUserId: 'u' }),
    ).resolves.toBeUndefined();
  });
});
