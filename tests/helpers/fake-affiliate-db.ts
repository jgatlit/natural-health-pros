/* eslint-disable @typescript-eslint/no-explicit-any */
import { fakeLedgerDb, type Entry, type FakeLedgerDb, type Wallet } from './fake-ledger-db';

export type { Entry };

/**
 * The recruiter-ledger view of `fakeLedgerDb` (see there for what the fake honours): `rows` and
 * `adjustments` are the affiliate ledger's, and the delegates are the shared ones.
 */
export function fakeAffiliateDb(
  opts: {
    practitioners?: Record<string, Wallet>;
    entries?: Entry[];
    adjustments?: Entry[];
  } = {},
) {
  const db = fakeLedgerDb({
    practitioners: opts.practitioners,
    affiliate: { entries: opts.entries, adjustments: opts.adjustments },
  });
  return Object.assign(db, { rows: db.affiliateRows, adjustments: db.affiliateAdjustments }) as FakeLedgerDb & {
    rows: Entry[];
    adjustments: Entry[];
  };
}
