/**
 * ADMIN-EDITABLE COMMERCIAL SETTINGS (spec v1.4 §1.1, as amended by v1.5 §2).
 *
 * One number is left here, and it is operational rather than a rate:
 *
 *  - REFERRAL HOLD PERIOD — 90 days (operator ruling 7, 2026-09-18: "Standard hold will be
 *    90 days"). Per HELD LEDGER ROW, not per referrer. It is the unclaimed-share window of a
 *    referrer who cannot receive money yet; a referrer who can receive money is paid when the
 *    client's payment clears and no hold applies.
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
  kind: 'int';
  key: SettingKey;
  /** Admin-facing label — the words in the spec, so the UI and the spec agree. */
  label: string;
  help: string;
  envVar: string;
  fallback: number;
  min: number;
  max: number;
  unit: 'months' | 'days';
  /** A change must carry a human reason, recorded on the audit row. */
  requiresReason?: boolean;
};

export const SETTING_DEFS: Record<keyof typeof SETTING_KEYS, SettingDef> = {
  referralHoldDays: {
    kind: 'int',
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

/**
 * WHAT PRACTITIONERS SEE (operator, 2026-10-19). Two switches and a note that decide whether the
 * plan and commission figures are PUBLISHED on practitioner-facing screens. They change words only:
 * no fee, rate or term is read from here, and the checkout buttons always show the price.
 *
 * ⚠️ BOTH SWITCHES RESOLVE TO OFF WHEN NO ROW EXISTS (operator ruling: off at go-live). There is no
 * env var and no seeded row on purpose, so "nobody has turned it on" and "off" are the same state.
 */
export const DISPLAY_SETTING_KEYS = {
  showPlanRates: 'show_plan_rates',
  showCommissionTerms: 'show_commission_terms',
  pricingNote: 'pricing_note',
} as const;

export type DisplaySettingName = keyof typeof DISPLAY_SETTING_KEYS;

type BoolSettingDef = {
  kind: 'bool';
  key: (typeof DISPLAY_SETTING_KEYS)[DisplaySettingName];
  label: string;
  help: string;
};

type TextSettingDef = {
  kind: 'text';
  key: (typeof DISPLAY_SETTING_KEYS)[DisplaySettingName];
  label: string;
  help: string;
  maxLength: number;
};

export const PRICING_NOTE_MAX_LENGTH = 140;

export const DISPLAY_SETTING_DEFS: {
  showPlanRates: BoolSettingDef;
  showCommissionTerms: BoolSettingDef;
  pricingNote: TextSettingDef;
} = {
  showPlanRates: {
    kind: 'bool',
    key: DISPLAY_SETTING_KEYS.showPlanRates,
    label: 'Show plan rates',
    help:
      'Off: plan cards describe what is included, with no prices or percentages. On: the prices and ' +
      'shares from each practitioner’s rate schedule are shown. Checkout buttons always show the price.',
  },
  showCommissionTerms: {
    kind: 'bool',
    key: DISPLAY_SETTING_KEYS.showCommissionTerms,
    label: 'Show commission terms',
    help:
      'Off: referral and invite tools stay, without percentages, amounts or months, and say terms are ' +
      'being finalised. On: the referral split and recruiter share from the rate schedule are shown.',
  },
  pricingNote: {
    kind: 'text',
    key: DISPLAY_SETTING_KEYS.pricingNote,
    label: 'Pricing note',
    help:
      'Optional. When set, plan cards and prices carry an asterisk and this note beneath them, on ' +
      'onboarding, the edit page and the billing card. Leave empty to show nothing.',
    maxLength: PRICING_NOTE_MAX_LENGTH,
  },
};

export type DisplaySettings = {
  showPlanRates: boolean;
  showCommissionTerms: boolean;
  /** Null when unset or empty: nothing (no asterisk, no note) is rendered. */
  pricingNote: string | null;
};

/** Every switch OFF and no note — the state of a database nobody has configured. */
export const DISPLAY_DEFAULTS: DisplaySettings = {
  showPlanRates: false,
  showCommissionTerms: false,
  pricingNote: null,
};

/** Only the exact stored string 'true' is on. Anything else, including a malformed row, is off. */
function parseBool(raw: string | undefined | null): boolean {
  return raw === 'true';
}

function normaliseNote(raw: string | undefined | null): string | null {
  const t = (raw ?? '').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, PRICING_NOTE_MAX_LENGTH) : null;
}

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

function parseBoundedInt(raw: string | undefined | null, def: SettingDef): number | null {
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
  const fromEnv = parseBoundedInt(process.env[def.envVar], def);
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
    return parseBoundedInt(byKey.get(def.key), def) ?? settingFromEnv(name);
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
  input: {
    name: keyof typeof SETTING_KEYS;
    value: number;
    updatedByUserId?: string | null;
    /** Why. Required for a setting whose definition says so; recorded on the audit row. */
    reason?: string | null;
  },
): Promise<void> {
  const def = SETTING_DEFS[input.name];
  const reason = input.reason?.trim() ? input.reason.trim().slice(0, 500) : null;
  if (def.requiresReason && (!reason || reason.length < 3)) {
    throw new Error(`${def.label} needs a reason for the change (it moves when money can be paid out)`);
  }
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
      reason,
    },
  });
}

/** Resolve the display switches and note. No row means OFF / no note; never an env read. */
export async function loadDisplaySettings(db: Pick<SettingsDb, 'platformSetting'>): Promise<DisplaySettings> {
  const rows = await db.platformSetting.findMany({
    where: { key: { in: Object.values(DISPLAY_SETTING_KEYS) } },
    select: { key: true, value: true },
  });
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  return {
    showPlanRates: parseBool(byKey.get(DISPLAY_SETTING_KEYS.showPlanRates)),
    showCommissionTerms: parseBool(byKey.get(DISPLAY_SETTING_KEYS.showCommissionTerms)),
    pricingNote: normaliseNote(byKey.get(DISPLAY_SETTING_KEYS.pricingNote)),
  };
}

/**
 * Write one display setting and log it with the admin, the time and old → new, exactly as
 * `saveSetting` does. A save that does not change the stored value writes nothing and logs
 * nothing, so the change history only ever lists real changes. Returns whether a change was made.
 */
export async function saveDisplaySetting(
  db: SettingsDb,
  input:
    | { name: 'showPlanRates' | 'showCommissionTerms'; value: boolean; updatedByUserId?: string | null }
    | { name: 'pricingNote'; value: string; updatedByUserId?: string | null },
): Promise<{ changed: boolean }> {
  const def = DISPLAY_SETTING_DEFS[input.name];
  let value: string;
  if (def.kind === 'bool') {
    if (typeof input.value !== 'boolean') throw new Error(`${def.label} must be on or off`);
    value = input.value ? 'true' : 'false';
  } else {
    if (typeof input.value !== 'string') throw new Error(`${def.label} must be text`);
    value = input.value.replace(/\s+/g, ' ').trim();
    if (value.length > def.maxLength) {
      throw new Error(`${def.label} must be ${def.maxLength} characters or fewer (got ${value.length})`);
    }
  }

  const previous = await db.platformSetting.findUnique({
    where: { key: def.key },
    select: { value: true },
  });
  if (previous?.value === value) return { changed: false };
  // Clearing a note that was never set is not a change either.
  if (!previous && def.kind === 'text' && value === '') return { changed: false };

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
      reason: null,
    },
  });
  return { changed: true };
}

/**
 * THE DISCLOSURE SAFEGUARD. A switch that is OFF is fine while nothing it hides has happened yet;
 * the first fee-bearing booking (plan rates) or the first recruited practitioner (commission terms)
 * is the point at which a practitioner is owed the figures. Returns one message per switch that
 * should be turned on now.
 */
export function displayWarnings(input: {
  display: Pick<DisplaySettings, 'showPlanRates' | 'showCommissionTerms'>;
  feeBearingBookings: number;
  recruitedPractitioners: number;
}): string[] {
  const out: string[] = [];
  if (!input.display.showPlanRates && input.feeBearingBookings > 0) {
    out.push(
      `Plan rates are hidden, but ${input.feeBearingBookings} booking${input.feeBearingBookings === 1 ? ' has' : 's have'} ` +
        'carried a fee. Turn on “Show plan rates” so practitioners can see what they are charged.',
    );
  }
  if (!input.display.showCommissionTerms && input.recruitedPractitioners > 0) {
    out.push(
      `Commission terms are hidden, but ${input.recruitedPractitioners} practitioner${input.recruitedPractitioners === 1 ? ' was' : 's were'} ` +
        'recruited by a colleague. Turn on “Show commission terms” so the recruiter share is disclosed.',
    );
  }
  return out;
}
