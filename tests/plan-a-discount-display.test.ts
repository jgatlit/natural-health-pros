import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// PendingButton reads useFormStatus, which a static render has no form context for.
vi.mock('@/components/practitioners/PendingButton', () => ({
  PendingButton: ({ children }: { children: React.ReactNode }) => h('button', null, children),
}));

import { PlanChoice } from '@/components/practitioners/PlanChoice';
import { PlanTermsSummary } from '@/components/practitioners/PlanTermsSummary';
import { SubscriptionSection } from '@/components/practitioners/SubscriptionSection';
import {
  annualPlanALabel,
  annualPlanASavingsLabel,
  monthlyFeeLabel,
  planADiscount,
  planComparison,
} from '@/lib/pricing-plans';
import type { RateSchedule } from '@/lib/rate-schedule';
import { getPlanAListSchedule, PLAN_A_LIST_RATE_SCHEDULE_KEY } from '@/lib/rate-schedules';
import { V1, V1_NUMBERS } from './helpers/rate-schedule';

/** Schedule "Founding 2026-10" as it stands in production: Plan A $29/mo, 14.08% off yearly. */
const FOUNDING: RateSchedule = {
  id: 'rs_founding',
  label: 'Founding 2026-10',
  ...V1_NUMBERS,
  planAMonthlyCents: 2900,
  annualDiscountBps: 1408,
};

describe('planADiscount: the regular Plan A price beside a lower one', () => {
  it('states the struck-through list prices and both savings', () => {
    expect(planADiscount(FOUNDING, V1)).toEqual({
      monthlyListLabel: '$39',
      monthlySavingsLabel: 'Founding rate: save $10/mo',
      annualListLabel: '$374.40',
      annualSavingsLabel: 'Founding rate: save $75.40/yr',
    });
  });

  it('is null with no list schedule, at the same price, or above it', () => {
    expect(planADiscount(FOUNDING, null)).toBeNull();
    expect(planADiscount(V1, V1)).toBeNull();
    expect(planADiscount(V1, FOUNDING)).toBeNull();
  });

  it('omits the annual pair when the yearly price is not below the list yearly price', () => {
    const shallow = { ...V1_NUMBERS, planAMonthlyCents: 3800, annualDiscountBps: 0 };
    const d = planADiscount(shallow, V1);
    expect(d?.monthlyListLabel).toBe('$39');
    expect(d?.annualListLabel).toBeNull();
    expect(d?.annualSavingsLabel).toBeNull();
  });
});

describe('planComparison carries the list price on the Plan A card only', () => {
  it('discounted', () => {
    const [a, b] = planComparison(FOUNDING, V1).cards;
    expect(a).toMatchObject({ monthlyListLabel: '$39', annualListLabel: '$374.40', discountLabel: 'Founding rate' });
    expect(b).toMatchObject({ monthlyListLabel: null, annualListLabel: null, discountLabel: null });
  });

  it('no list schedule: nothing extra', () => {
    for (const card of planComparison(FOUNDING).cards) {
      expect(card).toMatchObject({ monthlyListLabel: null, annualListLabel: null, discountLabel: null });
    }
  });
});

describe('getPlanAListSchedule reads the schedule the setting names', () => {
  const db = (value: string | null) => ({
    platformSetting: {
      findUnique: async (args: { where: { key: string } }) =>
        args.where.key === PLAN_A_LIST_RATE_SCHEDULE_KEY && value !== null ? { value } : null,
    },
    rateSchedule: {
      findUnique: async (args: { where: { id: string } }) => (args.where.id === V1.id ? V1 : null),
    },
  });

  it('the named schedule', async () => {
    expect((await getPlanAListSchedule(db(V1.id)))?.planAMonthlyCents).toBe(V1.planAMonthlyCents);
  });

  it('null with no setting, or a setting naming no schedule', async () => {
    expect(await getPlanAListSchedule(db(null))).toBeNull();
    expect(await getPlanAListSchedule(db('rs_missing'))).toBeNull();
  });
});

const billingProps = (schedule: RateSchedule, list: RateSchedule | null) => ({
  status: 'NONE' as const,
  billingOpen: true,
  foundingRate: true,
  isAdmin: false,
  isComplete: true,
  plan: 'PLAN_A' as const,
  interval: null,
  monthlyAction: null,
  annualAction: null,
  fallbackCheckoutUrl: 'https://example.test/checkout',
  priceLabel: monthlyFeeLabel(schedule, 'PLAN_A'),
  annualPriceLabel: annualPlanALabel(schedule),
  annualSavingsLabel: annualPlanASavingsLabel(schedule),
  discount: planADiscount(schedule, list),
});

const text = (html: string) => html.replace(/<[^>]+>/g, '');

describe('billing card', () => {
  it('strikes through $39 and $374.40 beside $29/mo and $299/yr, with the savings', () => {
    const html = renderToStaticMarkup(h(SubscriptionSection, billingProps(FOUNDING, V1)));
    expect(html).toMatch(/<s aria-hidden="true"[^>]*>\$39<\/s>/);
    expect(html).toMatch(/<s aria-hidden="true"[^>]*>\$374\.40<\/s>/);
    expect(text(html)).toContain('was $39, now $29/mo');
    expect(text(html)).toContain('was $374.40, now $299/yr');
    expect(text(html)).toContain('Founding rate: save $10/mo');
    expect(text(html)).toContain('Founding rate: save $75.40/yr');
    expect(text(html)).toContain('Save $49 vs monthly');
  });

  it('renders nothing extra without a discount', () => {
    for (const html of [
      renderToStaticMarkup(h(SubscriptionSection, billingProps(FOUNDING, null))),
      renderToStaticMarkup(h(SubscriptionSection, billingProps(V1, V1))),
    ]) {
      expect(html).not.toMatch(/<s[\s>]/);
      expect(html).not.toMatch(/was \$|save \$\d+(\.\d+)?\/(mo|yr)/);
    }
  });
});

describe('plan cards (edit page) and plan summary (onboarding)', () => {
  const choice = (list: RateSchedule | null) => {
    const c = planComparison(FOUNDING, list);
    return renderToStaticMarkup(
      h(PlanChoice, {
        chosen: 'PLAN_A',
        plans: c.cards,
        breakEven: c.breakEven,
        breakEvenMonthlyLabel: c.breakEvenMonthlyLabel,
        referral: c.referral,
        chooseAction: async () => {},
      }),
    );
  };
  const summary = (list: RateSchedule | null) => {
    const c = planComparison(FOUNDING, list);
    return renderToStaticMarkup(h(PlanTermsSummary, { plans: c.cards, referral: c.referral }));
  };

  it('struck-through $39 next to $29/mo · Founding rate', () => {
    const html = choice(V1);
    expect(html).toMatch(/<s aria-hidden="true"[^>]*>\$39<\/s>/);
    expect(text(html)).toContain('was $39, now $29/mo · Founding rate');
    expect(text(html)).toContain('was $374.40, now $299/yr');
    expect(summary(V1)).toMatch(/<s aria-hidden="true"[^>]*>\$39<\/s>/);
    expect(text(summary(V1))).toContain('Founding rate');
  });

  it('nothing extra without a list schedule', () => {
    for (const html of [choice(null), summary(null)]) {
      expect(html).not.toMatch(/<s[\s>]/);
      expect(html).not.toMatch(/Founding rate|was \$/);
    }
  });
});

describe('the migration seeds the setting idempotently, only when the schedule exists', () => {
  const sql = readFileSync(
    join(process.cwd(), 'prisma/migrations/20261016000000_plan_a_list_rate_schedule/migration.sql'),
    'utf8',
  );

  it('names the key and the regular schedule, and never overwrites', () => {
    expect(sql).toContain(`'${PLAN_A_LIST_RATE_SCHEDULE_KEY}'`);
    expect(sql).toContain(`"id" = '${V1.id}'`);
    expect(sql).toMatch(/ON CONFLICT \("key"\) DO NOTHING/);
    expect(sql).not.toMatch(/\b(UPDATE|DELETE|DROP|ALTER)\b/);
  });
});
