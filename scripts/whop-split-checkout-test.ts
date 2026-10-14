/**
 * 50/50 split-checkout probe (2026-09-14 action item).
 *
 * Mints ONE real checkout configuration on a connected practitioner account with the platform fee
 * set from the current rate schedule — it does not pay. A human has to complete the checkout with
 * a card; only that proves the money actually splits and lands in both directions, which is the
 * part no API read can answer (`verified` is a marketplace badge, not a payout gate).
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/whop-split-checkout-test.ts --company biz_… [--price 100] [--plan PLAN_B]
 */
import { PrismaClient } from '@prisma/client';

import { createOfferingCheckout } from '../src/lib/whop';
import { formatBpsAsPercent, isPlanKey, planLabel } from '../src/lib/pricing-plans';
import { planSourcedBps } from '../src/lib/rate-schedule';
import { requireCurrentSchedule } from '../src/lib/rate-schedules';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (v === undefined) {
    if (fallback === undefined) throw new Error(`missing --${name}`);
    return fallback;
  }
  return v;
}

async function main() {
  const companyId = arg('company');
  const planKey = arg('plan', 'PLAN_B');
  if (!isPlanKey(planKey)) throw new Error(`--plan must be PLAN_A or PLAN_B (got ${planKey})`);
  const priceUsdCents = Math.round(Number(arg('price', '100')) * 100);
  const practitionerId = arg('practitioner', 'split-test');
  const slug = arg('slug', 'split-test');

  // The rate comes from the CURRENT rate schedule in the database (spec v1.5 §2) — there is no
  // literal or env default to fall back on.
  const prisma = new PrismaClient();
  const schedule = await requireCurrentSchedule(prisma).finally(() => prisma.$disconnect());
  const bps = planSourcedBps(schedule, planKey);
  const fee = Math.floor((priceUsdCents * bps) / 10_000);

  console.log(`company            ${companyId}`);
  console.log(`plan               ${planLabel(planKey)} (${planKey})`);
  console.log(`schedule           ${schedule.label ?? schedule.id}`);
  console.log(`sourced split      ${formatBpsAsPercent(bps)} platform`);
  console.log(`price              $${(priceUsdCents / 100).toFixed(2)}`);
  console.log(`platform fee       $${(fee / 100).toFixed(2)}`);
  console.log(`practitioner nets  $${((priceUsdCents - fee) / 100).toFixed(2)}`);

  if (process.argv.includes('--dry-run')) {
    console.log('\n--dry-run: no Whop call made.');
    return;
  }

  const res = await createOfferingCheckout({
    companyId,
    offeringId: `split-test-${Date.now()}`,
    practitionerId,
    slug,
    title: `Split test — ${formatBpsAsPercent(bps)} platform fee`,
    priceUsdCents,
    interval: 'ONE_TIME',
    applicationFeeCents: fee,
  });

  console.log(`\ncheckout config    ${res.checkoutConfigId}`);
  console.log(`plan id            ${res.planId ?? '(none)'}`);
  console.log(`purchase url       ${res.purchaseUrl}`);
  console.log('\nPay this with a real card to confirm the split settles in both directions.');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
