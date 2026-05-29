import type { Metadata } from 'next';
import { SearchExperience } from '@/components/search/SearchExperience';

export const metadata: Metadata = {
  title: 'Search · HHE Directory',
  description: 'HHE-students-first practitioner directory.',
};

export default function SearchPage() {
  return (
    <main className="min-h-screen bg-muted/30 px-4 py-8 sm:py-12">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="space-y-1">
          <h1 className="font-serif text-2xl font-semibold tracking-tight">Find a practitioner</h1>
          <p className="text-sm text-muted-foreground">
            HHE-curated. Filter by specialty + city.
          </p>
        </header>
        <SearchExperience />
      </div>
    </main>
  );
}
