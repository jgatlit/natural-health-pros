import Link from 'next/link';

import { prisma } from '@/lib/prisma';
import { selectRecruiter, whereAnyRecruiter } from '@/lib/recruiter';
import { summarizeEntries, type LedgerAmounts, type LedgerTotals } from '@/lib/affiliate-earnings';

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

type Row = {
  recruiterId: string;
  name: string;
  slug: string;
  recruits: number;
  totals: LedgerTotals;
};

/**
 * READ-ONLY view of the recruiting-affiliate ledger (spec v1.5 section 5): who recruited whom, and
 * what each recruiter is owed, per recruiter. ADMIN-only because the page that renders it is
 * (`CommercialSettingsPage` redirects anyone else before this component is ever reached).
 *
 * There is deliberately no action here. Overriding a recruiter is a separate, audited feature; this
 * lane only makes the numbers visible. Amounts are the ledger's own, net of refunds.
 */
export async function AffiliateLedgerSection({ now = new Date() }: { now?: Date }) {
  const [recruited, entries] = await Promise.all([
    prisma.practitioner.findMany({
      where: whereAnyRecruiter,
      select: selectRecruiter,
    }),
    prisma.affiliateLedgerEntry.findMany({
      select: {
        recruiterPractitionerId: true,
        state: true,
        shareUsdCents: true,
        reversedUsdCents: true,
        transferUsdCents: true,
        holdUntil: true,
      },
      take: 50_000,
    }),
  ]);

  const recruitCount = new Map<string, number>();
  for (const p of recruited) {
    if (p.recruitedById) recruitCount.set(p.recruitedById, (recruitCount.get(p.recruitedById) ?? 0) + 1);
  }
  const byRecruiter = new Map<string, LedgerAmounts[]>();
  for (const e of entries) {
    const list = byRecruiter.get(e.recruiterPractitionerId) ?? [];
    list.push(e);
    byRecruiter.set(e.recruiterPractitionerId, list);
  }

  const ids = Array.from(new Set([...Array.from(recruitCount.keys()), ...Array.from(byRecruiter.keys())]));
  const people = ids.length
    ? await prisma.practitioner.findMany({
        where: { id: { in: ids } },
        select: { id: true, displayName: true, slug: true },
      })
    : [];
  const person = new Map(people.map((p) => [p.id, p]));

  const rows: Row[] = ids
    .map((id) => ({
      recruiterId: id,
      name: person.get(id)?.displayName || person.get(id)?.slug || id,
      slug: person.get(id)?.slug ?? '',
      recruits: recruitCount.get(id) ?? 0,
      totals: summarizeEntries(byRecruiter.get(id) ?? [], now),
    }))
    .sort((a, b) => b.recruits - a.recruits || a.name.localeCompare(b.name));

  const transfersOn = process.env.WHOP_TRANSFERS_ENABLED === 'true';

  return (
    <section className="mt-10" aria-labelledby="affiliate-ledger-heading">
      <h2 id="affiliate-ledger-heading" className="text-lg font-semibold text-slate-900">
        Recruiting affiliates
      </h2>
      <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-600">
        Read-only. Recruiter links are written once at sign-up and never change. Amounts are the affiliate
        ledger&apos;s, net of refunds.{' '}
        {!transfersOn && <strong>Payouts are off (WHOP_TRANSFERS_ENABLED is not true): nothing has been paid.</strong>}
      </p>

      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-slate-600">Nobody has been recruited yet.</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="py-2 pr-3">Recruiter</th>
                <th className="py-2 pr-3">Brought in</th>
                <th className="py-2 pr-3">Pending</th>
                <th className="py-2 pr-3">Accrued</th>
                <th className="py-2 pr-3">Held</th>
                <th className="py-2 pr-3">Paid</th>
                <th className="py-2 pr-3">Owed back</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((r) => (
                <tr key={r.recruiterId}>
                  <td className="py-2 pr-3">
                    {r.slug ? (
                      <Link href={`/practitioners/${r.slug}`} className="font-medium hover:underline">
                        {r.name}
                      </Link>
                    ) : (
                      r.name
                    )}
                  </td>
                  <td className="py-2 pr-3">{r.recruits}</td>
                  <td className="py-2 pr-3">{usd(r.totals.pendingUsdCents)}</td>
                  <td className="py-2 pr-3">{usd(r.totals.accruedUsdCents)}</td>
                  <td className="py-2 pr-3">{usd(r.totals.heldUsdCents)}</td>
                  <td className="py-2 pr-3">{usd(r.totals.settledUsdCents)}</td>
                  <td className="py-2 pr-3">{usd(r.totals.recoveryOwedUsdCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
