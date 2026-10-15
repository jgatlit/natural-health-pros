/* eslint-disable @typescript-eslint/no-explicit-any */
import type { LookupFn, TransferFn } from '@/lib/ledger-transfer';

/**
 * A fake Whop transfers API with a store of the transfers it holds, for the cases where Whop does not
 * behave as the code would like. Every knob is a way the real API might differ:
 *
 *   honourKey         a second POST with the same `idempotence_key` returns the first transfer
 *                     instead of creating another.
 *   listShows         what the transfer LIST can do for a lookup:
 *                       'metadata'   returns rows with our metadata (a lookup can find and rule out)
 *                       'no-metadata' returns rows without the metadata field (metadata not returned)
 *                       'bad-envelope' answers with an envelope the code does not recognise
 *   afterCreate       the next POST creates the transfer and THEN fails (a timeout or a 502 after the
 *                     transfer exists), the shape of every ambiguous outcome.
 *
 * `transfers` is what Whop holds: its length is the number of times the payee was paid.
 */
export function fakeWhop(
  opts: {
    honourKey?: boolean;
    listShows?: 'metadata' | 'no-metadata' | 'bad-envelope';
    afterCreate?: Array<'timeout' | 'bad-gateway'>;
  } = {},
) {
  const honourKey = opts.honourKey ?? false;
  const listShows = opts.listShows ?? 'metadata';
  const afterCreate = [...(opts.afterCreate ?? [])];
  const transfers: Array<{ id: string; amountUsdDollars: number; key: string | null; metadata: Record<string, string> | null }> = [];
  let posts = 0;
  let n = 0;

  const transfer: TransferFn = async (args) => {
    posts += 1;
    if (honourKey && args.idempotenceKey) {
      const existing = transfers.find((t) => t.key === args.idempotenceKey);
      if (existing) return { transferId: existing.id };
    }
    const created = {
      id: `wt_${++n}`,
      amountUsdDollars: args.amountUsdDollars,
      key: args.idempotenceKey ?? null,
      metadata: args.metadata ?? null,
    };
    transfers.push(created);
    const fail = afterCreate.shift();
    if (fail === 'timeout') throw new Error('The operation was aborted due to timeout');
    if (fail === 'bad-gateway') throw new Error('Whop /transfers failed (502): bad gateway');
    return { transferId: created.id };
  };

  const lookup: LookupFn = async (a) => {
    if (listShows === 'bad-envelope') {
      return { kind: 'unknown', reason: 'the transfer list did not have the expected { data: [...] } envelope' };
    }
    if (listShows === 'no-metadata' && transfers.length > 0) {
      return { kind: 'unknown', reason: 'the transfer list rows carry no metadata field, so a transfer cannot be matched by metadata' };
    }
    const hit = transfers.find((t) => t.metadata?.ledger_entry_id === a.ledgerEntryId);
    return hit ? { kind: 'found', transferId: hit.id, amountUsdDollars: hit.amountUsdDollars } : { kind: 'not-found' };
  };

  return {
    transfers,
    transfer,
    lookup,
    get posts() {
      return posts;
    },
    get totalCents() {
      return transfers.reduce((s, t) => s + Math.round(t.amountUsdDollars * 100), 0);
    },
  };
}
