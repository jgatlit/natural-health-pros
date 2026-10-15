# Share transfers: the canary, the switches, and what an operator does

Referral and recruiter shares move to the payee's Whop balance by an internal transfer when the client's
payment clears. This is the runbook for turning that on safely. Nothing here is automatic: every switch is
set by the operator, in this order.

## The switches

| Variable | Meaning | Default |
|---|---|---|
| `WHOP_TRANSFERS_ENABLED` | Exactly `true` turns transfers on. Anything else, or absent, is off and every transfer function does nothing. | absent |
| `WHOP_TRANSFERS_ALLOWLIST` | Comma-separated practitioner ids. When set, only those payees are ever transferred to. A present-but-blank value pays nobody. | absent (no restriction) |
| `WHOP_TRANSFERS_IDEMPOTENCE_VERIFIED` | Exactly `true` records that the canary proved Whop's duplicate protection. Until then an attempt with an unknown outcome is never re-sent. | absent |

## Step 0: one direct $1.00 transfer (no application code in the loop)

Precondition: Whop business verification of the parent company is complete.

```
WHOP_COMPANY_API_KEY=... WHOP_PARENT_COMPANY_ID=biz_... \
  npx tsx scripts/whop-canary-transfer.ts --to biz_<a sibling company you own>          # dry run
CANARY_CONFIRM=<today UTC, YYYY-MM-DD> ... --go                                            # sends
```

The script refuses unless `--to` is a connected account of the parent. It sends one $1.00 transfer with
`idempotence_key` and `metadata {canary:'step0'}` in the body, sends the identical request again, looks the
transfer up with `GET /transfers`, and reads both balances before and after. Read the JSON report:

- `idempotenceVerdict` / `repeatCreatedSecondTransfer`: did the second identical request create a second
  transfer? `false` means the body key is honoured. `true` means $2.00 moved and it is not.
- `lookupFoundFirst`: `true` means the list returns our metadata and a transfer can be found by it.
  `null` with a `lookupError` means the list could not answer (unexpected envelope, or rows without a
  `metadata` field).
- `observedFeeUsd`: parent decrease minus sibling increase (documented only; no fee is modelled anywhere).

**Set `WHOP_TRANSFERS_IDEMPOTENCE_VERIFIED=true` only if `repeatCreatedSecondTransfer` is `false` or
`lookupFoundFirst` is `true`.** If neither holds, leave it unset and escalate before enabling for everyone.

## Step 1: one real cleared payment, restricted to one payee

Set `WHOP_TRANSFERS_ENABLED=true` and `WHOP_TRANSFERS_ALLOWLIST=<the recruiter's practitioner id>` together and
redeploy. The payment webhook sends the share in the same run; the hourly `whop-reconcile` cron is the retry
backstop. Remove the allowlist only when going live for everyone.

## When a row needs a person

An attempt that ends with an unknown outcome (timeout, network error, 5xx after the request was sent) while
`WHOP_TRANSFERS_IDEMPOTENCE_VERIFIED` is not `true` is not retried. The row is flagged `ambiguous-unverified`,
the cron returns 207 naming it, and it appears at the top of `/admin/commercial-settings`. Look in Whop for a
transfer from the parent whose `metadata.ledger_entry_id` is the row id, then use the two buttons on the row:

- **It went out (record id):** enter the Whop transfer id and what you checked. The row is settled with that id.
- **It did not go out (retry):** enter what you checked. The row returns to the retry queue (made fresh again if
  nothing else could have been sent). Do this only after confirming in Whop that no such transfer exists.

Both decisions are audited on the fee ledger (who, which outcome, the reason, the transfer id). A transfer the
sweep finds in Whop settles a flagged row by itself.
