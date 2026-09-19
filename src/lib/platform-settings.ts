/**
 * ADMIN-EDITABLE COMMERCIAL SETTINGS (spec v1.4 §1.1).
 *
 * Two numbers in this file decide money, and both were ruled by the operator rather than derived:
 *
 *  - LEAD ATTRIBUTION TERM — 8 months. ONE term governs BOTH plans (operator ruling 5,
 *    2026-09-18: "Both plan a and plan b reduce to 0% after the same term"). There is deliberately
 *    NO per-plan term field: a second field is how the two plans drift apart silently.
 *  - REFERRAL HOLD PERIOD — 90 days (operator ruling 7, 2026-09-18: "Standard hold will be
 *    90 days"). Per HELD LEDGER ROW, not per referrer.
 *
 * Both are SETTINGS, not literals, for the same reason plan prices live in env: they are
 * commercial parameters the operator changes without a deploy. Resolution order is
 * database row → environment variable → the ruled default, so an unseeded database behaves
 * correctly rather than charging zero.
 *
 * ⚠️ A CHANGE HERE IS FORWARD-ONLY (R1). Every attribution row SNAPSHOTS the term at creation,
 * so editing this setting must never retroactively lengthen or shorten a claim already sold.
 * See `snapshotTerm()` in attribution-term.ts — that snapshot is the enforcement, not a comment.
 */

export const SETTING_KEYS = {
  leadAttributionTermMonths: 'lead_attribution_term_months',
  referralHoldDays: 'referral_hold_days',
} as const;

export type SettingKey = (typeof SETTING_KEYS)[keyof typeof SETTING_KEYS];

type SettingDef = {
  key: SettingKey;
  /** Admin-facing label — the words in spec v1.4 §1.1, so the UI and the spec agree. */
  label: string;
  help: string;
  envVar: string;
  fallback: number;
  min: number;
  max: number;
  unit: 'months' | 'days';
};

export const SETTING_DEFS: Record<keyof typeof SETTING_KEYS, SettingDef> = {
  leadAttributionTermMonths: {
    key: SETTING_KEYS.leadAttributionTermMonths,
    label: 'Lead Attribution Term',
    help:
      'How long a platform-sourced client stays attributed to us, anchored on the first booked ' +
      'session’s scheduled start. Both plans charge their share inside this term and 0% after it. ' +
      'Changing this affects NEW attributions only — existing ones keep the term they were sold.',
    envVar: 'LEAD_ATTRIBUTION_TERM_MONTHS',
    fallback: 8,
    min: 1,
    max: 60,
    unit: 'months',
  },
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
    upsert(args: any): Promise<unknown>;
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
): Promise<{ leadAttributionTermMonths: number; referralHoldDays: number }> {
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
    leadAttributionTermMonths: resolve('leadAttributionTermMonths'),
    referralHoldDays: resolve('referralHoldDays'),
  };
}

/** Write one setting. Rejects out-of-range input loudly — this is an operator-facing edit. */
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
  await db.platformSetting.upsert({
    where: { key: def.key },
    create: { key: def.key, value, updatedByUserId: input.updatedByUserId ?? null },
    update: { value, updatedByUserId: input.updatedByUserId ?? null },
  });
}
