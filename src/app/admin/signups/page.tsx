import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AlertTriangle, ArrowLeft } from 'lucide-react';
import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { isProfileComplete } from '@/lib/practitioner-indexer';
import { SIGNUP_PROGRESS_LABEL, signupProgress } from '@/lib/signup-progress';
import { setCohortEnabled } from './actions';
import { DirectoryControls } from '@/app/admin/invites/DirectoryControls';
import { HheBadgeControl } from '@/app/admin/invites/HheBadgeControl';

export const dynamic = 'force-dynamic';

export default async function AdminSignupsPage({
  searchParams,
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const session = await auth();
  if (!session?.user || session.user.role !== 'ADMIN') {
    redirect('/auth/signin?callbackUrl=/admin/signups');
  }
  const errorCode = typeof searchParams?.error === 'string' ? searchParams.error : null;
  const notice = typeof searchParams?.notice === 'string' ? searchParams.notice : null;

  const [cohorts, rows] = await Promise.all([
    prisma.signupCohort.findMany({ orderBy: { createdAt: 'asc' } }),
    prisma.invitation.findMany({
      where: { cohortId: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        cohort: { select: { slug: true, label: true } },
        acceptedByUser: {
          select: {
            practitioner: {
              select: {
                slug: true,
                displayName: true,
                delistedAt: true,
                archivedAt: true,
                hheCertified: true,
                hheCertifiedChangedAt: true,
                cityId: true,
                bio: true,
                specialties: { select: { specialtyId: true } },
              },
            },
          },
        },
      },
    }),
  ]);

  return (
    <main className="min-h-screen bg-muted/30 px-4 py-10 sm:py-14">
      <div className="mx-auto max-w-5xl space-y-4">
        <Link
          href="/admin"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Admin
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">Cohort sign-ups</h1>

        {/* Same outcomes as /admin/invites: the directory flag lives in the database AND in
            Typesense, and only the second half can fail. */}
        {errorCode === 'index-out-of-sync' && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
            <p>
              <span className="font-medium">Saved, but search was not updated.</span> This
              practitioner may still appear in search. Retry the button; if it keeps failing, run{' '}
              <code className="rounded bg-muted px-1">npm run typesense:reindex</code>.
            </p>
          </div>
        )}
        {errorCode === 'badge-index-out-of-sync' && (
          <div className="flex items-start gap-2 rounded-md border px-4 py-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <p>
              Badge saved and shown on the profile. The search index was not refreshed; run{' '}
              <code className="rounded bg-muted px-1">npm run typesense:reindex</code> if it keeps
              failing.
            </p>
          </div>
        )}
        {notice === 'index-unverified' && (
          <div className="flex items-start gap-2 rounded-md border px-4 py-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <p>Saved. Search was not checked: Typesense is not configured in this environment.</p>
          </div>
        )}
        {(errorCode === 'no-profile' || errorCode === 'not-found') && (
          <div className="flex items-start gap-2 rounded-md border px-4 py-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <p>That sign-up has no practitioner profile yet, so there is nothing to hide.</p>
          </div>
        )}

        <Card className="space-y-3 p-4 sm:p-6">
          <h2 className="text-sm font-semibold">Cohorts</h2>
          {cohorts.map((c) => (
            <div key={c.id} className="flex items-center justify-between gap-3 text-sm">
              <div>
                <span className="font-medium">{c.label}</span>{' '}
                <code className="text-xs text-muted-foreground">/join/{c.slug}</code>{' '}
                <Badge variant={c.enabled ? 'default' : 'outline'}>{c.enabled ? 'Open' : 'Closed'}</Badge>
              </div>
              <form action={setCohortEnabled}>
                <input type="hidden" name="id" value={c.id} />
                <input type="hidden" name="enabled" value={c.enabled ? 'false' : 'true'} />
                <button
                  type="submit"
                  className="h-8 rounded-md border px-3 text-xs font-medium hover:bg-muted"
                >
                  {c.enabled ? 'Close sign-up' : 'Reopen sign-up'}
                </button>
              </form>
            </div>
          ))}
        </Card>

        <Card className="space-y-3 p-4 sm:p-6">
          <h2 className="text-sm font-semibold">Sign-ups ({rows.length})</h2>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">No one has signed up through a cohort link yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-3 font-medium">Cohort</th>
                    <th className="py-1 pr-3 font-medium">Signed up</th>
                    <th className="py-1 pr-3 font-medium">Name</th>
                    <th className="py-1 pr-3 font-medium">Email</th>
                    <th className="py-1 pr-3 font-medium">Progress</th>
                    <th className="py-1 pr-3 font-medium">Directory · badge</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const p = r.acceptedByUser?.practitioner ?? null;
                    const progress = signupProgress({
                      acceptedAt: r.acceptedAt,
                      hasPractitioner: Boolean(p),
                      profileComplete: p
                        ? isProfileComplete({
                            displayName: p.displayName,
                            cityId: p.cityId,
                            bio: p.bio,
                            specialties: p.specialties,
                          })
                        : false,
                    });
                    return (
                      <tr key={r.id} className="border-t">
                        <td className="py-1.5 pr-3">{r.cohort?.slug}</td>
                        <td className="py-1.5 pr-3">{r.createdAt.toISOString().slice(0, 10)}</td>
                        <td className="py-1.5 pr-3">
                          {p ? (
                            <>
                              {p.displayName || <span className="text-muted-foreground">No name yet</span>}{' '}
                              <span className="text-muted-foreground">/{p.slug}</span>
                            </>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="break-all py-1.5 pr-3">{r.email}</td>
                        <td className="py-1.5 pr-3">
                          {SIGNUP_PROGRESS_LABEL[progress]}
                          {p && (
                            <>
                              {' '}
                              <Link className="underline" href={`/practitioners/${p.slug}`}>
                                profile
                              </Link>
                            </>
                          )}
                        </td>
                        <td className="py-1.5 pr-3">
                          {p && (
                            <div className="flex flex-wrap items-center gap-1">
                              <DirectoryControls
                                invitationId={r.id}
                                displayName={p.displayName}
                                delisted={Boolean(p.delistedAt)}
                                archived={Boolean(p.archivedAt)}
                                returnTo="/admin/signups"
                              />
                              <HheBadgeControl
                                invitationId={r.id}
                                displayName={p.displayName}
                                certified={p.hheCertified}
                                changedAt={p.hheCertifiedChangedAt}
                                returnTo="/admin/signups"
                              />
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </main>
  );
}
