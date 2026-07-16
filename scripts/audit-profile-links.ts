/**
 * Link-health audit: probe every third-party URL we publish on a practitioner profile.
 *
 * Why this exists: on 2026-07-16 a pilot's `websiteUrl` (https://fixmysexlife.com) had no DNS
 * records at all — her public profile had been sending patients to a domain that doesn't
 * resolve. It looked perfectly grounded on inspection (her email is @fixmysexlife.com, so
 * domain and identity aligned); it simply wasn't reachable. Plausibility is not reachability,
 * and only probing tells them apart. Link rot is recurring, so this is a script, not a one-off.
 *
 * Scope: URLs we publish and attribute to a named practitioner — Practitioner.websiteUrl and
 * BookingLink.url. These are NEVER LLM-generated (they aren't in ProfileDraft); they come from
 * the pilot import or the practitioner's own edit form. So a failure here is bad DATA, and the
 * fix is the row, not the prompt.
 *
 *   npm run links:audit           # human table; exit 1 if anything is DEAD
 *   npm run links:audit -- --json # machine-readable, for cron/CI
 *
 * Exit code is 0 only when nothing is DEAD, so this is safe to schedule.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const JSON_OUT = process.argv.includes('--json');
const TIMEOUT_MS = 20_000;

type Verdict = 'OK' | 'DEAD' | 'WARN';
type Row = {
  slug: string;
  field: 'websiteUrl' | 'bookingLink';
  label: string | null;
  url: string;
  verdict: Verdict;
  status: number | null;
  finalUrl: string | null;
  title: string | null;
  reason: string;
};

/**
 * One self-contained probe per URL. Deliberately holds the response body in a local — an earlier
 * cut of this audit wrote every fetch to one shared temp file and, on failure, silently reported
 * the PREVIOUS url's title. That manufactured false positives against real practitioners' pages,
 * which is worse than no audit at all.
 */
async function probe(url: string): Promise<Pick<Row, 'verdict' | 'status' | 'finalUrl' | 'title' | 'reason'>> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ctl.signal, headers: { 'user-agent': 'NaturalHealthPros-LinkAudit/1.0' } });
    const html = await res.text().catch(() => '');
    const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim() || null;

    if (!res.ok) return { verdict: 'DEAD', status: res.status, finalUrl: res.url, title, reason: `HTTP ${res.status}` };
    // 200 with no <title> is usually a parked page or a JS-only shell — suspicious, not proven bad.
    if (!title) return { verdict: 'WARN', status: res.status, finalUrl: res.url, title: null, reason: '200 but no <title> — parked page or JS-only shell?' };
    return { verdict: 'OK', status: res.status, finalUrl: res.url, title, reason: '' };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Distinguish "domain does not exist" from "slow/blocked" — very different remediations.
    const dns = /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg);
    const aborted = /abort/i.test(msg);
    return {
      verdict: 'DEAD',
      status: null,
      finalUrl: null,
      title: null,
      reason: dns ? 'DNS does not resolve — domain dead or expired' : aborted ? `no response in ${TIMEOUT_MS / 1000}s` : msg.slice(0, 80),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const practitioners = await prisma.practitioner.findMany({
    select: { slug: true, websiteUrl: true, bookingLinks: { select: { label: true, url: true } } },
    orderBy: { slug: 'asc' },
  });

  const targets: Omit<Row, 'verdict' | 'status' | 'finalUrl' | 'title' | 'reason'>[] = [];
  for (const p of practitioners) {
    if (p.websiteUrl) targets.push({ slug: p.slug, field: 'websiteUrl', label: null, url: p.websiteUrl });
    for (const b of p.bookingLinks) targets.push({ slug: p.slug, field: 'bookingLink', label: b.label, url: b.url });
  }

  const rows: Row[] = [];
  for (const t of targets) rows.push({ ...t, ...(await probe(t.url)) });

  if (JSON_OUT) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.log(`\n  ${rows.length} published third-party URL(s) across ${practitioners.length} profiles\n`);
    for (const r of rows) {
      const icon = r.verdict === 'OK' ? '✅' : r.verdict === 'WARN' ? '🟡' : '🔴';
      console.log(`  ${icon} [${r.slug}] ${r.field}${r.label ? ` (${r.label})` : ''}`);
      console.log(`     ${r.url}`);
      if (r.verdict === 'OK') console.log(`     ${r.status} · ${r.title}`);
      else console.log(`     ${r.reason}`);
    }
    const dead = rows.filter((r) => r.verdict === 'DEAD');
    const warn = rows.filter((r) => r.verdict === 'WARN');
    console.log(`\n  ${rows.filter((r) => r.verdict === 'OK').length} ok · ${warn.length} warn · ${dead.length} dead`);
    if (dead.length) {
      console.log('\n  🔴 DEAD — these are published on real practitioners\' pages. Null the field or replace the URL:');
      for (const d of dead) console.log(`     ${d.slug}: ${d.url}  (${d.reason})`);
    }
  }

  // Non-zero only for DEAD, so this can be scheduled without alerting on soft warnings.
  process.exit(rows.some((r) => r.verdict === 'DEAD') ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
}).finally(() => prisma.$disconnect());
