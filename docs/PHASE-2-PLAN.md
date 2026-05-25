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

### 2B. Booking / intro-consult integration

**Effort**: ~1-2 weeks depending on path
**Dependencies**: 2A (practitioners need to be logged in to manage availability). External: Cal.com OR Calendly OR built-in scheduler.
**Impact**: MEDIUM — this is the "Book an intro consult" button on `/practitioners/[slug]` becoming real. Significant trust signal for Amy's audience.

**Three implementation paths**:
1. **Cal.com embed** — each practitioner gets a Cal.com account, embed widget on profile. Cheapest, fastest, gives them a real calendar tool. ~3-5 days.
2. **Calendly redirect** — link out to practitioner's Calendly. Even faster, less polished. ~1-2 days.
3. **Built-in scheduler** — Prisma model + custom UI. Most flexible, most expensive. ~2 weeks.

**Open questions**: Who pays for Cal.com Pro per practitioner? Does HHE Directory subsidize? Or practitioner-side cost?

### 2C. Payments (Whop / WAP)

**Effort**: ~2 weeks once Blake's integration lands
**Dependencies**: Blake's WAP/Whop work (NOT controlled by this repo). 2A for practitioner-side payment-link management.
**Impact**: HIGH for revenue capture, MEDIUM for demo wow-factor (not visible at first click).

**Implementation tree**:
- Whop product per practitioner SKU (intro consult, package, custom invoice)
- Webhook → Neon database (payment status, receipt URL)
- Profile UI: "Book + Pay" buttons replace placeholder "Coming soon"
- Custom invoice request flow → email Amy/Jonathan → manual issue OR Stripe link generation

**Open questions**: Does Amy want HHE to take a platform fee? What revenue split with practitioners? Tax handling per state?

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
⏳ 2B   IN PROGRESS — Cal.com booking integration (next)
□  2C   Whop payments (after 2B, gated on Blake's WAP/Whop work)
□  2D   Real practitioners onboarded via 2A (operator + Amy's curated list)
□  2E   Search hardening + extended facets (interleaved)
```

Original "Week 1-2" estimate for 2A → actual: one focused-session day. Pace is accelerated; revisit timeline after 2B lands.

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
