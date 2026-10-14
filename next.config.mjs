/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    // Practitioner headshots live in the public Vercel Blob store; the landing
    // page's directory rail runs them through next/image.
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*.public.blob.vercel-storage.com',
      },
    ],
  },

  /**
   * SECURITY HEADERS — a hardening baseline, deliberately NOT a vendor allowlist.
   *
   * THE TRADEOFF, stated plainly. The threat is that Calendly's and cal.com's widget scripts run
   * in OUR origin (loadScript injects them into our document, not the iframe) on a page holding
   * the booking token and the buyer's name and email. The CSP directive that would actually bound
   * that is `connect-src` pinned to a vendor list — and that is exactly the directive that breaks
   * a practitioner's scheduler when a vendor adds a host we did not predict.
   *
   * An earlier draft of this file did pin `connect-src` and `frame-src` to enumerated vendor
   * hosts. That was wrong for this product, for the same reason the iframe sandbox allowlist was
   * wrong: it silently breaks a real practitioner's booking page and looks like a provider
   * outage. It had already missed one — Acuity's embed loads a Datadog SDK from a host that was
   * not on the list. Enumerating a third party's infrastructure is a guess that ages badly, and
   * the operator ruling is to trust the practitioner's vendor and keep the flow seamless.
   *
   * So `connect-src`, `frame-src` and `img-src` are `https:` — any HTTPS host. What is still
   * enforced costs nothing and cannot break a scheduler:
   *   object-src 'none'      no plugin content, ever
   *   base-uri 'self'        a `<base>` injection cannot repoint every relative URL
   *   frame-ancestors 'none' we cannot be framed (clickjacking on a payment flow)
   *   form-action 'self'     our own forms cannot be repointed; the scheduler's forms live in
   *                          its own document under its own policy, so this does not touch them
   *   the `https:` floor     blocks data:/blob:-sourced scripts and mixed content
   *
   * `script-src` keeps 'unsafe-inline'/'unsafe-eval' because the App Router ships inline
   * bootstrap and flight scripts; removing them needs per-request nonces in middleware. That is
   * the real next step if this is ever tightened — not a vendor allowlist.
   */
  async headers() {
    // media-src: uploaded section video is served from our public Blob store, which `default-src
    // 'self'` would otherwise refuse (a <video> falls back to default-src). Pinned to the exact
    // store host derived from BLOB_READ_WRITE_TOKEN (`vercel_blob_rw_<storeId>_...`); when that
    // cannot be derived it falls back to the Blob wildcard host, never to bare `https:`.
    const storeId = /^vercel_blob_rw_([A-Za-z0-9]+)_/.exec(process.env.BLOB_READ_WRITE_TOKEN ?? '')?.[1];
    const blobMediaHost = storeId
      ? `https://${storeId.toLowerCase()}.public.blob.vercel-storage.com`
      : 'https://*.public.blob.vercel-storage.com';
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:",
      "style-src 'self' 'unsafe-inline' https:",
      "font-src 'self' data: https:",
      "img-src 'self' data: blob: https:",
      `media-src 'self' ${blobMediaHost}`,
      "connect-src 'self' https:",
      "frame-src 'self' https:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ');

    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          // Belt-and-braces on the booking token. The browser default is already
          // strict-origin-when-cross-origin, but stating it means a future default change cannot
          // start sending the token-bearing URL to a practitioner's scheduler.
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default nextConfig;