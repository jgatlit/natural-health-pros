'use client';

import { useState } from 'react';
import { Plus, X } from 'lucide-react';

export type BookingLinkInput = { label: string; url: string };

type Props = { initial: BookingLinkInput[] };

// Repeatable booking-link field (Wedge 2B). Each row emits a paired
// `bookingLabel` + `bookingUrl` into the form; the server action zips them by
// index. The whole edit page is a server component, so this island manages the
// add/remove state client-side.
export function BookingLinksField({ initial }: Props) {
  const [rows, setRows] = useState<BookingLinkInput[]>(
    initial.length > 0 ? initial : [{ label: '', url: '' }],
  );

  const update = (i: number, patch: Partial<BookingLinkInput>) =>
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  const remove = (i: number) => setRows((r) => r.filter((_, idx) => idx !== i));
  const add = () => setRows((r) => [...r, { label: '', url: '' }]);

  return (
    <div className="space-y-2">
      {rows.map((row, i) => (
        <div key={i} className="flex items-start gap-2">
          <div className="grid flex-1 gap-2 sm:grid-cols-[minmax(0,11rem)_1fr]">
            <input
              type="text"
              name="bookingLabel"
              value={row.label}
              onChange={(e) => update(i, { label: e.target.value })}
              placeholder="Label (e.g. Free intro)"
              className="h-10 w-full rounded-md border bg-card px-3 text-sm outline-none ring-ring/30 focus-visible:ring-2"
            />
            <input
              type="url"
              name="bookingUrl"
              value={row.url}
              onChange={(e) => update(i, { url: e.target.value })}
              placeholder="https://cal.com/your-username/intro-consult"
              className="h-10 w-full rounded-md border bg-card px-3 text-sm outline-none ring-ring/30 focus-visible:ring-2"
            />
          </div>
          <button
            type="button"
            onClick={() => remove(i)}
            aria-label="Remove booking link"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ))}

      <button
        type="button"
        onClick={add}
        className="inline-flex items-center gap-1.5 rounded-md border border-dashed px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
        Add booking link
      </button>
    </div>
  );
}
