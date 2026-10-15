import { describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SetupChecklist, type SetupStep } from '@/components/practitioners/SetupChecklist';
import { SubscriptionSection } from '@/components/practitioners/SubscriptionSection';

// useFormStatus is client-only; the server renderer used here has no form context.
vi.mock('@/components/practitioners/PendingButton', () => ({
  PendingButton: ({ children }: { children: React.ReactNode }) => h('button', { type: 'submit' }, children),
}));

const step = (over: Partial<SetupStep> & { key: string }): SetupStep => ({
  label: over.key,
  hint: `hint-${over.key}`,
  done: false,
  href: `#${over.key}`,
  cta: `cta-${over.key}`,
  ...over,
});

describe('SetupChecklist', () => {
  it('counts only real steps, and marks exactly one as current', () => {
    const html = renderToStaticMarkup(
      h(SetupChecklist, { steps: [
          step({ key: 'a', done: true }),
          step({ key: 'b' }),
          step({ key: 'c' }),
          step({ key: 'w', state: 'coming-soon' }),
        ] }),
    );
    expect(html).toContain('1 of 3 done');
    expect(html.match(/border-2 border-primary/g)).toHaveLength(1);
  });

  it('shows a coming-soon step without a call to action and never as current', () => {
    const html = renderToStaticMarkup(
      h(SetupChecklist, { steps: [step({ key: 'a', done: true }), step({ key: 'w', state: 'coming-soon' })] }),
    );
    expect(html).toContain('Not switched on yet');
    expect(html).not.toContain('cta-w');
    expect(html).toContain('1 of 1 done');
  });
});

describe('SubscriptionSection is plan-aware', () => {
  const base = {
    isAdmin: false,
    isComplete: true,
    foundingRate: false,
    interval: null,
    monthlyAction: null,
    annualAction: null,
    fallbackCheckoutUrl: 'https://example.test/checkout',
    priceLabel: '$X/mo',
    annualPriceLabel: '$Y/yr',
    annualSavingsLabel: 'Save $Z vs monthly',
  } as const;

  it('never asks a Plan B practitioner to subscribe, whether or not billing is open', () => {
    for (const billingOpen of [true, false]) {
      for (const foundingRate of [true, false]) {
        const html = renderToStaticMarkup(
          h(SubscriptionSection, { ...base, plan: 'PLAN_B', status: 'NONE', billingOpen, foundingRate }),
        );
        expect(html).toContain('No monthly fee');
        expect(html).not.toMatch(/Subscribe|Pay monthly|Pay annually|Pilot|pilot|trial/);
        expect(html).not.toContain('example.test/checkout');
      }
    }
  });

  it('never mentions a pilot, a trial or a free first period to anyone', () => {
    for (const plan of ['PLAN_A', 'PLAN_B'] as const) {
      for (const status of ['NONE', 'ACTIVE', 'PAST_DUE', 'CANCELED'] as const) {
        for (const billingOpen of [true, false]) {
          for (const foundingRate of [true, false]) {
            const html = renderToStaticMarkup(
              h(SubscriptionSection, { ...base, plan, status, billingOpen, foundingRate }),
            );
            expect(html).not.toMatch(/pilot|90-day|trial|free/i);
          }
        }
      }
    }
  });

  it('Plan A: quiet while billing has not started, both choices once it has', () => {
    const before = renderToStaticMarkup(
      h(SubscriptionSection, { ...base, plan: 'PLAN_A', status: 'NONE', billingOpen: false }),
    );
    expect(before).toContain("Billing hasn&#x27;t started");
    expect(before).not.toMatch(/Pay monthly|Pay annually/);

    const after = renderToStaticMarkup(
      h(SubscriptionSection, { ...base, plan: 'PLAN_A', status: 'NONE', billingOpen: true }),
    );
    expect(after).toContain('Pay monthly · $X/mo');
    expect(after).toContain('Pay annually · $Y/yr');
    expect(after).toContain('Save $Z vs monthly');
    expect(after).not.toContain('Founding rate');
  });

  it('a cohort joiner sees the founding rate and one checkout form per interval', () => {
    const monthlyAction = async () => {};
    const annualAction = async () => {};
    const html = renderToStaticMarkup(
      h(SubscriptionSection, {
        ...base,
        plan: 'PLAN_A',
        status: 'NONE',
        billingOpen: true,
        foundingRate: true,
        monthlyAction,
        annualAction,
      }),
    );
    expect(html).toContain('Founding rate');
    expect(html.match(/<form/g)).toHaveLength(2);
    expect(html).not.toContain('example.test/checkout');
  });

  it('after checkout, hides both choices until the webhook activates the subscription', () => {
    const html = renderToStaticMarkup(
      h(SubscriptionSection, { ...base, plan: 'PLAN_A', status: 'NONE', billingOpen: true, notice: 'success' }),
    );
    expect(html).toContain('being confirmed');
    expect(html).not.toMatch(/Pay monthly|Pay annually/);
  });

  it('shows a failed checkout on the billing card itself', () => {
    const html = renderToStaticMarkup(
      h(SubscriptionSection, { ...base, plan: 'PLAN_A', status: 'NONE', billingOpen: true, notice: 'error' }),
    );
    expect(html).toContain('Checkout could not be opened');
    expect(html).toContain('Pay monthly');
  });

  it('an active subscription is shown whichever plan the practitioner is recorded on', () => {
    const html = renderToStaticMarkup(
      h(SubscriptionSection, { ...base, plan: 'PLAN_B', status: 'ACTIVE', billingOpen: false }),
    );
    expect(html).toContain('Active');
    expect(html).toContain('Monthly listing');
  });

  it('an active annual subscription names the annual price', () => {
    const html = renderToStaticMarkup(
      h(SubscriptionSection, { ...base, plan: 'PLAN_A', status: 'ACTIVE', billingOpen: true, interval: 'annual' }),
    );
    expect(html).toContain('Annual listing');
    expect(html).toContain('$Y/yr');
    expect(html).not.toMatch(/Pay monthly|Pay annually/);
  });
});
