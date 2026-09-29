import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Mail, Building2, Webhook, Tags, ChevronRight, Scale, Users } from 'lucide-react';
import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { isWhopPlatformsReady } from '@/lib/whop';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

export const dynamic = 'force-dynamic';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export default async function AdminIndex() {
  const session = await auth();
  if (!session?.user || session.user.role !== 'ADMIN') {
    redirect('/auth/signin?callbackUrl=/admin');
  }

  const weekAgo = new Date(Date.now() - WEEK_MS);
  const [
    pendingInvites,
    connectedAccounts,
    recentWebhooks,
    failedWebhooks,
    pendingSpecialties,
    held,
    attributions,
  ] = await Promise.all([
    prisma.invitation.count({
      where: { acceptedAt: null, expiresAt: { gt: new Date() } },
    }),
    prisma.practitioner.count({ where: { whopCompanyId: { not: null } } }),
    prisma.whopWebhookEvent.count({ where: { receivedAt: { gt: weekAgo } } }),
    prisma.whopWebhookEvent.count({ where: { receivedAt: { gt: weekAgo }, error: { not: null } } }),
    prisma.specialtyAlias.count({ where: { status: 'PENDING' } }),
    prisma.referralLedgerEntry.aggregate({
      where: { state: 'HELD' },
      _sum: { referrerShareUsdCents: true },
      _count: true,
    }),
    prisma.attributedClient.count(),
  ]);

  const heldShares = held._count;
  const heldDollars = `$${((held._sum.referrerShareUsdCents ?? 0) / 100).toFixed(2)}`;
  const whopReady = isWhopPlatformsReady();

  // The four things that can be waiting on the operator. Shown first, and each links to where it
  // is dealt with, so an empty strip means there is nothing to do and a full one says where to go.
  const attention = [
    { href: '/admin/commercial-settings', value: heldShares, label: 'Referral shares held', sub: heldDollars },
    { href: '/admin/invites', value: pendingInvites, label: 'Invitations waiting to be accepted', sub: null },
    { href: '/admin/specialties', value: pendingSpecialties, label: 'Specialties to review', sub: null },
    { href: '/admin/whop-webhooks', value: failedWebhooks, label: 'Failed Whop events, last 7 days', sub: null },
  ];

  const groups = [
    {
      heading: 'People',
      tools: [
        {
          icon: Mail,
          title: 'Invitations',
          href: '/admin/invites',
          count: pendingInvites,
          countLabel: 'pending',
          description: 'Invite practitioners and track who has accepted.',
          configured: true,
        },
        {
          icon: Tags,
          title: 'Specialties',
          href: '/admin/specialties',
          count: pendingSpecialties,
          countLabel: 'to review',
          description: 'Approve, merge or promote proposed specialties.',
          configured: true,
        },
      ],
    },
    {
      heading: 'Money',
      tools: [
        {
          icon: Scale,
          title: 'Commercial settings',
          href: '/admin/commercial-settings',
          count: heldShares,
          countLabel: 'shares held',
          description: 'Plan terms in force, the attribution term and the referral hold.',
          configured: true,
        },
        {
          icon: Users,
          title: 'Attributions',
          href: '/admin/attributions',
          count: attributions,
          countLabel: 'clients',
          description: 'Who owns each client and who referred them. Overrides need a note.',
          configured: true,
        },
        {
          icon: Building2,
          title: 'Connected accounts',
          href: '/admin/connected-accounts',
          count: connectedAccounts,
          countLabel: 'connected',
          description: "Each practitioner's Whop account and verification status.",
          configured: whopReady,
        },
        {
          icon: Webhook,
          title: 'Whop webhooks',
          href: '/admin/whop-webhooks',
          count: recentWebhooks,
          countLabel: 'this week',
          description: 'Recent events from Whop, for debugging and audit.',
          configured: whopReady,
        },
      ],
    },
  ];

  return (
    <main className="min-h-screen bg-muted/30 px-4 py-10 sm:py-14">
      <div className="mx-auto max-w-2xl space-y-8">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>
          <p className="text-sm text-muted-foreground">
            Natural Health Pros operator surface · {session.user.email}
          </p>
        </header>

        <section aria-labelledby="attention" className="space-y-2">
          <h2
            id="attention"
            className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
          >
            Needs attention
          </h2>
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {attention.map((a) => (
              <li key={a.href}>
                <Link href={a.href} className="group block h-full">
                  <Card
                    className={`flex h-full flex-col gap-1 p-4 transition-colors group-hover:bg-accent/30 ${
                      a.value > 0 ? '' : 'opacity-70'
                    }`}
                  >
                    <span className="text-2xl font-semibold tabular-nums">{a.value}</span>
                    <span className="text-xs leading-snug text-muted-foreground">{a.label}</span>
                    {a.sub && a.value > 0 && (
                      <span className="text-xs font-medium tabular-nums">{a.sub}</span>
                    )}
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
        </section>

        {groups.map((g) => (
          <section key={g.heading} aria-label={g.heading} className="space-y-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {g.heading}
            </h2>
            <ul className="space-y-2">
              {g.tools.map((t) => (
                <li key={t.href}>
                  <Link href={t.href} className="group block">
                    <Card className="flex items-center gap-4 p-4 transition-colors group-hover:bg-accent/30">
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted">
                        <t.icon className="h-4 w-4 text-muted-foreground" aria-hidden />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-sm font-semibold">{t.title}</p>
                          {/* A fact about this deployment's env, not a request waiting on Whop:
                              Connected Accounts is self-serve (2026-07-29 correction). */}
                          {!t.configured && (
                            <Badge
                              variant="outline"
                              className="text-[10px] uppercase tracking-wider"
                            >
                              Whop not configured
                            </Badge>
                          )}
                        </div>
                        <p className="truncate text-xs text-muted-foreground">{t.description}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs tabular-nums text-muted-foreground">
                          <strong className="text-foreground">{t.count}</strong> {t.countLabel}
                        </span>
                        <ChevronRight
                          className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                          aria-hidden
                        />
                      </div>
                    </Card>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </main>
  );
}
