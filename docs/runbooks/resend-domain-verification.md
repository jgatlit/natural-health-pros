# Runbook — Verify a Resend sending domain (fix transactional email)

> **Why this exists**: On 2026-07-10, driving a live test of the invite-resend feature (PR #20), creating/resending an invitation to a non-owner address returned **HTTP 500**. Root cause: `EMAIL_FROM = "HHE Directory <onboarding@resend.dev>"` uses Resend's **shared sandbox sender**, which only delivers to the account owner's own verified address — Resend returns 403 for any other recipient, so `sendInvitationEmail` (`src/lib/email.ts`) throws. This was **latent** because the 12 pilot invitations were DB-seeded (`invitedBy = system`, no email ever attempted). Verifying a real sending domain lifts the restriction. This runbook adds + verifies the domain and rewires `EMAIL_FROM`.

**Status**: ⏳ NOT YET EXECUTED — ⛔ blocked on Amy's (client) Cloudflare domain-admin auth (`tsk_2395b0d2`, → Jonathan); the DKIM/SPF records need zone access she controls. Engineering detail: `tsk_196d0a58`. Fold into the launch-bundle Cloudflare session (`tsk_1d2b5c90`).
**Owner**: operator (jgatlit / Jonathan). **Est. execution time**: ~15–30 min (mostly DNS propagation wait).

### Execution Log
- _(pending — record cluster/domain id, region, and verified timestamp here on execution)_

---

## 0. What breaks and what stays the same

Nothing in the repo needs to change to fix this — only the external Resend domain and the `EMAIL_FROM` env var. `src/lib/email.ts` already reads `EMAIL_FROM` and gracefully degrades (console-log, no send) when `RESEND_API_KEY` is unset; the failure only occurs when Resend is configured **and** rejects the send. The §5 code hardening is optional and separable.

| Fact | Value |
|---|---|
| Domain | `naturalhealthpros.com` (Cloudflare DNS — nameservers `serenity/terry.ns.cloudflare.com`) |
| Sender lib | `src/lib/email.ts` → `sendInvitationEmail` (Resend SDK) |
| Current (broken) | `EMAIL_FROM = "HHE Directory <onboarding@resend.dev>"` (sandbox sender + stale brand) |
| Target | `EMAIL_FROM = "Natural Health Pros <noreply@naturalhealthpros.com>"` |
| Vercel env scopes | development · preview · production (set all three) |

Values below are the Resend template — **the real DKIM values are generated per-domain; copy them from the dashboard**, don't hardcode.

## 1. Add the domain in Resend

Dashboard → **Domains → Add Domain** → `naturalhealthpros.com` (verify the **root** so `from` can be `noreply@naturalhealthpros.com`). Pick a region (e.g. `us-east-1`) — the MX/SPF host values are region-specific; use whatever Resend then shows.

## 2. Copy the generated DNS records

| Record | Name | Type | Value |
|---|---|---|---|
| Feedback | `send` | MX | `feedback-smtp.us-east-1.amazonses.com` (priority 10) |
| SPF | `send` | TXT | `"v=spf1 include:amazonses.com ~all"` |
| DKIM ×3 | `<token>._domainkey` | CNAME | `<token>.dkim.amazonses.com` |

Some domains get a single `resend._domainkey` **TXT** instead of three CNAMEs — use whatever the dashboard shows. Skip the optional `links` tracking CNAME (not needed for transactional mail).

## 3. Add the records in Cloudflare

naturalhealthpros.com zone → DNS → Records:
- ⚠️ **Proxy status = DNS only (grey cloud)** on every DKIM / CNAME record — never orange-cloud a mail record.
- ⚠️ **Do NOT append the domain to the Name** — Cloudflare auto-adds the zone. Enter `send`, `<token>._domainkey` — **not** `send.naturalhealthpros.com`.
- ⚠️ **One SPF TXT per name** — the fresh `send` subdomain has no existing SPF, so no merge needed; just don't duplicate.

## 4. Verify + rewire the app

1. Back in Resend, click **Verify**. Cloudflare propagation is usually **<15 min**; status flips to `verified`.
2. Set on Vercel (all three scopes — also fixes the stale "HHE Directory" brand):
   ```
   EMAIL_FROM = "Natural Health Pros <noreply@naturalhealthpros.com>"
   ```
   Dashboard: Settings → Environment Variables → edit `EMAIL_FROM` for Production + Preview + Development. Or via REST (avoids the CLI 54.4.1 empty-value bug — PATCHes all three entries in place):
   ```bash
   TOKEN=$(python3 -c "import json;print(json.load(open('$HOME/.local/share/com.vercel.cli/auth.json'))['token'])")
   PROJECT_ID="prj_hILUAi7uYNQfCJkcXlX4mG4Kn32E"; TEAM_ID="team_SJCnYFL92raN3dI1l86PpyeF"
   BODY=$(NEW='Natural Health Pros <noreply@naturalhealthpros.com>' python3 -c "import os,json;print(json.dumps({'value':os.environ['NEW']}))")
   for ID in $(curl -s "https://api.vercel.com/v9/projects/$PROJECT_ID/env?teamId=$TEAM_ID" -H "Authorization: Bearer $TOKEN" \
     | python3 -c "import json,sys;[print(e['id']) for e in json.load(sys.stdin)['envs'] if e['key']=='EMAIL_FROM']"); do
     curl -s -X PATCH "https://api.vercel.com/v9/projects/$PROJECT_ID/env/$ID?teamId=$TEAM_ID" \
       -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$BODY" -o /dev/null -w "patched $ID -> %{http_code}\n"
   done
   ```
   ⚠️ Only run this AFTER the domain shows `verified` — setting the new sender before verification makes ALL sends fail (Resend rejects the unverified domain).
3. Redeploy (env changes require a new build).
4. **Confirm**: send a test invite to a non-owner address via `/admin/invites` → expect **200** + delivery (no 500). A safe target is a `+alias` of the operator's own inbox.

## 5. Optional hardening (separable — not required to fix the 500)

`createInvitation` + `resendInvitation` (`src/app/admin/invites/actions.ts`) persisted the invitation row **before** calling `sendInvitationEmail`, so a Resend failure left a stale pending/reactivated row (confirmed live: a 500'd create still wrote the row). Flagged in the PR #20 review (note #1). ✅ **SHIPPED — PR #21 (`9f6d04c`)** reordered both actions to send-then-persist, so a rejected send now leaves no DB side effect. (New rare trade: send-OK-then-DB-write-fails yields an emailed link with no row; the accept route degrades that to a clean "expired" card.)

## 6. Related

- **NextAuth magic-link** — CONFIRMED shares this sender (`src/auth.config.ts:22` uses the same `EMAIL_FROM`), so non-owner practitioners can't sign in until the domain is verified → HARD prereq for the auth-gate re-enable (`tsk_1d2b5c90`, step 2). Order: verify domain → email works → re-enable gates.
- **Pairs with** the launch-bundle apex DNS cutover — same Cloudflare session. Resend records are independent of the apex A record, so order doesn't matter. ⛔ Both are blocked on Amy's Cloudflare domain-admin auth (`tsk_2395b0d2`).
- Vault: DNS-config task `tsk_2395b0d2` (→ Jonathan, blocked-on-Amy); engineering escalation `tsk_196d0a58`; runbook artifact `art_6bb222e3`.
