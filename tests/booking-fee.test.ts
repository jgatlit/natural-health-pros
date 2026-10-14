import { describe, expect, it } from 'vitest';

import { resolveBookingFee } from '@/lib/booking-fee';
import { hashClientEmail } from '@/lib/attributed-clients';
import { NoRateScheduleError, type RateSchedule } from '@/lib/rate-schedule';
import { V1, V2 } from './helpers/rate-schedule';

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
  /** The serving practitioner's schedule. `null` = the practitioner has none (fail closed). */
  schedule?: RateSchedule | null;
  /** Schedules readable by id (an in-flight client row's snapshot points at one). */
  schedules?: RateSchedule[];
}) {
  const snapshots: Record<string, unknown>[] = [];
  const schedule = seed.schedule === undefined ? V1 : seed.schedule;
  const byId = new Map([...(seed.schedules ?? []), ...(schedule ? [schedule] : [])].map((x) => [x.id, x]));
  return {
    snapshots,
    practitioner: {
      async findUnique() {
        return { rateSchedule: schedule };
      },
    },
    rateSchedule: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async findUnique(args: any) {
        return byId.get(args.where.id) ?? null;
      },
    },
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

describe('resolveBookingFee', () => {
  it('prices a brand-new client on Plan B at the sourced rate', async () => {
    const fee = await call(db({}));

    expect(fee.nhpFeeUsdCents).toBe(3_000);
    expect(fee.applicationFeeUsdCents).toBe(3_000);
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
    expect(fee.nhpFeeUsdCents).toBe(1_000);
    expect(fee.referrerShareUsdCents).toBe(2_000);
  });

  it('a stored referrer stops being paid after the referrer term and the plan rate takes over', async () => {
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
      { transactedAt: D(150) },
    );

    expect(fee.isCrossReferral).toBe(false);
    expect(fee.referrerShareUsdCents).toBe(0);
    expect(fee.nhpFeeUsdCents).toBe(3_000);
    expect(fee.referrerTermState).toBe('PAST_REFERRER_TERM');
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

    // 8 calendar months from 1 Jan end on 1 Sep, which is day 243 — derived from anchor + schedule.
    const inside = await call(db(seed), { transactedAt: D(242) });
    const outside = await call(db(seed), { transactedAt: D(244) });

    expect(inside.nhpFeeUsdCents).toBe(3_000);
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
    expect(s.applicationFeeUsdCents).toBe(3_000);
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

describe('resolveBookingFee — rate schedules (spec v1.5 §2)', () => {
  it('FAILS CLOSED: a practitioner with no schedule is refused, nothing is priced, nothing is written', async () => {
    const fake = db({ schedule: null });
    await expect(call(fake)).rejects.toBeInstanceOf(NoRateScheduleError);
    expect(fake.snapshots).toHaveLength(0);
  });

  it('prices on the schedule it is given — a different schedule is a different number', async () => {
    const onV1 = await call(db({ schedule: V1 }), { persist: false });
    const onV2 = await call(db({ schedule: V2 }), { persist: false });
    expect(onV1.nhpFeeUsdCents).toBe(3_000);
    expect(onV2.nhpFeeUsdCents).toBe(2_000);
  });

  it('copies the schedule id and the resolved v1.5 numbers onto the snapshot', async () => {
    const fake = db({
      referralTouches: [
        { id: 't1', receivedAt: D(1), referral: { referrerId: 'X', referredId: P, expiresAt: D(240) } },
      ],
      bookingIntents: [{ createdAt: D(5) }],
    });
    await call(fake, { whopCheckoutConfigId: 'ch_abc' });

    expect(fake.snapshots[0]).toMatchObject({
      rateScheduleId: V1.id,
      referrerTermState: 'IN_REFERRER_TERM',
      affiliateBps: 0,
      affiliateShareUsdCents: 0,
      recruiterPractitionerId: null,
      nhpNetUsdCents: 1_000,
      nhpFeeUsdCents: 1_000,
      referrerShareUsdCents: 2_000,
      applicationFeeUsdCents: 3_000,
    });
  });

  it('A LATER SCHEDULE CHANGE NEVER RE-PRICES AN IN-FLIGHT TERM: the client row keeps the schedule it was sold under', async () => {
    // The practitioner has since been migrated to V2 (Plan B 20%), but this client was attributed
    // under V1 (Plan B 30%) and carries V1's id. Their next session is still priced on V1.
    const inFlight = {
      owner: 'NHP',
      decidedAt: D(0),
      referrerPractitionerId: null,
      termAnchorAt: D(0),
      termEndsAt: D(243),
      termMonths: 8,
      rateScheduleId: V1.id,
    };
    const fee = await call(db({ schedule: V2, schedules: [V1], attributed: inFlight }), {
      transactedAt: D(60),
      persist: false,
    });

    expect(fee.nhpFeeUsdCents).toBe(3_000);
    expect(fee.rateScheduleId).toBe(V1.id);

    // …whereas a BRAND-NEW client of the same practitioner is priced on the new schedule.
    const fresh = await call(db({ schedule: V2, schedules: [V1] }), { persist: false });
    expect(fresh.nhpFeeUsdCents).toBe(2_000);
    expect(fresh.rateScheduleId).toBe(V2.id);
  });

  it('a stored term length wins over the schedule: a client sold 6 months stays at 6', async () => {
    const row = {
      owner: 'NHP',
      decidedAt: D(0),
      referrerPractitionerId: null,
      termAnchorAt: D(0),
      termEndsAt: D(181),
      termMonths: 6,
      rateScheduleId: V1.id,
    };
    expect((await call(db({ attributed: row }), { transactedAt: D(170), persist: false })).nhpFeeUsdCents).toBe(3_000);
    expect((await call(db({ attributed: row }), { transactedAt: D(190), persist: false })).nhpFeeUsdCents).toBe(0);
  });

  it('an unreadable client-row schedule falls back to the practitioner’s own rather than refusing', async () => {
    const row = {
      owner: 'NHP',
      decidedAt: D(0),
      referrerPractitionerId: null,
      termAnchorAt: D(0),
      termEndsAt: D(243),
      rateScheduleId: 'rs_gone',
    };
    const fee = await call(db({ attributed: row }), { transactedAt: D(10), persist: false });
    expect(fee.rateScheduleId).toBe(V1.id);
  });

  it('the recruiter is read through ONE seam that answers null until L0b lands: no affiliate is charged', async () => {
    const fee = await call(db({}), { persist: false });
    expect(fee.affiliateShareUsdCents).toBe(0);
    expect(fee.recruiterPractitionerId).toBeNull();
  });
});
