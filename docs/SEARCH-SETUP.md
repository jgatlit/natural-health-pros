# Search Setup — Typesense Cloud

> **Status as of 2026-05-24**: cluster `1rt8fj5i9epv2s6mp` provisioned. Local dev verified end-to-end. Vercel envs + production deploy is the remaining operator step.

## Local development

Already complete. The 5 env vars live in `.env.local` + `.env` (gitignored). Bootstrap + reindex have already run:

```bash
# What ran on 2026-05-24:
npm run typesense:bootstrap   # one-shot: create the `practitioners` collection
npm run typesense:reindex     # one-shot: push all 18 seeded practitioners to Typesense

# Then:
npm run dev                   # /search renders live against Typesense Cloud
```

If `.env.local` is ever lost, restore from your password manager OR run `vercel env pull .env.local --yes` once Vercel envs are populated (see below).

## Vercel envs — operator action required before deploy

The Typesense Cloud envs are **not** auto-provisioned via Marketplace (Typesense isn't on the Vercel Marketplace). They need to be added manually for production, preview, and development scopes.

### Step 1: add admin key (server-only) to Vercel

The admin key has full read/write on the cluster — it must NOT be public. Add it to all three Vercel environment scopes:

```bash
vercel env add TYPESENSE_HOST production
# When prompted, paste: 1rt8fj5i9epv2s6mp-1.a1.typesense.net

vercel env add TYPESENSE_PORT production
# Paste: 443

vercel env add TYPESENSE_PROTOCOL production
# Paste: https

vercel env add TYPESENSE_ADMIN_API_KEY production
# Paste the admin key
```

Repeat the four commands for `preview` and `development` scopes (so Vercel preview deploys + `vercel dev` both work):

```bash
vercel env add TYPESENSE_HOST preview
vercel env add TYPESENSE_PORT preview
vercel env add TYPESENSE_PROTOCOL preview
vercel env add TYPESENSE_ADMIN_API_KEY preview

vercel env add TYPESENSE_HOST development
vercel env add TYPESENSE_PORT development
vercel env add TYPESENSE_PROTOCOL development
vercel env add TYPESENSE_ADMIN_API_KEY development
```

### Step 2: add public search key + public host

The search-only key is intentionally bundled with client JS (Typesense scopes it to read-only). Both vars need the `NEXT_PUBLIC_` prefix so Next.js bakes them into the client bundle.

```bash
vercel env add NEXT_PUBLIC_TYPESENSE_HOST production
# Paste: 1rt8fj5i9epv2s6mp-1.a1.typesense.net

vercel env add NEXT_PUBLIC_TYPESENSE_SEARCH_API_KEY production
# Paste the search-only key
```

Repeat for `preview` and `development`.

### Step 3: verify

```bash
vercel env ls 2>&1 | grep TYPESENSE
```

You should see 5 distinct env vars × 3 scopes = 15 entries (or 5 entries with all-scope markers).

### Step 4: trigger a redeploy

Vercel does NOT pick up env changes until the next deploy. Either push a commit or:

```bash
vercel --prod
```

## Cluster operations (Typesense Cloud dashboard)

- **Dashboard**: https://cloud.typesense.org → Cluster `1rt8fj5i9epv2s6mp`
- **Snapshots**: Cloud auto-snapshots daily. To restore: dashboard → Snapshots → Restore.
- **Scaling**: starter tier is the smallest. Upgrade tier in dashboard if RAM/CPU pressure shows up at Phase 2 scale.
- **API key rotation**: dashboard → API Keys → Regenerate. After rotation, update Vercel envs + `.env.local` + redeploy.

## Routine operator tasks

### Reindex after seed changes

```bash
npm run db:seed          # writes practitioners to Neon
npm run typesense:reindex   # pushes them to Typesense Cloud (upsert; idempotent)
```

### Reset the collection (drops all docs)

```bash
npm run typesense:reset     # drops + recreates the collection from the schema
npm run typesense:reindex   # re-push all practitioners
```

Use this if the schema in `deployment/typesense-collection-schema.json` changes (e.g., new field added). Typesense supports additive schema changes via `collection.alter()`, but for Phase 1 simplicity we drop-and-recreate.

### Adding a new practitioner (Phase 2 — once provider edit flows ship)

The app-layer reindex pattern is wired in `src/lib/practitioner-indexer.ts`:

```ts
import { indexPractitioner } from '@/lib/practitioner-indexer';

// In a Server Action that creates/updates a Practitioner:
await prisma.practitioner.update({ where: { id }, data: { ... } });
await indexPractitioner(id);  // pushes the updated doc to Typesense
```

`indexPractitioner` is a no-op if `TYPESENSE_ADMIN_API_KEY` isn't set — local dev without keys won't crash.

## Cost estimate

- Phase 1 (today): Typesense Cloud starter tier ~$26/mo
- Phase 2 (500-2K practitioners, hundreds of searches/day): same tier holds, possibly upgrade to $50/mo
- Phase 3 (10K+ practitioners): cluster sizing decision based on RAM (each practitioner doc ~1KB indexed, ~2× in memory)

## Security notes

- **Admin key was pasted in chat during initial setup** (2026-05-24). Consider rotating via Typesense Cloud dashboard once the operator is comfortable the deployment is stable.
- **`.env.local` and `.env` are gitignored** — never commit them. If accidentally committed, rotate immediately.
- **Search-only key in `NEXT_PUBLIC_*`** is intentional and safe — Typesense Cloud scopes it to read operations on a specific collection. Public exposure is expected and built into the engine's auth model.

## Architecture diagram

```
Browser
  ↓ /search page (Next.js client component)
  ↓ NEXT_PUBLIC_TYPESENSE_SEARCH_API_KEY
  ↓ Typesense REST API
Typesense Cloud (1rt8fj5i9epv2s6mp-1.a1.typesense.net)
  ↑ collection: practitioners (18 docs as of 2026-05-24)
  ↑
Vercel Functions (Next.js Server Actions, future)
  ↑ TYPESENSE_ADMIN_API_KEY
  ↑ indexPractitioner(id) on upsert
  ↑
Prisma → Neon Postgres (source of truth)
```

## Reference

- `src/lib/typesense-server.ts` — admin client (lazy-init, server-only)
- `src/lib/typesense-search.ts` — InstantSearch adapter (client-side)
- `src/lib/practitioner-indexer.ts` — `indexPractitioner`, `indexAllPractitioners`, `deleteFromIndex`
- `scripts/typesense-bootstrap.ts` — idempotent collection creation
- `scripts/typesense-index.ts` — bulk reindex (Prisma → Typesense)
- `scripts/typesense-reset.ts` — drop + recreate collection
- `deployment/typesense-collection-schema.json` — Typesense schema (matches §3 of `SEARCH-REQUIREMENTS.md`)
- `src/components/search/*` — UI components (Block C)
- `src/app/search/page.tsx` — search page
