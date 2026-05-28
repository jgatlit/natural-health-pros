# ⚠️ TEMP: Admin Gate Bypass — Revert Instructions

**Created:** 2026-05-28
**Why:** Operator (jgatlit@gmail.com) needed to view the `/admin/*` surface without
completing a fresh magic-link sign-in. The admin gate was temporarily disabled for
viewing/testing.

> **This is a security bypass.** While active, `/admin`, `/admin/invites`,
> `/admin/connected-accounts`, and `/admin/whop-webhooks` are reachable by **anyone**
> with no authentication. The invites page can send invitation emails; the
> connected-accounts page exposes practitioner emails + Whop KYC status (PII).
> **Revert as soon as viewing is done.**

## Files changed (gate commented out, marked `⚠️ TEMP — LOCAL TESTING ONLY`)

| File | What was disabled |
|---|---|
| `src/middleware.ts` | middleware `/admin` role gate |
| `src/app/admin/page.tsx` | page role guard + `session.user.email` → null-safe `session?.user?.email ?? 'TEST BYPASS'` |
| `src/app/admin/invites/page.tsx` | page role guard + null-safe email |
| `src/app/admin/connected-accounts/page.tsx` | page role guard |
| `src/app/admin/whop-webhooks/page.tsx` | page role guard |
| `src/app/admin/invites/actions.ts` | `requireAdmin()` guard + null-safe `session?.user?.id` / `session?.user?.name` |

## Revert

### Option 1 — discard uncommitted changes (if NOT yet committed/pushed)

```bash
cd ~/projects/HHE/HHE-directory
git checkout src/middleware.ts src/app/admin/
rm docs/ADMIN-GATE-BYPASS-REVERT.md   # remove this doc too
```

### Option 2 — revert the bypass commit (if it WAS committed/pushed)

```bash
cd ~/projects/HHE/HHE-directory
git log --oneline -5                  # find the bypass commit hash
git revert <bypass-commit-hash>       # creates an inverse commit
git push origin main                  # auto-deploys the restored gate to Vercel
```

After Option 2, confirm production is gated again:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://hhe-directory.vercel.app/admin
# expect 307 (redirect to /auth/signin), NOT 200
```

## Why the bypass was needed (root cause, for the real fix)

The account `jgatlit@gmail.com` is **already `role: ADMIN`** in the Neon DB
(`emailVerified: 2026-05-28`). The gate reads `role` from the **JWT token**, which is
only stamped at sign-in (`src/auth.ts` `jwt` callback). A stale/absent session JWT is
the actual blocker — **a fresh sign-in fixes it with zero code changes.** The proper
long-term path is to sign in (or mint a `VerificationToken`) rather than disable the gate.

## Verify gate is OFF (while bypass active)

```bash
for p in /admin /admin/invites /admin/connected-accounts /admin/whop-webhooks; do
  curl -s -o /dev/null -w "$p -> %{http_code}\n" "http://localhost:3000$p"
done
# expect all 200 while bypassed
```
