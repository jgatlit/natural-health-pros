'use client';

import { useHits, useInstantSearch, useStats } from 'react-instantsearch';
import { Skeleton } from '@/components/ui/skeleton';
import { PractitionerHitCard, type PractitionerHit } from './PractitionerHit';

// Algolia's standard NoResultsBoundary pattern: InstantSearch sets
// `results.__isArtificial` to true on the first synchronous render BEFORE the
// initial request returns. Without checking it, the page shows
// "0 practitioners / No results match" for a beat before the actual data arrives.
function hasFirstResponse(results: { __isArtificial?: boolean } | undefined): boolean {
  return !!results && !results.__isArtificial;
}

export function ResultStats() {
  const { nbHits } = useStats();
  const { results } = useInstantSearch();
  if (!hasFirstResponse(results)) {
    return <Skeleton className="h-4 w-24" />;
  }
  return (
    <p className="text-xs font-medium text-muted-foreground" aria-live="polite">
      {nbHits === 1 ? '1 practitioner' : `${nbHits} practitioners`}
    </p>
  );
}

export function SearchResults() {
  const { items } = useHits<PractitionerHit>();
  const { results, status } = useInstantSearch();

  const initialLoad = !hasFirstResponse(results);
  const refreshing = status === 'loading' || status === 'stalled';

  if (initialLoad) {
    return <SearchResultsSkeleton />;
  }

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed bg-card p-8 text-center">
        <p className="text-sm font-medium">No practitioners match these filters.</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Try clearing a filter or broadening your search.
        </p>
      </div>
    );
  }

  return (
    <ul
      className="grid grid-cols-1 gap-3 md:grid-cols-2"
      // Subtle dim while a refinement request is in flight so the user sees
      // that filtering is responding even before counts settle.
      style={refreshing ? { opacity: 0.7, transition: 'opacity 120ms ease' } : undefined}
    >
      {items.map((hit) => (
        <li key={hit.id}>
          <PractitionerHitCard hit={hit} />
        </li>
      ))}
    </ul>
  );
}

function SearchResultsSkeleton() {
  return (
    <ul className="grid grid-cols-1 gap-3 md:grid-cols-2" aria-busy aria-label="Loading practitioners">
      {Array.from({ length: 6 }).map((_, i) => (
        <li key={i}>
          <Skeleton className="h-28 w-full rounded-lg" />
        </li>
      ))}
    </ul>
  );
}
