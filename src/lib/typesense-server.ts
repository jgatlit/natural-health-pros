import Typesense from 'typesense';
import type { Client } from 'typesense';

let _client: Client | undefined;

export function getTypesenseAdmin(): Client {
  if (_client) return _client;

  const host = process.env.TYPESENSE_HOST;
  const apiKey = process.env.TYPESENSE_ADMIN_API_KEY;
  if (!host || !apiKey) {
    throw new Error(
      'Typesense env vars missing: TYPESENSE_HOST and TYPESENSE_ADMIN_API_KEY must be set.',
    );
  }

  _client = new Typesense.Client({
    nodes: [
      {
        host,
        port: parseInt(process.env.TYPESENSE_PORT ?? '443', 10),
        protocol: process.env.TYPESENSE_PROTOCOL ?? 'https',
      },
    ],
    apiKey,
    connectionTimeoutSeconds: 5,
  });

  return _client;
}

export const TYPESENSE_COLLECTION = 'practitioners';
