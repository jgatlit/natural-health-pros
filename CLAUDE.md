# Claude Context — HHE Directory

> Read first. This file is the directive entry-point for AI agents working in this repo. Read in full before any task here.

## What this project is

**HHE Directory** — HHE-students-first practitioner directory + marketplace for Holistic Health Educators (HHE). Phase 0 stack live as of 2026-05-24. Currently building toward Phase 1 demo for in-person meeting with Amy (HHE budget authority) on 2026-05-28.

**Brand note**: This project was formerly called "PracticeNear" — that name was discontinued 2026-05-24 along with all legacy codebases. "HHE Directory" is the canonical go-forward brand. Historical artifacts (joint-call meeting note, decisions JSON, reconciliation doc, vault project entity filename) retain the "PracticeNear" name as point-in-time references; do not rename them.

## Stack (Phase 0 + Block A — live)

- Next.js 14.2.35 (App Router, `src/`, TS strict)
- **Tailwind 4.3 + shadcn/ui (`new-york` style, zinc base)** — primitives installed: Avatar, Badge, Button, Card, Separator, Skeleton. Config lives in `src/app/globals.css` via `@theme` (no `tailwind.config.ts`).
- Prisma 6.19 + PostgreSQL (Neon via Vercel Marketplace) — **`pg_trgm` extension live** + GIN trigram index on `Practitioner.searchText`
- NextAuth v5 (Auth.js) + Prisma adapter (no providers wired yet — Phase 0.5)
- Vercel Blob + Vercel KV / Upstash Ratelimit
- Sentry · Resend
- **Typesense Cloud** (cluster `1rt8fj5i9epv2s6mp`) + `react-instantsearch` + `react-instantsearch-nextjs` — live, env vars provisioned on Vercel for all 3 scopes

**Phase 2A also shipped** (2026-05-25): practitioner authentication via NextAuth + Resend magic-link, invitation system at `/admin/invites`, accept-invite flow → `/onboarding` → `/practitioners/[slug]/edit`. Middleware gates `/admin/*` + `/practitioners/[slug]/edit` + `/onboarding`. `ADMIN_EMAILS` env auto-promotes operator (jgatlit@gmail.com) on first sign-in.

**Phase 2B also shipped** (2026-05-25): practitioner-owned booking URLs (Cal.com / Calendly / SavvyCal / Acuity / etc.). Edit form has booking-link field with provider allowlist; public profile renders real `<a target="_blank">` link.

**Phase 2C BLOCKED** (2026-05-25): operator-locked architecture is Whop for Platforms (Connected Accounts — multi-tenant payment routing). Whop Platforms API is **invite-only**; current API key is standard creator-account scope. **Blake/Amy follow-up**: align on Whop as payments primitive + email sales@whop.com to request Platforms access.

**Phase 1 (Block A + B + C) shipped**:
- `/practitioners/[slug]` — Linktree-style profile, server-rendered (Block A)
- `/search` — InstantSearchNext + parametric/adaptive facets: keyword + typo tolerance, specialty (multi-select), city/state (single-select scoped), range facet (yearsInPractice), faceted autocomplete, mobile Sheet, URL state, sort
- Seed data: 18 practitioners across 13 cities (61% GA per operator directive)
- Typesense schema + indexer + bootstrap/reset/reindex scripts wired

## Where things are

| | |
|---|---|
| **Local cwd** | `~/projects/HHE/HHE-directory/` |
| **GitHub** | https://github.com/jgatlit/HHE-directory (public) |
| **Vercel project** | `ai-chemist/hhe-directory` — Vercel inspector: https://vercel.com/ai-chemist/hhe-directory |
| **Production URL** | https://hhe-directory.vercel.app |
| **Neon DB** | `neondb` @ `ep-plain-bird-ap6zr7b3.c-7.us-east-1.aws.neon.tech` (Marketplace-connected; branching per env) |
| **Typesense Cloud** | cluster `1rt8fj5i9epv2s6mp`, host `1rt8fj5i9epv2s6mp-1.a1.typesense.net`, collection `practitioners`, dashboard https://cloud.typesense.org |

## DO NOT touch (legacy / orphaned, per 5/24 operator directive)

These exist as historical reference. **Never modify, deploy to, or rename:**

- `jgatlit/holistic-health-marketplace` (fork) — withAuth wrapper donor; lifted into `src/lib/action-utils.ts`
- `tovesblake-max/holistic-health-marketplace` — Blake's upstream
- `jgatlit/practitionerDirectory` — Typesense search-arch donor; lifted into `src/lib/typesense.ts` + `deployment/typesense-collection-schema.json`
- `tovesblake-maxs-projects/practicenear` (Vercel project) — original marketing site. If `vercel link --project practicenear` is ever run, it WILL auto-link to this project across team scopes — caught us once during bootstrap. Always verify `.vercel/project.json` after link.
- `practicenear.vercel.app` (domain)
- `~/projects/HHE/PracticeNear/` (working folder — planning artifacts only, including the reconciliation doc)
- "PracticeNear" name itself

## Critical config gotchas

### Neon env-var prefix

Neon Marketplace integration prefixes all env vars with `hhe_directory_` (e.g., `hhe_directory_DATABASE_URL`). The Prisma schema references the prefixed names directly:

```prisma
datasource db {
  url       = env("hhe_directory_DATABASE_URL")           // pooled, runtime
  directUrl = env("hhe_directory_DATABASE_URL_UNPOOLED")  // unpooled, migrate
}
```

If the prefix is later removed in Vercel/Neon settings, schema needs a parallel edit. See `~/.claude/projects/-home-jgatlit-vault/memory/reference_neon_vercel_prisma_integration.md` for the broader pattern.

### Prisma reads `.env` not `.env.local`

After `vercel env pull .env.local`, also `cp .env.local .env` for Prisma CLI to find creds. `.env` is gitignored (added explicitly — `.env*.local` pattern doesn't match plain `.env`). Never commit `.env`.

### Phase 3 helpers stripped from action-utils.ts

`src/lib/action-utils.ts` was lifted from the fork. `requireConversationAccess()` was stripped because it depends on the `Conversation` model not in the Phase 0 schema. Reintroduce alongside `Conversation` schema when Phase 3 direct-messaging lands. There's a clearly-marked TODO block in the file.

## Build + deploy

- `git push origin main` → auto-deploys via Vercel GitHub App (verified 2026-05-24)
- Migration flow: `vercel env pull .env.local && cp .env.local .env && npm run db:migrate:dev --name <name>` → commit `prisma/migrations/` → push
- Migrations do NOT auto-apply on deploy (build runs `prisma generate && next build` only). Consider adding `prisma migrate deploy &&` to build script when Phase 1 starts adding regular migrations — safe given Neon branching per env.

## What's next

Phase 1 shipped + verified at https://hhe-directory.vercel.app (commits through `562d1af` + leave-behind `fb58286`). Amy meeting 2026-05-28.

**For Phase 2**: see `docs/PHASE-2-PLAN.md` — option space across 5 candidate wedges (auth+invite+claim, booking, payments, real practitioners, search hardening). Default sequence: 2A unlocks everything → 2D real practitioners → 2B booking → 2C payments (gated on Blake) → 2E hardening. Operator-overridable post-Amy meeting.

**For demo prep**: `docs/DEMO-PREP-5-28.md` — 3-act story + Q&A bank + recovery paths. Leave-behind for Amy: `docs/demo-prep/2026-05-28-amy-leave-behind.md`.

Phase 1 retrospective lives in `docs/PHASE-1-PLAN.md` (Blocks A/B/C/D all marked done).

**Post-Amy-meeting plan (2026-05-28)**: see `docs/2026-05-28-amy-meeting-plan.md` — V1 pilot greenlit (~20 practitioners, booking+payments, ~July 1). Two named priorities: (P1) rich practitioner landing-page redesign + ingest Amy's pilot spreadsheet/image-folder; (P2) consume design system from `cms.chem.dev` (slug TBD) + apply locked brand (white / forest-green / red-hot-pink / sage). Branding is locked but NOT yet applied (`globals.css` still default zinc). Canonical meeting record: `~/vault/300 Entities/Meetings/2026-05-28 HHE Ask Zuzu + Holistic Practitioner Directory - Dev & Strategy.md`.

## Reference artifacts (outside repo)

Authoritative source documents kept in the operator's vault / Downloads (vault is at `~/vault/`):

- **Joint-call meeting note**: `~/vault/300 Entities/Meetings/2026-05-15 HHE Amy Blake Jonathan - PracticeNear Joint Planning + New Repo Decision.md` — 53 feature decisions adjudicated live with Amy + Blake
- **53-feature decisions JSON**: `~/Downloads/practicenear-decisions-2026-05-15.json` — canonical scope lock (still authoritative for Phase 2 YES/MAYBE/NO rows)
- **Strategic reconciliation v2**: `~/projects/HHE/PracticeNear/STRATEGIC_RECONCILIATION_2026-05-18.md` — operator-authored sequencing plan; v2 doubles down on clean restart (do not read as a walk-back)
- **Project entity (vault)**: `~/vault/300 Entities/Projects/PracticeNear.md` — vault file name retained for wiki-link continuity; content reflects the rename and tracks Progress Log + Phase 2 queue
- **Operator's `Amy (HHE)` person entity**: `~/vault/300 Entities/People/Amy (HHE).md` — engagement-strategy synopsis (decision style, what frames land, what loses her)
- **Holistic Health Educators company entity**: `~/vault/300 Entities/Companies/Holistic Health Educators.md`
- **Project-side memory** (auto-loaded by Claude at this cwd): `~/.claude/projects/-home-jgatlit-projects-HHE-HHE-directory/memory/MEMORY.md` indexes 4 topic files — CSS bootstrap, seed strategy, Typesense/InstantSearch gotchas, Vercel env provisioning
- **Vault-side memory pointers**: `reference_practicenear_repo_topology` (broad context) + `reference_neon_vercel_prisma_integration` (deployment gotchas)

## Working agreements with the operator

- Don't add features beyond scope. Phase boundaries from decisions-JSON are load-bearing.
- Never deploy to or modify legacy artifacts (see DO NOT list above).
- Surface operator-decision points clearly when they arise (e.g., Vercel project name collisions, scope choices). Don't silently default to a guess that locks something in.
- Before recommending any work, check whether the meta-decision has been resolved (lock-honor was made 2026-05-24; future scope-shifts require new operator decision).

## House style for this project

- Match the fork's TypeScript conventions: `withAuth(...)`-shaped server actions, centralized `extractError()` with `USER:` prefix convention, IDOR-fix discipline (merge "not found" and "unauthorized" into a single response).
- Lift from donor (`practitionerDirectory`) for Phase 1 search architecture; lift from fork (`holistic-health-marketplace`) for general patterns. Never lift business logic — only patterns. The new repo's domain is HHE-students-first; the fork's domain is nationwide-NPI-scrape and is not a model.
- Prefer no comments unless they explain non-obvious WHY. Phase plan and reasoning belong in `docs/`, not in code comments.
