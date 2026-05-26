'use client';

import { useEffect, useRef, useState } from 'react';
import { useHits, useInstantSearch, useStats } from 'react-instantsearch';
import { Skeleton } from '@/components/ui/skeleton';
import { PractitionerHitCard, type PractitionerHit } from './PractitionerHit';

/**
 * Track whether at least one real search response has landed.
 *
 * Previous attempt used results.__isArtificial — that flag never cleared in
 * react-instantsearch@7 + react-instantsearch-nextjs, leaving the skeleton on
 * forever. This implementation watches useInstantSearch().status: the moment
 * it transitions to 'loading' OR back to 'idle' with nbHits > 0, we know a
 * search ran. A 250 ms timeout fallback ensures we never gate the empty
 * state forever even if the search engine is silent for some reason.
 */
function useFirstResponseSeen(): boolean {
  const [seen, setSeen] = useState(false);
  const seenRef = useRef(false);
  const { status, results } = useInstantSearch();
  const { nbHits } = useStats();

  useEffect(() => {
    if (seenRef.current) return;
    // Any of these signals means InstantSearch is actively fetching or has data.
    const responded =
      status === 'loading' ||
      status === 'stalled' ||
      nbHits > 0 ||
      (results && (results as { processingTimeMS?: number }).processingTimeMS !== undefined);
    if (responded) {
      seenRef.current = true;
      setSeen(true);
    }
  }, [status, nbHits, results]);

  // Safety net: regardless of what InstantSearch reports, lift the gate after
  // 250 ms so we never trap users in the loading state.
  useEffect(() => {
    const t = setTimeout(() => {
      if (!seenRef.current) {
        seenRef.current = true;
        setSeen(true);
      }
    }, 250);
    return () => clearTimeout(t);
  }, []);

  return seen;
}

export function ResultStats() {
  const { nbHits } = useStats();
  const seen = useFirstResponseSeen();
  if (!seen) {
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
  const { status } = useInstantSearch();
  const seen = useFirstResponseSeen();
  const refreshing = status === 'loading' || status === 'stalled';

  if (!seen) {
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
    <ul
      className="grid grid-cols-1 gap-3 md:grid-cols-2"
      aria-busy
      aria-label="Loading practitioners"
    >
      {Array.from({ length: 6 }).map((_, i) => (
        <li key={i}>
          <Skeleton className="h-28 w-full rounded-lg" />
        </li>
      ))}
    </ul>
  );
}
