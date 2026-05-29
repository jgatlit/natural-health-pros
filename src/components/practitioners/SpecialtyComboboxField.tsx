'use client';

import { useMemo, useRef, useState } from 'react';
import { X, Plus, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

export type CanonicalOption = { id: string; name: string };
export type AliasOption = { label: string; specialtyId: string };
export type Selection = { specialtyId: string | null; rawLabel: string };

type Props = {
  options: CanonicalOption[];
  aliases: AliasOption[];
  initial: Selection[];
};

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Dual-label intake combobox (P1b). Practitioners pick an existing canonical OR enter
 * their own phrasing — never blocked. Free-text that doesn't resolve becomes a PROPOSED
 * canonical + PENDING alias server-side (the /admin/specialties moderation queue).
 * Submits a hidden JSON field consumed by updatePractitioner.
 */
export function SpecialtyComboboxField({ options, aliases, initial }: Props) {
  const [selected, setSelected] = useState<Selection[]>(initial);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const nameById = useMemo(() => new Map(options.map((o) => [o.id, o.name])), [options]);
  const selectedIds = useMemo(
    () => new Set(selected.map((s) => s.specialtyId).filter(Boolean) as string[]),
    [selected],
  );
  const selectedLabels = useMemo(() => new Set(selected.map((s) => norm(s.rawLabel))), [selected]);

  const suggestions = useMemo(() => {
    const q = norm(query);
    if (!q) return [] as Array<{ specialtyId: string; name: string; hint?: string }>;
    const out: Array<{ specialtyId: string; name: string; hint?: string }> = [];
    const seen = new Set<string>();
    for (const o of options) {
      if (selectedIds.has(o.id)) continue;
      if (norm(o.name).includes(q)) {
        out.push({ specialtyId: o.id, name: o.name });
        seen.add(o.id);
      }
    }
    for (const a of aliases) {
      if (seen.has(a.specialtyId) || selectedIds.has(a.specialtyId)) continue;
      if (norm(a.label).includes(q)) {
        const name = nameById.get(a.specialtyId);
        if (name) {
          out.push({ specialtyId: a.specialtyId, name, hint: `matches “${a.label}”` });
          seen.add(a.specialtyId);
        }
      }
    }
    return out.slice(0, 8);
  }, [query, options, aliases, nameById, selectedIds]);

  const exactCanonical = useMemo(
    () => options.some((o) => norm(o.name) === norm(query)),
    [options, query],
  );

  function add(sel: Selection) {
    if (sel.specialtyId && selectedIds.has(sel.specialtyId)) return;
    if (!sel.specialtyId && selectedLabels.has(norm(sel.rawLabel))) return;
    setSelected((prev) => [...prev, sel]);
    setQuery('');
    setOpen(false);
    inputRef.current?.focus();
  }

  function remove(idx: number) {
    setSelected((prev) => prev.filter((_, i) => i !== idx));
  }

  return (
    <div className="space-y-2">
      {selected.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {selected.map((s, i) => (
            <li key={`${s.specialtyId ?? 'new'}-${s.rawLabel}-${i}`}>
              <Badge
                variant={s.specialtyId ? 'secondary' : 'outline'}
                className="gap-1 py-1 pl-2.5 pr-1"
              >
                {!s.specialtyId && <Sparkles className="h-3 w-3 opacity-70" aria-hidden />}
                <span>{s.rawLabel}</span>
                {!s.specialtyId && (
                  <span className="text-[10px] uppercase tracking-wider opacity-60">new</span>
                )}
                <button
                  type="button"
                  onClick={() => remove(i)}
                  aria-label={`Remove ${s.rawLabel}`}
                  className="ml-0.5 rounded-sm p-0.5 hover:bg-muted"
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      )}

      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (suggestions[0]) {
                add({ specialtyId: suggestions[0].specialtyId, rawLabel: suggestions[0].name });
              } else if (query.trim()) {
                add({ specialtyId: null, rawLabel: query.trim() });
              }
            }
          }}
          placeholder="Type to search — or enter your own term"
          className="h-10 w-full rounded-md border bg-card px-3 text-sm outline-none ring-ring/30 focus-visible:ring-2"
        />

        {open && query.trim() && (
          <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border bg-card shadow-md">
            {suggestions.map((s) => (
              <button
                key={s.specialtyId}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => add({ specialtyId: s.specialtyId, rawLabel: s.name })}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-accent/50"
              >
                <span>{s.name}</span>
                {s.hint && <span className="text-xs text-muted-foreground">{s.hint}</span>}
              </button>
            ))}
            {!exactCanonical && (
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => add({ specialtyId: null, rawLabel: query.trim() })}
                className="flex w-full items-center gap-2 border-t px-3 py-2 text-left text-sm hover:bg-accent/50"
              >
                <Plus className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                Add “<strong>{query.trim()}</strong>” as your own term
              </button>
            )}
          </div>
        )}
      </div>

      <input
        type="hidden"
        name="specialtiesJson"
        value={JSON.stringify(
          selected.map((s) => ({ specialtyId: s.specialtyId, rawLabel: s.rawLabel })),
        )}
      />
    </div>
  );
}
