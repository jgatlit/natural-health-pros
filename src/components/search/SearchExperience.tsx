'use client';

import { InstantSearchNext } from 'react-instantsearch-nextjs';
import { useMemo } from 'react';
import { createSearchAdapter, TYPESENSE_COLLECTION } from '@/lib/typesense-search';
import { SearchBox } from './SearchBox';
import { RefinementGroup } from './RefinementGroup';
import { CurrentRefinements } from './CurrentRefinements';
import { SortBy } from './SortBy';
import { SearchResults, ResultStats } from './SearchResults';

export function SearchExperience() {
  const searchClient = useMemo(() => createSearchAdapter().searchClient, []);

  return (
    <InstantSearchNext
      searchClient={searchClient}
      indexName={TYPESENSE_COLLECTION}
      future={{ preserveSharedStateOnUnmount: true }}
    >
      <div className="space-y-4">
        <SearchBox />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <ResultStats />
            <CurrentRefinements />
          </div>
          <SortBy />
        </div>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-[220px_1fr]">
          <aside className="space-y-5">
            <RefinementGroup attribute="specialtyNames" title="Specialty" />
            <RefinementGroup attribute="cityName" title="City" />
            <RefinementGroup attribute="cityState" title="State" />
          </aside>

          <SearchResults />
        </div>
      </div>
    </InstantSearchNext>
  );
}
