import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Fix 1: a used or expired magic link (second click, an older email, a mail scanner) no longer
 * dead-ends. Links stay single-use; this covers where the person goes next.
 */

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWx12_-';
const ORIGIN = 'https://naturalhealthpros.com';

const m = vi.hoisted(() => ({
  session: null as unknown,
  invitation: null as unknown,
  rateOk: true,
  signIn: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error(`REDIRECT:${url}`), { url });
  },
}));
vi.mock('@/auth', () => ({ auth: async () => m.session, signIn: m.signIn }));
vi.mock('@/lib/prisma', () => ({
  prisma: { invitation: { findUnique: async () => m.invitation } },
}));
vi.mock('@/lib/rate-limit', () => ({
  rateLimit: async (...a: unknown[]) => {
    m.rateLimit(...a);
    return { success: m.rateOk, remaining: 0, reset: 0 };
  },
}));

import {
  invitationCallbackPath,
  maskEmail,
  signedInDestination,
  withVerificationContext,
} from '@/lib/sign-in-recovery';
import AuthErrorPage from '@/app/auth/error/page';
import { resendInvitationLink } from '@/app/auth/error/actions';

const inviteRow = (over: Record<string, unknown> = {}) => ({
  email: 'carla_d_22@hotmail.com',
  expiresAt: new Date(Date.now() + 86_400_000),
  cohort: { slug: 'hhe', enabled: true },
  ...over,
});

beforeEach(() => {
  m.session = null;
  m.invitation = inviteRow();
  m.rateOk = true;
  m.signIn.mockReset();
  m.rateLimit.mockReset();
});

describe('invitationCallbackPath', () => {
  it('accepts the onboarding invitation shape, absolute or relative', () => {
    expect(invitationCallbackPath(`${ORIGIN}/onboarding?invitation=${TOKEN}`, ORIGIN)).toBe(
      `/onboarding?invitation=${TOKEN}`,
    );
    expect(invitationCallbackPath(`/onboarding?invitation=${TOKEN}`)).toBe(`/onboarding?invitation=${TOKEN}`);
  });

  it.each([
    ['another origin', `https://evil.example/onboarding?invitation=${TOKEN}`],
    ['a protocol-relative url', `//evil.example/onboarding?invitation=${TOKEN}`],
    ['another path', `/admin?invitation=${TOKEN}`],
    ['no token', '/onboarding'],
    ['a malformed token', '/onboarding?invitation=<script>'],
    ['garbage', 'http://[::1'],
  ])('rejects %s', (_label, raw) => {
    expect(invitationCallbackPath(raw, ORIGIN)).toBeNull();
    expect(invitationCallbackPath(raw)).toBeNull();
  });

  it('a signed-in visitor goes to the invitation, or bare /onboarding, never elsewhere', () => {
    expect(signedInDestination(`/onboarding?invitation=${TOKEN}`)).toBe(`/onboarding?invitation=${TOKEN}`);
    expect(signedInDestination('https://evil.example/')).toBe('/onboarding');
    expect(signedInDestination(undefined)).toBe('/onboarding');
  });

  it('masks the address', () => {
    expect(maskEmail('carla_d_22@hotmail.com')).toBe('c•••@hotmail.com');
    expect(maskEmail('nope')).toBe('•••');
  });
});

describe('withVerificationContext (the auth route wrapper)', () => {
  const callbackReq = (callbackUrl: string) =>
    new Request(
      `${ORIGIN}/api/auth/callback/resend?callbackUrl=${encodeURIComponent(callbackUrl)}&token=t&email=e%40x.com`,
    );

  it('puts the invitation back on the Verification redirect', () => {
    const res = withVerificationContext(
      callbackReq(`${ORIGIN}/onboarding?invitation=${TOKEN}`),
      Response.redirect(`${ORIGIN}/auth/error?error=Verification`, 302),
    );
    const loc = new URL(res.headers.get('location')!);
    expect(res.status).toBe(302);
    expect(loc.pathname).toBe('/auth/error');
    expect(loc.searchParams.get('error')).toBe('Verification');
    expect(loc.searchParams.get('callbackUrl')).toBe(`/onboarding?invitation=${TOKEN}`);
    expect(loc.searchParams.get('email')).toBeNull();
  });

  it('leaves every other response alone', () => {
    const ok = Response.redirect(`${ORIGIN}/onboarding?invitation=${TOKEN}`, 302);
    expect(withVerificationContext(callbackReq(`/onboarding?invitation=${TOKEN}`), ok)).toBe(ok);

    const other = Response.redirect(`${ORIGIN}/auth/error?error=Configuration`, 302);
    expect(withVerificationContext(callbackReq(`/onboarding?invitation=${TOKEN}`), other)).toBe(other);

    const notInvite = Response.redirect(`${ORIGIN}/auth/error?error=Verification`, 302);
    expect(withVerificationContext(callbackReq('/'), notInvite)).toBe(notInvite);

    const signinPath = Response.redirect(`${ORIGIN}/auth/error?error=Verification`, 302);
    const req = new Request(`${ORIGIN}/api/auth/signin?callbackUrl=${encodeURIComponent(`/onboarding?invitation=${TOKEN}`)}`);
    expect(withVerificationContext(req, signinPath)).toBe(signinPath);
  });

  it('the auth route GET runs through the wrapper', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/app/api/auth/[...nextauth]/route.ts', 'utf8');
    expect(src).toMatch(/withVerificationContext\(req, await handlers\.GET\(req\)\)/);
  });
});

describe('/auth/error?error=Verification', () => {
  const render = (searchParams: Record<string, string>) => AuthErrorPage({ searchParams });
  const text = (el: unknown) =>
    JSON.stringify(el, (k, v) => ((k === 'type' && typeof v !== 'string') || k === '_owner' ? undefined : v));

  it('already signed in: straight on to the invitation', async () => {
    m.session = { user: { id: 'u1' } };
    await expect(
      render({ error: 'Verification', callbackUrl: `/onboarding?invitation=${TOKEN}` }),
    ).rejects.toMatchObject({ url: `/onboarding?invitation=${TOKEN}` });
  });

  it('already signed in, no invitation context: bare /onboarding (profile or sign-up-link page)', async () => {
    m.session = { user: { id: 'u1' } };
    await expect(render({ error: 'Verification' })).rejects.toMatchObject({ url: '/onboarding' });
  });

  it('signed out with a live invitation: a one-click resend to the masked address', async () => {
    const out = text(await render({ error: 'Verification', callbackUrl: `/onboarding?invitation=${TOKEN}` }));
    expect(out).toContain('Send me a new link');
    expect(out).toContain('c•••@hotmail.com');
    expect(out).not.toContain('carla_d_22@hotmail.com');
    expect(out).toContain(`/onboarding?invitation=${TOKEN}`);
  });

  it('a throttled resend says so', async () => {
    const out = text(
      await render({ error: 'Verification', callbackUrl: `/onboarding?invitation=${TOKEN}`, resend: 'throttled' }),
    );
    expect(out).toContain('Several links were sent');
  });

  it('an expired cohort invitation points at the cohort sign-up page', async () => {
    m.invitation = inviteRow({ expiresAt: new Date(Date.now() - 1000) });
    const out = text(await render({ error: 'Verification', callbackUrl: `/onboarding?invitation=${TOKEN}` }));
    expect(out).not.toContain('Send me a new link');
    expect(out).toContain('/join/hhe');
  });

  it('no invitation context: the plain message and the sign-in link', async () => {
    const out = text(await render({ error: 'Verification' }));
    expect(out).toContain('This link is invalid or has expired');
    expect(out).toContain('/auth/signin');
  });

  it('other errors are unchanged and never redirect a signed-in user', async () => {
    m.session = { user: { id: 'u1' } };
    expect(text(await render({ error: 'AccessDenied' }))).toContain('You do not have permission');
  });
});

describe('resendInvitationLink', () => {
  const form = (callbackUrl: string) => {
    const fd = new FormData();
    fd.set('callbackUrl', callbackUrl);
    return fd;
  };

  it('sends a fresh link to the invitation address, back to the same invitation', async () => {
    await resendInvitationLink(form(`/onboarding?invitation=${TOKEN}`));
    expect(m.signIn).toHaveBeenCalledWith('resend', {
      email: 'carla_d_22@hotmail.com',
      redirectTo: `/onboarding?invitation=${TOKEN}`,
    });
    expect(m.rateLimit).toHaveBeenCalledWith('resend-invite', TOKEN, { limit: 5, windowSeconds: 3600 });
  });

  it('never mails an address taken from the form', async () => {
    const fd = form(`/onboarding?invitation=${TOKEN}`);
    fd.set('email', 'victim@example.com');
    await resendInvitationLink(fd);
    expect(m.signIn.mock.calls[0][1].email).toBe('carla_d_22@hotmail.com');
  });

  it('throttled: back to the error page with a message, nothing sent', async () => {
    m.rateOk = false;
    await expect(resendInvitationLink(form(`/onboarding?invitation=${TOKEN}`))).rejects.toMatchObject({
      url: expect.stringContaining('resend=throttled'),
    });
    expect(m.signIn).not.toHaveBeenCalled();
  });

  it('an expired or unknown invitation sends nothing', async () => {
    m.invitation = inviteRow({ expiresAt: new Date(Date.now() - 1000) });
    await expect(resendInvitationLink(form(`/onboarding?invitation=${TOKEN}`))).rejects.toMatchObject({
      url: expect.stringContaining('/auth/error?error=Verification'),
    });
    m.invitation = null;
    await expect(resendInvitationLink(form(`/onboarding?invitation=${TOKEN}`))).rejects.toBeTruthy();
    expect(m.signIn).not.toHaveBeenCalled();
  });

  it('a callback that is not an invitation path goes to plain sign-in', async () => {
    await expect(resendInvitationLink(form('https://evil.example/'))).rejects.toMatchObject({
      url: '/auth/signin',
    });
    expect(m.signIn).not.toHaveBeenCalled();
  });
});
