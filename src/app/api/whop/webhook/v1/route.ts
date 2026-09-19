import { NextResponse, type NextRequest } from 'next/server';
import type { Practitioner, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { recordAttributedClient } from '@/lib/attributed-clients';
import { loadSettings } from '@/lib/platform-settings';
import { unwrapWebhook } from '@/lib/whop';
import { indexPractitioner } from '@/lib/practitioner-indexer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Whop API v1 webhook receiver (Standard Webhooks spec) — runs alongside the legacy handler at
// src/app/api/whop/webhook/route.ts, which stays on the old {action,data} shape and drives live
// revenue today. This route owns Connected Accounts (Layer Y) payout-readiness events.

/**
 * `company_id` sits on the ENVELOPE, beside `type`/`data` — not inside `data`. Whop's v1
 * deliveries routinely carry a thin `data` (`{ id: "idpf_…" }`) with no company reference at
 * all, so the envelope is frequently the ONLY way to know which connected account an event
 * belongs to. Dropping it on the floor is what silently broke Layer Y (see resolvePractitioner).
 */
type V1Event = { type: string; data: Record<string, unknown>; company_id?: unknown };

function isV1Event(x: unknown): x is V1Event {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { type?: unknown }).type === 'string' &&
    typeof (x as { data?: unknown }).data === 'object' &&
    (x as { data?: unknown }).data !== null
  );
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
}

/**
 * First match wins: explicit practitioner_id metadata (set at checkout/account-link mint time),
 * then any company id the payload carries. Never throws — a resolution failure just means the
 * event is recorded without a practitioner attached.
 */
async function resolvePractitioner(
  data: Record<string, unknown>,
  envelope?: V1Event,
): Promise<Practitioner | null> {
  try {
    const metadata = asRecord(data.metadata);
    const practitionerId = asString(metadata?.practitioner_id);
    if (practitionerId) {
      const byId = await prisma.practitioner.findUnique({ where: { id: practitionerId } });
      if (byId) return byId;
    }

    // Order matters. The envelope's company_id outranks `linked_companies[0]` deliberately:
    // linked_companies is an ARRAY (so [0] is a guess that can attribute an event to the wrong
    // practitioner) and it reads back EMPTY for API-key callers — verified live against
    // /identity_profiles on 2026-08-13, for two separate approved profiles. The envelope names
    // exactly which connected company Whop is notifying about, and on thin payloads it is the
    // only company reference that exists at all.
    // Try every candidate, not just the first one PRESENT. A `??` chain collapses to the first
    // non-null value and issues a single lookup, so a fat payload carrying an unrelated
    // `account_id` (the parent/platform company) would stop there, miss, and never reach the
    // envelope — silently defeating the resolution this function exists to perform.
    const linkedCompanies = Array.isArray(data.linked_companies) ? data.linked_companies : undefined;
    const candidates = [
      asString(asRecord(data.company)?.id),
      asString(data.company_id),
      asString(data.account_id),
      asString(asRecord(data.payout_account)?.company_id),
      asString(envelope?.company_id),
      asString(asRecord(linkedCompanies?.[0])?.id),
    ];

    const seen = new Set<string>();
    for (const companyId of candidates) {
      if (!companyId || seen.has(companyId)) continue;
      seen.add(companyId);
      const byCompany = await prisma.practitioner.findUnique({ where: { whopCompanyId: companyId } });
      if (byCompany) return byCompany;
    }

    return null;
  } catch (e) {
    console.error('v1 webhook: practitioner resolution failed:', e);
    return null;
  }
}

/** Apply a payout-readiness change and re-run the listing gate (Typesense is push-based). */
async function updatePayoutState(practitionerId: string, data: Prisma.PractitionerUpdateInput): Promise<void> {
  await prisma.practitioner.update({ where: { id: practitionerId }, data });
  await indexPractitioner(practitionerId).catch((e) =>
    console.error('v1 webhook: reindex after payout-state change failed:', e),
  );
}

/**
 * A payout-gating event we could not attribute to a practitioner. Returned (not thrown) so POST
 * can persist it on the audit row's `error` column.
 *
 * This exists because the failure it names was invisible for two days. `if (!practitioner)
 * return;` dropped every unattributable event while still stamping processedAt with error null,
 * so /admin/whop-webhooks showed a wall of healthy green rows and the practitioner table was
 * never touched. An event that gates money must never fail quietly.
 */
function unresolved(type: string, data: Record<string, unknown>, envelope?: V1Event): string {
  const ref =
    asString(envelope?.company_id) ?? asString(data.company_id) ?? asString(data.id) ?? 'unknown';
  const message = `unresolved practitioner for ${type} (company/resource ref: ${ref}) — payout state NOT updated`;
  console.error(`v1 webhook: ${message}`);
  return message;
}

/**
 * Capture Whop's own resource ids as they float past.
 *
 * The webhook is the ONLY place the (company → idpf_/poact_) mapping can be learned. The REST
 * list endpoints return the profiles but `linked_companies` reads back empty for parent-company
 * API keys, so a listed profile cannot be attributed to one of our practitioners. Miss it here
 * and reconciliation has nothing to poll.
 */
function idCapture(
  practitioner: Practitioner,
  data: Record<string, unknown>,
): Prisma.PractitionerUpdateInput {
  const out: Prisma.PractitionerUpdateInput = {};
  const id = asString(data.id);
  if (id?.startsWith('idpf_') && practitioner.whopIdentityProfileId !== id) {
    out.whopIdentityProfileId = id;
  }
  if (id?.startsWith('poact_') && practitioner.whopPayoutAccountId !== id) {
    out.whopPayoutAccountId = id;
  }
  return out;
}

/**
 * Pull `booking_intent_id` out of a payment payload.
 *
 * Whop nests checkout metadata differently depending on the payload shape, and getting this wrong
 * fails SILENTLY — the payment is recorded on Whop's side and the intent stays unpaid forever. So
 * every plausible location is checked rather than betting on one.
 */
function bookingIntentIdFrom(data: Record<string, unknown>): string | null {
  const candidates = [
    asRecord(data.metadata),
    asRecord(asRecord(data.checkout_session)?.metadata),
    asRecord(asRecord(data.membership)?.metadata),
    asRecord(asRecord(data.plan)?.metadata),
  ];
  for (const m of candidates) {
    const id = asString(m?.booking_intent_id);
    if (id) return id;
  }
  return null;
}


async function handleEvent(
  type: string,
  data: Record<string, unknown>,
  envelope?: V1Event,
): Promise<string | null> {
  switch (type) {
    case 'identity_profile.approved': {
      const practitioner = await resolvePractitioner(data, envelope);
      if (!practitioner) return unresolved(type, data, envelope);
      await updatePayoutState(practitioner.id, {
        ...idCapture(practitioner, data),
        whopPayoutsEnabled: true,
        whopPayoutStatus: 'connected',
        whopKycCompletedAt: new Date(),
        whopKycStatus: 'VERIFIED', // legacy mirror, kept one release for expand/contract
      });
      return null;
    }
    case 'identity_profile.rejected': {
      const practitioner = await resolvePractitioner(data, envelope);
      if (!practitioner) return unresolved(type, data, envelope);
      await updatePayoutState(practitioner.id, {
        ...idCapture(practitioner, data),
        whopPayoutsEnabled: false,
        whopPayoutStatus: 'verification_failed',
        whopKycStatus: 'REJECTED',
      });
      return null;
    }
    case 'identity_profile.needs_action': {
      const practitioner = await resolvePractitioner(data, envelope);
      if (!practitioner) return unresolved(type, data, envelope);
      await updatePayoutState(practitioner.id, {
        ...idCapture(practitioner, data),
        whopPayoutsEnabled: false,
        whopPayoutStatus: 'action_required',
        whopKycStatus: 'PENDING',
      });
      return null;
    }
    case 'identity_profile.updated': {
      const practitioner = await resolvePractitioner(data, envelope);
      if (!practitioner) return unresolved(type, data, envelope);
      const update: Prisma.PractitionerUpdateInput = idCapture(practitioner, data);
      if (typeof data.payouts_enabled === 'boolean') update.whopPayoutsEnabled = data.payouts_enabled;
      const payoutStatus = asString(data.payout_status);
      if (payoutStatus) update.whopPayoutStatus = payoutStatus;
      if (Object.keys(update).length === 0) return null;
      await updatePayoutState(practitioner.id, update);
      return null;
    }
    case 'payout_account.status_updated': {
      const practitioner = await resolvePractitioner(data, envelope);
      if (!practitioner) return unresolved(type, data, envelope);
      const update: Prisma.PractitionerUpdateInput = idCapture(practitioner, data);
      const status = asString(data.status);
      if (status) update.whopPayoutStatus = status;
      if (typeof data.payouts_enabled === 'boolean') update.whopPayoutsEnabled = data.payouts_enabled;
      if (Object.keys(update).length === 0) return null;
      await updatePayoutState(practitioner.id, update);
      return null;
    }
    case 'payment.succeeded': {
      // THE AUTHORITY FOR PAYMENT (§17.3c). Everything else in the checkout path — the embed's
      // onComplete, the optimistic UI — is display. This is the only party that can prove money
      // moved, and it is the only writer of PAID.
      //
      // Until this existed the sole writer was a PUBLIC UNAUTHENTICATED server action taking the
      // two values printed in the booking URL, so anyone holding a link could record a sale that
      // never happened; and a buyer whose tab closed mid-redirect was never recorded at all.
      //
      // metadata MERGES onto the checkout session, so booking_intent_id arrives alongside the
      // configuration's practitioner_id/offering_id. Whop nests it differently across payload
      // shapes, so every plausible location is checked rather than assuming one.
      const intentId = bookingIntentIdFrom(data);
      if (!intentId) {
        // Layer X subscription payments legitimately carry no booking intent. Layer Y offering
        // payments are told apart by `offering_id`, which the checkout CONFIGURATION contributes
        // to every session's metadata (verified live 2026-08-15: config metadata merges with the
        // per-session metadata rather than being replaced).
        //
        // Reporting the Layer Y case matters because it is reachable: the §8 hosted-checkout
        // fallback is minted from the configuration and carries no booking_intent_id, so a buyer
        // who takes it pays for real against an intent we cannot name. Returning null here would
        // stamp that row healthy-green with error null — the exact silent failure `unresolved()`
        // was written to end, on the one event that moves money.
        const offeringId = asString(asRecord(data.metadata)?.offering_id);
        if (!offeringId) return null;
        const ref = asString(data.id) ?? 'unknown';
        const message = `payment.succeeded for offering ${offeringId} carried no booking_intent_id (payment ${ref}) — paid, but attributable to no booking`;
        console.error(`v1 webhook: ${message}`);
        return message;
      }

      const intent = await prisma.bookingIntent.findUnique({
        where: { id: intentId },
        select: {
          id: true,
          practitionerId: true,
          paidAt: true,
          email: true,
          attributionParty: true,
          attributionSource: true,
          // The term's ANCHOR — the first booked session's scheduled start, not this payment.
          scheduledAt: true,
        },
      });
      if (!intent) return `payment.succeeded referenced unknown booking intent ${intentId}`;

      // `booking_intent_id` is metadata on a checkout session, and anyone able to create a session
      // on a connected company can choose its value. Intent ids are cuids — timestamp-prefixed and
      // enumerable — so without this check one connected practitioner could pay $1 against a
      // RIVAL's intent id and flip it to PAID, permanently dead-ending that buyer (the flow's
      // settled branch gates the whole render) while the real practitioner never collects.
      //
      // Deliberately verified only when the event names a company we recognise. A payment payload
      // that carries no resolvable company reference is passed through rather than refused: this
      // guard must not become a way to drop REAL payments, and an unverifiable event is a weaker
      // problem than a mis-attributed one.
      const payer = await resolvePractitioner(data, envelope);
      if (payer && payer.id !== intent.practitionerId) {
        const message = `payment.succeeded for booking intent ${intentId} arrived on company ${payer.whopCompanyId} but that intent belongs to a different practitioner — REFUSED, not marked paid`;
        console.error(`v1 webhook: ${message}`);
        return message;
      }

      // Never re-writes an already-paid intent: `paidAt: null` is the idempotency guard, so a Whop
      // retry (3x over ~70s) cannot double-record. A zero count here means it was already paid,
      // which is the expected retry path — the unknown-id case was ruled out above.
      const marked = await prisma.bookingIntent.updateMany({
        where: { id: intentId, paidAt: null },
        data: { status: 'PAID', paidAt: new Date() },
      });

      // Record the attribution claim on the SAME transition that records payment, and only once —
      // `marked.count` is already the idempotency guard, so a Whop retry cannot re-stamp the
      // window and quietly extend a claim by 70 seconds' worth of retries.
      //
      // Never fatal. The webhook has ~70s of retries and then Whop drops the event permanently, so
      // a ledger write that fails must not cost us the PAID transition, which is the one thing
      // here that cannot be reconstructed.
      if (marked.count > 0) {
        try {
          // The TERM is snapshotted onto the row here, read from the admin setting exactly once,
          // at creation. Reading it later would let an operator edit reprice a claim already sold.
          const { leadAttributionTermMonths } = await loadSettings(prisma);
          await recordAttributedClient(prisma, {
            practitionerId: intent.practitionerId,
            email: intent.email,
            party: intent.attributionParty,
            source: intent.attributionSource,
            bookingIntentId: intent.id,
            termMonths: leadAttributionTermMonths,
            // ANCHOR ON THE SCHEDULED SESSION, not on `new Date()`. A January payment for a March
            // session is attributed from March; anchoring at payment silently shortened every
            // term by the booking lead time. Null here leaves the row PENDING_ANCHOR — chargeable,
            // but with a clock that has not started, which is the honest state.
            sessionStartsAt: intent.scheduledAt ?? null,
          });
        } catch (err) {
          console.error('v1 webhook: attribution ledger write failed', {
            intentId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return null;
    }
    default:
      return null;
  }
}

export async function POST(request: NextRequest) {
  // Fail CLOSED until a v1 signing secret exists. Either registration's secret is sufficient:
  // the platform needs TWO webhooks (child_resource_events is exclusive, not additive), each
  // with its own secret, and both post here.
  if (!process.env.WHOP_V1_WEBHOOK_SECRET && !process.env.WHOP_V1_WEBHOOK_SECRET_CHILD) {
    return NextResponse.json({ error: 'webhook not configured' }, { status: 503 });
  }

  const rawBody = await request.text();
  const headers = Object.fromEntries(request.headers);

  let event: unknown;
  try {
    event = unwrapWebhook(rawBody, headers);
  } catch {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }

  if (!isV1Event(event)) {
    return NextResponse.json({ ok: true });
  }
  const { type, data } = event;

  // Standard Webhooks dedup key. Composite fallback only covers the (unexpected) case where the
  // header is missing — the header is what makes redelivery-safe upserts actually redelivery-safe.
  const whopEventId = headers['webhook-id'] ?? `${type}:${asString(data.id) ?? 'unknown'}`;

  const logged = await prisma.whopWebhookEvent
    .upsert({
      where: { whopEventId },
      update: { eventType: type, payload: event as Prisma.InputJsonValue },
      create: { whopEventId, eventType: type, payload: event as Prisma.InputJsonValue },
    })
    .catch((e) => {
      console.error('v1 webhook: audit-row upsert failed:', e);
      return null;
    });

  // Whop retries only 3x (10s/20s/40s) then drops the event for good — a DB hiccup must never
  // turn into a non-2xx, or a legitimate event is lost permanently rather than just delayed.
  let failure: string | null = null;
  try {
    failure = await handleEvent(type, data, event);
  } catch (e) {
    failure = `handler threw: ${e instanceof Error ? e.message : String(e)}`;
    console.error('v1 webhook: handler failed (acking anyway):', e);
  }

  // processedAt means "we ran the handler", NOT "it did something" — so the outcome has to be
  // recorded alongside it. Without this, a no-op and a successful payout-state change are
  // indistinguishable in the audit table and on /admin/whop-webhooks.
  if (logged) {
    await prisma.whopWebhookEvent
      .update({ where: { id: logged.id }, data: { processedAt: new Date(), error: failure } })
      .catch(() => {});
  }

  return NextResponse.json({ ok: true });
}
