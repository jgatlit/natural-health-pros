# Quick Start — User Flows (Natural Health Pros)

Prod: **https://naturalhealthpros.com** (LIVE over HTTPS since 2026-07-15) · also **https://hhe-directory.vercel.app** (default `.vercel.app`, project not yet renamed). Brand: Theme D "Midnight Navy".

> **Auth note:** authorization gates are **ON** (re-enabled 2026-07-16 for public launch). `/admin/*` requires an **ADMIN** session; `/practitioners/*/edit` requires sign-in **+ ownership** (or admin); `/onboarding` requires a **valid invitation matching your email**. Sign-in is magic-link (Resend) sent from `agent@naturalhealthpros.com`. The public directory (`/search`, practitioner profiles) needs no sign-in.

---

## 1. Admin / operator flow
| Do | Where |
|---|---|
| **Invite a practitioner** | `/admin/invites` → enter email → sends a magic-link invite (invite is optional right now — onboarding also works without one) |
| **Moderate specialties** | `/admin/specialties` → approve/reject practitioner-submitted specialty terms (PENDING queue); approving syncs Typesense synonyms |
| **Dashboard** | `/admin` → live counts (pending invites, Whop-connected, webhooks, pending aliases) |
| **Payments observability** (Layer Y, pending) | `/admin/connected-accounts`, `/admin/whop-webhooks` → "pending Whop Platforms access" |

## 2. Practitioner onboarding flow (first run)
1. Click the invite email → **magic-link sign-in** → land on **`/onboarding`**.
2. Fill the form: **name** + **"Describe your practice"** (free-text — who you help, approach, background) + **specialties** + optional city / years / session formats.
3. **Generate** → AI one-shot builds your landing page (headline, bio, who-I-help, modalities, outcomes) from your description. *(Pre-filled practitioners see "Review & Regenerate".)*
4. You land on your **live public page** with a "Your page is live" banner → link to your dashboard.

## 3. Practitioner dashboard (ongoing) — `/practitioners/[slug]/edit`
- **Profile**: name, headline, bio, who-I-help, **photo upload**, website, telehealth/in-person, city, years, specialties. "Regenerate with AI" re-drafts from a description.
- **Offerings**: add / edit / remove — name · description · price · one-time vs monthly · category. Shown on your public page. *(Online checkout for these = Layer Y, coming with Whop Platforms.)*
- **Booking links**: your scheduling URLs (Cal.com / Calendly / SavvyCal / Acuity…).
- **Directory listing**: **Subscribe · $59/mo** → Whop checkout → once paid you're listed in search. Pilots show **"Complimentary"** and are listed free.

## 4. Public / patient flow
- **`/`** — featured practitioners + search entry.
- **`/search`** — symptom / specialty / city search → matched practitioners.
- **`/practitioners/[slug]`** — a practitioner's landing page: photo, bio, specialties, offerings, booking CTA.

## Listing gate — who appears in discovery
A practitioner shows in **search + featured** only when their profile is **complete** (name + city + bio ≥20 chars + ≥1 specialty) **AND** (`comped` **OR** subscription `ACTIVE`). Direct profile links always resolve, listed or not.

## Payments at a glance
- **Layer X** (LIVE): practitioner pays **$59/mo** to be listed → our Whop → `/api/whop/webhook` flips them to ACTIVE. Config: `docs/LAYER-X-SUBSCRIPTION.md`.
- **Layer Y** (deferred): patients pay practitioners for their offerings via connected Whop accounts — gated on the invite-only Whop Platforms grant.
