import Link from 'next/link';
import { Search, ArrowRight, ShieldCheck, Sparkles } from 'lucide-react';
import { prisma } from '@/lib/prisma';
import { listedWhere } from '@/lib/practitioner-indexer';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';

function initials(name: string) {
  return name
    .replace(/^Dr\.\s+/i, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

async function getFeaturedPractitioners() {
  return prisma.practitioner.findMany({
    take: 4,
    where: listedWhere(),
    orderBy: { acceptedAt: 'desc' },
    include: {
      city: true,
      specialties: { include: { specialty: true } },
    },
  });
}

async function getCompletePractitionerCount() {
  return prisma.practitioner.count({ where: listedWhere() });
}

export default async function Home() {
  const featured = await getFeaturedPractitioners();
  const totalCount = await getCompletePractitionerCount();

  return (
    <main className="min-h-screen bg-muted/30">
      <section className="px-4 pb-12 pt-16 sm:pt-24">
        <div className="mx-auto max-w-3xl text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
            <Sparkles className="h-3 w-3" aria-hidden />
            HHE-curated practitioners
          </span>
          <h1 className="mt-5 text-balance font-serif text-4xl font-semibold tracking-tight sm:text-5xl">
            Find a practitioner you can trust.
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-balance text-base text-muted-foreground">
            Functional medicine, holistic nutrition, gut health, hormone balance, and more — from
            practitioners trained through Holistic Health Educators.
          </p>
          <div className="mt-7 flex flex-col items-center justify-center gap-3 sm:flex-row">
            {/*
              Native <a> instead of next/link <Link>: client-side nav into
              /search can fail to trigger InstantSearchNext's initial search
              request. Full page load guarantees SSR boot. See
              src/components/search/SearchExperience.tsx EnsureInitialSearch
              for the in-component defense.
            */}
            <a
              href="/search"
              className="inline-flex h-11 items-center gap-2 rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
            >
              <Search className="h-4 w-4" />
              Browse the directory
            </a>
            <p className="text-xs text-muted-foreground">
              {totalCount} HHE-trained practitioners
            </p>
          </div>
        </div>
      </section>

      <section className="px-4 pb-16">
        <div className="mx-auto max-w-5xl">
          <div className="mb-4 flex items-baseline justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Recently joined
            </h2>
            <a
              href="/search"
              className="inline-flex items-center gap-1 text-xs font-medium text-foreground/80 underline-offset-2 hover:underline"
            >
              See all
              <ArrowRight className="h-3 w-3" aria-hidden />
            </a>
          </div>
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {featured.map((p) => {
              const primary = p.specialties[0]?.specialty.name;
              return (
                <li key={p.id}>
                  <Link href={`/practitioners/${p.slug}`} className="group block h-full">
                    <Card className="flex h-full flex-col gap-3 p-4 transition-colors group-hover:bg-accent/30">
                      <Avatar size="lg" className="size-14 ring-1 ring-border">
                        <AvatarFallback className="text-base font-medium">
                          {initials(p.displayName)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="space-y-1">
                        <p className="text-sm font-semibold leading-tight">{p.displayName}</p>
                        {p.city && (
                          <p className="text-xs text-muted-foreground">
                            {p.city.name}, {p.city.state}
                          </p>
                        )}
                      </div>
                      {primary && (
                        <div className="mt-auto">
                          <Badge variant="secondary" className="text-[10px]">
                            {primary}
                          </Badge>
                        </div>
                      )}
                    </Card>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      </section>

      <section className="px-4 pb-20">
        <div className="mx-auto max-w-3xl">
          <Card className="space-y-4 p-6 sm:p-8">
            <div className="flex items-start gap-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
                <ShieldCheck className="h-4 w-4 text-muted-foreground" aria-hidden />
              </span>
              <div>
                <h3 className="text-sm font-semibold">Invite-only directory</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Practitioners listed here are graduates of programs run by Holistic Health
                  Educators. We curate. You decide.
                </p>
              </div>
            </div>
            <Separator />
            <p className="text-xs text-muted-foreground">
              Looking for Holistic Health Educators certification &amp; training programs? Visit{' '}
              <a
                href="https://www.holistichealtheducators.com/"
                className="underline-offset-2 hover:underline"
              >
                holistichealtheducators.com
              </a>
              .
            </p>
          </Card>
        </div>
      </section>
    </main>
  );
}
