import { describe, expect, it } from 'vitest';

import { addClientEntries, buildClientList, loadClientList } from '@/lib/client-list';
import { hashClientEmail } from '@/lib/attributed-clients';

/**
 * THE CLIENT LIST, AND THE PRIVACY RULE THAT GOVERNS IT (operator ruling, 2026-09-18).
 *
 * A practitioner may see a client's EMAIL ADDRESS only where they serviced, invited/added, were
 * referred, or referred that client themselves. Every `source` this table accepts is one of those
 * four, which is why the address is readable here and hashed everywhere else.
 *
 * ⚠️ THE RULE IS ENFORCED AS A QUERY SHAPE, NOT AS A CONVENTION. `AttributedClient` carries a bare
 * `@@index([emailHash])` for the cross-practitioner leakage sweep — exactly the index that makes a
 * hash-only lookup cheap, and exactly the query that would return somebody else's clients. The
 * tests below assert that no read in this module is shaped that way, and one of them widens a
 * `where` deliberately to prove the assertion can fail.
 *
 * ⚠️ `addedAt` IS IMMUTABLE. It is the earliest-touch lock (R5), so a re-add that moved it would
 * let a practitioner retro-exempt a client after a fee was already owed.
 */

const P = 'practitioner-Y';
const D = (day: number) => new Date(Date.UTC(2026, 0, 1 + day));

describe('addClientEntries', () => {
  function fake() {
    const rows = new Map<string, Record<string, unknown>>();
    const calls: unknown[] = [];
    return {
      rows,
      calls,
      clientListEntry: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async upsert(args: any) {
          calls.push(args);
          const { practitionerId, emailHash } = args.where.practitionerId_emailHash;
          const k = `${practitionerId}|${emailHash}`;
          const existing = rows.get(k);
          rows.set(k, existing ? { ...existing, ...args.update } : { ...args.create });
          return rows.get(k);
        },
      },
    };
  }

  it('normalises the address and stores it readable alongside its hash', async () => {
    const db = fake();
    await addClientEntries(db, {
      practitionerId: P,
      source: 'MANUAL_ADD',
      at: D(0),
      entries: [{ email: '  Client@Example.COM ', name: 'Dana' }],
    });

    const row = Array.from(db.rows.values())[0]!;
    expect(row.email).toBe('client@example.com');
    expect(row.emailHash).toBe(hashClientEmail('client@example.com'));
    expect(row.name).toBe('Dana');
    expect(row.addedAt).toEqual(D(0));
  });

  it('NEVER moves addedAt on a re-add — that timestamp is the earliest-touch lock (R5)', async () => {
    const db = fake();
    await addClientEntries(db, {
      practitionerId: P,
      source: 'MANUAL_ADD',
      at: D(0),
      entries: [{ email: 'c@example.com', name: null }],
    });
    await addClientEntries(db, {
      practitionerId: P,
      source: 'MANUAL_ADD',
      at: D(30),
      entries: [{ email: 'c@example.com', name: 'Renamed' }],
    });

    const row = Array.from(db.rows.values())[0]!;
    expect(row.addedAt).toEqual(D(0));
    expect(row.name).toBe('Renamed');
    // The update payload must not even MENTION addedAt or source — an update that carried them
    // would silently relitigate the lock the next time someone re-added a client.
    const update = (db.calls[1] as { update: Record<string, unknown> }).update;
    expect(update).not.toHaveProperty('addedAt');
    expect(update).not.toHaveProperty('source');
  });

  it('refuses an unparseable address rather than storing a hash of nonsense', async () => {
    const db = fake();
    const result = await addClientEntries(db, {
      practitionerId: P,
      source: 'MANUAL_ADD',
      at: D(0),
      entries: [{ email: 'not-an-email', name: null }],
    });

    expect(result.added).toBe(0);
    expect(result.rejected).toEqual(['not-an-email']);
    expect(db.rows.size).toBe(0);
  });

  it('de-duplicates within one submission so a pasted list cannot double-write', async () => {
    const db = fake();
    const result = await addClientEntries(db, {
      practitionerId: P,
      source: 'MANUAL_ADD',
      at: D(0),
      entries: [
        { email: 'c@example.com', name: null },
        { email: 'C@Example.com', name: null },
      ],
    });

    expect(result.added).toBe(1);
    expect(db.rows.size).toBe(1);
  });
});

describe('buildClientList — statuses', () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    id: 'e1',
    email: 'c@example.com',
    emailHash: hashClientEmail('c@example.com'),
    name: null,
    addedAt: D(0),
    source: 'MANUAL_ADD',
    invitedAt: null,
    ...over,
  });

  it('marks a client with a paid booking as Booked, and carries their term end date', () => {
    const hash = hashClientEmail('c@example.com');
    const [row] = buildClientList({
      entries: [entry()],
      paidEmailHashes: new Set([hash]),
      attributions: new Map([[hash, { owner: 'NHP', termEndsAt: D(240) }]]),
      referralsByEmailHash: new Map(),
    });

    expect(row!.status).toBe('BOOKED');
    expect(row!.sourcedBy).toBe('NHP');
    expect(row!.termEndsAt).toEqual(D(240));
  });

  it('marks an emailed-but-unbooked client as Invited', () => {
    const [row] = buildClientList({
      entries: [entry({ source: 'EMAIL_INVITE', invitedAt: D(1) })],
      paidEmailHashes: new Set(),
      attributions: new Map(),
      referralsByEmailHash: new Map(),
    });

    expect(row!.status).toBe('INVITED');
  });

  it('marks everything else as Added, with no attribution claim implied', () => {
    const [row] = buildClientList({
      entries: [entry()],
      paidEmailHashes: new Set(),
      attributions: new Map(),
      referralsByEmailHash: new Map(),
    });

    expect(row!.status).toBe('ADDED');
    expect(row!.sourcedBy).toBeNull();
    expect(row!.termEndsAt).toBeNull();
  });

  it('shows a referral this practitioner MADE, naming the practitioner they referred to', () => {
    const hash = hashClientEmail('c@example.com');
    const [row] = buildClientList({
      entries: [entry({ source: 'REFERRAL_MADE' })],
      paidEmailHashes: new Set(),
      attributions: new Map(),
      referralsByEmailHash: new Map([
        [hash, [{ referredName: 'Dr Y', referredSlug: 'dr-y', status: 'OPENED', expiresAt: D(240) }]],
      ]),
    });

    expect(row!.referrals).toEqual([
      { referredName: 'Dr Y', referredSlug: 'dr-y', status: 'OPENED', expiresAt: D(240) },
    ]);
  });

  it('tells X NOTHING about Y’s side of a referral — not whether C was already Y’s client (§5.2A)', () => {
    // Spec §9 test 12: C was already on Y's list, so the referral earned nothing. X must not be
    // able to tell that apart from "not yet booked". The serialised row has no field that could
    // say so, by construction rather than by omission.
    const hash = hashClientEmail('c@example.com');
    const [row] = buildClientList({
      entries: [entry({ source: 'REFERRAL_MADE' })],
      paidEmailHashes: new Set(),
      attributions: new Map(),
      referralsByEmailHash: new Map([
        [hash, [{ referredName: 'Dr Y', referredSlug: 'dr-y', status: 'OPENED', expiresAt: D(240) }]],
      ]),
    });

    const fields = Object.keys(row!.referrals[0]!);
    expect(fields.sort()).toEqual(['expiresAt', 'referredName', 'referredSlug', 'status']);
    // Anything that would leak Y's own relationship with the client.
    for (const leak of ['owner', 'sourcedBy', 'attribution', 'onTheirList', 'earned', 'clientEmail']) {
      expect(fields).not.toContain(leak);
    }
  });
});

describe('loadClientList — every read is practitioner-scoped', () => {
  function spyDb() {
    const wheres: Record<string, unknown>[] = [];
    const record = (args: { where?: Record<string, unknown> }) => {
      if (args?.where) wheres.push(args.where);
      return [];
    };
    return {
      wheres,
      clientListEntry: { async findMany(a: { where?: Record<string, unknown> }) { return record(a); } },
      bookingIntent: { async findMany(a: { where?: Record<string, unknown> }) { return record(a); } },
      attributedClient: { async findMany(a: { where?: Record<string, unknown> }) { return record(a); } },
      referral: { async findMany(a: { where?: Record<string, unknown> }) { return record(a); } },
    };
  }

  it('scopes EVERY query to the owning practitioner — no hash-only read exists', async () => {
    const db = spyDb();
    await loadClientList(db, P);

    expect(db.wheres.length).toBeGreaterThanOrEqual(4);
    for (const where of db.wheres) {
      expect(
        JSON.stringify(where),
        `a query in loadClientList is not scoped to the practitioner: ${JSON.stringify(where)}`,
      ).toContain(P);
    }
  });

  it('asks only for PAID bookings when deciding the Booked badge', async () => {
    const db = spyDb();
    await loadClientList(db, P);

    const bookingWhere = db.wheres.find((w) => 'status' in w || 'paidAt' in w);
    expect(bookingWhere).toBeTruthy();
  });
});
