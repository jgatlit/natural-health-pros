# Plan A/B onboarding + leakage attribution — design notes (2026-09-17)

> Status: **proposal, not built.** Prices and splits remain Amy's decision; everything here is
> parameterised through `src/lib/pricing-plans.ts`.

## 1. Split-checkout test — SETTLED (validated 2026-09-17)

Payment `pay_JOaWdCx7xc37VJ` on Sarah's connected account `biz_xExE1eUWG4ZMeR`:
`status: paid` / `substatus: succeeded`, paid 21:15:04 UTC, amex ••6006, checkout configuration
`ch_xTtPtLPZBLvT8Vo`, plan `plan_fg9PBQdmRsCpX`, metadata carried `practitioner_id` intact.

| | |
|---|---|
| Gross | $10.00 |
| Sarah's `amount_after_fees` | **$4.28** |
| Implied platform application fee | $5.00 (the configured 50%) |
| Implied Whop/processing | ~$0.72 |
| `settlement_time_at` | **2026-09-21** |

**The practitioner side is proven.** The 50% came off the top exactly as configured.

**The platform side is NOT yet observable.** `GET /payments?account_id=<parent>`, `/transfers`,
and `/payouts` on the parent all return empty, and `/balances` 403s (`member:payment_methods:read`
not on the company key). Funds are held until the 2026-09-21 settlement date, so this is expected
rather than wrong — **re-check on or after 2026-09-21** before claiming the fee landed.

⚠️ This bears directly on the "full visibility over totals" claim made to Amy on 09-14. Today the
parent key can read every child's *payments* (that part is true), but it cannot read a parent
*balance* without an extra scope, and the fee credit is not yet visible anywhere. Do not restate
the claim as fact until the 09-21 re-check.

Also note: `GET /payments?company_id=…` is rejected — `account_id` is the filter, the same
naming trap as `/checkout_configurations`.

## 2. Plan B leakage — mitigation options

The open question from 09-14: nothing stops a Plan B practitioner taking a platform-sourced client
off-platform after the first session. Jonathan's proposal (2026-09-17) is **email-match attribution
with a 1-year window**: a client email captured from NHP-driven traffic is compared against the
practitioner's Whop account transactions, so a later private rebooking of a known NHP-sourced
client is detectable.

Ranked by cost/benefit:

1. **Attribution ledger + 12-month claim window (recommended core).** Persist an
   `AttributedClient` row the moment an NHP-sourced checkout completes: practitioner, buyer email
   (hashed + normalised), source channel, `attributedAt`, `expiresAt = +1y`. This is cheap, and
   we already receive the buyer email on the payment object and on the webhook.
2. **Reconciliation sweep against child-account payments.** A scheduled job walks
   `GET /payments?account_id=<child>` for every connected account and flags any payment whose buyer
   email matches a live attribution row but which carries no `booking_intent_id` metadata — i.e. a
   private rebooking of an NHP-sourced client. Reuses the existing `whop-reconcile` machinery.
   This is the piece that makes option 1 enforceable rather than decorative.
   Caveat: it only sees money that moves **through Whop**. Cash, Venmo, or a second processor are
   invisible. That is a real ceiling and should be stated to Amy rather than papered over.
3. **Make the honest path the easy path.** Practitioner-facing framing: rebooking through the
   platform is one click and keeps their calendar/receipts in one place. Cheapest mitigation per
   unit of effort, and consistent with the "launch pad, after that they're yours" positioning.
4. **Contractual, not technical.** The Plan B terms state the 12-month attribution and that
   platform-sourced clients rebooked privately within it still owe the first-session split. Pairs
   with option 2 as the evidence base. Needs a terms edit, which is Amy's call.
5. **Rejected: hiding client contact details.** Unworkable on a health directory — practitioner
   and client must be able to talk — and it would damage the consumer experience that the
   consumer-first GTM depends on.

**Deliberately NOT recommended:** auto-charging or auto-penalising on a match. Email matching has
false positives (shared household addresses, a client the practitioner already had). Flag for human
review; never move money on a heuristic.

## 3. Plan choice in onboarding — insertion point

Current flow: invite → `/onboarding` (single server page, `OnboardingForm`, invitation-gated) →
`/practitioners/[slug]/edit` → publish + accept payments (consolidated into one step, PR #111).

Recommendation: **a dedicated step between profile submit and the Whop connect step**, not a field
inside the profile form.

- Both plans require a Whop account, so plan choice must come *before* the connect step — the
  chosen plan determines whether a Layer X subscription checkout is also minted.
- It is a commercial decision, not profile content. Burying a pricing commitment among bio fields
  is how people later say they didn't agree to it.
- A separate step is the natural place for Amy's break-even guidance ("above ~$150/mo of
  platform-sourced business, Plan A is the better deal"), which is the single most persuasive thing
  said on the 09-14 call and belongs in the UI.

Shape:
- Two cards side by side (stacked on mobile), no "recommended" badge — Amy was explicit that these
  are choices, not tiers. Equal visual weight; Theme D, existing Card/Button primitives.
- Each card renders its numbers from `practitionerPlans()`. No literal prices in JSX, ever.
- A small interactive break-even line: "at $X/mo of platform-sourced bookings you'd pay $A vs $B".
- Plan is changeable later from the dashboard; say so on the card. Reduces the stall.

Schema (expand/contract — add now, nothing dropped):
```prisma
plan            String?   // 'PLAN_A' | 'PLAN_B'; null = not yet chosen (pre-existing practitioners)
planChosenAt    DateTime?
```
String, not an enum, for the same reason `whopPayoutStatus` is a String: a third plan must not
throw inside a webhook. `null` is meaningful — the 14 already-listed practitioners have not
chosen, and the migration must not silently assign them one. Backfill is an outreach task Sarah
owns, not a default value.

Fee wiring: `createBookingCheckoutConfig` derives `applicationFeeCents` from
`platformFeeCents({ plan, priceUsdCents, isFirstSession })`. `isFirstSession` is answered by the
attribution ledger in §2 — which is why §2 and §3 should ship together rather than in sequence.

## Shipped 2026-09-18

- **Ledger**: `AttributedClient` (hashed email, one claim per practitioner+client, 1-year window
  via `ATTRIBUTION_CLAIM_WINDOW_DAYS`). `src/lib/attributed-clients.ts`, 12 tests.
- **Plan columns**: `Practitioner.plan` / `planChosenAt`, nullable, no default, no backfill.
- **Per-booking fee**: resolved at mint time from plan + `isFirstSession()`. ⚠️ Whop fixes
  `application_fee_amount` when a PLAN is created, so there is no account-level split switch — a
  fee-bearing booking mints its own dynamic plan on the connected account. The shared-plan path is
  kept for the zero-fee case.
- **Plan choice UI**: `PlanChoice.tsx` at the top of Premium Accounts & Directory Listing.
- **Leakage sweep**: `npm run whop:leakage`. Advisory only; blind to money outside Whop.

**Still owed by a human:** Amy decides the real prices/splits (all env-driven); Amy decides the
Plan B contractual term naming the 12-month attribution; the 14 already-listed practitioners have
`plan = null` and need an outreach pass — do NOT backfill them into a plan.
