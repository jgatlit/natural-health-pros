import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * Public request-to-join (/join) and its admin review (/admin/requests).
 *
 * The public form stores a JoinRequest and nothing else. Approval goes through the same invite
 * core as /admin/invites, claims the row before sending so a double-click sends once, and puts it
 * back to PENDING if the send fails. The real actions run here against a mocked Prisma.
 */

const SECRET = 'test-auth-secret';

type Row = {
  id: string;
  name: string;
  email: string;
  credential: string;
  website: string | null;
  note: string | null;
  status: 'PENDING' | 'APPROVED' | 'DECLINED';
  reviewedAt: Date | null;
  reviewedById: string | null;
  invitationId: string | null;
};

const m = vi.hoisted(() => ({
  rate: new Map<string, boolean>(),
  rateCalls: [] as string[],
  session: null as null | { user: { id: string; role: string; email?: string } },
  signIn: vi.fn(),
  sendEmail: vi.fn(),
  rows: [] as Row[],
  users: new Map<string, { practitioner: { id: string } | null }>(),
  pendingInvitation: null as null | { id: string; token: string },
  invitationCreate: vi.fn(),
  invitationDelete: vi.fn(),
  userCreate: vi.fn(),
  practitionerCreate: vi.fn(),
  joinRequestCreate: vi.fn(),
}));

vi.mock('@/lib/rate-limit', () => ({
  rateLimit: async (prefix: string) => {
    m.rateCalls.push(prefix);
    return { success: m.rate.get(prefix) ?? true, remaining: 0, reset: 0 };
  },
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error(`REDIRECT:${url}`), { url });
  },
}));
vi.mock('next/headers', () => ({
  headers: () => ({ get: (k: string) => (k.toLowerCase() === 'x-forwarded-for' ? '203.0.113.9' : null) }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/auth', () => ({ auth: async () => m.session, signIn: m.signIn }));
vi.mock('@/lib/email', async (orig) => ({
  ...(await orig<typeof import('@/lib/email')>()),
  sendEmail: m.sendEmail,
}));

function matches(row: Row, where: Record<string, unknown>) {
  return Object.entries(where).every(([k, v]) => (row as Record<string, unknown>)[k] === v);
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    joinRequest: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        m.rows.find((r) => matches(r, where)) ?? null,
      findUnique: async ({ where }: { where: { id: string } }) =>
        m.rows.find((r) => r.id === where.id) ?? null,
      create: async ({ data }: { data: Omit<Row, 'id' | 'status' | 'reviewedAt' | 'reviewedById' | 'invitationId'> }) => {
        m.joinRequestCreate(data);
        const row: Row = {
          id: `jr${m.rows.length + 1}`,
          status: 'PENDING',
          reviewedAt: null,
          reviewedById: null,
          invitationId: null,
          ...data,
        };
        m.rows.push(row);
        return { id: row.id };
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
        const hit = m.rows.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const r = m.rows.find((x) => x.id === where.id)!;
        Object.assign(r, data);
        return r;
      },
    },
    user: {
      findUnique: async ({ where }: { where: { email: string } }) => m.users.get(where.email) ?? null,
      create: m.userCreate,
    },
    practitioner: { create: m.practitionerCreate },
    invitation: {
      findFirst: async () => m.pendingInvitation,
      create: async (args: { data: { email: string } }) => {
        m.invitationCreate(args);
        return { id: 'inv_new' };
      },
      delete: async (args: unknown) => m.invitationDelete(args),
    },
  },
}));

import { BOT_GUARD_FIELDS, issueFormStamp } from '@/lib/bot-guard';
import { requestToJoin } from '@/app/join/actions';
import { approveJoinRequest, declineJoinRequest } from '@/app/admin/requests/actions';
import { SignUpLinkNeeded } from '@/components/practitioners/SignUpLinkNeeded';
import JoinRequestPage from '@/app/join/page';
import { parseJoinRequest, JOIN_REQUEST_LIMITS, safeHttpUrl } from '@/lib/join-request';

function joinForm(over: Record<string, string> = {}, ageMs = 10_000) {
  const fd = new FormData();
  fd.set('name', '  Jane Doe ');
  fd.set('email', ' Jane@Example.com ');
  fd.set('credential', 'Holistic Health Educator');
  fd.set('website', '');
  fd.set('note', '');
  fd.set(BOT_GUARD_FIELDS.honeypot, '');
  fd.set(BOT_GUARD_FIELDS.stamp, issueFormStamp(Date.now() - ageMs, SECRET));
  for (const [k, v] of Object.entries(over)) fd.set(k, v);
  return fd;
}

function idForm(id: string, extra: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set('id', id);
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return fd;
}

const redirectOf = (p: Promise<unknown>) => p.then(() => null, (e: { url?: string }) => e.url ?? String(e));

function pendingRow(over: Partial<Row> = {}): Row {
  const row: Row = {
    id: 'jr1',
    name: 'Jane <b>Doe</b>',
    email: 'jane@example.com',
    credential: 'HHE',
    website: null,
    note: null,
    status: 'PENDING',
    reviewedAt: null,
    reviewedById: null,
    invitationId: null,
    ...over,
  };
  m.rows.push(row);
  return row;
}

const ADMIN = { user: { id: 'admin1', role: 'ADMIN', email: 'ops@x.com' } };

beforeEach(() => {
  vi.stubEnv('AUTH_SECRET', SECRET);
  vi.stubEnv('TURNSTILE_SITE_KEY', '');
  vi.stubEnv('TURNSTILE_SECRET_KEY', '');
  vi.stubEnv('ADMIN_EMAILS', 'ops@x.com, Amy@X.com');
  m.rate.clear();
  m.rateCalls.length = 0;
  m.session = ADMIN;
  m.rows = [];
  m.users = new Map();
  m.pendingInvitation = null;
  m.signIn.mockReset().mockResolvedValue('https://naturalhealthpros.com/auth/verify-request');
  m.sendEmail.mockReset().mockResolvedValue({ id: 'em1' });
  for (const f of [m.invitationCreate, m.invitationDelete, m.userCreate, m.practitionerCreate, m.joinRequestCreate]) {
    f.mockReset();
  }
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('/join: request to join', () => {
  it('stores one JoinRequest (trimmed, normalised) and nothing else; emails every admin', async () => {
    expect(await redirectOf(requestToJoin(joinForm({ website: 'https://jane.example' })))).toBe('/join?sent=1');

    expect(m.joinRequestCreate).toHaveBeenCalledTimes(1);
    expect(m.joinRequestCreate).toHaveBeenCalledWith({
      name: 'Jane Doe',
      email: 'jane@example.com',
      credential: 'Holistic Health Educator',
      website: 'https://jane.example',
      note: null,
    });
    expect(m.userCreate).not.toHaveBeenCalled();
    expect(m.practitionerCreate).not.toHaveBeenCalled();
    expect(m.invitationCreate).not.toHaveBeenCalled();
    expect(m.signIn).not.toHaveBeenCalled();

    expect(m.sendEmail.mock.calls.map(([e]) => e.to)).toEqual(['ops@x.com', 'amy@x.com']);
    const mail = m.sendEmail.mock.calls[0][0];
    expect(mail.html).toContain('https://naturalhealthpros.com/admin/requests');
    expect(mail.idempotencyKey).toBe('join-request/jr1/ops@x.com');
    expect(m.rateCalls).toEqual(['join-request-ip', 'join-request-ip-1d', 'join-request-email']);
  });

  it('escapes everything the requester typed in the admin email', async () => {
    await requestToJoin(joinForm({ name: '<img src=x onerror=alert(1)>', note: '<script>x</script>' })).catch(() => null);
    const html: string = m.sendEmail.mock.calls[0][0].html;
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('a failed admin email does not lose the request', async () => {
    m.sendEmail.mockRejectedValue(new Error('Resend down'));
    expect(await redirectOf(requestToJoin(joinForm()))).toBe('/join?sent=1');
    expect(m.rows).toHaveLength(1);
  });

  it('a second request from an email with one PENDING creates no row and looks identical', async () => {
    pendingRow({ email: 'jane@example.com' });
    expect(await redirectOf(requestToJoin(joinForm()))).toBe('/join?sent=1');
    expect(m.joinRequestCreate).not.toHaveBeenCalled();
    expect(m.sendEmail).not.toHaveBeenCalled();
  });

  it('an email that already belongs to a practitioner gets the same reply (nothing revealed)', async () => {
    m.users.set('jane@example.com', { practitioner: { id: 'p1' } });
    expect(await redirectOf(requestToJoin(joinForm()))).toBe('/join?sent=1');
  });

  it.each([
    ['honeypot', { [BOT_GUARD_FIELDS.honeypot]: 'x' }, 10_000, '/join?sent=1'],
    ['dotted Gmail', { email: 'f.ix.u.ha.fu68.9@gmail.com' }, 10_000, '/join?sent=1'],
    ['too fast', {}, 200, '/join?error=retry'],
  ])('%s: creates nothing, sends nothing', async (_l, over, age, url) => {
    expect(await redirectOf(requestToJoin(joinForm(over as Record<string, string>, age)))).toBe(url);
    expect(m.joinRequestCreate).not.toHaveBeenCalled();
    expect(m.sendEmail).not.toHaveBeenCalled();
  });

  it('throttled: creates nothing', async () => {
    m.rate.set('join-request-email', false);
    expect(await redirectOf(requestToJoin(joinForm()))).toBe('/join?error=throttled');
    expect(m.joinRequestCreate).not.toHaveBeenCalled();
  });

  it('missing or over-long fields are refused', async () => {
    expect(await redirectOf(requestToJoin(joinForm({ credential: '   ' })))).toBe('/join?error=invalid');
    expect(await redirectOf(requestToJoin(joinForm({ note: 'x'.repeat(JOIN_REQUEST_LIMITS.note + 1) })))).toBe(
      '/join?error=invalid',
    );
    expect(m.joinRequestCreate).not.toHaveBeenCalled();
  });

  it('parseJoinRequest keeps optional fields null when blank', () => {
    const fd = new FormData();
    fd.set('name', 'A');
    fd.set('email', 'a@b.co');
    fd.set('credential', 'C');
    expect(parseJoinRequest(fd)).toEqual({ name: 'A', email: 'a@b.co', credential: 'C', website: null, note: null });
  });

  it('only http(s) websites become links', () => {
    expect(safeHttpUrl('https://a.example/x')).toBe('https://a.example/x');
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('@janedoe')).toBeNull();
  });

  it('the page renders the bot-guard fields and the confirmation', () => {
    const form = renderToStaticMarkup(JoinRequestPage({ searchParams: {} }));
    expect(form).toContain(`name="${BOT_GUARD_FIELDS.honeypot}"`);
    expect(form).toContain(`name="${BOT_GUARD_FIELDS.stamp}"`);
    expect(form).toContain('name="credential"');
    const sent = renderToStaticMarkup(JoinRequestPage({ searchParams: { sent: '1' } }));
    expect(sent).toContain('email you once it is approved');
    expect(sent).not.toContain('<form');
  });
});

describe('/admin/requests: approve', () => {
  it('invites the request email through the shared core and records invitation, status, reviewer', async () => {
    const row = pendingRow();
    expect(await redirectOf(approveJoinRequest(idForm('jr1')))).toBe('/admin/requests?done=approved');

    expect(m.invitationCreate).toHaveBeenCalledTimes(1);
    expect(m.invitationCreate.mock.calls[0][0].data).toMatchObject({ email: 'jane@example.com', invitedById: 'admin1' });
    expect(m.signIn).toHaveBeenCalledTimes(1);
    expect(m.signIn.mock.calls[0][1]).toMatchObject({ email: 'jane@example.com', redirect: false });
    expect(row).toMatchObject({ status: 'APPROVED', invitationId: 'inv_new', reviewedById: 'admin1' });
    expect(row.reviewedAt).toBeInstanceOf(Date);
    expect(m.userCreate).not.toHaveBeenCalled();
    expect(m.practitionerCreate).not.toHaveBeenCalled();
  });

  it('reuses an existing pending admin invitation and records its id', async () => {
    const row = pendingRow();
    m.pendingInvitation = { id: 'inv_old', token: 'tok_old' };
    await redirectOf(approveJoinRequest(idForm('jr1')));
    expect(m.invitationCreate).not.toHaveBeenCalled();
    expect(row.invitationId).toBe('inv_old');
  });

  it('a double-click sends one invitation', async () => {
    pendingRow();
    await Promise.all([redirectOf(approveJoinRequest(idForm('jr1'))), redirectOf(approveJoinRequest(idForm('jr1')))]);
    expect(m.signIn).toHaveBeenCalledTimes(1);
  });

  it.each(['APPROVED', 'DECLINED'] as const)('a %s row is left alone', async (status) => {
    const row = pendingRow({ status, reviewedById: 'someone' });
    expect(await redirectOf(approveJoinRequest(idForm('jr1')))).toBe('/admin/requests?error=not-pending');
    expect(m.signIn).not.toHaveBeenCalled();
    expect(m.invitationCreate).not.toHaveBeenCalled();
    expect(row).toMatchObject({ status, reviewedById: 'someone' });
  });

  it('a failed send leaves the request PENDING and shows an error', async () => {
    const row = pendingRow();
    m.signIn.mockResolvedValue('https://naturalhealthpros.com/api/auth/error?error=Configuration');
    expect(await redirectOf(approveJoinRequest(idForm('jr1')))).toBe('/admin/requests?error=send-failed');
    expect(row).toMatchObject({ status: 'PENDING', reviewedAt: null, reviewedById: null, invitationId: null });
    expect(m.invitationDelete).toHaveBeenCalledWith({ where: { id: 'inv_new' } });
  });

  it('is refused when the email already has a practitioner profile', async () => {
    const row = pendingRow();
    m.users.set('jane@example.com', { practitioner: { id: 'p1' } });
    expect(await redirectOf(approveJoinRequest(idForm('jr1')))).toBe('/admin/requests?error=has-profile');
    expect(m.signIn).not.toHaveBeenCalled();
    expect(row.status).toBe('PENDING');
  });
});

describe('/admin/requests: decline', () => {
  it('sets DECLINED with the reviewer, sends no invitation and no email by default', async () => {
    const row = pendingRow();
    expect(await redirectOf(declineJoinRequest(idForm('jr1')))).toBe('/admin/requests?done=declined');
    expect(row).toMatchObject({ status: 'DECLINED', reviewedById: 'admin1', invitationId: null });
    expect(m.signIn).not.toHaveBeenCalled();
    expect(m.invitationCreate).not.toHaveBeenCalled();
    expect(m.sendEmail).not.toHaveBeenCalled();
  });

  it('emails the requester only when ticked, with their name escaped', async () => {
    pendingRow();
    await redirectOf(declineJoinRequest(idForm('jr1', { notify: 'on' })));
    expect(m.sendEmail).toHaveBeenCalledTimes(1);
    const mail = m.sendEmail.mock.calls[0][0];
    expect(mail.to).toBe('jane@example.com');
    expect(mail.idempotencyKey).toBe('join-request-declined/jr1');
    expect(mail.html).toContain('Jane &lt;b&gt;Doe&lt;/b&gt;');
    expect(mail.html).not.toContain('<b>');
    expect(m.signIn).not.toHaveBeenCalled();
  });

  it('a non-PENDING row is left alone and gets no email', async () => {
    const row = pendingRow({ status: 'APPROVED' });
    expect(await redirectOf(declineJoinRequest(idForm('jr1', { notify: 'on' })))).toBe(
      '/admin/requests?error=not-pending',
    );
    expect(row.status).toBe('APPROVED');
    expect(m.sendEmail).not.toHaveBeenCalled();
  });
});

describe('non-admin callers are refused', () => {
  it.each([
    ['signed out', null],
    ['practitioner', { user: { id: 'u1', role: 'PRACTITIONER' } }],
  ])('%s', async (_l, session) => {
    m.session = session;
    const row = pendingRow();
    for (const action of [approveJoinRequest, declineJoinRequest]) {
      expect(await redirectOf(action(idForm('jr1', { notify: 'on' })))).toBe(
        '/auth/signin?callbackUrl=/admin/requests',
      );
    }
    expect(row).toMatchObject({ status: 'PENDING', reviewedById: null });
    expect(m.signIn).not.toHaveBeenCalled();
    expect(m.sendEmail).not.toHaveBeenCalled();
  });
});

describe('sign-up page and homepage point to /join', () => {
  it.each([false, true])('SignUpLinkNeeded (expired=%s) links to /join and never to a cohort', (expired) => {
    const html = renderToStaticMarkup(SignUpLinkNeeded({ expired }));
    expect(html).toContain('href="/join"');
    expect(html).not.toMatch(/\/join\/[a-z0-9]/i);
    expect(html).toContain('If your program gave you a sign-up link, use that.');
  });

  const src = (...p: string[]) => readFileSync(join(__dirname, '..', 'src', ...p), 'utf8');

  it('/onboarding no longer looks up a cohort link', () => {
    expect(src('app', 'onboarding', 'page.tsx')).not.toMatch(/enabledJoinPath|signupCohort/);
  });

  it('the homepage "Get listed" CTA goes to /join', () => {
    const page = src('app', 'page.tsx');
    expect(page).toContain('href={`${SITE_URL}/join`}');
    expect(page).not.toContain('href={`${SITE_URL}/onboarding`}');
  });

  it('the invite core is not exported from a "use server" file', () => {
    const actions = src('app', 'admin', 'invites', 'actions.ts');
    expect(actions).not.toMatch(/export\s+(async\s+)?function\s+(invite|inviteOne|sendInviteMagicLink)\b/);
    expect(src('lib', 'admin-invite.ts')).not.toMatch(/^\s*['"]use server['"]/);
  });
});
