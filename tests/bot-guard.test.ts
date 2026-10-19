import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * Bot protection on the public email-sending forms (/auth/signin, /join/<cohort>). A rejected
 * submission sends no email and creates no invitation; a person's submission behaves as before.
 */

const SECRET = 'test-auth-secret';
const NOW = 1_800_000_000_000;

const m = vi.hoisted(() => ({
  rate: new Map<string, boolean>(),
  rateCalls: [] as Array<[string, string, { limit: number; windowSeconds: number }]>,
  signIn: vi.fn(),
  ensureInvite: vi.fn(),
  cohort: { id: 'c1', slug: 'hhe', enabled: true } as unknown,
  headers: new Map<string, string>(),
}));

vi.mock('@/lib/rate-limit', () => ({
  rateLimit: async (prefix: string, id: string, cfg: { limit: number; windowSeconds: number }) => {
    m.rateCalls.push([prefix, id, cfg]);
    return { success: m.rate.get(prefix) ?? true, remaining: 0, reset: 0 };
  },
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error(`REDIRECT:${url}`), { url });
  },
}));
vi.mock('next/headers', () => ({
  headers: () => ({ get: (k: string) => m.headers.get(k.toLowerCase()) ?? null }),
}));
vi.mock('@/auth', () => ({ signIn: m.signIn }));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    signupCohort: { findUnique: async () => m.cohort },
    invitation: { delete: vi.fn(async () => ({})) },
  },
}));
vi.mock('@/lib/join-cohort', async (orig) => ({
  ...(await orig<typeof import('@/lib/join-cohort')>()),
  ensureCohortInvitation: async (...a: unknown[]) => {
    m.ensureInvite(...a);
    return { id: 'inv1', token: 'TOKEN_abcdefghijklmnop', created: true };
  },
}));

import {
  BOT_GUARD_FIELDS,
  MAX_STAMP_AGE_MS,
  MIN_FILL_MS,
  checkBotGuard,
  checkFormStamp,
  clientIp,
  isDottedGmail,
  issueFormStamp,
  turnstileSiteKey,
  type RateRule,
} from '@/lib/bot-guard';
import { BotGuardFields } from '@/components/auth/BotGuardFields';
import { requestSignIn } from '@/app/auth/signin/actions';
import { requestJoin } from '@/app/join/[cohort]/actions';

const RULES: RateRule[] = [
  { prefix: 't-ip', by: 'ip', limit: 5, windowSeconds: 900 },
  { prefix: 't-email', by: 'email', limit: 3, windowSeconds: 3600 },
];

/** A form a person filled: empty honeypot, a stamp issued `ageMs` ago. */
function form(over: Record<string, string> = {}, ageMs = 10_000, now = Date.now()) {
  const fd = new FormData();
  fd.set('email', 'jane.doe@gmail.com');
  fd.set(BOT_GUARD_FIELDS.honeypot, '');
  fd.set(BOT_GUARD_FIELDS.stamp, issueFormStamp(now - ageMs, SECRET));
  for (const [k, v] of Object.entries(over)) fd.set(k, v);
  return fd;
}

const guard = (fd: FormData, email: string | null = 'jane.doe@gmail.com', now?: number) =>
  checkBotGuard({ form: 'test', formData: fd, email, ip: '203.0.113.9', rateLimits: RULES, now });

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.stubEnv('AUTH_SECRET', SECRET);
  vi.stubEnv('TURNSTILE_SITE_KEY', '');
  vi.stubEnv('TURNSTILE_SECRET_KEY', '');
  m.rate.clear();
  m.rateCalls.length = 0;
  m.signIn.mockReset();
  m.ensureInvite.mockReset();
  m.cohort = { id: 'c1', slug: 'hhe', enabled: true };
  m.headers = new Map([['x-forwarded-for', '203.0.113.9, 10.0.0.1']]);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('form stamp', () => {
  it('accepts a stamp between the minimum fill time and its maximum age', () => {
    expect(checkFormStamp(issueFormStamp(NOW - MIN_FILL_MS, SECRET), NOW, SECRET)).toEqual({ ok: true });
    expect(checkFormStamp(issueFormStamp(NOW - MAX_STAMP_AGE_MS, SECRET), NOW, SECRET)).toEqual({ ok: true });
  });

  it('rejects too fast, expired, missing, forged, tampered and future stamps', () => {
    expect(checkFormStamp(issueFormStamp(NOW - 500, SECRET), NOW, SECRET)).toMatchObject({ reason: 'too-fast' });
    expect(checkFormStamp(issueFormStamp(NOW - MAX_STAMP_AGE_MS - 1, SECRET), NOW, SECRET)).toMatchObject({
      reason: 'stamp-expired',
    });
    expect(checkFormStamp('', NOW, SECRET)).toMatchObject({ reason: 'stamp-missing' });
    expect(checkFormStamp(issueFormStamp(NOW - 10_000, 'other-secret'), NOW, SECRET)).toMatchObject({
      reason: 'stamp-invalid',
    });
    const [, sig] = issueFormStamp(NOW - 10_000, SECRET).split('.');
    expect(checkFormStamp(`${NOW - 20_000}.${sig}`, NOW, SECRET)).toMatchObject({ reason: 'stamp-invalid' });
    expect(checkFormStamp(issueFormStamp(NOW + 10 * 60_000, SECRET), NOW, SECRET)).toMatchObject({
      reason: 'stamp-invalid',
    });
    expect(checkFormStamp('garbage', NOW, SECRET)).toMatchObject({ reason: 'stamp-invalid' });
  });

  it('fails closed without AUTH_SECRET', () => {
    expect(issueFormStamp(NOW, '')).toBe('');
    expect(checkFormStamp(issueFormStamp(NOW - 10_000, SECRET), NOW, '')).toMatchObject({ ok: false });
  });
});

describe('dotted Gmail', () => {
  it.each([
    ['o.ge.bomi7.8.9@gmail.com', true],
    ['m.a.rk.p.h.obrat.h@gmail.com', true],
    ['f.ix.u.ha.fu68.9@gmail.com', true],
    ['a.b.c.d.e@googlemail.com', true],
    ['a.b.c.d@gmail.com', false],
    ['jane.doe@gmail.com', false],
    ['jane.m.doe@gmail.com', false],
    ['a.b.c.d.e@example.com', false],
    ['jane@gmail.com', false],
  ])('%s → %s', (email, expected) => {
    expect(isDottedGmail(email)).toBe(expected);
  });
});

describe('checkBotGuard', () => {
  it('passes a person (Turnstile off) and applies every rate rule', async () => {
    expect(await guard(form())).toEqual({ ok: true });
    expect(m.rateCalls.map(([p, id]) => [p, id])).toEqual([
      ['t-ip', '203.0.113.9'],
      ['t-email', 'jane.doe@gmail.com'],
    ]);
  });

  it('honeypot filled → pretend success, no rate limit spent', async () => {
    expect(await guard(form({ [BOT_GUARD_FIELDS.honeypot]: 'hello' }))).toEqual({
      ok: false,
      reason: 'honeypot',
      outcome: 'pretend-success',
    });
    expect(m.rateCalls).toHaveLength(0);
  });

  it('dotted Gmail → pretend success, logged with a masked address', async () => {
    const res = await guard(form(), 'o.ge.bomi7.8.9@gmail.com');
    expect(res).toMatchObject({ reason: 'dotted-gmail', outcome: 'pretend-success' });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('dotted-gmail');
    expect(logged).not.toContain('o.ge.bomi7.8.9');
  });

  it('too fast, forged or expired stamp → retry', async () => {
    expect(await guard(form({}, 1_000))).toMatchObject({ reason: 'too-fast', outcome: 'retry' });
    expect(await guard(form({ [BOT_GUARD_FIELDS.stamp]: issueFormStamp(Date.now() - 10_000, 'x') }))).toMatchObject({
      reason: 'stamp-invalid',
      outcome: 'retry',
    });
    expect(await guard(form({}, MAX_STAMP_AGE_MS + 60_000))).toMatchObject({ reason: 'stamp-expired', outcome: 'retry' });
    const noStamp = form();
    noStamp.delete(BOT_GUARD_FIELDS.stamp);
    expect(await guard(noStamp)).toMatchObject({ reason: 'stamp-missing', outcome: 'retry' });
  });

  it('rate limit exceeded → throttled', async () => {
    m.rate.set('t-email', false);
    expect(await guard(form())).toMatchObject({ reason: 'throttled', outcome: 'throttled' });
  });

  it('skips email rules without an email', async () => {
    expect(await guard(form(), null)).toEqual({ ok: true });
    expect(m.rateCalls.map(([p]) => p)).toEqual(['t-ip']);
  });

  it('Turnstile unconfigured (either key missing) → skipped, nothing sent to Cloudflare', async () => {
    vi.stubEnv('TURNSTILE_SITE_KEY', 'site');
    expect(turnstileSiteKey()).toBeNull();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await guard(form())).toEqual({ ok: true });
    expect(await guard(form())).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('Turnstile configured', () => {
    beforeEach(() => {
      vi.stubEnv('TURNSTILE_SITE_KEY', 'site-key');
      vi.stubEnv('TURNSTILE_SECRET_KEY', 'secret-key');
    });
    const withToken = () => form({ [BOT_GUARD_FIELDS.turnstile]: 'tok' });
    const reply = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

    it('success → ok, verified server-side with secret, token and remote ip', async () => {
      const fetchMock = reply({ success: true });
      vi.stubGlobal('fetch', fetchMock);
      expect(turnstileSiteKey()).toBe('site-key');
      expect(await guard(withToken())).toEqual({ ok: true });
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: URLSearchParams }];
      expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
      expect(init.body.get('secret')).toBe('secret-key');
      expect(init.body.get('response')).toBe('tok');
      expect(init.body.get('remoteip')).toBe('203.0.113.9');
    });

    it('refusal → retry', async () => {
      vi.stubGlobal('fetch', reply({ success: false, 'error-codes': ['invalid-input-response'] }));
      expect(await guard(withToken())).toMatchObject({ reason: 'turnstile', outcome: 'retry' });
    });

    it('missing token → retry without calling Cloudflare', async () => {
      const fetchMock = reply({ success: true });
      vi.stubGlobal('fetch', fetchMock);
      expect(await guard(form())).toMatchObject({ reason: 'turnstile', outcome: 'retry' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('network error or HTTP error → retry (fail closed)', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNRESET'))));
      expect(await guard(withToken())).toMatchObject({ reason: 'turnstile-error', outcome: 'retry' });
      vi.stubGlobal('fetch', reply({}, 500));
      expect(await guard(withToken())).toMatchObject({ reason: 'turnstile-error', outcome: 'retry' });
    });
  });

  it('clientIp takes the first forwarded address', () => {
    expect(clientIp(new Headers({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }))).toBe('1.2.3.4');
    expect(clientIp(new Headers({ 'x-real-ip': '9.9.9.9' }))).toBe('9.9.9.9');
    expect(clientIp(new Headers())).toBe('unknown');
  });
});

describe('BotGuardFields', () => {
  it('renders a hidden, unfocusable, non-autofilled honeypot and the stamp', () => {
    const html = renderToStaticMarkup(BotGuardFields({ stamp: 'S.T', turnstileSiteKey: null }));
    expect(html).toContain(`name="${BOT_GUARD_FIELDS.honeypot}"`);
    expect(html).toMatch(/tabindex="-1"/i);
    expect(html).toMatch(/autocomplete="off"/i);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('left:-10000px');
    expect(html).toContain(`name="${BOT_GUARD_FIELDS.stamp}" value="S.T"`);
    expect(BOT_GUARD_FIELDS.honeypot).not.toMatch(/website|url|email|name|phone/i);
  });
});

describe('/auth/signin action', () => {
  const submit = (fd: FormData, cb = '/onboarding') => requestSignIn(cb, fd);

  it('a person: signIn as before, with the callbackUrl unchanged', async () => {
    await submit(form(), '/practitioners/x/edit');
    expect(m.signIn).toHaveBeenCalledWith('resend', {
      email: 'jane.doe@gmail.com',
      redirectTo: '/practitioners/x/edit',
    });
    expect(m.rateCalls.map(([p]) => p)).toEqual(['signin-ip-15m', 'signin-ip-1d', 'signin-email-1h']);
    expect(m.rateCalls.map(([, , c]) => c)).toEqual([
      { limit: 5, windowSeconds: 900 },
      { limit: 20, windowSeconds: 86_400 },
      { limit: 3, windowSeconds: 3600 },
    ]);
  });

  it('honeypot bot: the normal verify-request page, no email sent', async () => {
    await expect(submit(form({ [BOT_GUARD_FIELDS.honeypot]: 'x' }))).rejects.toMatchObject({
      url: '/auth/verify-request?provider=resend&type=email',
    });
    expect(m.signIn).not.toHaveBeenCalled();
  });

  it('dotted-Gmail bot: the normal verify-request page, no email sent', async () => {
    await expect(submit(form({ email: 'm.a.rk.p.h.obrat.h@gmail.com' }))).rejects.toMatchObject({
      url: '/auth/verify-request?provider=resend&type=email',
    });
    expect(m.signIn).not.toHaveBeenCalled();
  });

  it('too fast: back to sign-in with a gentle retry, callbackUrl kept', async () => {
    const err = await submit(form({}, 500), '/onboarding?invitation=abc').catch((e) => e);
    const url = new URL(err.url, 'https://x');
    expect(url.pathname).toBe('/auth/signin');
    expect(url.searchParams.get('error')).toBe('retry');
    expect(url.searchParams.get('callbackUrl')).toBe('/onboarding?invitation=abc');
    expect(m.signIn).not.toHaveBeenCalled();
  });

  it('throttled: throttled message', async () => {
    m.rate.set('signin-ip-15m', false);
    const err = await submit(form()).catch((e) => e);
    expect(new URL(err.url, 'https://x').searchParams.get('error')).toBe('throttled');
    expect(m.signIn).not.toHaveBeenCalled();
  });
});

describe('/join/[cohort] action', () => {
  it('a person: invitation + signIn to /onboarding?invitation=…, then ?sent=1 (unchanged)', async () => {
    m.signIn.mockResolvedValue('https://naturalhealthpros.com/auth/verify-request');
    await expect(requestJoin('hhe', form())).rejects.toMatchObject({ url: '/join/hhe?sent=1' });
    expect(m.ensureInvite).toHaveBeenCalledTimes(1);
    expect(m.signIn).toHaveBeenCalledWith('resend', {
      email: 'jane.doe@gmail.com',
      redirectTo: '/onboarding?invitation=TOKEN_abcdefghijklmnop',
      redirect: false,
    });
    expect(m.rateCalls.map(([p]) => p)).toEqual(['join-ip', 'join-ip-1d', 'join-email']);
  });

  it.each([
    ['honeypot', { [BOT_GUARD_FIELDS.honeypot]: 'x' }],
    ['dotted Gmail', { email: 'f.ix.u.ha.fu68.9@gmail.com' }],
  ])('%s bot: the same ?sent=1, no invitation, no email', async (_l, over) => {
    await expect(requestJoin('hhe', form(over))).rejects.toMatchObject({ url: '/join/hhe?sent=1' });
    expect(m.ensureInvite).not.toHaveBeenCalled();
    expect(m.signIn).not.toHaveBeenCalled();
  });

  it('too fast → ?error=retry; throttled → ?error=throttled; neither mints or mails', async () => {
    await expect(requestJoin('hhe', form({}, 200))).rejects.toMatchObject({ url: '/join/hhe?error=retry' });
    m.rate.set('join-ip-1d', false);
    await expect(requestJoin('hhe', form())).rejects.toMatchObject({ url: '/join/hhe?error=throttled' });
    expect(m.ensureInvite).not.toHaveBeenCalled();
    expect(m.signIn).not.toHaveBeenCalled();
  });
});
