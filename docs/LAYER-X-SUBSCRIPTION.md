# Layer X — platform-listing subscription (LIVE)

> Practitioners pay **Natural Health Pros** a monthly subscription to be listed in the directory.
> Practitioner → platform, on **our own** Whop company — **not** connected accounts, so no
> Whop-for-Platforms gate. Shipped + verified live 2026-07-09 (PR #16 + `bf90730`/`6655422`).
> (Layer Y = patient → practitioner offerings checkout through connected accounts, live — see
> `docs/PHASE-2C-WHOP-CONNECTED-ACCOUNTS.md`.) The monthly fee is the Plan A fee of the practitioner's
> rate schedule (`docs/money-model.md`); it is never hardcoded.

## How it works (as of 2026-10-15)

1. **Choose Plan A** in the Plan card on `/practitioners/[slug]/edit`. The save lands on the
   billing card (`#billing`); a Plan B save goes on to client payments.
2. **Billing card** — `SubscriptionSection`:
   - admin owner → exempt; `ACTIVE` / `PAST_DUE` → status (with the interval when known); Plan B → no fee.
   - Plan A and **billing open** → two choices: **Monthly** (`monthlyFeeLabel`) and **Annual**
     (`annualPlanALabel`, with the saving against twelve monthly fees). Both prices come from the
     practitioner's rate schedule. A practitioner who joined through a cohort link sees them
     labelled **Founding rate**.
   - Plan A and billing not open → "Billing hasn't started".
   - **Billing open** (`planABillingOpen` in `src/lib/plan-a-billing.ts`): always for a practitioner
     whose accepted invitation carries a `cohortId` (joined via `/join/<cohort>`); otherwise only once
     `trialEndsAt` has passed, so admin-invited pilots keep "not billing yet".
3. **Checkout** — each button calls `startSubscriptionCheckout(slug, 'monthly' | 'annual')`, which
   mints a fresh Whop checkout configuration for that interval's plan with
   `metadata.practitioner_id` and `metadata.nhp_billing_interval`, redirecting back to
   `/edit?subscription=success#billing`. The plan ids are DB settings (`PlatformSetting`
   `whop_plan_a_monthly_plan_id`, `whop_plan_a_annual_plan_id`, seeded by migration
   `20261015233000_plan_a_billing_intervals`); monthly falls back to `WHOP_SUBSCRIPTION_PLAN_ID`,
   annual has no fallback. The amount charged is whatever the Whop plan says.
4. **Webhook** — `POST /api/whop/webhook` (verified via `@whop/api` `makeWebhookValidator`) flips
   `Practitioner.subscriptionStatus` on `membership.went_valid` / `went_invalid` for any plan, and
   on activation records `subscriptionInterval` from the plan id (or the checkout metadata). It
   matches the practitioner by `metadata.practitioner_id`, then membership id, then email.
   Fail-**closed**: returns 503 until `WHOP_WEBHOOK_SECRET` is set.
5. **Listing gate** — unchanged by billing: listing is immediate, and an unpaid cohort practitioner is
   not delisted. See `isListed(p)` in `src/lib/practitioner-indexer.ts`.

## Data model (`Practitioner`)
`subscriptionStatus` (`NONE|ACTIVE|PAST_DUE|CANCELED`, default NONE) · `subscriptionInterval`
(`monthly|annual`, nullable) · `whopMembershipId String? @unique` · `trialEndsAt` (pilot clock).
`whopSubscriptionCheckoutUrl` is no longer read or written (a stored URL is pinned to one plan).

## Whop resources
- Company: **`biz_Vpj1G2ryNdPCG0`** ("Natural Health Pros" — the directory's Whop, under Holistic
  Health Network LLC). ⚠️ NOT the school's `biz_FItvmhBTmW02WG` "Holistic Health Educators".
- App: `naturalhealthpros-01` (`app_eBs2xmM8gba3H4`).
- Product: **"Pro Practitioner Membership"** `prod_tVk25TdpND5jf`.
- Plans (both on that product): monthly `plan_5YdWsNzoCg3Z3` (30-day renewal) and annual
  `plan_iAotyGNZkG6VW` (365-day renewal). There is **no free first period**: the operator ruling of
  2026-10-15 sets each plan's initial price equal to its renewal price (founding rate $29/month and
  $299/year). Prices are set in the Whop dashboard; the app never edits a plan. Check them with
  `GET /api/v1/plans/<id>` (`initial_price`, `renewal_price`).
- Checkout: `https://whop.com/natural-health-pros/pro-practitioner-membership`.

## Env vars (Vercel, all environments)
| Var | Value |
|---|---|
| `WHOP_API_KEY` | company key scoped to `biz_Vpj1G2ryNdPCG0` (prefix `apik_8XMj…`) |
| `WHOP_WEBHOOK_SECRET` | `ws_…` from the app's webhook |
| `WHOP_PLATFORM_CHECKOUT_URL` | the checkout link above |

## Fallback
The generic product page (`WHOP_PLATFORM_CHECKOUT_URL`) is used only when no server action is
available. It carries no metadata, so the webhook matches the payer **by email**, which fails when
someone pays from a different address than their account.

## Gotchas (learned the hard way — 2026-07-09)
- **Two Whop companies** — the original repo key pointed at the *school's* Whop; creating billing
  products there routes revenue to the wrong entity. Verify with `GET /api/v5/company` first.
- **App API-key permissions are baked at key creation** — enabling app scopes afterward does NOT
  grant an existing key new scopes; recreate the key with Plans/Webhooks/Memberships checked.
- **Webhook signature** — use `@whop/api` `makeWebhookValidator`, not a hand-rolled HMAC (wrong
  scheme, rejects real events).
