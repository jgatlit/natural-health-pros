# Sarah Schindler onboarding session — design review

> **Point-in-time record, 2026-08-11.** Figures and rules below are as of that date. Current rates, payouts and flags: `docs/money-model.md` and `CLAUDE.md`.

**Call**: 2026-08-11, 17:00–18:08 UTC (68 min) · Jonathan Gudger ↔ Sarah Schindler
**Source**: Zoom federated index, meeting `7e018911-653b-4bcc-8dcf-209e7731fb4f` (`zoom.chem.dev`)
**Transcript**: VTT, 424 speaker turns, no AI summary row (`summary`/`action_items`/`discussions` all null in the federated store — this doc is the summary)

> Transcription note: Whop is rendered "WAP"/"WHOP" throughout the VTT. Read as Whop.

## Who Sarah is, and why this call matters

Sarah is an HHE graduate (health coach + therapeutic nutritional counselor), based in Illinois,
`sarah@wild-rooted.com`. Amy has designated her the **practitioner-side owner of the directory** —
vetting the next wave of graduate candidates and being first-line support for practitioner questions.

Two things happened at once:

1. **A usability test.** Sarah drove the full onboarding flow on her own screen while Jonathan
   watched. Every finding below is observed behavior, not speculation.
2. **The first real production transaction path.** Sarah is the **first non-test practitioner to
   complete Whop connected-account KYC** (ID + SSN + email verification; Whop quoted 1–2 business
   days for review). Jonathan, on the call: *"you are the very first person to fully onboard with
   your Whop and everything"* … *"Yours is the test case for that."*

---

## A. Rulings made on the call

Decided. These need building, not deciding.

| # | Ruling | Evidence in repo |
|---|---|---|
| A1 | **City must not be a fixed list.** Sarah could not type her city; fell back to "Virtual." Jonathan: *"I need to clean that up where it's not a finite list of cities."* | `edit/page.tsx:373-379` — `<select>` fed by `prisma.city.findMany()` |
| A2 | **"Have your ID ready" must appear *before* Setup Payments.** Sarah had to leave the call to fetch her license. Her words: *"letting them know that you're gonna need your ID."* Jonathan: *"That's a good point… I'll add that."* Copy should name driver's license **or passport**. | KYC entry point in the Whop connect flow |
| A3 | **Rename "How I work" → "Specialties."** It renders specialty chips; the heading misdescribes them. Sarah: *"the How I Work title doesn't fit."* Jonathan: *"Yeah, it should say specialties."* | `practitioners/[slug]/page.tsx:130-134` |
| A4 | **Remove the disabled placeholder tiles from the public profile.** "Browse offerings" and "Request invoice" render greyed-out with a *Coming soon* badge directly under real offerings. Sarah, in client voice: *"as a client looking for a practitioner, this is confusing."* Jonathan: *"You're right, yes."* | `PractitionerCTAs.tsx:108-110`, `PractitionerLinks.tsx:34` |
| A5 | **HSA reimbursement cannot be a blanket feature.** Only NBHWC-credentialed graduates can offer it. If kept, it must be conditional on a credential field. | same tiles as A4 |
| A6 | **Persistent "Edit my profile" for the signed-in owner.** Today the dashboard link only renders behind `?onboarded`; after that Sarah had to hand-type `/edit` onto the URL. Jonathan: *"that's another item for my list."* | `practitioners/[slug]/page.tsx:59-74` — gated on `searchParams.onboarded` |
| A7 | **Surface Regenerate on the dashboard.** The capability exists (the top dropdown re-enters the generate flow) but Sarah never found it unaided and asked for it explicitly. This is a discoverability fix, not a new feature. | `OnboardingSubmitButton.tsx:26` — "Regenerate my page" |
| A8 | **Profile card should not require an explicit Save.** Sarah lost an edit to it. Jonathan: *"That should not require you to save, but it does right now. That's good feedback."* | edit form card |
| A9 | **Photo spec + in-app crop.** The featured carousel is visibly incohesive (Tara's face cropped off, Juliette's is a low-res avatar). Jonathan committed to publishing target dimensions **and** adding a drag-and-crop widget — *"might as well have parity with what everybody expects."* | `api/practitioners/[slug]/photo/route.ts` (Blob upload exists; no cropper) |
| A10 | **No separate duration field on offerings.** Duration stays in the title (placeholder already reads *"60-minute initial consultation"*) or in "what's included." Jonathan's test: is there anything downstream you'd *calculate* from it? No → it stays text. *"Every time you add another field, it's another piece of noise, and if it doesn't fit the shape of everyone's offering…"* | offerings editor |
| A11 | **An offering is a checkout item: one thing, one price.** Ranges and packages ("sessions vary $150–$2,600") belong in profile prose, not as offering rows. | offerings model |
| A12 | **Show prices publicly even when the hero CTA is a free consult.** Sarah: it prevents sticker shock at the consult and helps buyers who already know what they want. Jonathan: *"that's my instinct as well… simplicity, clarity, transparency."* | public profile |
| A13 | **Free consultation = the hero booking link. Offerings = paid checkout only.** Practitioners get guidance to title the hero *"Free 30-minute consultation"* and not duplicate it as an offering row. Practitioners with no free consult must be able to omit it. | `PractitionerCTAs.tsx` |
| A14 | **Trial/pricing copy must state that the clock has not started.** This is the #1 question Sarah will field. Jonathan named the anti-pattern himself: *"It's easy to let a dozen of those little inaccuracies describing a future state remain in a tool."* | see **C1 — the code currently contradicts this** |

Confirmed unchanged: **$49/mo**, **90-day trial** (6 months judged too long; Sarah: *"90 days is great"*).

---

## B. The one genuinely open design problem

**Booking and checkout are two separate steps that should be one.**

Jonathan named this as the blocking creative task: *"do you book through a booking link, or do you
book through the checkout? Because you don't need to do both. It should be the same step."*

Sarah gave the hard requirement, unprompted and emphatically:

> **"For sure, they need to be able to schedule as soon as they pay. That would be very important."**

Today booking links and offerings are independent fields on the profile. A buyer can pay for a
60-minute session and land nowhere — no scheduling step. That is a broken purchase, and it will be
broken for the *first real money that moves through the platform*.

**Recommended shape** — it satisfies both constraints without a new field type:

- The offering already carries the practitioner's booking URL (per-offering override, falling back to
  the profile-level link). One optional field, reusing the existing provider allowlist.
- Post-Whop-checkout redirect → that booking URL. The confirmation page *is* the scheduler.
- The hero CTA stays a bare booking link, unmonetized, for the free consult (A13).

This keeps the practitioner's own scheduler (Calendly/Acuity/Cal.com — Sarah uses Acuity and
recommends free Calendly to beginners) as the system of record. It does not build a scheduler, and it
does not require Whop to know about calendars. It respects the complement-don't-compete principle (D1).

**Deferred but raised**: Sarah's $2,600 program *"they might want a payment option — isn't available
here."* Whop supports payment plans. Not urgent while offerings are gateway-priced, but it is the
predictable second ask once high-ticket items land.

---

## C. Where the code contradicts what was promised

### C1. The trial clock started, and Sarah was told it wouldn't

On the call: *"everybody's gonna be in pilot indefinitely, until we're actually, like, okay, the 90
days starts now… even if the program reflects that November 9th, that'll be reset indefinitely."*

The code does not do that. `onboarding/page.tsx:88-91` sets `trialEndsAt = now + TRIAL_DAYS` at
acceptance. Sarah onboarded on the call, so **her trial ends 2026-11-09** — the exact date Jonathan
guessed aloud. Nothing resets it automatically.

Compounding, from prior findings: expiry is not an event — the trial-sweep cron enforces it, and
`deleteFromIndex`'s bare catch swallows every error, so a delisting failure never surfaces. So the
failure mode is quiet in both directions: either she is silently delisted in November, or she is
silently *not* delisted and nobody learns the gate is broken.

`resetTrial` exists in `admin/invites/actions.ts` — the lever is built. It just has to be pulled, and
the copy has to stop describing a state the code doesn't implement (A14).

### C2. Stale emails are a live payment-routing risk

Sarah's email of record in the system — `hello@livingaligned` — **is dead**. She supplied
`sarah@wild-rooted.com` on the call.

That is not an isolated data-quality nit. Layer X still resolves payers by **email** (`startSubscriptionCheckout`
remains dormant, no caller). An email that doesn't reach the practitioner means a subscription that
can't be attributed. And the same list backs the **12 pilot invitations that expired 6/28** — those
were sent to addresses of the same vintage as Sarah's dead one.

**Ruling implied**: do not fire `resendInvitation` against the existing list. Have Sarah re-validate
the 12 addresses first — she is the one person who can, and she is now the designated owner of exactly
this. Re-sending 12 invitations to stale addresses burns the second impression as well as the first.

### C3. Whop checkout buttons are inert, and now there's a real account behind them

Jonathan on the call: *"Now that your Whop is connected, what will happen on the back end is every
time you create an offering, it'll actually create a Whop checkout item. And then those buttons will
be active."* — future tense. That wiring is unfinished, and Sarah's KYC clears in 1–2 business days
(≈ 2026-08-13).

Related open item from prior findings: **5 Whop buttons still lack pending-state feedback.** That was
a polish item when only synthetic accounts touched them. With a real practitioner clicking through, an
unresponsive button reads as a broken product.

---

## D. Positioning rulings (Amy's domain, reaffirmed here)

**D1. Complement, never compete.** The directory exists to push traffic *to* practitioners' own sites
and offers. Explicitly rejected on the call: free listing + 1–2% of practitioner sales — *"that's the
opposite incentive structure. It's anti-incentive."* Flat $49/mo is what keeps the posture honest.
Jonathan: *"we want this to complement your website… not compete with it."*

**D2. Two user classes, one shape.** Practitioners with an established site want exposure only;
practitioners with nothing need this to *be* their site. Jonathan: *"If you need a shingle, this is
your shingle. Otherwise, this is just another way to be listed."*

**D3. "High-tech business card" is the honest pitch — use it verbatim.** Sarah brought a cautionary
story: she paid for a Help.com-style directory listing, collected reviews, got **zero** clients, and
quit — *"I was very disappointed in putting any money into that."* She is about to recruit graduates
and needs language that will not set her up to repeat that. Jonathan's framing — a high-tech business
card and a place to aggregate case studies, reviews, and testimonials, with Amy driving promotion
*after* beta and **no short-term traffic expectation** — landed: *"I like using it as a high-tech
business card for now, that's a really great way to describe it for people."*

This should become the canonical recruiting language handed to Sarah, not re-improvised per call.

**D4. Practitioners voice their real business; don't over-tune to HHE.** Lead with HHE-aligned
offerings, position the rest as secondary, don't erase it. Sarah's worry is concrete: a graduate with
a shaman certification, or her own parenting work, contorting their bio to fit an assumed HHE
audience. Jonathan leaned this way but flagged it as Amy's call: *"I hesitate to steer you too
prescriptively."* Diverse practitioners are an asset to the portal.

**D5. Specialty taxonomy normalization is editorial, not engineering.** Free-typed specialties land in
an admin merge queue; the merge-vs-keep-separate policy belongs to Amy + Sarah. Jonathan: *"this is
definitely not a me question, this is a you question, or a you and Amy question."*

**D6. Offerings should be few.** Amy and Sarah have already agreed to discourage more than ~3 per
profile — gateway/wedge offerings, not a full catalog. More clutters the page and confuses buyers.

---

## E. Grade-based directory tiering — DROPPED

~~Amy's vetting model, relayed by Sarah: A grades listed *and searchable*; B- and below get a page but
are not surfaced in search.~~

**Operator ruling 2026-08-12: disregard.** Not building it, not scoping it, not escalating it to Amy.
Recorded here only so the transcript reference doesn't get re-discovered and re-scoped later.

---

## F. Next steps

Jonathan committed on the call to reaching back out **end of that week or early the next** (call was
Tue 8/11 → 8/14–8/18). Sarah is **holding — she will not onboard anyone until given the go-ahead**
(*"I'll wait till you give me the go-ahead"*) and will queue warm leads for outreach starting late in
that week. **That window has now passed** — re-contact is overdue.

### Must ship before Sarah onboards anyone

1. **Fix the trial copy and reset Sarah's clock** (C1, A14). Highest ratio of trust to effort. She will
   be asked about the $49 and the 90 days by every candidate.
2. **Finish the Whop offering→checkout wiring** (C3). Her KYC has cleared; the test case is live and
   waiting.
3. **Solve booking-at-checkout** (B). Sarah's one emphatic requirement, and the difference between a
   working purchase and a dead end.
4. **Re-validate the 12 pilot emails with Sarah before any resend** (C2). She is the right person and
   this is now her job.

### Quick wins, same pass

5. City → free text / typeahead (A1)
6. "Have your ID ready — driver's license or passport" before Setup Payments (A2)
7. "How I work" → "Specialties" (A3)
8. Delete the *Coming soon* tiles from the public profile (A4, A5)
9. Persistent "Edit my profile" for signed-in owners (A6)
10. Regenerate button on the dashboard (A7)
11. Profile card auto-save (A8)
12. Pending states on the 5 Whop buttons (C3)

### Needs Amy

13. Specialty normalization policy (D5)
14. Bio tuning guidance — HHE-first vs. authentic-first (D4)
15. Review of the recruiting-language baseline once drafted (D3) — drafting proceeds without waiting

### Owed to Sarah directly

17. Photo dimensions + the crop widget (A9)
18. The go-ahead, once 1–4 are done

### Standing

Sarah volunteered for repeat usability runs and to exercise regenerate on her own profile — *"anytime
you need a… I'm happy to answer questions, or do another trial run through the whole thing."* She is a
practitioner, teaches business to beginners, and reads the product in client voice unprompted. That is
the most valuable testing channel this project has. Use it before shipping practitioner-facing
changes, not after.
