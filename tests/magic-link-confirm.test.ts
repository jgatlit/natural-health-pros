import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * Every magic link goes through /auth/confirm. Mail scanners fetch links; a GET of the confirm page
 * must never redeem the token or create a user. Only the "Sign me in" POST does.
 */

const ORIGIN = 'https://naturalhealthpros.com';
const TOKEN = 'a3f9'.repeat(16);
const INVITE = 'AbCdEfGhIjKlMnOpQrStUvWx12_-';

const m = vi.hoisted(() => ({
  config: null as null | { providers: Array<{ sendVerificationRequest: (p: unknown) => Promise<void> }> },
  invitation: null as unknown,
  headers: new Map<string, string>(),
  signIn: vi.fn(),
  authPost: vi.fn(),
  authGet: vi.fn(),
  findUnique: vi.fn(),
  adapterCall: vi.fn(),
}));

vi.mock('next-auth', () => ({
  default: (config: typeof m.config) => {
    m.config = config;
    return {
      handlers: { GET: m.authGet, POST: m.authPost },
      signIn: m.signIn,
      signOut: vi.fn(),
      auth: vi.fn(),
    };
  },
}));
vi.mock('next-auth/providers/resend', () => ({
  default: (opts: Record<string, unknown>) => ({ id: 'resend', type: 'email', ...opts }),
}));
vi.mock('@auth/prisma-adapter', () => ({
  PrismaAdapter: () =>
    new Proxy({}, { get: (_t, key) => (...a: unknown[]) => m.adapterCall(key, ...a) }),
}));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    invitation: {
      findUnique: async (...a: unknown[]) => {
        m.findUnique(...a);
        return m.invitation;
      },
    },
    user: { findUnique: m.findUnique, update: m.findUnique, create: m.findUnique },
    verificationToken: { delete: m.findUnique, findUnique: m.findUnique },
  },
}));
vi.mock('next/headers', () => ({
  headers: () => ({ get: (k: string) => m.headers.get(k.toLowerCase()) ?? null }),
}));

import { CALLBACK_PATH, parseConfirmTarget, toConfirmUrl } from '@/lib/magic-link-confirm';

const authUrl = (callbackUrl: string, email = 'jane.doe@example.com') =>
  `${ORIGIN}${CALLBACK_PATH}?${new URLSearchParams({ callbackUrl, token: TOKEN, email })}`;

const params = (rec: Record<string, string>) => new URLSearchParams(rec);
const good = { callbackUrl: '/', token: TOKEN, email: 'jane.doe@example.com' };

beforeEach(() => {
  m.invitation = null;
  m.headers = new Map([
    ['host', 'naturalhealthpros.com'],
    ['x-forwarded-proto', 'https'],
  ]);
  for (const f of [m.signIn, m.authPost, m.authGet, m.findUnique, m.adapterCall]) f.mockReset();
});

describe('toConfirmUrl / parseConfirmTarget', () => {
  it('re-points the link at /auth/confirm on the same origin and shortens the callback', () => {
    const out = new URL(toConfirmUrl(authUrl(`${ORIGIN}/onboarding?invitation=${INVITE}`)));
    expect(out.origin).toBe(ORIGIN);
    expect(out.pathname).toBe('/auth/confirm');
    expect(out.searchParams.get('callbackUrl')).toBe(`/onboarding?invitation=${INVITE}`);
    expect(out.searchParams.get('token')).toBe(TOKEN);
    expect(out.searchParams.get('email')).toBe('jane.doe@example.com');
  });

  it('refuses to wrap anything but the Auth.js resend callback', () => {
    expect(() => toConfirmUrl(`${ORIGIN}/somewhere?token=${TOKEN}`)).toThrow();
  });

  it.each([
    ['a cohort invitation', `${ORIGIN}/onboarding?invitation=${INVITE}`, `/onboarding?invitation=${INVITE}`],
    ['the home page', `${ORIGIN}/`, '/'],
    ['a relative path', '/practitioners/maya/edit', '/practitioners/maya/edit'],
  ])('round-trips %s into a POST action on the callback', (_l, cb, expectedCb) => {
    const confirm = new URL(toConfirmUrl(authUrl(cb)));
    const target = parseConfirmTarget(confirm.searchParams, ORIGIN);
    expect(target).not.toBeNull();
    expect(target!.email).toBe('jane.doe@example.com');
    const action = new URL(target!.action, ORIGIN);
    expect(target!.action.startsWith(`${CALLBACK_PATH}?`)).toBe(true);
    expect(action.pathname).toBe(CALLBACK_PATH);
    expect(action.searchParams.get('callbackUrl')).toBe(expectedCb);
    expect(action.searchParams.get('token')).toBe(TOKEN);
    expect(action.searchParams.get('email')).toBe('jane.doe@example.com');
  });

  it('accepts an absolute callback on the same origin and emits it as a path', () => {
    const t = parseConfirmTarget(params({ ...good, callbackUrl: `${ORIGIN}/onboarding?invitation=${INVITE}` }), ORIGIN);
    expect(new URL(t!.action, ORIGIN).searchParams.get('callbackUrl')).toBe(`/onboarding?invitation=${INVITE}`);
  });

  it.each([
    ['another origin', { callbackUrl: 'https://evil.com/' }],
    ['a look-alike origin', { callbackUrl: 'https://naturalhealthpros.com.evil.com/' }],
    ['userinfo trick', { callbackUrl: 'https://naturalhealthpros.com@evil.com/' }],
    ['protocol-relative', { callbackUrl: '//evil.com' }],
    ['triple slash', { callbackUrl: '///evil.com' }],
    ['a same-origin url whose path is protocol-relative', { callbackUrl: `${ORIGIN}//evil.com` }],
    ['backslash', { callbackUrl: '/\\evil.com' }],
    ['javascript:', { callbackUrl: 'javascript:alert(1)' }],
    ['data:', { callbackUrl: 'data:text/html,hi' }],
    ['a bare host', { callbackUrl: 'evil.com' }],
    ['http on an https origin', { callbackUrl: 'http://naturalhealthpros.com/' }],
    ['whitespace', { callbackUrl: '/ok\n' }],
    ['a token with bad characters', { token: `${TOKEN}<script>` }],
    ['a token with a slash', { token: `${TOKEN}/x` }],
    ['a short token', { token: 'abc' }],
    ['an email with no @', { email: 'nope' }],
    ['an email with markup', { email: 'a<b>@x.com' }],
  ])('rejects %s', (_l, over) => {
    expect(parseConfirmTarget(params({ ...good, ...over }), ORIGIN)).toBeNull();
  });

  it('rejects missing, extra and repeated parameters', () => {
    const { token: _t, ...noToken } = good;
    expect(parseConfirmTarget(params(noToken), ORIGIN)).toBeNull();
    expect(parseConfirmTarget(params({ ...good, next: '/x' }), ORIGIN)).toBeNull();
    const dup = params(good);
    dup.append('callbackUrl', '/');
    expect(parseConfirmTarget(dup, ORIGIN)).toBeNull();
    expect(parseConfirmTarget({ ...good, token: [TOKEN, TOKEN] }, ORIGIN)).toBeNull();
    expect(parseConfirmTarget({}, ORIGIN)).toBeNull();
  });

  it('builds the action from validated parts only', () => {
    const t = parseConfirmTarget(params({ ...good, callbackUrl: `${ORIGIN}/a?b=c#frag` }), ORIGIN);
    expect(t!.action).toBe(`${CALLBACK_PATH}?${new URLSearchParams({ callbackUrl: '/a?b=c', token: TOKEN, email: good.email })}`);
  });
});

describe('the magic-link email', () => {
  async function sendWith(callbackUrl: string, invitation: unknown = null) {
    m.invitation = invitation;
    const bodies: Array<{ html: string; text: string; subject: string }> = [];
    const fetchMock = vi.fn(async (_u: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await import('@/auth');
    await m.config!.providers[0].sendVerificationRequest({
      identifier: 'jane.doe@example.com',
      url: authUrl(callbackUrl),
      provider: { apiKey: 'k', from: 'f' },
    });
    vi.unstubAllGlobals();
    return bodies[0];
  }

  it('links to /auth/confirm in text and html, never to the callback', async () => {
    const mail = await sendWith(`${ORIGIN}/`);
    for (const part of [mail.text, mail.html]) {
      expect(part).toContain(`${ORIGIN}/auth/confirm?`);
      expect(part).not.toContain('/api/auth/callback');
      expect(part).toContain(TOKEN);
    }
    expect(mail.subject).toBe('Sign in to Natural Health Pros');
  });

  it('still brands a real cohort invitation off the original Auth.js url', async () => {
    const mail = await sendWith(`${ORIGIN}/onboarding?invitation=${INVITE}`, {
      email: 'jane.doe@example.com',
      acceptedAt: null,
      expiresAt: new Date(Date.now() + 86_400_000),
      cohortId: 'c1',
      invitedBy: null,
    });
    expect(m.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { token: INVITE } }));
    expect(mail.subject).toBe('Sign in to claim your Natural Health Pros profile');
    expect(mail.text).toContain('set up your practitioner profile');
    expect(mail.text).not.toContain('/api/auth/callback');
    const link = mail.text.split('\n').find((l) => l.startsWith(ORIGIN))!;
    const t = parseConfirmTarget(new URL(link).searchParams, ORIGIN);
    expect(new URL(t!.action, ORIGIN).searchParams.get('callbackUrl')).toBe(`/onboarding?invitation=${INVITE}`);
  });
});

describe('/auth/confirm page', () => {
  const render = async (sp: Record<string, string>) => {
    const { default: Page } = await import('@/app/auth/confirm/page');
    return renderToStaticMarkup(Page({ searchParams: sp }));
  };

  it('shows the address and one POST button to the validated callback', async () => {
    const confirm = new URL(toConfirmUrl(authUrl(`${ORIGIN}/onboarding?invitation=${INVITE}`)));
    const html = await render(Object.fromEntries(confirm.searchParams));
    expect(html).toContain('jane.doe@example.com');
    expect(html).toContain('Sign me in');
    expect(html).toMatch(/<form method="post" action="\/api\/auth\/callback\/resend\?/);
    expect(html.match(/<form/g)).toHaveLength(1);
  });

  it('renders the invalid state for a bad link, with a way back to sign-in', async () => {
    const html = await render({ ...good, callbackUrl: '//evil.com' });
    expect(html).toContain('This link is not valid');
    expect(html).toContain('href="/auth/signin"');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('evil.com');
  });

  it('rendering (GET or HEAD) touches neither Auth.js, the adapter nor the database', async () => {
    await render(Object.fromEntries(new URL(toConfirmUrl(authUrl(`${ORIGIN}/`))).searchParams));
    await render({ ...good, token: 'x' });
    expect(m.signIn).not.toHaveBeenCalled();
    expect(m.authGet).not.toHaveBeenCalled();
    expect(m.authPost).not.toHaveBeenCalled();
    expect(m.adapterCall).not.toHaveBeenCalled();
    expect(m.findUnique).not.toHaveBeenCalled();
  });

  it('the page module imports neither Auth.js nor Prisma, and is dynamic + noindex + no-referrer', () => {
    const src = readFileSync('src/app/auth/confirm/page.tsx', 'utf8');
    const lib = readFileSync('src/lib/magic-link-confirm.ts', 'utf8');
    for (const s of [src, lib]) {
      expect(s).not.toMatch(/from ['"]@\/auth['"]/);
      expect(s).not.toMatch(/from ['"]next-auth/);
      expect(s).not.toMatch(/from ['"](@\/lib\/prisma|@prisma\/client|@auth\/)/);
      expect(s).not.toMatch(/signIn\(/);
    }
    expect(lib).not.toMatch(/^import /m);
    expect(src).toMatch(/export const dynamic = 'force-dynamic'/);
    expect(src).toMatch(/robots: \{ index: false, follow: false \}/);
    expect(src).toMatch(/referrer: 'no-referrer'/);
  });

  it('next.config sends Referrer-Policy: no-referrer for /auth/confirm, after the site-wide rule', async () => {
    const { default: nextConfig } = await import('../next.config.mjs');
    const rules = await nextConfig.headers!();
    const idx = rules.findIndex((r: { source: string }) => r.source === '/auth/confirm');
    expect(idx).toBeGreaterThan(0);
    expect(rules[idx].headers).toContainEqual({ key: 'Referrer-Policy', value: 'no-referrer' });
  });

  it('middleware gates no /auth path, and attribution stores only the pathname', async () => {
    const mw = readFileSync('src/middleware.ts', 'utf8');
    expect(mw).not.toMatch(/startsWith\('\/auth/);
    const { resolveAttribution } = await import('@/lib/attribution');
    const a = resolveAttribution({
      pathname: '/auth/confirm',
      searchParams: new URLSearchParams(good),
      referrer: null,
      selfHost: 'naturalhealthpros.com',
      now: 1,
    });
    expect(JSON.stringify(a)).not.toContain(TOKEN);
    expect(JSON.stringify(a)).not.toContain('jane.doe');
  });
});

describe('the auth route', () => {
  const req = (method: 'GET' | 'POST', callbackUrl: string) =>
    new Request(`${ORIGIN}${CALLBACK_PATH}?${new URLSearchParams({ callbackUrl, token: TOKEN, email: good.email })}`, {
      method,
    });

  it('POST (the confirm button) lands a used invitation link on the recovery page with its context', async () => {
    m.authPost.mockResolvedValue(Response.redirect(`${ORIGIN}/auth/error?error=Verification`, 302));
    const { POST } = await import('@/app/api/auth/[...nextauth]/route');
    const res = await POST(req('POST', `/onboarding?invitation=${INVITE}`) as never);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.pathname).toBe('/auth/error');
    expect(loc.searchParams.get('callbackUrl')).toBe(`/onboarding?invitation=${INVITE}`);
    expect(m.authPost).toHaveBeenCalledTimes(1);
  });

  it('GET keeps working for links already in inboxes', async () => {
    m.authGet.mockResolvedValue(Response.redirect(`${ORIGIN}/auth/error?error=Verification`, 302));
    const { GET } = await import('@/app/api/auth/[...nextauth]/route');
    const res = await GET(req('GET', `/onboarding?invitation=${INVITE}`) as never);
    expect(new URL(res.headers.get('location')!).searchParams.get('callbackUrl')).toBe(
      `/onboarding?invitation=${INVITE}`,
    );
  });

  it('a successful POST passes straight through', async () => {
    const ok = Response.redirect(`${ORIGIN}/onboarding?invitation=${INVITE}`, 302);
    m.authPost.mockResolvedValue(ok);
    const { POST } = await import('@/app/api/auth/[...nextauth]/route');
    expect(await POST(req('POST', `/onboarding?invitation=${INVITE}`) as never)).toBe(ok);
  });
});

describe('Auth.js accepts the confirm POST (pinned against the installed @auth/core)', () => {
  it('the email callback reads token/email from the query and skips CSRF for non-credentials POSTs', () => {
    const core = readFileSync('node_modules/@auth/core/lib/index.js', 'utf8');
    expect(core).toMatch(/case "callback":\s*if \(options\.provider\.type === "credentials"\)\s*\/\/[^\n]*\n\s*validateCSRF/);
    expect(core).toMatch(/callbackUrl: request\.body\?\.callbackUrl \?\? request\.query\?\.callbackUrl/);
    const cb = readFileSync('node_modules/@auth/core/lib/actions/callback/index.js', 'utf8');
    expect(cb).toMatch(/const paramToken = query\?\.token;/);
    expect(cb).toMatch(/const paramIdentifier = query\?\.email;/);
  });
});
