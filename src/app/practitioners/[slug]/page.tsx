import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { prisma } from '@/lib/prisma';
import { Card } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
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
    },
  });
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const p = await loadPractitioner(params.slug);
  if (!p) return { title: 'Practitioner not found' };
  const descr = p.whoIHelp || p.headline || p.bio || undefined;
  return {
    title: `${p.displayName}${p.headline ? ` — ${p.headline}` : ''} · HHE Directory`,
    description: descr?.slice(0, 200),
  };
}

export default async function PractitionerPage({ params }: PageProps) {
  const p = await loadPractitioner(params.slug);
  if (!p) notFound();

  // Dual-label: show the practitioner's own phrasing (rawLabel) as their voice; fall
  // back to the canonical name when a raw label wasn't captured.
  const specialtyLabels = Array.from(
    new Set(p.specialties.map((ps) => (ps.rawLabel?.trim() || ps.specialty.name).trim())),
  );

  return (
    <main className="min-h-screen bg-muted/30 px-4 py-10 sm:py-16">
      <div className="mx-auto max-w-3xl space-y-6">
        <Card className="space-y-8 p-6 sm:p-10">
          <PractitionerHero
            displayName={p.displayName}
            headline={p.headline}
            photoUrl={p.photoUrl}
            city={p.city ? { name: p.city.name, state: p.city.state } : null}
            telehealth={p.telehealth}
            inPerson={p.inPerson}
            specialtyLabels={specialtyLabels}
          />

          <div className="grid gap-8 sm:grid-cols-[1fr_18rem]">
            <div className="space-y-8">
              {p.whoIHelp && (
                <section aria-label="Who I help" className="space-y-2">
                  <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Who I help
                  </h2>
                  <p className="text-base leading-relaxed text-foreground">{p.whoIHelp}</p>
                </section>
              )}

              {p.bio && (
                <section aria-label="About" className="space-y-2">
                  <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    About
                  </h2>
                  <div className="space-y-3 text-sm leading-relaxed text-foreground">
                    {p.bio.split(/\n{2,}/).map((para, i) => (
                      <p key={i}>{para.trim()}</p>
                    ))}
                  </div>
                </section>
              )}

              {specialtyLabels.length > 0 && (
                <section aria-label="Specialties & modalities" className="space-y-2">
                  <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Specialties &amp; modalities
                  </h2>
                  <div className="flex flex-wrap gap-1.5">
                    {specialtyLabels.map((label) => (
                      <Badge key={label} variant="secondary">
                        {label}
                      </Badge>
                    ))}
                  </div>
                </section>
              )}
            </div>

            <aside className="space-y-3 sm:sticky sm:top-8 sm:self-start">
              <PractitionerCTAs
                bookingLinks={p.bookingLinks.map((b) => ({ label: b.label, url: b.url }))}
                websiteUrl={p.websiteUrl}
              />
            </aside>
          </div>

          <Separator />
          <p className="text-center text-xs text-muted-foreground">
            HHE-curated practitioner · invite-only directory
          </p>
        </Card>
      </div>
    </main>
  );
}
