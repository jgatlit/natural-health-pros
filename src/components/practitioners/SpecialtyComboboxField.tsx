'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Plus, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { SortableList } from '@/components/practitioners/SortableList';

export type CanonicalOption = { id: string; name: string };
export type AliasOption = { label: string; specialtyId: string };
export type Selection = { specialtyId: string | null; rawLabel: string };

type Props = {
  options: CanonicalOption[];
  aliases: AliasOption[];
  initial: Selection[];
  /** Block the enclosing form's submit until at least one specialty is added. */
  required?: boolean;
  requiredMessage?: string;
};

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Dual-label intake combobox (P1b). Practitioners pick an existing specialty OR enter
 * their own phrasing — never blocked. Free text is never converted to a different specialty:
 * server-side it reuses a specialty only when that specialty is the same words, else it becomes
 * a PROPOSED specialty + PENDING alias (the /admin/specialties moderation queue).
 * Submits a hidden JSON field consumed by updatePractitioner.
 */
export function SpecialtyComboboxField({
  options,
  aliases,
  initial,
  required = false,
  requiredMessage = 'Add at least one specialty.',
}: Props) {
  const [selected, setSelected] = useState<Selection[]>(initial);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // The selections travel in a hidden input, which the browser never validates, so the visible
  // search box carries the "required" state: the form will not submit, and the browser points at
  // this box with the message, until a chip exists. Text typed but not yet added does not count.
  const missing = required && selected.length === 0;
  useEffect(() => {
    inputRef.current?.setCustomValidity(missing ? requiredMessage : '');
  }, [missing, requiredMessage]);

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

  // dnd-kit needs a stable identity per item, and the array index stops being one the moment the
  // list can be reordered. A selection is identified by its canonical id, or by its normalized raw
  // label when it is a novel term with no canonical yet — deliberately WITHOUT the index, which an
  // earlier revision included: that made every id change on reorder, remounting rows mid-drag and
  // stealing focus from a keyboard user who had just lifted a chip. `add()` already rejects
  // duplicate labels, so the label alone is unique within this list.
  const sortableSelected = useMemo(
    () => selected.map((s) => ({ ...s, id: s.specialtyId ?? `new:${norm(s.rawLabel)}` })),
    [selected],
  );
  const handleReorder = (next: { specialtyId: string | null; rawLabel: string }[]) =>
    setSelected(next.map(({ specialtyId, rawLabel }) => ({ specialtyId, rawLabel })));

  return (
    <div className="space-y-2">
      {selected.length > 0 && (
        <>
          {/* Order here IS the order on the public profile — the server writes sortOrder from
              this array's index, so dragging a chip is the whole reorder mechanism. Requested by
              Sarah Schindler: "It doesn't allow you to arrange them from what you want the
              potential client to see first." */}
          <div className="flex flex-wrap gap-1.5">
            <SortableList items={sortableSelected} onReorder={handleReorder} orientation="wrap">
              {(s, i, handle) => (
                <Badge
                  variant={s.specialtyId ? 'secondary' : 'outline'}
                  className="gap-1 py-1 pl-1.5 pr-1"
                >
                  {handle}
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
              )}
            </SortableList>
          </div>
          {selected.length > 1 && (
            <p className="text-[11px] text-muted-foreground">
              Drag to reorder — this is the order clients see them in.
            </p>
          )}
        </>
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
              // Enter keeps the practitioner's own words. It takes an existing specialty only when
              // the text IS that specialty's name; a suggestion reached through an alias or a
              // partial match ("anxiety" → Stress / Sleep Optimization) is a different concept and
              // needs an explicit click.
              const exact = options.find(
                (o) => norm(o.name) === norm(query) && !selectedIds.has(o.id),
              );
              if (exact) {
                add({ specialtyId: exact.id, rawLabel: exact.name });
              } else if (query.trim()) {
                add({ specialtyId: null, rawLabel: query.trim() });
              }
            }
          }}
          aria-required={required || undefined}
          aria-invalid={missing || undefined}
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
