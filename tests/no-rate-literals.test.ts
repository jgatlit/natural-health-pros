import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * THE DATABASE IS THE ONLY SOURCE OF RATES (spec v1.5 §2).
 *
 * These are source-text tests, deliberately: a rate default is not a behaviour any runtime test can
 * see until the day the lookup comes back empty, which is exactly the day it matters. They fail the
 * build if an env-driven rate, a literal rate default, or a literal percentage in plan-card copy
 * comes back.
 */

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs)$/.test(name)) out.push(full);
  }
  return out;
}

/** Strip block and line comments, so a docstring that NAMES a retired variable is not a read of it. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

const files = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'scripts'))];
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('no env-driven rates survive anywhere in src/ or scripts/', () => {
  const RETIRED = [
    /XREF_[A-Z_]+/,
    /PLAN_[AB]_(MONTHLY|FIRST|LATER)[A-Z_]*/,
    /PLAN_[AB]_[A-Z_]*FEE[A-Z_]*/,
    /LEAD_ATTRIBUTION_TERM_MONTHS/,
    /firstSessionFeeOnce/,
    /FIRST_SESSION_FEE/,
    /firstSessionPlatformFeeBps|laterSessionPlatformFeeBps|monthlyFeeUsdCents/,
  ];

  it.each(RETIRED.map((r) => [String(r), r] as const))('nothing in code matches %s', (_label, re) => {
    const hits = files
      .filter((f) => re.test(code(readFileSync(f, 'utf8'))))
      .map((f) => relative(ROOT, f));
    expect(hits, `retired rate source still referenced in: ${hits.join(', ')}`).toEqual([]);
  });

  it('the only PLAN_* env names read anywhere are non-rate settings', () => {
    const allowed = new Set(['PLAN_A_LABEL', 'PLAN_B_LABEL', 'PLAN_DEFAULT', 'PLAN_COMPARISON_SESSION_PRICE_CENTS']);
    const read: string[] = [];
    for (const f of files) {
      for (const m of Array.from(code(readFileSync(f, "utf8")).matchAll(/process\.env(?:\.|\[['"])(PLAN_[A-Z_]+)/g))) {
        read.push(m[1]);
      }
    }
    expect(read.filter((n) => !allowed.has(n))).toEqual([]);
  });

  it('the fee path reads NO environment at all', () => {
    for (const rel of [
      'src/lib/referral-fees.ts',
      'src/lib/booking-fee.ts',
      'src/lib/rate-schedule.ts',
      'src/lib/rate-schedule-hash.ts',
      'src/lib/rate-schedules.ts',
      'src/lib/attribution-term.ts',
      'src/lib/referral-refunds.ts',
      'src/lib/referral-settlement.ts',
      'src/lib/recruiter.ts',
    ]) {
      expect(code(read(rel)), rel).not.toMatch(/process\.env/);
    }
  });

  it('.env.example documents no rate variables', () => {
    const env = read('.env.example').replace(/^#.*$/gm, '');
    expect(env).not.toMatch(/XREF_|PLAN_[AB]_(MONTHLY|FIRST|LATER)|LEAD_ATTRIBUTION_TERM_MONTHS/);
  });
});

describe('plan-card and referral copy contains no literal rate numbers', () => {
  const COPY_FILES = [
    'src/lib/pricing-plans.ts',
    'src/components/practitioners/PlanChoice.tsx',
    'src/components/practitioners/PlanTermsSummary.tsx',
    'src/components/practitioners/ClientsAndReferralsSection.tsx',
    'src/components/practitioners/OnboardingForm.tsx',
    'src/components/practitioners/SubscriptionSection.tsx',
    'src/app/admin/commercial-settings/page.tsx',
  ];

  it.each(COPY_FILES)('%s: no “N%”, no “$N”, no “N months”', (rel) => {
    const src = code(read(rel));
    // "0%" is structural (own clients / after the term are never charged), not a schedule rate.
    expect(src, `${rel} states a literal percentage`).not.toMatch(/(?<![\d.])[1-9]\d*(\.\d+)?\s*%/);
    expect(src, `${rel} states a literal price`).not.toMatch(/\$\d/);
    expect(src, `${rel} states a literal term`).not.toMatch(/\b\d+ months?\b/);
  });

  it('pricing-plans.ts has no numeric rate defaults (bps/cents) apart from the 10 000 denominator and the example price', () => {
    const src = code(read('src/lib/pricing-plans.ts'));
    const numbers = Array.from(src.matchAll(/(?<![\w.])(\d[\d_]*)(?![\w.])/g)).map((m) => m[1].replace(/_/g, ''));
    const allowed = new Set(['0', '1', '2', '4', '8', '10000', '100']);
    expect(numbers.filter((n) => !allowed.has(n))).toEqual([]);
  });
});
