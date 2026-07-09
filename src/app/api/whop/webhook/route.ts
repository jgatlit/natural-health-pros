import { NextResponse, type NextRequest } from 'next/server';
import crypto from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { indexPractitioner } from '@/lib/practitioner-indexer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Layer X — Whop membership webhook → flip the practitioner's platform-subscription status.
// The exact Whop event names + signature header are confirmed against Whop's webhook docs when
// the webhook is registered (WHOP_WEBHOOK_SECRET provisioned then); the resolution/mapping below
// is the wiring. Practitioner is matched by the `practitioner_id` metadata we attach at checkout,
// falling back to the membership id, then the buyer email.

type WhopWebhookPayload = {
  id?: string;
  action?: string;
  type?: string;
  event?: string;
  membership_id?: string;
  email?: string;
  metadata?: { practitioner_id?: string };
  user?: { email?: string };
  data?: {
    id?: string;
    membership_id?: string;
    email?: string;
    metadata?: { practitioner_id?: string };
    membership?: { id?: string; metadata?: { practitioner_id?: string } };
    user?: { email?: string };
  };
};

function verifySignature(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const provided = signature.replace(/^sha256=/, '').trim();
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  } catch {
    return false;
  }
}

function mapStatus(eventType: string): 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | null {
  const t = eventType.toLowerCase();
  if (t.includes('cancel') || t.includes('delete')) return 'CANCELED';
  if (t.includes('invalid') || t.includes('expired') || t.includes('past_due')) return 'PAST_DUE';
  if (t.includes('valid') || t.includes('succeed') || t.includes('active')) return 'ACTIVE';
  return null;
}

export async function POST(req: NextRequest) {
  const secret = process.env.WHOP_WEBHOOK_SECRET;
  // Fail CLOSED: reject everything until the signing secret is provisioned, so this public
  // route can't process forged/unsigned events (which could flip listing visibility).
  if (!secret) {
    return NextResponse.json({ error: 'webhook not configured' }, { status: 503 });
  }
  const rawBody = await req.text();
  const sig =
    req.headers.get('x-whop-signature') ??
    req.headers.get('whop-signature') ??
    req.headers.get('x-signature');
  if (!verifySignature(rawBody, sig, secret)) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }

  let event: WhopWebhookPayload;
  try {
    event = JSON.parse(rawBody) as WhopWebhookPayload;
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const d = event.data ?? {};
  const eventId = event.id ?? d.id;
  const eventType = event.action ?? event.type ?? event.event ?? '';

  // Dedup + audit.
  if (eventId) {
    const existing = await prisma.whopWebhookEvent.findUnique({ where: { whopEventId: eventId } });
    if (existing?.processedAt) return NextResponse.json({ ok: true, dedup: true });
  }
  const logged = eventId
    ? await prisma.whopWebhookEvent.upsert({
        where: { whopEventId: eventId },
        update: { eventType, payload: event },
        create: { whopEventId: eventId, eventType, payload: event },
      })
    : null;

  const status = mapStatus(eventType);
  if (status) {
    const practitionerId =
      d.metadata?.practitioner_id ??
      d.membership?.metadata?.practitioner_id ??
      event.metadata?.practitioner_id;
    const membershipId = d.id ?? d.membership_id ?? d.membership?.id ?? event.membership_id;
    const email = (d.user?.email ?? d.email ?? event.user?.email ?? event.email)?.toLowerCase();

    let practitioner = practitionerId
      ? await prisma.practitioner.findUnique({ where: { id: practitionerId } })
      : null;
    if (!practitioner && membershipId) {
      practitioner = await prisma.practitioner.findUnique({
        where: { whopMembershipId: membershipId },
      });
    }
    if (!practitioner && email) {
      const user = await prisma.user.findUnique({
        where: { email },
        include: { practitioner: true },
      });
      practitioner = user?.practitioner ?? null;
    }

    if (practitioner) {
      try {
        await prisma.practitioner.update({
          where: { id: practitioner.id },
          data: {
            subscriptionStatus: status,
            whopMembershipId: membershipId ?? practitioner.whopMembershipId,
          },
        });
        // Re-run the listing gate: subscribe → indexed; lapse → removed from discovery.
        await indexPractitioner(practitioner.id).catch((e) =>
          console.error('reindex after subscription webhook failed:', e),
        );
      } catch (e) {
        // e.g. a whopMembershipId unique collision (misrouted / reused delivery). Log and
        // fall through so the event still gets processedAt — avoids a Whop poison-pill retry loop.
        console.error('subscription update failed (acking anyway):', e);
      }
    }
  }

  if (logged) {
    await prisma.whopWebhookEvent.update({
      where: { id: logged.id },
      data: { processedAt: new Date() },
    });
  }
  return NextResponse.json({ ok: true });
}
