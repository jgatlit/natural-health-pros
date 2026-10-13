# Primer — 2026-10-08 Jonathan ↔ Amy call (Care Network / EHR phase) + week of 10-08 → 10-13

> **Read after `2026-09-15-triage-context.md`.** Staged 2026-10-13 from the vault.
> **Sources:** Zoom `36159431-6ec6-4ef2-8dd2-75645f56fb50` (vault `source_fetch zoom`, transcript + summary; the call runs ~13:00–59:00 of the recording) · Slack DM `D0A7J21LKQR` (Amy ↔ Jonathan, 10-07 → 10-10) · Amy SMS 2026-10-12 · vault plan `art_4eb6233f64dd49d5904f` · pricing model `art_826faf6384104b288dd7`.

## Production state (verified 2026-10-10, unchanged since)

- `main` = `6418d52`; apex serves `dpl_Brn2QQw8mTJFFdZRGDaDhFkQhrjj` (= `6418d52`).
- `feat/referrals-v14` was **fast-forwarded into `main` on 2026-09-29**. The recurring in-term fee rule, `/admin/commercial-settings` and `/r/<token>` referral links are live. Any note saying "referrals not merged" is stale.
- Merged branches still on origin, safe to delete: `feat/referrals-v14`, `feat/plan-ab-page-edits`, `fix/checklist-and-specialty-field`.

## What the 10-08 call added

1. **A second product: the Care Network** (Amy calls it "telehealth"; it can't be called that publicly). Client fills a health form → pays ~$45 intake → RN health-coach intake call (20–30 min) → assigned practitioner → health coach (client picks from 3–7) → program quoted up front ($350 / $2–5K / ~$3K six-month weight loss).
2. **Supply:** a small, hand-picked subset of the directory (~top 5–10 coaches to start; "20% of the directory, if that"), scouted from the directory.
3. **EHR is bought, not built.** Amy wants Biocanic (data tracking, Nexus AI Scribe); dislikes Practice Better.
4. **Lane split (Jonathan):** NHP owns listing, payments, marketing, referrals. The EHR owns client records, intake, notes, Scribe.
5. **Payments stay on Whop** with each practitioner's own account. Posture: faith-based / holistic wellness network, member-to-member, non-clinical. Needs counsel.
6. **Care Network split = 60% practitioner / 40% NHP** (Amy's "40-40", clarified by the operator 2026-10-10). Like every % fee, it runs for the n-month Lead Attribution Term only.
7. **Directory soft launch to the 15,000-person HHE list** comes first (Jonathan: "in the next week or two").
8. **Future:** B2B staffing (physicians and corporate wellness need health coaches). Add a profile toggle "open to outside contract opportunities". This is a draft task, not yet approved.

## Pricing — recommendation pending Amy (`art_826faf6384104b288dd7`)

| | Plan A | Plan B | Care Network |
|---|---|---|---|
| Live today | $39 + 20% | 40% | — |
| Proposed founding (first cohort, 12-mo lock) | $29 + 10% | 30% | 40% |
| Proposed standard | $39 + 15% | 35% | 40% |

Rates are env/admin config, not code. Keeping each practitioner on the rate card they joined on would need code: draft task `tsk_f2ba960147524e238031`, not approved.

## Biocanic — verified list prices (biocanic.com/pricing, 2026-10-10)

| Plan | Monthly | Annual |
|---|---|---|
| Core | $75/mo | $720/yr ($60/mo) |
| Max (prescribers, not needed) | $175/mo | $1,680/yr |
| **Nexus** (AI agent, up to 8 practitioners, API) | $299/mo | $2,870.40/yr ($239.20/mo) |
| White label | $1,250 one-time | |

⚠️ **The 10-10 Slack message to Amy used different figures** ("$1900/yr Nexus", "$1200 white label", "additional $159/mo", "$219/mo per practitioner"). Per the published page, Nexus annual is **$2,870.40** ($239.20/mo, i.e. **$179.20/mo above Core annual**) and white label is **$1,250**. Correct this with Amy before quoting numbers. The open question still stands: does Nexus price cover **up to 8 practitioners**, or is it per practitioner?

**Biocanic Nexus demo:** Tue 2026-10-13 16:30–17:15 ET with Lucy Bellville (BDR). The question list is in vault task `tsk_3936c57f13654c4aba69`.

## Week of 10-08 → 10-13 — Amy's open items

- **Amy SMS 2026-10-12 13:07:** wants to meet **Tue 10-13** "to firm things up before our big call on Thursday". Jonathan replied he'd send an invite for Tuesday afternoon. **As of 00:21 10-13 no invite is on either calendar.** Jonathan's Tuesday: Anil 14:30–15:30 and Biocanic 16:30–17:15 are booked, so the open windows are before 14:30 or 15:30–16:30.
- **Thursday 10-15:** the standing "Jonathan / Amy weekly touchpoint HHE-directory" is 12:00–13:00 ET. Amy's "big call on Thursday" is a call where she hopes to bring in cash by offering **a business course + 3 support calls as a $1K upsell**. Whether that is the weekly touchpoint or a separate call with her audience is **unconfirmed**. Ask on Tuesday.
- **Amy SMS 2026-10-12:** HHE **cannot make the payment due 10-15 for now**. Jonathan: "no worries, let me know the target date to re-run it". Amy hopes Thursday's call covers it. There is no target date yet.

## Suggested agenda for Tuesday

1. Thursday call: what it is, who attends, what Amy needs from Jonathan (a pricing slide, a directory demo, a sign-up link for the $1K upsell?).
2. The $1K upsell (business course + 3 support calls) maps to the **Plan A value stack** from 09-14 (HHE business calls / CE). Decide whether it is sold separately or bundled into Plan A or the founding rate.
3. Founding vs standard rates (`tsk_4d9371c189e24f28a03f`), so the Thursday audience can enroll on known terms.
4. Biocanic: correct the Slack figures and preview the demo questions.
5. Payment: agree a target re-run date.
