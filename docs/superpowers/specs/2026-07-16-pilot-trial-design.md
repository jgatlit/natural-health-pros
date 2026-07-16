# Spec — "Pilot" becomes a 90-day trial

**Date:** 2026-07-16 · **Status:** approved, pending implementation
**Supersedes:** `Practitioner.comped` as the listing mechanism.

## Problem

`comped: boolean` is a permanent free pass with no clock. It has two failure modes, both hit today:

1. **It never expires.** A "pilot" is indefinite, so there is no path from pilot to paying customer.
2. **Nothing sets it on the invite path.** Amy (the client) accepted an invite, completed a 100%-complete profile, and was silently absent from the directory — she inherited `comped: false` and hit the $59/mo Layer X paywall on the directory she is paying for. The 12 pilots only escape this because the *import* set `comped=true` directly. Fixed in #33 (invite ⇒ comped), which this spec replaces with a clock.

## Decisions (operator, 2026-07-16)

| Decision | Choice | Rationale |
|---|---|---|
| comp vs trial | **One concept — everyone trials** | Simpler model, one code path. Note this is *not* reversed by the admin exemption below: the exemption adds **no new field and no new state**, it is a predicate on `User.role`, which already exists and already means "staff, not customer". `comped` — a second, parallel, hand-maintained truth — stays retired. |
| Clock start | **Genuine onboarding** | `acceptedAt` for the 12 is the *seed* date (2026-05-29). A clock anchored there would have them 48 days into a 90-day trial for a product they have never opened. The clock must be an earned event, never an inferred one. |
| At expiry | **Warn → delist at 90 → 14-day grace** | Silent delisting is the exact failure that cost the client an hour today. |
| Billing rail | **Ours, not Whop's** ("D") | See below. |
| Exemption | **`user.role === 'ADMIN'`** | Staff/client are not customers. Reuses a field that already means this. |
| Operator lever | **Reset trial button** | `trialEndsAt = now + 90d`, beside Resend on `/admin/invites`. |

## Why not Whop-native (researched, rejected)

Whop provides all of it natively — `trial_period_days`, `memberships.addFreeDays(id, 90)` (literally the Reset button), Cancel → *"retains access until the next billing date"* (grace), Terminate (revoke). Building our own is strictly more code.

**But every Whop trial path requires a card up front**, because a recurring plan must eventually charge:
- `trial_period_days` → *"automatically charged"* at trial end ⇒ card on file
- 100%-off promo (`percentage` + `promo_duration_months: 3`) → plan still bills at month 4 ⇒ card
- `mode: "setup"` → its literal purpose is *"collect payment details without charging"* ⇒ card

The only card-free Whop path is a **$0 `expiration_days` plan** — rejected because it prices the listing at zero and anchors it there.

**The resolution:** the $59 anchor is a *messaging* property, not a *billing* one. Our own dashboard copy lands it without a card wall on a 12-person goodwill cohort Amy vouched for. Whop enters only at conversion, where it already works.

## Model

Add `trialEndsAt DateTime?`. Retire `comped`.

```ts
trialActive = trialEndsAt === null || trialEndsAt > now
isListed    = isProfileComplete && (ACTIVE || PAST_DUE || trialActive || user.role === 'ADMIN')
```

| `trialEndsAt` | meaning | listed |
|---|---|---|
| `null` | **pre-trial** — operator-seeded, never onboarded (the 12 today) | ✅ |
| future | trial running | ✅ |
| past | expired | ❌ (unless ACTIVE/PAST_DUE/admin) |

- `null` is reachable **only by seeding** — every real signup goes through onboarding and gets a clock. It is not a loophole; it is what keeps the 12 listed instead of vanishing on deploy.
- **`PAST_DUE` stays listed.** That is Whop's dunning window, and it becomes grace-for-payers for free. A failed card must not delist someone instantly.
- Admin exemption is read **server-side from the DB**, so the stale-JWT gap (#24) cannot affect listing.

**Known trade-off:** this couples "can administer the platform" with "gets a free listing". Fine at 2 admins; revisit if admins proliferate.

## Clock

`submitOnboarding` sets `trialEndsAt = now + 90d`. Nothing else starts it.

## Expiry

- **Day 90** — delisted from directory + Typesense. Profile stays live at its direct link; **all work intact**; dashboard shows subscribe → restore.
- **Day 90–104 (grace)** — an *urgency and messaging* window, not a data state. Nothing is archived or deleted, ever. Stated plainly rather than inventing an "archive" step that does not exist.
- **Day 104+** — stop nagging; flag for operator review.

## Warnings

Cron at T-14 / T-3 / T-0 + a dashboard countdown. Precedent exists: `vercel.json` already runs `/api/health/search` `*/15 * * * *` with `CRON_SECRET` bearer auth — reuse that shape.

Emails MUST be **transactional-shaped** (plain link, no button, no pitch, action-first subject). See `src/auth.ts` — a pretty branded invite landed the client in Gmail Promotions today.

## The $59 anchor

`SubscriptionSection`: **"Your 90-day pilot · $59/mo value · free until {date}"** + countdown. The anchor is what they read.

## Reset trial

Button on `/admin/invites` beside Resend, on **accepted** rows → `trialEndsAt = now + 90d`.

⚠️ `Invitation.acceptedByUserId` is a plain `String` with **no Prisma relation**, so the row cannot `include` its practitioner. Either add the relation or do a second query keyed by userId. Prefer the relation.

## Backfill

| Who | `trialEndsAt` | Why |
|---|---|---|
| **Amy** | `null` | ADMIN — exempt, no clock. |
| **The 12** | `null` | Clock starts when they genuinely accept. |
| **jgatlit** | `null` | Seeded; ADMIN-exempt regardless. |

**No backfill ships. Every row is already `null`, which is correct.**

This table originally gave Amy `2026-10-14` ("exempt anyway as ADMIN — the date is for when she is not"), and a `scripts/backfill-trial-dates.ts` was built to write it. Both were dropped once that reasoning was checked against the warning cron, which skips admins (`user: { role: { not: 'ADMIN' } }`). A dated-but-exempt admin therefore accrues no warnings — so if Amy were ever demoted after that date, she would be delisted the same day, silently, having received none of the T-14/T-3/T-0 mails. That is precisely the failure this design exists to prevent. `null` degrades safely instead: a demoted admin lands in **pre-trial**, still listed, still quiet. A defensive value that turns into a silent trapdoor is worse than no value.

## Migration notes

- `comped` is read by: `page.tsx`, `onboarding/page.tsx`, `SubscriptionSection.tsx`, `edit/page.tsx`, `practitioner-indexer.ts`. All must move to the new predicate.
- `src/app/page.tsx` filters with a **Prisma `where`**, not the `isListed()` function — the OR must be expressed there too, including `{ user: { role: 'ADMIN' } }`. Easy to miss; the two must not drift.
- **`isListed` gates Typesense indexing.** Any change to trial state requires a reindex or the directory will not reflect it. Flipping a date in SQL alone appears to do nothing.
- **Corollary, and the thing this design nearly shipped without: expiry is not an event.** Every other `indexPractitioner()` call hangs off one — onboarding, a profile edit, a Whop webhook, an admin action. A trial lapsing is the *absence* of an event: a timestamp passing with nobody there to react. So nothing would ever have rewritten the doc, and expired pilots would have stayed in `/search` indefinitely while the home page (which evaluates `listedWhere()` per query) correctly dropped them — the paywall gating everything except the one surface it is sold on. `/api/cron/trial-sweep` therefore **warns and then enforces**: it delists lapsed trials via `indexPractitioner()`, which self-heals both directions. Warning without enforcing is theatre.
- **`resetTrial` must reindex explicitly**, and the sweep cannot cover for it: the sweep only visits `trialEndsAt < now`, and a reset date is in the future. Miss that call and an admin's "Reset trial" restores someone everywhere except search, permanently.
- Migration must follow `gotcha_prisma_migrate_dev_broken`: `migrate diff` + hand-strip the `DROP INDEX "Practitioner_searchText_trgm_idx"` it always emits, then `migrate deploy`. Applying that DROP silently kills typo-tolerant search.

## Non-goals

- No Whop plan changes. Whop is untouched until conversion.
- No archiving/deletion of expired profiles.
- Trial length is a constant (90), not per-practitioner config. YAGNI — the Reset button covers exceptions.
