# Phase 2 Plan — Post-demo unlocks

> **Status when this was written**: Phase 1 shipped + verified at https://hhe-directory.vercel.app. Amy meeting scheduled 2026-05-28. This doc is the **option space** for what ships after that meeting; the specific sequencing is operator-locked post-meeting based on Amy + Blake input.

## Phase 1 retrospective (what's live)

- **Routes**: `/`, `/search`, `/practitioners/[slug]` all in production
- **Search engine**: Typesense Cloud cluster `1rt8fj5i9epv2s6mp` with 18 seeded HHE-graduate-style practitioners
- **UX wedges shipped**: parametric/adaptive facets, mobile Sheet, URL state, faceted autocomplete, range facet (`yearsInPractice`), typo tolerance, click-through to profile
- **Stack**: Next.js 14.2 + Prisma 6 + Neon + NextAuth v5 (scaffolded, no providers wired yet) + Tailwind v4 + shadcn/ui + Typesense Cloud
- **Operator artifacts**: `docs/DEMO-PREP-5-28.md`, `docs/demo-prep/*.png`, `docs/demo-prep/2026-05-28-amy-leave-behind.md`

**What is NOT yet built** (the Phase 2 candidate set):
1. Practitioner authentication + edit/claim flows
2. Practitioner invitation system (email → accept → claim profile)
3. Booking / intro-consult integration
4. Payments (gated on Blake's WAP/Whop work)
5. Real practitioner data (vs current seed)
6. Reindex cron (currently app-layer; OK for Phase 1, batch resilience for Phase 2)
7. Additional schema fields enabling more parametric filters (fee, telehealth, accepts-new-patients, languages spoken)

## Five candidate wedges

Each is a self-contained Phase 2.x sub-block. Effort + dependency + impact tagged for operator sequencing decisions.

### 2A. Practitioner onboarding (auth + invite + claim) — **DONE 2026-05-25**

Shipped end-to-end + verified on prod:
- NextAuth v5 + Resend magic-link sign-in (`/auth/signin`)
- `Invitation` Prisma model + migration `20260525010841_invitation_model`
- Admin-only invite send page (`/admin/invites`, Role.ADMIN gated via `ADMIN_EMAILS` env auto-promotion)
- Invitation accept flow (`/auth/invite-accept/[token]` → magic link → `/onboarding?invitation=TOKEN` → Practitioner record created + slug derived from email + Role.PRACTITIONER set + Typesense reindex)
- Profile edit form (`/practitioners/[slug]/edit`, ownership-gated, reindex on save)
- Middleware gates `/admin/*` + `/practitioners/[slug]/edit` + `/onboarding`
- Resend email send with graceful-degrade (console.log when key missing — dev-friendly)

**Operator test recipe** (5 minutes):
1. Visit https://hhe-directory.vercel.app/admin/invites
2. Sign in with `jgatlit@gmail.com` (auto-promoted to ADMIN via env)
3. Send an invitation to your own email
4. Click the invitation link in email → "Send sign-in link"
5. Click the magic link → land on profile edit form
6. Fill in details → save → public profile updates + search re-indexes

**Out of scope (Phase 2.5+)**:
- Practitioner-set custom slug (currently fixed at email-derived)
- Photo upload (placeholders use shadcn AvatarFallback initials)
- Per-practitioner lat/lng override (currently city centroid)
- Verified Resend domain (currently sandbox `onboarding@resend.dev` — only delivers to your Resend account email until you verify a domain)

### 2B. Booking / intro-consult integration — **DONE 2026-05-25**

Final architecture: **practitioner-owned booking URLs (provider-agnostic)**. Each practitioner brings their own scheduling tool (Cal.com, Calendly, SavvyCal, Acuity, etc.), HHE Directory stores the URL and renders it as a click-through "Book intro consult" link.

**Why this path** (over Cal.com Platform API or single-account Path B):
- Cal.com Platform is officially deprecated (Cal.com docs, Dec 2025 — no new Platform signups)
- Cal.com Organizations + sub-teams require $37/seat/month — at 100 practitioners, $3,700/mo (cost-prohibitive for HHE-borne costs)
- Operator-locked: practitioners pay their own subscription seat cost → simplest architecture wins

Shipped:
- `prisma/schema.prisma`: new `Practitioner.bookingUrl String?` field
- Migration `20260525014427_practitioner_booking_url`
- `src/app/practitioners/[slug]/edit/actions.ts`: `normalizeBookingUrl()` with allowlist (cal.com, calendly, savvycal, tidycal, koalendar, acuityscheduling, etc. + light TLD check for custom domains)
- Edit form: "Booking link" field with hint copy + URL validation error state
- `src/components/practitioners/PractitionerLinks.tsx`: renders real `<a target="_blank">` link when `bookingUrl` is set, "Coming soon" placeholder otherwise. Helper text shows the booking provider's hostname (e.g., "cal.com") for transparency.

**Out of scope (Phase 2.5+)**:
- Verify the booking URL actually resolves (could add a periodic crawl/healthcheck)
- Embedded iframe widget (vs link-out) for hosted-on-HHE experience
- Booking event webhooks (to track which practitioners are getting bookings — needs cooperation from each scheduling provider)
- Provider-specific UX hints (e.g., "Pre-fill your name from URL" for Cal.com)

### 2C. Whop for Platforms — multi-tenant payment routing — **GATED on Whop Platforms API access**

**Operator-confirmed architecture** (2026-05-25): centralized multi-tenant routing via Whop, NOT practitioner-owned payment URLs. HHE = platform; each practitioner = a Whop **Connected Account**; patient pays via Whop checkout → funds route to the practitioner's connected account. Whop handles each practitioner's KYC + tax + compliance. HHE optionally takes a platform fee.

**Critical blocker** — access to Whop's Platforms API is **invite-only**:
> *"Access to the platforms API is currently invite only. Please contact sales@whop.com to see if your use case is eligible."* — Whop docs

**Confirmed empirically** (2026-05-25): the current Whop API key on file
(`apik_r09aRuWqXq1Iv_...`) returns **401 Unauthorized** on `/connected_accounts`, `/users/me`,
`/me`. It IS a standard single-creator account key with access to `/memberships`, `/products`,
`/company`, `/checkout_sessions`, `/experiences` — NOT a Platforms key.

**Operator-side action required** (Blake/Amy alignment first):
1. Confirm with Blake + Amy that Whop is the intended payments primitive (vs Stripe Connect, vs another marketplace solution)
2. Email `sales@whop.com` requesting Whop for Platforms access. Include: HHE Directory use case, practitioner volume target, expected GMV, compliance requirements (HIPAA? SOC2?)
3. Complete Whop's underwriting / onboarding (typically days to weeks)
4. Receive a new API key with Connected Accounts scope
5. Add the new key to Vercel envs (rotate the old one)

**Architecture (to build once access is granted)**:
- `Practitioner.whopConnectedAccountId String?` — Whop's ID for this practitioner's account
- `Practitioner.whopProductId String?` — primary offering (e.g., intro consult)
- Practitioner onboarding adds a "Set up payments" step that bridges to Whop's Connect-style onboarding flow (HHE creates the connected account, Whop handles KYC, redirects back)
- Webhooks from Whop → Neon (payment events, payout status, refunds)
- Public profile "Browse offerings" + "Request custom invoice" buttons resolve against Whop products owned by the practitioner's connected account
- Optional platform-fee config per product (or zero — pass-through)

**Why the practitioner-owned payment URL approach was rejected** (briefly shipped + rolled back 2026-05-25):
- Diverges from "multi-tenant payment routing" intent — each practitioner-owned URL is an external link-out with zero HHE visibility into bookings/revenue
- HHE can't aggregate data, can't optionally take platform fee, can't enforce refund policy consistency
- Whop Connected Accounts gives all of these for free
- Practitioner-owned URLs reverted via migration `20260525015721_drop_payment_url`

### 2D. Real practitioner data (replace seed)

**Effort**: <1 week of execution, but bounded by 2A
**Dependencies**: 2A (invitation flow live). Operator-side: practitioner curation list from Amy.
**Impact**: HIGH for credibility — every demo to a new stakeholder is stronger with real people.

**Plan**:
- Amy provides curated list of 10-20 first-wave practitioners
- 2A invitation flow sends → they complete profiles
- Seed data gets deleted once real-data crosses 15+ practitioners
- Vercel Blob wired for headshot uploads (replace initials avatars)

**Open questions**: Who's on Amy's first-wave list? What's the "minimum viable" profile quality bar before a practitioner is publicly visible?

### 2E. Search hardening + extended facets

**Effort**: ~1 week
**Dependencies**: None (engine is live; this is pure additive work).
**Impact**: MEDIUM — improves the search experience but isn't a wedge by itself.

**Items**:
- `reindex-mark-dirty` cron — replace app-layer Phase 1 reindex with a Vercel Cron job
- New facet fields:
  - `consultationFee` (range)
  - `telehealthAvailable` (boolean)
  - `acceptsNewPatients` (boolean)
  - `languagesSpoken` (multi-select)
  - `insuranceAccepted` (multi-select, Phase 2.5+ once it matters)
- Photo upload via Vercel Blob (replace shadcn AvatarFallback with real images)
- Geolocation "near me" sort prompt
- Saved-search functionality (gated on 2A for "save to my account")

**Open questions**: Which facets are operator-visible vs practitioner-self-editable?

## Sequencing (operator-locked 2026-05-25)

```
✅ 2A   DONE 2026-05-25 — auth + invite + claim
✅ 2B   DONE 2026-05-25 — practitioner-owned booking URLs
⛔ 2C   BLOCKED — Whop for Platforms access required (invite-only, email sales@whop.com)
□  2D   Real practitioners onboarded via 2A (operator + Amy's curated list)
□  2E   Search hardening + extended facets (interleaved)
```

**Critical follow-up for Blake/Amy alignment** (capture at the 2026-05-28 meeting):
- Is Whop the intended payments primitive, or is there a Plan B (Stripe Connect, custom marketplace)?
- Who emails sales@whop.com? What HHE Directory positioning to include in the application?
- Expected timeline for Whop underwriting/onboarding?
- Until 2C lands, public profiles show "Coming soon" on Browse offerings + Request invoice. The Linktree shape is correct; the payment plumbing is missing.

Original "Week 4" estimate for 2B → actual: ~30 min once architecture pivoted from Cal.com Platform/Org to practitioner-owned URLs. Pivot was triggered by Cal.com Platform deprecation + operator confirming practitioners pay their own seat costs.

## Hard prerequisites (operator-side, before any Phase 2 work)

- [x] `AUTH_SECRET` — DONE 2026-05-24
- [ ] **Authorize Blake's GitHub collab invite** (still pending) — required if Blake contributes code
- [ ] **Rotate Typesense Cloud admin API key** (was pasted in chat during Phase 1 setup)
- [ ] **Amy's first-wave practitioner list** — name + email + program-of-origin for 10-20 candidates
- [ ] **Decide: 2B path** — Cal.com embed vs Calendly redirect vs built-in
- [ ] **Decide: 2C revenue split** — platform fee % vs flat-listing-fee vs free-tier

## Out of scope for Phase 2 (deferred to Phase 3+)

- Practitioner-to-patient direct messaging / conversations (`Conversation` model + the `requireConversationAccess` helper currently stripped from `src/lib/action-utils.ts`)
- LLM-generated practitioner recommendations
- Mobile native app (PWA-first instead)
- Multi-language localization
- Practitioner advertising / paid placement
- Reviews / ratings — explicit operator preference is to AVOID Yelp-style review dynamics

## Reference

- Phase 1 plan + retrospective: `docs/PHASE-1-PLAN.md`
- Demo prep (Phase 1 deliverable): `docs/DEMO-PREP-5-28.md`
- Search engine setup: `docs/SEARCH-SETUP.md`
- Search requirements: `docs/SEARCH-REQUIREMENTS.md`
- Decisions-JSON (5/15 scope lock — still authoritative for Phase 2 YES/MAYBE/NO rows): `~/Downloads/practicenear-decisions-2026-05-15.json`
- Strategic reconciliation: `~/projects/HHE/PracticeNear/STRATEGIC_RECONCILIATION_2026-05-18.md`
- Project entity (vault): `~/vault/300 Entities/Projects/PracticeNear.md`
- Amy engagement profile: `~/vault/300 Entities/People/Amy (HHE).md`

## Memory pointers for next-session priming

These should auto-load via the `~/.claude/projects/-home-jgatlit-projects-HHE-HHE-directory/memory/` system:
- `gotcha_css_bootstrap.md` — Tailwind v4 + shadcn v4 quirks (still applies)
- `pattern_seed_strategy.md` — HHE-graduate framing + 60% GA + Prisma include-order
- `gotcha_typesense_instantsearch.md` — facet operator semantics + base-ui vs Radix + routing
- `reference_vercel_env_provisioning.md` — CLI bug + REST API workaround + project/team IDs

A future Claude session starting at `~/projects/HHE/HHE-directory/` will:
1. Read `CLAUDE.md` (stack + state + boundary)
2. See pointer to this file (`docs/PHASE-2-PLAN.md`)
3. Pick a wedge per operator instruction
4. Read the corresponding §2A/B/C/D/E section for the punch list
5. Cross-reference memory + reference materials as needed
