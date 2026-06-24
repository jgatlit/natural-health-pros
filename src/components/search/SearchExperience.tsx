'use client';

import { InstantSearchNext } from 'react-instantsearch-nextjs';
import { useEffect, useMemo } from 'react';
import { useInstantSearch } from 'react-instantsearch';
import { createSearchAdapter, TYPESENSE_COLLECTION } from '@/lib/typesense-search';
import { SearchBox } from './SearchBox';
import { RefinementGroup } from './RefinementGroup';
import { RangeFacet } from './RangeFacet';
import { CurrentRefinements } from './CurrentRefinements';
import { SortBy } from './SortBy';
import { SearchResults, ResultStats } from './SearchResults';
import { MobileFiltersSheet } from './MobileFiltersSheet';
import { SearchErrorBoundary, SearchErrorState } from './SearchUnavailable';

/**
 * react-instantsearch-nextjs doesn't always fire the initial search on
 * client-side route transitions (e.g. clicking a <Link> from / to /search).
 * Direct nav works because SSR pre-renders state; client-side mounts can
 * arrive with empty UI state + no auto-search. Force a refresh on mount.
 */
function EnsureInitialSearch() {
  const { refresh } = useInstantSearch();
  useEffect(() => {
    refresh();
    // run-once on mount; we want exactly one extra search to kick off data
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

export function SearchExperience() {
  const searchClient = useMemo(() => createSearchAdapter().searchClient, []);

  return (
    <SearchErrorBoundary>
      <InstantSearchNext
        searchClient={searchClient}
        indexName={TYPESENSE_COLLECTION}
        routing={true}
        future={{ preserveSharedStateOnUnmount: true }}
      >
        <EnsureInitialSearch />
        <SearchErrorState>
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
        </SearchErrorState>
      </InstantSearchNext>
    </SearchErrorBoundary>
  );
}
