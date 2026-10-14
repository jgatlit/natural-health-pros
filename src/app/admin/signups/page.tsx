import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { isProfileComplete } from '@/lib/practitioner-indexer';
import { SIGNUP_PROGRESS_LABEL, signupProgress } from '@/lib/signup-progress';
import { setCohortEnabled } from './actions';

export const dynamic = 'force-dynamic';

export default async function AdminSignupsPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== 'ADMIN') {
    redirect('/auth/signin?callbackUrl=/admin/signups');
  }

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
      <div className="mx-auto max-w-4xl space-y-4">
        <Link
          href="/admin"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Admin
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">Cohort sign-ups</h1>

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
                    <th className="py-1 pr-3 font-medium">Email</th>
                    <th className="py-1 pr-3 font-medium">Progress</th>
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
                        <td className="py-1.5 pr-3">{r.email}</td>
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
