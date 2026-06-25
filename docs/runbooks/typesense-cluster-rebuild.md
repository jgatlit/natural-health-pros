# Runbook — Rebuild the Typesense Cloud Cluster

> **Why this exists**: On 2026-06-24 the Typesense Cloud cluster `1rt8fj5i9epv2s6mp` was found **terminated** — its host `1rt8fj5i9epv2s6mp-1.a1.typesense.net` no longer resolves (DNS NXDOMAIN). `/search` returns HTTP 200 but the SSR initial search hangs against the dead host, so the streamed page never resolves past the loading skeleton. `/` is unaffected (it never touches Typesense). This runbook recreates an **identical-or-better** cluster and rewires the app. Execute top-to-bottom once the new admin API key is in hand.

**Status**: ✅ EXECUTED 2026-06-24 — search restored (see Execution Log). Keep this runbook for the next rebuild.
**Owner**: operator (jgatlit). **Est. execution time**: ~20–30 min once key arrives.

### Execution Log
- **2026-06-24** — original cluster `1rt8fj5i9epv2s6mp` terminated; rebuilt as **`vm8gj01ubsi7hyxep`** (host `vm8gj01ubsi7hyxep-1.a2.typesense.net`, Server **v30.2**, single-node Starter). Ran bootstrap → reindex (13 docs) → synonyms (21 groups); rewired Vercel env (host + 2 keys × 3 scopes via v10 REST single-POST — no CLI bug); also fixed a pre-existing latent bug where `TYPESENSE_PORT`/`TYPESENSE_PROTOCOL` were stored EMPTY in the **production** scope only (set to 443/https). Redeployed prod (`hhe-directory-j5ul8xcpl`). Verified: `/search` 200 in ~0.9s with real hits (was hanging 15s).

---

## 0. What broke and what stays the same

The app code, schema, scripts, and Vercel project are all intact. **Nothing in the repo needs to change to restore parity** — only the external cluster and the env vars that point at it. The "more optimal" code changes in §7 are optional hardening, separable from restore.

Source-of-truth artifacts (already in repo, do not regenerate):
| Artifact | Path |
|---|---|
| Collection schema | `deployment/typesense-collection-schema.json` |
| Doc transform (Prisma → Typesense) | `src/lib/practitioner-indexer.ts` |
| Synonym-set sync (dual-label taxonomy) | `src/lib/typesense-synonyms.ts` |
| Admin client | `src/lib/typesense-server.ts` |
| Search-only client | `src/lib/typesense-client.ts` |
| InstantSearch adapter | `src/lib/typesense-search.ts` |
| Provisioning scripts | `scripts/typesense-{bootstrap,reset,index,synonyms-sync}.ts` |

---

## 1. Provision the new cluster (Typesense Cloud dashboard)

Dashboard: https://cloud.typesense.org

**Critical version requirement — DO NOT pick an older version:**
- Provision **Typesense Server v30.x** (latest 30.x; current is **v30.2**).
- The codebase uses the **named Synonym Sets** API (`client.synonymSets(...).upsert()` + `collection.update({ synonym_sets: [...] })`). This API only exists on **v29+** (the legacy per-collection `/synonyms` endpoint was removed). On any version < 29, `npm run typesense:synonyms` will **404 silently** and the dual-label "gut health ⇄ digestive disorders" collapse + symptom-bridge will not work.

**Configuration to match the original (parity baseline):**
| Setting | Original | Note |
|---|---|---|
| Server version | v30.x | **must be ≥ v29; pick latest 30.x** |
| Region | (match original — likely `us-east` / AWS, host suffix `.a1.`) | keep close to Vercel `iad1` for low SSR latency |
| Plan | **Starter (~$26/mo, single node) — CHOSEN** (operator decision 2026-06-24, identical to original) | see §7.1 |
| Memory/CPU | starter default | 18→~20 docs today; tiny — default is ample |

**Decision: RESOLVED 2026-06-24 — single-node Starter** (identical to original; cost-prioritized). HA (§7.1) deferred. Multi-node client config (§7.2) therefore not needed.

After creation, capture from the dashboard:
- **Host**: `<NEW_CLUSTER_ID>-1.a1.typesense.net` (the nearest-node hostname; HA clusters also expose `-2`, `-3`)
- **Admin API key** (full access) — the one "expected soon"
- **Search-only API key** — generate one (Dashboard → API Keys → "Generate Search Only Key"), OR script it (see §7.5). This becomes `NEXT_PUBLIC_TYPESENSE_SEARCH_API_KEY` (public-safe, search-scoped only).

---

## 2. Update local env (`.env` + `.env.local`)

Prisma + the tsx scripts read `.env`; Next dev reads `.env.local`. Update **both**. Six Typesense vars:

```bash
# .env  AND  .env.local  — replace the host + both keys (port/protocol unchanged)
TYPESENSE_HOST=<NEW_CLUSTER_ID>-1.a1.typesense.net
TYPESENSE_PORT=443
TYPESENSE_PROTOCOL=https
TYPESENSE_ADMIN_API_KEY=<NEW_ADMIN_KEY>
NEXT_PUBLIC_TYPESENSE_HOST=<NEW_CLUSTER_ID>-1.a1.typesense.net
NEXT_PUBLIC_TYPESENSE_SEARCH_API_KEY=<NEW_SEARCH_ONLY_KEY>
```

> `.env` is gitignored — never commit it. Keep `.env` and `.env.local` byte-identical for these six vars.

Sanity-check the new host resolves before proceeding:
```bash
curl -s -o /dev/null -w "health HTTP=%{http_code}\n" \
  "https://<NEW_CLUSTER_ID>-1.a1.typesense.net/health"   # expect HTTP=200
```

---

## 3. Build the collection + index data + sync synonyms (local, against new cluster)

Run in order. Each script reads `.env` (`tsx --env-file=.env`, already wired in package.json):

```bash
# 3a. Create the `practitioners` collection from the schema JSON (idempotent)
npm run typesense:bootstrap
#   → "Creating collection \"practitioners\"…" / "Collection created."
#   (If it says "already exists", the collection survived — fine.)

# 3b. Index every practitioner from Neon → Typesense (upsert)
npm run typesense:reindex
#   → "Indexed N practitioners."   (N ≈ 20 pilot practitioners)

# 3c. Sync the dual-label taxonomy → Synonym Set, and attach it to the collection
npm run typesense:synonyms
#   → "Synced K synonym groups."   (requires v29+ — see §1)
```

> If the schema or `toTypesenseDoc()` ever changed, use `npm run typesense:reset` (drop+recreate) instead of `:bootstrap`, then `:reindex`. For a clean rebuild on a brand-new cluster, `:bootstrap` is sufficient — there's nothing to drop.

---

## 4. Rewire Vercel env vars (all 3 scopes × 6 vars)

The app reads these at build (NEXT_PUBLIC_*) and runtime. Update **Production, Preview, Development**. Only the **host** and **two keys** change (3 vars); port/protocol are unchanged but listed for completeness.

> ⚠️ **Known CLI bug** (memory `hhe-directory-vercel-env-provisioning`): `vercel env add … preview --value … --yes` hangs in an `action_required` loop. Production + Development work via piped stdin; **Preview must use the REST API**.

### 4a. Remove the stale values first (CLI, all scopes)
```bash
for v in TYPESENSE_HOST TYPESENSE_ADMIN_API_KEY \
         NEXT_PUBLIC_TYPESENSE_HOST NEXT_PUBLIC_TYPESENSE_SEARCH_API_KEY; do
  for env in production preview development; do
    vercel env rm "$v" "$env" --yes 2>/dev/null
  done
done
# (TYPESENSE_PORT / TYPESENSE_PROTOCOL are unchanged — leave them.)
```

### 4b. Re-add Production + Development (CLI, stdin pipe works)
```bash
NEW_HOST="<NEW_CLUSTER_ID>-1.a1.typesense.net"
NEW_ADMIN="<NEW_ADMIN_KEY>"
NEW_SEARCH="<NEW_SEARCH_ONLY_KEY>"

for env in production development; do
  echo "$NEW_HOST"   | vercel env add TYPESENSE_HOST "$env"
  echo "$NEW_ADMIN"  | vercel env add TYPESENSE_ADMIN_API_KEY "$env"
  echo "$NEW_HOST"   | vercel env add NEXT_PUBLIC_TYPESENSE_HOST "$env"
  echo "$NEW_SEARCH" | vercel env add NEXT_PUBLIC_TYPESENSE_SEARCH_API_KEY "$env"
done
```

### 4c. Re-add Preview (REST API — CLI bug workaround)
```bash
TOKEN=$(jq -r .token ~/.local/share/com.vercel.cli/auth.json)
PROJECT_ID="prj_hILUAi7uYNQfCJkcXlX4mG4Kn32E"   # HHE Directory
TEAM_ID="team_SJCnYFL92raN3dI1l86PpyeF"          # ai-chemist

add_preview () { # $1=key $2=value
  curl -s -X POST "https://api.vercel.com/v9/projects/$PROJECT_ID/env?teamId=$TEAM_ID" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"key\":\"$1\",\"value\":\"$2\",\"type\":\"encrypted\",\"target\":[\"preview\"]}"
  echo
}
add_preview TYPESENSE_HOST "$NEW_HOST"
add_preview TYPESENSE_ADMIN_API_KEY "$NEW_ADMIN"
add_preview NEXT_PUBLIC_TYPESENSE_HOST "$NEW_HOST"
add_preview NEXT_PUBLIC_TYPESENSE_SEARCH_API_KEY "$NEW_SEARCH"
```

### 4d. Verify (no values printed)
```bash
vercel env ls | grep -i typesense   # expect 6 vars × 3 scopes = 18 rows, all "Encrypted"
```

---

## 5. Redeploy production

NEXT_PUBLIC_* vars are **build-time inlined** — a redeploy is required for the new host/search key to reach the browser bundle. A plain env change does NOT hot-swap them.

```bash
git commit --allow-empty -m "chore(search): rebuild Typesense cluster — rewire env" && git push origin main
# Vercel GitHub App auto-deploys. Or force: vercel --prod
```

---

## 6. Verify the restore

```bash
# 6a. Cluster health
curl -s -o /dev/null -w "health=%{http_code}\n" "https://$NEW_HOST/health"          # 200

# 6b. /search streams to completion (no hang) and contains a real hit, not just skeleton
curl -sS --max-time 15 https://hhe-directory.vercel.app/search \
  | grep -c 'data-slot="skeleton"'   # should be LOW / page should also contain practitioner names
curl -sS --max-time 15 -o /dev/null -w "search HTTP=%{http_code} time=%{time_total}s\n" \
  https://hhe-directory.vercel.app/search   # completes well under 15s (was timing out at 15s)
```

Then in a browser: load `https://hhe-directory.vercel.app/search`, confirm:
- [ ] Practitioner cards render (not a perpetual skeleton)
- [ ] Specialty / city / state / years facets populate with counts
- [ ] A synonym query works (e.g. search "digestive" surfaces a "Gut Health" practitioner) — proves §3c synonym set attached
- [ ] `isComplete:=true` gate holds (only complete profiles show)

**Verification checklist:**
- [ ] New cluster on v30.x (`curl https://$NEW_HOST/health` + dashboard version)
- [ ] `:bootstrap` created `practitioners`
- [ ] `:reindex` reported N ≈ 20 docs
- [ ] `:synonyms` reported K > 0 groups (proves v29+ synonym-sets API reachable)
- [ ] 18 Vercel env rows, all Encrypted
- [ ] Prod redeployed AFTER env update
- [ ] `/search` completes < 15s with real hits

---

## 7. "More optimal" — recommended improvements (optional, separable from restore)

These are the upgrades worth making **while we're rebuilding anyway**. None block the basic restore; flag each to the operator.

### 7.1 High-Availability cluster (resilience) — DEFERRED (Starter chosen 2026-06-24)
The original was a **single-node Starter**, a single point of failure for the July pilot. Typesense Cloud offers a **3-node Highly Available** config (auto-failover, no-downtime upgrades) at ~3× cost. **Operator chose Starter (cost-prioritized).** Revisit before/at GA if search uptime becomes revenue-critical. If adopted later, also do §7.2.

### 7.2 Multi-node client config (pairs with 7.1) — N/A while Starter
Today `typesense-server.ts`, `typesense-client.ts`, and `typesense-search.ts` each hardcode a **single** node. Only needed if §7.1 HA is adopted (list `-1/-2/-3` + `nearestNode`). No-op for the single-node Starter.

### 7.3 SSR resilience — ✅ IMPLEMENTED 2026-06-24 (branch `fix/search-ssr-resilience`)
The reason the 2026-06-24 outage was *invisible* (HTTP 200, infinite skeleton) is that the adapter's **server-side** initial search had no tight timeout/error boundary — it hung (~15s = 5s × ~3 retries) instead of failing fast. Shipped:
1. `src/lib/typesense-search.ts` — adapter `server` now sets `connectionTimeoutSeconds: 2`, `numRetries: 1`, `retryIntervalSeconds: 0.5`, `healthcheckIntervalSeconds: 15`. Bounds failure to a few seconds.
2. `src/components/search/SearchUnavailable.tsx` — `SearchErrorBoundary` (class, catches SSR/render throws) + `SearchErrorState` (inline `useInstantSearch().error` guard for non-throwing errors), rendering a "Search is temporarily unavailable / Try again" notice.
3. `src/components/search/SearchExperience.tsx` — wraps the `InstantSearchNext` subtree in both.

Net effect: a dead/slow cluster now degrades to an honest, actionable message in ~2–4s instead of a perpetual skeleton. Cluster-tier-independent.

### 7.4 Uptime monitoring — ✅ IMPLEMENTED (branch `feat/search-uptime-monitoring`)
The 2026-06-24 outage was found manually because nothing alerted us. Shipped a lightweight probe that asserts BOTH the cluster `/health` **and** a real search returning hits (`found > 0`) — the content assertion the HTTP-200 shell could never give us:

1. `src/lib/search-probe.ts` — `probeSearch()`: `GET https://<host>/health` (expects `{ok:true}`) + `GET /collections/practitioners/documents/search?q=*` (expects `found > 0`). 4s timeout per check, never throws. Resolves host/key from `NEXT_PUBLIC_TYPESENSE_HOST` / `NEXT_PUBLIC_TYPESENSE_SEARCH_API_KEY` (falls back to the admin key).
2. `src/app/api/health/search/route.ts` — returns 200 healthy / **503 + `Sentry.captureMessage`** on failure. Auth-gated by `Authorization: Bearer $CRON_SECRET` when `CRON_SECRET` is set (open otherwise, for local curl).
3. `vercel.json` — Vercel Cron hits `/api/health/search` every 15 min (`*/15 * * * *`). Adjust cadence to plan limits (Hobby = daily only; Pro/Enterprise = any). Set `CRON_SECRET` in Vercel env so the endpoint isn't publicly pollable.
4. `scripts/probe-search-uptime.ts` (`npm run probe:search`) — same checks from the CLI; exits 1 on failure. Use after a rebuild, or to drive an external cron (BetterStack / GitHub Actions / `/loop`) instead of Vercel Cron.

**Post-rebuild check:** `npm run probe:search` should print `✅ Search stack healthy (N indexed practitioners)`.

### 7.5 Script the search-only key (determinism)
The search-only key was created **manually** in the dashboard — undocumented and non-reproducible. Add a `typesense:keys` script that derives a search-scoped key from the admin key via the API:
```ts
client.keys().create({ description: 'hhe search-only', actions: ['documents:search'], collections: ['*'] })
```
Makes future cluster rebuilds fully scripted end-to-end.

### 7.6 Pin & document the server version
Record "Typesense Server v30.x" as the provisioning contract (this runbook + the `typesense-instantsearch-gotchas` memory). Prevents a future rebuild from silently regressing the synonym-sets feature by picking an older version.

---

## 8. Update memory after execution
Once restored, update:
- Memory `typesense-instantsearch-gotchas` → new cluster ID/host, server version, provisioned date.
- `CLAUDE.md` "Stack" + "Where things are" → new cluster ID/host.
- This runbook → mark which §7 optimizations were adopted.
