'use client';

import { Search, X } from 'lucide-react';
import { useSearchBox } from 'react-instantsearch';
import { useState, useEffect } from 'react';
import { SearchSuggestions } from './SearchSuggestions';

export function SearchBox() {
  const { query, refine, clear } = useSearchBox();
  const [value, setValue] = useState(query);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    setValue(query);
  }, [query]);

  useEffect(() => {
    const t = setTimeout(() => {
      if (value !== query) refine(value);
    }, 250);
    return () => clearTimeout(t);
  }, [value, query, refine]);

  return (
    <div className="relative">
      <Search
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <input
        type="search"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder="Find a functional medicine practitioner near Atlanta"
        aria-label="Search practitioners"
        className="h-11 w-full rounded-lg border bg-card pl-10 pr-10 text-sm shadow-sm outline-none ring-ring/30 transition-shadow focus-visible:ring-2"
      />
      {value && (
        <button
          type="button"
          onClick={() => {
            setValue('');
            clear();
          }}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label="Clear search"
        >
          <X className="h-4 w-4" />
        </button>
      )}
      <SearchSuggestions visible={focused} />
    </div>
  );
}
