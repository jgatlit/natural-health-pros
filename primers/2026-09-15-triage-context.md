# Triage context primer — 2026-09-15 (practitioner pricing becomes Plan A / Plan B)

> **Standalone primer, written by `/process-inbox` §3c (automated run, 2026-09-15).** It carries forward what landed in the vault from the **2026-09-14 Jonathan ↔ Amy call** so a session opened in this repo has it without resolving vault wiki-links.
> **Sources (vault):** meeting note `~/vault/300 Entities/Meetings/2026-09-14 HHE Amy Jonathan - Practitioner Pricing Plan A-B + Consumer-First GTM.md` (canonical) · `~/vault/300 Entities/People/Amy (HHE).md` `## Notes` 2026-09-14 (applied by reconciler commit `1928356`, 2026-09-15 05:21).
> **Not applied, still waiting for operator review:** `~/vault/999 Inbox/Triage/2026-09-15-naturalhealthpros-practitioner-pricing-supplement.md`. Its target, `naturalhealthpros.com.md`, **does not exist yet**. This is the sixth supplement queued against that missing entity. The supplement carries a named conflict on the fee model, so treat everything below as **working structure, not locked pricing**.

## What changed since the 2026-09-03 primer

**Pricing is now a practitioner choice between two plans.** Amy ran two feedback calls with HHE students and staff on her own initiative. Practitioners resist a monthly fee: income swings from ~$100 to ~$2,000/mo, and some said they'd cancel $29/mo after one or two months without a booking. They'll accept a bigger platform split on a platform-sourced first session.

| | Plan A | Plan B |
|---|---|---|
| Monthly fee | Yes. Discussed $29; Jonathan leans **$39**; Amy would accept **$49 if a monthly business call is included**. **Undecided, and Jonathan called it Amy's decision.** | None |
| Platform split | Smaller, on referred clients (e.g. **80/20**) | **Larger on the first session** (60/40 or 50/50, practitioner the larger share); later sessions booked privately |
| Suits | Practitioners **without their own payment processing** who need a digital footprint | Practitioners who just want pipeline |
| Whop account | Yes | **Yes, still required.** The split runs through checkout. |

- **Amy's break-even:** above ~$150/mo of platform-sourced business, Plan A is the better deal for the practitioner.
- **Naming:** "Plan A / Plan B", not "tiers", because tiers imply hierarchy.
- **Not offered for now:** a free listing-only "digital business card" tier. That was Jonathan's call and Amy didn't push back. Revisit after Plan A/B ships.
- **Deferred:** paid on-site featured placement (~$199/mo to rank first for a condition search). Jonathan: *"we don't have traffic, so it's like a fictitious value at the moment."*
- ⚠️ **Reconcile with earlier fee models before building price logic.** 2026-09-03: 0% on the practitioner's own link, 20% on NHP-sourced clients for ~12 months (Plan A's 80/20 is consistent with this). 2026-06-04: base 10% plus a 10% client premium. 2026-05-04: 5% take. Plan B is new.

## Build implications for this repo

1. **Next build test: a 50/50 split checkout** through Sarah's or Amy's Whop account, confirming payout in both directions. Jonathan: "I'll get that going." Architecture reference: `docs/PHASE-2C-WHOP-CONNECTED-ACCOUNTS.md`.
2. **Then restructure onboarding/application so a practitioner chooses Plan A or Plan B.** Prices and splits are open, so parameterise them rather than hardcoding.
3. **Unverified claim, don't repeat to the client as fact:** Jonathan told Amy the platform has "full visibility" over totals because the practitioner accounts are independent but linked to the parent. He qualified it as coming from documentation. Verify it against a real transaction (Sarah's test purchase) before relying on it for reporting.
4. **Open design question:** what stops a practitioner rebooking a platform-sourced client privately under Plan B? No rule was set.

## Paid-plan value stack (proposed, not built)

- HHE business-support calls (cadence TBD), HHE continuing education (microbiome, hormone health, nervous system), Ask Zuzu access, other business tools. Extends beyond HHE graduates to chiropractors, massage therapists and others.
- **Amy's listing-standard idea** for non-graduates without a strong referral: a **$399 crash course**. An idea, not decided, and it needs vetting criteria.
- **Owner:** Amy with Sarah drafts the basic benefits-package bullet list for Jonathan to align with public messaging.

## Positioning and go-to-market (landing-page implications)

- **Consumer-first.** Amy: *"our marketing effort is all going to go towards consumer adoption, not towards practitioner adoption."* She wants the first ~80% of the landing page to sell consumers on vetted, education-backed practitioners ("better than figuring it out yourself", "better than ChatGPT", book a session).
- **"Launch pad for practitioners"** (Jonathan's Hinge analogy, adopted by Amy): the platform is transparent that practitioners can outgrow it. *"After that, they're yours."*
- **Competitor to research:** a directory transcribed as "Heal Me" (brand unverified). A practitioner paid it and never got a referral. Goal: sound like the opposite of its practitioner pitch. No owner.
- **Launch traffic sequence (Amy):** announce to HHE's list and get students listed → students refer their own practitioners → social graphics for students → introductory first-session promotion → test ads.
- **Ad channel:** HHE uses Meta. Jonathan recommends **starting with Google** for a public, commoditised audience, because Meta test burn would be high. Both are open to either.
- **Differentiator Jonathan surfaced:** his agentic Meta/Google ad tooling can apportion ad spend to each paying practitioner's geography plus national. It's a possible premium benefit and a new service lane. It's a signal, not a scoped offer.

## Action items by owner (from the 09-14 call)

- [ ] **Jonathan:** configure and run the 50/50 split-checkout test (Sarah's or Amy's Whop account); confirm payout both ways.
- [ ] **Jonathan:** restructure the application so practitioners choose Plan A or Plan B.
- [ ] **Jonathan:** review notes and Amy's call recording; send back ideas on the value areas that made practitioners "perk up".
- [ ] **Jonathan:** look into Google Ads as the starting consumer channel.
- [ ] **Amy (with Sarah):** basic benefits-package bullet list.
- [ ] **Amy:** send the practitioner-feedback call recording or transcript (Slack).

## Still-open items from the 09-03 primer

**Resolved 2026-09-17.** The "two pink buttons" styling bug and the Whop bank-statement descriptor are **dropped by operator directive** and no longer tracked. Production deploy state of the 09-03/04 merges is **confirmed live**: naturalhealthpros.com serves `dpl_6A67xkVHEd1bRdWH9uXguNo3axsZ` (commit `278aa86`, PR #117, ready 2026-09-10), which contains PRs #110-#113.

## Whop key + connected accounts — VERIFIED 2026-09-17

The "our key is an App key missing `company:create`" blocker in `docs/PHASE-2C-WHOP-CONNECTED-ACCOUNTS.md` is **stale**. `WHOP_COMPANY_API_KEY` (`apik_SLZY…f8e4`, company key on `biz_Vpj1G2ryNdPCG0`, API version 2025-01-01) works: `GET /api/v1/companies/biz_Vpj1G2ryNdPCG0` → 200, `GET /api/v5/company` → 200. The earlier 400 came from calling the **collection** endpoint `GET /api/v1/companies` with no `parent_company_id` — that shape requires `company:basic:read` and is not how child accounts are listed.

**Correct enumeration:** `GET /api/v1/companies?parent_company_id=biz_Vpj1G2ryNdPCG0`.

Five connected accounts exist today, each carrying `metadata.practitioner_id` linking back to `Practitioner.whopCompanyId`:

| Company | Title | Created |
|---|---|---|
| `biz_8RDm3wyLlTRUPy` | Jonathan Gudger \| aiChemist | 2026-07-29 |
| `biz_xExE1eUWG4ZMeR` | Sarah Schindler | 2026-08-11 |
| `biz_V9YbXLfAEX9Xam` | Jonathan Gudger | 2026-08-15 |
| `biz_qVQXpYwtcdCNAm` | Amy Sprouse | 2026-09-02 |
| `biz_KMWK9qDuFlzQ1s` | Julie Ericson | 2026-09-11 |

So the connected-account architecture is live and Sarah + Amy are both already onboarded — the 50/50 split-checkout test has a real counterparty and is **not blocked on Whop access**. Both read back `verified: false`; payout readiness still needs confirming against a real transaction.
