import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  attributionTermState,
  hasAnyAttribution,
  hashClientEmail,
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
  termMonths: number | null;
  termAnchorAt: Date | null;
  termEndsAt: Date | null;
  referrerPractitionerId: string | null;
};

/**
 * Minimal in-memory stand-in for the Prisma delegate this module touches — including `update`
 * with a conditional WHERE, because the re-anchoring guard is exactly what these tests exist to
 * prove and a fake that ignores the guard would pass a broken implementation.
 */
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
      async updateMany(args: any) {
        // Honours the conditional filter the real query carries — a fake that ignored it would
        // pass an implementation with no lock at all, which is the bug under test.
        let count = 0;
        for (const [k, row] of Array.from(rows.entries())) {
          const r = row as Record<string, unknown>;
          const matches = Object.entries(args.where).every(([field, want]) => {
            if (field === 'practitionerId' || field === 'emailHash') return r[field] === want;
            return (r[field] ?? null) === want;
          });
          if (!matches) continue;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          rows.set(k, { ...(row as any), ...args.data });
          count += 1;
        }
        return { count };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async findUnique(args: any) {
        const { practitionerId, emailHash } = args.where.practitionerId_emailHash;
        return rows.get(key(practitionerId, emailHash)) ?? null;
      },
    },
  };
}

const TERM = 8;
const only = (db: ReturnType<typeof fakeDb>) => Array.from(db.rows.values())[0];

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

  it('snapshots the term onto the row at creation, anchored on the PAYMENT', async () => {
    const db = fakeDb();
    await recordAttributedClient(db, {
      practitionerId: 'p1',
      email: 'c@x.com',
      termMonths: TERM,
      transactedAt: new Date('2026-01-10T00:00:00Z'),
      at: new Date('2026-01-10T00:00:00Z'),
    });
    const row = only(db);
    expect(row.termMonths).toBe(8);
    // Anchored on the payment (January), not on a March session the client booked ahead.
    expect(row.termAnchorAt?.toISOString()).toBe('2026-01-10T00:00:00.000Z');
    expect(row.termEndsAt?.toISOString()).toBe('2026-09-10T00:00:00.000Z');
  });

  it('keeps a later operator term change off a claim already sold', async () => {
    const db = fakeDb();
    const anchor = new Date('2026-03-01T00:00:00Z');
    await recordAttributedClient(db, {
      practitionerId: 'p1', email: 'c@x.com', termMonths: 8, transactedAt: anchor, at: anchor,
    });
    // The operator doubles the term. The existing row must not move.
    await recordAttributedClient(db, {
      practitionerId: 'p1', email: 'c@x.com', termMonths: 16, transactedAt: anchor, at: anchor,
    });
    const row = only(db);
    expect(row.termMonths).toBe(8);
    expect(row.termEndsAt?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('LOCKS THE TERM AT EARLIEST TOUCH — a repeat booking never extends it', async () => {
    // The shipped code moved `expiresAt` forward on every repeat booking, making the claim a
    // rolling window that a frequent client could keep alive indefinitely.
    const db = fakeDb();
    const first = new Date('2026-01-01T00:00:00Z');
    const later = new Date('2026-06-01T00:00:00Z');
    await recordAttributedClient(db, {
      practitionerId: 'p1', email: 'c@x.com', termMonths: TERM,
      transactedAt: first, at: first, bookingIntentId: 'bi_1',
    });
    await recordAttributedClient(db, {
      practitionerId: 'p1', email: 'c@x.com', termMonths: TERM,
      transactedAt: later, at: later, bookingIntentId: 'bi_2',
    });
    expect(db.rows.size).toBe(1);
    const row = only(db);
    expect(row.attributedAt).toEqual(first);
    expect(row.firstBookingIntentId).toBe('bi_1');
    // The anchor is still the FIRST payment, and the end date has not moved.
    expect(row.termAnchorAt).toEqual(first);
    expect(row.termEndsAt?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('REPAIRS a legacy unanchored row from its OWN attributedAt, not from this payment', async () => {
    // A row written before the term columns existed (or by the previous deploy mid-migration) has
    // a null anchor: PENDING_ANCHOR, chargeable, with NO end date — the 8-month promise inverted.
    // The next payment repairs it.
    //
    // ⚠️ AND IT MUST ANCHOR ON `attributedAt`, WHICH IS THAT ROW'S FIRST PAYMENT. Anchoring on the
    // payment in hand would run the term from the client's second session and bill the
    // practitioner months past the eight they were sold.
    const db = fakeDb();
    const firstPayment = new Date('2026-01-10T00:00:00Z');
    db.rows.set(`p1|${hashClientEmail('c@x.com')}`, {
      practitionerId: 'p1',
      emailHash: hashClientEmail('c@x.com'),
      expiresAt: new Date('2027-01-10T00:00:00Z'),
      attributedAt: firstPayment,
      party: null,
      source: null,
      firstBookingIntentId: null,
      termMonths: null,
      termAnchorAt: null,
      termEndsAt: null,
      referrerPractitionerId: null,
    });
    await expect(
      attributionTermState(db, { practitionerId: 'p1', email: 'c@x.com', asOf: new Date() }),
    ).resolves.toBe('PENDING_ANCHOR');

    const secondPayment = new Date('2026-06-01T00:00:00Z');
    await recordAttributedClient(db, {
      practitionerId: 'p1', email: 'c@x.com', termMonths: TERM,
      transactedAt: secondPayment, at: secondPayment,
    });

    const row = only(db);
    expect(row.termAnchorAt?.toISOString()).toBe('2026-01-10T00:00:00.000Z');
    expect(row.termEndsAt?.toISOString()).toBe('2026-09-10T00:00:00.000Z');
    // …and a third payment does not re-anchor it.
    await recordAttributedClient(db, {
      practitionerId: 'p1', email: 'c@x.com', termMonths: TERM,
      transactedAt: new Date('2026-08-01T00:00:00Z'), at: new Date('2026-08-01T00:00:00Z'),
    });
    expect(only(db).termAnchorAt?.toISOString()).toBe('2026-01-10T00:00:00.000Z');
  });

  it('AUDIT: repairing a legacy row keeps ITS term, never today’s admin setting', async () => {
    // R1 is forward-only: `termMonths` is snapshotted per row precisely so that an operator
    // editing the setting cannot reprice a claim already sold. The repair below fills in a MISSING
    // anchor — it is not a licence to also rewrite a term the row already carries.
    //
    // Reachable: the previous revision of this branch wrote `termMonths` alongside a NULL anchor
    // whenever `sessionStartsAt` was null, which is every practitioner with no scheduler link.
    // Such a row sold at 6 months would silently become 8 on the client's next payment.
    const db = fakeDb();
    const firstPayment = new Date('2026-01-10T00:00:00Z');
    db.rows.set(`p9|${hashClientEmail('c@x.com')}`, {
      practitionerId: 'p9',
      emailHash: hashClientEmail('c@x.com'),
      expiresAt: new Date('2027-01-10T00:00:00Z'),
      attributedAt: firstPayment,
      party: null,
      source: null,
      firstBookingIntentId: null,
      termMonths: 6,
      termAnchorAt: null,
      termEndsAt: null,
      referrerPractitionerId: null,
    });

    // The operator has since raised the setting to 8. The claim was sold at 6.
    await recordAttributedClient(db, {
      practitionerId: 'p9', email: 'c@x.com', termMonths: 8,
      transactedAt: new Date('2026-06-01T00:00:00Z'), at: new Date('2026-06-01T00:00:00Z'),
    });

    const row = only(db);
    expect(row.termMonths).toBe(6);
    expect(row.termEndsAt?.toISOString()).toBe('2026-07-10T00:00:00.000Z');
  });

  it('keeps the first referrer named, never the latest', async () => {
    const db = fakeDb();
    const at = new Date('2026-01-01T00:00:00Z');
    await recordAttributedClient(db, {
      practitionerId: 'p1', email: 'c@x.com', termMonths: TERM, transactedAt: at, at,
      referrerPractitionerId: 'ref_1',
    });
    await recordAttributedClient(db, {
      practitionerId: 'p1', email: 'c@x.com', termMonths: TERM, transactedAt: at, at,
      referrerPractitionerId: 'ref_2',
    });
    // Same earliest-touch logic as the booking that introduced them: a later link must not steal
    // a referral that someone else earned.
    expect(only(db).referrerPractitionerId).toBe('ref_1');
  });

  it('scopes a claim to one practitioner — the same client is new to everyone else', async () => {
    const db = fakeDb();
    await recordAttributedClient(db, {
      practitionerId: 'p1', email: 'c@x.com', termMonths: TERM, transactedAt: new Date(),
    });
    await expect(
      attributionTermState(db, { practitionerId: 'p2', email: 'c@x.com', asOf: new Date() }),
    ).resolves.toBe('NONE');
    await expect(hasAnyAttribution(db, { practitionerId: 'p1', email: 'c@x.com' })).resolves.toBe(true);
    await expect(hasAnyAttribution(db, { practitionerId: 'p2', email: 'c@x.com' })).resolves.toBe(false);
  });

  it('reports the term state the fee path bills from', async () => {
    const db = fakeDb();
    const anchor = new Date('2026-01-15T00:00:00Z');
    await recordAttributedClient(db, {
      practitionerId: 'p1', email: 'c@x.com', termMonths: TERM, transactedAt: anchor, at: anchor,
    });
    const q = (asOf: Date) => attributionTermState(db, { practitionerId: 'p1', email: 'c@x.com', asOf });
    await expect(q(new Date('2026-04-15T00:00:00Z'))).resolves.toBe('IN_TERM');
    await expect(q(new Date('2026-09-15T00:00:00Z'))).resolves.toBe('OUT_OF_TERM'); // month 8 exactly
    await expect(q(new Date('2026-10-15T00:00:00Z'))).resolves.toBe('OUT_OF_TERM');
  });
});
