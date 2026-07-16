---
date: 2026-05-25
audience: sales@whop.com (Whop Platforms team)
channel: outbound email
from: Jonathan Gudger (aiChemist) <jgatlit@gmail.com>
purpose: Request access to Whop for Platforms / Connected Accounts API for HHE Directory — a multi-tenant practitioner marketplace.
related artifacts:
  - Live product: https://hhe-directory.vercel.app
  - Live search demo: https://hhe-directory.vercel.app/search
  - Operator's company entity (internal): aiChemist
  - Client company entity (internal): Holistic Health Educators (HHE)
---

# Email: Whop for Platforms application

## Subject

> Whop for Platforms application — HHE Directory (practitioner marketplace, ~20 → 2K sellers)

## Body

Hi Whop team,

I'm building **HHE Directory** — a curated practitioner marketplace for graduates of [Holistic Health Educators](https://www.holistichealtheducators.com/)' functional medicine + holistic nutrition + mind-body programs. The product is live at https://hhe-directory.vercel.app (search at https://hhe-directory.vercel.app/search — feel free to click around).

We're requesting access to **Whop for Platforms / Connected Accounts**. We've confirmed from your docs that this is invite-only and our current creator-account API key returns 401 on `/connected_accounts` — hence the outreach.

### What we're building (one paragraph)

Patients discover HHE-trained practitioners via search → click into a Linktree-style profile → book an intro consult → pay for ongoing programs (memberships, packages, custom invoices). HHE Directory is the platform; each practitioner is an independent seller with their own pricing and offerings. We want Whop to handle the payment routing, KYC, and tax compliance so each practitioner can onboard once and receive direct payouts. HHE may take a small platform fee per transaction (open — depends on what's typical for your Platforms customers).

### Volume + technical readiness

- **Practitioners (sellers)**: 18 seeded today; ~20 real practitioners within 6 weeks (Phase 2); 500-2,000 within 12-24 months
- **Expected GMV** (rough): $50K Year 1 ramp, $500K-$2M Year 2 once practitioner volume scales
- **Compliance**: holistic-health domain; **not HIPAA-required** (we're a directory, not an EHR or telehealth platform). Standard tax + payout compliance for independent practitioners across US states.
- **Stack**: Next.js 14 + Prisma + Neon Postgres + Vercel. Already wired with Cal.com (booking), NextAuth (auth), Resend (transactional email), Typesense Cloud (search). Whop Platforms slots in cleanly as the payments primitive.
- **Engineering capacity**: ready to integrate immediately; Phase 2A + 2B (auth + booking) shipped this week.

### What we'd love to learn

1. Eligibility — is our use case (practitioner marketplace, $50K → $2M GMV trajectory) a fit for Platforms?
2. Onboarding timeline — how long does Whop's underwriting typically take?
3. Fee structure — what's the platform-side economics on Connected Accounts?
4. Whether the existing aiChemist/HHE Whop creator account can be upgraded to a Platforms account, or whether a fresh setup is needed

Happy to jump on a 15-minute call. Demo of the live product is two clicks (https://hhe-directory.vercel.app/search → click any practitioner → see the Linktree-style profile that's waiting for the Browse-offerings + Request-invoice surfaces to become real via Whop).

Thanks,
**Jonathan Gudger**
aiChemist
jgatlit@gmail.com
[HHE Directory live](https://hhe-directory.vercel.app)

---

## Delivery notes / pre-send checklist

- [ ] Operator: align with Blake first — confirm Whop is the agreed payments primitive vs Stripe Connect / custom marketplace before sending. Avoid sending if Blake's been pursuing a different infrastructure path in parallel.
- [ ] Operator: confirm the volume projections match what you'd tell Amy (this email is independent outreach but the numbers should be consistent with the 5/28 demo conversation)
- [ ] Operator: edit the "Engineering capacity" line if you want to attribute differently (Jonathan vs Blake vs HHE-side eng)
- [ ] Send from `jgatlit@gmail.com` OR a domain you control if HHE has one set up — sales reps trust domain-matched senders
- [ ] Reply window: Whop sales typically responds within 1-3 business days. If silence after 5 business days, follow up once with subject `Re: Whop for Platforms application — HHE Directory` + one-line bump.

## What NOT to do

- **Don't include the live API key in the email.** That's a creator-account key; they'll issue a new one with Platforms scope after underwriting.
- **Don't oversell GMV.** The $500K-$2M Year 2 number is a reasonable range given the practitioner scale assumption. Don't inflate — Whop's underwriting team will scrutinize.
- **Don't ask for a discount in the first email.** Establish fit first; pricing/economics come in the response thread.

## If Whop says no or pricing is prohibitive

Fallback options (in priority order):
1. **Stripe Connect Express** — same architecture (platform + connected accounts), broader reach, transparent pricing (2.9% + $0.30 processing + 0.25% Connect fee). Stack-compatible.
2. **Lemon Squeezy** — merchant of record handles all tax/compliance; simpler but less practitioner-control.
3. **Practitioner-owned URLs** (the path we rolled back 2026-05-25) — lowest fidelity but ships immediately; revisit only if both Whop and Stripe Connect are off the table.

## Source material this draft was built from

- [Whop Connected Accounts docs](https://docs.whop.com/manage-your-business/manage-payouts/connected-accounts)
- [Whop Payments Network blog post](https://whop.com/blog/whop-payments-network/) — confirms Whop for Platforms is Stripe-Connect-equivalent and explicitly designed for multi-tenant marketplaces
- Live empirical test (2026-05-25): current API key `apik_r09aRuWqXq1Iv_...` returns 401 on `/connected_accounts`, `/users/me`, `/me` — confirmed standard creator-account scope
- Decisions-JSON Phase 1 YES rows (Whop named as the payment primitive at the 2026-05-15 joint call with Amy + Blake)
