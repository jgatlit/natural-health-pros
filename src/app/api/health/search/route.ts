import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { probeSearch } from '@/lib/search-probe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Search-stack uptime probe endpoint (Task C). Wired as a Vercel Cron in
 * vercel.json. Returns 200 when both the Typesense cluster /health and a real
 * search (found > 0) pass; 503 + a Sentry alert otherwise.
 *
 * Auth: when CRON_SECRET is set, requires `Authorization: Bearer <CRON_SECRET>`
 * (Vercel Cron sends this header automatically). When unset (e.g. local dev),
 * the endpoint is open so it can be curled directly.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const result = await probeSearch();

  if (!result.ok) {
    const failed = result.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
    // Both surfaces: structured log (Vercel log drains) + Sentry alert (paging).
    console.error('[search-uptime] PROBE FAILED', JSON.stringify({ failed, result }));
    Sentry.captureMessage(`Search uptime probe failed: ${failed.join(' | ')}`, 'error');
    return NextResponse.json(result, { status: 503 });
  }

  return NextResponse.json(result, { status: 200 });
}
