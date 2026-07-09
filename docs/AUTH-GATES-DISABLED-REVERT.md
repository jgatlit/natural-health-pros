# ⚠️ Auth gates DISABLED — re-enable instructions

**Disabled:** 2026-07-09, at the operator's explicit request, for seamless HHE admin +
practitioner visibility/testing across the onboarding-portal build phases.

**Retained:** magic-link sign-in is still the auth *method* (NextAuth + Resend). Only the
authorization *gates* (role / ownership / invite validity) are commented out.

> **Security note.** While disabled, `/admin/*`, every practitioner **admin portal**
> (`/practitioners/[slug]/edit`) and its server actions, and `/onboarding` are reachable +
> writable by **anyone** — no ownership or role check. Any visitor can edit any
> practitioner's profile. **Re-enable before any public launch, or on operator request.**

## What's off + how to restore

| File | Gate | Restore |
|---|---|---|
| `src/middleware.ts` | `/admin` role gate + `/practitioners/*/edit` + `/onboarding` session gate | Replace the `auth(() => …)` body with the commented `--- ORIGINAL GATES ---` block (uses `req`). |
| `src/app/practitioners/[slug]/edit/page.tsx` | session redirect + `isOwner \|\| isAdmin` check | Re-add `redirect` to the `next/navigation` import; uncomment the session guard + `const isOwner` + the ownership `redirect`. |
| `src/app/practitioners/[slug]/edit/actions.ts` | `authorizeForSlug` session + ownership check (guards updatePractitioner / generateDraftAction / submitOnboarding / removeCaseStudy) | Uncomment the `import { auth }` line + the session/ownership blocks in `authorizeForSlug`. |
| `src/app/onboarding/page.tsx` | invitation-required + invite validity + email-match | Uncomment the 3 gate blocks; make the invitation non-optional again (revert `token ? … : null` + the `if (invitation)` accept-guard) and derive slug/name from `invitation.email`. |
| `src/app/admin/**` + `admin/invites/actions.ts` + `admin/specialties/actions.ts` | page/action role guards | Already disabled since 2026-06-29 (see `docs/ADMIN-GATE-BYPASS-REVERT.md`); restore alongside these. |

All disabled sites are tagged `⚠️ TEMP` and dated `2026-07-09`, so:

```bash
grep -rn "TEMP" src/middleware.ts "src/app/practitioners/[slug]/edit" src/app/onboarding
```

lists every gate to restore. The clean long-term path is to route all four through
`withAdmin` / an ownership helper in `src/lib/action-utils.ts` (currently unused) rather
than inline guards.
