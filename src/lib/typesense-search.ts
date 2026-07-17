import TypesenseInstantSearchAdapter from 'typesense-instantsearch-adapter';
import { TYPESENSE_COLLECTION } from './typesense-server';

export function createSearchAdapter() {
  const host = process.env.NEXT_PUBLIC_TYPESENSE_HOST ?? process.env.TYPESENSE_HOST ?? '';
  const apiKey = process.env.NEXT_PUBLIC_TYPESENSE_SEARCH_API_KEY ?? '';

  return new TypesenseInstantSearchAdapter({
    server: {
      nodes: [{ host, port: 443, protocol: 'https' }],
      apiKey,
      cacheSearchResultsForSeconds: 60,
      // Fail FAST when the cluster is unreachable. Without these, the typesense-js
      // default (5s timeout × ~3 retries) makes the SSR initial search hang ~15s,
      // which streams an HTTP 200 shell that never resolves past the loading
      // skeleton — exactly the silent outage seen 2026-06-24 when the cluster was
      // terminated. 2s × 1 retry bounds the failure to a few seconds so the error
      // boundary in SearchExperience can render a real "unavailable" state.
      connectionTimeoutSeconds: 2,
      numRetries: 1,
      retryIntervalSeconds: 0.5,
      healthcheckIntervalSeconds: 15,
    },
    additionalSearchParameters: {
      // PRIMARY (P1d): keyword over canonical + the practitioner's own phrasing
      // (specialtyLabels) + bio/searchText. Multi-way synonyms (the dual-label collapse
      // + SECONDARY-a symptom bridge) apply automatically — the synonym set is attached
      // to the collection (see typesense-synonyms.ts), so no query param is needed.
      // SECONDARY-b (native vector fallback on low recall) is V1.5.
      query_by: 'displayName,cityName,specialtyNames,specialtyLabels,bio,searchText',
      query_by_weights: '8,6,5,5,2,3',
      sort_by: '_text_match:desc,acceptedAt:desc',
      num_typos: '1,1,1,1,2,2',
      typo_tokens_threshold: 1,
      drop_tokens_threshold: 1,
      prefix: true,
      infix: 'fallback,off,off,off,off,off',
      highlight_full_fields: 'displayName,cityName,specialtyNames,specialtyLabels',
      // Facet on the CURATED canonical only — raw labels stay searchable but out of the facet.
      facet_by: 'specialtyNames,cityName,cityState,yearsInPractice',
      max_facet_values: 50,
      // Phase 2.5 completeness gate: only show practitioners with name + city +
      // bio (≥20 chars) + ≥1 specialty in public discovery. Direct profile URLs
      // still work for incomplete profiles — they're just hidden from search.
      filter_by: 'isComplete:=true',
      // Typesense defaults per_page to 10 and we never overrode it, so /search silently
      // truncated: the facet said "Virtual Practice 13" and the header said "14
      // practitioners" while the list rendered 10, with no pagination widget on the page to
      // reach the rest. They were unreachable, not just unshown. 24 comfortably covers the
      // whole directory at pilot scale (14 now, ~20-50 planned) so the common case is one
      // page and no scrolling; beyond that SearchResults auto-loads on scroll. Typesense
      // caps per_page at 250 — don't raise this to "just fetch everything", the infinite
      // scroll is what keeps it correct as the cohort grows.
      per_page: 24,
    },
  });
}

export { TYPESENSE_COLLECTION };
