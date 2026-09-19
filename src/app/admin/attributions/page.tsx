import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';

import { OverrideForm } from './OverrideForm';

export const dynamic = 'force-dynamic';

/**
 * ATTRIBUTION OVERRIDES (spec v1.4 §3.2, §7).
 *
 * §3.1's decision is taken once and is otherwise immutable — that immutability is what stops a
 * late list entry from retro-exempting a client and a late referral from stealing credit. This
 * screen is the one sanctioned way past it, and every change here needs a note and writes an
 * adjustment entry to the fee ledger.
 *
 * 🔒 CLIENT EMAILS ARE NOT SHOWN, NOT EVEN TO AN ADMIN. `AttributedClient` stores a hash and only
 * a hash, and the model's own docstring is the reason: a plaintext table of people who saw a
 * holistic-health practitioner is the most sensitive thing this system could hold. An override is
 * about WHO IS PAID, which the practitioner, the referrer and the date answer completely. The
 * hash prefix is enough to line a row up against a support conversation.
 */
export default async function AttributionsPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== 'ADMIN') {
    redirect('/auth/signin?callbackUrl=/admin/attributions');
  }

  const rows = await prisma.attributedClient.findMany({
    select: {
      id: true,
      emailHash: true,
      owner: true,
      decidedByRule: true,
      termMonths: true,
      termAnchorAt: true,
      termEndsAt: true,
      referrerPractitionerId: true,
      overrideNote: true,
      overriddenAt: true,
      attributedAt: true,
      practitioner: { select: { displayName: true, slug: true } },
    },
    orderBy: { attributedAt: 'desc' },
    take: 100,
  });

  const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '—');

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <Link href="/admin" className="inline-flex items-center gap-1 text-sm text-slate-600 hover:text-slate-900">
        <ArrowLeft className="h-4 w-4" /> Admin
      </Link>

      <h1 className="mt-4 text-2xl font-semibold text-slate-900">Attributions</h1>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-600">
        Who owns each client, and who referred them. Changing either needs a note and writes an
        adjustment entry to the fee ledger. An override changes what happens <strong>next</strong>{' '}
        — it does not re-price sessions Whop has already charged for.
      </p>

      {rows.length === 0 ? (
        <p className="mt-8 text-sm text-slate-600">No attributions recorded yet.</p>
      ) : (
        <ul className="mt-6 space-y-3">
          {rows.map((r) => (
            <li key={r.id} className="rounded-lg border border-slate-200 p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="font-medium text-slate-900">{r.practitioner.displayName}</span>
                <span className="font-mono text-xs text-slate-500">
                  client {r.emailHash.slice(0, 12)}…
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-600">
                {r.owner === 'PRACTITIONER' ? 'Their own client · 0%' : 'NHP-sourced'}
                {r.referrerPractitionerId ? ` · referred by ${r.referrerPractitionerId}` : ''}
                {' · '}
                term {r.termMonths ?? '—'} months, {day(r.termAnchorAt)} → {day(r.termEndsAt)}
                {r.decidedByRule ? ` · ${r.decidedByRule}` : ''}
              </p>
              {r.overriddenAt && (
                <p className="mt-1 text-xs text-amber-700">
                  Overridden {day(r.overriddenAt)}: {r.overrideNote}
                </p>
              )}
              <OverrideForm
                attributionId={r.id}
                owner={r.owner}
                referrerPractitionerId={r.referrerPractitionerId}
              />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
