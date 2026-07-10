# Layer X — $59/mo platform-listing subscription (LIVE)

> Practitioners pay **Natural Health Pros** a monthly subscription to be listed in the directory.
> Practitioner → platform, on **our own** Whop company — **not** connected accounts, so no
> Whop-for-Platforms gate. Shipped + verified live 2026-07-09 (PR #16 + `bf90730`/`6655422`).
> (Layer Y = patient → practitioner offerings checkout, still gated on Platforms — see
> `docs/PHASE-2C-WHOP-DESIGN.md`.)

## How it works

1. **Portal CTA** — `SubscriptionSection` on `/practitioners/[slug]/edit`:
   - `comped` → "Complimentary" (pilots).
   - `subscriptionStatus === 'ACTIVE'` → "Active".
   - else → **Subscribe · $59/mo** → links to `WHOP_PLATFORM_CHECKOUT_URL` (or "Coming soon" if unset).
2. **Checkout** — the practitioner subscribes on Whop's hosted page.
3. **Webhook** — `POST /api/whop/webhook` (verified via `@whop/api` `makeWebhookValidator`) flips
   `Practitioner.subscriptionStatus` on `membership.went_valid` / `went_invalid` and re-runs the
   listing gate. Fail-**closed**: returns 503 until `WHOP_WEBHOOK_SECRET` is set.
4. **Listing gate** — `isListed(p)` in `src/lib/practitioner-indexer.ts`:
   `complete AND (comped OR subscriptionStatus === 'ACTIVE')`. Applied at index time (Typesense)
   **and** on the home page query (`LISTED_WHERE` in `src/app/page.tsx`). Direct profile URLs still
   resolve for the unlisted — the gate only controls discovery.

## Data model (`Practitioner`)
`subscriptionStatus` (`NONE|ACTIVE|PAST_DUE|CANCELED`, default NONE) · `comped Boolean` (pilots =
true, set in migration `20260709191242_layer_x_subscription`) · `whopMembershipId String? @unique`.

## Whop resources
- Company: **`biz_Vpj1G2ryNdPCG0`** ("Natural Health Pros" — the directory's Whop, under Holistic
  Health Network LLC). ⚠️ NOT the school's `biz_FItvmhBTmW02WG` "Holistic Health Educators".
- App: `naturalhealthpros-01` (`app_eBs2xmM8gba3H4`).
- Product: **"Pro Practitioner Membership"** `prod_tVk25TdpND5jf`.
- Checkout: `https://whop.com/natural-health-pros/pro-practitioner-membership`.

## Env vars (Vercel, all environments)
| Var | Value |
|---|---|
| `WHOP_API_KEY` | company key scoped to `biz_Vpj1G2ryNdPCG0` (prefix `apik_8XMj…`) |
| `WHOP_WEBHOOK_SECRET` | `ws_…` from the app's webhook |
| `WHOP_PLATFORM_CHECKOUT_URL` | the checkout link above |

## Known limitation / follow-up
The CTA links to the **generic product page**, so the webhook matches the practitioner **by email**
(works when they subscribe with their platform email). A per-practitioner checkout link carrying
`practitioner_id` metadata would be more robust — it needs the **`list_plans`/plan API permission**
enabled on the Whop key (see gotcha below), which never stuck this session.

## Gotchas (learned the hard way — 2026-07-09)
- **Two Whop companies** — the original repo key pointed at the *school's* Whop; creating billing
  products there routes revenue to the wrong entity. Verify with `GET /api/v5/company` first.
- **App API-key permissions are baked at key creation** — enabling app scopes afterward does NOT
  grant an existing key new scopes; recreate the key with Plans/Webhooks/Memberships checked.
- **Webhook signature** — use `@whop/api` `makeWebhookValidator`, not a hand-rolled HMAC (wrong
  scheme, rejects real events).
