/**
 * Walk src/app/ for page.tsx + route.ts files, match each against the manifest,
 * render docs/routes-index.html. Run via `npm run docs:routes` (also hooked
 * into prebuild so it stays current on every `npm run build`).
 *
 * Warns on routes discovered in the file tree that have no manifest entry.
 * Pass --check to exit non-zero if drift exists (useful in CI).
 */

import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  ROUTE_META,
  PLANNED_API_ROUTES,
  AUDIENCE_LABELS,
  type Audience,
  type RouteMeta,
} from './routes-meta';

const APP_DIR = join(process.cwd(), 'src', 'app');
const OUT_FILE = join(process.cwd(), 'docs', 'routes-index.html');

type DiscoveredRoute = { path: string; meta: RouteMeta | null; file: string };

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walk(full));
    } else if (entry === 'page.tsx' || entry === 'route.ts') {
      out.push(full);
    }
  }
  return out;
}

function fileToRoute(file: string): string {
  const rel = relative(APP_DIR, file);
  // Strip the trailing /page.tsx or /route.ts
  const segs = rel.split('/').slice(0, -1);
  // Filter out route groups like (marketing) and parallel routes like @modal
  const visible = segs.filter((s) => !s.startsWith('(') && !s.startsWith('@'));
  if (visible.length === 0) return '/';
  return '/' + visible.join('/');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function badgeClass(audience: Audience): string {
  return audience;
}

function authLabel(meta: RouteMeta): string {
  if (meta.authBadge) return meta.authBadge;
  switch (meta.audience) {
    case 'public':
      return 'Public';
    case 'auth':
      return 'Auth required';
    case 'admin':
      return 'Admin';
    case 'api':
      return 'API';
  }
}

function statusBadge(status: RouteMeta['status']): string {
  const map = {
    live: { cls: 'live', label: 'Live' },
    scaffold: { cls: 'scaffold', label: 'Scaffold' },
    'not-yet': { cls: 'scaffold', label: 'Not yet' },
  } as const;
  const { cls, label } = map[status];
  return `<span class="badge ${cls}">${label}</span>`;
}

function renderRoute(path: string, meta: RouteMeta, hasFile: boolean): string {
  const sampleHref = meta.sampleHref ?? path;
  const isClickable = hasFile && meta.status !== 'not-yet';
  const pathEl = isClickable
    ? `<a href="" data-route="${escapeHtml(sampleHref)}" target="_blank">${escapeHtml(path)}</a>`
    : escapeHtml(path);
  const samples = meta.additionalSamples
    ? `<div class="sample-slugs">Sample slugs: ${meta.additionalSamples
        .map(
          (s) =>
            `<a href="" data-route="${escapeHtml(s.href)}" target="_blank">${escapeHtml(s.label)}</a>`,
        )
        .join('')}</div>`
    : '';
  return `
        <div class="route">
          <div>
            <div class="path">${pathEl}</div>
            <p class="desc">${meta.description}</p>
            ${samples}
          </div>
          <div class="badges">
            <span class="badge ${badgeClass(meta.audience)}">${authLabel(meta)}</span>
            ${statusBadge(meta.status)}
          </div>
        </div>`;
}

function renderGroup(audience: Audience, routes: Array<[string, RouteMeta, boolean]>): string {
  if (routes.length === 0) return '';
  const { title, intro } = AUDIENCE_LABELS[audience];
  // Stable, deterministic sort: shorter paths first, then alpha
  routes.sort(([a], [b]) => a.length - b.length || a.localeCompare(b));
  const cards = routes.map(([p, m, f]) => renderRoute(p, m, f)).join('');
  return `
      <section class="group">
        <h2>${escapeHtml(title)}</h2>
        <p class="intro">${escapeHtml(intro)}</p>
        ${cards}
      </section>`;
}

function buildHtml(routesByAudience: Record<Audience, Array<[string, RouteMeta, boolean]>>) {
  const groups: Audience[] = ['public', 'auth', 'admin', 'api'];
  const sections = groups.map((a) => renderGroup(a, routesByAudience[a])).join('\n');

  // Find a sub-set of /auth/* that should be split out as "Auth entry points"
  // — the current routes-meta marks them as 'public' which is correct from a
  // gating perspective but worth visually distinguishing. Keep them in the
  // Public section for simplicity; downstream tweak if needed.

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>HHE Directory · Route Index</title>
    <style>
      :root {
        --bg: oklch(0.985 0 0);
        --fg: oklch(0.145 0 0);
        --muted: oklch(0.556 0 0);
        --border: oklch(0.922 0 0);
        --card: oklch(1 0 0);
        --accent: oklch(0.97 0 0);
        --primary: oklch(0.205 0 0);
        --primary-fg: oklch(0.985 0 0);
      }
      * { box-sizing: border-box; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        background: var(--bg);
        color: var(--fg);
        margin: 0;
        padding: 0;
        line-height: 1.5;
      }
      main { max-width: 960px; margin: 0 auto; padding: 40px 20px 80px; }
      header { margin-bottom: 32px; }
      h1 { font-size: 28px; font-weight: 600; letter-spacing: -0.02em; margin: 0 0 6px; }
      header p { color: var(--muted); font-size: 14px; margin: 0; }
      .toggle {
        display: inline-flex; background: var(--card); border: 1px solid var(--border);
        border-radius: 8px; padding: 2px; margin: 20px 0; gap: 2px;
      }
      .toggle button {
        background: transparent; border: 0; padding: 7px 14px; font-size: 13px;
        font-weight: 500; color: var(--muted); cursor: pointer; border-radius: 6px;
      }
      .toggle button.active { background: var(--primary); color: var(--primary-fg); }
      .toggle button:not(.active):hover { background: var(--accent); color: var(--fg); }
      .group { margin-bottom: 36px; }
      .group h2 {
        font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em;
        color: var(--muted); margin: 0 0 12px;
      }
      .group p.intro { font-size: 14px; color: var(--muted); margin: 0 0 14px; }
      .route {
        background: var(--card); border: 1px solid var(--border); border-radius: 10px;
        padding: 14px 16px; margin-bottom: 8px;
        display: grid; grid-template-columns: 1fr auto; gap: 12px; align-items: start;
      }
      .route .path { font-family: 'SF Mono', Menlo, monospace; font-size: 13px; font-weight: 600; }
      .route .path a {
        color: var(--fg); text-decoration: none; background: var(--accent);
        padding: 2px 8px; border-radius: 5px; display: inline-block;
      }
      .route .path a:hover { background: var(--border); }
      .route .desc { font-size: 13px; color: var(--muted); margin: 4px 0 0; }
      .route .desc strong { color: var(--fg); font-weight: 500; }
      .badges { display: flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; align-items: center; }
      .badge {
        font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
        padding: 3px 8px; border-radius: 999px; border: 1px solid var(--border);
        background: var(--card); white-space: nowrap;
      }
      .badge.public { background: var(--card); color: var(--muted); }
      .badge.auth { background: oklch(0.95 0.05 230); color: oklch(0.4 0.1 230); border-color: oklch(0.85 0.05 230); }
      .badge.admin { background: oklch(0.95 0.04 310); color: oklch(0.4 0.1 310); border-color: oklch(0.85 0.04 310); }
      .badge.api { background: var(--accent); color: var(--muted); }
      .badge.scaffold { background: oklch(0.95 0.05 70); color: oklch(0.4 0.1 70); border-color: oklch(0.85 0.05 70); }
      .badge.live { background: oklch(0.95 0.05 145); color: oklch(0.4 0.1 145); border-color: oklch(0.85 0.05 145); }
      footer { margin-top: 40px; padding-top: 24px; border-top: 1px solid var(--border); font-size: 12px; color: var(--muted); }
      footer a { color: var(--muted); }
      code { font-family: 'SF Mono', Menlo, monospace; font-size: 11px; background: var(--accent); padding: 1px 5px; border-radius: 3px; }
      .sample-slugs { font-size: 12px; color: var(--muted); margin-top: 6px; }
      .sample-slugs a {
        color: var(--muted); text-decoration: underline; text-underline-offset: 2px; margin-right: 8px;
      }
      .sample-slugs a:hover { color: var(--fg); }
      .meta-note {
        font-size: 11px; color: var(--muted); margin-top: 8px;
        font-family: 'SF Mono', Menlo, monospace;
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <h1>HHE Directory · Route Index</h1>
        <p>
          Auto-generated from src/app/ + scripts/routes-meta.ts. Re-runs on every
          <code>npm run build</code>.
        </p>
        <div class="toggle" role="tablist" aria-label="Environment">
          <button id="env-prod" class="active" type="button">Production</button>
          <button id="env-local" type="button">Local (localhost:3000)</button>
        </div>
        <p class="meta-note">Generated ${new Date().toISOString()}</p>
      </header>
${sections}
      <footer>
        <p>
          <strong>Production:</strong>
          <a href="https://hhe-directory.vercel.app" target="_blank">hhe-directory.vercel.app</a>
          &nbsp;·&nbsp;
          <strong>Repo:</strong>
          <a href="https://github.com/jgatlit/HHE-directory" target="_blank">github.com/jgatlit/HHE-directory</a>
          &nbsp;·&nbsp;
          <strong>Vercel:</strong>
          <a href="https://vercel.com/ai-chemist/hhe-directory" target="_blank">vercel.com/ai-chemist/hhe-directory</a>
        </p>
        <p>
          Phase status: 1 ✅ · 2A ✅ · 2B ✅ · 2C ⛔ scaffolded (pending Whop Platforms access)
          · 2D ⏳ pending Amy's curated practitioner list · 2E ⏳ deferred.
        </p>
        <p>
          See <code>docs/PHASE-2-PLAN.md</code>, <code>docs/PHASE-2C-WHOP-DESIGN.md</code>,
          <code>docs/DEMO-PREP-5-28.md</code>.
        </p>
        <p>
          To add a new route: create the page.tsx, add a matching entry in
          <code>scripts/routes-meta.ts</code>, re-run <code>npm run docs:routes</code>
          (or just <code>npm run build</code>).
        </p>
      </footer>
    </main>

    <script>
      (function () {
        var PROD = 'https://hhe-directory.vercel.app';
        var LOCAL = 'http://localhost:3000';
        var current = PROD;

        function applyHrefs() {
          document.querySelectorAll('a[data-route]').forEach(function (a) {
            a.href = current + a.dataset.route;
          });
        }

        document.getElementById('env-prod').addEventListener('click', function () {
          current = PROD;
          document.getElementById('env-prod').classList.add('active');
          document.getElementById('env-local').classList.remove('active');
          applyHrefs();
        });
        document.getElementById('env-local').addEventListener('click', function () {
          current = LOCAL;
          document.getElementById('env-local').classList.add('active');
          document.getElementById('env-prod').classList.remove('active');
          applyHrefs();
        });

        applyHrefs();
      })();
    </script>
  </body>
</html>
`;
}

async function main() {
  const checkMode = process.argv.includes('--check');

  // Discover routes from src/app/
  const files = walk(APP_DIR);
  const discovered: DiscoveredRoute[] = files.map((file) => {
    const path = fileToRoute(file);
    return { path, meta: ROUTE_META[path] ?? null, file };
  });

  // Stable sort
  discovered.sort((a, b) => a.path.localeCompare(b.path));

  // Warn on undocumented routes
  const missing = discovered.filter((r) => !r.meta);
  if (missing.length > 0) {
    console.error('\n⚠️  Routes discovered in src/app/ with no metadata entry:');
    for (const r of missing) {
      console.error(`   ${r.path}  (${relative(process.cwd(), r.file)})`);
    }
    console.error(
      "\nAdd entries to scripts/routes-meta.ts ROUTE_META for each. Generator skipped these in output.\n",
    );
    if (checkMode) process.exit(1);
  }

  // Bucket by audience (filtered to documented routes only, plus planned API entries)
  const buckets: Record<Audience, Array<[string, RouteMeta, boolean]>> = {
    public: [],
    auth: [],
    admin: [],
    api: [],
  };

  for (const { path, meta } of discovered) {
    if (!meta) continue;
    buckets[meta.audience].push([path, meta, true]);
  }

  for (const planned of PLANNED_API_ROUTES) {
    buckets[planned.meta.audience].push([planned.path, planned.meta, false]);
  }

  const html = buildHtml(buckets);
  writeFileSync(OUT_FILE, html, 'utf8');

  const totals = Object.entries(buckets)
    .map(([k, v]) => `${k}=${v.length}`)
    .join(' ');
  console.log(
    `✓ routes-index.html generated (${totals})  →  ${relative(process.cwd(), OUT_FILE)}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
