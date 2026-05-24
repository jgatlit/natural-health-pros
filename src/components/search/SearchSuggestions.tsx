'use client';

import { useEffect, useState } from 'react';
import { MapPin, Tag } from 'lucide-react';
import { useRefinementList, useSearchBox } from 'react-instantsearch';
import { getTypesenseSearchClient } from '@/lib/typesense-client';
import { TYPESENSE_COLLECTION } from '@/lib/typesense-server';

type Suggestion =
  | { kind: 'city'; value: string }
  | { kind: 'specialty'; value: string };

async function fetchSuggestions(query: string): Promise<Suggestion[]> {
  if (!query.trim() || query.length < 2) return [];

  const client = getTypesenseSearchClient();
  const [cityRes, specialtyRes] = await Promise.all([
    client.collections(TYPESENSE_COLLECTION).documents().search(
      {
        q: '*',
        query_by: 'cityName',
        facet_by: 'cityName',
        facet_query: `cityName:${query}`,
        max_facet_values: 5,
        per_page: 0,
      },
      {},
    ),
    client.collections(TYPESENSE_COLLECTION).documents().search(
      {
        q: '*',
        query_by: 'specialtyNames',
        facet_by: 'specialtyNames',
        facet_query: `specialtyNames:${query}`,
        max_facet_values: 5,
        per_page: 0,
      },
      {},
    ),
  ]);

  const out: Suggestion[] = [];
  for (const c of cityRes.facet_counts?.[0]?.counts ?? []) {
    if (c.count > 0) out.push({ kind: 'city', value: c.value });
  }
  for (const s of specialtyRes.facet_counts?.[0]?.counts ?? []) {
    if (s.count > 0) out.push({ kind: 'specialty', value: s.value });
  }
  return out.slice(0, 6);
}

export function SearchSuggestions({ visible }: { visible: boolean }) {
  const { query, clear } = useSearchBox();
  const { refine: refineCity } = useRefinementList({ attribute: 'cityName', operator: 'and' });
  const { refine: refineSpecialty } = useRefinementList({
    attribute: 'specialtyNames',
    operator: 'or',
  });

  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!query || query.length < 2) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const result = await fetchSuggestions(query);
        if (!cancelled) setSuggestions(result);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  const apply = (s: Suggestion) => {
    if (s.kind === 'city') refineCity(s.value);
    else refineSpecialty(s.value);
    clear();
  };

  if (!visible || suggestions.length === 0) return null;

  return (
    <ul
      role="listbox"
      className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-lg border bg-card shadow-lg"
    >
      {loading && (
        <li className="px-3 py-2 text-xs text-muted-foreground">Searching…</li>
      )}
      {suggestions.map((s) => {
        const Icon = s.kind === 'city' ? MapPin : Tag;
        return (
          <li key={`${s.kind}-${s.value}`}>
            <button
              type="button"
              onMouseDown={(e) => {
                // onMouseDown so it fires before the input's onBlur hides us
                e.preventDefault();
                apply(s);
              }}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
            >
              <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="flex-1 truncate">{s.value}</span>
              <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
                {s.kind === 'city' ? 'City' : 'Specialty'}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
