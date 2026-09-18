import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  attributionExpiry,
  attributionWindowDays,
  hashClientEmail,
  hasLiveAttribution,
  isFirstSession,
  recordAttributedClient,
} from '@/lib/attributed-clients';

type Row = {
  practitionerId: string;
  emailHash: string;
  expiresAt: Date;
  attributedAt: Date;
  party: string | null;
  source: string | null;
  firstBookingIntentId: string | null;
};

/** Minimal in-memory stand-in for the one Prisma delegate this module touches. */
function fakeDb() {
  const rows = new Map<string, Row>();
  const key = (p: string, h: string) => `${p}|${h}`;
  return {
    rows,
    attributedClient: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async upsert(args: any) {
        const { practitionerId, emailHash } = args.where.practitionerId_emailHash;
        const k = key(practitionerId, emailHash);
        const existing = rows.get(k);
        if (existing) rows.set(k, { ...existing, ...args.update });
        else rows.set(k, { ...args.create });
        return rows.get(k);
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async findUnique(args: any) {
        const { practitionerId, emailHash } = args.where.practitionerId_emailHash;
        return rows.get(key(practitionerId, emailHash)) ?? null;
      },
    },
  };
}

describe('attributed-clients', () => {
  let saved: Record<string, string | undefined>;
  const ENV = ['ATTRIBUTION_CLAIM_WINDOW_DAYS', 'ATTRIBUTION_EMAIL_SALT'];

  beforeEach(() => {
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    for (const k of ENV) delete process.env[k];
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('defaults the claim window to one year', () => {
    expect(attributionWindowDays()).toBe(365);
    process.env.ATTRIBUTION_CLAIM_WINDOW_DAYS = '180';
    expect(attributionWindowDays()).toBe(180);
  });

  it('rejects a nonsense window rather than silently charging the wrong split', () => {
    process.env.ATTRIBUTION_CLAIM_WINDOW_DAYS = '0';
    expect(() => attributionWindowDays()).toThrow(/positive integer/);
  });

  it('normalises case and whitespace, so one person is one client', () => {
    expect(hashClientEmail('  Sarah@Example.COM ')).toBe(hashClientEmail('sarah@example.com'));
  });

  it('does NOT merge gmail dot/plus variants — different addresses stay different', () => {
    expect(hashClientEmail('a.b@gmail.com')).not.toBe(hashClientEmail('ab@gmail.com'));
    expect(hashClientEmail('a+x@gmail.com')).not.toBe(hashClientEmail('a@gmail.com'));
  });

  it('never stores the address itself', () => {
    const h = hashClientEmail('sarah@example.com');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain('sarah');
  });

  it('salts the hash so it is useless outside our database', () => {
    const bare = hashClientEmail('sarah@example.com');
    process.env.ATTRIBUTION_EMAIL_SALT = 'pepper';
    expect(hashClientEmail('sarah@example.com')).not.toBe(bare);
  });

  it('expires a claim one year out', () => {
    const at = new Date('2026-09-17T00:00:00Z');
    expect(attributionExpiry(at).toISOString()).toBe('2027-09-17T00:00:00.000Z');
  });

  it('treats an unseen client as a first session', async () => {
    const db = fakeDb();
    await expect(isFirstSession(db, { practitionerId: 'p1', email: 'c@x.com' })).resolves.toBe(true);
  });

  it('treats a client we already introduced as a repeat', async () => {
    const db = fakeDb();
    await recordAttributedClient(db, { practitionerId: 'p1', email: 'c@x.com', party: 'NHP' });
    await expect(isFirstSession(db, { practitionerId: 'p1', email: 'c@x.com' })).resolves.toBe(
      false,
    );
  });

  it('scopes a claim to one practitioner — the same client is new to everyone else', async () => {
    const db = fakeDb();
    await recordAttributedClient(db, { practitionerId: 'p1', email: 'c@x.com' });
    await expect(isFirstSession(db, { practitionerId: 'p2', email: 'c@x.com' })).resolves.toBe(true);
  });

  it('lets a claim lapse after the window', async () => {
    const db = fakeDb();
    const at = new Date('2026-01-01T00:00:00Z');
    await recordAttributedClient(db, { practitionerId: 'p1', email: 'c@x.com', at });
    const inside = new Date('2026-06-01T00:00:00Z');
    const outside = new Date('2027-06-01T00:00:00Z');
    await expect(
      hasLiveAttribution(db, { practitionerId: 'p1', email: 'c@x.com', now: inside }),
    ).resolves.toBe(true);
    await expect(
      hasLiveAttribution(db, { practitionerId: 'p1', email: 'c@x.com', now: outside }),
    ).resolves.toBe(false);
  });

  it('extends the window on a repeat booking without moving the introduction date', async () => {
    const db = fakeDb();
    const first = new Date('2026-01-01T00:00:00Z');
    const later = new Date('2026-06-01T00:00:00Z');
    await recordAttributedClient(db, {
      practitionerId: 'p1',
      email: 'c@x.com',
      at: first,
      bookingIntentId: 'bi_1',
    });
    await recordAttributedClient(db, {
      practitionerId: 'p1',
      email: 'c@x.com',
      at: later,
      bookingIntentId: 'bi_2',
    });
    expect(db.rows.size).toBe(1);
    const row = Array.from(db.rows.values())[0];
    expect(row.attributedAt).toEqual(first);
    expect(row.firstBookingIntentId).toBe('bi_1');
    expect(row.expiresAt).toEqual(attributionExpiry(later));
  });
});
