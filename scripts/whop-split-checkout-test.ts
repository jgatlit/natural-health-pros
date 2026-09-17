/**
 * 50/50 split-checkout probe (2026-09-14 action item).
 *
 * Mints ONE real checkout configuration on a connected practitioner account with the platform fee
 * set from `src/lib/pricing-plans.ts` — it does not pay. A human has to complete the checkout with
 * a card; only that proves the money actually splits and lands in both directions, which is the
 * part no API read can answer (`verified` is a marketplace badge, not a payout gate).
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/whop-split-checkout-test.ts --company biz_… [--price 100] [--plan PLAN_B]
 */
import { createOfferingCheckout } from '../src/lib/whop';
import { getPlan, formatBpsAsPercent, isPlanKey, platformFeeCents } from '../src/lib/pricing-plans';

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

  const plan = getPlan(planKey);
  const fee = platformFeeCents({ plan: planKey, priceUsdCents, isFirstSession: true });

  console.log(`company            ${companyId}`);
  console.log(`plan               ${plan.label} (${planKey})`);
  console.log(`first-session split ${formatBpsAsPercent(plan.firstSessionPlatformFeeBps)} platform`);
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
    title: `Split test — ${formatBpsAsPercent(plan.firstSessionPlatformFeeBps)} platform fee`,
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
