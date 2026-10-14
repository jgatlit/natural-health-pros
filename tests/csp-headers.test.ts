import { describe, it, expect, afterEach } from 'vitest';
import nextConfig from '../next.config.mjs';
import { expectedBlobHost } from '@/lib/custom-sections';

async function cspWith(token: string | undefined): Promise<string> {
  const prev = process.env.BLOB_READ_WRITE_TOKEN;
  if (token === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
  else process.env.BLOB_READ_WRITE_TOKEN = token;
  try {
    const rules = await nextConfig.headers!();
    const h = rules[0].headers.find((x: { key: string }) => x.key === 'Content-Security-Policy');
    return h!.value;
  } finally {
    if (prev === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = prev;
  }
}
const directive = (csp: string, name: string) =>
  csp.split('; ').find((d) => d.startsWith(`${name} `)) ?? '';

describe('Content-Security-Policy admits section media', () => {
  afterEach(() => undefined);

  it('media-src allows self and exactly our Blob store host (derived from the token)', async () => {
    const csp = await cspWith('vercel_blob_rw_abc123_secret');
    expect(directive(csp, 'media-src')).toBe(`media-src 'self' https://${expectedBlobHost('vercel_blob_rw_abc123_secret')}`);
  });
  it('without a derivable token it falls back to the Blob wildcard host, never bare https:', async () => {
    const media = directive(await cspWith(undefined), 'media-src');
    expect(media).toBe("media-src 'self' https://*.public.blob.vercel-storage.com");
    expect(media).not.toMatch(/\shttps:(\s|$)/);
  });
  it('img-src (posters, images) and frame-src (embeds) admit the provider hosts', async () => {
    const csp = await cspWith('vercel_blob_rw_abc123_secret');
    // Both directives carry the scheme source `https:`, which admits youtube-nocookie.com,
    // player.vimeo.com and www.loom.com (and the Blob host for posters). They are intentionally
    // not narrowed: practitioners' booking widgets share frame-src.
    expect(directive(csp, 'img-src')).toMatch(/\shttps:(\s|$)/);
    expect(directive(csp, 'frame-src')).toMatch(/\shttps:(\s|$)/);
  });
  it('default-src stays self (no loosening)', async () => {
    expect(directive(await cspWith('vercel_blob_rw_abc123_secret'), 'default-src')).toBe("default-src 'self'");
  });
});
