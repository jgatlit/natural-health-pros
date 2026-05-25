import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { prisma } from '@/lib/prisma';
import { Card } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { PractitionerHeader } from '@/components/practitioners/PractitionerHeader';
import { PractitionerLinks } from '@/components/practitioners/PractitionerLinks';
import { PractitionerBio } from '@/components/practitioners/PractitionerBio';

type PageProps = { params: { slug: string } };

async function loadPractitioner(slug: string) {
  return prisma.practitioner.findUnique({
    where: { slug },
    include: {
      city: true,
      specialties: { include: { specialty: true } },
    },
  });
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const p = await loadPractitioner(params.slug);
  if (!p) return { title: 'Practitioner not found' };
  const cityLine = p.city ? `${p.city.name}, ${p.city.state}` : null;
  return {
    title: `${p.displayName}${cityLine ? ` — ${cityLine}` : ''} · HHE Directory`,
    description: p.bio ?? undefined,
  };
}

export default async function PractitionerPage({ params }: PageProps) {
  const p = await loadPractitioner(params.slug);
  if (!p) notFound();

  const specialties = p.specialties.map((ps) => ({
    id: ps.specialty.id,
    name: ps.specialty.name,
  }));

  return (
    <main className="min-h-screen bg-muted/30 px-4 py-10 sm:py-16">
      <div className="mx-auto max-w-md">
        <Card className="space-y-6 p-6 sm:p-8">
          <PractitionerHeader
            displayName={p.displayName}
            city={p.city ? { name: p.city.name, state: p.city.state } : null}
            specialties={specialties}
          />

          <Separator />

          <PractitionerLinks bookingUrl={p.bookingUrl} />

          {p.bio && (
            <>
              <Separator />
              <PractitionerBio bio={p.bio} />
            </>
          )}
        </Card>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          HHE-curated practitioner · invite-only directory
        </p>
      </div>
    </main>
  );
}
