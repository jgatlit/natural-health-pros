import { describe, expect, it, vi } from 'vitest';

import { resolveBookingFee } from '@/lib/booking-fee';
import { hashClientEmail } from '@/lib/attributed-clients';
import { V1 } from './helpers/rate-schedule';

/**
 * THE AFFILIATE OVERLAY, THROUGH `resolveBookingFee` AND INTO THE SNAPSHOT.
 *
 * `getRecruiterFor` is the seam to lane L0b and answers null until `Practitioner.recruitedById`
 * exists. Here it is mocked to name a recruiter, so the wiring from the seam through the fee rule
 * to `BookingFeeSnapshot` is proven today — and so merging L0b needs only to change the seam, not
 * to re-verify the money.
 */

const recruiter = vi.hoisted(() => ({ id: 'prac_R' as string | null }));
vi.mock('@/lib/recruiter', () => ({ getRecruiterFor: async () => recruiter.id }));

const P = 'prac_Y';
const EMAIL = 'client@example.com';
const D = (day: number) => new Date(Date.UTC(2026, 0, 1 + day));

function db(attributed: Record<string, unknown> | null = null, clientListed = false) {
  const snapshots: Record<string, unknown>[] = [];
  return {
    snapshots,
    practitioner: { findUnique: async () => ({ rateSchedule: V1 }) },
    rateSchedule: { findUnique: async () => V1 },
    attributedClient: { findUnique: async () => attributed },
    clientListEntry: {
      findFirst: async () => (clientListed ? { addedAt: D(-30) } : null),
    },
    bookingIntent: { findFirst: async () => ({ createdAt: D(5) }) },
    referralTouch: { findMany: async () => [] },
    bookingFeeSnapshot: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      upsert: async (args: any) => {
        snapshots.push(args.create);
        return args.create;
      },
    },
  };
}

const price = (fake: ReturnType<typeof db>, plan: 'PLAN_A' | 'PLAN_B', over: Record<string, unknown> = {}) =>
  resolveBookingFee(fake, {
    bookingIntentId: 'bi_1',
    practitionerId: P,
    email: EMAIL,
    plan,
    priceUsdCents: 10_000,
    bookingCreatedAt: D(5),
    transactedAt: D(5),
    referralTouchId: null,
    ...over,
  });

describe('recruited practitioner Y, $100 session — through the fee path and into the snapshot', () => {
  it('own client: Y is charged $3, handed to R; NHP nets $0; the Whop fee is $3', async () => {
    recruiter.id = 'prac_R';
    const fake = db(null, true);
    const fee = await price(fake, 'PLAN_A');

    expect(fee.applicationFeeUsdCents).toBe(300);
    expect(fee.practitionerNetUsdCents).toBe(9_700);
    expect(fake.snapshots[0]).toMatchObject({
      nhpFeeUsdCents: 0,
      affiliateBps: 300,
      affiliateShareUsdCents: 300,
      recruiterPractitionerId: 'prac_R',
      nhpNetUsdCents: 0,
      applicationFeeUsdCents: 300,
      practitionerNetUsdCents: 9_700,
      rateScheduleId: V1.id,
    });
  });

  it('Plan A sourced: still $10 total; $3 of it is R’s, so NHP nets $7', async () => {
    recruiter.id = 'prac_R';
    const fake = db();
    const fee = await price(fake, 'PLAN_A');

    expect(fee.applicationFeeUsdCents).toBe(1_000);
    expect(fake.snapshots[0]).toMatchObject({
      nhpFeeUsdCents: 1_000,
      affiliateShareUsdCents: 300,
      nhpNetUsdCents: 700,
      applicationFeeUsdCents: 1_000,
    });
  });

  it('Plan B sourced: $30 total; NHP nets $27', async () => {
    recruiter.id = 'prac_R';
    const fake = db();
    await price(fake, 'PLAN_B');
    expect(fake.snapshots[0]).toMatchObject({
      applicationFeeUsdCents: 3_000,
      affiliateShareUsdCents: 300,
      nhpNetUsdCents: 2_700,
    });
  });

  it('past the lead term: Y bears the $3, NHP nets $0', async () => {
    recruiter.id = 'prac_R';
    const fake = db({
      owner: 'NHP',
      decidedAt: D(-300),
      referrerPractitionerId: null,
      termAnchorAt: D(-300),
      termEndsAt: D(-60),
      termMonths: 8,
      rateScheduleId: V1.id,
    });
    const fee = await price(fake, 'PLAN_B');
    expect(fee.nhpFeeUsdCents).toBe(0);
    expect(fee.applicationFeeUsdCents).toBe(300);
    expect(fake.snapshots[0]).toMatchObject({ affiliateShareUsdCents: 300, nhpNetUsdCents: 0 });
  });

  it('no recruiter: no affiliate columns are populated and nothing extra is charged', async () => {
    recruiter.id = null;
    const fake = db();
    const fee = await price(fake, 'PLAN_A');
    expect(fee.applicationFeeUsdCents).toBe(1_000);
    expect(fake.snapshots[0]).toMatchObject({
      affiliateBps: 0,
      affiliateShareUsdCents: 0,
      recruiterPractitionerId: null,
      nhpNetUsdCents: 1_000,
    });
  });

  it('a recruiter who is the serving practitioner themselves earns nothing', async () => {
    recruiter.id = P;
    const fake = db();
    await price(fake, 'PLAN_A');
    expect(fake.snapshots[0]).toMatchObject({ affiliateShareUsdCents: 0, recruiterPractitionerId: null });
  });

  it('uses hashClientEmail consistently (the stored-row lookup is keyed on it)', () => {
    expect(hashClientEmail(EMAIL)).toMatch(/^[0-9a-f]{64}$/);
  });
});
