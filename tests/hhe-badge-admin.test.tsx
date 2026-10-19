import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * tsk_1fb8683b: an admin grants or removes the 'HHE Certified' badge from /admin/signups and
 * /admin/invites. The change records who and when, and reindexes the practitioner.
 */

const m = vi.hoisted(() => ({
  session: { user: { id: 'admin_1', role: 'ADMIN' } } as unknown,
  invitation: null as unknown,
  updates: [] as Array<{ where: unknown; data: Record<string, unknown> }>,
  reindexed: [] as string[],
  revalidated: [] as string[],
  sync: { ok: true, verified: true } as { ok: boolean; verified: boolean },
}));

vi.mock('@/auth', () => ({ auth: async () => m.session }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error(`REDIRECT:${url}`), { url });
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => m.revalidated.push(p) }));
vi.mock('@/lib/admin-invite', () => ({ INVITATION_TTL_MS: 1, inviteOne: vi.fn(), sendInviteMagicLink: vi.fn() }));
vi.mock('@/lib/practitioner-indexer', () => ({
  indexPractitioner: vi.fn(),
  indexPractitionerVerified: async (id: string) => {
    m.reindexed.push(id);
    return m.sync;
  },
  RETIREMENT_SENTINEL: new Date(0),
}));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    invitation: { findUnique: async () => m.invitation },
    user: { findUnique: async () => null },
    practitioner: {
      update: async (a: { where: unknown; data: Record<string, unknown> }) => {
        m.updates.push(a);
        return { slug: 'jane-doe' };
      },
    },
  },
}));

import { setHheCertified } from '@/app/admin/invites/actions';
import { HheBadgeControl } from '@/app/admin/invites/HheBadgeControl';

function fd(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

const run = (p: Promise<void>) => p.then(() => ({}) as { url?: string }, (e) => e as { url?: string });

beforeEach(() => {
  m.session = { user: { id: 'admin_1', role: 'ADMIN' } };
  m.invitation = { email: 'jane@x.com', acceptedByUser: { practitioner: { id: 'p_1' } } };
  m.updates = [];
  m.reindexed = [];
  m.revalidated = [];
  m.sync = { ok: true, verified: true };
});

describe('setHheCertified', () => {
  it('grants the badge and records who and when', async () => {
    const before = Date.now();
    await run(setHheCertified(fd({ id: 'inv_1', on: '1', returnTo: '/admin/signups' })));
    expect(m.updates).toHaveLength(1);
    expect(m.updates[0].where).toEqual({ id: 'p_1' });
    const data = m.updates[0].data;
    expect(data.hheCertified).toBe(true);
    expect(data.hheCertifiedChangedById).toBe('admin_1');
    expect(data.hheCertifiedChangedAt).toBeInstanceOf(Date);
    expect((data.hheCertifiedChangedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('removes the badge and records who and when', async () => {
    await run(setHheCertified(fd({ id: 'inv_1', on: '0', returnTo: '/admin/invites' })));
    const data = m.updates[0].data;
    expect(data.hheCertified).toBe(false);
    expect(data.hheCertifiedChangedById).toBe('admin_1');
    expect(data.hheCertifiedChangedAt).toBeInstanceOf(Date);
  });

  it('writes only the badge and its audit columns', async () => {
    await run(setHheCertified(fd({ id: 'inv_1', on: '1' })));
    expect(Object.keys(m.updates[0].data).sort()).toEqual([
      'hheCertified',
      'hheCertifiedChangedAt',
      'hheCertifiedChangedById',
    ]);
  });

  it('reindexes the practitioner and revalidates the public profile', async () => {
    await run(setHheCertified(fd({ id: 'inv_1', on: '1', returnTo: '/admin/signups' })));
    expect(m.reindexed).toEqual(['p_1']);
    expect(m.revalidated).toContain('/practitioners/jane-doe');
    expect(m.revalidated).toContain('/admin/signups');
    expect(m.revalidated).toContain('/admin/invites');
  });

  it('resolves a seeded pilot with no accepted invitation by email', async () => {
    m.invitation = { email: 'pilot@x.com', acceptedByUser: null };
    // user.findUnique is mocked to null at module level; this pins the no-profile branch.
    const out = await run(setHheCertified(fd({ id: 'inv_1', on: '1', returnTo: '/admin/invites' })));
    expect(out.url).toBe('/admin/invites?error=no-profile');
    expect(m.updates).toEqual([]);
    expect(m.reindexed).toEqual([]);
  });

  it('a failed search push returns to the page it was pressed on with the error', async () => {
    m.sync = { ok: false, verified: false };
    const out = await run(setHheCertified(fd({ id: 'inv_1', on: '1', returnTo: '/admin/signups' })));
    expect(out.url).toBe('/admin/signups?error=index-out-of-sync');
  });

  it('an unallowlisted returnTo falls back to /admin/invites', async () => {
    m.sync = { ok: false, verified: false };
    const out = await run(setHheCertified(fd({ id: 'inv_1', on: '1', returnTo: 'https://evil.example' })));
    expect(out.url).toBe('/admin/invites?error=index-out-of-sync');
  });

  it.each([
    ['a practitioner', { user: { id: 'u', role: 'PRACTITIONER' } }],
    ['a signed-out visitor', null],
  ])('%s is sent to sign-in, writes nothing and reindexes nothing', async (_who, session) => {
    m.session = session;
    const out = await run(setHheCertified(fd({ id: 'inv_1', on: '1', returnTo: '/admin/signups' })));
    expect(out.url).toMatch(/^\/auth\/signin/);
    expect(m.updates).toEqual([]);
    expect(m.reindexed).toEqual([]);
  });
});

describe('HheBadgeControl', () => {
  it('an uncertified practitioner shows the state and a Mark button that grants', () => {
    const html = renderToStaticMarkup(
      <HheBadgeControl invitationId="inv_1" displayName="Jane" certified={false} changedAt={null} returnTo="/admin/signups" />,
    );
    expect(html).toContain('Not HHE Certified');
    expect(html).toContain('Mark HHE Certified');
    expect(html).toMatch(/name="on" value="1"/);
    expect(html).toMatch(/name="returnTo" value="\/admin\/signups"/);
  });

  it('a certified practitioner shows the state and a Remove button that removes', () => {
    const html = renderToStaticMarkup(
      <HheBadgeControl
        invitationId="inv_1"
        displayName="Jane"
        certified
        changedAt={new Date('2026-10-19T12:00:00Z')}
        returnTo="/admin/invites"
      />,
    );
    expect(html).toContain('>HHE Certified<');
    expect(html).toContain('Remove HHE Certified');
    expect(html).toMatch(/name="on" value="0"/);
    expect(html).toContain('2026-10-19');
  });
});

describe('both admin screens render the control', () => {
  const root = join(__dirname, '..');
  it.each([
    ['src/app/admin/signups/page.tsx', '/admin/signups'],
    ['src/app/admin/invites/page.tsx', '/admin/invites'],
  ])('%s renders HheBadgeControl and selects the badge state', (file, returnTo) => {
    const src = readFileSync(join(root, file), 'utf8');
    expect(src).toMatch(new RegExp(`<HheBadgeControl[\\s\\S]*?returnTo="${returnTo}"`));
    expect(src).toMatch(/hheCertified: true/);
    expect(src).toMatch(/hheCertifiedChangedAt: true/);
  });
});

describe('the audit migration is expand-only', () => {
  it('adds two nullable columns and a foreign key, and touches no row', () => {
    const sql = readFileSync(
      join(__dirname, '..', 'prisma', 'migrations', '20261019180000_hhe_certified_audit', 'migration.sql'),
      'utf8',
    );
    const body = sql
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n')
      // Foreign-key referential actions, not statements.
      .replace(/ON (DELETE|UPDATE) (SET NULL|CASCADE)/g, '');
    expect(body).not.toMatch(/\b(UPDATE|DELETE|DROP|INSERT)\b/i);
    expect(body).not.toMatch(/NOT NULL/i);
    expect(body).toMatch(/ADD COLUMN\s+"hheCertifiedChangedAt" TIMESTAMP\(3\)/);
    expect(body).toMatch(/ADD COLUMN\s+"hheCertifiedChangedById" TEXT/);
  });
});
