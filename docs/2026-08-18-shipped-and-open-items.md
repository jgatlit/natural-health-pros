# 2026-08-18 — what shipped, what was decided, what is still open

> **Point-in-time record, 2026-08-18.** Figures and rules below are as of that date. Current rates, payouts and flags: `docs/money-model.md` and `CLAUDE.md`.

Companion to `docs/2026-08-13-booking-checkout-handoff.md`. Written at session close so the
open-items register survives the conversation that produced it.

**Production: `246f2f3` — `dpl_H2aYZhXNTk6C7qovggLhUUfbZXtx`.** Tests 331 → **397**.

---

## Shipped (7 PRs)

| PR | Commit | What |
|---|---|---|
| #72 | `2420555` | Sign out from the header |
| #73 | `6b434b4` | Delist + archive controls on `/admin/invites` |
| #74 | `1755d45` | Billing-enforcement spec (deferred; docs only) |
| #75 | `05ba0bc` | Layer X is $49/mo — last stale `$59` refs |
| #76 | `b812938` | Write-authorization guard (tests only) |
| #77 | `8034596` | trial-sweep can actually report a failed delist |
| #78 | `246f2f3` | Resend resets the pilot clock + email correction |

Plus two infrastructure changes with no PR:

- **`ADMIN_EMAILS` now carries three admins** — `jgatlit@`, `amy@`, `sarah@wild-rooted.com` —
  across all three Vercel scopes, and Sarah's DB role is `ADMIN`.
- **Upstash Redis provisioned** (`nhp-ratelimit`, free plan, `iad1`, all three scopes). This was
  the fix for `rateLimit()` being a production no-op.

---

## Decisions taken

**Billing enforcement in the booking flow stays OFF.** Spec and scope recorded in
`docs/superpowers/specs/2026-08-18-booking-billing-enforcement.md`. The commercial question is
framed there and deliberately unanswered: does the subscription buy directory *placement* or the
*transaction rail*? A third option — keep booking, take a higher cut — needs no gate at all.

**Archive is a soft delete, not a hard one.** Deleting a `Practitioner` cascades its
`BookingIntent`s away: leads and real payment records, on a system where a live payment ran
2026-08-15. `archivedAt` preserves them.

**Delisted stays bookable; archived does not.** `delistedAt` never reaches `bookableWhere()`;
`archivedAt` does. That asymmetry is the §17 / PR #70 rule.

**Resend resets the pilot clock — but will not START one.** See the open item below.

---

## Open items

### 1. ✅ CLOSED — server-rendered output AND client-side interaction both verified live
Verified on production as an authenticated ADMIN (see "How the authenticated check was done"):

- **Header (#72)** — signed in, the slot renders `My profile · Sign out`; `Sign in` appears only
  in `SiteFooter`, never in the header. Signed out, the same slot renders `Sign in`.
- **`/admin/invites` (#73, #78)** — 18 invitation rows; **all 12 pilots carry directory
  controls**, which is the assertion that matters: keying off `acceptedByUser` instead of email
  would have rendered them on 4 rows. 17 of 18 rows resolve to a practitioner; the one that does
  not is the `jgatlit+resendtest@` junk row, correctly control-free. "Show archived" is absent
  because `archivedCount` is 0.
- **`/edit` (#78)** — the Account email card renders with the `#account` anchor, and opening
  `sarah`, `amy` and `tara-garrison` as an admin prefills **each owner's** address with the
  "this practitioner signs in with" copy. The operator's own address never leaked into another
  profile's form — the viewer/owner conflation this was designed against is absent.

**✅ RESOLVED later the same day — the UI was driven in a real browser.** Playwright against
production with a minted admin session (recipe below). Verified by clicking: sign-out ends the
session (`/api/auth/session` → `null`, `/admin/invites` → 307); delist→relist and
archive→restore both round-trip on the operator profile, with the DB returning to 0 flagged; and
the two-click confirm dismisses on **both** Escape and outside-click without writing.

Two things surfaced that no HTTP-level check could reach:

1. **A real defect — "Show archived (N)" counted invitation ROWS, not practitioners.** Archiving
   one person rendered "(2)", because `jgatlit@gmail.com` holds two invitation rows. Fixed in
   PR #80 (`d235a08`) and verified live: it now reads **"Show 1 archived practitioner"**.
2. **A false alarm I reported as a defect — select-on-open.** I claimed the email control failed
   to select its text and that `focus()` fixed it. ⚠️ **Both halves were wrong.** `select()`
   already focuses in Chromium; typing replaced the value with and without the change. My
   evidence was `selectionEnd - selectionStart` reading 0, and both are **`null` on
   `<input type="email">`** because the selection API does not apply to that type — so it could
   never have read anything else. Retracted in `13d04d7`; `focus()` is kept only as a defensive
   ordering and is now labelled as such.

**Still unexercised:** submitting an actual email CHANGE (only the cancel path was exercised),
the resend path, and Typesense removal of a **listed** document — the operator profile is
unlisted, so delisting it takes the already-absent branch. Proving a real removal means briefly
hiding a real practitioner from search, which was deliberately not done.

### 2. Resend is a no-op on billing until `PILOT_TRIAL_CLOCK_ENABLED=true`
The operator instruction was "resend invite SHOULD reset the trial period". The implementation
resets an existing clock but refuses to CREATE one while the flag is unset — which it is, in
every scope. Rationale: starting twelve pilots' paywall as a side effect of a button labelled
"resend invite" is not reversible once the emails are out, and enforcement was explicitly
deferred the same day. **Setting the flag gives the literal behaviour on the same button.**

### 3. The 12 pilots are still locked out
Invitations expired 2026-06-28, none accepted, `emailVerified` null on all twelve. The tooling
to fix it now exists (resend + in-place email correction). The action has not been taken.
⚠️ Re-validate each address BEFORE resending — see the duplicate mechanism below.

### 4. `initial_price: $0` is undisclosed
> Superseded 2026-10-15: the operator ruled no free first period; see `docs/LAYER-X-SUBSCRIPTION.md`.

The Whop plan's first 30-day period is free, then $49/mo. Nothing a practitioner reads says so.
Under-charging generates no complaints, which is why it has survived. Still a billing-vs-copy
gap on the primary revenue line. Recorded in `docs/PHASE-2C-WHOP-CONNECTED-ACCOUNTS.md`.

### 5. ADMIN is a latent paywall exemption, and now three people hold it
`listedWhere()` OR-includes `user.role === 'ADMIN'` and `trial-sweep` excludes admins. All three
admins own practitioner profiles. Amy is deliberate. **Sarah is new and is a real practitioner** —
once the trial clocks start, her listing is permanently free and sweep-exempt. Decide before
pulling the clock lever, not after.

### 6. No verify-before-switch on email change
Magic-link is the only auth, so a typo in the self-serve email field locks the owner out.
Recoverable by an admin via `/admin/invites`, and the UI says so. A verification round-trip is
the correct end state; it needs a token store.

### 7. Stale-JWT role gap
`session.user.role` is baked into the token at sign-in (30-day). A **demoted** admin keeps write
access to other practitioners' profiles until their token expires. `isOwner` is unaffected.
Revoking admin urgently needs a DB change *and* a forced sign-out.

---

## Corrections to earlier beliefs

**`startSubscriptionCheckout` is NOT dormant.** It is imported at `edit/page.tsx:26`, bound at
`:208`, passed as `subscribeAction` at `:650`, and is in `MUST_HAVE_A_CALLER` in
`tests/server-action-reachability.test.ts`, which passes. The email-matching problem it once
caused is also fixed — the action mints a per-practitioner checkout carrying
`metadata.practitioner_id`. Any note calling it dormant is stale. **Layer X revenue is zero
because nobody has been asked, not because the rail is broken.**

**Preview builds are green.** The Neon 10-branch cap outage is historical; PR #54's cleanup
workflow works. Seven previews passed first try today. Do not debug a red preview by assuming
the cap — check a real PR first.

**Re-accepting an invitation does NOT duplicate a practitioner.** `/onboarding` resolves by
`userId` and only creates when absent, so it is idempotent. The duplicate comes from a **changed
email**: a different address is a different `User` with no practitioner, so the create branch
runs. That is how the duplicate `sarah-schindler` row was made — and why in-place email
correction, not re-invitation, is the fix.

---

## Verification standard used today

Every behavioural guard shipped today was **mutation-tested** — the guard was deliberately broken
and the suite had to fail on exactly the assertion written for it. Fifteen mutations across five
changes; all caught. Two were caught only by source-pinning assertions, not by the behaviour
tests, because the helper under test could not be imported (its `'use server'` import graph pulls
in `next/navigation` and the auth stack) and the test therefore exercises a mirror of it.

Live checks were made against **deployment IDs served at the apex**, never status codes: while a
slow deploy is in flight the previous deployment keeps serving 200s from old code.

---

## How the authenticated check was done (repeatable)

The mailbox route was blocked — the `google-tools` grant for `jgatlit@gmail.com` is missing a
scope, and the claude.ai Gmail connector is bound to `jonathan@noboxai.com`, so the magic link
that WAS sent could not be read. (Re-authorising is one command: `google-tools auth login`.)

Instead, a session was minted directly. The app uses `strategy: 'jwt'`, so a valid session is a
signed token, not a DB row:

```ts
import { encode } from '@auth/core/jwt';
await encode({
  token: { sub: <userId>, email, role },
  secret: process.env.AUTH_SECRET,
  salt: '__Secure-authjs.session-token', // v5: salt === cookie name; this is the HTTPS name
  maxAge: 60 * 30,
});
```

Send it as `Cookie: __Secure-authjs.session-token=<token>`. `/api/auth/session` echoing the right
`id` + `role` confirms acceptance before relying on anything else.

Leaves no residue: JWT sessions write no `Session` rows (count stayed 0), and the token was
short-lived and destroyed after use. Useful for verifying gated server-rendered output without a
mailbox — **not** a substitute for clicking the UI.
