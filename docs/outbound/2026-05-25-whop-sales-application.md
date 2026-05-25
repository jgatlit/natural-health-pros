---
date: 2026-05-25
channel: email
to: sales@whop.com
from: Jonathan Gudger <jgatlit@gmail.com>
cc: (optional — add Blake/Amy if they want visibility)
subject: Whop for Platforms application — HHE Directory (multi-tenant practitioner marketplace)
purpose: Request invite-only access to Whop for Platforms / Connected Accounts API for HHE Directory's Phase 2C payment infrastructure.
related: docs/PHASE-2-PLAN.md §2C, docs/SEARCH-SETUP.md
---

# Email draft — Whop for Platforms application

---

**Subject:** Whop for Platforms application — HHE Directory (multi-tenant practitioner marketplace)

Hi Whop team,

I'm building **HHE Directory** — a curated practitioner directory with integrated booking and payments for graduates of Holistic Health Educators programs. Applying for **Whop for Platforms / Connected Accounts** access.

---

**What we are**

HHE Directory connects patients with HHE-trained holistic health practitioners (functional medicine, gut health, hormone balance, mind-body coaching, herbal medicine). MVP is live at https://hhe-directory.vercel.app — search, filter by specialty + city, click into a practitioner profile, book a consult.

Production stack: Next.js 14 (App Router) on Vercel · Prisma 6 + Neon Postgres · Typesense Cloud for search · NextAuth + Resend for practitioner auth · Cal.com / Calendly for scheduling (practitioner-managed).

Today: 18 seeded practitioners. Target: 50 within 60 days, 500+ within 12 months.

---

**Use case for Whop**

Multi-tenant payment routing. Each practitioner = a Connected Account on Whop. Patient pays via Whop checkout; funds route directly to the practitioner's account; HHE Directory takes an optional platform fee (TBD — likely 0–10%).

Product types we'd map to Whop products:

- One-off intro consultations ($75–$200, 30–60 min)
- Multi-session packages ($300–$2,000)
- Ongoing memberships ($50–$300/month)
- Course-style programs ($200–$1,500)

---

**Why Whop specifically**

- Whop handles KYC + tax for connected accounts — significant compliance lift off our plate
- Memberships + one-time + recurring + creator-program products all in one stack
- Established at our target practitioner scale (you've processed $2.67B GMV across 183K sellers; our 500-practitioner target is well within your wheelhouse)
- Our team is integration-ready — already shipped Cal.com, NextAuth, Resend, Typesense Cloud, and standard Whop creator-account integrations in the past week

---

**Volume estimates** (rough; willing to share more during qualification)

| Horizon | Practitioners | Annual GMV (est.) | Avg transaction |
|---|---|---|---|
| Year 1 | 50–100 | ~$300K | $150–$300 |
| Year 2 | 200–500 | ~$2–3M | $150–$300 |
| Year 3+ | 500–2,000 | $10M+ | $150–$300 |

Geography: US, Georgia-concentrated launch (HHE's footprint), national expansion in Year 2.

---

**Compliance**

Practitioners handle patient health information adjacent to PHI. HIPAA compliance is on our roadmap. Strong preference for partners with **SOC 2 + HIPAA support**. Please confirm Whop for Platforms supports our use case under those constraints (or what's required to enable it).

---

**Technical readiness**

- **API integration**: ready. Webhook handlers ready for payment/refund/payout/dispute events into our Postgres source-of-truth.
- **Frontend**: Next.js 14 App Router. Can embed Whop checkout components or use hosted-checkout URLs — your call on the preferred integration pattern.
- **Empirical note**: I tested our current Whop creator-account API key (`apik_r09aRuWqXq1Iv_...`) against Whop's API earlier this week. It returns 401 on `/connected_accounts`, `/users/me`, `/me` — confirming we're on standard creator-account scope and need the Platforms upgrade for this use case.

---

**Ask**

1. **Qualification**: Confirm HHE Directory qualifies for Whop for Platforms / Connected Accounts.
2. **Pricing**: What's the structure for the volume tier we'd land at — Year 1 ($300K GMV) vs Year 2+ ($2M+ GMV)? Platform fee + processing fee + any monthly minimums.
3. **Underwriting timeline**: typical days-to-approval given our volume bracket?
4. **HIPAA / SOC 2**: enablement path for partners handling health-adjacent data.

---

**Timing**

We have an in-person meeting with our HHE budget authority on **2026-05-28** to lock the Phase 2 build sequence. Ideal to have at least a directional response ("yes, qualified, here's the path") before our Phase 2 sprint kicks off in early June. Happy to jump on a 20-minute call any time this week if it accelerates qualification.

---

Thanks for considering — looking forward to building on Whop.

Jonathan Gudger
Founder, HHE Directory
jgatlit@gmail.com
https://hhe-directory.vercel.app

---

## Delivery notes — pre-send checklist for the operator

- [ ] Decide cc list: Amy (HHE budget authority) and/or Blake (practitioner-side Whop integration owner). Both have skin in this; cc'ing them creates aligned visibility.
- [ ] Verify the live URL renders correctly before pressing send (https://hhe-directory.vercel.app). First impression matters.
- [ ] Decide whether to share the Whop key fingerprint (`apik_r09aRuWqXq1Iv_...`) — it's already public-ish in the chat transcript and adds credibility ("we already use Whop, we just need to upgrade"). Recommend: include.
- [ ] Decide which email to send from: `jgatlit@gmail.com` (current operator address) OR a real HHE Directory domain address once that's set up. For first contact, gmail is fine.
- [ ] **Volume estimates** — these are rough; confirm with Amy before sending if she has firmer practitioner-target numbers from HHE's program enrollment data.
- [ ] **Geographic framing** — "GA-concentrated launch" reflects the 61% GA seed. If Amy wants a different positioning (national-first, multi-state-from-day-one), adjust before sending.
- [ ] **Platform fee** — I wrote "0–10%, TBD." If Amy + Blake have already adjudicated this (or want it locked before Whop sees the application), update before sending.

## What to do if no response within 5 business days

1. Follow up once via the same thread — short, "checking on this, happy to share more detail or jump on a call."
2. If still silent after 10 business days: assume Whop is not prioritizing or the use case doesn't fit their current sales bandwidth. Switch to fallback architecture (Stripe Connect or paymentUrl pass-through). Document in `docs/PHASE-2-PLAN.md §2C` why we pivoted.

## Related artifacts

- Full Phase 2C architecture spec: `docs/PHASE-2-PLAN.md` §2C
- Empirical Whop API key scope test: see commit `0d63437` notes
- 5/28 demo prep doc with this in the Q&A bank: `docs/DEMO-PREP-5-28.md`
- Memory pointer (Whop platforms blocker): vault — pending entry post-meeting
