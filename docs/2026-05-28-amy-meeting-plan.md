---
date: 2026-05-28
source_meeting: "~/vault/300 Entities/Meetings/2026-05-28 HHE Ask Zuzu + Holistic Practitioner Directory - Dev & Strategy.md"
transcript: "~/Documents/aiChemist.agency/HHE/2026May28-Amy-Jonathan/"
attendees: [Jonathan Gudger, Amy (HHE)]
project: HHE Directory (PracticeNear lineage)
status: build-ready plan — primed 2026-05-29
purpose: Requirements + prioritized build plan distilled from the 2026-05-28 Amy working session, scoped to this repo.
---

# HHE Directory — Plan from the 2026-05-28 Amy Session

> **Canonical record**: the full meeting note (decisions, quotes, attribution, Ask Zuzu workstream) lives in the vault at
> `~/vault/300 Entities/Meetings/2026-05-28 HHE Ask Zuzu + Holistic Practitioner Directory - Dev & Strategy.md`.
> This doc is the **repo-local, build-ready distillation** — only the directory-relevant requirements + the sequenced plan.
> Ask Zuzu (Kajabi transcript→course-ID mapping agent) is a **separate workstream**, not built in this repo — noted at the bottom for completeness.

## Headline outcome

Amy greenlit a **dated V1 pilot**: a *styled, real-data* directory with **~20 (min ~12) HHE practitioners**, **booking + payments**, target **~July 1, 2026** (~30 days). Hands-on build was to start on-site **2026-05-29**. Branding is **locked**. The two named operator priorities for this priming pass:

1. **Practitioner landing-page design** — ingest Amy's pilot list (Drive share, forthcoming) + design the optimal "rich landing page" frontend for the current architecture.
2. **Upstream visual design system** — consume the design system from `cms.chem.dev` (CMS slug forthcoming) and apply the locked brand.

Both top priorities are **blocked on a forthcoming input** (Amy's spreadsheet/images; the CMS slug). The work below is everything we can stage *now* so that when the inputs land, ingestion is a single pass.

---

## Locked decisions (directory-relevant)

| Decision | Detail |
|---|---|
| **V1 pilot scope** | ~20 practitioners (acceptable down to ~12), booking + payments, ~July 1 |
| **Booking + payments = must-win** | "the most meaningful part of the turnkey directory" |
| **Branding** | Pure **white background**, **forest-green** primary ("forest green *over* sage" — sage rejected as primary), **red-hot-pink** accent (instead of gold — "Mom likes gold"; gold acknowledged to pair well). Rejected the creamy tan/green "holistic vibe" AND the existing HHE white+blue ("feels clinical"). Clean, professional. **Secondary color ambiguous** — transcript shows both "sage" and "navy blue" floated; **confirm with Amy.** Tagline floated: *"Expert holistic healthcare — affordable and accessible."* Design riffing via **Google Stitch**. |
| **Payments model** | **WAP/Whop as a *platform*** — each practitioner their own connected account, payments flow through the central account, automated payouts + % fee. (NOT single-account-issuing-1099s; NOT Stripe — cost-prohibitive.) Gated on platform credentials + Blake pricing vet. |
| **HIPAA** | Upgrade to **HIPAA-compliant Vercel plan** to support user health-data (labs) upload + share-with-practitioner. Confirmed in-scope ("not difficult," cost "hundreds"). |
| **AI-driven search from day one** | Single Google-like bar; user types symptoms / "whole life story" → matched to practitioners. Quiz (à la Blake's PracticeNear quiz) as secondary path. |
| **Rich landing pages** | Practitioner profiles are **rich landing pages, not cards**; structured onboarding for normalized profiles; AI can generate landing pages from a rich intake form; practitioners add backend data incl. anonymized case studies to improve matching. |
| **First-session pricing** | Standard **< $100**; promo push to **≤ $75**. Success metric = **revenue generated for listed practitioners**. Idea: HHE covers first **$5,000** so students demo it for their own health. |
| **Hosting independence** | Currently on Blake's Vercel; code in GitHub → portable to our Vercel anytime (already is: `ai-chemist/hhe-directory`). |
| **Brand/legal entity** | Directory is a **separate business from HHE**; long-term aspirational name **"Amoria"** (future university + nationwide healthcare system). A direct name for the directory now is **TBD — Amy owns this decision** (named blocker). |
| **Legal** | Keep PMA (3pp, lawyer-approved). Shorten NDA (22→12pp, still too long; Kim Pakino refused to sign). Hannah to revamp. |

---

## Action items (this repo's surface)

**Jonathan / build:**
- [ ] Apply locked brand tokens (white / forest-green / pink / sage) — **quick win, do now** (see P-Brand)
- [ ] Rich practitioner landing-page template (vs current minimal Linktree card) — **P1**
- [ ] Ingest Amy's ~20-practitioner spreadsheet + Drive image folder → seed/import → invite flow — **P1, awaiting input**
- [ ] Symptom-based AI-driven search bar (core feature)
- [ ] Multi-booking-link support (initial limit: unlimited) — **already shipped** (`BookingLink[]` + `BookingLinksField`); verify only
- [ ] HIPAA-compliant health-file upload feature (Vercel HIPAA plan)
- [ ] WAP/Whop platform config once credentials arrive — **blocked** (Whop Platforms API invite-only; email sales@whop.com)
- [ ] `info@`/`admin@` forwarding once domain chosen

**Amy / operator-side (blockers we depend on):**
- [ ] **Directory domain/name** — named blocker, Amy owns
- [ ] **Spreadsheet of ~20 pilot practitioners** (name, bio, photo, email, website, …) — Drive share, the P1 unlock
- [ ] **Google Drive folder of profile images**, named to match the spreadsheet
- [ ] WAP account under shared email/pass + grant Jonathan access; call Blake re pricing
- [ ] Send PMA+NDA to Hannah; provide Rachael's contact for transcript pipeline

---

## P1 — Practitioner landing-page design + Amy's-list ingestion

**Goal:** Move from the current minimal Linktree card (`src/app/practitioners/[slug]/page.tsx`, `max-w-md`) to the "rich landing page" Amy wants, and stage a clean importer for her forthcoming spreadsheet + image folder.

### Current state (verified)
- Profile = single `max-w-md` shadcn `Card`: `PractitionerHeader` + `PractitionerLinks` (Linktree buttons) + `PractitionerBio`.
- Intake (`/practitioners/[slug]/edit`) collects: **displayName, bio, cityId, yearsInPractice, bookingLinks[], specialtyIds[]**. Whop payments section scaffolded.
- **Schema gaps vs Amy's spreadsheet fields** (name / bio / **picture** / email / **website**):
  - No **photo** field (Avatar uses initials fallback; Vercel Blob deferred to "Phase 2.5").
  - No **website** / external-link field (only booking links).
  - No **case-studies / anonymized-outcomes** field (Amy wants these as backend matching signal).
  - No **headline / tagline**, **modalities/approach long-form**, **virtual-vs-in-person** flag (70% online estimate), **languages**, **fee/first-session-price**.

### Staged work (do now, before the list lands)
1. **Schema additions** (one migration): `Practitioner.photoUrl String?`, `websiteUrl String?`, `headline String?`, `telehealth Boolean?`, `inPerson Boolean?`, `firstSessionPriceCents Int?`, plus a `CaseStudy` model (`title`, `summary`, `outcome`, `anonymized Boolean`, FK) — or a single `caseStudies Json?` if we want to defer the relational model. Keep it expand-only (Neon branch per env).
2. **Vercel Blob photo upload** — wire `@vercel/blob` (already a dep) into the edit form; this directly unblocks "picture" from Amy's image folder.
3. **Rich landing-page layout** — redesign `[slug]/page.tsx` into a real landing page: hero (photo + headline + city + specialties as branded chips), about/bio, modalities, case-studies/outcomes block, booking CTA(s) styled as the primary action, "Browse offerings / Request invoice" (Whop-gated). Keep server-rendered. Drive entirely off brand tokens so the design-system swap (P2) is a token change, not a rewrite.
4. **Importer script** — `scripts/import-pilot-practitioners.ts`: read Amy's spreadsheet (CSV/XLSX export) + image folder (filenames matched to rows), create `Practitioner` records (or `Invitation`s), upload images to Blob, reindex Typesense. **This is the single ingestion pass once the Drive share arrives.** Stub the column→field map now from the known fields; finalize when the real headers are seen.

### RECEIVED 2026-05-29 — Amy's pilot assets (inventoried)
Drive folder "HHE Graduate Directory": `HHE_Health_Network_Professionals_V1.xlsx` + 12 images. Spreadsheet staged at
`~/Documents/aiChemist.agency/HHE/2026May28-Amy-Jonathan/amy-assets/HHE_Health_Network_Professionals_V1.xlsx`.

**Source-of-truth note:** the images are downloads of monday.com `protected_static` assets (board `8382973`); the directory data lives in **Monday.com** ("HHE Health Network" board). For future syncs, the Monday board — not this one-off xlsx — is likely the upstream.

**Column → field map (xlsx headers in row 3, data rows 4–16):**

| xlsx col | header | → Prisma field | notes |
|---|---|---|---|
| A | Name | `displayName` + derive `slug` | |
| B | Brief bio | `bio` | long-form, clean |
| C | Professional email | `User.email` (invite) / contact | |
| D | Website **or** booking link | `websiteUrl` **and/or** `BookingLink.url` | **overloaded** — classify per row (see gaps) |
| E | Profile picture | `photoUrl` (→ Vercel Blob) | URL embeds filename → matches Drive file |
| F | Professional title | credentials/headline + seed for specialty normalization | free-text |
| G | "Who/how you help" (sentence) | `searchText` boost + matching context | **blank for several** |
| H | Item ID (auto) | external ref (Monday.com item id) | keep for sync |

**12 unique practitioners** (13 rows — **Tammi Cross duplicated** rows 8 & 15): Tara Garrison, Kellie Johnston, Jill Staudacher, Julie Ericson, Tammi Cross, Emily Teale, Jeanette Ricci, Gayle Parker Kelley, Juliette Steven, D.D. Black, Sarah Schindler, Debbie Hoelscher. (Floor of the "~20, min ~12" pilot target.)

**Image→practitioner map — VERIFIED 12/12, zero orphans.** Match key = **filename stem from col-E URL, case + extension insensitive** (Drive normalized `.JPG`→`.jpeg`, `.PNG`→`.png`, collapsed double-spaces). Mapping: `Tara Garrison Fitness Headshot.jpg`→Tara · `Kellie-73.jpg`→Kellie · `Drumming hide away - small.jpeg`→Julie · `Tammi Full Love color-1-7.jpeg`→Tammi · `IMG_6965.jpeg`→Emily · `IMG_0916.jpeg`→Jeanette · `IMG_4472.jpeg`→Gayle · `IMG_6728.png`→Juliette · `Trevor _ D.D. Mexico 2024.jpg`→D.D. Black · `15.png`→Sarah · `Tammi Headshot.jpeg`→Tammi(dup) · `portrait.jpg`→Debbie. **Importer match rule: lowercase the col-E basename, strip extension, match against lowercased-stripped Drive filenames.** Secondary images referenced in the sheet but NOT in Drive (optional gallery): `Kellie-40.jpg`, `Amongst the flowers.JPG` (Julie), `IMG_4468.jpeg` (Gayle).

**Data-quality gaps the importer MUST handle:**
1. **Jill Staudacher has no usable image** — her picture is `Jill Headshot.heic` (HEIC, not in the Drive folder, browser-unrenderable). Convert or re-request.
2. **Dedupe Tammi Cross** — one record, pick the better headshot.
3. **Classify column D** — website vs booking-link vs email-repeated-as-website (Tammi, Juliette) vs Facebook (Debbie). Only Emily's `calendly.com/emanneteale/30min` matches the booking allowlist.
4. **No city/location column** — the search has a **city facet** that can't be populated from this data. **Decision needed:** drop the city facet for V1, or collect locations from the 12.
5. **Free-text titles (col F)** → normalize into `Specialty` taxonomy (the meeting's "collapse synonyms" requirement). Seen: Holistic Health Coach, Therapeutic Nutritional Counselor, Reiki, CranioSacral, Foot Zone, Hypnotist, Shaman, MBSR, Cognitive Parenting, HTMA.
6. **Col G blank for Tara, Juliette, Sarah** — the AI-matching sentence is missing; backfill from bio or request.

**Still open:** import as live `Practitioner` records (operator-entered, faster for pilot) **or** as `Invitation`s (self-complete via 2A). Pilot speed favors operator-entered + optional later claim.

### Additional requirements surfaced verbatim (fold into design)
- **AI "one-shot" landing-page generation** — generate a normalized landing page per practitioner from the intake form: *"one shot per practitioner… it normalizes everybody's profile."* This is the onboarding default; practitioners can then customize.
- **Specialty-tag normalization (canonical synonyms)** — collapse synonyms to one tag: *"if someone's like gut health and then someone's like digestive disorders… they need to be the same thing."* Practitioners enter their own **or** select from a system-managed list; backend normalizes. Affects the `Specialty` taxonomy + Typesense facet — a real backend requirement, not just UI.
- **Case-studies "dump" for AI matching** — anonymized outcomes (*"40-year-old woman came in with these symptoms… resolved her case"*) stored as backend context the AI search reads, beyond what's visible on the page. *"If it's not on the landing page, it's not going to come up in search"* — so we need a backend field the matcher indexes.
- **Booking = checkout (paired)** — *"the booking link should be part of checkout… both happen at once."* When payments land (Whop), booking + pay are one action, not two.
- **Practitioner engagement choice** — each practitioner picks: full landing page with book-now, **or** a minimal card that just links out to their own site (referral-only, no money through the platform).
- **Optional "HHE certified" badge** — *"badges are cool"* — optional, not a quality ranking signal.

### V1 scope nuance (reconcile)
Amy's **V1 = search + rich landing pages + booking links + on-brand design**; payments + HIPAA file upload are explicitly *deferrable past V1* (*"it doesn't need to have all the features I'm describing"*). Jonathan framed **booking + payments** as the must-win for the *full* turnkey product. **Reconciliation:** ship V1 without live payments (booking link-outs only), keep the Whop scaffolding warm, turn payments on the moment Platforms access + WAP credentials land. Don't block V1 on Whop.

### Frontend-design recommendation for the current architecture
Next.js 14 App Router + Tailwind v4 `@theme` + shadcn/ui (new-york) + server components. The rich landing page should be **100% token-driven** (no hard-coded colors) so P2's design-system import is a `globals.css` token swap. Keep the profile a **server component** (SEO + share-ability matter for a directory). Use shadcn primitives already installed; add only what the rich layout needs.

---

## P1b — Evolving dual-label specialty taxonomy (Typesense-optimized)

**Operator requirement (2026-05-29):** specialty areas must **grow & evolve**; the app must keep **both** the practitioner's preferred/provided label **and** the system's normalized/canonical label, make **both searchable + intuitive** using the Typesense feature set optimally, **and** keep onboarding frictionless as the variety grows. This generalizes the meeting's "collapse gut-health = digestive-disorders" ask into a real architecture.

### Core principle
Separate the practitioner's **voice** (raw labels they provide) from the system's **canonical taxonomy** (curated, faceted). Display the voice; facet + match on the canonical; make both findable; let the taxonomy accrete through moderation rather than free-for-all.

### Current state (verified)
- `Specialty` is hierarchical (parent/child) via `PractitionerSpecialty`. The indexer flattens **parent + child canonical names** into `specialtyNames[]` (faceted) + `specialtySlugs[]`.
- **No synonyms configured**; **no embedding/vector field**. Collection schema: `deployment/typesense-collection-schema.json`. Practitioners currently must pick from a fixed checkbox list (`edit/page.tsx`) — the exact friction Amy flagged ("it's forcing this menu… they should be able to enter their own *or* select").

### Typesense features confirmed available (v30) and how each is used
| Feature | Role here |
|---|---|
| **Synonyms (multi-way)** | Query-time collapse of equivalent labels — *decoupled from indexing* (add a synonym = 1 API call, no reindex). The mechanism for "gut health ⇄ digestive disorders." |
| **Faceting on array field** | `specialtyNames[]` (canonical only) stays the clean, curated facet sidebar. |
| **Semantic / Hybrid Search (auto-embed, built-in model)** | Symptom→practitioner matching ("my stomach hurts" → gut-health) without exact keywords. No external API key (built-in S-BERT/E-5). |
| **Natural Language Search** | LLM converts free-form ("stressed, not sleeping") → structured filters on canonical specialties. |
| **Conversational Search (RAG)** | Amy's "type your whole life story → here's who we recommend." |
| **Separate collection + JOIN / autocomplete** | A `specialties` collection powers intake + search autocomplete (prefix + typo + infix). |

### Data model (Neon — source of truth)
- **`Specialty`** (canonical node): add `status (ACTIVE | PROPOSED | MERGED)`, `mergedIntoId?`. Keep `parentId` hierarchy.
- **`SpecialtyAlias`** (NEW): `label` (raw, normalized-lowercased), `specialtyId`→canonical, `source (PRACTITIONER | CURATED | IMPORT)`, `status (PENDING | APPROVED | REJECTED)`, `confidence?`. **This is the bridge** — every practitioner phrasing maps to a canonical; `PENDING` rows are the moderation queue.
- **`PractitionerSpecialty`** join: add **`rawLabel String?`** — preserves the exact phrasing the practitioner chose (their voice, shown on their profile), alongside the canonical `specialtyId` that drives facet + match.

Result: profile shows *"Gut Health Coach"* (rawLabel); facet + AI matching use *"Digestive Health"* (canonical). Both retained, both searchable.

### Typesense index (extend `practitioners` collection)
- `specialtyNames[]` (canonical, **facet:true**) — KEEP (clean facet list, parent rollup as today).
- `specialtyLabels[]` (practitioner raw labels, **index:true, facet:false**) — NEW: searchable so a practitioner's own words are findable, but kept *out* of the facet list so it stays curated.
- `searchText` — keep, include canonical + raw + bio.
- *(V2)* `embedding` (float[], `embed.from: [displayName, bio, specialtyNames, specialtyLabels]`, built-in model) — enables hybrid/semantic + the symptom search.
- **Synonyms**: a sync job pushes APPROVED `SpecialtyAlias` rows → Typesense multi-way synonym groups.

### Onboarding/intake flow (the "evolve as it grows" core)
Replace the fixed checkbox with a **combobox**:
1. Practitioner types → autocomplete queries the `specialties` collection (canonical + approved aliases; prefix/infix/typo) → suggests existing canonical tags ("Did you mean *Digestive Health*?").
2. They **pick an existing canonical** (ideal — no taxonomy growth) **or submit their own label** (voice preserved).
3. A novel label is normalized — **high confidence** (vector similarity vs `specialties`, or an LLM call since Amy wants AI-driven) → auto-mapped as an APPROVED alias; **low confidence** → `SpecialtyAlias status=PENDING`, practitioner proceeds live immediately with their raw label (never blocked).
4. **Admin moderation** (`/admin/specialties`, NEW): review pending → map to existing canonical, or promote to a new canonical node (+parent). Approval pushes a synonym + reindexes affected practitioners. **This is how the taxonomy grows cleanly.**

### Search-side UX
- Facet sidebar: canonical `specialtyNames[]` only (hierarchical unfold as today).
- Free-text: `query_by: displayName, specialtyLabels, specialtyNames, bio, searchText` + `query_by_weights` (labels/canonical high, bio low); synonyms expand the query; typo tolerance on.
- *(V2)* Hybrid + Natural-Language + Conversational layer for the "whole life story" symptom matching.

### Phasing (don't balloon V1) — **APPROVED 2026-05-29**
- **V1 (pilot):** dual-label model (`rawLabel` + canonical + `SpecialtyAlias`), facet on canonical, `specialtyLabels` searchable, **synonyms seeded from the 12 pilot practitioners' col-F titles + col-G "who I help"**, intake combobox (autocomplete + free-text + pending queue), `/admin/specialties` moderation. Keyword + synonyms is plenty for 12 people — **fully satisfies the requirement at pilot scale.**
- **V2 (scale):** add `embedding` + hybrid semantic search + LLM-assisted auto-mapping + Natural-Language / Conversational symptom search.

### Seed from the pilot data
The 12 practitioners' col-F titles become the **initial canonical set + alias map + synonym groups**: Holistic Health Coach, Therapeutic Nutritional Counselor, Reiki, Cranial Sacral Therapy, Foot Zone Therapy, Hypnosis, Shamanic Practice, MBSR, HTMA (hair analysis), Cognitive Parenting, Energy Medicine, Homeopathy, Microcurrent. This is the taxonomy's genesis.

---

## P1c — Onboarding LLM pipeline → static landing page → admin edits (APPROVED + CONFIRMED)

**Operator directive (2026-05-29):** onboarding should **scrape all inputs → one LLM call to extract/summarize/normalize → render into a go-forward *static* layout**; the practitioner then **edits field-level from their admin view**. The landing page must **accommodate all provided fields as a clean professional visual flow — NOT rigid field-level sections, NOT a form dump.** LLM normalization happens **at onboarding**, complementary to Typesense vector similarity for ongoing search + admin edits.

### The per-practitioner onboarding pipeline (one-shot at ingest)
1. **Collect all raw inputs.** Pilot: the xlsx row (name, bio, email, website/booking, picture, title, "who I help") + the matched Drive image. Go-forward: a rich intake form / Monday-board sync.
2. **Single LLM call → one structured JSON** (extract + summarize + normalize):
   - **Presentation:** `displayName`, `headline` (from title), `bioSummary` (cleaned, professional), `whoIHelp` (synthesize from bio when col-G is blank — fixes Tara/Juliette/Sarah), `modalities[]`.
   - **Classify the overloaded col-D** → `websiteUrl` and/or `bookingLink` (+ provider) vs email-repeat/junk.
   - **Specialty normalization (the Typesense-priming payload):** `rawLabels[]` (the practitioner's voice); per label a `canonical` (match existing `Specialty`, else `proposedNew` + suggested parent) + `confidence`; and `laySynonyms[]` per canonical (plain-language/symptom equivalents — e.g. "gut health, digestion, bloating" for *Therapeutic Nutritional Counselor*).
3. **Persist to Neon (source of truth):** `Practitioner` presentation fields; `PractitionerSpecialty.rawLabel` + canonical `specialtyId`; `SpecialtyAlias` rows (high-confidence → `APPROVED`, low → `PENDING`).
4. **Render the static landing page** from the persisted fields — designed visual flow (hero photo + name + headline, narrative bio, modality chips, "who I help", booking CTA). **No LLM at view time.** The LLM's normalization is what makes 12 unevenly-filled rows render *uniformly professional*.
5. **Admin field-level edit** thereafter — practitioner edits any field. On **specialty edits, Typesense vector similarity** (not a fresh LLM call) proposes the canonical in the combobox; re-save re-primes synonyms + reindexes. Optional "regenerate summary" re-runs the LLM on demand.

### CONFIRM — does the onboarding LLM optimally prime/feed/configure the Typesense native features? **YES.**
The onboarding call's structured output is explicitly shaped to *configure* the Typesense primitives:

| LLM onboarding output | → primes which Typesense native feature |
|---|---|
| `rawLabels[]` | `specialtyLabels[]` index field (**searchable**, not faceted) — the practitioner's voice is findable |
| canonical assignment | `specialtyNames[]` (**facet** field) — clean curated facet list |
| approved alias maps + `laySynonyms[]` | **multi-way Synonyms** (registered via API, no reindex) — the V1 symptom-bridge ("stomach hurts" → gut-health) |
| `bioSummary` + `whoIHelp` | `searchText` now; and the optimal **`embed.from`** input for **Semantic/Hybrid + Conversational (RAG)** later — same one-shot output primes V2 embeddings |
| classified `websiteUrl`/`bookingLink` | profile links + `BookingLink` rows |

**Complementary split (confirmed):**
- **LLM = write-time / onboarding intelligence** — one rich extraction that *seeds* the canonical taxonomy + aliases + Synonym groups (and pre-shapes future embedding text). Expensive but rare.
- **Typesense vector similarity = read-time / ongoing intelligence** — powers search and proposes canonical mappings for admin edits + future self-serve practitioners. Cheap, per-query, no LLM.
- They don't overlap: the LLM does the genesis once; Typesense's native features carry the ongoing load. → **"LLM onboarding optimally seeds Typesense."** ✅

### Seed data — clean + replace (APPROVED), but mine the taxonomy first
- **Remove the 18 fictional seed practitioners** (Maya Sullivan et al.); replace with the 12 real pilots via the onboarding pipeline above. (Per `docs/PHASE-2-PLAN.md` §2D, seed deletion was always planned once real data ≥15 — pilot is 12, so delete on cutover.)
- **KEEP + mine the seed's *specialty taxonomy* as canonical scaffold + synonym/dual-label test fixture** (per operator "CONSIDER"): the seed's 4 parents + 4 children — **Functional Medicine** → (Hormone Balance, Gut Health), **Holistic Nutrition** → (Children's Holistic Health), **Mind-Body Coaching** → (Stress / Sleep Optimization), **Herbal Medicine** — overlap conceptually with the real pilots' titles. Use them as:
  - the **genesis canonical set** the LLM maps the 12 pilots' raw labels against (e.g. "Therapeutic Nutritional Counselor" → *Gut Health*/*Holistic Nutrition*; "MBSR/Reiki/anxiety" → *Mind-Body Coaching* / *Stress-Sleep*; "hair tissue mineral analysis" → *Functional Medicine*);
  - **synonym test cases** to validate the multi-way collapse + dual-label search before real-data cutover (e.g. confirm a search for "digestive disorders" returns a practitioner who self-labeled "gut health").
- **No city/location data** in the pilot xlsx → either drop the city facet for V1 or collect locations (open decision from P1).

---

## P1d — Two-tier primary search bar (PRIMARY + SECONDARY symptom fallback)

**Operator focus (2026-05-29):** the search bar should do **(1) PRIMARY** keyword/synonym/Typesense-native/standard-DB search, **plus (2) SECONDARY** broader symptom/condition/topic matching *when PRIMARY returns nothing relevant* — without overcomplicating via premature LLM calls.

### CONFIRM — is PRIMARY already planned? **Mostly yes.**
Planned for V1 (P1b): keyword `query_by` (displayName / specialtyLabels / specialtyNames / bio / searchText) + **multi-way Synonyms** (dual-label collapse) + **typo tolerance** (Typesense native) + **pg_trgm** Postgres backstop (already enabled) + faceting. **Semantic/embedding is currently phased to V2** — see below for why that's the right home for it (it's the SECONDARY mechanism, not PRIMARY).

### Recommendation — tiered fallback that escalates only as needed (no premature LLM)
| Tier | Mechanism | LLM at query time? | Phase |
|---|---|---|---|
| **PRIMARY** | keyword + multi-way synonyms + typo + facets (+ pg_trgm backstop) | none | **V1** |
| **SECONDARY-a** | **symptom/condition/topic synonyms** seeded at onboarding into the existing Synonyms feature | **none** (seeded write-time) | **V1** |
| **SECONDARY-b** | **Typesense Semantic/Hybrid** (built-in S-BERT/E-5 embeddings), fired only when PRIMARY recall < N | **none external** — embeddings are native to Typesense, no per-query API cost | **V1.5/V2** |
| **GUIDED (separate surface)** | Natural-Language / Conversational (RAG) for "type your whole life story" | **yes, external LLM** — deliberate opt-in entry point, not the silent fallback | **V2+** |

### Why this is right-size
- **The cheapest big win is SECONDARY-a, and it's nearly free.** The onboarding LLM already emits `laySynonyms[]` per canonical (P1c). **Extend that to deliberately include symptom/condition/topic terms** ("bloating", "can't sleep", "anxiety", "fatigue", "low energy") as synonyms mapping → the relevant canonical. Then a symptom query resolves through the *existing* Synonyms feature — write-time LLM (already planned), **zero query-time LLM**. This covers the bulk of "search by symptom/condition/topic" for V1.
- **SECONDARY-b is the true semantic fallback, and it is NOT an external LLM call.** Typesense auto-embeds with a built-in model — no OpenAI/Anthropic key, no per-query API cost. So "broader symptom matching on novel phrasing" is achievable *without* the LLM cost the operator wants to avoid. Gate it on **low PRIMARY recall** (e.g. fire the vector pass only when keyword+synonym returns < N results) so it never adds latency to a query that already found good matches — this literally implements "SECONDARY fires when PRIMARY doesn't return relevant results." Can also be expressed as a single Typesense hybrid query with keyword weighted high, so exact matches rank first and semantic neighbors fill the tail.
- **External LLM has exactly one right-fit home: write-time onboarding** (seed synonyms now, pre-shape embedding text for later) — highest leverage, improves both PRIMARY and SECONDARY, zero query-time cost. The *only* justified query-time external-LLM use is the **explicit conversational "whole life story" surface** (Amy's aspirational vision) — and that should be a distinct opt-in ("Not sure where to start? Describe what's going on →"), **not** the default bar's silent fallback. Defer to V2+.

### Net answer to "is there a right-fit application for LLM here?"
**Yes — at onboarding (write-time), already planned. No — at the query-time SECONDARY fallback** (Typesense native vector covers it without external LLM). **Reserve external query-time LLM for a deliberate conversational entry point**, V2+. This gives Amy symptom/condition/topic search in V1 (via seeded synonyms) and true semantic fallback in V1.5/V2 (via native embeddings) with **no premature LLM calls anywhere in the hot path.**

---

## Implementation sequence — START HERE next session

> Target cwd: `~/projects/HHE/HHE-directory/`. Read `CLAUDE.md` (boundaries) → this doc. Branding is locked, V1 phasing + dual-label taxonomy + onboarding pipeline + search tiers are **APPROVED**. Build order:

1. **P-Brand** — apply locked brand tokens to `globals.css` (white / forest-green / red-hot-pink / sage). Screenshot-verify `/`, `/search`, `/practitioners/[slug]`. *(Decoupled from P2; do first so demos are on-brand. P2 later refines from the CMS slug.)*
2. **Schema migration** — `Specialty.status/mergedIntoId`, new `SpecialtyAlias`, `PractitionerSpecialty.rawLabel`; `Practitioner.photoUrl/websiteUrl/headline/telehealth/firstSessionPriceCents` + `CaseStudy`. Expand-only (Neon branch/env).
3. **Seed the genesis canonical taxonomy** from the existing seed tree (Functional Medicine→Hormone Balance/Gut Health · Holistic Nutrition→Children's · Mind-Body→Stress/Sleep · Herbal Medicine); keep as test fixture, then **remove the 18 fictional practitioners** on cutover.
4. **Onboarding pipeline** (`scripts/import-pilot-practitioners.ts`) — read `amy-assets/HHE_Health_Network_Professionals_V1.xlsx` (dedupe Tammi; classify col-D; match images by filename-stem; Jill = initials fallback or converted HEIC) → **one LLM call per practitioner** (extract/summarize/normalize → presentation fields + `rawLabels[]` + canonical map + `laySynonyms[]` incl. symptom terms) → persist Neon → upload images to Vercel Blob → register Typesense synonyms → reindex.
5. **Typesense collection delta** — add `specialtyLabels[]` (index, not facet); extend `searchText`; (V1.5) add `embedding` (`embed.from`) for SECONDARY-b. NB: schema change needs collection reset (see `gotcha_typesense_instantsearch.md`).
6. **Rich landing page** — rebuild `/practitioners/[slug]` token-driven, server-rendered, clean visual flow (hero/photo, narrative bio, modality chips, who-I-help, booking CTA). Renders from persisted fields (no LLM at view). **Baseline layout mockups exist:** `docs/mockups/practitioner-page-mockups.html` (+ `varA-centered.png` / `varB-twocol.png` / `varC-editorial.png`) — 3 grayscale layout-only variations on real pilot data (Kellie Johnston) with field→component map + render-states (initials / Virtual Practice / referral-only). Pick a variation, then apply the design system. **Recommended baseline = Variation A (centered single-column)**; colors/type are placeholders pending P2.
7. **Intake combobox + `/admin/specialties` moderation** — autocomplete vs `specialties` collection; free-text → PENDING queue; admin map/promote → push synonym + reindex.
8. **Search wiring** — PRIMARY `query_by` + synonyms + facets (V1); SECONDARY-b low-recall vector fallback (V1.5).
9. **Open decisions to resolve with operator before/while building** — (a) city facet: drop for V1 vs collect locations; (b) import as live records vs invitations; (c) Jill's image; (d) directory domain/name (Amy owns). P2 CMS slug arrives separately.

---

## P2 — Upstream visual design system from `cms.chem.dev`

**Goal:** Consume the design system / DTCG tokens published from the aiChemist CMS (`vps:~/apps/CMS`, served at `cms.chem.dev/{slug}`) and apply the locked brand to this repo.

### What we know
- The CMS 9-stage pipeline produces **DTCG tokens** → `tokens.css` per project slug, and a Penpot/Stitch design system. Ref: `~/.claude/projects/-home-jgatlit-Documents-aiChemist-agency/memory/reference_cms_design_pipeline.md`.
- This repo themes via **Tailwind v4 `@theme` + CSS custom properties** in `src/app/globals.css` (no `tailwind.config.ts`). Tokens map cleanly to the existing `--primary / --secondary / --accent / --background …` variables.
- **`globals.css` still ships default shadcn zinc** (`--primary: oklch(0.205 0 0)` ≈ near-black). The locked brand is **not yet applied** — this is the bridge point.

### Staged work (awaiting the CMS slug from you)
1. **Pull the slug's tokens** — `tokens.json` (DTCG) from `vps:~/apps/CMS/projects/{slug}/` (or the published `tokens.css`).
2. **Bridge DTCG → this repo's variables** — flatten DTCG to the `--primary/--secondary/--accent/--background/--ring/--border …` names the shadcn components reference (the ShowcasePage injection pattern from the CMS memory is the reference, but here it's a *static* one-time mapping into `globals.css :root`, not runtime injection).
3. **Encode the locked brand explicitly** if the CMS slug doesn't already carry it: white bg (`oklch(1 0 0)` — already), forest-green primary, red-hot-pink accent/destructive-adjacent, sage secondary. Convert to OKLCH to match the file's convention.
4. **Verify** with Playwright screenshots of `/`, `/search`, `/practitioners/[slug]` (the CMS pipeline's ≥90/100 quality gate is the standard).

### Decision needed from you
- Which **CMS slug** carries the design system to consume?
- Is the brand defined **in the CMS slug already**, or do we author it here and (optionally) round-trip it back into the CMS as the canonical design system for "Amoria"?

---

## P-Brand — Apply locked brand tokens (quick win, decoupled from P2)

Branding is **locked** regardless of the CMS slug. We can apply white / forest-green / pink / sage to `globals.css` `:root` **today** as a baseline, then let P2 refine/replace from the CMS source. This de-risks every demo between now and the CMS import. ~1 token block edit + screenshot verify.

---

## Quick wins / low-hanging fruit (high impact, low effort)

| Item | Effort | Why now |
|---|---|---|
| **Apply brand tokens** (P-Brand) | XS | Locked; every demo looks on-brand immediately |
| **Verify multi-booking-link** end-to-end | XS | Schema + field shipped; confirm it satisfies "unlimited links" ask |
| **Vercel Blob photo upload** | S | Unblocks Amy's image folder; replaces initials avatars (biggest "feels real" lift) |
| **`websiteUrl` field** | XS | Direct spreadsheet column; trivial add to edit form + profile |
| **Importer script scaffold** | S | Turns Amy's list into a one-pass ingestion the moment it lands |
| **Rotate Typesense admin key** | XS | Was pasted in chat during Phase 1 setup (security hygiene) |
| **Authorize Blake's GitHub collab invite** | XS | Pending; required if Blake contributes code |
| **Resend verified domain** | S | Currently sandbox (`onboarding@resend.dev`) — only delivers to operator; needed for real practitioner invites |

---

## Blocked / awaiting (track, don't start)

- **Domain/name** — Amy owns; blocks `info@`/`admin@` forwarding + final brand lockup.
- **Amy's spreadsheet + image folder** — unblocks P1 ingestion.
- **CMS slug** — unblocks P2.
- **Whop Platforms API access** — invite-only; email `sales@whop.com` (operator-side). Until then, payments UI shows "Pending access" (already handled in edit page). `WhopProduct` / `whopConnectedAccount` schema already scaffolded.
- **WAP/Whop credentials + Blake pricing vet** — operator-side.
- **HIPAA Vercel plan** — operator billing decision before health-file upload ships.

---

## Architecture notes (for the build session)

- Stack: Next.js 14.2 App Router (`src/`, TS strict) · Tailwind v4 `@theme` (globals.css) · shadcn/ui new-york · Prisma 6 + Neon (env vars prefixed `hhe_directory_`) · NextAuth v5 + Resend magic-link · Typesense Cloud · Vercel Blob/KV · Sentry.
- Schema already carries: multiple `BookingLink`s, full Whop `Connected Account` + `WhopProduct` + webhook scaffolding, `Invitation` flow, city/specialty taxonomy, `searchText` (pg_trgm) + Typesense indexer.
- Prisma reads `.env` (not `.env.local`) — `cp .env.local .env` after `vercel env pull`. Migration flow in CLAUDE.md.
- **DO NOT touch** legacy artifacts (PracticeNear Vercel project/domain, the two forks, the search-arch donor) — see CLAUDE.md "DO NOT touch."

---

## Separate workstream — Ask Zuzu (NOT this repo)

For completeness (canonical detail in the vault note): build an AI agent on the Ask Zuzu Google account connected to the Drive transcript folder → table mapping **each transcript → its Kajabi course ID** (fixes ~80–90% mis-mapping), with surgical spelling-correction rules (e.g., "DON" mis-transcribed "DAWN"). Label automated Kajabi replies as AI. Rachael = weekly-transcript source; schedule a workflow call with Denise + Rachael. Tracked separately from the directory build.
