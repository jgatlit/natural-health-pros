/**
 * ADMIN-EDITABLE COMMERCIAL SETTINGS (spec v1.4 §1.1, as amended by v1.5 §2).
 *
 * One number is left here, and it is operational rather than a rate:
 *
 *  - REFERRAL HOLD PERIOD — 90 days (operator ruling 7, 2026-09-18: "Standard hold will be
 *    90 days"). Per HELD LEDGER ROW, not per referrer.
 *
 * ⚠️ THE LEAD ATTRIBUTION TERM IS NO LONGER A SETTING. Spec v1.5 §2 moved both attribution terms
 * (and every rate) into the immutable `RateSchedule` a practitioner is priced under; the
 * `lead_attribution_term_months` row seeded schedule v1 and was then retired. Nothing on the fee
 * path reads it any more, and the old `LEAD_ATTRIBUTION_TERM_MONTHS` env var is gone with it.
 * Old PlatformSetting rows with that key are inert and may be left in place.
 *
 * Resolution order is database row → environment variable → the ruled default, so an unseeded
 * database behaves correctly rather than holding for zero days.
 *
 * ⚠️ A CHANGE HERE IS FORWARD-ONLY. Every held ledger row snapshots the hold at creation.
 */

export const SETTING_KEYS = {
  referralHoldDays: 'referral_hold_days',
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

type SettingDef = {
  key: SettingKey;
  /** Admin-facing label — the words in the spec, so the UI and the spec agree. */
  label: string;
  help: string;
  envVar: string;
  fallback: number;
  min: number;
  max: number;
  unit: 'months' | 'days';
};

export const SETTING_DEFS: Record<keyof typeof SETTING_KEYS, SettingDef> = {
  referralHoldDays: {
    key: SETTING_KEYS.referralHoldDays,
    label: 'Referral Hold Period',
    help:
      'How long a referrer’s unpaid share is held while they claim their Whop account. The clock ' +
      'runs per held row from the moment the share could not be paid. At expiry the row is marked ' +
      'expired_unclaimed and surfaced here — no money moves automatically, in either direction.',
    envVar: 'REFERRAL_HOLD_DAYS',
    fallback: 90,
    min: 1,
    max: 3650,
    unit: 'days',
  },
};

/** STRUCTURAL, not the generated delegate — see the note in attributed-clients.ts. */
type SettingsDb = {
  platformSetting: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany(args?: any): Promise<Array<{ key: string; value: string }>>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findUnique(args: any): Promise<{ value: string } | null>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    upsert(args: any): Promise<unknown>;
  };
  platformSettingChange: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    create(args: any): Promise<unknown>;
  };
};

function parsePositiveInt(raw: string | undefined | null, def: SettingDef): number | null {
  if (raw === undefined || raw === null || raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < def.min || n > def.max) return null;
  return n;
}

/**
 * Resolve one setting WITHOUT a database read — env or the ruled default.
 *
 * Exists because the fee path is already doing one ledger read on the critical path of a checkout
 * mint, and because middleware and unit tests must be able to answer "how long is the term?"
 * without Prisma in the import graph.
 */
export function settingFromEnv(name: keyof typeof SETTING_KEYS): number {
  const def = SETTING_DEFS[name];
  const fromEnv = parsePositiveInt(process.env[def.envVar], def);
  return fromEnv ?? def.fallback;
}

/** Resolve every setting, database first. A malformed stored value falls back rather than throwing. */
export async function loadSettings(
  db: SettingsDb,
): Promise<{ referralHoldDays: number }> {
  const rows = await db.platformSetting.findMany({
    where: { key: { in: Object.values(SETTING_KEYS) } },
    select: { key: true, value: true },
  });
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const resolve = (name: keyof typeof SETTING_KEYS) => {
    const def = SETTING_DEFS[name];
    return parsePositiveInt(byKey.get(def.key), def) ?? settingFromEnv(name);
  };
  return {
    referralHoldDays: resolve('referralHoldDays'),
  };
}

/**
 * Write one setting, and LOG THE CHANGE (spec §1.1: "logged with the admin, the time, and the old
 * and new values").
 *
 * The log is a separate append-only table because `PlatformSetting` holds only the CURRENT value
 * and therefore structurally cannot answer "who shortened the term, when, and from what?" — a
 * question that matters precisely because the term decides what practitioners are charged.
 *
 * Rejects out-of-range input loudly and BEFORE writing either row: a refused change is not a
 * change, and logging one would put an event in the audit trail that never happened.
 */
export async function saveSetting(
  db: SettingsDb,
  input: { name: keyof typeof SETTING_KEYS; value: number; updatedByUserId?: string | null },
): Promise<void> {
  const def = SETTING_DEFS[input.name];
  if (!Number.isInteger(input.value) || input.value < def.min || input.value > def.max) {
    throw new Error(
      `${def.label} must be a whole number of ${def.unit} between ${def.min} and ${def.max}`,
    );
  }
  const value = String(input.value);

  // Read the PREVIOUS stored value before overwriting it. Null when there has never been a row —
  // deliberately not the resolved default, because "nobody had set this" and "somebody set it to
  // 8" are different facts and the log should not claim the second when the first is true.
  const previous = await db.platformSetting.findUnique({
    where: { key: def.key },
    select: { value: true },
  });

  await db.platformSetting.upsert({
    where: { key: def.key },
    create: { key: def.key, value, updatedByUserId: input.updatedByUserId ?? null },
    update: { value, updatedByUserId: input.updatedByUserId ?? null },
  });

  await db.platformSettingChange.create({
    data: {
      key: def.key,
      oldValue: previous?.value ?? null,
      newValue: value,
      changedByUserId: input.updatedByUserId ?? null,
    },
  });
}
