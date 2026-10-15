import { prisma } from '@/lib/prisma';
import { resolveTransferAttentionAction } from './actions';
import {
  UNCONFIRMED_AFTER_MS,
  findUnconfirmedTransfers,
  type LedgerTransferDb,
  type UnconfirmedReason,
} from '@/lib/ledger-transfer';

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

const REASON_LABEL: Record<UnconfirmedReason, string> = {
  'needs-attention': 'Outcome unknown: decide',
  sending: 'Attempt in flight or lost',
  waiting: 'Not yet transferred',
  'payee-inactive': 'Recruiter inactive: nothing will move until reinstated',
  'payee-unpayable': 'Transfer claimed; payee can no longer receive money',
};

/**
 * Shares with no confirmed receipt (recruiter and referrer ledgers alike):
 *   - waiting for a person: an attempt ended with an unknown outcome and the transfer lookup is not
 *     verified (`WHOP_TRANSFERS_IDEMPOTENCE_VERIFIED`), so it is never retried on its own. The admin
 *     looks in Whop for a transfer from the parent whose `metadata.ledger_entry_id` is the row id and
 *     records "it went out (transfer id)" or "it did not go out";
 *   - SENDING or waiting for a payee who can receive money, more than 30 minutes after the client's
 *     payment was recorded; waiting for an inactive recruiter; or claimed for a payee who can no
 *     longer receive money.
 * The whop-reconcile cron returns 207 for the same rows. Empty while payouts are off. The only writes
 * are the audited server action; nothing here sends money.
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
          id; if one exists, record it, and only if none exists is it safe to pay. Refund balances are netted within
          a ledger: a recruiter debit comes off recruiter transfers and a referrer debit off referrer transfers.
        </p>
        <table className="mt-3 w-full text-left text-sm" data-testid="transfers-attention-table">
          <thead className="text-xs uppercase tracking-wide text-red-900">
            <tr>
              <th className="py-1 pr-3">Ledger</th>
              <th className="py-1 pr-3">Row</th>
              <th className="py-1 pr-3">Payee</th>
              <th className="py-1 pr-3">Why</th>
              <th className="py-1 pr-3">State</th>
              <th className="py-1 pr-3">Amount</th>
              <th className="py-1 pr-3">Attempts</th>
              <th className="py-1 pr-3">Last error</th>
              <th className="py-1 pr-3">Decide</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.ledger}:${r.id}`} className="border-t border-red-200">
                <td className="py-1 pr-3">{r.ledger}</td>
                <td className="py-1 pr-3 font-mono text-xs">{r.id}</td>
                <td className="py-1 pr-3 font-mono text-xs">{r.payeeId}</td>
                <td className="py-1 pr-3">{REASON_LABEL[r.reason]}</td>
                <td className="py-1 pr-3">{r.state}</td>
                <td className="py-1 pr-3">{usd(r.amountUsdCents)}</td>
                <td className="py-1 pr-3">{r.attempts}</td>
                <td className="py-1 pr-3 text-xs">{r.lastError ?? ''}</td>
                <td className="py-1 pr-3 text-xs">
                  {r.reason === 'needs-attention' ? (
                    <div className="space-y-2">
                      <form action={resolveTransferAttentionAction} className="space-y-1">
                        <input type="hidden" name="ledger" value={r.ledger} />
                        <input type="hidden" name="rowId" value={r.id} />
                        <input type="hidden" name="outcome" value="went-out" />
                        <input name="transferId" required placeholder="Whop transfer id" className="w-full rounded border border-red-300 px-1 py-0.5" />
                        <input name="reason" required minLength={3} placeholder="What you checked" className="w-full rounded border border-red-300 px-1 py-0.5" />
                        <button type="submit" className="rounded bg-red-900 px-2 py-0.5 text-white">It went out (record id)</button>
                      </form>
                      <form action={resolveTransferAttentionAction} className="space-y-1">
                        <input type="hidden" name="ledger" value={r.ledger} />
                        <input type="hidden" name="rowId" value={r.id} />
                        <input type="hidden" name="outcome" value="did-not-go-out" />
                        <input name="reason" required minLength={3} placeholder="What you checked" className="w-full rounded border border-red-300 px-1 py-0.5" />
                        <button type="submit" className="rounded border border-red-900 px-2 py-0.5 text-red-900">It did not go out (retry)</button>
                      </form>
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
