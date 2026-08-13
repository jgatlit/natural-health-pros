import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { indexPractitioner } from '@/lib/practitioner-indexer';
import { getIdentityProfile, getPayoutStatus, isWhopPlatformsReady } from '@/lib/whop';

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

      if (p.whopIdentityProfileId) {
        const profile = await getIdentityProfile(p.whopIdentityProfileId);
        if (profile) {
          if (profile.payoutStatus && profile.payoutStatus !== p.whopPayoutStatus) {
            drift.push({
              slug: p.slug,
              field: 'whopPayoutStatus',
              was: p.whopPayoutStatus,
              now: profile.payoutStatus,
            });
            update.whopPayoutStatus = profile.payoutStatus;
          }

          // ONE-WAY ONLY: this sweep may OPEN the payout gate, never close it.
          //
          // A parent-company API key is known to under-report — `linked_companies` arrives
          // populated on the webhook and reads back empty here for the same profile — so a
          // `false` from this endpoint is "unconfirmed", not "revoked". Acting on it would let
          // a read artifact silently delist a practitioner who can actually take payments.
          // Revocation stays exclusively with identity_profile.rejected / needs_action.
          if (
            profile.payoutsEnabled === true &&
            profile.status === 'approved' &&
            !p.whopPayoutsEnabled
          ) {
            drift.push({ slug: p.slug, field: 'whopPayoutsEnabled', was: 'false', now: 'true' });
            update.whopPayoutsEnabled = true;
          }
        }
      } else if (p.whopPayoutAccountId) {
        // Fallback: no identity profile id yet, but we do have the payout account. This gives
        // status only — never payouts_enabled — so it can correct the banner but not the gate.
        const { status } = await getPayoutStatus(p.whopPayoutAccountId);
        if (status && status !== p.whopPayoutStatus) {
          drift.push({
            slug: p.slug,
            field: 'whopPayoutStatus',
            was: p.whopPayoutStatus,
            now: status,
          });
          update.whopPayoutStatus = status;
        }
      }

      if (Object.keys(update).length > 0) {
        await prisma.practitioner.update({ where: { id: p.id }, data: update });
        // Typesense is push-based, so a DB flip that changes listing eligibility is invisible
        // to /search until it is explicitly reindexed.
        await indexPractitioner(p.id).catch((e) =>
          errors.push(`${p.slug}: reindex failed: ${e instanceof Error ? e.message : String(e)}`),
        );
      }
    } catch (e) {
      errors.push(`${p.slug}: ${e instanceof Error ? e.message : String(e)}`);
    }
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

  return NextResponse.json({
    checked: practitioners.length,
    corrected: drift.length,
    drift,
    unpollable,
    errors,
  });
}
