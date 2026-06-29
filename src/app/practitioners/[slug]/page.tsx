import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { prisma } from '@/lib/prisma';
import { Card } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { PractitionerHero } from '@/components/practitioners/PractitionerHero';
import { PractitionerCTAs } from '@/components/practitioners/PractitionerCTAs';

type PageProps = { params: { slug: string } };

async function loadPractitioner(slug: string) {
  return prisma.practitioner.findUnique({
    where: { slug },
    include: {
      city: true,
      specialties: { include: { specialty: true } },
      bookingLinks: { orderBy: { sortOrder: 'asc' } },
      caseStudies: { orderBy: { createdAt: 'desc' } },
    },
  });
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const p = await loadPractitioner(params.slug);
  if (!p) return { title: 'Practitioner not found' };
  const descr = p.whoIHelp || p.headline || p.bio || undefined;
  return {
    title: `${p.displayName}${p.headline ? ` — ${p.headline}` : ''} · Natural Health Pros`,
    description: descr?.slice(0, 200),
  };
}

export default async function PractitionerPage({ params }: PageProps) {
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
      <div className="mx-auto max-w-4xl">
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
                hheCertified
              />
              <PractitionerCTAs
                bookingLinks={p.bookingLinks.map((b) => ({ label: b.label, url: b.url }))}
                websiteUrl={p.websiteUrl}
                firstSessionPriceCents={p.firstSessionPriceCents}
              />
            </aside>

            {/* Scrollable narrative */}
            <div className="min-w-0 space-y-6">
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
