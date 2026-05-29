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
    },
  });
}

export { TYPESENSE_COLLECTION };
