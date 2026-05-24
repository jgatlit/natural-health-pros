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

## Hard prerequisites (all resolved)

1. **`AUTH_SECRET` env var added to Vercel** — NextAuth requires it before any provider lands. `openssl rand -base64 32` → `vercel env add AUTH_SECRET production`, `preview`, `development`. (Still operator-side TODO; not yet provisioned. Not gating Block B/C since no auth providers wired yet.)
2. ~~Typesense provisioned~~ — **DONE 2026-05-24**: Typesense Cloud cluster `1rt8fj5i9epv2s6mp` live. All 5 env vars (`TYPESENSE_HOST`, `TYPESENSE_PORT`, `TYPESENSE_PROTOCOL`, `TYPESENSE_ADMIN_API_KEY`, `NEXT_PUBLIC_TYPESENSE_HOST`, `NEXT_PUBLIC_TYPESENSE_SEARCH_API_KEY`) provisioned to production, preview, and development scopes. See `docs/SEARCH-SETUP.md`.
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

### Block B — Search infrastructure (Tue, ~4 hr) — **DONE 2026-05-24**

Shipped:
- `src/lib/typesense-server.ts` — admin client (lazy-init, server-only)
- `src/lib/typesense-search.ts` — InstantSearch adapter w/ query_by weights + `additionalSearchParameters`
- `src/lib/typesense-client.ts` — search-only SearchClient for client-side facet queries (autocomplete)
- `src/lib/practitioner-indexer.ts` — `toTypesenseDoc` (hierarchical-flatten parent+child specialties), `indexPractitioner`, `indexAllPractitioners`, `deleteFromIndex` — all no-op if envs missing
- `scripts/typesense-bootstrap.ts` / `typesense-reset.ts` / `typesense-index.ts` — wired as `npm run typesense:bootstrap` / `reset` / `reindex`
- `deployment/typesense-collection-schema.json` — refined to match SEARCH-REQUIREMENTS §3 (slug, displayName, bio, cityName, cityState, location/geopoint, specialtyNames[], specialtySlugs[], acceptedAt, yearsInPractice, searchText)
- Migration `20260524141519_pg_trgm_search` applied
- `prisma/seed.ts` — 18 practitioners, includes `yearsInPractice` Phase 1.5 stretch field

### Block C — Search UI + seed data (Wed, ~4 hr) — **DONE 2026-05-24** (includes all parking-lot items)

Shipped:
- `src/app/search/{page,loading}.tsx` — InstantSearchNext root, mobile-first, parametric/adaptive UX per §7
- `src/components/search/SearchExperience.tsx` — main composition (search box + facets + results + sort + mobile sheet)
- `src/components/search/SearchBox.tsx` — debounced shadcn-styled input + suggestions dropdown
- `src/components/search/SearchSuggestions.tsx` — faceted autocomplete via Typesense `facet_query`
- `src/components/search/RefinementGroup.tsx` — adaptive facets w/ zero-value pruning, configurable `operator`
- `src/components/search/RangeFacet.tsx` — useRange-driven min/max for `yearsInPractice`
- `src/components/search/MobileFiltersSheet.tsx` — shadcn Sheet trigger w/ active-count badge (hidden md:up)
- `src/components/search/CurrentRefinements.tsx` — removable breadcrumb chips + Clear all
- `src/components/search/SortBy.tsx` — relevance / newest / alphabetical
- `src/components/search/SearchResults.tsx` + `PractitionerHit.tsx` — Hits + cards reusing Block A shadcn primitives

**Live**: https://hhe-directory.vercel.app/search

**Out of scope (locked-in trade-offs)**: city/state facets are single-select (`operator='and'`) to preserve cross-facet conjunctive scoping. Specialty stays multi-select (`operator='or'`). Phase 2 reconsider if multi-city is needed.

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
- [x] ~~Provision Typesense~~ — done 2026-05-24 via Typesense Cloud cluster `1rt8fj5i9epv2s6mp`
- [x] ~~Enable `pg_trgm` in Neon~~ — done 2026-05-24 via migration
- [ ] **Rotate Typesense Cloud admin API key** (was pasted in chat during initial setup)
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
