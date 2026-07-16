# Next Session Prime — Natural Health Pros

> **Written 2026-07-16**, immediately post-launch. Read this first. Everything below was verified live, not assumed.

## 0. Where we are

Public launch is **complete** (2026-07-16):

| | |
|---|---|
| `https://naturalhealthpros.com` | LIVE over HTTPS (Let's Encrypt → 2026-10-14) |
| Transactional email | LIVE from `agent@naturalhealthpros.com`, inbox-delivering |
| Auth gates | **ON** — verified on prod (gated → 307 → `/auth/signin`; public → 200) |
| Vercel project | renamed `natural-health-pros` |

Records: PR #22 (gates), PR #23 (doc sync), issue #25 (launch record, closed), issue #24 (follow-up, open).

**Guardrail:** auth gates are ON deliberately. Do **not** re-disable them. The memory `project-admin-gate-no-auth-approved` is CLOSED/inverted — if you read anything saying "auth is intentionally off, don't revert," that is stale.

---

## 1. 🚨 IMMEDIATE PRIORITY — e2e practitioner onboarding flow tests

### ⚠️ FIRST: live breakage found 2026-07-16 (fix before/with the tests)

**All 12 pilot practitioner invitations EXPIRED `2026-06-28`.** Verified against prod DB.

`/onboarding` gates (restored in PR #22) require: session **+ invitation exists + invitation not expired + `session.user.email === invitation.email`**. With every pilot invite expired, **all 12 pilots are currently locked out of onboarding** → `redirect('/auth/error?error=Verification')`.

This was latent while gates were off (invitation was optional during the 2026-07-09→07-16 no-auth window). The gate flip surfaced it. Nobody has hit it yet because no pilot has ever signed in (`emailVerified: null` on all 12).

**Fix path — already built, no new code:** `resendInvitation` (`src/app/admin/invites/actions.ts`, PR #20 `d1becbd`) reactivates an expired/revoked invite **with a fresh token** and sends the email. It refuses to touch already-accepted invites, so dead links stay dead. Email now works (verified inbox delivery), so this is unblocked.

> ⛔ **Sending invites = real emails to real practitioners.** Get explicit operator go before any bulk resend. Recommend proving the full flow on ONE address first (e.g. a `+alias`), then batching.

Current invitation table (14 rows): 1 admin (`jgatlit@gmail.com`, accepted ✅) · 12 pilots (**all expired 6/28**) · 1 test row (`jgatlit+resendtest@gmail.com`, `expiresAt` epoch = revoked marker).

### Test design (operator-specified)

Two **independent, parallel** lanes, findings **merged** at the end. Independence is the point — neither lane should see the other's results until merge, so they don't converge on the same blind spots.

| Lane | Driver | Strength |
|---|---|---|
| **Operator-driven** | Human, real inbox, real browser | Catches deliverability, UX friction, email rendering, real-world timing — things automation can't see |
| **Agent-driven** | Automated browser | Catches gate/redirect correctness, state transitions, repeatable regressions |

**Merge output:** one findings doc reconciling both — specifically flag anything only ONE lane caught, since that's where the method earned its keep.

### The flow to cover (now fully gated)

1. Admin creates/resends invite at `/admin/invites` — *requires ADMIN session*
2. Invite email → `/auth/invite-accept/[token]`
3. Magic-link sign-in `/auth/signin` → Resend email → session
4. `/onboarding?invitation=<token>` — **gates: session · invite exists · not expired · email-match**
5. Onboarding form → AI-generates landing (`draftProfile()` / `submitOnboarding`)
6. `/practitioners/[slug]/edit` — **gates: session + ownership (`isOwner || isAdmin`)**
7. Public `/practitioners/[slug]` — public, but **listing gate**: `isListed = complete AND (comped OR ACTIVE)`; pilots are `comped=true`

**Highest-risk assertions** (ranked — these are where it breaks):
- Expired invite → blocked (that's the live bug ☝️); resent invite → passes
- Email-match: signing in as A then opening B's invite → `AccessDenied`
- Token replay: reusing an accepted invite → stays dead
- Ownership: practitioner A cannot reach/POST to B's `/edit` (server actions are independently invocable — test the **action**, not just the page)
- Post-onboarding profile actually appears in `/search` (listing gate + Typesense index)

### ⚠️ No test infra exists — decide first

Verified: **no** playwright/vitest/jest/cypress in `package.json`, no `e2e/`/`tests/` dir, no test script. So the agent lane needs a decision:

- **Option A — Playwright MCP** (`mcp__playwright__browser_*`): zero repo footprint, fastest to first result, well-matched to "agent driven." **Recommended for the first pass.**
- **Option B — stand up `@playwright/test` in-repo**: durable, CI-able, but real setup cost + a new dependency surface.

Recommend A now; graduate to B only if the suite earns its keep. Don't let infra choice block the finding that 12 pilots are locked out.

---

## 2. Homepage root → landing page

**Task:** the root needs a real landing page. Current `src/app/page.tsx` (168 lines) is a server component, prisma-backed, Card/Badge/Avatar, listing-gate filtered — a *directory-ish* home, not a marketing landing.

**Dispatch a planning & research subagent to `ssh vps:~/apps/CMS`.**

> ⚠️ **Path correction:** the brief said `~/apps/cms` — that **does not exist**. It is **`~/apps/CMS`** (uppercase; the VPS is case-sensitive). Verified 2026-07-16.

**What's there** (recon'd): `CLAUDE.md` (194 lines) · `design/` · **`frontier-UX/`** · `specs/` · `handoffs/` · `apps/` · `packages/` · `static-site/` · `Kaleido-landing/` · `projects/` · `docs/` · `ops/`. Live at `cms.chem.dev` (Caddy: "CMS-aiChemist Platform (Next.js)").

> ⚠️ **That repo has its own operating protocol** — its `CLAUDE.md` mandates *"NotebookLM is the brain, Claude Code is the hands"* with a **PULL → EXECUTE → PUSH** session cycle (read NotebookLM/`handoffs/` first; write learnings back). The subagent **must read and follow it**, not just grep the directory.

**Identify & execute optimal available skills for:**
- **cms** → the CMS repo's own capabilities + protocol
- **frontend/visual design** → the `frontend-design` skill
- **frontier** → `frontier-UX/` in that repo

**Branding — non-negotiable:** adhere to the live theme. **CMS Theme D "Midnight Navy"** (midnight navy + rose-magenta + sage; Inter/Playfair), shipped 2026-05-29 via `8cf4f17`/`5a23aff`. Tokens live in `src/app/globals.css` via `@theme` (`--color-primary`, `--color-cta`, `--color-background`, …) — there is **no `tailwind.config.ts`**. Consume the tokens; don't hardcode hexes.

> ⛔ **Do NOT reopen the palette.** Any note proposing "white / forest-green / red-hot-pink" is **stale** — it was superseded 2026-05-29 and never shipped.

---

## 3. Open threads — tracked, low priority

1. **Issue #24 — stale JWT role.** `src/auth.ts` re-reads `role` only at sign-in; no `session.maxAge` → NextAuth's 30-day default. A demoted admin keeps access until expiry/re-auth. Latent, low risk at one admin. A `session.maxAge` bump is the cheap fix.
2. **`.vercel.app` alias.** `natural-health-pros.vercel.app` 404s; legacy `hhe-directory.vercel.app` still serves. Vercel only moves the auto-alias on the **next deployment** — so this **self-resolves** the moment the landing-page work (§2) deploys. Canonical domain unaffected. No action needed.

---

## Suggested order

1. **Confirm + fix the expired invitations** (§1) — it's live breakage gating the entire pilot cohort, and it's a resend, not a build.
2. **Run the two e2e lanes** (§1) — they validate the fix and the whole gated flow.
3. **Landing page** (§2) — bigger, and its deploy incidentally clears §3.2.

## Verification habits that paid off this session

- **Check the claim, not the story.** A blocker parked for days as "waiting on the client" was self-serviceable the whole time — the zone was already ours.
- **"200 OK" ≠ "it works."** The apex returned 200 while serving a GoDaddy placeholder; the email API returned 200 while the message landed in spam. Assert on *content and outcome*, not status codes.
- **Docs invert silently.** Re-enabling gates made every "auth is off" doc actively wrong. When you flip a state, sweep for the docs that asserted the old one.
