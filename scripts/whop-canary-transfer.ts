/**
 * STEP 0 OF THE FIRST REAL TRANSACTION: one direct $1.00 parent -> sibling transfer, measured.
 *
 * It answers, with real money and no application code in the loop:
 *   Q2  does an internal Whop-to-Whop transfer carry any fee?
 *       observed fee = parent balance decrease - sibling balance increase
 *   Q3  does POST /transfers honour `idempotence_key` and `metadata`?
 *       the SAME request is posted twice; the report says whether the repeat created a second
 *       transfer, and whether GET /transfers finds the transfer by its metadata.
 *
 * DRY RUN BY DEFAULT. Without `--go` it prints exactly what it would do and sends NOTHING: no
 * request of any kind leaves the process.
 *
 * TO SEND (moves $1.00 of real money, once, plus $1.00 more if Whop ignores the idempotence key):
 *
 *   WHOP_COMPANY_API_KEY=... WHOP_PARENT_COMPANY_ID=biz_... CANARY_CONFIRM=<today UTC, YYYY-MM-DD> \
 *     npx tsx scripts/whop-canary-transfer.ts --to biz_<a sibling company you own> --go
 *
 * It reads the key from the same environment variables the app uses (WHOP_COMPANY_API_KEY,
 * WHOP_PARENT_COMPANY_ID, and WHOP_API_BASE when set). It never reads an env file; export the
 * variables in the shell. It is plain TypeScript with no database access.
 *
 * It goes through the SAME `createTransfer` the app uses, so the request it makes is the request the
 * payment webhook will make (dollars on the wire, `idempotence_key` and `metadata` in the body; there
 * is no other duplicate-protection mechanism, so the repeat answers exactly one question: does the
 * body key stop a second identical request from creating a second transfer?).
 *
 * Before anything is sent it reads the `--to` company (read-only GET) and refuses unless it is a
 * connected account (sibling) of the configured parent company.
 *
 * WHAT TO DO WITH THE REPORT (the switch the operator sets afterwards):
 *   `WHOP_TRANSFERS_IDEMPOTENCE_VERIFIED=true` only if `repeatCreatedSecondTransfer` is false (the key
 *   is honoured) OR `lookupFoundFirst` is true (the metadata lookup finds a transfer). Until it is set,
 *   a transfer attempt that ends with an unknown outcome is never re-sent: the row waits for an admin
 *   to record whether it went out (/admin/commercial-settings).
 *
 * Balances are read from `GET /ledger_accounts/{id}`. If Whop does not accept the company id there,
 * the report records the error for that read and still reports the transfer and lookup answers;
 * the balances can then be read from the Whop dashboard for the fee calculation.
 */

import { randomBytes } from 'node:crypto';

import {
  createTransfer,
  findTransfer,
  getAccountBalanceUsd,
  isConnectedAccountOfParent,
  type WhopTransferRecord,
} from '../src/lib/whop';

export const CANARY_AMOUNT_USD = 1;
export const CANARY_METADATA = { canary: 'step0' } as const;

type Balance = { balanceUsd: number; pendingUsd: number } | { error: string };

export type CanaryDeps = {
  transfer: typeof createTransfer;
  find: typeof findTransfer;
  balance: typeof getAccountBalanceUsd;
  /** Read-only: is this company a connected account of the configured parent? */
  isSibling: typeof isConnectedAccountOfParent;
};

const realDeps: CanaryDeps = {
  transfer: createTransfer,
  find: findTransfer,
  balance: getAccountBalanceUsd,
  isSibling: isConnectedAccountOfParent,
};

export type CanaryReport = {
  mode: 'go';
  startedAt: string;
  parent: string;
  sibling: string;
  amountUsd: number;
  idempotenceKey: string;
  balancesBefore: { parent: Balance; sibling: Balance };
  firstTransferId: string | null;
  firstError: string | null;
  repeatTransferId: string | null;
  repeatError: string | null;
  /** Q3: true means the idempotence key was NOT honoured and $2.00 moved. */
  repeatCreatedSecondTransfer: boolean | null;
  /** Q3: whether GET /transfers (filtered client-side on the metadata) found the first transfer. */
  lookupFoundFirst: boolean | null;
  /** Why the list could not answer (unexpected envelope, no metadata on its rows) or the request failed. */
  lookupError: string | null;
  /** Q3 in one line, without interpretation: did the second identical request create a second transfer? */
  idempotenceVerdict: string;
  /** The transfer record's own fee field, when Whop returns it. */
  transferRecord: { amountUsd: number; feeAmountUsd: number | null; metadata: Record<string, unknown> | null } | null;
  balancesAfter: { parent: Balance; sibling: Balance };
  /** Q2: parent decrease - sibling increase, in dollars. Null when a balance could not be read. */
  parentDecreaseUsd: number | null;
  siblingIncreaseUsd: number | null;
  observedFeeUsd: number | null;
  note: string;
};

export type CanaryResult =
  | { kind: 'dry-run'; plan: string[] }
  | { kind: 'refused'; reason: string }
  | { kind: 'done'; report: CanaryReport; exitCode: number };

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function parseArgs(argv: string[]): { go: boolean; to: string | null } {
  const toIdx = argv.indexOf('--to');
  return { go: argv.includes('--go'), to: toIdx >= 0 ? (argv[toIdx + 1] ?? null) : null };
}

const SIBLING_RE = /^biz_[A-Za-z0-9]+$/;

export async function runCanary(opts: {
  argv: string[];
  env: Record<string, string | undefined>;
  now: Date;
  deps?: CanaryDeps;
}): Promise<CanaryResult> {
  const deps = opts.deps ?? realDeps;
  const { go, to } = parseArgs(opts.argv);
  const parent = opts.env.WHOP_PARENT_COMPANY_ID ?? '';
  const today = opts.now.toISOString().slice(0, 10);

  if (!to || !SIBLING_RE.test(to)) {
    return { kind: 'refused', reason: 'pass --to biz_... (a sibling company you own) as the destination' };
  }
  if (!opts.env.WHOP_COMPANY_API_KEY || !parent) {
    return { kind: 'refused', reason: 'WHOP_COMPANY_API_KEY and WHOP_PARENT_COMPANY_ID must be set in the environment' };
  }
  if (to === parent) {
    return { kind: 'refused', reason: '--to must be a sibling, not the parent company itself' };
  }

  const key = `canary-step0-${today}-${randomBytes(4).toString('hex')}`;

  if (!go) {
    return {
      kind: 'dry-run',
      plan: [
        `DRY RUN: nothing is sent. Re-run with --go and CANARY_CONFIRM=${today} to perform these steps:`,
        `0. GET /companies/${to} (read-only) and refuse unless it is a connected account of ${parent}`,
        `1. GET /ledger_accounts/${parent} and /ledger_accounts/${to} (balances before)`,
        `2. POST /transfers  origin ${parent} -> destination ${to}  amount $${CANARY_AMOUNT_USD.toFixed(2)}  idempotence_key ${key}  metadata ${JSON.stringify(CANARY_METADATA)}`,
        `3. POST /transfers  the SAME request again (same idempotence_key); record whether a second transfer is created`,
        `4. GET /transfers?origin_id=${parent}&destination_id=${to}  and look for metadata ${JSON.stringify(CANARY_METADATA)}`,
        `5. GET /ledger_accounts/${parent} and /ledger_accounts/${to} (balances after)`,
        `6. print a JSON report: transfer ids, whether the repeat created a second transfer, whether the lookup found it, observed fee = parent decrease - sibling increase`,
      ],
    };
  }

  if (opts.env.CANARY_CONFIRM !== today) {
    return {
      kind: 'refused',
      reason: `--go needs CANARY_CONFIRM=${today} (today's date, UTC) in the environment; nothing was sent`,
    };
  }

  let sibling: boolean;
  try {
    sibling = await deps.isSibling(to);
  } catch (e) {
    return { kind: 'refused', reason: `could not verify that ${to} is a connected account of ${parent}: ${msg(e)}; nothing was sent` };
  }
  if (!sibling) {
    return { kind: 'refused', reason: `${to} is not a connected account (sibling) of ${parent}; nothing was sent` };
  }

  const readBalance = async (id: string): Promise<Balance> => {
    try {
      return await deps.balance(id);
    } catch (e) {
      return { error: msg(e) };
    }
  };

  const startedAt = opts.now;
  const balancesBefore = { parent: await readBalance(parent), sibling: await readBalance(to) };

  const request = {
    originId: parent,
    destinationId: to,
    amountUsdDollars: CANARY_AMOUNT_USD,
    metadata: { ...CANARY_METADATA },
    idempotenceKey: key,
  };

  let firstTransferId: string | null = null;
  let firstError: string | null = null;
  try {
    firstTransferId = (await deps.transfer(request)).transferId;
  } catch (e) {
    firstError = msg(e);
  }

  let repeatTransferId: string | null = null;
  let repeatError: string | null = null;
  if (firstTransferId) {
    try {
      repeatTransferId = (await deps.transfer(request)).transferId;
    } catch (e) {
      repeatError = msg(e);
    }
  }

  let lookupFoundFirst: boolean | null = null;
  let lookupError: string | null = null;
  let record: WhopTransferRecord | null = null;
  if (firstTransferId) {
    try {
      const result = await deps.find({
        originId: parent,
        destinationId: to,
        createdAfter: new Date(startedAt.getTime() - 60_000),
        match: (t) => t.metadata?.canary === CANARY_METADATA.canary && t.id === firstTransferId,
      });
      if (result.kind === 'found') {
        record = result.transfer;
        lookupFoundFirst = true;
      } else if (result.kind === 'not-found') {
        lookupFoundFirst = false;
      } else {
        lookupError = result.reason;
      }
    } catch (e) {
      lookupError = msg(e);
    }
  }

  const balancesAfter = { parent: await readBalance(parent), sibling: await readBalance(to) };

  const diff = (before: Balance, after: Balance, sign: 1 | -1): number | null =>
    'error' in before || 'error' in after ? null : Math.round(sign * (after.balanceUsd - before.balanceUsd) * 100) / 100;
  const parentDecreaseUsd = diff(balancesBefore.parent, balancesAfter.parent, -1);
  const siblingIncreaseUsd = diff(balancesBefore.sibling, balancesAfter.sibling, 1);

  const repeatCreatedSecondTransfer =
    firstTransferId && repeatTransferId ? repeatTransferId !== firstTransferId : null;
  const idempotenceVerdict =
    repeatCreatedSecondTransfer === true
      ? `The second identical request (same idempotence_key) created a SECOND transfer (${repeatTransferId}): $${(CANARY_AMOUNT_USD * 2).toFixed(2)} moved and the key is NOT honoured.`
      : repeatCreatedSecondTransfer === false
        ? `The second identical request (same idempotence_key) returned the SAME transfer (${firstTransferId}) and created no second transfer: the key is honoured.`
        : repeatError
          ? `The second identical request was rejected (${repeatError}); no second transfer was created, which does not by itself show the key is honoured.`
          : 'The first transfer did not complete, so the repeat was not made and nothing is known about the key.';

  const report: CanaryReport = {
    mode: 'go',
    startedAt: startedAt.toISOString(),
    parent,
    sibling: to,
    amountUsd: CANARY_AMOUNT_USD,
    idempotenceKey: key,
    balancesBefore,
    firstTransferId,
    firstError,
    repeatTransferId,
    repeatError,
    repeatCreatedSecondTransfer,
    lookupFoundFirst,
    lookupError,
    idempotenceVerdict,
    transferRecord: record
      ? { amountUsd: record.amount, feeAmountUsd: record.feeAmount, metadata: record.metadata }
      : null,
    balancesAfter,
    parentDecreaseUsd,
    siblingIncreaseUsd,
    observedFeeUsd:
      parentDecreaseUsd !== null && siblingIncreaseUsd !== null
        ? Math.round((parentDecreaseUsd - siblingIncreaseUsd) * 100) / 100
        : null,
    note:
      'Balances move with other activity on either account while this runs; read observedFeeUsd together with ' +
      'the two transfer amounts (a second transfer doubles both sides). A repeat that returned the SAME id means the ' +
      'idempotence key was honoured; a different id means $2.00 moved and the key was ignored.',
  };

  return { kind: 'done', report, exitCode: firstError ? 1 : 0 };
}

async function main(): Promise<void> {
  const result = await runCanary({ argv: process.argv.slice(2), env: process.env, now: new Date() });
  if (result.kind === 'dry-run') {
    for (const line of result.plan) console.log(line);
    return;
  }
  if (result.kind === 'refused') {
    console.error(`REFUSED: ${result.reason}`);
    process.exit(2);
  }
  console.log(JSON.stringify(result.report, null, 2));
  process.exit(result.exitCode);
}

if (process.argv[1] && /whop-canary-transfer\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(msg(e));
    process.exit(1);
  });
}
