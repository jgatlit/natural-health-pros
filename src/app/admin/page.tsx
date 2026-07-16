import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Mail, Building2, Webhook, Tags, ChevronRight } from 'lucide-react';
import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { isWhopPlatformsReady } from '@/lib/whop';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';

export const dynamic = 'force-dynamic';

export default async function AdminIndex() {
  const session = await auth();
  if (!session?.user || session.user.role !== 'ADMIN') {
    redirect('/auth/signin?callbackUrl=/admin');
  }

  const [pendingInvites, connectedAccounts, recentWebhooks, pendingSpecialties] = await Promise.all([
    prisma.invitation.count({
      where: { acceptedAt: null, expiresAt: { gt: new Date() } },
    }),
    prisma.practitioner.count({ where: { whopCompanyId: { not: null } } }),
    prisma.whopWebhookEvent.count({
      where: { receivedAt: { gt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
    }),
    prisma.specialtyAlias.count({ where: { status: 'PENDING' } }),
  ]);

  const tools = [
    {
      icon: Mail,
      title: 'Invitations',
      href: '/admin/invites',
      count: pendingInvites,
      countLabel: 'pending',
      description: 'Send + manage practitioner invitations.',
      status: 'active' as const,
    },
    {
      icon: Tags,
      title: 'Specialty moderation',
      href: '/admin/specialties',
      count: pendingSpecialties,
      countLabel: 'pending',
      description: 'Approve aliases + promote/merge proposed specialties. Grows the taxonomy.',
      status: 'active' as const,
    },
    {
      icon: Building2,
      title: 'Connected accounts (Whop)',
      href: '/admin/connected-accounts',
      count: connectedAccounts,
      countLabel: 'connected',
      description: 'View practitioner Whop sub-merchant status + KYC progress.',
      status: isWhopPlatformsReady() ? ('active' as const) : ('pending-access' as const),
    },
    {
      icon: Webhook,
      title: 'Whop webhooks',
      href: '/admin/whop-webhooks',
      count: recentWebhooks,
      countLabel: 'last 7 days',
      description: 'Recent webhook events from Whop for debugging + audit.',
      status: isWhopPlatformsReady() ? ('active' as const) : ('pending-access' as const),
    },
  ];

  return (
    <main className="min-h-screen bg-muted/30 px-4 py-10 sm:py-14">
      <div className="mx-auto max-w-2xl space-y-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Admin tools</h1>
          <p className="text-sm text-muted-foreground">
            Natural Health Pros operator surface · {session.user.email}
          </p>
        </header>

        <ul className="space-y-2">
          {tools.map((t) => (
            <li key={t.href}>
              <Link
                href={t.href}
                className="group block"
              >
                <Card className="flex items-center gap-4 p-4 transition-colors group-hover:bg-accent/30">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-muted">
                    <t.icon className="h-4 w-4 text-muted-foreground" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-semibold">{t.title}</p>
                      {t.status === 'pending-access' && (
                        <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
                          Pending Whop access
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

        <Separator />

        <p className="text-center text-xs text-muted-foreground">
          See <code className="rounded bg-muted px-1.5 py-0.5">docs/PHASE-2-PLAN.md</code> for
          what&apos;s shipping next.
        </p>
      </div>
    </main>
  );
}
