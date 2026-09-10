# Whop payments configuration — findings and per-practitioner runbook

**Date:** 2026-09-08
**Trigger:** Sarah Schindler reported a Whop notification asking her to verify a domain for Apple Pay,
and asked whether it was a platform-side or practitioner-side task.
**Status:** Apple Pay fixed for Amy + Sarah. Statement descriptor default set. BNPL blocked on
business verification. Jonathan's own practitioner account still pending.

---

## TL;DR

| Item | State |
|---|---|
| Apple Pay / Google Pay in embedded checkout | ✅ Fixed — domain file shipped (PR #115), verified on Amy + Sarah |
| Payment methods (cards, wallets, ACH, installments) | ✅ Already all-enabled by default — never the blocker |
| Bank statement descriptor | ⚠️ `WHOP*` prefix is **unremovable**; default set to `WHOP* NATURALHEALTHPROS` |
| Klarna / Affirm (BNPL) | ❌ Blocked — requires business verification of Holistic Health Network LLC |
| Payouts on the platform account | ❌ Blocked — same business verification; can collect, cannot pay out |
| PayPal | ❌ Not set up — separate per-account flow |
| Checkout ceiling | ⚠️ $2,500 max per transaction, per account |

---

## 1. Wallets (Apple Pay / Google Pay)

**Root cause.** Apple requires the *embedding* domain to be registered against the *merchant of
record*. Our booking flow uses `WhopCheckoutEmbed`, and the merchant is the practitioner's connected
account — so each account needed `naturalhealthpros.com` registered. Whop's hosted checkout pages
already support wallets with no setup; only embedded checkout needs this.

**Payment-method config was never the problem.** Every account ships with all methods checked and
*"Include default payment methods"* ON. `accept_card_payments` is `active` everywhere, and the SDK
documents it as *"Card payins, including Apple Pay and Google Pay."*

**The fix that scales.** Whop serves ONE platform-wide domain-association file — decoded it carries a
`pspId` and no merchant id:

```json
{"version":1,"pspId":"646A8BB6…53F2","createdOn":1760664777432}
```

So hosting it once at our apex satisfies every account that registers the domain. Shipped in PR #115
at `public/.well-known/apple-developer-merchantid-domain-association` (228 bytes, byte-exact), with
`.well-known` excluded from the middleware matcher and a `whop:health` check that byte-compares our
copy against Whop's.

> ⚠️ **Use self-hosted verification, never Whop-hosted.** Whop-hosted repoints the domain's A/CNAME at
> Whop and warns verbatim *"This step will cause downtime for your domain"*, then has you revert — and
> since Whop stops serving the file after you revert, it buys no ongoing maintenance. On a live apex
> that is a pure outage, repeated once per practitioner.

**No inheritance.** Registering the domain on the parent `biz_Vpj1G2ryNdPCG0` **and** enabling
*"Share domains with connect accounts"* did **not** clear `setup_apple_pay_domains` on any child.
Treat the setting as per-account.

**But the per-account cost is one click.** Whop auto-adds the parent's domain to each connected
account at creation, parked in `Needs verification` (Sarah's dated Aug 15, Amy's Sep 2 — their
onboarding dates). Once our file is live, verifying is a single menu action.

### Runbook — per practitioner (~15 seconds)

1. `https://whop.com/dashboard/<biz_id>/?settings=checkout%2Fapple-pay`
2. The `…` menu on the `naturalhealthpros.com` row → **Self-hosted verification** → **Verify domain**
3. Confirm: `GET /accounts/<biz_id>` no longer lists `setup_apple_pay_domains`

`required_actions` is a **reliable oracle** — it flipped YES→no the instant Sarah's domain verified.

> ⚠️ **Not yet proven:** that Apple Pay actually *renders* on an Apple device. Everything above is
> verification state, not a rendered button. Confirm on a real iPhone in Safari before telling
> practitioners wallets are live.

---

## 2. Bank statement descriptor

**`WHOP*` cannot be removed.** Confirmed three independent ways:

1. The dashboard dialog contains exactly one textbox (accessibility tree) — no input for the prefix.
2. `ProductCreateParams.custom_statement_descriptor`: *"Must start with `WHOP\*`."*
3. The `Product` read model: *"Maximum 22 characters, including required `WHOP*` prefix."* (22 − 5 = 17)

So statements can never read "Holistic Health Network" alone. Best achievable is
`WHOP* NATURALHEALTHPROS`. **Set expectations with the client accordingly.**

Editable portion: **17 characters, uppercase letters and digits only.**

### Two levels — and why the API one is a trap

| Level | How | API |
|---|---|---|
| **Account** | Settings → Checkout → *Custom statement descriptor* | ❌ None. Absent from `AccountUpdateParams` **and** from the account read object |
| **Product** | `custom_statement_descriptor` on `ProductCreateParams` | ⚠️ Create-only; absent from `ProductUpdateParams` |

> ⚠️ **Do not set a house default via the product-level API.** Product overrides account, and the
> account value is unreadable via API — so code cannot detect who has customized, and an
> unconditional product default would silently stomp a practitioner's own descriptor. The
> account-level setting already has the desired semantics: house default, practitioner overwrites.

**Live state:**

| Account | Descriptor |
|---|---|
| `biz_Vpj1G2ryNdPCG0` — parent | `WHOP* NATURALHEALTHPROS` *(set 2026-09-08)* |
| `biz_xExE1eUWG4ZMeR` — Sarah | `WHOP* WILDANDROOTED` *(self-set, approved, retained)* |
| `biz_qVQXpYwtcdCNAm` — Amy | `WHOP* AMYSPROUSE` *(self-set, approved, retained)* |
| `biz_V9YbXLfAEX9Xam` — Jonathan | unset |

All products carry `custom_statement_descriptor: null`, so the account value governs. The parent's
value did **not** propagate to the unset child — assume no inheritance.

> ⚠️ `calculated_statement_descriptor` exists in Whop's **v5** `CompanyPayment` schema but is **absent
> from the v1 payment response**, so the API cannot confirm what actually printed. A real bank
> statement is the only proof. (Payments are readable per company via
> `GET /payments?company_id=biz_…`; unscoped returns 401.)

---

## 3. Klarna / Affirm (BNPL) — blocked

Lives at **Settings → Payments → Financing → Apply**, *not* the Checkout payment-methods panel (whose
"Buy Now Pay Later" tab reads "No payment methods in this category" until approved).

`accept_bnpl_payments` is `inactive` on the parent and every child, with `financing_disabled: false` —
so nothing suppresses it; it has simply never been applied for.

Clicking **Apply** on the parent redirects to identity verification with:

> **"Business verification required — You must verify your business before applying."**

Three paths offered: *Verify as an individual* (unlocks payouts + card), **_Verify your business_**
("Verify a registered company to **unlock additional payment methods**" ← the BNPL gate), and *Form a
new business*.

**Blocked on:** business verification of [Holistic Health Network LLC](#5-entity--merchant-of-record),
which requires a beneficial owner's government ID and SSN.

**Already available today:** Card Installments (3 / 6 / 12 months) are enabled on practitioner
accounts — patients have a pay-over-time option now, just not Klarna/Affirm branded.

---

## 4. Payouts — the bigger blocker behind BNPL

The platform company can **collect but not disburse**:

```
accept_card_payments : active     ← can collect the $49/mo
standard_payout      : inactive
instant_payout       : inactive
bank_deposit         : inactive
REQUIRED: verify_identity → "Complete verification to unlock cards and payouts"
```

Zero Layer X checkouts have been minted, so nothing is stranded yet. But the moment practitioners are
asked to pay, revenue accumulates in a Whop balance with no route to a bank account. **Business
verification is not a Klarna nice-to-have — it gates the platform receiving its own revenue.**

---

## 5. Entity / merchant of record

**Operator decision (2026-09-08): Holistic Health Network LLC is merchant of record for the $49/mo
listing revenue.**

| Field | Value |
|---|---|
| Legal name | Holistic Health Network LLC |
| Type / state | Domestic LLC, Georgia |
| Control number | 26143167 |
| Organized | 06/25/2026 |
| Principal office | 74 Cole Drive, Hawkinsville, GA 31036 |
| Registered agent / organizer | Amy Sprouse |

Source: GA Certificate of Organization, `~/Downloads/31820531.pdf`.

**Two gaps before verification can proceed:**

1. **No EIN on hand.** A GA Certificate never carries one; it lives on the IRS CP-575. Searched six
   connected mailboxes, two Drives, Slack and local disk — not present. It would have gone to Amy
   personally around late June 2026.
2. **Ownership.** Amy is the sole documented organizer/agent. Georgia does not list LLC members on the
   certificate, so this neither establishes nor excludes Jonathan as a member — the operating
   agreement is the authority. Whop requires a **beneficial owner** to attest, so if Jonathan is not a
   member, **Amy must run the verification personally.**

Outbound ask drafted at `docs/outbound/2026-09-08-email-amy-ein-membership.md`.

---

## 6. Other findings worth knowing

- **$2,500 maximum per checkout**, per account, with a "Request limit review" link on Settings →
  Payments. A hard ceiling on any single high-ticket practitioner offering.
- **PayPal is not set up** — a separate per-account "Setup" flow on the same page.
- **Payment methods diverge per account.** Amy's shows "7 Active" (Card, Apple Pay, Google Pay,
  Installments ×3, ACH) rather than the default all-on. Check per account before assuming a wallet is
  live for someone.
- **3D Secure** is off by default; transactions over $1,000 always require it regardless.
- A **Whop Tax Service** enrollment modal blocks the settings pages on Jonathan's practitioner account
  and must be dealt with before that account can be configured.

---

## Open items

- [ ] Confirm Apple Pay **renders** on a real iPhone at a booking page
- [ ] Jonathan's practitioner account (`biz_V9YbXLfAEX9Xam`): Apple Pay verify + descriptor + dismiss tax modal
- [ ] Amy: send EIN/membership ask
- [ ] Business verification → unlocks payouts **and** the Klarna/Affirm application
- [ ] Consider adding `setup_apple_pay_domains` detection to `whop:health` so new practitioners needing
      the click are visible rather than discovered by their own confusion
