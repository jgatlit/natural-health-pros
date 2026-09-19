import { describe, expect, it } from 'vitest';

import { overrideAttribution } from '@/lib/attribution-override';
import { reconcileFeeLines } from '@/lib/fee-reconciliation';

/**
 * ADMIN OVERRIDES AND RECONCILIATION (spec v1.4 §3.2, §7).
 *
 * §3.2: "Only an admin override can change the owner or the referrer. Overrides are logged and
 * write adjustment entries to the ledger." Both halves matter. A change with no note is
 * unexplainable six months later, and a change with no ledger entry is invisible to the
 * reconciliation that is supposed to make the ledger trustworthy.
 *
 * ⚠️ AN OVERRIDE DOES NOT RE-PRICE ANYTHING ALREADY CHARGED. `BookingFeeSnapshot` records what was
 * actually collected and Whop has already taken it; changing the attribution changes what happens
 * NEXT. The adjustment entry is the record of the difference, for a human to act on.
 */

const NOW = new Date(Date.UTC(2026, 5, 1));

function fake(existing: Record<string, unknown> | null) {
  const updates: Record<string, unknown>[] = [];
  const ledger: Record<string, unknown>[] = [];
  return {
    updates,
    ledger,
    attributedClient: {
      async findUnique() {
        return existing;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async update(args: any) {
        updates.push(args.data);
        return { ...existing, ...args.data };
      },
    },
    feeLedgerEntry: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async create(args: any) {
        ledger.push(args.data);
        return args.data;
      },
    },
  };
}

const row = (over: Record<string, unknown> = {}) => ({
  id: 'attr_1',
  practitionerId: 'Y',
  owner: 'NHP',
  referrerPractitionerId: null,
  ...over,
});

describe('overrideAttribution', () => {
  it('REFUSES an override with no note — an unexplained change is unauditable', async () => {
    const db = fake(row());

    await expect(
      overrideAttribution(db, {
        attributionId: 'attr_1',
        owner: 'PRACTITIONER',
        note: '   ',
        adminUserId: 'usr_admin',
        at: NOW,
      }),
    ).rejects.toThrow(/USER:.*note/i);

    expect(db.updates).toEqual([]);
    expect(db.ledger).toEqual([]);
  });

  it('records the admin, the time and the note on the row itself', async () => {
    const db = fake(row());

    await overrideAttribution(db, {
      attributionId: 'attr_1',
      owner: 'PRACTITIONER',
      note: 'Client confirmed they were Sarah’s before the platform existed.',
      adminUserId: 'usr_admin',
      at: NOW,
    });

    expect(db.updates[0]).toMatchObject({
      owner: 'PRACTITIONER',
      decidedByRule: 'ADMIN_OVERRIDE',
      overriddenByUserId: 'usr_admin',
      overriddenAt: NOW,
    });
    expect(String(db.updates[0]!.overrideNote)).toContain('Sarah');
  });

  it('writes an ADMIN_ADJUSTMENT ledger entry naming what changed', async () => {
    const db = fake(row());

    await overrideAttribution(db, {
      attributionId: 'attr_1',
      owner: 'PRACTITIONER',
      note: 'Pre-existing client.',
      adminUserId: 'usr_admin',
      at: NOW,
    });

    const entry = db.ledger[0]!;
    expect(entry).toMatchObject({ kind: 'ADMIN_ADJUSTMENT', amountUsdCents: 0 });
    // Zero, deliberately: this does not move money. It records that a decision changed, so the
    // difference is visible to a human who can then act on it.
    expect(String(entry.note)).toMatch(/NHP.*PRACTITIONER/);
    expect(String(entry.dedupeKey)).toContain('attr_1');
  });

  it('can change the referrer, and says so in the ledger', async () => {
    const db = fake(row({ referrerPractitionerId: 'X1' }));

    await overrideAttribution(db, {
      attributionId: 'attr_1',
      referrerPractitionerId: 'X2',
      note: 'X1 confirmed the introduction was actually X2’s.',
      adminUserId: 'usr_admin',
      at: NOW,
    });

    expect(db.updates[0]).toMatchObject({ referrerPractitionerId: 'X2' });
    expect(String(db.ledger[0]!.note)).toMatch(/X1.*X2/);
  });

  it('refuses when there is nothing to change — a no-op override is a mis-click, not an audit event', async () => {
    const db = fake(row());

    await expect(
      overrideAttribution(db, {
        attributionId: 'attr_1',
        note: 'Nothing here.',
        adminUserId: 'usr_admin',
        at: NOW,
      }),
    ).rejects.toThrow(/USER:/);
    expect(db.ledger).toEqual([]);
  });

  it('refuses an attribution that does not exist, rather than creating one', async () => {
    const db = fake(null);

    await expect(
      overrideAttribution(db, {
        attributionId: 'nope',
        owner: 'PRACTITIONER',
        note: 'x',
        adminUserId: 'usr_admin',
        at: NOW,
      }),
    ).rejects.toThrow(/USER:/);
  });
});

describe('reconcileFeeLines — §7, what makes the ledger checkable', () => {
  /**
   * `GET /api/v1/payments/{id}/fees` itemises every line with an `origin`. Validated live on
   * pay_JOaWdCx7xc37VJ: a $10.00 payment carried `application_fee` $5.00 alongside Whop's own
   * processing lines. So our recorded fee CAN be checked against Whop rather than assumed.
   */

  it('agrees when Whop’s application_fee line matches what we recorded', () => {
    const result = reconcileFeeLines({
      expectedUsdCents: 4_000,
      whopFees: [
        { origin: 'application_fee', amount: 40 },
        { origin: 'payment_processing_fixed_fee', amount: 0.3 },
      ],
    });

    expect(result).toEqual({ ok: true, observedUsdCents: 4_000, expectedUsdCents: 4_000 });
  });

  it('⚠️ reads Whop’s fee amounts as DOLLARS — the same unit trap as /transfers', () => {
    // `amount: 40` is $40.00, not 40 cents. Reading it as cents would report a 100× mismatch on
    // every single payment and make the whole reconciliation useless noise.
    const result = reconcileFeeLines({
      expectedUsdCents: 4_000,
      whopFees: [{ origin: 'application_fee', amount: 40 }],
    });

    expect(result.observedUsdCents).toBe(4_000);
  });

  it('reports a mismatch with both numbers, not just a boolean', () => {
    const result = reconcileFeeLines({
      expectedUsdCents: 4_000,
      whopFees: [{ origin: 'application_fee', amount: 20 }],
    });

    expect(result).toEqual({ ok: false, observedUsdCents: 2_000, expectedUsdCents: 4_000 });
  });

  it('treats a MISSING application_fee line as an observed zero, which is a real mismatch', () => {
    // Not "unknown". A payment that carries no application fee line collected nothing for us, and
    // silently skipping it is how a fee that never arrived stays invisible.
    const result = reconcileFeeLines({
      expectedUsdCents: 4_000,
      whopFees: [{ origin: 'payment_processing_fixed_fee', amount: 0.3 }],
    });

    expect(result).toEqual({ ok: false, observedUsdCents: 0, expectedUsdCents: 4_000 });
  });

  it('sums several application_fee lines rather than taking the first', () => {
    const result = reconcileFeeLines({
      expectedUsdCents: 4_000,
      whopFees: [
        { origin: 'application_fee', amount: 30 },
        { origin: 'application_fee', amount: 10 },
      ],
    });

    expect(result.ok).toBe(true);
  });

  it('agrees on a zero-fee booking — "we charged nothing" must be provable too', () => {
    expect(reconcileFeeLines({ expectedUsdCents: 0, whopFees: [] }).ok).toBe(true);
  });

  it('tolerates a one-cent float artefact rather than reporting it as a discrepancy', () => {
    // 0.1 + 0.2 arithmetic on Whop's side can land a hair off. A reconciliation that cried wolf
    // on a cent would be switched off within a week, which is worse than the cent.
    const result = reconcileFeeLines({
      expectedUsdCents: 4_000,
      whopFees: [{ origin: 'application_fee', amount: 39.999999 }],
    });

    expect(result.ok).toBe(true);
  });
});
