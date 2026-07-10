import { NextResponse, type NextRequest } from 'next/server';
import { makeWebhookValidator } from '@whop/api';
import { prisma } from '@/lib/prisma';
import { indexPractitioner } from '@/lib/practitioner-indexer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Layer X — Whop membership webhook → flip the practitioner's platform-subscription status.
// Verified with Whop's official validator (correct signature scheme). Practitioner is matched by
// the `practitioner_id` metadata we attach at checkout, then membership id, then buyer email.

const validateWebhook = makeWebhookValidator({
  webhookSecret: process.env.WHOP_WEBHOOK_SECRET ?? '',
});

type MembershipData = {
  id?: string;
  membership_id?: string;
  email?: string;
  metadata?: { practitioner_id?: string } | null;
  user?: { id?: string; email?: string } | null;
};

function mapStatus(action: string): 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | null {
  const t = action.toLowerCase();
  if (t.includes('cancel') || t.includes('delete')) return 'CANCELED';
  if (t.includes('invalid') || t.includes('expired') || t.includes('past_due') || t.includes('fail'))
    return 'PAST_DUE';
  if (t.includes('valid') || t.includes('succeed') || t.includes('active')) return 'ACTIVE';
  return null;
}

export async function POST(request: NextRequest) {
  // Fail CLOSED: reject everything until the signing secret is provisioned.
  if (!process.env.WHOP_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'webhook not configured' }, { status: 503 });
  }

  let result: { action?: string; data?: MembershipData };
  try {
    result = (await validateWebhook(request)) as unknown as {
      action?: string;
      data?: MembershipData;
    };
  } catch {
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }

  const action = result.action ?? '';
  const data = result.data ?? {};
  const membershipId = data.id ?? data.membership_id;
  const status = mapStatus(action);

  // Audit + dedup (idempotent on re-delivery); status writes are idempotent regardless.
  const eventKey = `${action}:${membershipId ?? 'unknown'}`;
  const logged = await prisma.whopWebhookEvent
    .upsert({
      where: { whopEventId: eventKey },
      update: { eventType: action, payload: result as object },
      create: { whopEventId: eventKey, eventType: action, payload: result as object },
    })
    .catch(() => null);

  if (status) {
    const practitionerId = data.metadata?.practitioner_id;
    const email = (data.user?.email ?? data.email)?.toLowerCase();

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
        // e.g. a whopMembershipId unique collision — log + ack so Whop doesn't poison-pill retry.
        console.error('subscription update failed (acking anyway):', e);
      }
    }
  }

  if (logged) {
    await prisma.whopWebhookEvent
      .update({ where: { id: logged.id }, data: { processedAt: new Date() } })
      .catch(() => {});
  }
  return NextResponse.json({ ok: true });
}
