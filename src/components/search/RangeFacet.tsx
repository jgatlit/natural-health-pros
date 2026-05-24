'use client';

import { useRange } from 'react-instantsearch';
import { useEffect, useState } from 'react';

type Props = {
  attribute: string;
  title: string;
  unit?: string;
};

export function RangeFacet({ attribute, title, unit = '' }: Props) {
  const { start, range, refine, canRefine } = useRange({ attribute });
  const min = range.min;
  const max = range.max;
  const [minVal, setMinVal] = useState<number | undefined>(undefined);
  const [maxVal, setMaxVal] = useState<number | undefined>(undefined);

  useEffect(() => {
    setMinVal(typeof start[0] === 'number' && start[0] !== -Infinity ? start[0] : min);
    setMaxVal(typeof start[1] === 'number' && start[1] !== Infinity ? start[1] : max);
  }, [start, min, max]);

  if (!canRefine || min === undefined || max === undefined || min === max) return null;

  const apply = (lo: number | undefined, hi: number | undefined) => {
    refine([
      lo === undefined || lo === min ? undefined : lo,
      hi === undefined || hi === max ? undefined : hi,
    ]);
  };

  return (
    <section aria-labelledby={`range-${attribute}`} className="space-y-2">
      <h3
        id={`range-${attribute}`}
        className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
      >
        {title}
      </h3>
      <div className="flex items-center gap-2 text-xs">
        <label className="flex-1">
          <span className="sr-only">Min</span>
          <input
            type="number"
            min={min}
            max={max}
            value={minVal ?? ''}
            onChange={(e) => {
              const v = e.target.value === '' ? undefined : Number(e.target.value);
              setMinVal(v);
              apply(v, maxVal);
            }}
            className="h-8 w-full rounded-md border bg-card px-2 text-xs outline-none ring-ring/30 focus-visible:ring-2"
            aria-label={`Minimum ${title}`}
          />
        </label>
        <span className="text-muted-foreground">to</span>
        <label className="flex-1">
          <span className="sr-only">Max</span>
          <input
            type="number"
            min={min}
            max={max}
            value={maxVal ?? ''}
            onChange={(e) => {
              const v = e.target.value === '' ? undefined : Number(e.target.value);
              setMaxVal(v);
              apply(minVal, v);
            }}
            className="h-8 w-full rounded-md border bg-card px-2 text-xs outline-none ring-ring/30 focus-visible:ring-2"
            aria-label={`Maximum ${title}`}
          />
        </label>
      </div>
      <p className="text-[10px] text-muted-foreground">
        Range available: {min}{unit && ` ${unit}`}–{max}{unit && ` ${unit}`}
      </p>
    </section>
  );
}
