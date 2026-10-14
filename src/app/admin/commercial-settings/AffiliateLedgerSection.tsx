import Link from 'next/link';

import { prisma } from '@/lib/prisma';
import { selectRecruiter, whereAnyRecruiter } from '@/lib/recruiter';
import { summarizeEntries, type LedgerAmounts, type LedgerTotals } from '@/lib/affiliate-earnings';
import { STUCK_SENDING_AFTER_MS } from '@/lib/affiliate-payouts';

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
        id: true,
        lastError: true,
        updatedAt: true,
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
  // Rows the sweep will never touch again: a transfer claimed and possibly sent with no receipt
  // (SENDING for over an hour), or parked after a failure that could not be proven harmless (HELD).
  const stuck = entries.filter(
    (e) =>
      e.state === 'HELD' ||
      (e.state === 'SENDING' && e.updatedAt.getTime() <= now.getTime() - STUCK_SENDING_AFTER_MS),
  );
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
        ledger&apos;s, net of refunds. Payouts are net of Whop&apos;s transfer fee.{' '}
        {!transfersOn && <strong>Payouts are off (WHOP_TRANSFERS_ENABLED is not true): nothing has been paid.</strong>}
      </p>

      {stuck.length > 0 && (
        <div className="mt-4 rounded-lg border border-red-300 bg-red-50 p-4" role="alert">
          <h3 className="text-sm font-semibold text-red-900">
            {stuck.length} payout row{stuck.length === 1 ? '' : 's'} need a person
          </h3>
          <p className="mt-1 text-sm leading-relaxed text-red-900">
            The sweep will not touch these again. Before ANY manual release or re-send, look the transfer up in
            Whop (<code>GET /transfers?origin_id=&lt;parent&gt;</code>, match <code>metadata.affiliate_ledger_entry_id</code>
            to the row id below): if it exists, record it; only if it does not exist is it safe to pay.
          </p>
          <table className="mt-3 w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-red-900">
              <tr>
                <th className="py-1 pr-3">Row</th>
                <th className="py-1 pr-3">Recruiter</th>
                <th className="py-1 pr-3">State</th>
                <th className="py-1 pr-3">Amount</th>
                <th className="py-1 pr-3">Since</th>
                <th className="py-1 pr-3">Last error</th>
              </tr>
            </thead>
            <tbody>
              {stuck.map((e) => (
                <tr key={e.id} className="border-t border-red-200">
                  <td className="py-1 pr-3 font-mono text-xs">{e.id}</td>
                  <td className="py-1 pr-3">
                    {person.get(e.recruiterPractitionerId)?.displayName || e.recruiterPractitionerId}
                  </td>
                  <td className="py-1 pr-3">{e.state}</td>
                  <td className="py-1 pr-3">
                    {usd(e.transferUsdCents ?? Math.max(0, e.shareUsdCents - e.reversedUsdCents))}
                  </td>
                  <td className="py-1 pr-3">{e.updatedAt.toISOString().slice(0, 16).replace('T', ' ')}</td>
                  <td className="py-1 pr-3 text-xs">{e.lastError ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
