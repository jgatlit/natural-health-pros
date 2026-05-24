# PracticeNear

HHE-students-first practitioner directory. Post-5/15 clean restart per `STRATEGIC_RECONCILIATION_2026-05-18` sequencing plan.

## Stack

- Next.js 14.2 (App Router, src/, Tailwind)
- Prisma 6 + PostgreSQL (Neon via Vercel Marketplace)
- NextAuth v5 (Auth.js) + Prisma adapter
- Vercel Blob (file storage) + Vercel KV / Upstash Ratelimit
- Sentry (errors)
- Resend (email)
- Typesense + react-instantsearch (Phase 1 faceted search)

## Inherited patterns

- `src/lib/action-utils.ts` — `withAuth(...)` wrapper pattern lifted from `jgatlit/holistic-health-marketplace` (canonical fork). Encapsulates auth + error masking + rate-limit hooks per Decisions-JSON `withauth-wrappers: YES Phase 0`.
- `src/lib/typesense.ts` + `deployment/typesense-collection-schema.json` — lifted from `jgatlit/practitionerDirectory` (donor repo). Per Decisions-JSON `typesense: YES Phase 1`.

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

## Reference artifacts (outside repo)

- Joint-call meeting note: `~/vault/300 Entities/Meetings/2026-05-15 HHE Amy Blake Jonathan - PracticeNear Joint Planning + New Repo Decision.md`
- 53-feature decisions JSON: `~/Downloads/practicenear-decisions-2026-05-15.json`
- Strategic reconciliation (v2): `~/projects/HHE/PracticeNear/STRATEGIC_RECONCILIATION_2026-05-18.md`
- Project hub: `~/vault/300 Entities/Projects/PracticeNear.md`
