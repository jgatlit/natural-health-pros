import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SetupChecklist, type SetupStep } from '@/components/practitioners/SetupChecklist';
import { SubscriptionSection } from '@/components/practitioners/SubscriptionSection';

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
    subscribeAction: null,
    fallbackCheckoutUrl: 'https://example.test/checkout',
    priceLabel: '$X/mo',
  } as const;
  const past = new Date(Date.now() - 86_400_000);
  const future = new Date(Date.now() + 86_400_000 * 10);

  it('never asks a Plan B practitioner to subscribe, whatever the trial date says', () => {
    for (const trialEndsAt of [null, future, past]) {
      const html = renderToStaticMarkup(
        h(SubscriptionSection, { ...base, plan: 'PLAN_B', status: 'NONE', trialEndsAt: trialEndsAt }),
      );
      expect(html).toContain('No monthly fee');
      expect(html).not.toMatch(/Subscribe|Pilot|pilot|trial/);
      expect(html).not.toContain('example.test/checkout');
    }
  });

  it('never mentions a pilot or trial to anyone', () => {
    for (const plan of ['PLAN_A', 'PLAN_B'] as const) {
      for (const status of ['NONE', 'ACTIVE', 'PAST_DUE', 'CANCELED'] as const) {
        for (const trialEndsAt of [null, future, past]) {
          const html = renderToStaticMarkup(
            h(SubscriptionSection, { ...base, plan, status, trialEndsAt }),
          );
          expect(html).not.toMatch(/pilot|Pilot|90-day|trial/i);
        }
      }
    }
  });

  it('Plan A: quiet before billing, subscribe only once the date has passed', () => {
    const before = renderToStaticMarkup(
      h(SubscriptionSection, { ...base, plan: 'PLAN_A', status: 'NONE', trialEndsAt: future }),
    );
    expect(before).toContain("Billing hasn&#x27;t started");
    expect(before).not.toContain('Subscribe ·');

    const after = renderToStaticMarkup(
      h(SubscriptionSection, { ...base, plan: 'PLAN_A', status: 'NONE', trialEndsAt: past }),
    );
    expect(after).toContain('Subscribe ·');
  });

  it('an active subscription is shown whichever plan the practitioner is recorded on', () => {
    const html = renderToStaticMarkup(
      h(SubscriptionSection, { ...base, plan: 'PLAN_B', status: 'ACTIVE', trialEndsAt: null }),
    );
    expect(html).toContain('Active');
    expect(html).toContain('Monthly listing');
  });
});
