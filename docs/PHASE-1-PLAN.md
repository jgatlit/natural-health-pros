# Phase 1 Plan — Demoable Substrate for Amy 5/28

> **Deadline**: 2026-05-28 (in-person with Amy at HHE). 4 working days from Phase 0 ship (2026-05-24).
> **Goal**: Walk Amy through real working substrate (not decision matrices) on three wedges Blake locked at the 5/15 call: **landing pages · payments · discoverability**. Payments are gated on WAP/Whop work Blake owes (will not ship by 5/28). Landing + discoverability are this week's deliverables.

## Source of truth

- **53-feature scope**: `~/Downloads/practicenear-decisions-2026-05-15.json` (canonical adjudication)
- **Reconciliation sequencing**: `~/projects/HHE/PracticeNear/STRATEGIC_RECONCILIATION_2026-05-18.md` §149–193

Phase 1 YES rows from decisions-JSON (in scope this week):
- `typesense` · `instantsearch-ui` · `haversine` · `pgtrgm` · `hierarchical-tax` · `reindex-mark-dirty` (search architecture)
- Practitioner profile + Linktree-style landing page model (Blake's framing)
- Practitioner invitation flow scaffolding (net-new build — full flow is Phase 1+, this week shows the data model + admin-create surface)

## Hard prerequisites (must land before any UI work)

1. **`AUTH_SECRET` env var added to Vercel** — NextAuth requires it before any provider lands. `openssl rand -base64 32` → `vercel env add AUTH_SECRET production`, `preview`, `development`.
2. **Typesense provisioned** — either Typesense Cloud account (https://cloud.typesense.org) OR self-host on Railway/Fly. Donor doc: `~/projects/HHE/practitionerDirectory/research/typesense-v30-implementation-guide-2025-11-07.md`. After provision: add `TYPESENSE_HOST`, `TYPESENSE_API_KEY`, `NEXT_PUBLIC_TYPESENSE_SEARCH_KEY` to Vercel envs (no prefix needed; not Marketplace-injected).
3. ~~`pg_trgm` extension enabled in Neon~~ — **DONE 2026-05-24**: migration `20260524141519_pg_trgm_search` applied, GIN trigram index on `Practitioner.searchText` live.

## Work blocks

### Block A — Practitioner profile (Mon, ~3 hr) — **DONE 2026-05-24**

Shipped:
- `src/app/practitioners/[slug]/{page,loading}.tsx` — server-rendered profile, returns 404 via `notFound()` for unknown slugs
- `src/components/practitioners/{PractitionerHeader,PractitionerLinks,PractitionerBio}.tsx` — built on shadcn/ui primitives (Card, Avatar, Badge, Separator)
- Visual layer: Tailwind 4.3 + shadcn/ui (`new-york`, zinc). Mobile-first Linktree-style card.
- Seed data: 18 practitioners across 13 cities, 61% GA per operator directive (`prisma/seed.ts`)
- `pg_trgm` migration applied to Neon

Verified end-to-end via Playwright at 440×900 against real Neon-backed data.

**Out of scope this block (deferred to Phase 2+)**: edit flows, claim flows, invitation acceptance. Linktree CTAs render as `Coming soon` placeholders until booking + payments wedges land.

### Block B — Search infrastructure (Tue, ~4 hr)

**Files to create:**
- `src/lib/typesense-server.ts` — server-side client (existing `src/lib/typesense.ts` is the donor; refine if needed)
- `src/lib/typesense-search.ts` — client-side InstantSearch adapter config (using `NEXT_PUBLIC_TYPESENSE_SEARCH_KEY`)
- `prisma/seed.ts` — seed script (see Block C)
- `scripts/typesense-index.ts` — one-shot script that reads all practitioners from Neon, transforms to Typesense docs (flattening specialty, denormalizing city + state + coordinates for haversine), bulk-inserts into Typesense collection
- `deployment/typesense-collection-schema.json` — already lifted from donor; may need field adjustments to match the new `Practitioner` schema (don't blindly use as-is)

**Schema work**:
- Add to `prisma/schema.prisma`: `searchText` column denormalization trigger? Or just compute in app-layer on practitioner upsert. Simpler: app-layer for Phase 1, trigger when we have time.
- Add migration: `CREATE EXTENSION IF NOT EXISTS pg_trgm;` + index on `Practitioner.searchText` using `gin_trgm_ops`

**Test by**: `npm run db:seed` then `npm run typesense:index` then visit search page (Block C below).

### Block C — Search UI + seed data (Wed, ~4 hr)

**Files to create:**
- `src/app/search/page.tsx` — Client component (`'use client'`) with InstantSearch root, mounted to Typesense via the search-only key
- `src/components/search/SearchFilters.tsx` — `RefinementList` for specialty (hierarchical), `RangeInput` for price, `Pagination`. Airbnb-style facets per Amy's 5/15 framing.
- `src/components/search/SearchResults.tsx` — `Hits` component with per-card `PractitionerCard` (display name, city, primary specialty, intro-consult price)
- `src/components/search/SearchBox.tsx` — `SearchBox` (Typesense handles `pgtrgm`-style typo tolerance via fuzzy match)
- `prisma/seed.ts` — seed 15–20 HHE-graduate-style practitioners with realistic specialties (per Amy's framing — graduates of Lamonte's program, Kieran's gut-health program, etc.) and US cities. Use `faker` for names/bios; keep specialties fixed and realistic.

**Specialties to seed** (from Amy's 5/15 + 5/13 voice note framing):
- Functional Medicine
- Holistic Nutrition
- Gut Health
- Hormone Balance
- Stress / Sleep Optimization
- Herbal Medicine
- Mind-Body Coaching
- Children's Holistic Health

**Geographic seeding**: pick ~8–10 US cities Amy's students would recognize (Asheville, Boulder, Sedona, Austin, Portland OR, Nashville, Charleston, Burlington VT, plus a couple of major metros — Atlanta, NYC area).

**Test by**: visit `/search`, search "gut", filter by Specialty + City, click into a profile, verify `/practitioners/[slug]` renders.

### Block D — Polish + demo dry-run (Thu morning)

- Verify all routes return 200
- Cross-browser sanity (Chrome + Safari mobile — Amy's likely demo surface)
- Capture screenshots/screen recording of: search flow + faceted filtering + practitioner profile → tuck into a "5/28 demo prep" doc
- Have a clear story arc for Amy: "Search finds them → Filter narrows → Profile shows what HHE-curated trust looks like"

## Anti-scope (do NOT build this week)

These are decisions-JSON YES rows that are Phase 1 but are second-week work, NOT 5/28-demo-load-bearing:
- `profile-claim` (MAYBE) — invite-only model means traditional claim is replaced by invite-acceptance, which is its own flow
- `practitioner invitation system` (full UX) — needs email infrastructure + auth providers, both not in Phase 0; seed admin-side data only
- `reindex-mark-dirty` cron — wire app-layer reindex on practitioner upsert this week, cron job is week-2 polish

## Operator-side TODO before demo

- [ ] Add `AUTH_SECRET` to Vercel envs (~30 sec)
- [ ] Provision Typesense (~10 min for Cloud signup, ~30 min for self-host)
- [x] ~~Enable `pg_trgm` in Neon~~ — done 2026-05-24 via migration
- [ ] Authorize Blake's GitHub collab invitation (Blake-side, pending since 2026-05-24)
- [ ] (Optional but recommended) Update `package.json` build script to `prisma migrate deploy && prisma generate && next build` — safer per-env migration via Neon branching

## Memory pointers

- `~/.claude/projects/-home-jgatlit-vault/memory/reference_practicenear_repo_topology.md` — full repo topology + DO NOT TOUCH boundary
- `~/.claude/projects/-home-jgatlit-vault/memory/reference_neon_vercel_prisma_integration.md` — Neon + Vercel + Prisma deployment integration gotchas

## What "demo success" looks like 5/28

Amy can:
1. Type a practitioner specialty keyword and see results filtered by it
2. Narrow by US city using the faceted filter
3. Click into a practitioner card and see a polished Linktree-style profile
4. Recognize HHE-students-first sourcing in the seed data (NOT a 60K NPI scrape vibe)

That's the threshold for Phase 1 → Phase 2 conversation. Anything beyond is gravy.
