'use client';

import { useSortBy } from 'react-instantsearch';

const ITEMS = [
  { value: 'practitioners', label: 'Best match' },
  { value: 'practitioners/sort/acceptedAt:desc', label: 'Newest first' },
  { value: 'practitioners/sort/displayName:asc', label: 'Name A–Z' },
];

export function SortBy() {
  const { currentRefinement, refine } = useSortBy({ items: ITEMS });

  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="hidden sm:inline">Sort:</span>
      <select
        value={currentRefinement}
        onChange={(e) => refine(e.target.value)}
        className="h-8 rounded-md border bg-card px-2 text-xs font-medium text-foreground outline-none ring-ring/30 focus-visible:ring-2"
        aria-label="Sort results by"
      >
        {ITEMS.map((i) => (
          <option key={i.value} value={i.value}>
            {i.label}
          </option>
        ))}
      </select>
    </label>
  );
}
