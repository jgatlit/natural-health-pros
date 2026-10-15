# Phase 2C — Whop Connected Accounts (validated architecture)

> Whop Connected Accounts architecture and API notes. Prices quoted in this document ($49, $59) are as of mid-2026; the practitioner monthly fee and every session rate come from rate schedules in the database. Current rates, payouts and flags: `docs/money-model.md` and `CLAUDE.md`.

> **Supersedes `docs/PHASE-2C-WHOP-DESIGN.md`** (2026-05-25). That doc's blocker premise ("Whop for Platforms is invite-only") was a **context error**. Its API shapes are also wrong in several load-bearing ways. Read this instead.
>
> Written 2026-07-29 against `https://docs.whop.com/llms-full.txt` + live read-only probes of the production API with the repo's current key.

## 1. The correction

**"Whop for Platforms" and "Connected Accounts" are the same product, and it is self-serve.**

There is no invite gate, no `sales@whop.com` application, no allowlist. `parent_company_id` is a documented **optional field on the public create-company endpoint**:

> `POST /api/v1/companies` — `parent_company_id` (string | null): *Creates a connected account under a platform; omit for standalone company.* `email` (string | null): *required when `parent_company_id` is provided.*
> Required permissions: `company:create`, `company:basic:read`

The setup instructions in [Enroll connected accounts](https://docs.whop.com/developer/platforms/enroll-connected-accounts) are three steps, all self-serve:

1. Have a Company account (we do — `biz_Vpj1G2ryNdPCG0` "Natural Health Pros")
2. Generate a **Company API key** in developer settings
3. Use it

### What the real blocker is

Probed live against production on 2026-07-29 with the repo's current `WHOP_API_KEY` (`apik_8XMj…`):

| Request | Result |
|---|---|
| `GET /api/v5/company` | `200` → `biz_Vpj1G2ryNdPCG0` "Natural Health Pros" |
| `GET /api/v1/companies/biz_Vpj1G2ryNdPCG0` | `200` (self-read works) |
| `GET /api/v1/companies` | `400` — *"Actor is missing all required permissions: `company:basic:read`"* |
| `GET /api/v1/companies?parent_company_id=…` | `403` — *"You are not authorized"* |
| `GET /api/v1/plans?company_id=…` | `403` — *"**App API key** is not authorized for the `plan:basic:read` scope."* |
| `GET /api/v1/checkout_configurations?company_id=…` | `403` — *"You are not authorized"* |
| `GET /api/v1/webhooks?company_id=…` | `403` — *"You are not authorized"* |

Two findings:

1. **The key authenticates fine on `/api/v1`.** `checkout_configurations` returned a *missing-parameter* error before an auth error, which proves the credential is accepted by v1. Nothing about the API version is blocked to us.
2. **The key is the wrong class and lacks the scopes.** Whop's own error names it an *"App API key"* — a key scoped to the `naturalhealthpros-01` app (`app_eBs2xmM8gba3H4`). The platforms docs call for a **Company API key** on the parent company.

This is consistent with the standing gotcha in memory (`gotcha_whop_setup` §2): **Whop API-key permissions are baked at creation.** Toggling app permissions after the fact does not re-scope an existing key.

**So the unblock is a dashboard action taking minutes, not a sales negotiation.** Mint a Company API key on `biz_Vpj1G2ryNdPCG0` with the scopes in §6, and re-run the probe table above.

## 2. Other ways the 5/25 design doc is wrong

Worth listing explicitly, because the scaffold in `src/lib/whop.ts` encodes all of them.

| 5/25 design said | Reality |
|---|---|
| SDK is `@whop/api` | Platform APIs live in **`@whop/sdk`** — a *different npm package*. `@whop/api@0.0.51` (installed, used by the live Layer X webhook) is the Whop **Apps** SDK, and is **deprecated on npm**. See §2.1. |
| Product → Plan → CheckoutConfig = 3 API calls | **One call.** `checkoutConfigurations.create()` accepts an inline `plan` object which itself accepts an inline `product`. |
| `GET /v1/companies/{id}` returns `{kyc_status, payouts_enabled}` | **The Company object has neither field.** Its `verified` boolean is the marketing verified-badge, *not* KYC. Polling company for payout readiness returns nothing useful. |
| KYC status is a 4-state enum | Whop's `payout_status` has **nine** states: `not_started`, `pending_verification`, `action_required`, `manual_review`, `connected`, `disabled`, `verification_failed`, `denied`, `blocked_by_parent`. The authoritative boolean is `payouts_enabled` — docs: *"Treat this as the single source of truth for payout readiness."* |
| Webhooks are hand-rolled HMAC over raw body | v1 webhooks follow the **[Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks)** spec (`webhook-id` / `webhook-timestamp` / `webhook-signature` headers). Verify with `whopsdk.webhooks.unwrap()`. The secret must be **base64-encoded** when passed as `webhookKey`. |
| `purchase_url` is a full URL | The **docs** show it relative (`/checkout/plan_xxx?session={id}`), but the **live API returns it absolute** (verified 2026-07-29). Normalise both — see §2.2. |
| Platform fee is the only revenue lever | There are **two**: per-checkout `application_fee_amount`, and **fee markups** (`POST /fee_markups`, scope `company:update_child_fees`) — a platform-wide markup on Whop's processing fees for all connected accounts. |

Also newly available and not in the old doc: a **sandbox** (`https://sandbox-api.whop.com/api/v1`), and **child company API keys** (`POST /companies/{parent_company_id}/api_keys`).

### 2.3 🚨 Live bug found + fixed 2026-07-29 — `plan.title` capped at 30 chars, silently failed the whole publish

First real practitioner-side test (post-KYC, publishing an offering) hit: **"Offering published but NO checkout link on profile page."** Root-caused by replaying the exact `createOfferingCheckout()` request against the real connected account:

```
plan.title = "Business Process Automation Audit" (34 chars)
→ 400 "Failed to create dynamic plan: Validation failed: Title is too long (maximum is 30 characters)"
```

Isolated field-by-field: `plan.title` caps at **30 chars**; `product.title` is a *separate* field capping at **80 chars**. `publishOffering()`'s catch-all swallowed this into a generic `?whop=error#offerings` banner with zero indication of *why* — a title over 30 chars silently failed the entire publish for any practitioner, a very plausible offering-title length in this directory.

**Fix — omit `plan.title` entirely**, verified live: the real Layer X plan (`plan_5YdWsNzoCg3Z3`) already ships with `title: null` and displays via `product.title`, so nothing customer-facing is lost. `product.title` (unbounded on our side) is the one actually shown to the buyer, so `publishOffering()` now pre-checks `offering.title.length <= 80` (`WHOP_OFFERING_TITLE_MAX` in `src/lib/whop.ts`) and redirects with a specific, actionable error (`?error=offering-title-too-long`) instead of the generic catch-all. Client-side `maxLength={80}` added to the title input as an earlier guard.

### 2.1 Does `@whop/sdk` fully replace `@whop/api`? — **Yes. Validated 2026-07-29.**

| | `@whop/api` (installed) | `@whop/sdk` (added) |
|---|---|---|
| npm status | `0.0.51` — **DEPRECATED**: *"Package no longer supported."* | `0.0.42` — *"The official TypeScript library for the Whop API"* |
| Last publish | 2026-06-12 | 2026-07-22 |
| Transport | GraphQL (`graphql-request`, `graphql-tag`) | REST v1 |
| Resource coverage | Apps-oriented | **70+ namespaces** incl. `companies`, `checkoutConfigurations`, `accountLinks`, `plans`, `payments`, `memberships`, `transfers`, `feeMarkups`, `payoutAccounts`, `verifications`, `refunds`, `disputes`, `withdrawals` |
| Webhooks | `makeWebhookValidator` | `webhooks.unwrap()` + full webhook CRUD (`create` / `list` / `update` / `delete`) |

**Repo usage of `@whop/api` is exactly one import at one site** — `makeWebhookValidator` in `src/app/api/whop/webhook/route.ts`. Nothing else in `src/` or `scripts/` touches it.

The only capability `@whop/sdk` lacks is **user/app token verification** (`verifyUserToken`, `makeUserTokenVerifier`, `getUserToken`, `WhopClientSdk`). Those exist for apps running **inside Whop's iframe**. Natural Health Pros is a standalone Next.js site on its own domain authenticating via NextAuth — it has never used them and has no path that would. **Nothing is lost.**

⚠️ **But it is NOT a drop-in swap.** The two packages verify *different webhook schemes*:

| | `@whop/api` | `@whop/sdk` |
|---|---|---|
| Scheme | Whop app webhooks | **Standard Webhooks** spec |
| Payload | `{ action, data }` | `{ type, data }` |
| Secret | raw | **base64-encoded** |
| Dashboard | legacy API version | must be **API version `v1`** |

So retiring `@whop/api` means re-registering the webhook in the Whop dashboard on v1 and rewriting event matching from `action` substring-sniffing to `type` equality. That is a **live-revenue migration** (Layer X), so it gets its own deliberate step — see §6a — not a drive-by dependency bump. Whop permits multiple registered webhooks, so old and new can run in parallel during cutover.

**Verdict: migrate fully to `@whop/sdk` and drop `@whop/api` — but only once the v1 webhook is registered and observed working.**

## 2.2 Validated against production — 2026-07-29

A Company API key was minted and every open question resolved against the live API. **No assumptions remain in the checkout path.**

### Scopes now working

| Request | Old app key | New Company key |
|---|---|---|
| `GET /v1/companies?parent_company_id=…` | `403` | **`200`** ✅ (empty — no connected accounts yet) |
| `GET /v1/plans?company_id=…` | `403` | **`200`** ✅ |
| `GET /v1/checkout_configurations?company_id=…` | `403` | **`200`** ✅ |
| `GET /v1/webhooks?company_id=…` | `403` | **`200`** ✅ (empty — **nothing registered on v1 yet**) |
| `GET /v1/companies` (bare list) | `400` | `400` — still missing `company:basic:read` for the "companies I can access" variant. Irrelevant: the platform path uses the `parent_company_id` variant, which works. |

### `company_id` vs `account_id` — resolved: **`company_id`**

Probed via deliberate validation errors so nothing was created:

- `plan.company_id` → passes parameter validation and proceeds to business validation ✅
- `plan.account_id` (same `biz_` value) → `Missing required parameter: plan.account_id` ❌

**The published docs are right and the generated SDK type is stale.** The raw-POST decision in `src/lib/whop.ts` was correct.

### Strict parameter validation is ON

`plan.zzz_bogus_field` → `Invalid value for parameter 'plan.zzz_bogus_field'`. Unknown fields are **rejected**, not ignored — so every field must be verified, and a stale SDK shape would hard-fail rather than degrade.

### The full documented shape is accepted

Posting `plan.{company_id, currency, title, plan_type, initial_price, renewal_price, billing_period, application_fee_amount, product:{title, external_identifier}}` + top-level `metadata` + `redirect_url` returned **only** the business-rule error below — meaning every parameter validated. This is exactly the shape `createOfferingCheckout()` sends. ✅

### ⚠️ Application fees require a connected account

> *"Application fee amount can only be set for connected accounts (companies with a parent company)"*

You **cannot** set `application_fee_amount` on your own platform company — only on a child. This is consistent with the architecture (fees are a Layer Y concept) but it means the fee path is untestable until the first connected account exists.

### Layer X end-to-end — works

A real per-practitioner checkout configuration was created against the live listing plan:

```
POST /checkout_configurations { mode:'payment', plan_id, metadata:{practitioner_id}, redirect_url }
→ id           ch_Un0YBUwMVN5lEvK
  company_id   biz_Vpj1G2ryNdPCG0
  purchase_url https://whop.com/checkout/plan_5YdWsNzoCg3Z3/?session=ch_Un0YBUwMVN5lEvK   ← ABSOLUTE
  metadata     { practitioner_id: … }        ← round-trips ✅
```

`metadata` round-trips intact, which is the whole basis for retiring email-matching (§4.2b). Note the config carries `practitioner_id: "probe_validation_only"` and **there is no delete endpoint** for checkout configurations — it is inert (an unguessable URL for the normal listing plan) but it does exist.

### Price — ✅ mismatch 1 RESOLVED at $49/mo · ⚠️ mismatch 2 still open

The live plan `plan_5YdWsNzoCg3Z3` on product `prod_tVk25TdpND5jf` "Pro Practitioner Membership" is:

```
plan_type renewal · initial_price $0.00 · renewal_price $49.00 · billing_period 30 days
```

Two mismatches were recorded here. Their status as of **2026-08-18**:

1. ✅ **$59 advertised vs $49 charged — RESOLVED, settled at $49.** The operator decision went to
   the plan, not the copy. Everything the practitioner can see now reads $49: `src/content/copy.ts`
   (`price: '$49'`), the edit page's `priceLabel="$49/mo"`, both trial-sweep emails, and
   `docs/LAYER-X-SUBSCRIPTION.md`. The last two stale `$59` strings — comments in
   `prisma/schema.prisma` — were corrected the same day. **$49 is canonical; treat any surviving
   `$59` in this repo as a dated artifact, not a price.**
2. **Superseded 2026-10-15:** the operator ruled no free first period. Both Plan A plans
   (monthly `plan_5YdWsNzoCg3Z3`, annual `plan_iAotyGNZkG6VW`) are to charge their initial price equal
   to their renewal price; the current setup is in `docs/LAYER-X-SUBSCRIPTION.md`. Historical note:
   ⚠️ **`initial_price` is $0 — STILL OPEN.** The first 30-day period is free, then $49/mo. The
   UI says only `Subscribe · $49/mo`; nothing a practitioner reads mentions the free first period.
   `docs/LAYER-X-SUBSCRIPTION.md` records it, but that is an internal doc, not product copy.
   Under-charging relative to the advertised price is a benign direction to be wrong in, which is
   exactly why it has survived — it produces no complaint. It is still a billing-vs-copy gap on
   the primary revenue line, and it is unresolved. **Operator decision, unchanged.**

### Resolved env

```
WHOP_COMPANY_API_KEY       apik_SLZY…            (Company key on biz_Vpj1G2ryNdPCG0)
WHOP_PARENT_COMPANY_ID     biz_Vpj1G2ryNdPCG0
WHOP_SUBSCRIPTION_PLAN_ID  plan_5YdWsNzoCg3Z3
```

✅ **All provisioned on Vercel 2026-07-29** across Production + Preview + Development, and mirrored into local `.env` / `.env.local` (both gitignored, verified):

| Var | Value |
|---|---|
| `WHOP_COMPANY_API_KEY` | `apik_SLZY…` (Company key on `biz_Vpj1G2ryNdPCG0`) |
| `WHOP_PARENT_COMPANY_ID` | `biz_Vpj1G2ryNdPCG0` |
| `WHOP_SUBSCRIPTION_PLAN_ID` | `plan_5YdWsNzoCg3Z3` |
| `WHOP_V1_WEBHOOK_SECRET` | `ws_…` from `hook_AfcAy8KImM101` |
| `WHOP_V1_WEBHOOK_SECRET_CHILD` | `ws_…` from `hook_DUkQVk9efwGbg` |

Pushed via the v9 REST API, not the CLI — CLI 54.4.1 is bugged on preview scope and can store empty
values via stdin piping. Each value was then read back and length-checked, because a silently-empty
env var is the failure mode this project has actually hit before.

Pre-existing and untouched: `WHOP_API_KEY` (legacy app key), `WHOP_WEBHOOK_SECRET` (legacy webhook),
`WHOP_PLATFORM_CHECKOUT_URL`. All three stay until `@whop/api` is retired (§6a A5).

## 3. Current state of the repo

| Layer | Status |
|---|---|
| **Layer X** — practitioner pays NHP $49/mo | **LIVE.** Hosted Whop product page via `WHOP_PLATFORM_CHECKOUT_URL`; webhook at `/api/whop/webhook` using `@whop/api`'s `makeWebhookValidator`; flips `subscriptionStatus` → drives the listing gate + Typesense reindex. |
| **Layer Y** — patient pays practitioner | **Catalog-only.** `WhopProduct` rows are created by `createOffering()` in the edit page and rendered on the profile, but `whopProductId` / `whopPlanId` / `purchaseUrl` stay `null`. No checkout exists. The editor tells practitioners *"online checkout turns on once your Whop payments…"*. |
| `src/lib/whop.ts` | Stubs that throw `WhopPlatformsAccessNotConfigured`, gated behind `WHOP_PLATFORMS_ENABLED` + `WHOP_PARENT_COMPANY_ID` — **neither env var is set**. |
| `/admin/connected-accounts`, `/admin/whop-webhooks` | Shipped, rendering empty/`NOT_STARTED` state. |

The good news: the **data model and UI surfaces are already in the right shape.** What has to change is the client layer, the status model, and the webhook scheme.

## 4. Recommended architecture

### 4.1 Money-flow model — **direct charges**, not transfers

Whop offers both. The table from their docs:

| | Direct charges | Transfers |
|---|---|---|
| Whop fees | Connected account pays | **Platform pays** |
| Disputes | Connected account handles | **Platform handles** |
| Refunds | Connected account handles | **Platform handles** |

**Use direct charges.** Transfers would make Natural Health Pros the merchant of record for every practitioner session — inheriting chargeback liability, refund obligations, and the need to float a funded balance. For a directory connecting patients to independent practitioners, that is the wrong risk posture and the wrong regulatory posture. Direct charges keep each practitioner the merchant for their own services, which is also what they'd expect.

Transfers stay available later if we ever need platform-mediated splits (e.g. affiliate commissions).

### 4.2 Fee model — **DECIDED 2026-07-29: subscription-only, transaction fee wired-but-off**

> **Operator decision.** Revenue is the **monthly per-practitioner subscription to be listed and searchable in the Directory** — independent of any transaction or checkout fee. Transaction-fee capability is to be **wired in code for future use**, but stays **off**. Primary build focus is the ordinary monthly subscription.

Consequences:

- **`application_fee_amount` is omitted** from every checkout configuration we create. Note this must be *omission*, not `0` — the docs require the fee to be "positive and less than the total payment," so sending `0` is an invalid request, not a free one.
- **`WhopProduct.applicationFeeCents` stays in the schema and stays plumbed** end-to-end (editor → action → config creation). It defaults to `0`, and `0` means *omit the field at the API boundary*. Flipping fees on later is then a data change, not a code change.
- **`fee_markups` stays untouched.** It's the other lever (a platform markup on Whop's processing fees for all connected accounts) and is explicitly out of scope.
- **Layer Y is therefore infrastructure, not a revenue line.** It earns its keep by making the subscription worth paying for — a practitioner who can actually take money through their listing has a reason to keep paying the monthly. That reframing matters for sequencing: see §6.

### 4.2a The dual-role model — practitioners are on *both* sides of our Whop company

Easy to conflate, so state it plainly. After this ships, a practitioner is simultaneously:

| Role | Whop relationship | Money flows | Billed on |
|---|---|---|---|
| **Layer X** — Directory subscriber | a **member** of `biz_Vpj1G2ryNdPCG0` holding a membership on our $49/mo product | practitioner → **us** | **our own** company |
| **Layer Y** — service seller | a **connected account** whose `parent_company_id` is `biz_Vpj1G2ryNdPCG0` | patient → **practitioner** | **their** connected company |

These are independent paths that never touch each other's funds. They share exactly one thing: **the same Company API key** unlocks both. That is why one dashboard action clears both layers at once.

### 4.2b The Layer X upgrade this unlocks

Layer X today resolves the paying practitioner by **email**, because the CTA points at a generic hosted product page carrying no per-practitioner context — `gotcha_whop_setup` §4 records that a per-practitioner checkout link "needs the plan API permission… deferred; email-match covers V1."

**The Company API key grants exactly that permission** (`plan:create`, `checkout_configuration:create`). So the same unblock lets us mint a **per-practitioner checkout configuration for the monthly subscription** carrying `metadata.practitioner_id` — and retire email-matching, which silently fails whenever a practitioner pays with a different email than the one on their profile.

Given the fee decision puts the subscription at the center of the business, **this is the highest-value item in the whole effort** and is sequenced first (§6).

### 4.3 Onboarding — lazy creation, gated publish

**Do not bulk-create connected accounts for the 12 pilots.** Creating a company causes Whop to email that address about account setup, and produces an orphan company for anyone who never sells anything. Create on **first intent to take money**.

```
Practitioner completes profile (existing Phase 2A/3 flow)
      │
      ▼
Adds an offering  ──►  WhopProduct row (local, unpublished)   ← already built
      │
      ▼  clicks "Enable checkout"
POST companies.create({
  title:  practitioner.displayName,
  email:  practitioner.user.email,          // required with parent_company_id
  parent_company_id: WHOP_PARENT_COMPANY_ID,
  country: 'US',                            // else inferred from parent or caller IP
  send_customer_emails: true,               // Whop emails patient receipts — we build none
  metadata: { practitioner_id, slug },      // ← reconciliation key, see §4.6
})
      │  persist company.id → Practitioner.whopCompanyId (@unique, already in schema)
      ▼
POST account_links.create({
  company_id, use_case: 'account_onboarding',
  return_url:  /api/whop/onboarding/return?practitioner=<id>,
  refresh_url: /practitioners/<slug>/edit?whop=refresh,
})
      │  redirect to accountLink.url  (Whop-hosted KYC — we build no KYC UI)
      ▼
identity_profile.approved webhook  ──►  payouts_enabled = true  ──►  offerings publishable
```

Three things that matter here:

- **Account links are short-lived** (`expires_at` on the object). Mint on demand, never persist. `refresh_url` exists precisely because the link can expire mid-flow — that route must re-mint and redirect.
- **`POST /companies` is not idempotent.** A double-click creates two companies under our platform and one leaks. Guard it: check `whopCompanyId` inside the same transaction that writes it, and reconcile stragglers via `GET /companies?parent_company_id=` matched on `metadata.practitioner_id`.
- **The return route is best-effort; the webhook is authoritative.** Whop redirects the user back the moment they finish the form, which is *before* the provider has approved. Treat `return_url` as "show a pending state," and let `identity_profile.approved` be what flips readiness.

### 4.4 Status model — replace the enum

`WhopKycStatus`'s four states can't represent what Whop reports. Expand-then-contract per the repo's migration discipline (migrations apply during build while the previous deploy still serves traffic):

```prisma
// ADD (expand) — keep whopKycStatus one release, then drop
whopPayoutStatus      WhopPayoutStatus @default(NOT_STARTED)  // mirrors Whop's 9 values
whopPayoutsEnabled    Boolean          @default(false)        // ← the gate
whopIdentityProfileId String?                                 // idpf_… for lookups
whopCompanyCreatedAt  DateTime?
```

**Gate the public "Buy" button on `whopPayoutsEnabled`, not on any status string.** Letting a patient pay into an account that can't withdraw is the worst possible failure mode for a pilot.

> ⚠️ **Amended 2026-08-14 — this applies to the WEBHOOK value only.** The original text continued: *"a `connected` status paired with `payouts_enabled: false` is an active account restriction, not incomplete setup — the distinction only shows up in the boolean."* That is **not safe to apply to a polled read.** A parent-company API key under-reports the boolean: Whop's own `identity_profile.updated` for `idpf_f9VEKuIiqGPc2` carried `payouts_enabled: true` with `linked_companies` populated, while `GET /identity_profiles` returns `false` with `linked_companies: []` for that same profile.
>
> So: **`payouts_enabled` is authoritative on the webhook and unreliable on read.** Store what the webhook says; gate checkout on the stored value. Any reconciliation sweep must key on `status: 'approved'` + `payout_status: 'connected'`, which do read accurately — gating a sweep on the polled boolean means it can never open the gate. See `src/app/api/cron/whop-reconcile/route.ts`.

### 4.5 Publishing an offering — regenerate, don't mutate

One call replaces the old three-step:

```ts
const cfg = await whop.checkoutConfigurations.create({
  company_id: practitioner.whopCompanyId,     // the connected account
  mode: 'payment',
  plan: {
    company_id: practitioner.whopCompanyId,
    currency: 'usd',
    title: offering.title,
    plan_type: offering.interval === 'ONE_TIME' ? 'one_time' : 'renewal',
    initial_price: offering.priceUsdCents / 100,   // dollars, not cents
    ...(offering.interval !== 'ONE_TIME' && {
      renewal_price:  offering.priceUsdCents / 100,
      billing_period: offering.interval === 'MONTHLY' ? 30 : 365,   // days
    }),
    product: { title: offering.title, external_identifier: offering.id },
  },
  redirect_url: `${BASE_URL}/practitioners/${slug}?purchase=success`,
  metadata: { practitioner_id, offering_id },   // ← flows through to payment webhooks
});

purchaseUrl = `https://whop.com${cfg.purchase_url}`;   // response is RELATIVE
```

**Treat the Whop-side checkout config as derived and disposable.** The `WhopProduct` row stays the source of truth for content; when a practitioner edits title or price, **create a fresh checkout configuration and swap the URL** rather than trying to PATCH plan pricing. This sidesteps plan-mutation semantics entirely, and it's the only approach that stays correct once a percentage-based `application_fee_amount` is in play (the fee has to be recomputed against the new price anyway).

Two units traps: prices are **dollars** here (`10.0` = $10.00) while `WhopProduct.priceUsdCents` is cents; and `billing_period` is **days**, not a named interval.

### 4.6 Attribution — set metadata at both levels

The `payment.succeeded` payload carries `company`, `membership`, `plan`, `checkout_configuration_id`, `application_fee`, and `metadata`. With `metadata.practitioner_id` + `metadata.offering_id` set on the checkout config, every payment self-identifies — no email-matching heuristics.

This is a real upgrade over Layer X, which resolves the practitioner by **email** because the CTA points at a generic hosted product page. Layer Y should not inherit that weakness.

Set `metadata.practitioner_id` on the **company** too, so a company-scoped event with no checkout context still resolves.

### 4.7 Webhooks — new endpoint, don't touch the live one

The v1 scheme is incompatible with the `@whop/api` validator running the live Layer X path. **Add `/api/whop/webhook/v1` rather than migrating `/api/whop/webhook`.** Layer X is live revenue; it should not be refactored in the same change that introduces Layer Y. Consolidate later, deliberately.

```ts
export const whopsdk = new Whop({
  apiKey: process.env.WHOP_COMPANY_API_KEY,
  webhookKey: btoa(process.env.WHOP_V1_WEBHOOK_SECRET || ''),   // ← base64, per docs
});

const event = whopsdk.webhooks.unwrap(await request.text(), {
  headers: Object.fromEntries(request.headers),
});
```

Subscribe to (dashboard → Developer → Create Webhook, **API version `v1`**):

| Event | Effect |
|---|---|
| `identity_profile.approved` | `whopPayoutsEnabled = true` → offerings publishable |
| `identity_profile.rejected` / `.needs_action` | surface a fix-it CTA on the edit page |
| `payout_account.status_updated` | sync `whopPayoutStatus` |
| `payment.succeeded` | record the sale, attribute via metadata |
| `refund.created`, `dispute.created` | admin visibility (practitioner owns resolution) |

Delivery semantics to respect — all documented, all easy to get wrong:

- **At-least-once.** Dedupe on the **`webhook-id` header**. The current Layer X handler synthesizes `${action}:${membershipId}` as its dedupe key, which collapses genuinely distinct events of the same type on the same membership into one audit row. Status writes stay idempotent so it isn't breaking anything today, but the v1 handler should use the real event id.
- **Retries stop after ~70s** (3 retries at 10s/20s/40s). There is no long retry tail — a handler that's down for two minutes loses events permanently. Reconciliation (§4.8) is not optional.
- **Ordering is not guaranteed.** Never infer state from arrival order.
- **Respond 2xx fast**; do work in `waitUntil()`.

### 4.7a v1 webhook registration — you need TWO, not one

**The trap:** `child_resource_events` is **exclusive, not additive**. Per Whop's own field docs:

> *"Whether or not to send events for child resources. For example, if the webhook is created for a Company, enabling this will **only** send events from the Company's sub-merchants (child companies)."*

So a single registration with the flag on would **silently stop delivering Layer X events** (our own memberships/payments) while appearing correctly configured. Two registrations are required:

| | Webhook 1 — platform | Webhook 2 — connected accounts |
|---|---|---|
| Purpose | Layer X (practitioner → us) | Layer Y (patient → practitioner) |
| `child_resource_events` | `false` | `true` |
| Secret env | `WHOP_V1_WEBHOOK_SECRET` | `WHOP_V1_WEBHOOK_SECRET_CHILD` |

Both POST to the **same** URL. `unwrapWebhook()` in `src/lib/whop.ts` tries each configured secret in turn, so one route handles both.

**`webhook_secret` is returned only at creation time.** It is not on the Webhook object afterwards — lose it and you must delete and recreate. This dictates the ordering below.

#### Order of operations — create DISABLED to avoid a dropped-delivery window

The naive order (create enabled, then deploy) burns Whop's 3 retries (10s/20s/40s) against a route
that doesn't exist yet, and those events are then gone for good. `enabled` is settable at create and
patchable afterwards, so create them switched off instead:

```
1. Create both webhooks with enabled:false   ← capture each webhook_secret (create-time only!)
2. Push the two secrets to Vercel (all 3 scopes)
3. Deploy
4. PATCH both to enabled:true                ← zero events dropped
```

Step 2 must precede step 3: Vercel binds env at deploy time, so a secret added *after* a deploy is
inert until the next one (the same trap that bit `EMAIL_FROM` on 07-15).

#### ✅ Provisioned 2026-07-29

| Webhook | id | `child_resource_events` | events | secret → env |
|---|---|---|---|---|
| Platform (Layer X) | `hook_AfcAy8KImM101` | `false` | 8 | `WHOP_V1_WEBHOOK_SECRET` |
| Connected accounts (Layer Y) | `hook_DUkQVk9efwGbg` | `true` | 9 | `WHOP_V1_WEBHOOK_SECRET_CHILD` |

Both `api_version: v1`, both pointing at `https://naturalhealthpros.com/api/whop/webhook/v1`.

✅ **Both `enabled: true` as of 2026-07-29**, after PR #37 deployed (`dpl_8NbgmuN1YJYKn1Mg3HemDnJ1e5fi`,
verified serving on the apex). An unsigned POST to the route returns `401`, not `503` — confirming
the secrets are bound and signature verification is active in production.

**To toggle (kept for reference):**

```bash
K=$(sed -E 's/^[A-Za-z_]+[:=][[:space:]]*//' .env.whop.company | tr -d '"'"'"' \r\n')
for h in hook_AfcAy8KImM101 hook_DUkQVk9efwGbg; do
  curl -sS -X PATCH "https://api.whop.com/api/v1/webhooks/$h" \
    -H "Authorization: Bearer $K" -H 'Content-Type: application/json' \
    -d '{"enabled":true}'
done
```

Registrations are fully reversible — `DELETE /api/v1/webhooks/{id}`.

#### Config values

```
url            https://naturalhealthpros.com/api/whop/webhook/v1
api_version    v1                       ← REQUIRED. v2/v5 send the legacy shape.
resource_id    biz_Vpj1G2ryNdPCG0       ← REQUIRED IN PRACTICE (see below)
enabled        false at create, flipped true after deploy
```

⚠️ **`resource_id` is not optional.** The docs say it "defaults to current company", but omitting it with a Company API key returns
`400 "Please provide a resource id or have a current company in context"`. Always send it explicitly.

**Webhook 1 — platform (`child_resource_events: false`)**
```
membership.activated · membership.deactivated · membership.trial_ending_soon
membership.cancel_at_period_end_changed
payment.succeeded · payment.failed · refund.created · dispute.created
```

**Webhook 2 — connected accounts (`child_resource_events: true`)**
```
identity_profile.approved · identity_profile.rejected
identity_profile.needs_action · identity_profile.updated
payout_account.status_updated
payment.succeeded · payment.failed · refund.created · dispute.created
```

All event names verified against the SDK's `WebhookEvent` union — Whop rejects unknown parameters outright (`parameter_invalid`), so a typo fails the registration rather than silently subscribing to nothing.

#### Create via API (returns the secret; the dashboard also works)

```bash
K=$(sed -E 's/^[A-Za-z_]+[:=][[:space:]]*//' .env.whop.company | tr -d '"'"'"' \r\n')

# 1. platform
curl -sS -X POST https://api.whop.com/api/v1/webhooks \
  -H "Authorization: Bearer $K" -H 'Content-Type: application/json' -d '{
  "url":"https://naturalhealthpros.com/api/whop/webhook/v1",
  "api_version":"v1","enabled":true,"child_resource_events":false,
  "events":["membership.activated","membership.deactivated","membership.trial_ending_soon",
            "membership.cancel_at_period_end_changed","payment.succeeded","payment.failed",
            "refund.created","dispute.created"]}'

# 2. connected accounts
curl -sS -X POST https://api.whop.com/api/v1/webhooks \
  -H "Authorization: Bearer $K" -H 'Content-Type: application/json' -d '{
  "url":"https://naturalhealthpros.com/api/whop/webhook/v1",
  "api_version":"v1","enabled":true,"child_resource_events":true,
  "events":["identity_profile.approved","identity_profile.rejected",
            "identity_profile.needs_action","identity_profile.updated",
            "payout_account.status_updated","payment.succeeded","payment.failed",
            "refund.created","dispute.created"]}'
```

Take `webhook_secret` from response 1 → `WHOP_V1_WEBHOOK_SECRET`, from response 2 → `WHOP_V1_WEBHOOK_SECRET_CHILD`. The secret is passed to the SDK **base64-encoded** — `src/lib/whop.ts` does that encoding, so store the RAW secret in env.

Verify with `GET /api/v1/webhooks?company_id=biz_Vpj1G2ryNdPCG0` (was empty before this).

### 4.8 Operations surfaces

| Surface | Implementation |
|---|---|
| `/admin/connected-accounts` | Join local rows against `GET /companies?parent_company_id=…` — this is also the **reconciliation** source that catches webhook drops and orphaned companies. |
| Practitioner payouts | `accountLinks.create({ use_case: 'payouts_portal' })` → redirect. Covers withdrawals, payout methods, *and* KYC in one hosted surface. **We build no payout UI.** |
| Patient receipts | `send_customer_emails: true` on the connected company — Whop sends them. |
| Refunds / disputes | Practitioner's own Whop dashboard (they're the merchant under direct charges). Admin gets read-only visibility via webhooks. |
| Bookings | **Unchanged.** Stays practitioner-owned Cal.com/Calendly links (Phase 2B). Whop is payments, not scheduling — don't conflate them. |

## 5. What stays the same

Worth stating, since it's most of the system:

- **Layer X is untouched.** $49/mo listing subscription, its webhook, and the listing gate all keep working exactly as they do now.
- `WhopProduct`, `WhopWebhookEvent`, `/admin/connected-accounts`, `/admin/whop-webhooks`, and the offerings editor keep their current shape.
- Booking links, search, profiles, auth gates: unaffected.

## 6. Unblock sequence

✅ **Step 0 completed 2026-07-29** — Company API key minted and validated (§2.2). Steps 1–2 done locally; Vercel envs still pending.

```
0.  Whop dashboard → biz_Vpj1G2ryNdPCG0 → developer settings
    Create a COMPANY API key (not an app key) with:
      company:create · company:basic:read · company:update
      checkout_configuration:create · checkout_configuration:basic:read
      plan:create · plan:basic:read
      access_pass:create · access_pass:update
      payout:account:read
      webhook_receive:identity_profiles · webhook_receive:payout_accounts
      webhook_receive:payments · webhook_receive:refunds · webhook_receive:disputes
    ⚠ Scopes are baked at creation — a key made without these can never gain them.

1.  Verify before writing any code — re-run the §1 probe table.
    GET /api/v1/companies?parent_company_id=biz_Vpj1G2ryNdPCG0  must return 200.

2.  Env: WHOP_COMPANY_API_KEY, WHOP_PARENT_COMPANY_ID=biz_Vpj1G2ryNdPCG0,
    WHOP_V1_WEBHOOK_SECRET  (all 3 Vercel scopes; keep existing Layer X vars intact)
```

Everything below is code and needs no operator action.

### 6a. Track A — Layer X hardening (the revenue line, per §4.2)

```
A1.  npm i @whop/sdk                                        ✅ done (0.0.42)
A2.  src/lib/whop.ts rewritten against real v1 endpoints    ✅ done, typechecks
A3.  Per-practitioner subscription checkout config carrying
     metadata.practitioner_id  (§4.2b) — retires email-matching
     ✅ API shape validated live (ch_Un0YBUwMVN5lEvK); still needs the
     server action + SubscriptionSection wiring to replace the generic
     WHOP_PLATFORM_CHECKOUT_URL link
A4.  Register a v1 webhook in the dashboard ALONGSIDE the existing one;
     /api/whop/webhook/v1 handles {type,…} via webhooks.unwrap()
     (confirmed: v1 webhook list is currently EMPTY — nothing to collide with)
A5.  Observe both webhooks delivering; then delete the legacy registration,
     delete src/app/api/whop/webhook/route.ts, and `npm rm @whop/api`
```

`@whop/api` cannot be removed before A5 — it verifies the webhook that currently drives every listing gate.

### 6b. Track B — Layer Y connected accounts (green-lit 2026-07-29)

```
B1.  Prisma expand migration (§4.4) via `migrate diff` + `migrate deploy`
     — NOT `migrate dev` (see gotcha_prisma_migrate_dev_broken)
B2.  Onboarding: enable-checkout action + /api/whop/onboarding/return + refresh route
B3.  Publish-offering action (§4.5); gate public Buy on whopPayoutsEnabled
B4.  Extend /api/whop/webhook/v1 with identity_profile.* + payout_account.status_updated
B5.  Admin reconciliation against GET /companies?parent_company_id=
```

Dry-run against **`https://sandbox-api.whop.com/api/v1`** before production. Sandbox needs its own key and its own plan IDs.

## 7. Decisions

| Decision | Status |
|---|---|
| **Fee model** | ✅ **Decided 2026-07-29** — monthly per-practitioner subscription is the revenue; transaction fee wired but off (§4.2). |
| **Layer Y scope** | ✅ **Green-lit 2026-07-29** — build it, as infrastructure that justifies the subscription rather than as a revenue line. |
| **Retire `@whop/api`** | ✅ **Decided** — it's deprecated on npm; migrate fully to `@whop/sdk`, gated on the v1 webhook cutover (§2.1, step A5). |
| **Gate strictness** | ⏳ **Open** — recommendation is hard-gating public checkout on `payouts_enabled` (§4.4). Alternative (publish with a warning) trades support burden for faster listing. Defaulting to the hard gate until told otherwise. |

## 8. Sources

- [Enroll connected accounts](https://docs.whop.com/developer/platforms/enroll-connected-accounts)
- [Collect payments for connected accounts](https://docs.whop.com/developer/platforms/collect-payments-for-connected-accounts)
- [Enable connected account payouts](https://docs.whop.com/developer/platforms/render-payout-portal)
- [Manual payouts to connected accounts](https://docs.whop.com/developer/platforms/manual-payouts)
- [Create company](https://docs.whop.com/api-reference/companies/create-company) · [Company object](https://docs.whop.com/api-reference/companies/company) · [List companies](https://docs.whop.com/api-reference/companies/list-companies)
- [Create checkout configuration](https://docs.whop.com/api-reference/checkout-configurations/create-checkout-configuration)
- [Create account link](https://docs.whop.com/api-reference/account-links/create-account-link) · [Account Link object](https://docs.whop.com/api-reference/account-links/account-link)
- [Verification object](https://docs.whop.com/api-reference/verifications/verification) · [Payout Account object](https://docs.whop.com/api-reference/payout-accounts/payout-account)
- [Webhooks guide](https://docs.whop.com/developer/guides/webhooks)
- Whop dev support thread, 2026-07-28 (`johnny.gonzales@whop.com`) — `Whop dev support 2026Jul28.md`
