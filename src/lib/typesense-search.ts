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
      query_by: 'displayName,cityName,specialtyNames,bio,searchText',
      query_by_weights: '8,6,5,2,3',
      sort_by: '_text_match:desc,acceptedAt:desc',
      num_typos: '1,1,1,2,2',
      typo_tokens_threshold: 1,
      drop_tokens_threshold: 1,
      prefix: true,
      infix: 'fallback,off,off,off,off',
      highlight_full_fields: 'displayName,cityName,specialtyNames',
      facet_by: 'specialtyNames,cityName,cityState',
      max_facet_values: 50,
    },
  });
}

export { TYPESENSE_COLLECTION };
