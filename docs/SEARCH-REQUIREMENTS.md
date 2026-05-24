# Search & Discovery Requirements — HHE Directory

> **Purpose**: Engine-agnostic requirements doc to support the operator's research into three search-engine options for Block B/C of Phase 1.
>
> **Three options under research** (decision pending):
> 1. **Typesense Cloud** — managed Typesense (https://cloud.typesense.org)
> 2. **Typesense self-hosted** — on Railway, Fly, or Hetzner; Vercel hosts the Next.js app only
> 3. **Upstash Search** — Vercel Marketplace-native, managed serverless search (`upstash/upstash-search`)
>
> **Written**: 2026-05-24, after Block A shipped + Vercel Marketplace research confirmed Typesense cannot run on Vercel itself.

---

## 1. Decision context

### What is locked

- **Phase 1 wedge**: search-as-discovery for the 2026-05-28 Amy demo. The story is "search → filter → profile click-through" demonstrating HHE-curated trust.
- **Stack**: Next.js 14 App Router + Prisma 6 + Neon Postgres + Vercel deploy + Tailwind v4 + shadcn/ui.
- **Data model**: `Practitioner` table in Neon with hierarchical `Specialty` taxonomy, `City` join, lat/lng, denormalized `searchText`. See `prisma/schema.prisma`.
- **Phase 1 YES rows from the 5/15 decisions-JSON**:
  - `typesense` — declared engine choice, but reopened pending this research
  - `instantsearch-ui` — preferred client library (currently Typesense-adapter-shaped)
  - `haversine` — distance-based "near me" sort
  - `pgtrgm` — typo-tolerance backstop (already enabled in Neon)
  - `hierarchical-tax` — specialty taxonomy with parent/child unfolding
  - `reindex-mark-dirty` — app-layer reindex pattern (Phase 1 app-layer; Phase 2 cron)

### What is NOT locked (the research question)

- **Which engine actually runs the search**. The decisions-JSON listed Typesense but the meeting did not adjudicate Typesense Cloud vs self-hosted vs an alternative like Upstash. This is the operator-research decision.

### What the demo requires (5/28 acceptance bar)

Amy must be able to:
1. Type a specialty keyword and see results filtered by it
2. Narrow by US city using a faceted filter
3. Click into a practitioner card and land on the polished Linktree-style profile (Block A — already done)
4. Recognize HHE-students-first sourcing in the seed data (NOT 60K NPI scrape vibe)

---

## 2. Non-negotiable constraints

| Constraint | Why | Implication for engine choice |
|---|---|---|
| **Vercel hosts the Next.js app** | Phase 0 stack lock | App talks to search engine over HTTPS |
| **Neon is the source of truth** | All practitioner data lives in Postgres | Search engine is a denormalized index, never authoritative |
| **HHE-curated trust signal preserved** | Strategic wedge against legacy NPI-scrape codebase | Engine choice cannot leak through to "feels like a phonebook" |
| **Re-index from Neon must always work** | If the index dies, we restore from source-of-truth | Engine ops burden is bounded — worst-case is re-run the indexer |

---

## 3. Data model — what gets indexed

### Fields to index per practitioner

| Field | Type | Searchable | Facetable | Sortable | Notes |
|---|---|---|---|---|---|
| `id` | string | no | no | no | Primary key — used for upsert |
| `slug` | string | no | no | no | URL slug — used for click-through to `/practitioners/[slug]` |
| `displayName` | string | **yes** | no | yes (alpha) | "Dr. Maya Sullivan" |
| `bio` | text | **yes** | no | no | Long-form bio, weighted lower than name |
| `cityName` | string | **yes** | **yes** | no | "Atlanta" — flattened from `City.name` join |
| `cityState` | string | **yes** | **yes** | no | "GA" — flattened from `City.state` |
| `latitude` | float | no | no | **yes (geo)** | For haversine sort |
| `longitude` | float | no | no | **yes (geo)** | For haversine sort |
| `specialtyNames` | string[] | **yes** | **yes (hierarchical)** | no | Flattened list — both parent + child names ("Functional Medicine", "Hormone Balance") |
| `specialtySlugs` | string[] | no | **yes (hierarchical)** | no | For URL-stable facet filters |
| `acceptedAt` | timestamp | no | no | yes | Newest practitioners first sort |
| `searchText` | text | **yes** (typo-tolerant) | no | no | Composite field — name + bio + city + specialties for fallback Postgres path |

### Hierarchical specialty handling

The taxonomy is 2-level (4 parents + 4 children, currently). Two facet UX patterns matter:

- **Parent selected** → results matching either the parent OR any of its children should appear
- **Child selected** → only that child's results

Either the engine's hierarchical-facet primitive handles this natively, OR we flatten both parent + child names into `specialtyNames[]` and use OR-facet semantics. Both work; the engine choice may simplify or complicate this.

### Seed data (current state)

- 18 practitioners
- 13 cities (61% GA per operator directive)
- 8 specialties (4 parents + 4 children)
- See `prisma/seed.ts` and the seed memory at `~/.claude/projects/-home-jgatlit-projects-HHE-HHE-directory/memory/pattern_seed_strategy.md`

---

## 4. Functional requirements

### MUST (Phase 1, demo-bearing)

- **Keyword search** across `displayName`, `bio`, `cityName`, `specialtyNames`
- **Typo tolerance** — "gut helth" should find "gut health" (decisions-JSON `pgtrgm` row implies this is non-negotiable)
- **Specialty facet** — single or multi-select, hierarchical (parent selection includes children)
- **City facet** — single or multi-select, single-level (state inferred from city)
- **Combined facet + query** — Amy types "hormone" AND filters to Atlanta — both narrow the result set
- **Parametric / adaptive facets** — Amazon-style. Only facet values present in the current result set appear; counts live-update as filters apply; selecting one facet immediately re-narrows the other facets' available values. A facet category with zero matching values hides entirely until the result set widens to include them again. Required for the search to feel "intelligent" rather than "static checkbox tree." See §7 for concrete UX behavior.
- **Pagination** — at minimum page-of-N, ideally infinite scroll
- **Empty state** — "No practitioners match" with suggestion (clear filters, broaden query)

### SHOULD (Phase 1 stretch, OK to defer to Block D polish)

- **Haversine "near me"** — sort by distance from user-provided lat/lng (decisions-JSON `haversine` row)
- **Geolocation prompt** — browser API for lat/lng acquisition; fallback to city select
- **Result count display** — "18 practitioners · 11 in Georgia"
- **Saved filter URL state** — search query + facets in the URL so /search?q=hormone&city=atlanta is shareable
- **Range facets** — sliders or min/max inputs for numeric attributes (years of practice, intro-consult fee, distance from "me"). Live-update result count as the slider moves. Phase 1.5 candidates: years-of-practice + distance-from-me.
- **Boolean facets** — toggles for binary attributes (`acceptsNewPatients`, `telehealthAvailable`, `inNetworkWithMajorInsurance`). Schema-add candidates for Phase 1.5/2.
- **Faceted autocomplete** — typing "atl" surfaces "Atlanta, GA" as a clickable facet-selection chip (NOT just keyword text). Amazon's "did you mean this category?" pattern. Disambiguates between query intent (free-text) and filter intent (facet pick).
- **Sort selector** — relevance (default), distance from me, alphabetical, newest practitioners first. Sort persists across pagination.

### COULD (Phase 2)

- **Boosting by HHE-curation signal** — e.g., recent graduates of partner programs ranked higher
- **Boosting by intro-consult availability** — practitioners with current availability surface first
- **Semantic search** — vector-embedding-based, "find someone like Dr. Sullivan"
- **Synonym expansion** — "PCOS" matches "polycystic ovary syndrome"

### WON'T (out of scope)

- LLM-generated answers about practitioners (privacy + trust hazard)

---

## 5. Performance + scale requirements

### Phase 1 (today through 5/28)

- **Corpus size**: 18 practitioners (current seed). Realistic demo: stays at 18–20.
- **Query volume**: Single-user demo. ≤10 searches during the Amy meeting. PRODUCTION: hundreds per day.
- **Latency target**: p95 search response < 200ms over US-East mobile network. Below 200ms is the threshold for "feels instant."
- **Indexing latency**: app-layer reindex on practitioner upsert, completion within 60s tolerable.

### Phase 1.5 (post-demo through Phase 2 ramp)

- **Corpus**: 500-2,000 practitioners
- **Query volume**: low — operator + a handful of early HHE-graduate signups. 
- **Latency**: same target, p95 < 200ms

### Phase 2 (12–24 month projection)

- **Corpus**: 500–2,000 practitioners
- **Query volume**: 10K–50K searches/day (rough order-of-magnitude estimate; needs operator validation)
- **Latency**: p95 < 300ms acceptable at this scale
- **Concurrency**: 100s of simultaneous searches plausible

### Phase 3 (speculative, 36+ months)

- **Corpus**: 2K–10K practitioners (HHE national footprint).  Performance and capability must scale.
- **Query volume**: 100K+ searches/day.  Performance and capability must scale.
- The engine should not require a complete migration at this scale — but a tier-upgrade or instance-size bump is acceptable.

---

## 6. User journeys

### 6.1 Amy's demo journey — 2026-05-28 (the load-bearing flow)

```
Open /search (mobile Safari, in person at HHE office)
  ↓
See 18 practitioners + facet sidebar (specialty, city)
  ↓
Type "gut" in search box → results narrow to gut-health practitioners
  ↓
Tap "Atlanta" city facet → results narrow further
  ↓
Tap a practitioner card → /practitioners/[slug] profile renders (Block A — done)
  ↓
Back button → search state preserved
```

**Failure modes Amy would notice immediately**:
- Slow search (waiting >300ms feels broken on mobile)
- Empty result on a query that should match ("functional med" missing "Functional Medicine")
- Facet checkboxes that don't visibly update result count
- Result cards that look like generic phonebook entries (UX problem, not engine problem)
- Profile page broken or slow (Block A problem, not search)

### 6.2 Prospective HHE-student patient — Phase 2 future state

```
Referred to HHE Directory by their program (Lamonte's, Kieran's, etc.)
  ↓
Lands on /search
  ↓
Types specialty + location keyword
  ↓
Refines by intro-consult availability (Phase 2 facet — not in Phase 1)
  ↓
Compares 3-4 practitioner profiles
  ↓
Books intro-consult on the profile they trust most (Phase 2 booking — not in Phase 1)
```

### 6.3 HHE practitioner perspective (Phase 2)

```
Accepts HHE invitation → completes profile
  ↓
Practitioner data lands in Neon
  ↓
App-layer reindex fires on save → profile appears in search within 60s
  ↓
Practitioner can search their own name to verify appearance
```

This Phase 2 flow shapes the **reindex-mark-dirty** decisions-JSON row — Phase 1 does app-layer reindex, Phase 2 polish moves it to a cron-driven mark-and-sweep.

---

## 7. UX requirements — search page (`/search`)

### Layout

- **Mobile-first** — Amy's likely demo surface is Safari mobile. Design for 375×667 baseline.
- **Mobile**: single-column results; facets in a slide-up sheet (shadcn `Sheet` component pattern)
- **Tablet/Desktop**: 2-column layout — facets on the left, results on the right
- **Sticky search box** on mobile so it's always accessible during scroll

### Search box

- Single text input at the top
- Placeholder: something HHE-flavored, e.g., "Find a functional medicine practitioner near Atlanta"
- Debounced query: 300ms after last keystroke before firing the search (typing should feel responsive, not laggy)
- "Clear" affordance once there's text
- No autocomplete in Phase 1 (Phase 2 enhancement)

### Facets

- **Specialty facet**: hierarchical checkbox list with parent-collapsed-by-default. Selecting a parent selects all children. Show count per facet value.
- **City facet**: alphabetical checkbox list. Show state in parentheses ("Atlanta, GA"). Limit to cities present in current result set.
- **Selected-facet chips** at the top of results so the user sees what's narrowing things
- **Clear all** affordance

### Results

- Card format per practitioner:
  - Avatar (initials fallback, matching profile page style — Block A pattern reused)
  - Name (display name with optional credential)
  - City + state
  - Primary specialty badge + secondary badges
  - Optional 1-line bio truncation
  - Whole card is the click target → `/practitioners/[slug]`
- Mobile: single column, full-width cards
- Desktop: 2- or 3-column grid

### Parametric / adaptive facet behavior (Amazon-style reference)

The /search page must behave like a parametric retail-style faceted search, NOT a static filter sidebar. Concrete behaviors required:

| Behavior | Spec |
|---|---|
| **Adaptive facet visibility** | A facet category appears only if 2+ distinct values exist in the current result set. If filtering to "Atlanta" leaves only practitioners with one specialty, the specialty facet collapses. |
| **Live facet counts** | Every facet value shows the count of matching results IN THE CURRENT FILTERED SET (e.g., "Functional Medicine (4)"). Counts update on every facet selection without a full page reload. |
| **Zero-value facet pruning** | Facet values with 0 matching results in the current set are hidden (not just disabled). When the user clears a filter, hidden values reappear. |
| **Multi-value selection within a category** | "Specialty: Functional Medicine OR Gut Health" — selecting two values in the same category is OR; selecting values across categories is AND. Match Amazon's checkbox-within-category convention. |
| **Cross-facet AND semantics** | "Specialty: Functional Medicine AND City: Atlanta" narrows the result set to the intersection. Standard faceted-search convention. |
| **Selected-facet breadcrumb** | All active filters appear as removable chips at the top of results: `[× Functional Medicine] [× Atlanta] · 4 results`. Tapping the × clears that filter. |
| **Range facets** (Phase 1.5+) | Slider or min/max input. Result count + listing update on slider release (debounced). Range values that produce zero results visibly compressed (slider shows "no data here"). |
| **Faceted autocomplete** (Phase 1.5+) | Typing "atl" surfaces a dropdown with both keyword matches ("Atlanta in 4 bios") AND facet matches ("📍 Atlanta, GA — select as filter"). Clicking the facet match applies the filter instead of running a keyword search. |
| **Sort + filter coexistence** | Sort selector (relevance / distance / newest / alphabetical) lives next to the results header; changing sort does NOT reset filters. |
| **Filter state in URL** | Every filter + sort + query reflected in `/search?q=...&specialty=...&city=...&sort=...`. Back/forward navigation restores prior state. Shareable URL is a Phase 2 referral primitive. |

### Why this matters strategically

Parametric search is the difference between "I'm browsing a database" (feels like a phonebook — fails the HHE wedge) and "the directory is helping me find the right practitioner" (feels like a curated tool — confirms the wedge). For Amy's audience — patients navigating a wellness journey, not a SaaS dashboard — Amazon-style adaptive facets are the established mental model. They reduce cognitive load: the system shows what's possible from where you currently are, instead of forcing the user to read a static filter tree and guess which combinations have results.

### States

| State | Treatment |
|---|---|
| **Loading** | shadcn `Skeleton` placeholders for card grid (3-6 placeholders, matches expected result count) |
| **Empty** (initial visit, no query, no facet) | All 18 practitioners shown, sorted by `acceptedAt` desc (newest first) |
| **No results** | Friendly message + "Clear filters" + suggestion chips ("Try: Functional Medicine, Atlanta, Gut Health") |
| **Error** (engine down) | "Search is temporarily unavailable" + degraded path: show a static directory list pulled from Neon directly via Prisma |

### Accessibility

- Keyboard navigable (Tab through facets + cards; Enter to activate)
- Search box has explicit `aria-label`
- Facet checkboxes are real `<input type="checkbox">` for screen-reader support
- Result count announced via `aria-live="polite"` region when it changes

---

## 8. Operational requirements

### Indexing strategy

- **Phase 1**: App-layer reindex. Every time a practitioner is created or updated in Neon (via Prisma `create`/`update`), the same code path pushes a corresponding document to the search engine. Synchronous, simple. Acceptable latency: <2s per upsert.
- **Phase 1.5**: Add retry + dead-letter handling if the search engine is unreachable during an upsert. Practitioner data still lives in Neon — index can be rebuilt.
- **Phase 2**: Move to mark-dirty + cron-based reindex. Practitioner upsert sets `searchIndexDirty=true`; cron job every N minutes reads dirty rows and pushes. Better for batch + outage tolerance.

### Bootstrap re-index

A one-shot script (`scripts/typesense-index.ts` or equivalent) reads all practitioners from Neon, builds the document shape, and bulk-inserts to the search engine. Run on:
- First-time setup
- After schema changes
- Recovery from engine data loss

### Backup / DR

- **Source of truth is Neon.** If the search engine catastrophically loses data, run the bootstrap reindex script.
- **Engine-side backups** are nice-to-have but not load-bearing. The recovery RTO is bounded by "how long does a full re-index take" (for 18 rows: seconds; for 2K rows: minutes).

### Ops burden

The Phase 1 operator (Jonathan) has limited operational appetite. Hard ceiling: <30 min/month average ops burden once running. Anything beyond that has to be either automated (cron + alerts) or replaced.

### Cost ceiling

- **Phase 1**: <$10/mo for the engine. Demo doesn't need scale.
- **Phase 2 ramp**: <$50/mo until revenue justifies more.
- **Phase 2 mature**: cost should scale with practitioner count, not query volume. Operator preference is predictable monthly bills, not per-query.

---

## 9. Integration requirements

### Vercel envs

The engine must expose its endpoint + credentials via env vars consumable by both:
- **Server-side** (Vercel Functions running `prisma` + search-engine SDK): admin key for write/index operations
- **Client-side** (browser running React InstantSearch or equivalent): search-only key with limited permissions

Variables needed (illustrative names):
- `SEARCH_HOST` or `SEARCH_API_URL`
- `SEARCH_ADMIN_KEY` (server-only)
- `NEXT_PUBLIC_SEARCH_PUBLIC_KEY` (client-safe)

### Client library

- **First preference**: React InstantSearch + an engine adapter. The `react-instantsearch` + `typesense-instantsearch-adapter` packages are already in `package.json` from Phase 0 prefetch.
- **Fallback**: hand-rolled React hooks on top of the engine's REST API. Higher development cost; loses prefab UI primitives.

### Schema migration

When a new field is added to the `Practitioner` model (e.g., Phase 2 booking-availability):
1. Run Prisma migration
2. Update the search-engine collection schema
3. Re-run bootstrap reindex
4. Deploy app changes

The engine should support **additive schema changes without re-creating the collection**. If it doesn't, every field addition is a downtime event — disqualifying.

---

## 10. Evaluation criteria — research questions per option

The operator should be able to answer the following for each of the three options. Bring back the answers and we'll lock in the engine.

### Cost

| Question | Typesense Cloud | Typesense self-hosted | Upstash Search |
|---|---|---|---|
| Free tier? What does it cover? | | | |
| Cost at 18 practitioners, light dev traffic? | | | |
| Cost at 500 practitioners, 10K searches/day? | | | |
| Cost at 2,000 practitioners, 50K searches/day? | | | |
| Predictable monthly or usage-based? | | | |

### Ops burden

| Question | Typesense Cloud | Typesense self-hosted | Upstash Search |
|---|---|---|---|
| Who manages uptime? | Vendor | Operator (Railway/Fly) | Vendor |
| Who applies security patches? | Vendor | Operator | Vendor |
| Backup automated? | | | |
| Restart / scaling = automated? | | | |
| SLA / uptime guarantee? | | | |

### Feature parity vs requirements (Section 4)

| Feature | Typesense Cloud | Typesense self-hosted | Upstash Search |
|---|---|---|---|
| Typo tolerance | Yes (built-in) | Yes (built-in) | Verify |
| Hierarchical facets | Yes (via `nested` fields or flatten) | Yes (same) | Verify |
| Geo / haversine sort | Yes (`geopoint` field type) | Yes (same) | Verify |
| **Adaptive facet counts (Amazon-style)** | Yes (facets API returns counts per filter context) | Yes (same) | **Critical to verify** — table-stakes for the parametric UX |
| **Zero-value facet pruning** | Yes (engine returns only non-zero facet values when scoped) | Yes (same) | Verify |
| **Range facets** | Yes (numeric field + InstantSearch `RangeInput`/`RangeSlider`) | Yes (same) | Verify |
| **Faceted autocomplete** | Yes (combination of `query_by` + facet search endpoint) | Yes (same) | Verify |
| **Multi-sort orders** (relevance / geo / alphabetical / date) | Yes (per-query `sort_by`) | Yes (same) | Verify |
| Faceted filtering UX | InstantSearch adapter exists | Same | Verify — adapter? |
| React InstantSearch adapter | Yes (`typesense-instantsearch-adapter`) | Yes (same) | Verify |
| Schema additive changes | Yes (collection alter) | Yes (same) | Verify |

### Integration with Vercel stack

| Question | Typesense Cloud | Typesense self-hosted | Upstash Search |
|---|---|---|---|
| Vercel Marketplace integration? | No | No | **Yes** |
| Env vars auto-provisioned? | Manual | Manual | Auto |
| Billing through Vercel? | Separate | Separate (+ Railway) | Vercel-unified |
| Latency from Vercel us-east-1? | Verify (Typesense Cloud has us-east-1) | Depends on Railway region | Verify |

### Risk / portability

| Question | Typesense Cloud | Typesense self-hosted | Upstash Search |
|---|---|---|---|
| Open source? | Yes (Typesense is OSS, Cloud is the managed offering) | Yes | No (proprietary) |
| Migration path to different engine? | Re-index from Neon | Re-index from Neon | Re-index from Neon (but client code rewrites needed) |
| Donor doc applies? (`~/projects/HHE/practitionerDirectory/research/typesense-v30-implementation-guide-2025-11-07.md`) | Yes | Yes | No — partial |
| Vendor lock-in risk | Low (OSS escape hatch) | Lowest (you're already self-hosting) | Moderate (proprietary API) |

---

## 11. Open questions specifically for the operator's research

### Typesense Cloud (https://cloud.typesense.org)

1. **What's the entry tier price?** Last public pricing was ~$26/mo for the smallest cluster. Still current?
2. **What regions are available?** Need us-east-1 or us-east-2 for low latency from Vercel us-east default.
3. **Backup + DR story** — automatic snapshots? Restore complexity?
4. **SLA published** — uptime percentage commitment?

### Typesense self-hosted on Railway (or Fly / Hetzner)

1. **Typesense is RAM-hungry** — the entire corpus is held in memory. For 18 rows: trivial. For 500: ~256MB. For 2,000: ~1GB. Verify Railway tier required.
2. **Railway monthly cost** at the relevant RAM tier ($5–$20 estimated)
3. **Snapshot + restore** — Railway volumes support snapshots, but Typesense's own snapshot format also matters
4. **Single-node failure mode** — if the Railway instance restarts, what's the cold-start latency? Does the in-memory index need to be rebuilt from disk?
5. **TLS / auth surface** — Typesense ships with API-key auth but no native TLS termination. Railway provides TLS at the proxy. Verify the path.

### Upstash Search (`upstash/upstash-search` on Vercel Marketplace)

1. **API surface** — does it have first-class support for hierarchical facets + geo sort + typo tolerance?
2. **Pricing model** — request-based, doc-count-based, or hybrid? Free tier coverage?
3. **Client library** — is there a React InstantSearch adapter? If not, what's the search-client shape?
4. **Maturity** — when did Upstash Search go GA? Production-grade for our timeline?
5. **Hierarchical specialty handling** — manual flatten + OR semantics, or native nested support?
6. **Vendor pricing transparency** — Upstash is generally known for clear pricing; verify their search pricing page.
7. **Parametric facet primitives** — does the API return live counts per facet value scoped to the current filter context? Does it prune zero-value facets? These are table stakes for the Amazon-style UX described in §7 — if Upstash returns "all facet values regardless of current filters," the parametric UX has to be hand-built on top of the engine, which raises the development cost significantly.
8. **Range facets + numeric range queries** — Phase 1.5/2 schema additions (years of practice, fee, distance) need range filter primitives. Verify supported.

### Cross-cutting

1. Which option gives the **fastest path to production-ready search**? Managed options (Cloud, Upstash) win on this dimension over self-hosted.
2. Which option gives the **lowest total cost of ownership** at Phase 1.5/2 scale (500–2,000 practitioners, hundreds-to-tens-of-thousands of searches/day)?
3. Which option **most reduces ops burden** for an operator who explicitly does not want to babysit infrastructure?
4. Which option **preserves optionality** if the engine choice turns out to be wrong?
5. Which option **best supports the Amazon-style parametric facet UX (§7)** out of the box? Building parametric search manually on a less-capable engine triples the client-side complexity and risks visual jank as filters update.

---

## 12. Reference materials

- **Phase 1 plan**: `docs/PHASE-1-PLAN.md` (this repo)
- **Decisions-JSON** (canonical 5/15 scope lock): `~/Downloads/practicenear-decisions-2026-05-15.json`
- **Strategic reconciliation v2**: `~/projects/HHE/PracticeNear/STRATEGIC_RECONCILIATION_2026-05-18.md`
- **Joint-call meeting note** (Amy + Blake + Jonathan, 5/15): `~/vault/300 Entities/Meetings/2026-05-15 HHE Amy Blake Jonathan - PracticeNear Joint Planning + New Repo Decision.md`
- **Amy's engagement profile**: `~/vault/300 Entities/People/Amy (HHE).md`
- **Typesense donor doc** (covers Typesense v30 patterns; applies to Cloud + self-hosted): `~/projects/HHE/practitionerDirectory/research/typesense-v30-implementation-guide-2025-11-07.md`
- **Practitioner schema**: `prisma/schema.prisma`
- **Current seed**: `prisma/seed.ts` — 18 practitioners across 13 cities, 61% GA
- **Vercel Marketplace search result** (this session): Typesense not on Marketplace; closest matches are Upstash Search, Mixedbread Search

---

## 13. What this doc deliberately does NOT pre-decide

- **Engine choice** — that's the research question
- **Instance size / RAM tier** — depends on engine
- **Pricing tier** — depends on engine + projected ramp
- **Whether to use `react-instantsearch` or hand-roll** — depends on engine's adapter availability

Once the operator returns with research findings, the next step is a one-page decision memo locking the engine + sizing + estimated monthly cost. Then Block B (search infra) and Block C (search UI) build against that locked choice.
