# Money model

One page. This is the current commercial and payout behaviour of Natural Health Pros, with the file that implements each rule. The numbers below describe rate schedule v1 "Go-forward 2026-10" and are stored in the database only; never copy them into code, copy or env.

## Rates: the database is the only source

- A `RateSchedule` row (`prisma/schema.prisma`) is immutable and content-addressed: `contentHash` is the sha256 of the canonical serialisation of 11 numeric fields (`RATE_SCHEDULE_FIELDS` in `src/lib/rate-schedule.ts`, hash in `src/lib/rate-schedule-hash.ts`). The same numbers are always the same row.
- Each practitioner maps to one schedule (`Practitioner.rateScheduleId`, history in `RateScheduleAssignment`, reasons `SIGNUP | COHORT_LINK | ADMIN_MIGRATION | CUSTOM_DEAL`). New sign-ups get the schedule named by the `PlatformSetting` key `current_rate_schedule_id` (`src/lib/rate-schedules.ts`). A client's attribution row copies the schedule id and term lengths it was sold under, so a later change never reprices a term in flight.
- There are no rate env vars and no literal rate defaults. `tests/no-rate-literals.test.ts` enforces it. A practitioner with no schedule fails closed at checkout (`NoRateScheduleError` in `src/lib/rate-schedule.ts`, thrown from `resolveBookingFee` in `src/lib/booking-fee.ts`).
- Schedule v1 is seeded by `prisma/migrations/20261014150000_rate_schedules_fee_rule_v15/migration.sql`. Admins create further schedules, set the current one and migrate a cohort at `/admin/commercial-settings`.

### Schedule v1 "Go-forward 2026-10"

| Rule | Value |
|---|---|
| Plan A | $39/month, plus 10% on NHP-attributed sessions. Yearly price is derived (`annualPlanAPriceCents`): $374.40 |
| Plan B | $0/month, plus 30% on NHP-attributed sessions |
| Client referral (`nhpr`) | 30% in all: 20% to the referring practitioner plus 10% to NHP, for 4 months from the client's first payment (`referrerTermMonths`). Both plans |
| After the referral window | The plan rate, until the lead term ends |
| Lead attribution term | 8 months from the client's first payment (`leadTermMonths`); 0% after it |
| Recruiting affiliate (`nhpa`) | 3% of the gross of every payment of a recruited practitioner, indefinitely |
| Own clients (`?ref`) | 0%, always |
| Ceiling | Total fees never exceed 30% (`maxTotalFeeBps`, bounded by `PLATFORM_FEE_CEILING_BPS` in `src/lib/rate-schedule.ts`, which is not admin-editable) |

The affiliate comes out of NHP's share when NHP takes a fee on the payment; when NHP's fee is 0 it is added to the practitioner's charge. NHP never pays an affiliate out of pocket. Shares are rounded down, each independently.

The rule is `resolveSessionFee` in `src/lib/referral-fees.ts`; `resolveBookingFee` in `src/lib/booking-fee.ts` applies it to stored state when the checkout is minted and writes the `BookingFeeSnapshot`. `payment.succeeded` commits that snapshot and never recomputes it.

## Parameters

| Param | Meaning | Where |
|---|---|---|
| `?ref=` | A practitioner's own audience, 0% | `src/lib/attribution.ts` |
| `nhpr` | Client referral between practitioners; `/r/<token>` records a `ReferralTouch` then redirects with `?nhpr=` | `src/lib/referral-param.ts`, `src/app/r/[token]/route.ts` |
| `nhpa` | Recruiter of a new practitioner: `/join/<cohort>?nhpa=<recruiterToken>` | `src/lib/recruiter-cookie.ts`, `src/app/join/[cohort]/` |

Recruiter attribution comes only from the signed cookie (`nhp_rec`, stamped by `src/middleware.ts`) of the browser that redeems the sign-in link; `/onboarding` resolves it and writes `Practitioner.recruitedById` once, in the create (`src/lib/recruiter.ts`). Signing up on one device and opening the email on another records no recruiter. A fix is planned (vault task `tsk_7e75bcc931a64749a8fd`).

## Who gets paid, and when

- All internal NHP, practitioner, referral, affiliate and recruiting fees are independent of payout. They are computed on the full purchase price and moved by an internal Whop-to-Whop transfer from the parent company to the payee's Whop balance when the client's payment clears.
- Whop's own payout (withdrawal) fee is each user's matter when they withdraw. It is never reflected in a share, a ledger figure or a percentage.
- Ledgers: `ReferralLedgerEntry` (referrer share) and `AffiliateLedgerEntry` (recruiter 3%), with `ReferralBalanceAdjustment` and `AffiliateBalanceAdjustment` for refund debits, and `FeeLedgerEntry` as the append-only audit trail. Both ledgers share one transfer routine (`src/lib/ledger-transfer.ts`, bound per ledger by `src/lib/ledger-config.ts`). A row owes `share - reversedUsdCents`.
- States: `waiting` (`ACCRUED` for recruiters, `PAYABLE` for referrers) to `SENDING` to `SETTLED`. The guarded claim, the idempotence key (the ledger row id) and the lookup of unknown outcomes are described in the header of `src/lib/ledger-transfer.ts`.
- Triggers: the payment webhook (`src/app/api/whop/webhook/v1/route.ts`) settles the one row its payment accrued; the hourly `whop-reconcile` cron (`src/app/api/cron/whop-reconcile/route.ts`, schedule in `vercel.json`) retries every row without a receipt.
- Recruiter 3%: accrued at `payment.succeeded` and paid with no hold (`src/lib/affiliate-ledger.ts`, `src/lib/affiliate-payouts.ts`). It is paid only while the recruiter is active (`activePayeeOnly` in `src/lib/ledger-config.ts`; active means not archived and not retired, `bookableWhere()`), checked again at the moment of payment. The share is not dropped when a recruiter goes inactive: the row stays waiting and pays on reinstatement. The referral ledger has no such rule.
- Refunds: before the transfer is claimed, the share is reduced; after it, the refund is booked as a debit netted off the payee's next transfer, oldest first, never below zero (`src/lib/ledger-reversal.ts`, `src/lib/referral-refunds.ts`).
- `referral_hold_days` (90, `PlatformSetting`, edited at `/admin/commercial-settings`, `src/lib/platform-settings.ts`) is only the unclaimed-share window for a referrer who cannot yet receive money. The share is held, settles when they can receive, and at expiry is marked `EXPIRED_UNCLAIMED` with no automatic money action (`src/lib/referral-payouts.ts`).
- Rows without a confirmed receipt are listed under "needs attention" at `/admin/commercial-settings` (`findUnconfirmedTransfers` in `src/lib/ledger-transfer.ts`; `src/app/admin/commercial-settings/TransfersNeedingAttention.tsx`). Alert classes (they turn the cron red): `needs-attention` (a person must decide whether a transfer went out; an admin records the outcome through `src/lib/transfer-attention.ts`), `sending` (SENDING 30+ minutes after accrual), `waiting` (waiting for a payee who can receive money, 30+ minutes after accrual), `payee-unpayable` (a transfer was claimed and the payee can no longer receive money). Informational class: `payee-inactive` (a recruiter's share waiting while the recruiter is archived or retired; owed and safe, only listed).

## Flags (all in `.env.example`; transfers are off in production per a read-only check on 2026-10-14/15)

| Variable | Effect |
|---|---|
| `WHOP_TRANSFERS_ENABLED` | Exactly `true` allows transfers. Anything else, or absent: every transfer function reads, writes and calls nothing (`payoutsGuard`) |
| `WHOP_TRANSFERS_ALLOWLIST` | Comma-separated practitioner ids; only those payees are paid. Present-but-blank pays nobody |
| `WHOP_TRANSFERS_IDEMPOTENCE_VERIFIED` | Exactly `true`: canary Step 0 showed a repeated request with the same key made no second transfer |
| `WHOP_TRANSFERS_LOOKUP_VERIFIED` | Exactly `true`: canary Step 0 showed `GET /transfers` finds a known transfer by metadata |
| `REFERRAL_HOLD_DAYS` | Fallback for the unclaimed-share window when the database has no row |

## Enabling transfers safely

Nothing is enabled before Whop business verification of the parent company and the canary.

1. Complete Whop business verification of the parent company.
2. Run canary Step 0 (`scripts/whop-canary-transfer.ts`), read its report and set only the flags it recommends.
3. Run canary Step 1: `WHOP_TRANSFERS_ENABLED=true` with `WHOP_TRANSFERS_ALLOWLIST` naming one payee, one real cleared payment.
4. Remove the allowlist only when going live for everyone.

Procedure, decision table and the admin resolution of ambiguous rows: [`docs/runbooks/transfers-canary.md`](runbooks/transfers-canary.md). A real-Postgres check of the transfer engine: `scripts/verify-transfers-postgres.ts`.

## Where each rule lives

| Rule | File |
|---|---|
| Schedule fields, invariants, 30% ceiling, yearly price | `src/lib/rate-schedule.ts` |
| Canonical hash | `src/lib/rate-schedule-hash.ts` |
| Find, create, assign, migrate a cohort | `src/lib/rate-schedules.ts` |
| Fee rule for one session | `src/lib/referral-fees.ts` |
| Fee at checkout mint, snapshot | `src/lib/booking-fee.ts` |
| Term anchor and boundaries | `src/lib/attribution-term.ts` |
| Recruiter capture and read | `src/lib/recruiter.ts`, `src/lib/recruiter-cookie.ts` |
| Referral and affiliate ledgers | `src/lib/referral-settlement.ts`, `src/lib/affiliate-ledger.ts`, `src/lib/ledger-config.ts` |
| Transfer engine | `src/lib/ledger-transfer.ts` |
| Refund reversal and debit netting | `src/lib/ledger-reversal.ts`, `src/lib/referral-refunds.ts` |
| Hold setting | `src/lib/platform-settings.ts` |
| Plan labels and plan-card copy built from a schedule | `src/lib/pricing-plans.ts` |
