# Claude Context — HHE Directory

> Read first. This file is the directive entry-point for AI agents working in this repo. Read in full before any task here.

## What this project is

**Natural Health Pros** — HHE-students-first practitioner directory + marketplace for Holistic Health Educators (HHE). Live at `naturalhealthpros.com` with the HHE pilot practitioners; open sign-up at `/join/hhe`. Amy is the HHE budget authority; Sarah Schindler is the practitioner-side owner.

**Brand note**: Product name lineage: "PracticeNear" (discontinued 2026-05-24) → "HHE Directory" (interim) → **"Natural Health Pros"** (canonical go-forward, rebranded 2026-06-29; domain `naturalhealthpros.com`). User-facing product copy uses "Natural Health Pros"; "Holistic Health Educators / HHE" is retained wherever it denotes the school/credential (positioning, "HHE program lead", "graduates of HHE programs"). Historical artifacts (joint-call meeting note, decisions JSON, reconciliation doc, vault project entity filename) retain the "PracticeNear" name as point-in-time references; do not rename them.

**Logo & favicon** (2026-09-29): the mark is the leaf-and-figure symbol (`natural-health-pros-d5-icon-only`). `public/brand/natural-health-pros-mark.svg` (light surfaces) and `…-mark-on-dark.svg` (navy header / OG card — lightens only the dark right leaf for contrast) drive `<Wordmark>`; `src/app/favicon.ico`, `icon.png`, `apple-icon.png` are the favicon set; `src/lib/brand-mark-data.ts` inlines the on-dark mark for the OG card. Masters and variants (SVG/PNG) live in `logo/master/`. This replaced the older node-and-filament glyph.

## Stack (live)

- Next.js 14.2.35 (App Router, `src/`, TS strict)
- **Tailwind 4.3 + shadcn/ui (`new-york` style)** — primitives installed: Avatar, Badge, Button, Card, Separator, Skeleton. Config lives in `src/app/globals.css` via `@theme` (no `tailwind.config.ts`). **Applied brand = CMS Theme D "Midnight Navy"** (midnight navy + rose-magenta + sage), shipped 2026-05-29 — NOT the default shadcn zinc (that base note is historical).
- Prisma 6.19 + PostgreSQL (Neon via Vercel Marketplace) — **`pg_trgm` extension live** + GIN trigram index on `Practitioner.searchText`
- NextAuth v5 (Auth.js) + Prisma adapter, Resend magic-link sign-in
- Vercel Blob + Vercel KV / Upstash Ratelimit
- Sentry · Resend
- **Typesense Cloud** (cluster `vm8gj01ubsi7hyxep`, Server v30.2) + `react-instantsearch` + `react-instantsearch-nextjs` — live, env vars provisioned on Vercel for all 3 scopes. (Original cluster `1rt8fj5i9epv2s6mp` was terminated 2026-06-24 and rebuilt same-day — see `docs/runbooks/typesense-cluster-rebuild.md`.)

**Shipped and live** (see `docs/2026-08-18-shipped-and-open-items.md` for the PR-level history):
- Practitioner authentication (NextAuth + Resend magic link), invitations at `/admin/invites`, `/onboarding` → `/practitioners/[slug]/edit`. Middleware gates `/admin/*`, `/practitioners/[slug]/edit` and `/onboarding`; `ADMIN_EMAILS` auto-promotes operators on first sign-in.
- Practitioner-owned booking URLs, the booking and checkout flow (`/practitioners/[slug]/book/[token]`), and Whop Connected Accounts for multi-tenant payment routing. Architecture and API notes: `docs/PHASE-2C-WHOP-CONNECTED-ACCOUNTS.md`.
- `/practitioners/[slug]` (server-rendered profile) and `/search` (InstantSearchNext + Typesense, adaptive facets, URL state).
- Open sign-up at `/join/<cohort>` (cohort `hhe`) with `/admin/signups`; each practitioner has a `recruiterToken` and a join link.
- A private "open to outside work" question (`Practitioner.openToOutsideWork`): owner and admin only, never on the public profile, never indexed in Typesense.
- Custom profile sections (`ProfileSection`) with Blob image and video uploads; the CSP `media-src` in `next.config.mjs` is pinned to the Blob store host.
- Edit-page left navigation with scroll-spy (`src/components/practitioners/EditSideNav.tsx`, entries in `src/app/practitioners/[slug]/edit/edit-nav.ts`).
- Rate schedules, referral and affiliate ledgers, and the admin "needs attention" table at `/admin/commercial-settings`. See "Money model" below.

## Where things are

| | |
|---|---|
| **Local cwd** | `~/projects/HHE/HHE-directory/` (folder unchanged) |
| **GitHub** | https://github.com/jgatlit/natural-health-pros (public; renamed from `HHE-directory` 2026-06-29, GitHub keeps redirects) |
| **Vercel project** | `ai-chemist/natural-health-pros` — inspector: https://vercel.com/ai-chemist/natural-health-pros (**renamed** from `hhe-directory` 2026-07-16 as the final launch step; project id `prj_hILUAi7uYNQfCJkcXlX4mG4Kn32E` unchanged, so the local `.vercel` link + deploy hook still resolve). ⚠️ Vercel refreshes the auto `.vercel.app` alias only on the NEXT deployment — `hhe-directory.vercel.app` may keep serving and `natural-health-pros.vercel.app` may 404 until then. Cosmetic; `naturalhealthpros.com` is canonical. |
| **Production URL** | **`naturalhealthpros.com` — LIVE over HTTPS** (cutover 2026-07-15). Apex `A → 76.76.21.21` (DNS-only, replaced the GoDaddy builder), `www` CNAME → `cname.vercel-dns.com` (DNS-only); Let's Encrypt cert; Vercel domain `verified:true`. Zone `naturalhealthpros.com` (id `3ec2cb56dd0ad83824440b2e802ff73c`) lives in **Jonathan's own Cloudflare account**, editable via `ssh vps:~/apps/cloudflare/` (`cfapi` wrapper) — DNS was never gated on Amy's domain-admin auth; that was a phantom blocker. **Auth gates ON** since 2026-07-16 (PR #22): `/admin` needs ADMIN, `/edit` needs sign-in + ownership, `/onboarding` needs a valid invite; `/search` + profiles stay public. |
| **Neon DB** | `neondb` @ `ep-plain-bird-ap6zr7b3.c-7.us-east-1.aws.neon.tech` (Marketplace-connected; branching per env) |
| **Typesense Cloud** | cluster `vm8gj01ubsi7hyxep` (Server v30.2), host `vm8gj01ubsi7hyxep-1.a2.typesense.net`, collection `practitioners`, dashboard https://cloud.typesense.org (rebuilt 2026-06-24; prior cluster `1rt8fj5i9epv2s6mp` terminated) |

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
- Migrations **DO** auto-apply on deploy — build is `prisma migrate deploy && prisma generate && next build`. This makes expand/contract mandatory: the migration applies during build while the PREVIOUS deploy still serves traffic, so a migration must never break the currently-live code (add the column now, drop the old one a release later).
- **Git auto-deploy works, but can be SLOW — don't mistake slow for broken.** Usually a merge deploys within seconds (PR #35: merge 19:09:14 → deploy 19:09:18). But on 2026-07-16 PR #34's deploy took **~10 minutes to start**, and another sat at `● Initializing` for **~12 minutes** before building normally. Both eventually succeeded on their own. Wait ~15 min before concluding anything is wrong; a CLI `vercel --prod --yes` fired impatiently just races the git deploy and creates duplicate production deployments.
- **Verify what is actually LIVE, never infer it from status codes.** While a slow deploy is in flight the previous deployment keeps serving — the site returns 200 everywhere while running old code. Compare deployment IDs instead:
  ```bash
  curl -s https://naturalhealthpros.com/ | grep -o 'dpl_[A-Za-z0-9]*' | head -1   # what the apex serves
  ```
  then match it against the deployment's git SHA via the REST API (`/v13/deployments/<dpl_id>` → `meta.githubCommitSha`). Note `vercel ls --prod` is unreliable for this: it has shown a 6h-old deploy as "newest" while a newer one was live.

## Rates

Rates live only in the database, as immutable content-addressed `RateSchedule` rows. Each practitioner maps to one schedule (`Practitioner.rateScheduleId`, history in `RateScheduleAssignment`). Admins edit schedules at `/admin/commercial-settings`: a save finds or creates a schedule for NEW sign-ups; existing practitioners move only through the audited "migrate cohort" action. There is no rate env var and no literal rate default (`tests/no-rate-literals.test.ts`), and a practitioner with no schedule fails closed at checkout. Never hardcode a price, percentage or term in code or copy; read them from the schedule (`src/lib/pricing-plans.ts` builds copy from one).

Schedule v1 "Go-forward 2026-10" (seeded in migration `20261014150000_rate_schedules_fee_rule_v15`):

- Plan A: $39/month plus 10% on NHP-attributed sessions (yearly price derived: $374.40). Plan B: $0 plus 30% on NHP-attributed sessions.
- Client referral (`nhpr`): 30% in all, 20% to the referring practitioner plus 10% to NHP, for 4 months; then the plan rate until the 8-month lead term ends; then 0%.
- Recruiter affiliate (`nhpa`): 3% of the gross of every payment of the recruited practitioner, indefinitely.
- A practitioner's own audience (`?ref`) is 0%. Total fees never exceed 30%.

The rule is `resolveSessionFee` in `src/lib/referral-fees.ts`. `nhpa` is captured from the signed cookie of the browser that redeems the sign-in link at `/join/<cohort>?nhpa=<recruiterToken>`; a cross-device sign-up records no recruiter (fix planned, vault task `tsk_7e75bcc931a64749a8fd`).

## Money model

- Every internal NHP, practitioner, referral, affiliate and recruiting fee is computed on the full purchase price and moved by an internal Whop-to-Whop transfer when the client's payment clears. Whop's own payout (withdrawal) fee is each user's matter and appears in no share or ledger figure.
- The recruiter's 3% is paid immediately with no hold. A refund before the transfer reduces the share; a refund after it becomes a debit netted off that person's next transfer.
- `referral_hold_days` (90) is only the unclaimed-share window for a payee who cannot yet receive money.
- Transfers are OFF in production. Flags (`.env.example`): `WHOP_TRANSFERS_ENABLED`, `WHOP_TRANSFERS_ALLOWLIST`, `WHOP_TRANSFERS_IDEMPOTENCE_VERIFIED`, `WHOP_TRANSFERS_LOOKUP_VERIFIED`. Do not enable any before Whop business verification and the canary in `docs/runbooks/transfers-canary.md`.
- One-page reference with the data model and the file for each rule: `docs/money-model.md`.

## Migrations

- Never point a shadow database, `prisma migrate dev`, `migrate reset` or any destructive Prisma command at the production Neon URL (`.env` is production). A shadow DB is disposable: on 2026-08-27 `prisma migrate diff --shadow-database-url` against production wiped the live database.
- Generate migrations offline on a local Docker Postgres (schema to schema with `prisma migrate diff --from-schema-datamodel` / `--to-schema-datamodel`), then hand-check the SQL. Every diff proposes `DROP INDEX "Practitioner_searchText_trgm_idx"` (a raw-SQL index the schema cannot express); remove it from the migration.
- Migrations are expand-only. `npm run build` runs `prisma migrate deploy` against whatever `.env` points at, so run `npx next build` locally.
- The chain currently ends at `20261015122000_transfer_attention_and_allocations`. The history cannot be replayed on an empty database: migration `20260524141519_pg_trgm_search` references `Practitioner` before `20260524173856_init` creates it. Preview deploys and fresh databases are affected; fixing it is an operator decision (baseline or `migrate resolve`).

## Where the runbooks are

- `docs/money-model.md`: rates, payouts, flags, where each rule is implemented.
- `docs/runbooks/transfers-canary.md`: enabling transfers safely, resolving ambiguous rows.
- `docs/runbooks/`: also `auth-middleware-missing-adapter.md`, `notfound-streaming-200.md`, `resend-domain-verification.md`, `typesense-cluster-rebuild.md`.
- `docs/routes-index.html`: every route, generated from `scripts/routes-meta.ts` by `npm run docs:routes`.
- `docs/PHASE-2C-WHOP-CONNECTED-ACCOUNTS.md`: Whop Connected Accounts architecture and API notes.
- `docs/2026-08-18-shipped-and-open-items.md`: shipped history and open items.

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
- **Primers** (`primers/`): the 2026-09-15 triage-context primer and the 2026-09-03 call primer are point-in-time records of those calls. Each carries a banner naming this file and `docs/money-model.md` as the current source for rates and payouts.

### Current engagement state (as of 2026-10-15)

- Practitioners choose Plan A (subscription plus a lower sourced-session rate) or Plan B (no subscription, higher sourced-session rate). Both require a Whop account. The numbers are in the database (see "Rates").
- Sarah Schindler announced the directory to the listed practitioners on 2026-09-04. Open sign-up at `/join/hhe` is the current acquisition path; recruiter and referral links carry `nhpa` and `nhpr`.
- Payout transfers are off in production (see "Money model"). Nothing on the payout side is switched on before Whop business verification of the parent company and the canary.
- Marketing targets consumers, not practitioner acquisition. There is no free listing-only tier; paid featured placement waits for consumer traffic.
- Before telling Amy or Sarah that something is live, compare deployment ids as described in "Build + deploy".

## Working agreements with the operator

- Don't add features beyond scope. Phase boundaries from decisions-JSON are load-bearing.
- Never deploy to or modify legacy artifacts (see DO NOT list above).
- Surface operator-decision points clearly when they arise (e.g., Vercel project name collisions, scope choices). Don't silently default to a guess that locks something in.
- Before recommending any work, check whether the meta-decision has been resolved (lock-honor was made 2026-05-24; future scope-shifts require new operator decision).

## House style for this project

- Match the fork's TypeScript conventions: `withAuth(...)`-shaped server actions, centralized `extractError()` with `USER:` prefix convention, IDOR-fix discipline (merge "not found" and "unauthorized" into a single response).
- Lift from donor (`practitionerDirectory`) for Phase 1 search architecture; lift from fork (`holistic-health-marketplace`) for general patterns. Never lift business logic — only patterns. The new repo's domain is HHE-students-first; the fork's domain is nationwide-NPI-scrape and is not a model.
- Prefer no comments unless they explain non-obvious WHY. Phase plan and reasoning belong in `docs/`, not in code comments.
