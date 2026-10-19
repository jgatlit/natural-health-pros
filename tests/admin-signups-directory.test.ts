import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * tsk_303ec99f (c): a cohort sign-up can be hidden or archived from /admin/signups, through the
 * same applyDirectoryFlag the invites page uses, and comes back to the page it was pressed on.
 */

const m = vi.hoisted(() => ({
  session: { user: { id: 'admin', role: 'ADMIN' } } as unknown,
  invitation: null as unknown,
  updates: [] as Array<{ where: unknown; data: Record<string, unknown> }>,
  sync: { ok: true, verified: true } as { ok: boolean; verified: boolean },
}));

vi.mock('@/auth', () => ({ auth: async () => m.session }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error(`REDIRECT:${url}`), { url });
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/admin-invite', () => ({ INVITATION_TTL_MS: 1, inviteOne: vi.fn(), sendInviteMagicLink: vi.fn() }));
vi.mock('@/lib/practitioner-indexer', () => ({
  indexPractitioner: vi.fn(),
  indexPractitionerVerified: vi.fn(async () => m.sync),
  RETIREMENT_SENTINEL: new Date(0),
}));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    invitation: { findUnique: async () => m.invitation },
    user: { findUnique: async () => null },
    practitioner: {
      update: async (a: { where: unknown; data: Record<string, unknown> }) => {
        m.updates.push(a);
        return {};
      },
    },
  },
}));

import { setArchived, setDelisted } from '@/app/admin/invites/actions';

const cohortSignup = {
  email: 'new@x.com',
  acceptedByUser: { practitioner: { id: 'p_new' } },
};

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

const run = (p: Promise<void>) => p.then(() => ({}) as { url?: string }, (e) => e as { url?: string });

beforeEach(() => {
  m.session = { user: { id: 'admin', role: 'ADMIN' } };
  m.invitation = cohortSignup;
  m.updates = [];
  m.sync = { ok: true, verified: true };
});

describe('/admin/signups directory controls', () => {
  it('Hide sets delistedAt on the sign-up practitioner', async () => {
    await run(setDelisted(fd({ id: 'inv_c', on: '1', returnTo: '/admin/signups' })));
    expect(m.updates).toHaveLength(1);
    expect(m.updates[0].where).toEqual({ id: 'p_new' });
    expect(m.updates[0].data.delistedAt).toBeInstanceOf(Date);
  });

  it('Archive sets archivedAt, and restore clears it', async () => {
    await run(setArchived(fd({ id: 'inv_c', on: '1', returnTo: '/admin/signups' })));
    expect(m.updates[0].data.archivedAt).toBeInstanceOf(Date);
    await run(setArchived(fd({ id: 'inv_c', on: '0', returnTo: '/admin/signups' })));
    expect(m.updates[1].data.archivedAt).toBeNull();
  });

  it('a failed search push comes back to /admin/signups with the error', async () => {
    m.sync = { ok: false, verified: false };
    const out = await run(setDelisted(fd({ id: 'inv_c', on: '1', returnTo: '/admin/signups' })));
    expect(out.url).toBe('/admin/signups?error=index-out-of-sync');
  });

  it('a sign-up with no profile yet comes back to /admin/signups and writes nothing', async () => {
    m.invitation = { email: 'new@x.com', acceptedByUser: null };
    const out = await run(setDelisted(fd({ id: 'inv_c', on: '1', returnTo: '/admin/signups' })));
    expect(out.url).toBe('/admin/signups?error=no-profile');
    expect(m.updates).toEqual([]);
  });

  it.each(['https://evil.example/x', '//evil.example', '/admin/signups/../x', ''])(
    'returnTo %j is not followed: falls back to /admin/invites',
    async (returnTo) => {
      m.sync = { ok: false, verified: false };
      const out = await run(setDelisted(fd({ id: 'inv_c', on: '1', returnTo })));
      expect(out.url).toBe('/admin/invites?error=index-out-of-sync');
    },
  );

  it('a non-admin is sent to sign-in and writes nothing', async () => {
    m.session = { user: { id: 'u', role: 'PRACTITIONER' } };
    const out = await run(setDelisted(fd({ id: 'inv_c', on: '1', returnTo: '/admin/signups' })));
    expect(out.url).toMatch(/^\/auth\/signin/);
    expect(m.updates).toEqual([]);
  });
});

describe('hheCertified defaults to false for new rows, expand-only', () => {
  const root = join(__dirname, '..');
  it('schema default is false', () => {
    const schema = readFileSync(join(root, 'prisma', 'schema.prisma'), 'utf8');
    expect(schema).toMatch(/hheCertified\s+Boolean\s+@default\(false\)/);
  });
  it('the migration only changes the default and touches no existing row', () => {
    const sql = readFileSync(
      join(root, 'prisma', 'migrations', '20261019150000_hhe_certified_default_false', 'migration.sql'),
      'utf8',
    );
    const statements = sql
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements).toEqual([`ALTER TABLE "Practitioner" ALTER COLUMN "hheCertified" SET DEFAULT false`]);
  });
});
