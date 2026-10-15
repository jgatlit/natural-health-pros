/**
 * Plan A listing billing: which Whop plan a monthly or annual subscription sells, and who is
 * asked to pay now.
 *
 * Plan ids live in `PlatformSetting` (seeded by migration `20261015233000_plan_a_billing_intervals`),
 * not in code or a Vercel env var, so the operator can point either interval at a new Whop plan
 * without a deploy. The monthly id still falls back to `WHOP_SUBSCRIPTION_PLAN_ID`, which carried it
 * before the setting existed; the annual id has no fallback. Prices are never read from here: the
 * card's copy comes from the practitioner's rate schedule and the amount charged is Whop's.
 */

export type BillingInterval = 'monthly' | 'annual';

export const PLAN_A_PLAN_SETTING_KEYS: Record<BillingInterval, string> = {
  monthly: 'whop_plan_a_monthly_plan_id',
  annual: 'whop_plan_a_annual_plan_id',
};

export function isBillingInterval(value: unknown): value is BillingInterval {
  return value === 'monthly' || value === 'annual';
}

/** STRUCTURAL, not the generated delegate — see the note in attributed-clients.ts. */
type PlanIdDb = {
  platformSetting: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany(args?: any): Promise<Array<{ key: string; value: string }>>;
  };
};

type CohortDb = {
  invitation: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findFirst(args: any): Promise<{ id: string } | null>;
  };
};

/** Did this user sign up through a /join/<cohort> link? Their accepted invitation carries the cohort. */
export async function hasJoinedViaCohort(db: CohortDb, userId: string): Promise<boolean> {
  const invitation = await db.invitation.findFirst({
    where: { acceptedByUserId: userId, cohortId: { not: null } },
    select: { id: true },
  });
  return invitation !== null;
}

/** Both interval plan ids, database first. A missing or blank row resolves to null. */
export async function loadPlanAPlanIds(db: PlanIdDb): Promise<Record<BillingInterval, string | null>> {
  const rows = await db.platformSetting.findMany({
    where: { key: { in: Object.values(PLAN_A_PLAN_SETTING_KEYS) } },
    select: { key: true, value: true },
  });
  const byKey = new Map(rows.map((r) => [r.key, r.value.trim()]));
  const envMonthly = process.env.WHOP_SUBSCRIPTION_PLAN_ID?.trim();
  return {
    monthly: byKey.get(PLAN_A_PLAN_SETTING_KEYS.monthly) || envMonthly || null,
    annual: byKey.get(PLAN_A_PLAN_SETTING_KEYS.annual) || null,
  };
}

/** Which interval a Whop plan id sells, or null when it is neither configured Plan A plan. */
export function intervalForPlanId(
  ids: Record<BillingInterval, string | null>,
  planId: string | null | undefined,
): BillingInterval | null {
  if (!planId) return null;
  if (planId === ids.monthly) return 'monthly';
  if (planId === ids.annual) return 'annual';
  return null;
}

/**
 * Is a Plan A practitioner asked to pay now?
 *
 * A practitioner who joined through a cohort link (/join/<cohort>) is billed from the start, whatever
 * the pilot clock says (operator ruling 2026-10-15). Everyone else keeps the pilot rule: billing
 * starts once `trialEndsAt` has passed, and null means it has not started.
 */
export function planABillingOpen(input: {
  joinedViaCohort: boolean;
  trialEndsAt: Date | null;
  now?: number;
}): boolean {
  if (input.joinedViaCohort) return true;
  const now = input.now ?? Date.now();
  return input.trialEndsAt !== null && input.trialEndsAt.getTime() <= now;
}
