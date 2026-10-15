import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PLAN_A_PLAN_SETTING_KEYS,
  hasJoinedViaCohort,
  ownerBillingState,
  intervalForPlanId,
  loadPlanAPlanIds,
  planABillingOpen,
} from '@/lib/plan-a-billing';
import { annualPlanALabel, annualPlanASavingsLabel, monthlyFeeLabel } from '@/lib/pricing-plans';
import type { RateScheduleNumbers } from '@/lib/rate-schedule';

const settingsDb = (rows: Array<{ key: string; value: string }>) => ({
  platformSetting: { findMany: vi.fn(async () => rows) },
});

describe('planABillingOpen', () => {
  const now = Date.UTC(2026, 9, 15);
  const past = new Date(now - 1);
  const future = new Date(now + 86_400_000);

  it('opens billing for a cohort joiner whatever the pilot clock says', () => {
    for (const trialEndsAt of [null, past, future]) {
      expect(planABillingOpen({ joinedViaCohort: true, trialEndsAt, now })).toBe(true);
    }
  });

  it('keeps the pilot rule for everyone else', () => {
    expect(planABillingOpen({ joinedViaCohort: false, trialEndsAt: null, now })).toBe(false);
    expect(planABillingOpen({ joinedViaCohort: false, trialEndsAt: future, now })).toBe(false);
    expect(planABillingOpen({ joinedViaCohort: false, trialEndsAt: past, now })).toBe(true);
  });
});

describe('hasJoinedViaCohort / ownerBillingState', () => {
  const created = new Date('2026-10-15T22:43:50Z');

  it('counts only a cohort invitation created no later than the profile', async () => {
    const findFirst = vi.fn(async () => ({ id: 'inv_1' }));
    expect(await hasJoinedViaCohort({ invitation: { findFirst } }, { userId: 'usr_1', createdAt: created })).toBe(true);
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { acceptedByUserId: 'usr_1', cohortId: { not: null }, createdAt: { lte: created } },
      }),
    );
  });

  it('is false for an admin-invited pilot', async () => {
    const db = { invitation: { findFirst: vi.fn(async () => null) } };
    expect(await hasJoinedViaCohort(db, { userId: 'usr_2', createdAt: created })).toBe(false);
  });

  it('opens billing for the owner who joined via a cohort, and not for a pilot', async () => {
    const owner = { userId: 'usr_1', createdAt: created, trialEndsAt: null };
    const joined = { invitation: { findFirst: vi.fn(async () => ({ id: 'inv_1' })) } };
    const pilot = { invitation: { findFirst: vi.fn(async () => null) } };
    expect(await ownerBillingState(joined, owner)).toEqual({ joinedViaCohort: true, billingOpen: true });
    expect(await ownerBillingState(pilot, owner)).toEqual({ joinedViaCohort: false, billingOpen: false });
    expect(joined.invitation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ acceptedByUserId: 'usr_1' }) }),
    );
  });
});

describe('the edit page asks about the PROFILE OWNER, never the viewer', () => {
  it('passes the loaded practitioner row to ownerBillingState', () => {
    const src = readFileSync('src/app/practitioners/[slug]/edit/page.tsx', 'utf8');
    expect(src).toMatch(/ownerBillingState\(prisma, practitioner\)/);
    expect(src).toMatch(/billingOpen=\{billingState\.billingOpen\}/);
    expect(src).toMatch(/foundingRate=\{billingState\.joinedViaCohort\}/);
  });
});

describe('loadPlanAPlanIds', () => {
  const ENV = process.env.WHOP_SUBSCRIPTION_PLAN_ID;
  beforeEach(() => {
    delete process.env.WHOP_SUBSCRIPTION_PLAN_ID;
  });
  afterEach(() => {
    if (ENV === undefined) delete process.env.WHOP_SUBSCRIPTION_PLAN_ID;
    else process.env.WHOP_SUBSCRIPTION_PLAN_ID = ENV;
  });

  it('reads both plan ids from the database', async () => {
    process.env.WHOP_SUBSCRIPTION_PLAN_ID = 'plan_env';
    const ids = await loadPlanAPlanIds(
      settingsDb([
        { key: PLAN_A_PLAN_SETTING_KEYS.monthly, value: 'plan_db_month' },
        { key: PLAN_A_PLAN_SETTING_KEYS.annual, value: ' plan_db_year ' },
      ]),
    );
    expect(ids).toEqual({ monthly: 'plan_db_month', annual: 'plan_db_year' });
  });

  it('falls back to the env var for monthly only', async () => {
    process.env.WHOP_SUBSCRIPTION_PLAN_ID = 'plan_env';
    expect(await loadPlanAPlanIds(settingsDb([]))).toEqual({ monthly: 'plan_env', annual: null });
  });

  it('treats a blank row as missing', async () => {
    const ids = await loadPlanAPlanIds(settingsDb([{ key: PLAN_A_PLAN_SETTING_KEYS.annual, value: '  ' }]));
    expect(ids).toEqual({ monthly: null, annual: null });
  });
});

describe('intervalForPlanId', () => {
  const ids = { monthly: 'plan_m', annual: 'plan_y' };
  it('maps each configured plan to its interval and anything else to null', () => {
    expect(intervalForPlanId(ids, 'plan_m')).toBe('monthly');
    expect(intervalForPlanId(ids, 'plan_y')).toBe('annual');
    expect(intervalForPlanId(ids, 'plan_other')).toBeNull();
    expect(intervalForPlanId(ids, undefined)).toBeNull();
    expect(intervalForPlanId({ monthly: null, annual: null }, 'plan_m')).toBeNull();
  });
});

describe('Plan A price copy comes from the schedule', () => {
  // The Founding schedule the operator is creating: $29/month and a 14.08% annual discount.
  const founding = { planAMonthlyCents: 2900, planBMonthlyCents: 0, annualDiscountBps: 1408 } as RateScheduleNumbers;

  it('prices the founding rate at $29/mo and $299/yr, saving $49', () => {
    expect(monthlyFeeLabel(founding, 'PLAN_A')).toBe('$29/mo');
    expect(annualPlanALabel(founding)).toBe('$299/yr');
    expect(annualPlanASavingsLabel(founding)).toBe('Save $49 vs monthly');
  });

  it('claims no saving when the yearly price saves nothing', () => {
    expect(annualPlanASavingsLabel({ ...founding, annualDiscountBps: 0 })).toBeNull();
  });
});
