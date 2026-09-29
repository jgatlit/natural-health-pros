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
type Filter = 'all' | 'sent' | 'own' | 'referred' | 'overridden';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'sent', label: 'Sent by us' },
  { key: 'own', label: 'Their own clients' },
  { key: 'referred', label: 'Referred' },
  { key: 'overridden', label: 'Overridden' },
];

/** Whole months elapsed from `from` to `to`, counting a month only once its day-of-month is reached. */
function monthsElapsed(from: Date, to: Date): number {
  let m = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  if (to.getUTCDate() < from.getUTCDate()) m -= 1;
  return Math.max(0, m);
}

export default async function AttributionsPage({
  searchParams,
}: {
  searchParams: { filter?: string };
}) {
  const session = await auth();
  if (!session?.user || session.user.role !== 'ADMIN') {
    redirect('/auth/signin?callbackUrl=/admin/attributions');
  }

  const filter: Filter = FILTERS.some((f) => f.key === searchParams.filter)
    ? (searchParams.filter as Filter)
    : 'all';
  const where =
    filter === 'sent'
      ? { owner: 'NHP' as const }
      : filter === 'own'
        ? { owner: 'PRACTITIONER' as const }
        : filter === 'referred'
          ? { referrerPractitionerId: { not: null } }
          : filter === 'overridden'
            ? { overriddenAt: { not: null } }
            : {};

  const rows = await prisma.attributedClient.findMany({
    where,
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

  // The referrer is stored as an id; an operator reads a name. One scoped read, no per-row lookups.
  const referrerIds = Array.from(
    new Set(rows.map((r) => r.referrerPractitionerId).filter((x): x is string => !!x)),
  );
  const referrers = referrerIds.length
    ? await prisma.practitioner.findMany({
        where: { id: { in: referrerIds } },
        select: { id: true, displayName: true },
      })
    : [];
  const referrerName = new Map(referrers.map((r) => [r.id, r.displayName]));
  const now = new Date();

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

      <nav aria-label="Filter attributions" className="mt-5 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={f.key === 'all' ? '/admin/attributions' : `/admin/attributions?filter=${f.key}`}
            aria-current={filter === f.key ? 'page' : undefined}
            className={`rounded-full border px-3 py-1 text-xs font-medium ${
              filter === f.key
                ? 'border-slate-900 bg-slate-900 text-white'
                : 'border-slate-300 text-slate-700 hover:bg-slate-50'
            }`}
          >
            {f.label}
          </Link>
        ))}
      </nav>

      {rows.length === 0 ? (
        <p className="mt-8 text-sm text-slate-600">
          {filter === 'all' ? 'No attributions recorded yet.' : 'Nothing matches this filter.'}
        </p>
      ) : (
        <ul className="mt-6 space-y-3">
          {rows.map((r) => {
            const own = r.owner === 'PRACTITIONER';
            const ended = r.termEndsAt ? r.termEndsAt <= now : false;
            const termLine = own
              ? 'No end date'
              : r.termAnchorAt && r.termMonths
                ? ended
                  ? `Term ended ${day(r.termEndsAt)}`
                  : `Month ${Math.min(r.termMonths, monthsElapsed(r.termAnchorAt, now) + 1)} of ${r.termMonths} · ends ${day(r.termEndsAt)}`
                : 'Term starts at first payment';
            return (
            <li key={r.id} className="rounded-lg border border-slate-200 p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                <span className="font-medium text-slate-900">{r.practitioner.displayName}</span>
                <span className="font-mono text-xs text-slate-500">
                  client {r.emailHash.slice(0, 12)}…
                </span>
              </div>
              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-600">
                <span
                  className={`rounded-full px-2 py-0.5 font-medium ${
                    own ? 'bg-slate-100 text-slate-800' : 'bg-emerald-50 text-emerald-800'
                  }`}
                >
                  {own ? 'Their own client · 0%' : 'Sent by us'}
                </span>
                <span>{termLine}</span>
                {r.referrerPractitionerId && (
                  <span>
                    · Referred by {referrerName.get(r.referrerPractitionerId) ?? r.referrerPractitionerId}
                  </span>
                )}
                {r.decidedByRule && <span>· {r.decidedByRule}</span>}
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
            );
          })}
        </ul>
      )}
    </main>
  );
}
