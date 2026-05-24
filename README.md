# HHE Directory

HHE-students-first practitioner directory. Go-forward brand for the directory work post-2026-05-24. Supersedes the **PracticeNear** name (discontinued 2026-05-24 along with all legacy codebases orphaned per `STRATEGIC_RECONCILIATION_2026-05-18`).

> **Naming note:** historical artifacts (joint-call meeting note, decisions JSON, reconciliation doc, vault project entity filename) still reference "PracticeNear" as the working name at the time. "HHE Directory" is the canonical go-forward brand.

## Stack

- Next.js 14.2 (App Router, src/, Tailwind)
- Prisma 6 + PostgreSQL (Neon via Vercel Marketplace)
- NextAuth v5 (Auth.js) + Prisma adapter
- Vercel Blob (file storage) + Vercel KV / Upstash Ratelimit
- Sentry (errors)
- Resend (email)
- Typesense + react-instantsearch (Phase 1 faceted search)

## Inherited patterns

- `src/lib/action-utils.ts` — `withAuth(...)` wrapper pattern lifted from `jgatlit/holistic-health-marketplace` (canonical fork, now legacy/orphaned). Encapsulates auth + error masking + rate-limit hooks per Decisions-JSON `withauth-wrappers: YES Phase 0`.
- `src/lib/typesense.ts` + `deployment/typesense-collection-schema.json` — lifted from `jgatlit/practitionerDirectory` (donor repo, also legacy/orphaned). Per Decisions-JSON `typesense: YES Phase 1`.

## Legacy / orphaned (DO NOT modify — do not apply breaking changes)

Per the 2026-05-15 joint-call decision + 2026-05-18 reconciliation + 2026-05-24 operator directive, these are kept as reference only:

- `jgatlit/holistic-health-marketplace` (fork) — withAuth wrapper donor
- `tovesblake-max/holistic-health-marketplace` (upstream) — Blake's original
- `jgatlit/practitionerDirectory` — search-arch donor
- `tovesblake-maxs-projects/practicenear` (Vercel) — original marketing site, leave intact
- `practicenear.vercel.app` domain — orphaned
- "PracticeNear" name itself — discontinued 2026-05-24

## Phase plan (53-feature adjudication, decisions-JSON 2026-05-15)

- **Phase 0** (this commit) — foundation: schema (User + Practitioner + Specialty + City + NextAuth tables), withAuth wrapper, Prisma client, rate-limit env-gated stub, NextAuth v5 skeleton.
- **Phase 1** — practitioner profile + linktree-style landing page + Typesense+InstantSearch faceted search (price/specialty/availability + haversine + pg_trgm + hierarchical tax) + practitioner invitation flow (net-new).
- **Phase 2** — notifications (Resend + in-app + web push) + Cal.com scheduling + indexable city pages (HHE-student locations only).
- **Phase 3** — auth hardening (MFA/TOTP + session-freshness) + WAP payments end-to-end + HIPAA module + direct messaging + care-match.
- **Phase 4** — clinical (intake forms + care timeline + client-held health journal).
- **Phase 5** — smart-scheduling + AI search agent + page-builder (future).

## Local dev

```bash
cp .env.example .env.local   # fill DATABASE_URL + AUTH_SECRET
npm install
npm run db:migrate:dev
npm run dev
```

## Reference artifacts (outside repo, historical naming retained)

- Joint-call meeting note: `~/vault/300 Entities/Meetings/2026-05-15 HHE Amy Blake Jonathan - PracticeNear Joint Planning + New Repo Decision.md`
- 53-feature decisions JSON: `~/Downloads/practicenear-decisions-2026-05-15.json`
- Strategic reconciliation (v2): `~/projects/HHE/PracticeNear/STRATEGIC_RECONCILIATION_2026-05-18.md` (legacy working-folder path retained)
- Project hub: `~/vault/300 Entities/Projects/PracticeNear.md` (vault filename retained for wiki-link continuity; content reflects the rename)
