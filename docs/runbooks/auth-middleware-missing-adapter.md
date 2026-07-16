# Runbook — `MissingAdapter` in Edge middleware (the silent sign-in loop)

> **Why this exists**: On 2026-07-16, immediately after re-enabling the auth gates (PR #22), every gated route bounced to `/auth/signin` in an infinite loop — even with a valid, freshly-minted session. The magic link worked; the *gate* was broken. Root cause was **pre-existing since `39bdd9f`** and had been logging an error on every request for weeks without anyone noticing.

## Symptom

- Magic link → `/api/auth/callback/resend` → **302, sets `__Secure-authjs.session-token`** ✅
- `GET /api/auth/session` with that cookie → **returns a full, valid session** ✅
- `GET /onboarding` (or any gated route) with the *same* cookie → **307 → `/auth/signin`** ❌
- User signs in again → same → **loop**. Three emails, no session.

The tell: **the app can read the session but middleware cannot.**

## Root cause

`src/middleware.ts` built its instance from the edge-safe config:

```ts
const { auth } = NextAuth(authConfig);   // ← BUG
```

`auth.config.ts` carries the **Resend provider**, which Auth.js types as `email`. `assertConfig` (`@auth/core/lib/utils/assert.js`) enforces:

```js
if (hasEmail) {
  if (!adapter) return new MissingAdapter("Email login requires an adapter");
}
```

The edge instance has **no adapter by design** (the whole point of the split — Prisma would blow Vercel's 1 MB Edge limit). So Auth.js **threw on every middleware invocation**:

```
[auth][error] MissingAdapter: Email login requires an adapter.
```

`req.auth` was therefore always `null` → every gate redirected to signin.

## Why it hid for weeks

The auth gates were commented out from 2026-07-09 to 2026-07-16. During that window middleware never *read* `req.auth` — it just `return NextResponse.next()`. The error logged on every request and was ignored, because nothing consumed the broken value. **PR #22 didn't introduce this; it started consuming it.**

Corollary worth remembering: while the gates were off, *no test could have proven a session worked* — there was no gated surface to prove it against. "I clicked the magic link and got no error" was never evidence of a session.

## Fix

```ts
const { auth } = NextAuth({ ...authConfig, providers: [] });
```

Middleware only **decodes** the session JWT — it never initiates a sign-in — so it needs no providers. Emptying them makes `hasEmail` false, `assertConfig` passes, and the JWT decodes normally. `assertConfig` has **no** minimum-provider requirement, so `[]` is safe. The Node instance (`src/auth.ts`) keeps the provider **and** the adapter, so sign-in is unaffected.

Shipped alongside: middleware was building `callbackUrl` from `pathname` **only**, silently dropping `?invitation=<token>` — so a bounced invitee lost their invitation and failed the onboarding gate even once signed in. Now uses `pathname + search`.

## Rule

**Never pass an email/magic-link provider into an adapter-less edge instance.** Auth.js's published edge-compatibility guide assumes OAuth providers (which are edge-safe and adapter-optional); it does not cover the Email-provider case, where the adapter is mandatory. If you split the config, the edge side must carry `providers: []`.

## How to reproduce / verify (no inbox needed)

Auth.js stores `sha256(rawToken + AUTH_SECRET)` in `VerificationToken` and puts the **raw** token in the URL — so you can forge a valid magic link:

```js
const raw  = crypto.randomBytes(32).toString('hex');            // == randomString(32)
const hash = crypto.createHash('sha256').update(`${raw}${AUTH_SECRET}`).digest('hex');
await prisma.verificationToken.create({ data: { identifier: EMAIL, token: hash, expires: <+1d> } });
// → GET /api/auth/callback/resend?callbackUrl=<cb>&token=<raw>&email=<EMAIL>
```

Then assert **both**, which is what isolates this bug:

```bash
curl -b jar https://naturalhealthpros.com/api/auth/session   # expect a real session  (Node/λ)
curl -b jar https://naturalhealthpros.com/onboarding         # expect NOT 307→signin  (Edge/ε)
```

Session-OK + gate-307 is the signature of this failure.

## Debugging tip that cracked it

Vercel runtime logs distinguish `λ` (Node function) from `ε` (Edge middleware). Every `ε` line was `error` while every `λ` line was clean — including on public pages returning 200. Pull the full text (the console strips it):

```bash
vercel logs https://naturalhealthpros.com --scope ai-chemist --json | grep -i auth
```

Read the runtime logs **before** theorizing. Two plausible hypotheses (cookie-name/salt mismatch, missing `AUTH_URL`) were investigated and **disproven** by reading `@auth/core` source; the logs named the real cause in one line.
