/**
 * Generate docs/2026-09-18-plan-ab-one-year-projection.md.
 *
 * A SCRIPT RATHER THAN A HAND-WRITTEN TABLE, for two reasons. The first version of this document
 * was written by hand against a fee rule that the operator then reversed, and every number in it
 * became wrong at once with nothing to recompute them from. The second is that the figures are
 * the input to a pricing decision Amy owns — they have to come from the same `resolveSessionFee`
 * the checkout uses, or the document is describing a product we do not ship.
 *
 * Run: `npx tsx scripts/plan-ab-projection.ts > docs/2026-09-18-plan-ab-one-year-projection.md`
 *
 * Reads NOTHING from the database and calls NOTHING external.
 */

import { resolveSessionFee } from '../src/lib/referral-fees';
import { getPlan, type PlanKey } from '../src/lib/pricing-plans';
import type { TermState } from '../src/lib/attribution-term';

/** The ruled default. Snapshotted per attribution in production; a constant is right here. */
const TERM_MONTHS = 8;
const HORIZON_MONTHS = 12;

/**
 * When a sourced client's follow-up sessions happen, in months after their first.
 *
 * Months 3 and 6 deliberately mirror spec §9 test 3, which is the acceptance case the operator
 * signed off — so the projection and the test are modelling the same client rather than two
 * different imagined ones.
 */
const FOLLOW_UP_OFFSETS = [3, 6];

type Scenario = {
  priceUsdCents: number;
  newClientsPerMonth: number;
  followUps: number;
};

/** Every chargeable session in the horizon, as (monthIndex, termState) for one cohort member. */
function sessionsFor(arrivalMonth: number, followUps: number): { month: number; term: TermState }[] {
  const offsets = [0, ...FOLLOW_UP_OFFSETS.slice(0, followUps)];
  return offsets
    .map((offset) => ({
      month: arrivalMonth + offset,
      // The first session INTRODUCES the client, so there is no prior claim: NONE. Later sessions
      // sit inside the term while `offset < TERM_MONTHS` and outside it after — the boundary is
      // exclusive, so month 8 exactly would be out.
      term: (offset === 0 ? 'NONE' : offset < TERM_MONTHS ? 'IN_TERM' : 'OUT_OF_TERM') as TermState,
    }))
    .filter((s) => s.month < HORIZON_MONTHS);
}

function yearCost(plan: PlanKey, s: Scenario): { feeUsdCents: number; grossUsdCents: number } {
  let feeUsdCents = 0;
  let grossUsdCents = 0;
  for (let arrival = 0; arrival < HORIZON_MONTHS; arrival++) {
    for (let client = 0; client < s.newClientsPerMonth; client++) {
      for (const session of sessionsFor(arrival, s.followUps)) {
        grossUsdCents += s.priceUsdCents;
        feeUsdCents += resolveSessionFee({
          plan,
          owner: 'NHP',
          term: session.term,
          referrerPractitionerId: null,
          priceUsdCents: s.priceUsdCents,
        }).nhpFeeUsdCents;
      }
    }
  }
  const subscription = getPlan(plan).monthlyFeeUsdCents * HORIZON_MONTHS;
  return { feeUsdCents: feeUsdCents + subscription, grossUsdCents };
}

/** `-$468`, not `$-468`. The minus belongs outside the symbol, and Plan A's floor loss is the
 *  one figure in this document a practitioner will read as a headline. */
const usd = (cents: number) => {
  const dollars = Math.round(cents / 100);
  const body = `$${Math.abs(dollars).toLocaleString('en-US')}`;
  return dollars < 0 ? `-${body}` : body;
};

const VOLUMES = [0, 1, 2, 4, 8];

function table(priceUsdCents: number, followUps: number): string {
  const lines = [
    '| New sourced clients/mo | Sourced gross/yr | Plan A cost/yr | Plan B cost/yr | Plan A net | Plan B net | Cheaper |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const newClientsPerMonth of VOLUMES) {
    const s = { priceUsdCents, newClientsPerMonth, followUps };
    const a = yearCost('PLAN_A', s);
    const b = yearCost('PLAN_B', s);
    const better =
      a.feeUsdCents === b.feeUsdCents ? 'Same' : a.feeUsdCents < b.feeUsdCents ? 'Plan A' : 'Plan B';
    lines.push(
      `| ${newClientsPerMonth} | ${usd(a.grossUsdCents)} | ${usd(a.feeUsdCents)} | ${usd(
        b.feeUsdCents,
      )} | ${usd(a.grossUsdCents - a.feeUsdCents)} | ${usd(b.grossUsdCents - b.feeUsdCents)} | ${better} |`,
    );
  }
  return lines.join('\n');
}

/**
 * The monthly sourced gross at which Plan A becomes cheaper.
 *
 * Solved rather than searched, because with both plans bounded by the SAME term the relationship
 * is exact: Plan B's fee is a fixed multiple of Plan A's on identical volume, so the crossover is
 * `subscription / (planB_rate - planA_rate)` and does not depend on the session price or on how
 * often clients rebook. That independence IS the headline finding, so stating it as a formula is
 * more honest than presenting a table of near-identical numbers.
 */
function breakEvenMonthlyUsdCents(): number {
  const a = getPlan('PLAN_A');
  const b = getPlan('PLAN_B');
  const gap = b.firstSessionPlatformFeeBps - a.firstSessionPlatformFeeBps;
  if (gap <= 0) return Number.POSITIVE_INFINITY;
  return Math.round((a.monthlyFeeUsdCents * 10_000) / gap);
}

const a = getPlan('PLAN_A');
const b = getPlan('PLAN_B');
const pct = (bps: number) => `${bps / 100}%`;

process.stdout.write(`# Plan A vs Plan B — one-year projection for a single practitioner

> **Regenerated ${new Date().toISOString().slice(0, 10)} against the RECURRING fee rule. This supersedes the
> 2026-09-18 version entirely.** That one was computed when Plan B charged its share once per
> client forever and Plan A charged 20% indefinitely. Both readings were reversed by operator
> rulings on 2026-09-18, and the headline finding that came out of them — "Plan A never wins if
> clients rebook" — was an artifact of that asymmetry. It is gone, and it does not survive into
> the numbers below.
>
> Generated by \`scripts/plan-ab-projection.ts\`, which calls the same \`resolveSessionFee()\` the
> checkout calls. Re-run it after any change to \`src/lib/pricing-plans.ts\`.
>
> Nothing here forecasts platform revenue. It is what ONE practitioner pays under each plan.

## The rule these numbers are computed under

| | Plan A | Plan B |
|---|---|---|
| Monthly fee | ${a.monthlyFeeUsdCents === 0 ? 'none' : usd(a.monthlyFeeUsdCents) + '/mo'} | ${b.monthlyFeeUsdCents === 0 ? 'none' : usd(b.monthlyFeeUsdCents) + '/mo'} |
| Every NHP-sourced session **inside** the term | platform ${pct(a.firstSessionPlatformFeeBps)} | platform ${pct(b.firstSessionPlatformFeeBps)} |
| After the term | **0%** | **0%** |
| The practitioner's own clients | **0%, always** | **0%, always** |
| Whop account | required | required |

**One term, ${TERM_MONTHS} months, governing both plans** (operator ruling 5). It is anchored on the
first booked session's scheduled start and snapshotted per client, so changing the admin setting
never moves a claim already made.

## Assumptions, and where each comes from

1. **Session price $75 / $100 / $150.** Amy reasoned from $100 on the 2026-09-14 call ("that's a
   twenty dollar difference on a hundred dollars"); HHE's stated standard is first sessions under
   $100, promoted hardest at $75 or less (2026-05-28 call).
2. **0 / 1 / 2 / 4 / 8 new NHP-sourced clients per month**, held flat for 12 months. Practitioner
   income was described as swinging from ~$100 to ~$2,000/mo, so the low end is the realistic case.
3. **Follow-ups at months 3 and 6** after the first session — the same cadence as spec §9 test 3,
   so the projection and the acceptance test model the same client.
4. **Only NHP-sourced work is counted.** Own clients are 0% on both plans and are excluded.
5. **Cross-referred clients are excluded** and are modelled separately at the end: they cost 40%
   in total on *either* plan, so they do not discriminate between the two.
6. Whop processing fees excluded — identical on both plans (~$0.72 on the live $10 test). No
   churn, no refunds, no mid-year price change.

### Session price $75

**No follow-ups**

${table(7_500, 0)}

**Two follow-ups per client (months 3 and 6)**

${table(7_500, 2)}

### Session price $100

**No follow-ups**

${table(10_000, 0)}

**Two follow-ups per client (months 3 and 6)**

${table(10_000, 2)}

### Session price $150

**No follow-ups**

${table(15_000, 0)}

**Two follow-ups per client (months 3 and 6)**

${table(15_000, 2)}

## What the projection actually says

**1. The break-even is ${usd(breakEvenMonthlyUsdCents())}/month of platform-sourced business, and it does not
move.** Both plans now charge on the same sessions inside the same term, so Plan B's fee is
always exactly ${(b.firstSessionPlatformFeeBps / a.firstSessionPlatformFeeBps).toFixed(1)}× Plan A's on identical volume. The crossover is therefore
\`${usd(a.monthlyFeeUsdCents)} ÷ (${pct(b.firstSessionPlatformFeeBps)} − ${pct(a.firstSessionPlatformFeeBps)})\` and is **independent of the session price and of how
often clients rebook**. Every table above crosses at the same sourced GROSS — around
${usd(breakEvenMonthlyUsdCents() * HORIZON_MONTHS)}/yr — though that falls at a different clients-per-month row in each one,
because a client is worth more at $150 than at $75 and more again if they rebook.

**2. The previous document's headline finding is gone, and it inverts.** It said Plan A could
never win once sourced clients rebooked through the platform, because 20%-forever eventually
exceeded 40%-once. Under the ruling, rebooking now makes Plan A win *sooner*: more in-term
sessions means the ${pct(a.firstSessionPlatformFeeBps)}-versus-${pct(b.firstSessionPlatformFeeBps)} saving accumulates faster against a fixed
${usd(a.monthlyFeeUsdCents)}/month. The volume threshold from that version was an artifact and must not be quoted.

**3. Plan A still has a floor loss of ${usd(a.monthlyFeeUsdCents * HORIZON_MONTHS)}/yr.** A practitioner who subscribes and is sent
nothing pays that for the year. This is unchanged and is exactly the outcome practitioners told
Amy they would cancel over after one or two empty months.

**4. Amy's "$150/mo break-even" was computed at $29/mo, not ${usd(a.monthlyFeeUsdCents)}.** At $29 the crossover is
~$145/mo, which is where her number came from. At the configured ${usd(a.monthlyFeeUsdCents)} it is ${usd(breakEvenMonthlyUsdCents())}/mo. If
$150 is going into practitioner-facing copy, either the price or the copy has to move.

**5. Both plans go to 0% after ${TERM_MONTHS} months**, so neither is a permanent tax on a client
relationship. That is a genuinely better story than either plan had before the ruling, and it is
the part most worth saying out loud to practitioners.

## Cross-referred clients — the case that ignores the plan

When another practitioner refers a client, the session costs **${pct(2_000)} to Natural Health Pros and
${pct(2_000)} to the referrer** for the term — 40% in total, on **either** plan. Plan A does not make a
cross-referred client cheaper, and Plan B does not make them more expensive. A practitioner
choosing a plan should know that referred work is priced the same either way, and that the ${pct(2_000)}
they pay on referred clients is the same ${pct(2_000)} they *earn* when they refer one out.

## Levers, if this shape is not the intended one

- Move the ${usd(a.monthlyFeeUsdCents)} monthly fee — it is the only thing setting the break-even.
- Move the gap between the two rates; the break-even is inversely proportional to it.
- Move the ${TERM_MONTHS}-month term, which changes total volume but not the crossover.

All three are configuration, not code.
`);
