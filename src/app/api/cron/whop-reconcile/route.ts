import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import {
  createTransfer,
  getIdentityProfile,
  getPaymentFees,
  getPayoutStatus,
  isWhopPlatformsReady,
} from '@/lib/whop';
import { reconcileFeeLines } from '@/lib/fee-reconciliation';
import {
  expireLapsedHolds,
  promoteHeldToPayable,
  settlePayableShares,
} from '@/lib/referral-payouts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Drift sweep for Whop payout state — the safety net behind the identity_profile.* webhook.
 *
 * WHY THIS EXISTS. Whop retries a webhook 3x over ~70s and then drops it permanently. Until
 * 2026-08-13 the documented reconciliation for that was getPayoutStatus(companyId), which
 * queried `GET /payout_accounts/{biz_…}` — an id type that endpoint does not accept, so it
 * 404'd on every call and the 404 branch swallowed it as "normal pre-KYC state". The net had a
 * hole the exact size of itself. Sarah Schindler was approved by Whop on 2026-08-11 and sat at
 * `not_started` for two days with nothing anywhere reporting a problem.
 *
 * WHAT IT READS. `GET /identity_profiles/{idpf_…}` is the only endpoint exposing all three
 * payout-gating fields together: `status`, `payout_status`, `payouts_enabled`. Keyed on
 * `status: 'approved'` — there is no usable "verified" signal, since the company object's
 * `verified` boolean reads false for every company we own including the platform company.
 *
 * Auth: same shape as /api/cron/trial-sweep — Bearer CRON_SECRET when set, open when unset.
 */

/** Whop ids are only learnable from webhooks, so a null id means "never had a delivery". */
type Drift = {
  slug: string;
  field: string;
  was: string;
  now: string;
};

function authorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return request.headers.get('authorization') === `Bearer ${secret}`;
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!isWhopPlatformsReady()) {
    return NextResponse.json({ error: 'whop not configured' }, { status: 503 });
  }

  const practitioners = await prisma.practitioner.findMany({
    where: { whopCompanyId: { not: null } },
    select: {
      id: true,
      slug: true,
      whopIdentityProfileId: true,
      whopPayoutAccountId: true,
      whopPayoutStatus: true,
      whopPayoutsEnabled: true,
    },
  });

  const drift: Drift[] = [];
  const unpollable: string[] = [];
  const errors: string[] = [];

  for (const p of practitioners) {
    // No stored ids means no webhook ever resolved for this practitioner. That is itself the
    // alarm — it is the exact signature of the bug this sweep was written to catch — so it is
    // reported rather than skipped silently.
    if (!p.whopIdentityProfileId && !p.whopPayoutAccountId) {
      unpollable.push(p.slug);
      continue;
    }

    try {
      const update: Record<string, unknown> = {};
      // Staged, not published. Nothing enters `drift` until the row is actually written —
      // otherwise a failed update still reports `corrected: N` and logs "corrected drift" for
      // changes that were rolled back.
      const pending: Drift[] = [];
      let observedStatus: string | null = null;

      const profile = p.whopIdentityProfileId
        ? await getIdentityProfile(p.whopIdentityProfileId)
        : null;

      if (profile) {
        observedStatus = profile.payoutStatus ?? null;

        // ONE-WAY ONLY: this sweep may OPEN the payout gate, never close it.
        //
        // Gate on `status`/`payout_status`, NOT on `payouts_enabled`. A parent-company API key
        // under-reports the boolean: Whop's own identity_profile.updated for idpf_f9VEKuIiqGPc2
        // carried `payouts_enabled: true` with `linked_companies` populated, and GET
        // /identity_profiles returns `false` with `linked_companies: []` for that same profile
        // today. The boolean is authoritative on the WEBHOOK and unreliable on READ, so gating
        // the sweep on it means the sweep can never open the gate it exists to open.
        //
        // Revocation stays exclusively with identity_profile.rejected / needs_action — a `false`
        // here is "unconfirmed", never "revoked", and acting on it would let a read artifact
        // silently delist a practitioner who can actually take payments.
        if (
          profile.status === 'approved' &&
          profile.payoutStatus === 'connected' &&
          !p.whopPayoutsEnabled
        ) {
          pending.push({ slug: p.slug, field: 'whopPayoutsEnabled', was: 'false', now: 'true' });
          update.whopPayoutsEnabled = true;
        }
      } else if (p.whopPayoutAccountId) {
        // Reached when there is no identity-profile id OR the profile did not resolve (404 on a
        // stale idpf_). A practitioner holding both ids must still fall through to here — an
        // `else if` on the id alone would strand them with no fallback and no error.
        const { status } = await getPayoutStatus(p.whopPayoutAccountId);
        observedStatus = status ?? null;
      } else {
        // Neither id resolved to anything. Report it rather than counting a silent no-op as a
        // verified row.
        errors.push(`${p.slug}: no Whop resource resolved (identity profile 404 or missing)`);
      }

      if (observedStatus && observedStatus !== p.whopPayoutStatus) {
        pending.push({
          slug: p.slug,
          field: 'whopPayoutStatus',
          was: p.whopPayoutStatus,
          now: observedStatus,
        });
        update.whopPayoutStatus = observedStatus;
      }

      if (Object.keys(update).length > 0) {
        await prisma.practitioner.update({ where: { id: p.id }, data: update });
        drift.push(...pending);
      }
    } catch (e) {
      errors.push(`${p.slug}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── Referrer settlement (spec v1.4 §6.2, operator rulings 6 and 7) ─────────────────────────
  //
  // Here rather than in a new cron: this route already runs hourly and already owns "reconcile
  // our Whop state", and every cron route has to appear in vercel.json or it never runs at all —
  // a route that shipped written, documented and unregistered is exactly how /api/cron/whop-
  // reconcile itself spent its first weeks.
  //
  // Order matters. Promote first so a referrer who became payable since the last run is settled
  // on THIS run rather than waiting another hour; expire last so a hold cannot lapse in the same
  // pass that would have paid it.
  const now = new Date();
  const promoted = await promoteHeldToPayable(prisma).catch((e) => {
    errors.push(`promote-held: ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  });

  const settlement = await settlePayableShares(prisma, {
    transfer: createTransfer,
    at: now,
  }).catch((e) => {
    errors.push(`settle-referrals: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  });

  const expired = await expireLapsedHolds(prisma, { at: now }).catch((e) => {
    errors.push(`expire-holds: ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  });

  // ── Fee reconciliation (spec §7) ───────────────────────────────────────────────────────────
  //
  // Match what we RECORDED collecting against what Whop says it actually took. This is the whole
  // point of the fee ledger: without it, "the application fee was charged" is an assumption
  // nobody can check, and a mint that silently minted a zero-fee plan would look identical to one
  // that worked.
  //
  // Bounded and re-checked. Rows are re-examined on later runs rather than marked reconciled,
  // which costs a handful of API reads an hour and buys idempotence with no extra column — and a
  // discrepancy that appears later (a refund, an adjustment on Whop's side) is still caught.
  const mismatches: { bookingIntentId: string | null; expectedUsdCents: number; observedUsdCents: number }[] = [];
  const recent = await prisma.feeLedgerEntry
    .findMany({
      where: {
        kind: 'APPLICATION_FEE',
        whopPaymentId: { not: null },
        createdAt: { gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) },
      },
      select: { bookingIntentId: true, whopPaymentId: true, amountUsdCents: true },
      orderBy: { createdAt: 'desc' },
      take: 25,
    })
    .catch((e) => {
      errors.push(`fee-reconcile: ${e instanceof Error ? e.message : String(e)}`);
      return [] as { bookingIntentId: string | null; whopPaymentId: string | null; amountUsdCents: number }[];
    });

  for (const entry of recent) {
    try {
      const fees = await getPaymentFees(entry.whopPaymentId!);
      const result = reconcileFeeLines({ expectedUsdCents: entry.amountUsdCents, whopFees: fees });
      if (!result.ok) {
        mismatches.push({
          bookingIntentId: entry.bookingIntentId,
          expectedUsdCents: result.expectedUsdCents,
          observedUsdCents: result.observedUsdCents,
        });
      }
    } catch (e) {
      errors.push(`fee-reconcile ${entry.whopPaymentId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (mismatches.length > 0) {
    console.error('whop-reconcile: FEE MISMATCHES', JSON.stringify(mismatches));
  }

  // A BLOCKED payout is not an error — it is the expected state until the parent company is
  // business-verified — but it must be visible in the response rather than inferred from
  // `settled: 0`. "We owe referrers money and here is exactly why it has not moved" should be
  // answerable from one cron response.
  if (settlement?.blocked) {
    console.warn('whop-reconcile: referrer payouts BLOCKED:', settlement.blocked);
  }

  if (unpollable.length > 0) {
    console.error(
      `whop-reconcile: ${unpollable.length} connected account(s) have NO Whop resource ids — ` +
        `no webhook has ever resolved for them: ${unpollable.join(', ')}`,
    );
  }
  if (drift.length > 0) {
    console.warn('whop-reconcile: corrected drift:', JSON.stringify(drift));
  }

  // 207 on any failure, matching /api/cron/trial-sweep. A sweep that polled twelve accounts,
  // failed all twelve on a rotated key, and returned 200 is indistinguishable from a clean run
  // to Vercel cron monitoring — the silent-success shape this route exists to eliminate.
  // A fee mismatch is a REAL problem — money we think we collected and Whop does not — so it must
  // not return 200. A sweep that found one and reported success is the silent-success shape this
  // route exists to eliminate.
  const ok = errors.length === 0 && unpollable.length === 0 && mismatches.length === 0;
  return NextResponse.json(
    {
      ok,
      checked: practitioners.length,
      corrected: drift.length,
      drift,
      unpollable,
      referrals: { promoted, expired, ...(settlement ?? {}) },
      feeMismatches: mismatches,
      errors,
    },
    { status: ok ? 200 : 207 },
  );
}
