import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { CheckCircle2 } from 'lucide-react';
import { prisma } from '@/lib/prisma';
import { Card } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { PractitionerHero } from '@/components/practitioners/PractitionerHero';
import { PractitionerCTAs } from '@/components/practitioners/PractitionerCTAs';

type PageProps = { params: { slug: string }; searchParams: { onboarded?: string } };

async function loadPractitioner(slug: string) {
  return prisma.practitioner.findUnique({
    where: { slug },
    include: {
      city: true,
      specialties: { include: { specialty: true } },
      bookingLinks: { orderBy: { sortOrder: 'asc' } },
      caseStudies: { orderBy: { createdAt: 'desc' } },
      whopProducts: {
        where: { active: true, archived: false },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
}

const formatPrice = (cents: number) => {
  const d = cents / 100;
  return `$${d % 1 === 0 ? d.toString() : d.toFixed(2)}`;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const p = await loadPractitioner(params.slug);
  if (!p) return { title: 'Practitioner not found' };
  const descr = p.whoIHelp || p.headline || p.bio || undefined;
  return {
    title: `${p.displayName}${p.headline ? ` — ${p.headline}` : ''} · Natural Health Pros`,
    description: descr?.slice(0, 200),
  };
}

export default async function PractitionerPage({ params, searchParams }: PageProps) {
  const p = await loadPractitioner(params.slug);
  if (!p) notFound();

  // Dual-label: canonical names = curated rail chips; rawLabels = the practitioner's own
  // phrasing, listed under "How I work". Parent rollups excluded from the chip set to keep it tight.
  const canonicalChips = Array.from(new Set(p.specialties.map((ps) => ps.specialty.name)));
  const rawModalities = Array.from(
    new Set(p.specialties.map((ps) => ps.rawLabel?.trim()).filter((l): l is string => !!l)),
  );

  return (
    <main className="min-h-screen bg-muted/30 px-4 py-10 sm:py-16">
      <div className="mx-auto max-w-4xl space-y-4">
        {searchParams.onboarded && (
          <Card className="flex flex-col items-start gap-3 border-primary/30 bg-primary/5 p-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="flex items-center gap-2 text-sm">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" aria-hidden />
              <span>
                <strong>Your page is live.</strong> Edit anything — bio, offerings, booking links —
                anytime in your dashboard.
              </span>
            </p>
            <Link
              href={`/practitioners/${params.slug}/edit`}
              className="inline-flex h-9 shrink-0 items-center justify-center rounded-md bg-primary px-4 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Go to dashboard
            </Link>
          </Card>
        )}
        <Card className="p-6 sm:p-12">
          <div className="grid gap-12 sm:grid-cols-[22rem_1fr]">
            {/* Sticky identity + booking rail (Variation B) */}
            <aside className="min-w-0 space-y-6 sm:sticky sm:top-8 sm:self-start">
              <PractitionerHero
                displayName={p.displayName}
                headline={p.headline}
                photoUrl={p.photoUrl}
                city={p.city ? { name: p.city.name, state: p.city.state } : null}
                telehealth={p.telehealth}
                inPerson={p.inPerson}
                yearsInPractice={p.yearsInPractice}
                chips={canonicalChips}
                hheCertified={p.hheCertified}
              />
              <PractitionerCTAs
                bookingLinks={p.bookingLinks.map((b) => ({ label: b.label, url: b.url }))}
                websiteUrl={p.websiteUrl}
                firstSessionPriceCents={p.firstSessionPriceCents}
              />
            </aside>

            {/* Scrollable narrative */}
            <div className="min-w-0 space-y-6">
              {/* Hook sits at the top of the narrative column, directly above whoIHelp. The
                  credential line (headline) stays with the identity rail on the left, so the two
                  read as distinct registers rather than two titles stacked together. */}
              {p.tagline && (
                <p className="font-serif text-2xl leading-snug tracking-tight text-primary">
                  {p.tagline}
                </p>
              )}

              {p.whoIHelp && (
                <p className="text-lg leading-relaxed text-foreground">{p.whoIHelp}</p>
              )}

              {p.bio && (
                <section
                  aria-label="About"
                  className="space-y-2 rounded-xl bg-secondary/40 p-6"
                >
                  <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    About {p.displayName.split(/\s+/)[0]}
                  </h2>
                  <div className="space-y-3 text-sm leading-relaxed text-foreground">
                    {p.bio.split(/\n{2,}/).map((para, i) => (
                      <p key={i}>{para.trim()}</p>
                    ))}
                  </div>
                </section>
              )}

              {rawModalities.length > 0 && (
                <section
                  aria-label="How I work"
                  className="space-y-2 rounded-xl bg-secondary/40 p-6"
                >
                  <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    How I work
                  </h2>
                  <ul className="divide-y rounded-lg border bg-card">
                    {rawModalities.map((m) => (
                      <li key={m} className="px-3 py-2.5 text-sm">
                        {m}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {p.whopProducts.length > 0 && (
                <section
                  aria-label="Offerings"
                  className="space-y-3 rounded-xl bg-secondary/40 p-6"
                >
                  <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Offerings
                  </h2>
                  <ul className="space-y-2.5">
                    {p.whopProducts.map((o) => (
                      <li
                        key={o.id}
                        className="flex items-start justify-between gap-4 rounded-lg border bg-card p-4"
                      >
                        <div className="min-w-0 space-y-1">
                          <p className="text-sm font-medium">{o.title}</p>
                          {o.description && (
                            <p className="text-xs leading-relaxed text-muted-foreground">
                              {o.description}
                            </p>
                          )}
                          {o.category && (
                            <span className="inline-block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                              {o.category}
                            </span>
                          )}
                        </div>
                        {o.priceUsdCents > 0 && (
                          <p className="shrink-0 text-sm font-semibold">
                            {formatPrice(o.priceUsdCents)}
                            {o.interval === 'MONTHLY' && (
                              <span className="text-xs font-normal text-muted-foreground">/mo</span>
                            )}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {p.caseStudies.length > 0 && (
                <section
                  aria-label="Outcomes"
                  className="space-y-3 rounded-xl bg-secondary/40 p-6"
                >
                  <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Outcomes
                  </h2>
                  <ul className="space-y-3">
                    {p.caseStudies.map((cs) => (
                      <li key={cs.id} className="rounded-lg border bg-card p-4">
                        <p className="text-sm font-medium">{cs.title}</p>
                        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                          {cs.summary}
                        </p>
                        {cs.outcome && (
                          <p className="mt-1 text-sm leading-relaxed text-foreground">{cs.outcome}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          </div>

          <Separator className="my-8" />
          <p className="text-center text-xs text-muted-foreground">
            HHE-curated practitioner · invite-only directory
          </p>
        </Card>
      </div>
    </main>
  );
}
