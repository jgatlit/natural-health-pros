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
 * Reads the CURRENT rate schedule from the database (spec v1.5 §2 — there is no other source of
 * rates) and calls nothing external. Run with `--env-file=.env` against a database you intend to
 * read; it writes nothing.
 */

import { PrismaClient } from '@prisma/client';

import { resolveSessionFee } from '../src/lib/referral-fees';
import type { PlanKey } from '../src/lib/pricing-plans';
import { addMonths } from '../src/lib/attribution-term';
import { planMonthlyCents, planSourcedBps, type RateSchedule } from '../src/lib/rate-schedule';
import { requireCurrentSchedule } from '../src/lib/rate-schedules';

const HORIZON_MONTHS = 12;
const ANCHOR = new Date(Date.UTC(2026, 0, 15));

/** Set in main(); every figure below reads it. */
let SCHEDULE: RateSchedule;
const getPlan = (plan: PlanKey) => ({
  monthlyUsdCents: planMonthlyCents(SCHEDULE, plan),
  sourcedBps: planSourcedBps(SCHEDULE, plan),
});

/**
 * When a sourced client's follow-up sessions happen, in months after their first PAYMENT.
 *
 * The anchor and the boundary both read payment dates (operator correction, 2026-09-19), so an
 * offset here is a gap between two transactions — which is what the model always meant.
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

/** Every session in the horizon, as (month index, months since the first payment) for one client. */
function sessionsFor(arrivalMonth: number, followUps: number): { month: number; offset: number }[] {
  const offsets = [0, ...FOLLOW_UP_OFFSETS.slice(0, followUps)];
  return offsets
    .map((offset) => ({ month: arrivalMonth + offset, offset }))
    .filter((s) => s.month < HORIZON_MONTHS);
}

function yearCost(plan: PlanKey, s: Scenario): { feeUsdCents: number; grossUsdCents: number } {
  let feeUsdCents = 0;
  let grossUsdCents = 0;
  for (let arrival = 0; arrival < HORIZON_MONTHS; arrival++) {
    for (let client = 0; client < s.newClientsPerMonth; client++) {
      for (const session of sessionsFor(arrival, s.followUps)) {
        grossUsdCents += s.priceUsdCents;
        // The term boundary is exclusive and comes from the schedule, exactly as at checkout.
        feeUsdCents += resolveSessionFee({
          plan,
          owner: 'NHP',
          referrerPractitionerId: null,
          priceUsdCents: s.priceUsdCents,
          schedule: SCHEDULE,
          practitionerId: 'projection',
          recruiterPractitionerId: null,
          anchorAt: ANCHOR,
          at: addMonths(ANCHOR, session.offset),
        }).nhpFeeUsdCents;
      }
    }
  }
  const subscription = getPlan(plan).monthlyUsdCents * HORIZON_MONTHS;
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
  const gap = b.sourcedBps - a.sourcedBps;
  if (gap <= 0) return Number.POSITIVE_INFINITY;
  return Math.round(((a.monthlyUsdCents - b.monthlyUsdCents) * 10_000) / gap);
}

async function main() {
SCHEDULE = await requireCurrentSchedule(new PrismaClient());
const TERM_MONTHS = SCHEDULE.leadTermMonths;
const a = getPlan('PLAN_A');
const b = getPlan('PLAN_B');
const pct = (bps: number) => `${bps / 100}%`;
const referralTotal = pct(SCHEDULE.referralTotalBps);
const referrerShare = pct(SCHEDULE.referrerBps);
const nhpReferralShare = pct(SCHEDULE.referralTotalBps - SCHEDULE.referrerBps);

process.stdout.write(`# Plan A vs Plan B — one-year projection for a single practitioner

> **Regenerated ${new Date().toISOString().slice(0, 10)} against the RECURRING fee rule. This supersedes the
> 2026-09-18 version entirely.** That one was computed when Plan B charged its share once per
> client forever and Plan A charged 20% indefinitely. Both readings were reversed by operator
> rulings on 2026-09-18, and the headline finding that came out of them — "Plan A never wins if
> clients rebook" — was an artifact of that asymmetry. It is gone, and it does not survive into
> the numbers below.
>
> Generated by \`scripts/plan-ab-projection.ts\`, which calls the same \`resolveSessionFee()\` the
> checkout calls. Re-run it after any change to the current rate schedule.
>
> Nothing here forecasts platform revenue. It is what ONE practitioner pays under each plan.

## The rule these numbers are computed under

| | Plan A | Plan B |
|---|---|---|
| Monthly fee | ${a.monthlyUsdCents === 0 ? 'none' : usd(a.monthlyUsdCents) + '/mo'} | ${b.monthlyUsdCents === 0 ? 'none' : usd(b.monthlyUsdCents) + '/mo'} |
| Every NHP-sourced session **inside** the term | platform ${pct(a.sourcedBps)} | platform ${pct(b.sourcedBps)} |
| After the term | **0%** | **0%** |
| The practitioner's own clients | **0%, always** | **0%, always** |
| Whop account | required | required |

**One term, ${TERM_MONTHS} months, governing both plans** (operator ruling 5). It is anchored on the
**day of transaction** — the client's first payment to that practitioner — and snapshotted per
client, so changing the admin setting never moves a claim already made. (Operator correction,
2026-09-19: the anchor was briefly the first booked session's scheduled start. Anchoring at
payment starts the clock earlier for any advance booking, which reaches 0% sooner — a small
concession in the practitioner's favour, and it is already reflected in the months below, which
have always counted from the first billable session.)

## Assumptions, and where each comes from

1. **Session price $75 / $100 / $150.** Amy reasoned from $100 on the 2026-09-14 call ("that's a
   twenty dollar difference on a hundred dollars"); HHE's stated standard is first sessions under
   $100, promoted hardest at $75 or less (2026-05-28 call).
2. **0 / 1 / 2 / 4 / 8 new NHP-sourced clients per month**, held flat for 12 months. Practitioner
   income was described as swinging from ~$100 to ~$2,000/mo, so the low end is the realistic case.
3. **Follow-ups at months 3 and 6** after the first payment — the same cadence as spec §9 test 3,
   so the projection and the acceptance test model the same client. Under the transaction-date
   anchor these offsets are measured on payment dates on both sides, which is why the term
   arithmetic below needs no adjustment: the model already counted from the first paid session.
4. **Only NHP-sourced work is counted.** Own clients are 0% on both plans and are excluded.
5. **Cross-referred clients are excluded** and are modelled separately at the end: inside the
   referrer window they cost the same on *either* plan, so they do not discriminate between the two.
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
always exactly ${(b.sourcedBps / a.sourcedBps).toFixed(1)}× Plan A's on identical volume. The crossover is therefore
\`${usd(a.monthlyUsdCents)} ÷ (${pct(b.sourcedBps)} − ${pct(a.sourcedBps)})\` and is **independent of the session price and of how
often clients rebook**. Every table above crosses at the same sourced GROSS — around
${usd(breakEvenMonthlyUsdCents() * HORIZON_MONTHS)}/yr — though that falls at a different clients-per-month row in each one,
because a client is worth more at $150 than at $75 and more again if they rebook.

**2. The previous document's headline finding is gone, and it inverts.** It said Plan A could
never win once sourced clients rebooked through the platform, because 20%-forever eventually
exceeded 40%-once. Under the ruling, rebooking now makes Plan A win *sooner*: more in-term
sessions means the ${pct(a.sourcedBps)}-versus-${pct(b.sourcedBps)} saving accumulates faster against a fixed
${usd(a.monthlyUsdCents)}/month. The volume threshold from that version was an artifact and must not be quoted.

**3. Plan A still has a floor loss of ${usd(a.monthlyUsdCents * HORIZON_MONTHS)}/yr.** A practitioner who subscribes and is sent
nothing pays that for the year. This is unchanged and is exactly the outcome practitioners told
Amy they would cancel over after one or two empty months.

**4. Amy's "$150/mo break-even" was computed at $29/mo, not ${usd(a.monthlyUsdCents)}.** At $29 the crossover is
~$145/mo, which is where her number came from. At the configured ${usd(a.monthlyUsdCents)} it is ${usd(breakEvenMonthlyUsdCents())}/mo. If
$150 is going into practitioner-facing copy, either the price or the copy has to move.

**5. Both plans go to 0% after ${TERM_MONTHS} months**, so neither is a permanent tax on a client
relationship. That is a genuinely better story than either plan had before the ruling, and it is
the part most worth saying out loud to practitioners.

## Cross-referred clients — the case that ignores the plan

When another practitioner refers a client, the session costs **${nhpReferralShare} to Natural Health Pros and
${referrerShare} to the referrer** for the first ${SCHEDULE.referrerTermMonths} months — ${referralTotal} in total, on **either** plan — and then
reverts to the plan rate until month ${TERM_MONTHS}. Plan A does not make a referred client cheaper in the
referrer window, and Plan B does not make them more expensive. The ${referrerShare} they pay on
referred clients in that window is the same ${referrerShare} they *earn* when they refer one out.

## Levers, if this shape is not the intended one

- Move the ${usd(a.monthlyUsdCents)} monthly fee — it is the only thing setting the break-even.
- Move the gap between the two rates; the break-even is inversely proportional to it.
- Move the ${TERM_MONTHS}-month term, which changes total volume but not the crossover.

All three are configuration, not code.
`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
