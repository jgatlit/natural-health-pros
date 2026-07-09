import { TYPESENSE_COLLECTION } from './typesense-server';

/**
 * Lightweight uptime probe for the search stack (Task C). Asserts BOTH:
 *   1. the Typesense cluster /health endpoint reports {ok:true}, and
 *   2. a real search query against the practitioners collection returns hits
 *      (found > 0) — not merely an HTTP 200.
 *
 * The 2026-06-24 outage was invisible precisely because the page returned 200
 * while the data path was dead (see docs/runbooks/typesense-cluster-rebuild.md
 * §7.4). Asserting `found > 0` is the content check that would have caught it.
 *
 * Framework-agnostic (plain fetch + env) so it runs from the Vercel Cron route
 * and the standalone scripts/probe-search-uptime.ts identically.
 */

export type ProbeCheck = {
  name: string;
  ok: boolean;
  detail: string;
  durationMs: number;
};

export type ProbeResult = {
  ok: boolean;
  checks: ProbeCheck[];
  found: number;
  durationMs: number;
  checkedAt: string;
};

const TIMEOUT_MS = 4000;

function resolveTarget(): { host: string; apiKey: string } {
  const host = process.env.NEXT_PUBLIC_TYPESENSE_HOST || process.env.TYPESENSE_HOST || '';
  // Prefer the search-only key; fall back to admin so the probe still runs in
  // contexts where only the admin key is provisioned (e.g. local scripts).
  const apiKey =
    process.env.NEXT_PUBLIC_TYPESENSE_SEARCH_API_KEY || process.env.TYPESENSE_ADMIN_API_KEY || '';
  return { host, apiKey };
}

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
}

/** Run both checks. Never throws — failures are captured as failed ProbeChecks. */
export async function probeSearch(): Promise<ProbeResult> {
  const checkedAt = new Date().toISOString();
  const started = Date.now();
  const { host, apiKey } = resolveTarget();
  const checks: ProbeCheck[] = [];
  let found = 0;

  if (!host || !apiKey) {
    checks.push({
      name: 'config',
      ok: false,
      detail: 'Typesense host or API key not configured (NEXT_PUBLIC_TYPESENSE_HOST / *_SEARCH_API_KEY).',
      durationMs: 0,
    });
    return { ok: false, checks, found, durationMs: Date.now() - started, checkedAt };
  }

  const base = `https://${host}`;
  const headers = { 'x-typesense-api-key': apiKey };

  // 1. Cluster /health
  {
    const t = Date.now();
    try {
      const res = await timedFetch(`${base}/health`, { headers });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean };
      const ok = res.ok && body.ok === true;
      checks.push({
        name: 'cluster-health',
        ok,
        detail: ok ? 'cluster reports ok' : `unexpected /health response (HTTP ${res.status})`,
        durationMs: Date.now() - t,
      });
    } catch (err) {
      checks.push({
        name: 'cluster-health',
        ok: false,
        detail: `unreachable: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - t,
      });
    }
  }

  // 2. Real search returns hits (content assertion, not just HTTP 200)
  {
    const t = Date.now();
    const params = new URLSearchParams({ q: '*', query_by: 'displayName', per_page: '1' });
    const url = `${base}/collections/${TYPESENSE_COLLECTION}/documents/search?${params}`;
    try {
      const res = await timedFetch(url, { headers });
      const body = (await res.json().catch(() => ({}))) as { found?: number };
      found = typeof body.found === 'number' ? body.found : 0;
      const ok = res.ok && found > 0;
      checks.push({
        name: 'search-hits',
        ok,
        detail: ok
          ? `search returned ${found} indexed practitioner(s)`
          : `search returned no hits (HTTP ${res.status}, found=${found})`,
        durationMs: Date.now() - t,
      });
    } catch (err) {
      checks.push({
        name: 'search-hits',
        ok: false,
        detail: `search failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - t,
      });
    }
  }

  return {
    ok: checks.every((c) => c.ok),
    checks,
    found,
    durationMs: Date.now() - started,
    checkedAt,
  };
}
