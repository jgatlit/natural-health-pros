'use client';

import { InstantSearchNext } from 'react-instantsearch-nextjs';
import { useMemo } from 'react';
import { createSearchAdapter, TYPESENSE_COLLECTION } from '@/lib/typesense-search';
import { SearchBox } from './SearchBox';
import { RefinementGroup } from './RefinementGroup';
import { RangeFacet } from './RangeFacet';
import { CurrentRefinements } from './CurrentRefinements';
import { SortBy } from './SortBy';
import { SearchResults, ResultStats } from './SearchResults';
import { MobileFiltersSheet } from './MobileFiltersSheet';

export function SearchExperience() {
  const searchClient = useMemo(() => createSearchAdapter().searchClient, []);

  return (
    <InstantSearchNext
      searchClient={searchClient}
      indexName={TYPESENSE_COLLECTION}
      routing={true}
      future={{ preserveSharedStateOnUnmount: true }}
    >
      <div className="space-y-4">
        <SearchBox />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <ResultStats />
            <CurrentRefinements />
          </div>
          <div className="flex items-center gap-2">
            <MobileFiltersSheet />
            <SortBy />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-[220px_1fr]">
          <aside className="hidden space-y-5 md:block">
            <RefinementGroup attribute="specialtyNames" title="Specialty" operator="or" />
            <RefinementGroup attribute="cityName" title="City" operator="and" />
            <RefinementGroup attribute="cityState" title="State" operator="and" />
            <RangeFacet attribute="yearsInPractice" title="Years in practice" unit="yr" />
          </aside>

          <SearchResults />
        </div>
      </div>
    </InstantSearchNext>
  );
}
