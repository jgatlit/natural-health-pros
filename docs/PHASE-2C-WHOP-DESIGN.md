# Phase 2C — Whop Platforms architecture (designed, scaffolded, gated on access)

> **Status as of 2026-05-25**: design + schema + lib + UI placeholders shipped. Live API integration paused pending Whop for Platforms API access (operator-side action via `sales@whop.com`). When access lands, swap the placeholder no-ops in `src/lib/whop.ts` for the real client calls; everything else is wired.

## Decision context

- **Operator-locked architecture** (2026-05-25): centralized multi-tenant payment routing via Whop. HHE = platform; each practitioner = a Whop **sub-merchant company** (Whop's Connected Account / Stripe-Connect-equivalent primitive); patients pay via Whop checkout → funds route directly to the practitioner's sub-merchant; HHE optionally takes a flat platform fee per transaction.
- **Why this over practitioner-owned payment URLs** (rejected 2026-05-25): centralized routing gives HHE platform-fee revenue, refund-policy consistency, aggregated analytics, and uniform compliance. Practitioner-owned URLs lose all of these.
- **Why this over Stripe Connect direct** (kept as fallback): operator pre-selected Whop based on Blake's 5/15 scope. Whop also handles practitioner KYC + tax compliance natively, reducing HHE-side operational burden.

## Whop Platforms entity model (as designed)

Per [Whop's docs](https://docs.whop.com/developer/api/getting-started) + [platforms quickstart](https://docs.whop.com/developer/platforms/quickstart):

```
Parent Company        ← HHE (the platform)
  └── Sub-Merchant    ← Each practitioner (created via companies.create with parent_company_id)
        ├── Payout Account  (KYC-verified, where funds settle)
        ├── Products        (the practitioner's offerings)
        │     └── Plans     (pricing tiers per product — one-time, monthly, annual)
        └── Checkout Configurations  (one per product, includes application_fee_amount)
```

**Authentication**: Company API Key (Platforms-scoped) — invite-only via `sales@whop.com`. Current key on file is standard-creator scope (returns 401 on `/connected_accounts`, `/users/me`, `/me`).

**Platform fee model**: `application_fee_amount` per checkout (flat, not percentage). Whop's example: $10 payment with `application_fee_amount: 1.23` → platform receives $1.23, connected account receives $8.77 net of Whop processing fees.

## HHE-side data model (Prisma additions)

### New Practitioner fields

```prisma
model Practitioner {
  // ...existing fields...

  // Phase 2C — Whop Platforms (sub-merchant company)
  whopCompanyId        String?         // Whop sub-merchant company.id from companies.create
  whopKycStatus        WhopKycStatus   @default(NOT_STARTED)
  whopKycCompletedAt   DateTime?
  whopProducts         WhopProduct[]
}

enum WhopKycStatus {
  NOT_STARTED   // No Whop sub-merchant yet
  PENDING       // Sub-merchant created, KYC in progress
  VERIFIED      // KYC complete, payouts enabled
  REJECTED      // Whop declined verification
}
```

### New WhopProduct model

```prisma
model WhopProduct {
  id                    String        @id @default(cuid())
  practitionerId        String
  practitioner          Practitioner  @relation(fields: [practitionerId], references: [id], onDelete: Cascade)

  whopProductId         String        @unique  // product.id from products.create
  whopPlanId            String?                 // plan.id (Whop's pricing tier within a product)
  whopCheckoutConfigId  String?                 // checkoutConfiguration.id
  purchaseUrl           String?                 // Whop-hosted checkout URL

  title                 String
  description           String?
  priceUsdCents         Int           // always in cents; renders as $X.XX
  applicationFeeCents   Int           @default(0)  // HHE's platform fee per transaction
  interval              ProductInterval @default(ONE_TIME)

  active                Boolean       @default(true)
  archived              Boolean       @default(false)
  createdAt             DateTime      @default(now())
  updatedAt             DateTime      @updatedAt

  @@index([practitionerId, active])
}

enum ProductInterval {
  ONE_TIME    // Single purchase (intro consult, package)
  MONTHLY     // Subscription
  ANNUAL
}
```

### Operator-side WhopWebhookEvent log (optional, recommended)

For debugging + audit:

```prisma
model WhopWebhookEvent {
  id            String   @id @default(cuid())
  whopEventId   String   @unique  // dedupe key from Whop's webhook payload
  eventType     String   // e.g., 'payment.succeeded', 'account.verified'
  payload       Json
  receivedAt    DateTime @default(now())
  processedAt   DateTime?
  error         String?
}
```

## Lifecycle flows (designed, code-stubbed)

### Flow A — Practitioner enrolls in Whop payments

```
1. Practitioner finishes Phase 2A profile (auth + invite + claim done)
2. On /practitioners/[slug]/edit, sees a "Payments" section:
   - whopKycStatus=NOT_STARTED → "Set up payments via Whop" CTA
3. Click CTA → POST /api/whop/onboarding/start (Server Action):
   a. Call client.companies.create({
        email: practitioner.user.email,
        parent_company_id: process.env.WHOP_PARENT_COMPANY_ID,
        title: practitioner.displayName,
        metadata: { practitioner_id, slug }
      })
   b. Store whopCompanyId on Practitioner, set whopKycStatus=PENDING
   c. Call client.accountLinks.create({
        company_id: whopCompanyId,
        refresh_url: `${BASE_URL}/practitioners/${slug}/edit?whop=refresh`,
        return_url: `${BASE_URL}/api/whop/onboarding/return?company_id=${whopCompanyId}`,
        use_case: 'account_onboarding'
      })
   d. Redirect practitioner to accountLink.url
4. Practitioner completes KYC at Whop's hosted onboarding page
5. Whop redirects to /api/whop/onboarding/return?company_id=X
6. Return handler verifies status via Whop API + updates Practitioner.whopKycStatus
7. Webhook (account.verified) is the authoritative confirmation; return route is best-effort
```

### Flow B — Practitioner adds a product

```
1. On /practitioners/[slug]/edit, whopKycStatus=VERIFIED → see "Offerings" section with:
   - List of existing products (active + archived)
   - "Add new offering" CTA
2. Click CTA → modal/page with form: title, description, price, interval, fee model
3. Submit → POST /api/whop/products/create (Server Action):
   a. client.products.create({ company_id: whopCompanyId, title, description })
   b. client.plans.create({ product_id, price_cents: priceUsdCents, currency: 'usd', interval })
   c. client.checkoutConfigurations.create({
        company_id: whopCompanyId,
        plan_id,
        application_fee_amount: applicationFeeCents / 100
      })
   d. Store full row in WhopProduct table; reindex practitioner in Typesense if active
4. Public profile renders new offering in PractitionerLinks
```

### Flow C — Patient buys an offering

```
1. Patient on /practitioners/[slug] sees PractitionerLinks with active offerings
2. Click "Browse offerings" → drawer/modal with product cards
3. Click "Buy" on a product → opens Whop hosted checkout at purchaseUrl
4. Whop handles payment, sends webhook (payment.succeeded) to HHE
5. Webhook handler logs WhopWebhookEvent, optionally updates analytics
6. Funds settle: practitioner gets (price - application_fee - Whop processing); HHE gets application_fee
7. Whop emails patient receipt + practitioner notification
```

### Flow D — Refund / dispute (Phase 2.5+)

Out of scope for initial 2C ship. Whop's standard refund flow applies; webhook (refund.created) updates internal state.

### Flow E — Practitioner offboards / archives

Practitioner toggles a product `archived=true` → not shown publicly. Existing customers' subscriptions continue per Whop's terms. Hard-deletion is Phase 2.5.

## API surface (HHE-side routes)

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/whop/onboarding/start` | POST (Server Action) | Practitioner | Create sub-merchant + KYC link |
| `/api/whop/onboarding/return` | GET | Practitioner (via redirect) | Whop redirects here after KYC |
| `/api/whop/products/create` | POST (Server Action) | Practitioner | Add a product |
| `/api/whop/products/update` | POST (Server Action) | Practitioner (owner) | Edit product details |
| `/api/whop/products/archive` | POST (Server Action) | Practitioner (owner) | Soft-delete a product |
| `/api/whop/webhook` | POST | Whop (signed) | Whop event notifications |
| `/admin/connected-accounts` | GET | Admin | List all sub-merchants + status |
| `/admin/whop-webhooks` | GET | Admin | View recent webhook events |

## Webhook events to subscribe to

- `company.created` — sub-merchant creation confirmation
- `account.verified` — KYC complete, payouts enabled
- `account.rejected` — KYC failed
- `payment.succeeded` — patient paid
- `payment.failed` — patient checkout failure
- `payout.scheduled` — funds queued to practitioner
- `payout.paid` — funds settled to practitioner
- `refund.created` — Phase 2.5 territory

## UI surfaces (designed, placeholder-shipped)

### `/practitioners/[slug]/edit` — Payments section

3 states:

**State 1 — No Whop account**
```
[icon] Set up Whop payments
       Enable patients to book paid sessions + memberships
       [ Connect with Whop ]   ← gated on Platforms access; shows "Coming soon" until then
```

**State 2 — KYC in progress**
```
[icon] Whop payments — verification in progress
       Whop is reviewing your account. This typically takes 1-2 business days.
       Status: PENDING · started 2 days ago
       [ Continue verification ]   ← refresh URL
```

**State 3 — Verified, add products**
```
[icon] Whop payments — active
       Sub-merchant: biz_xxxxx · KYC verified
       [ Add an offering ]
       
       Active offerings:
       ── Intro Consult ── $150 · one-time
       ── Monthly Membership ── $99/mo · subscription
```

### `/practitioners/[slug]` — public profile

PractitionerLinks expands when `WhopProduct[]` is non-empty:

```
[Book an intro consult]  ← Wedge 2B booking link
[Browse offerings]        ← expands to product list when 2C active
   └── Intro Consult — $150 · one-time           [Buy →]   (links to purchaseUrl)
   └── Monthly Membership — $99/mo · subscription [Buy →]
[Request custom invoice]  ← Phase 2.5 (email-admin Server Action)
```

### `/admin/connected-accounts`

Table: practitioner name | email | whopCompanyId | KYC status | product count | total GMV | actions

### `/admin/whop-webhooks`

Recent events list, retry failed ones, debug payloads.

## Required env vars (operator-side)

| Var | Where | Notes |
|---|---|---|
| `WHOP_API_KEY` | Already set | Currently standard-creator scope; replace with Platforms key once access granted |
| `WHOP_PARENT_COMPANY_ID` | NEW — needs operator to provide | HHE's own Whop company ID; used as `parent_company_id` when creating sub-merchants |
| `WHOP_WEBHOOK_SECRET` | NEW — provided by Whop on Platforms onboarding | HMAC verification for incoming webhooks |
| `WHOP_API_BASE` | Default `https://api.whop.com/api/v1` | Override only if needed |

## Implementation order (when Platforms access lands)

```
Step 1   Replace WHOP_API_KEY with Platforms-scoped key in Vercel envs
Step 2   Add WHOP_PARENT_COMPANY_ID + WHOP_WEBHOOK_SECRET envs
Step 3   Verify env config: GET /v1/companies/$WHOP_PARENT_COMPANY_ID returns 200
Step 4   Wire src/lib/whop.ts — replace stub no-ops with real SDK calls
Step 5   Apply pending migration (whop_platforms_models)
Step 6   Subscribe to webhooks via dashboard or programmatically via webhooks.create
Step 7   Smoke test: create one sub-merchant via /api/whop/onboarding/start, complete KYC
Step 8   Add a test product, verify checkout link works
Step 9   Deploy to production
```

Estimated effort once access lands: ~2-3 days focused work. Most of the surface area (schema, routes, UI, types) is already scaffolded — only the live API calls need to swap in.

## Out of scope for Phase 2C v1 (deferred to 2.5)

- Refund + dispute UI (use Whop dashboard for now)
- Multi-currency support (USD only initially)
- Subscription lifecycle UI (pause / resume / cancel) — defer to Whop's own pages
- Promo codes / discount logic
- Affiliate / referral commission splits
- Tax form generation (Whop should handle 1099s natively for sub-merchants)
- Marketplace-level analytics dashboard for HHE
- Practitioner-side earnings dashboard inside HHE Directory (link out to Whop's own dashboard initially)

## Fallback if Whop Platforms doesn't pan out

See `docs/demo-prep/2026-05-25-whop-platforms-request.md` § "If Whop says no" — priority-ordered fallback list:
1. Stripe Connect Express (same architecture, transparent pricing)
2. Lemon Squeezy (merchant-of-record handles tax/compliance)
3. Practitioner-owned URLs (the path rolled back 2026-05-25 — last resort)

## Related artifacts

- `docs/PHASE-2-PLAN.md` §2C — sequencing + blocker status
- `docs/demo-prep/2026-05-25-whop-platforms-request.md` — outbound email template for `sales@whop.com`
- `docs/DEMO-PREP-5-28.md` § "Critical Blake/Amy follow-up" — the alignment questions to capture at the 5/28 meeting
- `src/lib/whop.ts` — Whop Platforms client wrapper with stub no-ops (to be added in this PR)
- `src/components/practitioners/PractitionerLinks.tsx` — UI surface for 2B + 2C link rendering
