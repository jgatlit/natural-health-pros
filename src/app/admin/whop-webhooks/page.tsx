import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft, Check, AlertTriangle, Clock } from 'lucide-react';
import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { isWhopPlatformsReady } from '@/lib/whop';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export const dynamic = 'force-dynamic';

export default async function WhopWebhooksPage() {
  const session = await auth();
  // ⚠️ TEMP — LOCAL TESTING ONLY: admin gate disabled. REVERT BEFORE PUSH.
  // if (!session?.user || session.user.role !== 'ADMIN') {
  //   redirect('/auth/signin?callbackUrl=/admin/whop-webhooks');
  // }

  const events = await prisma.whopWebhookEvent.findMany({
    orderBy: { receivedAt: 'desc' },
    take: 100,
  });

  const platformsReady = isWhopPlatformsReady();

  return (
    <main className="min-h-screen bg-muted/30 px-4 py-10 sm:py-14">
      <div className="mx-auto max-w-3xl space-y-6">
        <Link
          href="/admin"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to admin tools
        </Link>

        <header className="space-y-1">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">Whop webhooks</h1>
            {!platformsReady && (
              <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
                Pending access
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {platformsReady
              ? 'Last 100 webhook events received from Whop.'
              : 'This view will populate once Whop for Platforms access lands and the /api/whop/webhook handler is wired.'}
          </p>
        </header>

        <Card className="overflow-hidden">
          <div className="border-b bg-muted/40 px-5 py-3">
            <h2 className="text-sm font-semibold">
              Recent events <span className="text-muted-foreground">({events.length})</span>
            </h2>
          </div>
          {events.length === 0 ? (
            <div className="space-y-2 px-5 py-8 text-center">
              <p className="text-sm text-muted-foreground">No webhook events received yet.</p>
              <p className="text-xs text-muted-foreground">
                Events will appear here once practitioners enroll in Whop sub-merchants and
                patients make purchases.
              </p>
              <details className="mt-3 inline-block text-left text-xs">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                  Expected event types
                </summary>
                <ul className="mt-2 space-y-0.5 text-muted-foreground">
                  <li>
                    <code>company.created</code> — sub-merchant created
                  </li>
                  <li>
                    <code>account.verified</code> — KYC complete
                  </li>
                  <li>
                    <code>account.rejected</code> — KYC failed
                  </li>
                  <li>
                    <code>payment.succeeded</code> — patient paid
                  </li>
                  <li>
                    <code>payment.failed</code> — checkout failed
                  </li>
                  <li>
                    <code>payout.scheduled</code> — funds queued
                  </li>
                  <li>
                    <code>payout.paid</code> — funds settled
                  </li>
                  <li>
                    <code>refund.created</code> — refund issued (Phase 2.5)
                  </li>
                </ul>
              </details>
            </div>
          ) : (
            <ul className="divide-y">
              {events.map((e) => {
                const status: 'ok' | 'pending' | 'error' = e.error
                  ? 'error'
                  : e.processedAt
                  ? 'ok'
                  : 'pending';
                return (
                  <li key={e.id} className="flex items-start gap-3 px-5 py-3">
                    <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted">
                      {status === 'ok' && <Check className="h-3.5 w-3.5 text-foreground" />}
                      {status === 'pending' && (
                        <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                      {status === 'error' && (
                        <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                          {e.eventType}
                        </code>
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {e.receivedAt.toLocaleString()} · {e.whopEventId}
                      </p>
                      {e.error && (
                        <p className="mt-1 truncate text-xs text-destructive">{e.error}</p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <p className="text-center text-xs text-muted-foreground">
          See{' '}
          <code className="rounded bg-muted px-1 py-0.5">
            docs/PHASE-2C-WHOP-DESIGN.md
          </code>{' '}
          § Webhook events for the full event catalog.
        </p>
      </div>
    </main>
  );
}
