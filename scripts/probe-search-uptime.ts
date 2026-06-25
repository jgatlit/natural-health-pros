/**
 * Standalone search-stack uptime probe (Task C).
 *
 * Same checks as the /api/health/search Vercel Cron route: asserts the Typesense
 * cluster /health is ok AND that a real search returns hits (found > 0). Use this
 * for manual verification (e.g. after a cluster rebuild — see
 * docs/runbooks/typesense-cluster-rebuild.md §7.4) or to drive an external cron
 * (BetterStack, GitHub Actions, /loop) when not relying on Vercel Cron.
 *
 * Exits 0 when healthy, 1 when any check fails (so it pages CI / cron wrappers).
 *
 * Usage: tsx --env-file=.env scripts/probe-search-uptime.ts
 */
import { probeSearch } from '../src/lib/search-probe';

async function main() {
  const result = await probeSearch();
  console.log(`Search uptime probe @ ${result.checkedAt} (${result.durationMs}ms)`);
  for (const c of result.checks) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.name} (${c.durationMs}ms): ${c.detail}`);
  }
  if (!result.ok) {
    console.error('\n❌ Search stack UNHEALTHY — see failed checks above.');
    process.exit(1);
  }
  console.log(`\n✅ Search stack healthy (${result.found} indexed practitioners).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
