'use client';

import { useRefinementList } from 'react-instantsearch';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

type Props = {
  attribute: string;
  title: string;
  limit?: number;
  operator?: 'or' | 'and';
};

export function RefinementGroup({ attribute, title, limit = 50, operator = 'or' }: Props) {
  const { items, refine } = useRefinementList({
    attribute,
    limit,
    operator,
    sortBy: ['count:desc', 'name:asc'],
  });

  // Parametric pruning: hide entirely if no values exist in current result set.
  if (items.length === 0) return null;

  return (
    <section aria-labelledby={`facet-${attribute}`} className="space-y-2">
      <h3
        id={`facet-${attribute}`}
        className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
      >
        {title}
      </h3>
      <ul className="space-y-0.5">
        {items.map((item) => (
          <li key={item.label}>
            <button
              type="button"
              onClick={() => refine(item.value)}
              className={cn(
                'flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                'hover:bg-accent/40',
                item.isRefined && 'bg-accent text-accent-foreground',
              )}
              aria-pressed={item.isRefined}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className={cn(
                    'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                    item.isRefined
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-input',
                  )}
                  aria-hidden
                >
                  {item.isRefined && <Check className="h-3 w-3" strokeWidth={3} />}
                </span>
                <span className="truncate">{item.label}</span>
              </span>
              <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                {item.count}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
