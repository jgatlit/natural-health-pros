/**
 * RATE SCHEDULES (spec v1.5 §2) — the pure half: the fields, the ONE canonical hash, the
 * invariants, and the numbers derived from a schedule.
 *
 * A rate schedule is the whole price card a practitioner is under: both plans, the referral split,
 * the recruiting affiliate and both attribution terms. Rows are IMMUTABLE and content-addressed —
 * the same combination of numbers is always the same row — so "everyone who joined in October keeps
 * October's card" is one id, and an admin "rate change" can never re-price anyone: it finds or
 * creates a schedule and makes it current for NEW sign-ups only.
 *
 * ⚠️ NO PRISMA, NO `next/headers`, NO `node:crypto`. The fee path, the plan-card copy, the unit
 * tests AND the admin form's live validation (a client component) all import this, so it must be
 * safe in a browser bundle. The sha256 therefore lives next door in `rate-schedule-hash.ts`, which
 * is server-only; the canonical SERIALISATION it hashes is defined here.
 *
 * ⚠️ THE DATABASE IS THE ONLY SOURCE OF RATES. There is deliberately NO exported default schedule
 * here: a constant with the ruled numbers in it is exactly the "literal rate default" the spec
 * removes, and it is the first thing a fee path would reach for when a lookup came back empty.
 * Schedule v1 exists only in the migration SQL.
 */

const BPS_DENOMINATOR = 10_000;

/**
 * THE CANONICAL FIELD ORDER. The hash is computed over exactly these keys in exactly this order, so
 * adding a field to the Prisma model without adding it here changes nothing about identity — and
 * changing this list re-keys every schedule. Treat it as append-never: a new rate dimension is a
 * new serialisation version, not an edit.
 */
export const RATE_SCHEDULE_FIELDS = [
  'planAMonthlyCents',
  'annualDiscountBps',
  'planASourcedBps',
  'planBMonthlyCents',
  'planBSourcedBps',
  'referralTotalBps',
  'referrerBps',
  'affiliateBps',
  'leadTermMonths',
  'referrerTermMonths',
  'maxTotalFeeBps',
] as const;

export type RateScheduleField = (typeof RATE_SCHEDULE_FIELDS)[number];

/** The numeric content of a schedule — everything the hash covers, and nothing else. */
export type RateScheduleNumbers = Record<RateScheduleField, number>;

/** A stored schedule: the numbers plus its identity. `label` is cosmetic and NOT hashed. */
export type RateSchedule = RateScheduleNumbers & { id: string; label?: string };

/**
 * ⚠️ THE O6 CEILING: "Total fees charged to a practitioner never exceed 30%, in any circumstance."
 *
 * `maxTotalFeeBps` is a field on the schedule so the invariants can be written in terms of it, but
 * an editable cap that can be edited upward is not a cap. This constant is the one number in the
 * module that is NOT admin-reachable: raising it past 30% is a code change and a deliberate
 * review, never a form field. It is the operator's absolute ruling, not a default.
 */
export const PLATFORM_FEE_CEILING_BPS = 3_000;

/** Hard sanity bounds, so a typo cannot produce a schedule the UI then has to render. */
const MAX_TERM_MONTHS = 60;
const MAX_MONTHLY_CENTS = 1_000_000;

/** Thrown when a fee is requested for a practitioner who has no schedule. FAIL CLOSED. */
export class NoRateScheduleError extends Error {
  readonly practitionerId: string | null;
  constructor(practitionerId: string | null, detail?: string) {
    super(
      `No rate schedule${practitionerId ? ` for practitioner ${practitionerId}` : ''}` +
        `${detail ? ` (${detail})` : ''} — refusing to price a booking against a default. Assign one: re-run the backfill UPDATE from migration 20261014150000_rate_schedules_fee_rule_v15, or use /admin/commercial-settings`,
    );
    this.name = 'NoRateScheduleError';
    this.practitionerId = practitionerId;
  }
}

/** Thrown when schedule fields break an invariant. Carries every violation, not just the first. */
export class RateScheduleInvariantError extends Error {
  readonly violations: string[];
  constructor(violations: string[]) {
    super(`Invalid rate schedule: ${violations.join('; ')}`);
    this.name = 'RateScheduleInvariantError';
    this.violations = violations;
  }
}

function isInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n);
}

/**
 * Every invariant in spec §1, as a list of human-readable violations (empty = valid).
 *
 * Listing rather than throwing is for the admin form, which shows all of them live. The server
 * action and `createRateSchedule` call `assertRateScheduleValid`, which throws — validation in the
 * browser is a courtesy, the server is the authority.
 */
export function rateScheduleViolations(f: Partial<RateScheduleNumbers>): string[] {
  const v: string[] = [];

  for (const key of RATE_SCHEDULE_FIELDS) {
    const n = f[key];
    if (!isInt(n)) {
      v.push(`${key} must be a whole number`);
    } else if (n < 0) {
      v.push(`${key} must not be negative`);
    }
  }
  // Type/sign failures make every comparison below meaningless; report them alone.
  if (v.length > 0) return v;

  const g = f as RateScheduleNumbers;
  const bpsFields: RateScheduleField[] = [
    'annualDiscountBps',
    'planASourcedBps',
    'planBSourcedBps',
    'referralTotalBps',
    'referrerBps',
    'affiliateBps',
    'maxTotalFeeBps',
  ];
  for (const key of bpsFields) {
    if (g[key] > BPS_DENOMINATOR) v.push(`${key} must be at most ${BPS_DENOMINATOR} bps`);
  }
  if (g.planAMonthlyCents > MAX_MONTHLY_CENTS) v.push('planAMonthlyCents is implausibly large');
  if (g.planBMonthlyCents > MAX_MONTHLY_CENTS) v.push('planBMonthlyCents is implausibly large');
  if (g.leadTermMonths < 1 || g.leadTermMonths > MAX_TERM_MONTHS) {
    v.push(`leadTermMonths must be between 1 and ${MAX_TERM_MONTHS}`);
  }
  if (g.referrerTermMonths < 1 || g.referrerTermMonths > MAX_TERM_MONTHS) {
    v.push(`referrerTermMonths must be between 1 and ${MAX_TERM_MONTHS}`);
  }

  // O6 — the absolute ceiling, independent of what the schedule says about itself.
  if (g.maxTotalFeeBps > PLATFORM_FEE_CEILING_BPS) {
    v.push(`maxTotalFeeBps must not exceed the platform ceiling of ${PLATFORM_FEE_CEILING_BPS} bps`);
  }

  // The cap invariants (spec §1).
  if (g.planASourcedBps > g.maxTotalFeeBps) v.push('planASourcedBps must not exceed maxTotalFeeBps');
  if (g.planBSourcedBps > g.maxTotalFeeBps) v.push('planBSourcedBps must not exceed maxTotalFeeBps');
  if (g.referralTotalBps > g.maxTotalFeeBps) v.push('referralTotalBps must not exceed maxTotalFeeBps');
  if (g.referrerBps > g.referralTotalBps) v.push('referrerBps must not exceed referralTotalBps');
  if (g.referrerTermMonths > g.leadTermMonths) {
    v.push('referrerTermMonths must not exceed leadTermMonths');
  }

  // Every NON-ZERO NHP rate must cover the affiliate, so the deduction from NHP's share can never
  // run short. A zero NHP rate is legal and means "NHP charges nothing here", in which case the
  // affiliate is charged to the practitioner instead (spec §1, O7 clarified).
  if (g.planASourcedBps > 0 && g.planASourcedBps < g.affiliateBps) {
    v.push('planASourcedBps must cover affiliateBps');
  }
  if (g.planBSourcedBps > 0 && g.planBSourcedBps < g.affiliateBps) {
    v.push('planBSourcedBps must cover affiliateBps');
  }
  const referralNhpBps = g.referralTotalBps - g.referrerBps;
  if (referralNhpBps > 0 && referralNhpBps < g.affiliateBps) {
    v.push('referralTotalBps − referrerBps must cover affiliateBps');
  }

  // When NHP's fee is 0 the practitioner's whole charge is the affiliate share, so it too is
  // capped. (Redundant with the ceiling for v1, but the invariant is stated in terms of the
  // schedule's own cap and must keep holding if the ceiling is ever raised.)
  if (g.affiliateBps > g.maxTotalFeeBps) v.push('affiliateBps must not exceed maxTotalFeeBps');

  return v;
}

export function assertRateScheduleValid(f: Partial<RateScheduleNumbers>): asserts f is RateScheduleNumbers {
  const violations = rateScheduleViolations(f);
  if (violations.length > 0) throw new RateScheduleInvariantError(violations);
}

/** Pick exactly the hashed fields out of anything that carries them (a Prisma row, a form). */
export function scheduleNumbers(f: RateScheduleNumbers): RateScheduleNumbers {
  const out = {} as RateScheduleNumbers;
  for (const key of RATE_SCHEDULE_FIELDS) out[key] = f[key];
  return out;
}

/**
 * THE ONE CANONICAL SERIALISATION. `key=value` lines in `RATE_SCHEDULE_FIELDS` order under a
 * version header. Not JSON: JSON key order is an implementation accident of whoever built the
 * object, which is exactly how two logically identical schedules end up with different hashes.
 */
export function canonicalRateScheduleString(f: RateScheduleNumbers): string {
  const lines = RATE_SCHEDULE_FIELDS.map((key) => {
    const n = f[key];
    if (!isInt(n)) throw new RateScheduleInvariantError([`${key} must be a whole number`]);
    return `${key}=${n}`;
  });
  return `rate-schedule/v1\n${lines.join('\n')}`;
}

/**
 * The yearly Plan A price in cents, DERIVED: `monthly × 12 × (1 − discount)`. Never typed in — a
 * stored annual price is a second number that can drift from the first. Rounded to the nearest
 * cent (37 440 for v1 is exact).
 */
export function annualPlanAPriceCents(s: Pick<RateScheduleNumbers, 'planAMonthlyCents' | 'annualDiscountBps'>): number {
  return Math.round((s.planAMonthlyCents * 12 * (BPS_DENOMINATOR - s.annualDiscountBps)) / BPS_DENOMINATOR);
}

export type PlanKeyLike = 'PLAN_A' | 'PLAN_B';

/** The plan's rate on an NHP-sourced session. */
export function planSourcedBps(s: Pick<RateScheduleNumbers, 'planASourcedBps' | 'planBSourcedBps'>, plan: PlanKeyLike): number {
  return plan === 'PLAN_A' ? s.planASourcedBps : s.planBSourcedBps;
}

/** The plan's monthly listing fee in cents (0 = none). */
export function planMonthlyCents(s: Pick<RateScheduleNumbers, 'planAMonthlyCents' | 'planBMonthlyCents'>, plan: PlanKeyLike): number {
  return plan === 'PLAN_A' ? s.planAMonthlyCents : s.planBMonthlyCents;
}

/**
 * ADMIN FORM UNITS. The form speaks dollars and percent; storage speaks cents and basis points.
 * The conversion lives here (pure, browser-safe) so the live preview in the browser and the
 * authoritative server action parse a submission identically.
 */
export type ScheduleFormUnit = 'dollars' | 'percent' | 'months';

export const SCHEDULE_FORM_FIELDS: Array<{
  field: RateScheduleField;
  name: string;
  label: string;
  unit: ScheduleFormUnit;
  help: string;
}> = [
  { field: 'planAMonthlyCents', name: 'planAMonthly', label: 'Plan A monthly fee', unit: 'dollars', help: 'Subscription charged to a Plan A practitioner.' },
  { field: 'annualDiscountBps', name: 'annualDiscount', label: 'Plan A annual discount', unit: 'percent', help: 'Off twelve months of the monthly fee. The yearly price is derived, never typed.' },
  { field: 'planASourcedBps', name: 'planASourced', label: 'Plan A rate on NHP-sourced sessions', unit: 'percent', help: 'Charged on every NHP-sourced session inside the lead term.' },
  { field: 'planBMonthlyCents', name: 'planBMonthly', label: 'Plan B monthly fee', unit: 'dollars', help: '0 means no subscription.' },
  { field: 'planBSourcedBps', name: 'planBSourced', label: 'Plan B rate on NHP-sourced sessions', unit: 'percent', help: 'Charged on every NHP-sourced session inside the lead term.' },
  { field: 'referralTotalBps', name: 'referralTotal', label: 'Referred client: total charged', unit: 'percent', help: 'During the referrer term, either plan. Referrer share plus NHP share.' },
  { field: 'referrerBps', name: 'referrer', label: 'Referred client: referrer share', unit: 'percent', help: 'The part of the total paid to the referring practitioner.' },
  { field: 'affiliateBps', name: 'affiliate', label: 'Recruiting affiliate share', unit: 'percent', help: 'Of gross client payments of a recruited practitioner. Comes out of NHP’s share when NHP takes a fee, otherwise out of the practitioner’s.' },
  { field: 'leadTermMonths', name: 'leadTerm', label: 'NHP lead attribution term', unit: 'months', help: 'From the client’s first payment. 0% after it.' },
  { field: 'referrerTermMonths', name: 'referrerTerm', label: 'Referrer attribution term', unit: 'months', help: 'The shorter window in which a referred client is split referrer + NHP.' },
  { field: 'maxTotalFeeBps', name: 'maxTotalFee', label: 'Maximum total fee', unit: 'percent', help: 'Never exceeded in any circumstance. Cannot exceed the platform ceiling.' },
];

/** Stored value → the string an input shows ("39", "10", "8", "12.5"). */
export function toFormValue(unit: ScheduleFormUnit, stored: number): string {
  if (unit === 'months') return String(stored);
  const v = stored / 100;
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Form strings → schedule numbers. Anything that is not a plain non-negative decimal becomes NaN
 * and is then reported by `rateScheduleViolations` as "must be a whole number" — an unparseable
 * field is a validation failure, never a silent 0.
 */
export function parseScheduleForm(
  get: (name: string) => string | null | undefined,
): Partial<RateScheduleNumbers> {
  const out: Partial<RateScheduleNumbers> = {};
  for (const f of SCHEDULE_FORM_FIELDS) {
    const raw = (get(f.name) ?? '').trim();
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
      out[f.field] = Number.NaN;
      continue;
    }
    const n = Number(raw);
    out[f.field] = f.unit === 'months' ? (Number.isInteger(n) ? n : Number.NaN) : Math.round(n * 100);
  }
  return out;
}
