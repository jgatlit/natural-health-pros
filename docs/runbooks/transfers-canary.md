# Share transfers: the canary, the switches, and what an operator does

Referral and recruiter shares move to the payee's Whop balance by an internal transfer when the client's
payment clears. This is the runbook for turning that on safely. Nothing here is automatic: every switch is
set by the operator, in this order. Transfers are OFF in production: no switch below is set until Whop
business verification of the parent company is complete and Step 0 has been read. The rules these switches
guard are summarised in [`docs/money-model.md`](../money-model.md).

## The switches

| Variable | Meaning | Default |
|---|---|---|
| `WHOP_TRANSFERS_ENABLED` | Exactly `true` turns transfers on. Anything else, or absent, is off and every transfer function does nothing. | absent |
| `WHOP_TRANSFERS_ALLOWLIST` | Comma-separated practitioner ids. When set, only those payees are ever transferred to. A present-but-blank value pays nobody. | absent (no restriction) |
| `WHOP_TRANSFERS_IDEMPOTENCE_VERIFIED` | Exactly `true` records that canary Step 0 proved a repeated request with the same `idempotence_key` did **not** create a second transfer. An attempt with an unknown outcome is then re-sent with the same key, whatever the lookup says. | absent |
| `WHOP_TRANSFERS_LOOKUP_VERIFIED` | Exactly `true` records that canary Step 0 proved `GET /transfers` **finds our known canary transfer by its metadata**. A lookup that finds nothing, after reaching the end of the list, then counts as "it did not go out" and allows the re-send. | absent |

The two proofs are independent facts and are set from two different results. Setting
`WHOP_TRANSFERS_LOOKUP_VERIFIED` means an empty answer from the transfer list is believed from then on: the
canary looks up once, seconds after creating the transfer, and measures nothing about list lag, about the
`created_after` filter, or about paging on a long list. Set it only when you accept that.

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
  transfer? `false` means the repeat returned the same transfer and the body key is honoured. `true` means
  $2.00 moved and it is not.
- `lookupFoundFirst`: `true` means the list returned our metadata and the known transfer was found by it.
  `null` with a `lookupError` means the list could not answer (unexpected envelope, rows without a
  `metadata` field, a full page it could not page past).
- `observedFeeUsd`: parent decrease minus sibling increase (documented only; no fee is modelled anywhere).
- `recommendedFlags`: the table below, applied.

## Decision table

| `repeatCreatedSecondTransfer` | `lookupFoundFirst` | Set | What an unknown outcome does afterwards |
|---|---|---|---|
| `false` (key honoured) | `true` | both flags | Looked up first; a found transfer settles the row; otherwise re-sent with the same key. |
| `false` | `false` / `null` | `WHOP_TRANSFERS_IDEMPOTENCE_VERIFIED` only | Looked up first; a found transfer settles the row; otherwise re-sent with the same key. |
| `true` (key IGNORED) | `true` | `WHOP_TRANSFERS_LOOKUP_VERIFIED` only | Looked up first; a found transfer settles the row; re-sent only when the lookup reaches the end of the list without finding it; a lookup that cannot answer keeps the row retrying with backoff. |
| `true` (key IGNORED) | `false` / `null` (lookup BLIND) | **neither** | Never re-sent. The row is flagged and waits for an admin. |
| `null` (first transfer failed) | any | neither | Re-run the canary; do not enable for everyone. |

If the key is ignored and the lookup is blind, leave both flags unset: that is the safe state, and the
admin decision below resolves each ambiguous row by hand.

## Step 1: one real cleared payment, restricted to one payee

Set `WHOP_TRANSFERS_ENABLED=true` and `WHOP_TRANSFERS_ALLOWLIST=<the recruiter's practitioner id>` together and
redeploy. The payment webhook sends the share in the same run; the hourly `whop-reconcile` cron is the retry
backstop. Remove the allowlist only when going live for everyone.

## When a row needs a person

An attempt that ends with an unknown outcome (timeout, network error, 5xx after the request was sent, a success
status with no transfer id) while neither flag permits a re-send is not retried. The row is flagged
`ambiguous-unverified`, the cron returns 207 naming it, and it appears at the top of `/admin/commercial-settings`.
A row that is retrying under a lookup that keeps failing is listed there too once it is 30 minutes old, and can be
resolved the same way. Look in Whop for a transfer from the parent whose `metadata.ledger_entry_id` is the row id,
then use the two buttons on the row:

- **It went out (record id):** enter the Whop transfer id and what you checked. The row is settled with that id.
  An id already recorded on another ledger row is refused (and the refusal is audited).
- **It did not go out (retry):** enter what you checked. The row returns to the retry queue (made fresh again if
  nothing else could have been sent). Do this only after confirming in Whop that no such transfer exists.

Both decisions are audited on the fee ledger (who, which outcome, the reason, the transfer id). A transfer the
sweep finds in Whop settles a flagged row by itself.

Shares owed to an inactive (archived or retired) recruiter are listed on the same page for information. They stay
owed, nothing is lost, and they do not turn the cron red.
