import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * WHAT PRACTITIONERS SEE (tsk_8cbab1fa54ec453aa555): the two display switches and the pricing note.
 *
 * Off (the state of a database nobody has configured) = value copy, no plan $ or %, no commission
 * %, $ or months. On = today's figures, read from the schedule. The checkout buttons keep their
 * price either way. Every change is admin-only and logged old → new.
 */

const state = vi.hoisted(() => ({
  role: 'ADMIN' as 'ADMIN' | 'PRACTITIONER',
  db: null as unknown,
}));

vi.mock('@/auth', () => ({
  auth: async () => ({ user: { id: 'usr_admin', role: state.role } }),
}));
vi.mock('@/lib/prisma', () => ({
  get prisma() {
    return state.db;
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
// PendingButton reads useFormStatus, which a static render has no form context for.
vi.mock('@/components/practitioners/PendingButton', () => ({
  PendingButton: ({ children }: { children: React.ReactNode }) => h('button', null, children),
}));

import {
  DISPLAY_DEFAULTS,
  displayWarnings,
  loadDisplaySettings,
  saveDisplaySetting,
  type DisplaySettings,
} from '@/lib/platform-settings';
import {
  annualPlanALabel,
  annualPlanASavingsLabel,
  monthlyFeeLabel,
  planADiscount,
  planComparison,
} from '@/lib/pricing-plans';
import { recruiterDisclosure } from '@/lib/recruiter';
import { referralBookedCopy } from '@/lib/referral-notifications';
import { getListed } from '@/content/copy';
import { PlanChoice } from '@/components/practitioners/PlanChoice';
import { PlanTermsSummary } from '@/components/practitioners/PlanTermsSummary';
import { SubscriptionSection } from '@/components/practitioners/SubscriptionSection';
import { ClientsAndReferralsSection } from '@/components/practitioners/ClientsAndReferralsSection';
import { TermsAcknowledgment } from '@/components/practitioners/TermsAcknowledgment';
import type { RateSchedule } from '@/lib/rate-schedule';
import { V1, V1_NUMBERS } from './helpers/rate-schedule';

const FOUNDING: RateSchedule = { id: 'rs_founding', label: 'Founding 2026-10', ...V1_NUMBERS, planAMonthlyCents: 2900, annualDiscountBps: 1408 };

/** In-memory PlatformSetting + PlatformSettingChange. */
function fakeSettingsDb(seed: Record<string, string> = {}) {
  const settings = new Map(Object.entries(seed));
  const changes: Array<Record<string, unknown>> = [];
  const upserts: unknown[] = [];
  return {
    settings,
    changes,
    upserts,
    platformSetting: {
      async findMany(args: { where: { key: { in: string[] } } }) {
        return args.where.key.in.filter((k) => settings.has(k)).map((k) => ({ key: k, value: settings.get(k)! }));
      },
      async findUnique(args: { where: { key: string } }) {
        const v = settings.get(args.where.key);
        return v === undefined ? null : { value: v };
      },
      async upsert(args: { where: { key: string }; create: { value: string }; update: { value: string } }) {
        upserts.push(args);
        settings.set(args.where.key, settings.has(args.where.key) ? args.update.value : args.create.value);
        return null;
      },
    },
    platformSettingChange: {
      async create(args: { data: Record<string, unknown> }) {
        changes.push(args.data);
        return args.data;
      },
    },
  };
}

const ON: DisplaySettings = { showPlanRates: true, showCommissionTerms: true, pricingNote: null };
const OFF: DisplaySettings = DISPLAY_DEFAULTS;

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

/** A price, a non-zero percentage, or a month count. "0%" is a guarantee, not a rate. */
const FIGURE = /\$\d|(?<![\d.])(?:[1-9]\d*|0\.\d+)(?:\.\d+)?%|\d+\s*months?\b/;

const choice = (display: DisplaySettings) => {
  const c = planComparison(FOUNDING, V1);
  return renderToStaticMarkup(
    h(PlanChoice, {
      chosen: null,
      plans: c.cards,
      breakEven: c.breakEven,
      breakEvenMonthlyLabel: c.breakEvenMonthlyLabel,
      referral: c.referral,
      display,
      chooseAction: async () => {},
    }),
  );
};

const summary = (display: DisplaySettings) => {
  const c = planComparison(FOUNDING, V1);
  return renderToStaticMarkup(h(PlanTermsSummary, { plans: c.cards, referral: c.referral, display }));
};

const billing = (
  display: DisplaySettings,
  over: Partial<Parameters<typeof SubscriptionSection>[0]> = {},
) =>
  renderToStaticMarkup(
    h(SubscriptionSection, {
      status: 'NONE',
      billingOpen: true,
      foundingRate: true,
      isAdmin: false,
      isComplete: true,
      plan: 'PLAN_A',
      interval: null,
      monthlyAction: async () => {},
      annualAction: async () => {},
      fallbackCheckoutUrl: null,
      priceLabel: monthlyFeeLabel(FOUNDING, 'PLAN_A'),
      annualPriceLabel: annualPlanALabel(FOUNDING),
      annualSavingsLabel: annualPlanASavingsLabel(FOUNDING),
      discount: planADiscount(FOUNDING, V1),
      showPlanRates: display.showPlanRates,
      pricingNote: display.pricingNote,
      ...over,
    }),
  );

const clients = (showCommissionTerms: boolean, newReferralLink: string | null = 'https://x.test/r/abc') =>
  renderToStaticMarkup(
    h(ClientsAndReferralsSection, {
      slug: 'me',
      rows: [],
      referable: [{ slug: 'col', displayName: 'A Colleague' }],
      newReferralLink,
      referral: planComparison(V1).referral,
      showCommissionTerms,
      addAction: async () => {},
      inviteAction: async () => {},
      referByEmailAction: async () => {},
      createLinkAction: async () => {},
      notice: null,
    }),
  );

describe('loadDisplaySettings: both switches OFF and no note until an admin sets them', () => {
  it('no rows → both off, no note (operator ruling: off at go-live)', async () => {
    expect(await loadDisplaySettings(fakeSettingsDb())).toEqual(OFF);
  });

  it('only the stored string "true" is on; a malformed row is off', async () => {
    const db = fakeSettingsDb({ show_plan_rates: 'true', show_commission_terms: 'yes' });
    expect(await loadDisplaySettings(db)).toMatchObject({ showPlanRates: true, showCommissionTerms: false });
  });

  it('an empty or whitespace note is no note; a note is trimmed and collapsed', async () => {
    expect((await loadDisplaySettings(fakeSettingsDb({ pricing_note: '   ' }))).pricingNote).toBeNull();
    expect((await loadDisplaySettings(fakeSettingsDb({ pricing_note: '  Founding\n price  ' }))).pricingNote).toBe(
      'Founding price',
    );
  });
});

describe('saveDisplaySetting: every change logged with who, when and old → new', () => {
  it('turning a switch on and off logs (unset) → true → false with the admin', async () => {
    const db = fakeSettingsDb();
    await saveDisplaySetting(db, { name: 'showPlanRates', value: true, updatedByUserId: 'usr_a' });
    await saveDisplaySetting(db, { name: 'showPlanRates', value: false, updatedByUserId: 'usr_b' });
    expect(db.changes).toEqual([
      { key: 'show_plan_rates', oldValue: null, newValue: 'true', changedByUserId: 'usr_a', reason: null },
      { key: 'show_plan_rates', oldValue: 'true', newValue: 'false', changedByUserId: 'usr_b', reason: null },
    ]);
  });

  it('a save that changes nothing writes and logs nothing', async () => {
    const db = fakeSettingsDb({ show_commission_terms: 'true' });
    expect(await saveDisplaySetting(db, { name: 'showCommissionTerms', value: true })).toEqual({ changed: false });
    expect(await saveDisplaySetting(db, { name: 'pricingNote', value: '  ' })).toEqual({ changed: false });
    expect(db.upserts).toEqual([]);
    expect(db.changes).toEqual([]);
  });

  it('a note over 140 characters is refused before anything is written', async () => {
    const db = fakeSettingsDb();
    await expect(saveDisplaySetting(db, { name: 'pricingNote', value: 'x'.repeat(141) })).rejects.toThrow(/140/);
    expect(db.upserts).toEqual([]);
    expect(db.changes).toEqual([]);
  });

  it('setting then clearing a note logs both', async () => {
    const db = fakeSettingsDb();
    await saveDisplaySetting(db, { name: 'pricingNote', value: 'Founding pricing held for 12 months.', updatedByUserId: 'usr_a' });
    await saveDisplaySetting(db, { name: 'pricingNote', value: '', updatedByUserId: 'usr_a' });
    expect(db.changes.map((c) => [c.oldValue, c.newValue])).toEqual([
      [null, 'Founding pricing held for 12 months.'],
      ['Founding pricing held for 12 months.', ''],
    ]);
  });
});

describe('saveDisplaySettingAction (admin server action)', () => {
  let actions: typeof import('@/app/admin/commercial-settings/actions');
  const form = (name: string, value: string) => {
    const fd = new FormData();
    fd.set('name', name);
    fd.set('value', value);
    return fd;
  };
  const db = () => state.db as ReturnType<typeof fakeSettingsDb>;

  beforeEach(async () => {
    state.role = 'ADMIN';
    state.db = fakeSettingsDb();
    actions = await import('@/app/admin/commercial-settings/actions');
  });

  it('is admin-only: a practitioner is redirected and nothing is written', async () => {
    state.role = 'PRACTITIONER';
    for (const [n, v] of [['showPlanRates', 'on'], ['showCommissionTerms', 'on'], ['pricingNote', 'hi']]) {
      await expect(actions.saveDisplaySettingAction(null, form(n, v))).rejects.toThrow(/REDIRECT:\/auth\/signin/);
    }
    expect(db().settings.size).toBe(0);
    expect(db().changes).toEqual([]);
  });

  it('an admin turns a switch on; the change carries the admin id and old → new', async () => {
    const r = await actions.saveDisplaySettingAction(null, form('showCommissionTerms', 'on'));
    expect(r).toEqual({ ok: true, message: 'Show commission terms is now on.' });
    expect(db().settings.get('show_commission_terms')).toBe('true');
    expect(db().changes).toEqual([
      { key: 'show_commission_terms', oldValue: null, newValue: 'true', changedByUserId: 'usr_admin', reason: null },
    ]);
  });

  it('refuses an unknown setting, a rate key, or a value that is not on/off', async () => {
    expect((await actions.saveDisplaySettingAction(null, form('current_rate_schedule_id', 'x')))?.ok).toBe(false);
    expect((await actions.saveDisplaySettingAction(null, form('referralHoldDays', '5')))?.ok).toBe(false);
    expect((await actions.saveDisplaySettingAction(null, form('showPlanRates', 'true')))?.ok).toBe(false);
    expect(db().changes).toEqual([]);
  });

  it('the Change history on Commercial settings lists every PlatformSettingChange with who, when, old → new', () => {
    const page = readFileSync(join(__dirname, '..', 'src/app/admin/commercial-settings/page.tsx'), 'utf8');
    expect(page).toMatch(/platformSettingChange\.findMany/);
    expect(page).toMatch(/c\.changedAt[\s\S]*c\.key[\s\S]*c\.oldValue === null \? '\(unset\)' : c\.oldValue \|\| '\(empty\)'[\s\S]*c\.newValue \|\| '\(empty\)'[\s\S]*c\.changedByUserId/);
    expect(page).toMatch(/<DisplaySettingsCard/);
  });
});

describe('show_plan_rates OFF: no plan $ or % on any plan surface', () => {
  it('PlanChoice: value cards, no cost table, no break-even, no figure', () => {
    const t = text(choice(OFF));
    expect(t).toContain('Listing subscription');
    expect(t).toContain('Founding-member pricing');
    expect(t).toContain('Pay nothing until we send you a client');
    expect(t).not.toContain('What each plan would cost you');
    expect(t).not.toContain('better deal');
    expect(t).not.toMatch(FIGURE);
  });

  it('PlanTermsSummary: value lists and the "confirmed to you" line, no figure', () => {
    const t = text(summary(OFF));
    expect(t).toContain('No subscription');
    expect(t).toContain('Current rates are confirmed to you before any share applies.');
    expect(t).not.toMatch(FIGURE);
  });

  it('billing card: no price outside the checkout buttons, which still show it', () => {
    const t = text(billing(OFF));
    expect(t).toContain('Pay monthly · $29/mo');
    expect(t).toContain('Pay annually · $299/yr');
    const withoutButtons = t.replace('Pay monthly · $29/mo', '').replace('Pay annually · $299/yr', '');
    expect(withoutButtons).not.toMatch(FIGURE);
    expect(withoutButtons).not.toMatch(/save/i);
    expect(withoutButtons).not.toMatch(/below/);
  });

  it('billing card states before billing and when active carry no price', () => {
    expect(text(billing(OFF, { billingOpen: false }))).toContain("Billing hasn't started for Plan A. You'll be told");
    expect(text(billing(OFF, { billingOpen: false }))).not.toMatch(FIGURE);
    expect(text(billing(OFF, { status: 'ACTIVE' }))).toContain('Your monthly listing subscription is active');
    expect(text(billing(OFF, { status: 'ACTIVE' }))).not.toMatch(FIGURE);
  });

  it('Terms §7 says the rates are confirmed before any share applies', () => {
    const t = text(renderToStaticMarkup(h(TermsAcknowledgment, { acceptedAt: null, showPlanRates: false })));
    expect(t).toContain('are confirmed to you before any share applies');
    expect(t).not.toContain('are shown in the summary above');
  });
});

describe('show_plan_rates ON: today’s figures, from the schedule', () => {
  it('PlanChoice and PlanTermsSummary quote the schedule’s prices and shares', () => {
    for (const t of [text(choice(ON)), text(summary(ON))]) {
      expect(t).toContain('$29/mo');
      expect(t).toContain('We take 10%');
      expect(t).toContain('We take 30%');
    }
    expect(text(choice(ON))).toContain('What each plan would cost you');
  });

  it('billing card shows the struck-through and founding prices', () => {
    const t = text(billing(ON));
    expect(t).toContain('was $39, now $29/mo');
    expect(t).toContain('Founding rate: save $10/mo');
    expect(text(billing(ON, { billingOpen: false }))).toContain('Billing hasn\'t started for Plan A ($29/mo)');
  });

  it('Terms §7 points at the summary above', () => {
    const t = text(renderToStaticMarkup(h(TermsAcknowledgment, { acceptedAt: null, showPlanRates: true })));
    expect(t).toContain('are shown in the summary above');
  });
});

describe('show_commission_terms OFF: referral and recruiter copy has no %, $ or months; the tools stay', () => {
  it('Clients & referrals: approved wording, the referral form and link still render, no figure', () => {
    const html = clients(false);
    const t = text(html);
    expect(t).toContain('Refer a client to a colleague — when someone would be better served by another practitioner here');
    expect(t).toContain('Referrals between members are recognised; terms are being finalised.');
    expect(html).toContain('Send referral');
    expect(html).toContain('Create a referral link');
    expect(html).toContain('https://x.test/r/abc');
    expect(t).not.toMatch(FIGURE);
  });

  it('plan surfaces drop the referral split too', () => {
    const offCommission = { ...ON, showCommissionTerms: false };
    for (const t of [text(choice(offCommission)), text(summary(offCommission))]) {
      expect(t).toContain('terms are being finalised');
      expect(t).not.toMatch(/goes to them/);
      expect(t).not.toMatch(/20%/);
    }
  });

  it('the recruiter notice names no share', () => {
    expect(recruiterDisclosure(null)).toBe('You were invited by a colleague on Natural Health Pros.');
  });

  it('the referral-booked email names no rate and no term', () => {
    const e = referralBookedCopy({ referredName: 'Dr Y', rateLabel: null, termMonths: 4 });
    expect(e.text).not.toMatch(FIGURE);
    expect(e.html).not.toMatch(FIGURE);
  });
});

describe('show_commission_terms ON: figures read from the schedule', () => {
  it('Clients & referrals quotes the schedule’s split and terms', () => {
    const t = text(clients(true));
    expect(t).toContain('Earn 20% of what they book with that practitioner for 4 months');
    expect(t).toContain('30% of those sessions');
    expect(t).toContain('Valid for 8 months');
  });

  it('the recruiter notice states the schedule’s affiliate share, not a literal', () => {
    expect(recruiterDisclosure(V1.affiliateBps)).toMatch(/^3% of your clients/);
    expect(recruiterDisclosure(450)).toMatch(/^4\.50% of your clients/);
  });

  it('onboarding and /join pass the schedule’s affiliateBps, gated on the switch', () => {
    const onboarding = readFileSync(join(__dirname, '..', 'src/app/onboarding/page.tsx'), 'utf8');
    expect(onboarding).toMatch(/recruiterDisclosure\(display\.showCommissionTerms \? copySchedule\.affiliateBps : null\)/);
    const join_ = readFileSync(join(__dirname, '..', 'src/app/join/[cohort]/page.tsx'), 'utf8');
    expect(join_).toMatch(/display\.showCommissionTerms \? await getCurrentSchedule\(prisma\) : null/);
    expect(join_).toMatch(/recruiterDisclosure\(schedule \? schedule\.affiliateBps : null\)/);
  });
});

describe('pricing note: an asterisk and the note on every plan surface when set; nothing when empty', () => {
  const NOTE = 'Founding-member pricing is held for 12 months.';
  for (const base of [OFF, ON]) {
    const label = base.showPlanRates ? 'rates shown' : 'rates hidden';
    it(`set (${label}): PlanChoice, PlanTermsSummary and the billing card carry * and the note`, () => {
      const d = { ...base, pricingNote: NOTE };
      for (const html of [choice(d), summary(d), billing(d)]) {
        expect(html).toContain('data-testid="pricing-note-mark"');
        expect(html).toContain(`* ${NOTE}`);
      }
    });

    it(`empty (${label}): no asterisk, no note`, () => {
      for (const html of [choice(base), summary(base), billing(base)]) {
        expect(html).not.toContain('pricing-note');
        expect(html).not.toContain(NOTE);
      }
    });
  }
});

describe('the disclosure safeguard on Commercial settings', () => {
  it('warns for plan rates once a fee-bearing booking exists while the switch is off', () => {
    expect(displayWarnings({ display: OFF, feeBearingBookings: 0, recruitedPractitioners: 0 })).toEqual([]);
    const w = displayWarnings({ display: OFF, feeBearingBookings: 1, recruitedPractitioners: 0 });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/Show plan rates/);
  });

  it('warns for commission terms once a recruited practitioner exists while the switch is off', () => {
    const w = displayWarnings({ display: OFF, feeBearingBookings: 0, recruitedPractitioners: 2 });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/Show commission terms/);
  });

  it('is silent once the matching switch is on', () => {
    expect(displayWarnings({ display: ON, feeBearingBookings: 5, recruitedPractitioners: 5 })).toEqual([]);
  });

  it('the page counts fee-bearing snapshots and recruited practitioners, and renders the warnings', () => {
    const page = readFileSync(join(__dirname, '..', 'src/app/admin/commercial-settings/page.tsx'), 'utf8');
    expect(page).toMatch(/bookingFeeSnapshot\.count\(\{ where: \{ applicationFeeUsdCents: \{ gt: 0 \} \} \}\)/);
    expect(page).toMatch(/countRecruitedPractitioners\(prisma\)/);
    expect(page).toMatch(/warnings=\{warnings\}/);
  });
});

describe('homepage practitioner section (static copy, no switch)', () => {
  it('carries the approved network and rates wording', () => {
    expect(getListed.guarantees[2]).toEqual({
      title: 'A network that refers to each other',
      body: 'Send clients to colleagues whose work fits, and invite the practitioners you trust to join you.',
    });
    expect(getListed.ratesNote).toBe('You’ll see exactly what applies before anything is charged.');
    expect(JSON.stringify(getListed)).not.toMatch(/earn a share/i);
  });
});

describe('no hardcoded recruiter 3% left in practitioner-facing copy', () => {
  it('git grep finds no "3%" literal in src/ code', () => {
    let out = '';
    try {
      out = execFileSync('git', ['grep', '-n', '-E', '(^|[^0-9.])3%', '--', 'src'], { encoding: 'utf8' });
    } catch (err) {
      // git grep exits 1 when nothing matches.
      if ((err as { status?: number }).status !== 1) throw err;
    }
    // Comments may name the rule; code may not state it.
    const code = out.split('\n').filter((l) => l && !/^\s*(\/\/|\*|\/\*)/.test(l.split(':').slice(2).join(':')));
    expect(code).toEqual([]);
  });
});
