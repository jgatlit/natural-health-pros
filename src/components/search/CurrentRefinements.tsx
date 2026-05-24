'use client';

import { X } from 'lucide-react';
import { useCurrentRefinements, useClearRefinements } from 'react-instantsearch';

export function CurrentRefinements() {
  const { items } = useCurrentRefinements();
  const { refine: clearAll, canRefine } = useClearRefinements();

  const refinements = items.flatMap((scope) =>
    scope.refinements.map((r) => ({
      scopeLabel: scope.label,
      value: r.value,
      label: r.label,
      refine: () => scope.refine(r),
    })),
  );

  if (refinements.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {refinements.map((r) => (
        <button
          key={`${r.scopeLabel}-${r.value}`}
          type="button"
          onClick={r.refine}
          className="group inline-flex items-center gap-1 rounded-full border bg-card px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent"
        >
          {r.label}
          <X className="h-3 w-3 text-muted-foreground transition-colors group-hover:text-foreground" aria-hidden />
        </button>
      ))}
      {canRefine && (
        <button
          type="button"
          onClick={clearAll}
          className="text-xs font-medium text-muted-foreground underline-offset-2 hover:underline"
        >
          Clear all
        </button>
      )}
    </div>
  );
}
