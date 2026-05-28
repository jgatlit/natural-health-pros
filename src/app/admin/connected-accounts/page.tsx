import Link from 'next/link';
import { ArrowLeft, Check, Clock, X, MinusCircle, AlertCircle } from 'lucide-react';
import { prisma } from '@/lib/prisma';
import { isWhopPlatformsReady } from '@/lib/whop';
import { isProfileComplete } from '@/lib/practitioner-indexer';
import type { WhopKycStatus } from '@prisma/client';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export const dynamic = 'force-dynamic';

export default async function ConnectedAccountsPage() {
  // ⚠️ TEMP — LOCAL TESTING ONLY: admin gate disabled. REVERT BEFORE PUSH.
  // const session = await auth();
  // if (!session?.user || session.user.role !== 'ADMIN') {
  //   redirect('/auth/signin?callbackUrl=/admin/connected-accounts');
  // }

  const practitioners = await prisma.practitioner.findMany({
    include: {
      user: { select: { email: true } },
      whopProducts: { where: { archived: false } },
      specialties: { select: { specialtyId: true } },
    },
    orderBy: [{ whopKycStatus: 'asc' }, { displayName: 'asc' }],
  });

  const byStatus: Record<WhopKycStatus, typeof practitioners> = {
    NOT_STARTED: [],
    PENDING: [],
    VERIFIED: [],
    REJECTED: [],
  };
  for (const p of practitioners) byStatus[p.whopKycStatus].push(p);

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
            <h1 className="text-2xl font-semibold tracking-tight">Connected accounts (Whop)</h1>
            {!platformsReady && (
              <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
                Pending access
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {platformsReady
              ? 'Practitioner sub-merchant Whop accounts, KYC status, and product counts.'
              : 'This view will populate once Whop for Platforms access is granted. See docs/PHASE-2C-WHOP-DESIGN.md.'}
          </p>
        </header>

        <SummaryStrip
          totals={{
            total: practitioners.length,
            verified: byStatus.VERIFIED.length,
            pending: byStatus.PENDING.length,
            notStarted: byStatus.NOT_STARTED.length,
            rejected: byStatus.REJECTED.length,
          }}
        />

        <Card className="overflow-hidden">
          <div className="border-b bg-muted/40 px-5 py-3">
            <h2 className="text-sm font-semibold">
              All practitioners{' '}
              <span className="text-muted-foreground">({practitioners.length})</span>
            </h2>
          </div>
          {practitioners.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-muted-foreground">
              No practitioners yet.
            </p>
          ) : (
            <ul className="divide-y">
              {practitioners.map((p) => {
                const complete = isProfileComplete(p);
                return (
                  <li key={p.id} className="flex items-center gap-3 px-5 py-3">
                    <div className="min-w-0 flex-1">
                      <Link
                        href={`/practitioners/${p.slug}`}
                        className="truncate text-sm font-medium underline-offset-2 hover:underline"
                      >
                        {p.displayName || <span className="italic text-muted-foreground">(no name)</span>}
                      </Link>
                      <p className="truncate text-xs text-muted-foreground">
                        {p.user.email}
                        {p.whopCompanyId && ` · ${p.whopCompanyId}`}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      {!complete && (
                        <Badge
                          variant="outline"
                          className="gap-1 border-amber-500/40 bg-amber-500/10 text-[10px] uppercase tracking-wider text-amber-700 dark:text-amber-400"
                        >
                          <AlertCircle className="h-3 w-3" />
                          Profile incomplete
                        </Badge>
                      )}
                      {p.whopProducts.length > 0 && (
                        <span className="tabular-nums">
                          {p.whopProducts.length} offering
                          {p.whopProducts.length === 1 ? '' : 's'}
                        </span>
                      )}
                      <KycStatusBadge status={p.whopKycStatus} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <p className="text-center text-xs text-muted-foreground">
          Until Whop Platforms access lands, every account stays at{' '}
          <code className="rounded bg-muted px-1 py-0.5">NOT_STARTED</code>. See{' '}
          <code className="rounded bg-muted px-1 py-0.5">
            docs/PHASE-2C-WHOP-DESIGN.md
          </code>{' '}
          for the lifecycle.
        </p>
      </div>
    </main>
  );
}

function SummaryStrip({
  totals,
}: {
  totals: {
    total: number;
    verified: number;
    pending: number;
    notStarted: number;
    rejected: number;
  };
}) {
  const cells: Array<{ label: string; value: number; tone: 'default' | 'success' | 'muted' | 'destructive' }> = [
    { label: 'Total', value: totals.total, tone: 'default' },
    { label: 'Verified', value: totals.verified, tone: 'success' },
    { label: 'Pending', value: totals.pending, tone: 'default' },
    { label: 'Not started', value: totals.notStarted, tone: 'muted' },
    { label: 'Rejected', value: totals.rejected, tone: 'destructive' },
  ];
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
      {cells.map((c) => (
        <Card key={c.label} className="px-3 py-2.5 text-center">
          <p className="text-2xl font-semibold tabular-nums">{c.value}</p>
          <p className="mt-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            {c.label}
          </p>
        </Card>
      ))}
    </div>
  );
}

function KycStatusBadge({ status }: { status: WhopKycStatus }) {
  switch (status) {
    case 'VERIFIED':
      return (
        <Badge variant="default" className="gap-1 text-[10px] uppercase tracking-wider">
          <Check className="h-3 w-3" />
          Verified
        </Badge>
      );
    case 'PENDING':
      return (
        <Badge variant="secondary" className="gap-1 text-[10px] uppercase tracking-wider">
          <Clock className="h-3 w-3" />
          Pending
        </Badge>
      );
    case 'REJECTED':
      return (
        <Badge variant="destructive" className="gap-1 text-[10px] uppercase tracking-wider">
          <X className="h-3 w-3" />
          Rejected
        </Badge>
      );
    case 'NOT_STARTED':
    default:
      return (
        <Badge variant="outline" className="gap-1 text-[10px] uppercase tracking-wider">
          <MinusCircle className="h-3 w-3" />
          Not started
        </Badge>
      );
  }
}
