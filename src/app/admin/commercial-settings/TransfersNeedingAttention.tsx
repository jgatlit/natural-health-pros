import { prisma } from '@/lib/prisma';
import {
  UNCONFIRMED_AFTER_MS,
  findUnconfirmedTransfers,
  type LedgerTransferDb,
} from '@/lib/ledger-transfer';

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * Shares with no confirmed receipt: SENDING, or waiting for a payee who can receive money, more
 * than 30 minutes after the client's payment was recorded (recruiter and referrer ledgers alike).
 * The whop-reconcile cron returns 207 for the same rows. Read-only; empty while payouts are off.
 *
 * Before ANY manual re-send, look the transfer up in Whop (`GET /transfers?origin_id=<parent>`,
 * match `metadata.ledger_entry_id` to the row id below): if it exists, record it; only if it does
 * not exist is it safe to pay. The sweep does exactly this lookup before it re-sends.
 */
export async function TransfersNeedingAttention({ now = new Date() }: { now?: Date }) {
  const rows = await findUnconfirmedTransfers(prisma as unknown as LedgerTransferDb, { at: now });
  if (rows.length === 0) return null;
  const minutes = Math.round(UNCONFIRMED_AFTER_MS / 60_000);

  return (
    <section className="mt-10" aria-labelledby="transfers-attention-heading">
      <div className="rounded-lg border border-red-300 bg-red-50 p-4" role="alert">
        <h2 id="transfers-attention-heading" className="text-sm font-semibold text-red-900">
          {rows.length} share{rows.length === 1 ? '' : 's'} without a confirmed transfer after {minutes} minutes
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-red-900">
          The hourly sweep retries these with the same idempotence key and looks each one up in Whop before
          re-sending. A reason in the last column means the attempt was refused or could not be confirmed. To check
          by hand, look in Whop for a transfer from the parent whose <code>metadata.ledger_entry_id</code> is the row
          id; if one exists, record it, and only if none exists is it safe to pay.
        </p>
        <table className="mt-3 w-full text-left text-sm" data-testid="transfers-attention-table">
          <thead className="text-xs uppercase tracking-wide text-red-900">
            <tr>
              <th className="py-1 pr-3">Ledger</th>
              <th className="py-1 pr-3">Row</th>
              <th className="py-1 pr-3">Payee</th>
              <th className="py-1 pr-3">State</th>
              <th className="py-1 pr-3">Amount</th>
              <th className="py-1 pr-3">Attempts</th>
              <th className="py-1 pr-3">Last error</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.ledger}:${r.id}`} className="border-t border-red-200">
                <td className="py-1 pr-3">{r.ledger}</td>
                <td className="py-1 pr-3 font-mono text-xs">{r.id}</td>
                <td className="py-1 pr-3 font-mono text-xs">{r.payeeId}</td>
                <td className="py-1 pr-3">{r.state}</td>
                <td className="py-1 pr-3">{usd(r.amountUsdCents)}</td>
                <td className="py-1 pr-3">{r.attempts}</td>
                <td className="py-1 pr-3 text-xs">{r.lastError ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
