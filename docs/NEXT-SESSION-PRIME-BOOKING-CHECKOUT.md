
> **Point-in-time record, 2026-08.** Figures and rules below are as of that date. Current rates, payouts and flags: `docs/money-model.md` and `CLAUDE.md`.

> ⚠️ **SUPERSEDED 2026-08-13 — this brief's job is DONE.** The review + reconciliation it asks for
> happened; the canonical design is now vault `art_c688ea69482744d19c89` (v2) and the task set lives
> in vault project `prj_63362baf8f58464c904e`.
> **→ Read `docs/2026-08-13-booking-checkout-handoff.md` instead.**
> Kept as a point-in-time record of what the reconciliation was asked to resolve.

# Next session — review + refactor the booking/checkout flow

**Written**: 2026-08-13, closing the session that shipped PRs #47/#48
**Task**: review and refactor `docs/2026-08-12-booking-checkout-flow.md`
**Expect**: input from an upstream planning agent. **Reconcile against it before building anything.**
**Vault**: `art_d549066904e94292a883` · task `tsk_5533311473d3487d9773`

---

## What this session is for

Not "implement the design". **Review it, reconcile it with the upstream planning input, and refactor
it** — then decide whether it is ready to build.

Nothing in the booking/checkout flow is built. That is deliberate: the operator deferred it so the
design could take upstream input first. So the design doc is a *proposal with reasoning attached*,
not a spec to execute on faith.

**How to handle the upstream input when it arrives:**

1. Read `docs/2026-08-12-booking-checkout-flow.md` in full first, including the reasoning. Every
   ruling in it carries *why*, precisely so a later reader can judge whether an override is
   justified rather than having to guess.
2. Where the upstream input agrees — fold it in and move on.
3. Where it **disagrees**, sort the disagreement into one of three kinds before resolving it:
   - **Operator rulings** (below) — these were decided by the operator with reasons on the table.
     They can be overridden, but only by the operator, and the override should be explicit.
   - **Hard constraints** (below) — these are facts about third-party systems, not preferences.
     If the upstream plan contradicts one, **the plan is wrong**, not the constraint. Verify the
     constraint yourself rather than assuming either side; that is cheap and it settles it.
   - **Everything else** — genuinely open. Take the better idea.
4. Refactor the doc in place. Do not fork it into a second design doc; one canonical design.

---

## Operator rulings — carried, overridable only by the operator

**Booking Link = DECIDED buyer. Offering card = UNDECIDED buyer.**
The same offering appears in both places on purpose. Booking links are primary CTAs whose job is to
get out of the way; offering cards are secondary, expand in place, and do the selling. Precisely:
*decided to **act**, not decided to **buy*** — which is why a free consultation sits in the decided
rail even though the buyer has not decided to purchase anything.

An earlier draft proposed deduplicating a linked offering out of the secondary list. **The operator
rejected that**, correctly: two entry points serve two buyer states, and the transcript evidence
originally cited for the dedup was misread (it was about dead placeholder tiles, since removed).
If the upstream plan proposes deduplication again, this is settled ground — say so.

**Sequence is capture → schedule → pay.** The decisive argument is lead capture: payment-first
yields *nothing* on abandonment, schedule-first hands the practitioner a real contact before the
payment wall. For a directory selling exposure — to a recruiter whose own scar tissue is *"I paid
for a listing and got zero clients"* — that outweighs the unpaid-hold risk it accepts.

**Booking↔offering is many-to-many.** One scheduler typically serves a practitioner's whole
practice, so a single FK would force duplicate `BookingLink` rows kept in sync by hand.

**Grade-based directory tiering is dropped.** Recorded so it is not re-discovered in the transcript
and re-scoped a third time.

---

## Hard constraints — facts, not preferences. Verify, don't assume.

**Custom redirect-after-booking is a PAID Calendly feature.** Sarah recommends *free* Calendly to
beginners, so the obvious chain `scheduler → redirect → checkout` breaks for exactly the cohort this
product targets. The unlock is the **inline embed**: Calendly emits `calendly.event_scheduled` via
postMessage on all plans including free; Cal.com emits `bookingSuccessful`. Acuity has no reliable
public event → manual "I've booked my time →" fallback. **Re-verify this before building on it** —
plan vendors change tiers, and a stale assumption here silently excludes the target cohort.

**We do not own the scheduler.** It is the practitioner's Calendly / Acuity / Cal.com / SavvyCal.
Any design that assumes control over the booking step is wrong. "One step" can mean one *flow*; it
cannot mean one *request*.

**`createOfferingCheckout` already sets `redirect_url`** (`src/lib/whop.ts`, in the checkout config).
Pointing it at the flow's done screen is a one-line change, not new integration work.

**A missing city unlists a practitioner.** `hasCity` → `isProfileComplete()` → `isListed()`. Any new
required-ish field in this flow inherits that hazard: if it can end up null on a save that reports
success, it can silently remove someone from the directory. See
`gotcha_listing_gate_expiry_not_an_event` in project memory.

**Whop's hosted KYC can never run in CI.** Any plan promising full end-to-end automated coverage of
the payment path is fake. `npm run whop:health` is the after-the-fact canary instead.

---

## Design shape as it currently stands

Both middle steps conditional; only capture is unconditional:

| Case | Steps |
|---|---|
| Free consult (link, no offering) | capture → schedule |
| Paid session with a scheduler | capture → schedule → pay |
| Subscription, nothing to book | capture → pay |
| Practitioner's own scheduler takes payment | capture → schedule |

Primary CTA by linked-offering count: **0** → free consult, no checkout · **1** → straight in, fast
path preserved · **2+** → card expands in place to list choices, selection stays on the profile so
the decided buyer's minimum-friction property survives.

Schema (all additive, expand-only): `BookingLinkOffering` join table (+ own `sortOrder`),
`WhopProduct.paymentMode` { WHOP_CHECKOUT, EXTERNAL_SCHEDULER, FREE }, `BookingIntent` +
`entryPoint` { BOOKING_LINK, OFFERING_CARD }.

`entryPoint` is a **diagnostic, not a vanity metric**: it proxies buyer intent at entry. UNDECIDED
converting comparably means descriptions are doing real selling; UNDECIDED high-volume-low-conversion
is a coachable content problem, which is Sarah's job.

---

## Open questions the refactor should actually resolve

1. **Unpaid holds.** Schedule-first accepts that a slot can be held by someone who never pays. The
   design mitigates with an abandoned-payment resume email at ~1h and the practitioner already
   holding the lead. Is that sufficient, or does a per-offering pay-first flip need to exist in v1?
2. **Payment plans.** Sarah raised her $2,600 program: *"they might want a payment option — isn't
   available here."* Whop supports plans. Not urgent while offerings are gateway-priced, but it is
   the predictable second ask once high-ticket items land.
3. **Where the abandoned-intent sweep lives**, and how it avoids the `deleteFromIndex` bare-catch
   pattern that already defeated one "fail LOUD" counter in this codebase.
4. **Label ambiguity.** When one offering is linked, default the booking link's label from the
   offering title so the two read as one thing. With several linked there is no single title to
   borrow — what should it say?

---

## Do not relitigate

- The DECIDED/UNDECIDED framing, the dedup question, the capture→schedule→pay order, many-to-many —
  all settled above.
- Theme D "Midnight Navy" tokens in `src/app/globals.css` `@theme`. No `tailwind.config.ts`.
- Whop Connected Accounts is **self-serve**. The "invite-only Platforms" claim is a documented
  context error; do not send the outbound templates in `docs/outbound/`.
- $49/mo, not $59.

---

## State of the world entering this session

**Live** (`main`, PRs #47/#48): practitioner-controlled ordering · free-text city over a US Census
catalog · pilot clock held open behind `PILOT_TRIAL_CLOCK_ENABLED` · unsaved-changes guard · admin
invite delete · the profile/payments copy fixes. 51 tests.

**Sarah Schindler is holding.** She is the practitioner-side owner and will not onboard the next
wave until given the go-ahead. Her duplicate row was retired 2026-08-12; her real account is live
with a connected Whop account attached.

**Two things gated on the operator, both outside this session's scope:**
- 🚨 **Re-validate the 12 pilot email addresses before any `resendInvitation`.** A corrected email
  produces a duplicate practitioner row whose stale twin may be the listed one — this already
  happened once.
- `whopKycStatus` on `sarah` is still `NOT_STARTED` despite her completing ID + SSN on the call.
  Either Whop is still reviewing or the status webhook is not landing. **Worth resolving before
  building checkout on top of it**, since the whole flow assumes KYC status propagates.

**Read first**: `docs/2026-08-12-booking-checkout-flow.md` · `docs/2026-08-11-sarah-onboarding-review.md`
(the call this all came from) · `docs/recruiting-language-baseline.md` (what practitioners are being
told, which the flow has to stay honest against).
