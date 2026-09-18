/**
 * Leakage sweep — platform-sourced clients paying a practitioner off-platform.
 *
 * Walks each connected account's Whop payments and flags any payment whose buyer matches a LIVE
 * attribution claim but which carries no `booking_intent_id` — i.e. a client we introduced, paid
 * for privately inside the claim window.
 *
 * READ-ONLY AND ADVISORY BY DESIGN. It never charges, never adjusts a plan, never writes to Whop.
 * Email matching has real false positives — a shared household address, a client the practitioner
 * already had before we introduced anyone — and moving money on a heuristic is not recoverable.
 * Output is for a human.
 *
 * Its honest ceiling, which should be stated to the client rather than papered over: it can only
 * see money that moves THROUGH WHOP. Cash, Venmo or a second processor are invisible to it.
 *
 * Usage: npx tsx --env-file=.env scripts/whop-attribution-sweep.ts [--days 90] [--json]
 */
import { PrismaClient } from '@prisma/client';
import { hashClientEmail } from '../src/lib/attributed-clients';

const prisma = new PrismaClient();

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

type WhopPayment = {
  id: string;
  status?: string;
  customer_email?: string | null;
  created_at?: string;
  total?: { amount?: string } | null;
  metadata?: Record<string, unknown> | null;
};

async function payments(accountId: string): Promise<WhopPayment[]> {
  const key = process.env.WHOP_COMPANY_API_KEY;
  if (!key) throw new Error('WHOP_COMPANY_API_KEY is not set');
  const res = await fetch(
    `https://api.whop.com/api/v1/payments?account_id=${encodeURIComponent(accountId)}&limit=100`,
    { headers: { Authorization: `Bearer ${key}` } },
  );
  if (!res.ok) throw new Error(`payments(${accountId}) failed ${res.status}`);
  const body = (await res.json()) as { data?: WhopPayment[] };
  return body.data ?? [];
}

async function main() {
  const days = Number(arg('days', '90'));
  const since = new Date(Date.now() - days * 86_400_000);
  const asJson = process.argv.includes('--json');

  const practitioners = await prisma.practitioner.findMany({
    where: { whopCompanyId: { not: null } },
    select: { id: true, slug: true, displayName: true, whopCompanyId: true, plan: true },
  });

  const flags: Record<string, unknown>[] = [];
  let scanned = 0;
  let unmatchableEmail = 0;

  for (const p of practitioners) {
    let rows: WhopPayment[];
    try {
      rows = await payments(p.whopCompanyId!);
    } catch (err) {
      console.error(`skip ${p.slug}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    for (const payment of rows) {
      if (payment.status !== 'paid') continue;
      if (payment.created_at && new Date(payment.created_at) < since) continue;
      scanned++;

      // No buyer email means we cannot match at all. Counted rather than ignored: a sweep that
      // silently skips half its input reads as "no leakage found", which is a different claim.
      if (!payment.customer_email) {
        unmatchableEmail++;
        continue;
      }

      // A payment that names a booking intent came through us. That is the normal, honest path.
      if (payment.metadata && payment.metadata.booking_intent_id) continue;

      const claim = await prisma.attributedClient.findUnique({
        where: {
          practitionerId_emailHash: {
            practitionerId: p.id,
            emailHash: hashClientEmail(payment.customer_email),
          },
        },
        select: { attributedAt: true, expiresAt: true, party: true },
      });
      if (!claim) continue;
      if (claim.expiresAt <= new Date(payment.created_at ?? Date.now())) continue;

      flags.push({
        practitioner: p.slug,
        plan: p.plan ?? 'unchosen',
        paymentId: payment.id,
        amount: payment.total?.amount ?? null,
        paidAt: payment.created_at ?? null,
        introducedAt: claim.attributedAt.toISOString(),
        claimExpiresAt: claim.expiresAt.toISOString(),
      });
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ scanned, unmatchableEmail, flags }, null, 2));
  } else {
    console.log(`scanned ${scanned} paid payments across ${practitioners.length} connected accounts`);
    console.log(`${unmatchableEmail} had no buyer email and could not be matched`);
    console.log(`${flags.length} flagged for review\n`);
    for (const f of flags) console.log(JSON.stringify(f));
    if (flags.length) {
      console.log('\nFlags are ADVISORY. Confirm with the practitioner before acting — a shared');
      console.log('household address or a pre-existing client both look exactly like this.');
    }
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
