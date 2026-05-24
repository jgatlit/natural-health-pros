import { SearchClient } from 'typesense';

let _client: SearchClient | undefined;

export function getTypesenseSearchClient(): SearchClient {
  if (_client) return _client;

  const host = process.env.NEXT_PUBLIC_TYPESENSE_HOST ?? '';
  const apiKey = process.env.NEXT_PUBLIC_TYPESENSE_SEARCH_API_KEY ?? '';
  if (!host || !apiKey) {
    throw new Error(
      'Typesense client envs missing: NEXT_PUBLIC_TYPESENSE_HOST + NEXT_PUBLIC_TYPESENSE_SEARCH_API_KEY required.',
    );
  }

  _client = new SearchClient({
    nodes: [{ host, port: 443, protocol: 'https' }],
    apiKey,
    connectionTimeoutSeconds: 3,
  });

  return _client;
}
