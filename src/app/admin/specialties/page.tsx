import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft, Check, X, Sparkles, GitMerge, ArrowUpCircle } from 'lucide-react';
import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  approveAlias,
  rejectAlias,
  promoteSpecialtyAction,
  mergeSpecialtyAction,
} from './actions';

export const dynamic = 'force-dynamic';

export default async function AdminSpecialtiesPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== 'ADMIN') {
    redirect('/auth/signin?callbackUrl=/admin/specialties');
  }

  const [pendingAliases, proposed, activeCanonicals, parents] = await Promise.all([
    prisma.specialtyAlias.findMany({
      where: { status: 'PENDING' },
      include: { specialty: true },
      orderBy: [{ confidence: 'asc' }, { createdAt: 'asc' }],
    }),
    prisma.specialty.findMany({
      where: { status: 'PROPOSED' },
      include: { _count: { select: { practitioners: true } } },
      orderBy: { name: 'asc' },
    }),
    prisma.specialty.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { name: 'asc' },
    }),
    // Top-level canonicals usable as a parent when promoting
    prisma.specialty.findMany({
      where: { status: 'ACTIVE', parentId: null },
      orderBy: { name: 'asc' },
    }),
  ]);

  return (
    <main className="min-h-screen bg-muted/30 px-4 py-10 sm:py-14">
      <div className="mx-auto max-w-3xl space-y-6">
        <Link
          href="/admin"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to admin
        </Link>

        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Specialty moderation</h1>
          <p className="text-sm text-muted-foreground">
            Grow the canonical taxonomy cleanly. Approve aliases to collapse synonyms; promote or
            merge proposed specialties. {activeCanonicals.length} active canonicals.
          </p>
        </header>

        {/* PENDING ALIASES */}
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">Pending aliases</h2>
            <Badge variant="secondary">{pendingAliases.length}</Badge>
          </div>
          {pendingAliases.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nothing pending. 🎉</p>
          ) : (
            <ul className="space-y-2">
              {pendingAliases.map((a) => (
                <li key={a.id}>
                  <Card className="flex items-center gap-3 p-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        “{a.label}”{' '}
                        <span className="text-muted-foreground">→ {a.specialty.name}</span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {a.source.toLowerCase()}
                        {a.confidence != null && ` · confidence ${a.confidence.toFixed(2)}`}
                      </p>
                    </div>
                    <form action={approveAlias.bind(null, a.id)}>
                      <button
                        type="submit"
                        className="inline-flex h-8 items-center gap-1 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                      >
                        <Check className="h-3.5 w-3.5" /> Approve
                      </button>
                    </form>
                    <form action={rejectAlias.bind(null, a.id)}>
                      <button
                        type="submit"
                        className="inline-flex h-8 items-center gap-1 rounded-md border bg-card px-3 text-xs font-medium hover:bg-accent"
                      >
                        <X className="h-3.5 w-3.5" /> Reject
                      </button>
                    </form>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </section>

        <Separator />

        {/* PROPOSED CANONICALS */}
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-muted-foreground" aria-hidden />
            <h2 className="text-sm font-semibold">Proposed specialties</h2>
            <Badge variant="secondary">{proposed.length}</Badge>
          </div>
          {proposed.length === 0 ? (
            <p className="text-xs text-muted-foreground">No proposed specialties awaiting review.</p>
          ) : (
            <ul className="space-y-2">
              {proposed.map((s) => (
                <li key={s.id}>
                  <Card className="space-y-3 p-3">
                    <div className="flex items-center gap-2">
                      <p className="flex-1 truncate text-sm font-medium">{s.name}</p>
                      <span className="text-xs text-muted-foreground">
                        {s._count.practitioners} practitioner
                        {s._count.practitioners === 1 ? '' : 's'}
                      </span>
                    </div>

                    <div className="grid gap-2 sm:grid-cols-2">
                      {/* Promote → ACTIVE under an optional parent */}
                      <form action={promoteSpecialtyAction} className="flex items-center gap-1.5">
                        <input type="hidden" name="specialtyId" value={s.id} />
                        <select
                          name="parentId"
                          defaultValue=""
                          className="h-8 min-w-0 flex-1 rounded-md border bg-card px-2 text-xs outline-none"
                        >
                          <option value="">— no parent (top level) —</option>
                          {parents.map((p) => (
                            <option key={p.id} value={p.id}>
                              under {p.name}
                            </option>
                          ))}
                        </select>
                        <button
                          type="submit"
                          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                        >
                          <ArrowUpCircle className="h-3.5 w-3.5" /> Promote
                        </button>
                      </form>

                      {/* Merge → existing canonical */}
                      <form action={mergeSpecialtyAction} className="flex items-center gap-1.5">
                        <input type="hidden" name="sourceId" value={s.id} />
                        <select
                          name="targetId"
                          defaultValue=""
                          required
                          className="h-8 min-w-0 flex-1 rounded-md border bg-card px-2 text-xs outline-none"
                        >
                          <option value="" disabled>
                            merge into…
                          </option>
                          {activeCanonicals.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                        <button
                          type="submit"
                          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border bg-card px-2.5 text-xs font-medium hover:bg-accent"
                        >
                          <GitMerge className="h-3.5 w-3.5" /> Merge
                        </button>
                      </form>
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </section>

        <p className="text-center text-xs text-muted-foreground">
          Signed in as {session.user.email}
        </p>
      </div>
    </main>
  );
}
