'use client';

import { useHits, useStats } from 'react-instantsearch';
import { PractitionerHitCard, type PractitionerHit } from './PractitionerHit';

export function ResultStats() {
  const { nbHits } = useStats();
  return (
    <p className="text-xs font-medium text-muted-foreground" aria-live="polite">
      {nbHits === 1 ? '1 practitioner' : `${nbHits} practitioners`}
    </p>
  );
}

export function SearchResults() {
  const { items } = useHits<PractitionerHit>();

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
    <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
      {items.map((hit) => (
        <li key={hit.id}>
          <PractitionerHitCard hit={hit} />
        </li>
      ))}
    </ul>
  );
}
