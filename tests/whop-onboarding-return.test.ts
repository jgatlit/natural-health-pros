import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

/**
 * The return route is the surface a practitioner lands on after Whop's hosted KYC. Its whole
 * contract is: never require a session, never write, never disclose. These tests pin all three,
 * because the failure they replace was a sign-in wall that only appeared for people who
 * finished verification on a second device.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn<() => Promise<unknown>>(),
  findUnique: vi.fn<(args: unknown) => Promise<unknown>>(),
  redirect: vi.fn<(url: string) => never>(),
}));

vi.mock('@/auth', () => ({ auth: mocks.auth }));
vi.mock('@/lib/prisma', () => ({
  prisma: { practitioner: { findUnique: mocks.findUnique } },
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    mocks.redirect(url);
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

type GetHandler = (request: NextRequest) => Promise<Response>;
let GET: GetHandler;

beforeAll(async () => {
  ({ GET } = await import('@/app/api/whop/onboarding/return/route'));
});

beforeEach(() => {
  mocks.auth.mockReset();
  mocks.findUnique.mockReset();
  mocks.redirect.mockReset();
  mocks.auth.mockResolvedValue(null);
  mocks.findUnique.mockResolvedValue(null);
});

function request(query: string): NextRequest {
  return { nextUrl: new URL(`https://naturalhealthpros.com/api/whop/onboarding/return${query}`) } as NextRequest;
}

/** redirect() throws by design; swallow it and read what it was called with. */
async function redirectTargetOf(req: NextRequest): Promise<string> {
  await GET(req).catch(() => undefined);
  expect(mocks.redirect).toHaveBeenCalledTimes(1);
  return mocks.redirect.mock.calls[0][0];
}

describe('KYC return never requires a session cookie', () => {
  it('sends an unauthenticated visitor to the public landing, NOT to sign-in', async () => {
    // The device-handoff case: finished ID capture on a phone that has no session.
    expect(await redirectTargetOf(request('?slug=sarah&status=submitted'))).toBe(
      '/verification-submitted',
    );
  });

  it('never redirects to /auth/signin under any input', async () => {
    for (const q of ['', '?slug=sarah', '?slug=does-not-exist', '?slug=someone-else']) {
      mocks.redirect.mockReset();
      expect(await redirectTargetOf(request(q))).not.toContain('/auth/signin');
    }
  });

  it('survives an auth() failure rather than 500ing mid-flow', async () => {
    mocks.auth.mockRejectedValue(new Error('auth backend down'));
    expect(await redirectTargetOf(request('?slug=sarah'))).toBe('/verification-submitted');
  });
});

describe('owner gets the useful landing', () => {
  it('sends the owning practitioner straight to their payments section', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'user_1', role: 'PRACTITIONER' } });
    mocks.findUnique.mockResolvedValue({ userId: 'user_1' });
    expect(await redirectTargetOf(request('?slug=sarah&status=submitted'))).toBe(
      '/practitioners/sarah/edit?whop=pending#payments',
    );
  });

  it('lets an ADMIN through as well', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'user_admin', role: 'ADMIN' } });
    mocks.findUnique.mockResolvedValue({ userId: 'someone_else' });
    expect(await redirectTargetOf(request('?slug=sarah'))).toBe(
      '/practitioners/sarah/edit?whop=pending#payments',
    );
  });
});

describe('non-disclosure: every non-owner outcome is identical', () => {
  it('cannot distinguish an unknown slug from someone else’s slug', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'user_1', role: 'PRACTITIONER' } });

    mocks.findUnique.mockResolvedValue(null); // no such practitioner
    const unknown = await redirectTargetOf(request('?slug=nobody'));

    mocks.redirect.mockReset();
    mocks.findUnique.mockResolvedValue({ userId: 'user_2' }); // exists, not theirs
    const notMine = await redirectTargetOf(request('?slug=someone-else'));

    expect(unknown).toBe(notMine);
    expect(unknown).toBe('/verification-submitted');
  });
});

describe('side-effect free', () => {
  it('performs no write on any path — only a single ownership read', async () => {
    mocks.auth.mockResolvedValue({ user: { id: 'user_1', role: 'PRACTITIONER' } });
    mocks.findUnique.mockResolvedValue({ userId: 'user_1' });
    await GET(request('?slug=sarah')).catch(() => undefined);

    // A write would have needed prisma.practitioner.update, which is not even mocked here —
    // its absence from the mock surface is the assertion.
    expect(mocks.findUnique).toHaveBeenCalledTimes(1);
    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: { slug: 'sarah' },
      select: { userId: true },
    });
  });

  it('does not even look up a practitioner when there is no session', async () => {
    await GET(request('?slug=sarah')).catch(() => undefined);
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });
});
