import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { resolveBookingFee } from '@/lib/booking-fee';
import { hashClientEmail } from '@/lib/attributed-clients';

/**
 * THE FEE A BOOKING IS ACTUALLY MINTED WITH — where the rule meets the ledger.
 *
 * ⚠️ THIS RUNS AT MINT, NOT AT PAYMENT, AND THAT IS FORCED. Spec §6.1 says the calculation "runs
 * once, when a session is paid". It cannot: Whop fixes `application_fee_amount` when the PLAN is
 * created and it is not patchable afterwards. So the decision is taken here, recorded, and merely
 * COMMITTED by `payment.succeeded` — never recomputed, because a recomputation that disagreed
 * with the amount Whop already charged is unresolvable.
 *
 * The assertions below are mostly about not re-deciding: §3.2 says the owner is decided once, and
 * a fee path that quietly re-derived it would let a list entry added mid-relationship retro-exempt
 * a client we had already been paid for.
 */

const P = 'practitioner-Y';
const EMAIL = 'client@example.com';
const HASH = hashClientEmail(EMAIL);
const D = (day: number) => new Date(Date.UTC(2026, 0, 1 + day));

function db(seed: {
  attributed?: Record<string, unknown> | null;
  clientListEntries?: Array<Record<string, unknown>>;
  bookingIntents?: Array<Record<string, unknown>>;
  referralTouches?: Array<Record<string, unknown>>;
}) {
  const snapshots: Record<string, unknown>[] = [];
  return {
    snapshots,
    attributedClient: {
      async findUnique() {
        return seed.attributed ?? null;
      },
    },
    clientListEntry: {
      async findFirst(args: { where: Record<string, unknown> }) {
        return (
          (seed.clientListEntries ?? []).find(
            (r) => r.practitionerId === args.where.practitionerId && r.emailHash === args.where.emailHash,
          ) ?? null
        );
      },
    },
    bookingIntent: {
      async findFirst() {
        const rows = (seed.bookingIntents ?? []).slice().sort(
          (a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime(),
        );
        return rows[0] ?? null;
      },
    },
    referralTouch: {
      async findMany() {
        return seed.referralTouches ?? [];
      },
    },
    bookingFeeSnapshot: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async upsert(args: any) {
        snapshots.push(args.create);
        return args.create;
      },
    },
  };
}

const call = (fake: ReturnType<typeof db>, over: Record<string, unknown> = {}) =>
  resolveBookingFee(fake, {
    bookingIntentId: 'bi_1',
    practitionerId: P,
    email: EMAIL,
    plan: 'PLAN_B',
    priceUsdCents: 10_000,
    bookingCreatedAt: D(5),
    transactedAt: D(5),
    referralTouchId: null,
    ...over,
  });

const ENV = ['XREF_NHP_FEE_BPS', 'XREF_REFERRER_FEE_BPS'];

describe('resolveBookingFee', () => {
  let saved: Record<string, string | undefined>;
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

  it('prices a brand-new client on Plan B at the sourced rate', async () => {
    const fee = await call(db({}));

    expect(fee.nhpFeeUsdCents).toBe(4_000);
    expect(fee.applicationFeeUsdCents).toBe(4_000);
    expect(fee.termState).toBe('NONE');
    expect(fee.attributionOwner).toBe('NHP');
  });

  it('REUSES an already-decided attribution instead of re-deriving it (§3.2)', async () => {
    // The stored row says PRACTITIONER. A list entry no longer exists (say it was removed) and a
    // referral has since arrived — neither may reopen a decision already taken.
    const fee = await call(
      db({
        attributed: {
          owner: 'PRACTITIONER',
          decidedAt: D(0),
          referrerPractitionerId: null,
          termAnchorAt: D(0),
          termEndsAt: D(240),
        },
        referralTouches: [
          {
            id: 't1',
            receivedAt: D(1),
            referral: { referrerId: 'X', referredId: P, expiresAt: D(240) },
          },
        ],
      }),
    );

    expect(fee.attributionOwner).toBe('PRACTITIONER');
    expect(fee.applicationFeeUsdCents).toBe(0);
    expect(fee.referrerPractitionerId).toBeNull();
  });

  it('honours a stored referrer on a repeat session, without re-reading the referral', async () => {
    const fee = await call(
      db({
        attributed: {
          owner: 'NHP',
          decidedAt: D(0),
          referrerPractitionerId: 'X',
          termAnchorAt: D(0),
          termEndsAt: D(240),
        },
      }),
      { transactedAt: D(100) },
    );

    expect(fee.isCrossReferral).toBe(true);
    expect(fee.referrerPractitionerId).toBe('X');
    expect(fee.nhpFeeUsdCents).toBe(2_000);
    expect(fee.referrerShareUsdCents).toBe(2_000);
  });

  it('decides fresh when a row exists but was never decided — the pre-referrals rows', async () => {
    // Rows written before this stage have `decidedAt` null and `owner` defaulted to NHP. They must
    // still get a real decision rather than silently inheriting the column default, or a client on
    // the practitioner's own list would keep being charged.
    const fee = await call(
      db({
        attributed: { owner: 'NHP', decidedAt: null, referrerPractitionerId: null, termAnchorAt: D(0), termEndsAt: D(240) },
        clientListEntries: [{ practitionerId: P, emailHash: HASH, addedAt: D(0) }],
        bookingIntents: [{ createdAt: D(5) }],
      }),
    );

    expect(fee.attributionOwner).toBe('PRACTITIONER');
    expect(fee.applicationFeeUsdCents).toBe(0);
  });

  it('measures the term at the TRANSACTION instant (§6.1, corrected 2026-09-19)', async () => {
    // The boundary reads the same calendar the anchor was set from — the client's payments — so
    // the instant handed in here is this session's transaction, never its scheduled start.
    const seed = {
      attributed: {
        owner: 'NHP',
        decidedAt: D(0),
        referrerPractitionerId: null,
        termAnchorAt: D(0),
        termEndsAt: D(240),
      },
    };

    const inside = await call(db(seed), { transactedAt: D(239) });
    const outside = await call(db(seed), { transactedAt: D(241) });

    expect(inside.nhpFeeUsdCents).toBe(4_000);
    expect(outside.nhpFeeUsdCents).toBe(0);
    expect(outside.termState).toBe('OUT_OF_TERM');
  });

  it('writes a snapshot whose parts add up to the single fee handed to Whop', async () => {
    const fake = db({
      referralTouches: [
        { id: 't1', receivedAt: D(1), referral: { referrerId: 'X', referredId: P, expiresAt: D(240) } },
      ],
      bookingIntents: [{ createdAt: D(5) }],
    });
    await call(fake, { whopCheckoutConfigId: 'ch_abc' });

    expect(fake.snapshots).toHaveLength(1);
    const s = fake.snapshots[0] as Record<string, number | string | boolean | null>;
    expect(s.isCrossReferral).toBe(true);
    expect(s.referrerPractitionerId).toBe('X');
    expect(s.applicationFeeUsdCents).toBe(4_000);
    expect(Number(s.nhpFeeUsdCents) + Number(s.referrerShareUsdCents)).toBe(
      Number(s.applicationFeeUsdCents),
    );
    expect(Number(s.practitionerNetUsdCents) + Number(s.applicationFeeUsdCents)).toBe(
      Number(s.priceUsdCents),
    );
    expect(s.whopCheckoutConfigId).toBe('ch_abc');
  });

  it('does not write a snapshot when asked only to price (no configuration minted yet)', async () => {
    const fake = db({});
    await call(fake, { persist: false });

    expect(fake.snapshots).toHaveLength(0);
  });
});
