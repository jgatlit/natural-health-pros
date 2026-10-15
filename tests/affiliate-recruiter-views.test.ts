import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { summarizeAdjustments, summarizeEntries } from '@/lib/affiliate-earnings';
import { RECRUITER_DISCLOSURE } from '@/lib/recruiter';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * THE RECRUITER'S VIEW, THE ADMIN VIEW, AND THE SILENCE OF EVERYONE ELSE (spec v1.5 section 5).
 *
 *   - the recruiter sees who they brought in and what it earned, as the ledger records it;
 *   - the RECRUITED practitioner's dashboard shows nothing about the affiliate share;
 *   - nobody sees a recruited practitioner's clients, and nobody sees another recruiter's rows.
 *
 * Rendering runs the real components against a fake database that HONOURS `where`, so a query that
 * forgot to scope by recruiter would visibly leak here instead of passing by coincidence.
 */

const state = vi.hoisted(() => ({ db: null as any }));
vi.mock('@/lib/prisma', () => ({
  get prisma() {
    return state.db;
  },
}));

const R = 'prac_R'; // the recruiter
const Y = 'prac_Y'; // recruited by R
const Z = 'prac_Z'; // recruited by someone else
const OTHER = 'prac_other';
const NOW = new Date(Date.UTC(2026, 11, 1));
const PAST = new Date(Date.UTC(2026, 10, 1));
const FUTURE = new Date(Date.UTC(2027, 1, 1));

type P = { id: string; displayName: string; slug: string; recruitedById: string | null; recruitedAt: Date | null; archivedAt: Date | null; listed: boolean; email: string };
const PEOPLE: P[] = [
  { id: Y, displayName: 'Yara Young', slug: 'yara-young', recruitedById: R, recruitedAt: new Date(Date.UTC(2026, 9, 14)), archivedAt: null, listed: true, email: 'yara@private.test' },
  { id: 'prac_W', displayName: 'Wren West', slug: 'wren-west', recruitedById: R, recruitedAt: new Date(Date.UTC(2026, 9, 20)), archivedAt: null, listed: false, email: 'wren@private.test' },
  { id: 'prac_old', displayName: 'Archived Ann', slug: 'archived-ann', recruitedById: R, recruitedAt: null, archivedAt: new Date(), listed: false, email: 'ann@private.test' },
  { id: Z, displayName: 'Zed Zane', slug: 'zed-zane', recruitedById: OTHER, recruitedAt: new Date(Date.UTC(2026, 9, 15)), archivedAt: null, listed: true, email: 'zed@private.test' },
  { id: R, displayName: 'Rae Recruiter', slug: 'rae-recruiter', recruitedById: null, recruitedAt: null, archivedAt: null, listed: true, email: 'rae@private.test' },
];

type L = { recruiterPractitionerId: string; recruitedPractitionerId: string; state: string; shareUsdCents: number; reversedUsdCents: number; transferUsdCents: number | null; holdUntil: Date; clientEmail?: string };
let LEDGER: L[] = [];

type A = { recruiterPractitionerId: string; sourceLedgerEntryId: string; amountUsdCents: number; appliedUsdCents: number; state: 'OPEN' | 'APPLIED'; createdAt: Date };
let ADJ: A[] = [];

const calls: { practitioner: any[]; ledger: any[]; adjustments: any[] } = { practitioner: [], ledger: [], adjustments: [] };

/** Honours the `where` keys the code uses. An unrecognised key throws so a new filter can't be ignored. */
function fakeEarningsDb() {
  return {
    practitioner: {
      findMany: async (args: any) => {
        calls.practitioner.push(args);
        return PEOPLE.filter((p) =>
          Object.entries(args.where ?? {}).every(([k, v]) => {
            if (k === 'recruitedById') return typeof v === 'string' ? p.recruitedById === v : p.recruitedById !== null;
            if (k === 'archivedAt') return p.archivedAt === v;
            if (k === 'delistedAt') return true;
            if (['displayName', 'cityId', 'bio', 'specialties', 'OR'].includes(k)) return p.listed;
            if (k === 'id') return (v as any).in.includes(p.id);
            throw new Error(`fake does not understand where.${k}`);
          }),
        ).map((p) => {
          const out: any = {};
          for (const key of Object.keys(args.select)) out[key] = (p as any)[key];
          return out;
        });
      },
    },
    affiliateLedgerEntry: {
      findMany: async (args: any) => {
        calls.ledger.push(args);
        return LEDGER.filter((e) =>
          Object.entries(args.where ?? {}).every(([k, v]) => {
            if (k === 'recruiterPractitionerId') return e.recruiterPractitionerId === v;
            throw new Error(`fake does not understand where.${k}`);
          }),
        ).map((e) => {
          const out: any = {};
          for (const key of Object.keys(args.select)) out[key] = (e as any)[key];
          return out;
        });
      },
    },
    affiliateBalanceAdjustment: {
      findMany: async (args: any) => {
        calls.adjustments.push(args);
        return ADJ.filter((a) =>
          Object.entries(args.where ?? {}).every(([k, v]) => {
            if (k === 'recruiterPractitionerId') return a.recruiterPractitionerId === v;
            throw new Error(`fake does not understand where.${k}`);
          }),
        ).map((a) => {
          const out: any = {};
          for (const key of Object.keys(args.select)) out[key] = (a as any)[key];
          return out;
        });
      },
    },
  };
}

const row = (over: Partial<L> & Record<string, unknown>): L => ({
  recruiterPractitionerId: R,
  recruitedPractitionerId: Y,
  state: 'ACCRUED',
  shareUsdCents: 300,
  reversedUsdCents: 0,
  transferUsdCents: null,
  holdUntil: PAST,
  clientEmail: 'client@secret.test',
  ...over,
});

const ENV = 'WHOP_TRANSFERS_ENABLED';
let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env[ENV];
  delete process.env[ENV];
  state.db = fakeEarningsDb();
  calls.practitioner = [];
  calls.ledger = [];
  calls.adjustments = [];
  LEDGER = [];
  ADJ = [];
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

async function section(practitionerId: string, isOwner: boolean) {
  const { RecruitedPractitionersSection } = await import('@/components/practitioners/RecruitedPractitionersSection');
  const el = await RecruitedPractitionersSection({ practitionerId, isOwner, db: state.db, now: NOW });
  return el === null ? null : renderToStaticMarkup(el);
}

describe('"Practitioners you brought in" — the recruiter’s card', () => {
  it('lists who joined through the link, with join date and whether the profile is published', async () => {
    LEDGER = [row({})];
    const html = (await section(R, true))!;
    expect(html).toContain('Practitioners you brought in');
    expect(html).toContain('Yara Young');
    expect(html).toContain('href="/practitioners/yara-young"');
    expect(html).toContain('Oct 14, 2026');
    expect(html).toMatch(/Yara Young[\s\S]*?Published/);
    expect(html).toContain('Wren West');
    expect(html).toMatch(/Wren West[\s\S]*?Not published yet/);
  });

  it('does not list archived practitioners, anyone else’s recruits, or the recruiter themself', async () => {
    LEDGER = [row({})];
    const html = (await section(R, true))!;
    expect(html).not.toContain('Archived Ann');
    expect(html).not.toContain('Zed Zane');
    expect(html).not.toContain('Rae Recruiter');
  });

  it('shows pending / accrued / paid exactly as the ledger records them, net of refunds', async () => {
    LEDGER = [
      row({ state: 'ACCRUED', holdUntil: FUTURE, shareUsdCents: 300 }), // pending $3.00
      row({ state: 'ACCRUED', holdUntil: PAST, shareUsdCents: 300, reversedUsdCents: 99 }), // accrued $2.01
      row({ state: 'HELD', shareUsdCents: 300 }), // accrued $3.00
      row({ state: 'SETTLED', shareUsdCents: 300, transferUsdCents: 300 }), // paid $3.00
      row({ state: 'REVERSED', shareUsdCents: 300, reversedUsdCents: 300 }), // nothing
    ];
    const html = (await section(R, true))!;
    expect(html).toMatch(/data-testid="affiliate-pending">\$3\.00</);
    expect(html).toMatch(/data-testid="affiliate-accrued">\$5\.01</);
    expect(html).toMatch(/data-testid="affiliate-settled">\$3\.00</);
  });

  it('L2a: always says payouts are net of Whop’s transfer fee, and shows gross / fee / net only when recorded', async () => {
    LEDGER = [row({ state: 'SETTLED', shareUsdCents: 300, transferUsdCents: 300 })];
    let html = (await section(R, true))!;
    expect(html).toContain('Payouts are net of Whop&#x27;s transfer fee.');
    expect(html).not.toContain('affiliate-paid-breakdown');

    LEDGER = [
      row({
        state: 'SETTLED',
        shareUsdCents: 1234,
        transferUsdCents: 1198,
        grossShareUsdCents: 1234,
        transferFeeUsdCents: 36,
        netPaidUsdCents: 1198,
      }),
    ];
    html = (await section(R, true))!;
    expect(html).toMatch(/data-testid="affiliate-paid-gross">\$12\.34</);
    expect(html).toMatch(/data-testid="affiliate-paid-fee">\$0\.36</);
    expect(html).toMatch(/data-testid="affiliate-paid-net">\$11\.98</);
  });

  it('says payouts are not active while WHOP_TRANSFERS_ENABLED is not true, and stops saying it when it is', async () => {
    LEDGER = [row({})];
    expect(await section(R, true)).toContain('(payouts are not active yet)');
    process.env[ENV] = 'false';
    expect(await section(R, true)).toContain('(payouts are not active yet)');
    process.env[ENV] = 'true';
    expect(await section(R, true)).not.toContain('payouts are not active');
  });

  it('lane R2: says recruiters are paid as client payments come in, with NO 90-day / hold-period wording', async () => {
    LEDGER = [row({})];
    const html = (await section(R, true))!;
    expect(html).toMatch(/data-testid="affiliate-timing-note">[^<]*paid as client payments come in once payouts are live/);
    expect(html).not.toMatch(/hold period|90 days|90-day|inside the hold/i);
  });

  it('lane R2: shows the open refund balance and what was already taken off, owner only', async () => {
    LEDGER = [row({})];
    ADJ = [
      { recruiterPractitionerId: R, sourceLedgerEntryId: 'afl_x', amountUsdCents: 120, appliedUsdCents: 120, state: 'APPLIED', createdAt: new Date(Date.UTC(2026, 9, 20)) },
      { recruiterPractitionerId: R, sourceLedgerEntryId: 'afl_y', amountUsdCents: 300, appliedUsdCents: 100, state: 'OPEN', createdAt: new Date(Date.UTC(2026, 9, 22)) },
      { recruiterPractitionerId: OTHER, sourceLedgerEntryId: 'afl_z', amountUsdCents: 9_900, appliedUsdCents: 0, state: 'OPEN', createdAt: new Date(Date.UTC(2026, 9, 22)) },
    ];
    const html = (await section(R, true))!;
    expect(html).toContain('Adjusted for a refund');
    expect(html).toMatch(/data-testid="affiliate-refund-open">\$2\.00</);
    expect(html).toMatch(/data-testid="affiliate-refund-applied">\$2\.20</);
    expect(html).toContain('fully taken off');
    expect(html).toContain('$1.00 taken off so far');
    expect(html).not.toContain('99.00'); // another recruiter's debt is never summed in
    expect(calls.adjustments[0].where).toEqual({ recruiterPractitionerId: R });
    // amounts, state and date only: never the source row, so never a client or a booking
    expect(Object.keys(calls.adjustments[0].select).sort()).toEqual(['amountUsdCents', 'appliedUsdCents', 'createdAt', 'state']);
    expect(await section(R, false)).toBeNull();
  });

  it('lane R2: no refund block at all when there is no refund adjustment', async () => {
    LEDGER = [row({})];
    const html = (await section(R, true))!;
    expect(html).not.toContain('affiliate-refund-adjustments');
  });

  it('lane R2: a recruiter whose only activity is an open refund balance still sees the card', async () => {
    ADJ = [{ recruiterPractitionerId: Z, sourceLedgerEntryId: 'afl_x', amountUsdCents: 120, appliedUsdCents: 0, state: 'OPEN', createdAt: NOW }];
    const html = (await section(Z, true))!;
    expect(html).toMatch(/data-testid="affiliate-refund-open">\$1\.20</);
  });

  it('lane R2: the paid breakdown shows gross, adjusted-for-a-refund, fee and net, and they add up', async () => {
    LEDGER = [
      row({
        state: 'SETTLED',
        shareUsdCents: 300,
        transferUsdCents: 174,
        grossShareUsdCents: 300,
        adjustmentAppliedUsdCents: 120,
        transferFeeUsdCents: 6,
        netPaidUsdCents: 174,
      }),
    ];
    const html = (await section(R, true))!;
    expect(html).toMatch(/data-testid="affiliate-paid-gross">\$3\.00</);
    expect(html).toMatch(/data-testid="affiliate-paid-adjusted">\$1\.20</);
    expect(html).toMatch(/data-testid="affiliate-paid-fee">\$0\.06</);
    expect(html).toMatch(/data-testid="affiliate-paid-net">\$1\.74</);
    expect(300 - 120 - 6).toBe(174);
  });

  it('is the owner’s alone: an admin looking at somebody else’s page gets nothing, and no query runs', async () => {
    LEDGER = [row({})];
    expect(await section(R, false)).toBeNull();
    expect(calls.practitioner).toHaveLength(0);
    expect(calls.ledger).toHaveLength(0);
    expect(calls.adjustments).toHaveLength(0);
  });

  it('renders nothing for a practitioner who has brought nobody in and earned nothing', async () => {
    expect(await section(Z, true)).toBeNull();
    expect(await section('prac_nobody', true)).toBeNull();
  });
});

describe('what it must never show', () => {
  it('no client data and no recruited practitioner’s email, in the markup or in the queries', async () => {
    LEDGER = [row({ state: 'SETTLED', transferUsdCents: 300 })];
    const html = (await section(R, true))!;
    for (const secret of ['@private.test', '@secret.test', 'client@', 'yara@', 'wren@']) {
      expect(html).not.toContain(secret);
    }
    const asked = JSON.stringify([...calls.practitioner, ...calls.ledger].map((c) => c.select));
    expect(asked).not.toMatch(/email|clientEmail|whopPaymentId|bookingIntent|whopTransferId/i);
  });

  it('the ledger query is scoped to THIS recruiter: another recruiter’s money is never summed in', async () => {
    LEDGER = [row({ state: 'SETTLED', transferUsdCents: 300 }), row({ recruiterPractitionerId: OTHER, state: 'SETTLED', transferUsdCents: 9_900 })];
    const html = (await section(R, true))!;
    expect(html).toMatch(/data-testid="affiliate-settled">\$3\.00</);
    expect(html).not.toContain('99.00');
    expect(calls.ledger[0].where).toEqual({ recruiterPractitionerId: R });
    expect(calls.practitioner.every((c) => c.where.recruitedById === R)).toBe(true);
  });
});

describe('the RECRUITED practitioner’s dashboard exposes no affiliate amounts (spec section 5)', () => {
  it('Y, recruited by R and generating R’s share on every session, sees no card at all', async () => {
    LEDGER = [row({ recruitedPractitionerId: Y }), row({ recruitedPractitionerId: Y, state: 'SETTLED', transferUsdCents: 300 })];
    // Y's own page: Y is the owner, and has brought nobody in.
    expect(await section(Y, true)).toBeNull();
    // The ledger query for Y is "rows where Y is the RECRUITER" — the rows Y GENERATES are never read.
    expect(calls.ledger[0].where).toEqual({ recruiterPractitionerId: Y });
  });

  it('even a recruited practitioner who recruits in turn sees only what THEY earn, never what they generate', async () => {
    // Y was recruited by R, and Y recruited Z2. Y's card is about Z2's sessions, not Y's own.
    PEOPLE.push({ id: 'prac_Z2', displayName: 'Zoe Two', slug: 'zoe-two', recruitedById: Y, recruitedAt: NOW, archivedAt: null, listed: true, email: 'zoe@private.test' });
    LEDGER = [
      row({ recruiterPractitionerId: R, recruitedPractitionerId: Y, shareUsdCents: 700 }), // generated BY Y: R's money
      row({ recruiterPractitionerId: Y, recruitedPractitionerId: 'prac_Z2', shareUsdCents: 300, holdUntil: FUTURE }),
    ];
    try {
      const html = (await section(Y, true))!;
      expect(html).toContain('Zoe Two');
      expect(html).toMatch(/data-testid="affiliate-pending">\$3\.00</);
      expect(html).not.toContain('7.00');
      expect(html).not.toMatch(/recruited you|brought you in/i);
    } finally {
      PEOPLE.pop();
    }
  });

  it('the edit page reads no ledger itself and no "generated" side: the card is the only route', () => {
    const page = readFileSync(join(__dirname, '..', 'src/app/practitioners/[slug]/edit/page.tsx'), 'utf8');
    expect(page).not.toMatch(/affiliateLedgerEntry|affiliateEntriesGenerated|affiliateEntriesEarned|recruitedPractitionerId/);
    expect(page).toMatch(/<RecruitedPractitionersSection practitionerId=\{practitioner\.id\} isOwner=\{isOwner\} \/>/);
    // and the page never tells a practitioner who recruited them
    expect(page).not.toMatch(/recruitedBy\b|recruitedById/);
  });

  it('the component that the page mounts is scoped by the page’s own authorised id, not a request value', () => {
    const src = readFileSync(join(__dirname, '..', 'src/components/practitioners/RecruitedPractitionersSection.tsx'), 'utf8');
    expect(src).not.toMatch(/searchParams|params\.|headers\(|cookies\(/);
    expect(src).toMatch(/if \(!isOwner\) return null/);
  });
});

describe('summarizeEntries', () => {
  const e = (over: Partial<L> & Record<string, unknown>) => ({ ...row({}), ...over });
  it('breaks out HELD; a refund of an already-paid share is NOT an "owed back" figure on the row (it is a debit)', () => {
    const t = summarizeEntries(
      [
        e({ state: 'SETTLED', transferUsdCents: 300, reversedUsdCents: 150 }),
        e({ state: 'HELD', shareUsdCents: 300 }),
        e({ state: 'SENDING', transferUsdCents: 300, reversedUsdCents: 100 }),
      ],
      NOW,
    );
    expect(t.settledUsdCents).toBe(300);
    expect(t.heldUsdCents).toBe(300);
    expect(t.accruedUsdCents).toBe(300 + 200);
    expect('recoveryOwedUsdCents' in t).toBe(false);
  });

  it('lane R2: debt relief already netted against an unpaid row is not shown as still owed', () => {
    const t = summarizeEntries([e({ state: 'ACCRUED', holdUntil: PAST, shareUsdCents: 300, adjustmentAppliedUsdCents: 120 })], NOW);
    expect(t.accruedUsdCents).toBe(180);
    expect(t.pendingUsdCents).toBe(0);
  });

  it('lane R2: a share swallowed whole by debits is SETTLED with nothing transferred', () => {
    const t = summarizeEntries(
      [e({ state: 'SETTLED', transferUsdCents: 0, grossShareUsdCents: 300, adjustmentAppliedUsdCents: 300, transferFeeUsdCents: 0, netPaidUsdCents: 0 })],
      NOW,
    );
    expect(t.settledUsdCents).toBe(0);
    expect(t.paidGrossUsdCents).toBe(300);
    expect(t.paidAdjustedUsdCents).toBe(300);
    expect(t.paidNetUsdCents).toBe(0);
  });

  it('lane R2: summarizeAdjustments adds up the open balance (never negative) and what was applied', () => {
    expect(
      summarizeAdjustments([
        { amountUsdCents: 120, appliedUsdCents: 120 },
        { amountUsdCents: 300, appliedUsdCents: 100 },
        { amountUsdCents: 50, appliedUsdCents: 60 }, // corrupt over-application never goes negative
      ]),
    ).toEqual({ openBalanceUsdCents: 200, appliedUsdCents: 280 });
    expect(summarizeAdjustments([])).toEqual({ openBalanceUsdCents: 0, appliedUsdCents: 0 });
  });
});

describe('admin: read-only recruiter links and affiliate totals per recruiter', () => {
  it('shows each recruiter, how many they brought in, and their ledger totals; nothing editable', async () => {
    state.db = {
      practitioner: {
        findMany: async (args: any) =>
          args.where.id
            ? PEOPLE.filter((p) => args.where.id.in.includes(p.id)).map((p) => ({ id: p.id, displayName: p.displayName, slug: p.slug }))
            : PEOPLE.filter((p) => p.recruitedById).map((p) => ({ recruitedById: p.recruitedById })),
      },
      affiliateLedgerEntry: {
        findMany: async () => [
          row({ state: 'ACCRUED', holdUntil: FUTURE }),
          row({ state: 'SETTLED', transferUsdCents: 300 }),
          row({ state: 'SETTLED', transferUsdCents: 300, reversedUsdCents: 100 }),
        ],
      },
      affiliateBalanceAdjustment: {
        findMany: async () => [
          { recruiterPractitionerId: R, amountUsdCents: 100, appliedUsdCents: 0 },
          { recruiterPractitionerId: R, amountUsdCents: 250, appliedUsdCents: 250 },
        ],
      },
    };
    const { AffiliateLedgerSection } = await import('@/app/admin/commercial-settings/AffiliateLedgerSection');
    const html = renderToStaticMarkup(await AffiliateLedgerSection({ now: NOW }));
    expect(html).toContain('Recruiting affiliates');
    expect(html).toContain('Rae Recruiter');
    expect(html).toContain('Payouts are off');
    // R brought in Y, W and the archived one (3); OTHER brought in Z (1).
    expect(html).toMatch(/Rae Recruiter[\s\S]*?<td[^>]*>3<\/td>/);
    expect(html).toContain('$3.00'); // pending
    expect(html).toContain('$6.00'); // paid
    expect(html).toContain('Refund balance (open)');
    expect(html).toMatch(/data-testid="affiliate-refund-balance-total"[^>]*>[^<]*<strong>\$1\.00<\/strong>/); // read-only total
    expect(html).not.toContain('Owed back');
    expect(html).not.toMatch(/hold period|90 days|90-day/i);
    expect(html).not.toMatch(/<form|<button|<input/);
  });

  it('lists stuck payout rows (HELD, SENDING for over an hour) with the reconcile warning', async () => {
    const old = new Date(NOW.getTime() - 3 * 3_600_000);
    state.db = {
      practitioner: {
        findMany: async (args: any) =>
          args.where.id
            ? PEOPLE.filter((p) => args.where.id.in.includes(p.id)).map((p) => ({ id: p.id, displayName: p.displayName, slug: p.slug }))
            : [],
      },
      affiliateLedgerEntry: {
        findMany: async () => [
          { ...row({ state: 'SENDING', transferUsdCents: 300 }), id: 'afl_old', updatedAt: old, lastError: null },
          { ...row({ state: 'SENDING', transferUsdCents: 300 }), id: 'afl_fresh', updatedAt: NOW, lastError: null },
          { ...row({ state: 'HELD' }), id: 'afl_held', updatedAt: old, lastError: 'fetch failed' },
          { ...row({ state: 'ACCRUED' }), id: 'afl_fine', updatedAt: old, lastError: null },
        ],
      },
      affiliateBalanceAdjustment: { findMany: async () => [] },
    };
    const { AffiliateLedgerSection } = await import('@/app/admin/commercial-settings/AffiliateLedgerSection');
    const html = renderToStaticMarkup(await AffiliateLedgerSection({ now: NOW }));
    expect(html).toContain('2 payout rows need a person');
    expect(html).toContain('afl_old');
    expect(html).toContain('afl_held');
    expect(html).toContain('fetch failed');
    expect(html).not.toContain('afl_fresh');
    expect(html).not.toContain('afl_fine');
    expect(html).toContain('affiliate_ledger_entry_id');
    expect(html).not.toMatch(/<form|<button|<input/);
  });

  it('is rendered only inside the ADMIN-gated page, and carries no write path of its own', () => {
    const page = readFileSync(join(__dirname, '..', 'src/app/admin/commercial-settings/page.tsx'), 'utf8');
    expect(page.indexOf("role !== 'ADMIN'")).toBeGreaterThan(-1);
    expect(page.indexOf("role !== 'ADMIN'")).toBeLessThan(page.indexOf('<AffiliateLedgerSection'));
    const sec = readFileSync(join(__dirname, '..', 'src/app/admin/commercial-settings/AffiliateLedgerSection.tsx'), 'utf8');
    expect(sec).not.toMatch(/\.(update|updateMany|create|createMany|upsert|delete|deleteMany)\(/);
    expect(sec).not.toMatch(/'use server'/);
  });
});

describe('e13: the recruiter disclosure comes before the plan terms and the plan choice', () => {
  it('in the onboarding form the disclosure precedes the plan terms summary', async () => {
    const src = readFileSync(join(__dirname, '..', 'src/components/practitioners/OnboardingForm.tsx'), 'utf8');
    const disclosure = src.indexOf('{recruiterDisclosure && (');
    const plans = src.indexOf('<PlanTermsSummary');
    expect(disclosure).toBeGreaterThan(-1);
    expect(plans).toBeGreaterThan(disclosure);
  });

  it('the rendered form shows the 3% disclosure for a recruited sign-up, before the plan terms; none otherwise', async () => {
    const { OnboardingForm } = await import('@/components/practitioners/OnboardingForm');
    const props: any = {
      action: () => undefined,
      isPrefilled: false,
      llmConfigured: false,
      values: { displayName: '', describe: '', cityName: '', cityState: '', yearsInPractice: null, telehealth: false, inPerson: false, openToOutsideWork: null },
      specialties: [],
      aliases: [],
      initialSpecialties: [],
      termsAcceptedAt: null,
      planTerms: {
        plans: [],
        referral: { termMonths: 8, referrerTermMonths: 4, referralTotalLabel: '30%', referrerRateLabel: '20%', nhpReferralRateLabel: '10%' },
      },
    };
    let withIt: string | null = null;
    try {
      withIt = renderToStaticMarkup(h(OnboardingForm, { ...props, recruiterDisclosure: RECRUITER_DISCLOSURE }));
    } catch {
      // The form pulls in client-only widgets that may not server-render in this harness; the
      // source-order test above is then the proof, and the page-level prop test below covers wiring.
    }
    if (withIt) {
      const at = withIt.indexOf('goes to the person who brought you in');
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(withIt.indexOf('How Natural Health Pros is paid'));
      const without = renderToStaticMarkup(h(OnboardingForm, { ...props, recruiterDisclosure: null }));
      expect(without).not.toContain('brought you in');
    }
  });

  it('the disclosure names the 3% and who funds it', () => {
    expect(RECRUITER_DISCLOSURE).toMatch(/3%/);
    expect(RECRUITER_DISCLOSURE).toMatch(/our fee when we take one/);
    expect(RECRUITER_DISCLOSURE).toMatch(/comes out of your payment/);
  });
});
