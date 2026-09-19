import { describe, expect, it } from 'vitest';

import { resolveAttributionInputs } from '@/lib/attribution-resolver';
import { hashClientEmail } from '@/lib/attributed-clients';

/**
 * THE THREE READS THAT FEED THE DECISION (spec v1.4 §3.1) — and the privacy rule they enforce.
 *
 * `decideAttribution` is a pure function; this is what fetches its L, B and R. It is tested
 * separately because the failure modes are query-shaped rather than logic-shaped:
 *
 *  - a list read that is not scoped to the booked practitioner would exempt a client because
 *    SOMEBODY ELSE had listed them (R8 says only Y's own list counts), and would simultaneously
 *    be a query path that returns another practitioner's clients;
 *  - a booking read that takes THIS booking instead of the FIRST one would let the cutoff move
 *    every time the client books again, so a list entry added after the relationship started
 *    could retro-exempt it;
 *  - a referral read that missed the touch carried on this very intent would silently drop the
 *    referrer on the one booking that actually converted.
 */

const P = 'practitioner-Y';
const EMAIL = 'Client@Example.com';
const HASH = hashClientEmail(EMAIL);

function db(seed: {
  clientListEntries?: Array<Record<string, unknown>>;
  bookingIntents?: Array<Record<string, unknown>>;
  referralTouches?: Array<Record<string, unknown>>;
}) {
  const calls: { model: string; args: unknown }[] = [];
  const match = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (v !== null && typeof v === 'object' && 'equals' in (v as object)) {
        const want = (v as { equals: unknown; mode?: string }).equals;
        const got = row[k];
        return typeof want === 'string' && typeof got === 'string'
          ? want.toLowerCase() === got.toLowerCase()
          : want === got;
      }
      if (v !== null && typeof v === 'object') {
        const nested = row[k] as Record<string, unknown> | undefined;
        return nested ? match(nested, v as Record<string, unknown>) : false;
      }
      return row[k] === v;
    });

  return {
    calls,
    clientListEntry: {
      async findFirst(args: { where: Record<string, unknown> }) {
        calls.push({ model: 'clientListEntry', args });
        return (seed.clientListEntries ?? []).filter((r) => match(r, args.where))[0] ?? null;
      },
    },
    bookingIntent: {
      async findFirst(args: { where: Record<string, unknown> }) {
        calls.push({ model: 'bookingIntent', args });
        const rows = (seed.bookingIntents ?? [])
          .filter((r) => match(r, args.where))
          .sort(
            (a, b) =>
              (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime(),
          );
        return rows[0] ?? null;
      },
    },
    referralTouch: {
      async findMany(args: { where: Record<string, unknown> }) {
        calls.push({ model: 'referralTouch', args });
        const or = (args.where.OR ?? null) as Array<Record<string, unknown>> | null;
        const rows = (seed.referralTouches ?? []).filter((r) =>
          or ? or.some((clause) => match(r, clause)) : match(r, args.where),
        );
        return rows;
      },
    },
  };
}

const D = (day: number) => new Date(Date.UTC(2026, 0, 1 + day));

const touchRow = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  clientEmailHash: HASH,
  receivedAt: D(3),
  referral: { referrerId: 'X', referredId: P, expiresAt: D(240) },
  ...over,
});

describe('resolveAttributionInputs', () => {
  it('reads the practitioner’s own list entry and returns its addedAt as L', async () => {
    const inputs = await resolveAttributionInputs(
      db({ clientListEntries: [{ practitionerId: P, emailHash: HASH, addedAt: D(0) }] }),
      { practitionerId: P, email: EMAIL, bookingCreatedAt: D(5) },
    );

    expect(inputs.listEntryAddedAt).toEqual(D(0));
  });

  it('scopes the list read to THIS practitioner — another practitioner’s entry never exempts (R8)', async () => {
    const inputs = await resolveAttributionInputs(
      db({ clientListEntries: [{ practitionerId: 'someone-else', emailHash: HASH, addedAt: D(0) }] }),
      { practitionerId: P, email: EMAIL, bookingCreatedAt: D(5) },
    );

    expect(inputs.listEntryAddedAt).toBeNull();
  });

  it('every query it issues is scoped by the booked practitioner — no hash-only read exists', async () => {
    const fake = db({});
    await resolveAttributionInputs(fake, {
      practitionerId: P,
      email: EMAIL,
      bookingCreatedAt: D(5),
      referralTouchId: 'carried',
    });

    // Mutation guard on the privacy rule: widening any of these to a bare emailHash lookup would
    // return rows belonging to other practitioners, and this is what would stop failing.
    for (const call of fake.calls) {
      const where = JSON.stringify((call.args as { where: unknown }).where);
      expect(where, `${call.model} is not scoped to the practitioner`).toContain(P);
    }
  });

  it('takes the EARLIEST booking as B, not the one being priced', async () => {
    const inputs = await resolveAttributionInputs(
      db({
        bookingIntents: [
          { practitionerId: P, email: EMAIL, createdAt: D(9) },
          { practitionerId: P, email: EMAIL, createdAt: D(2) },
        ],
      }),
      { practitionerId: P, email: EMAIL, bookingCreatedAt: D(9) },
    );

    expect(inputs.firstBookingAt).toEqual(D(2));
  });

  it('falls back to the booking being priced when no earlier one is stored yet', async () => {
    const inputs = await resolveAttributionInputs(db({}), {
      practitionerId: P,
      email: EMAIL,
      bookingCreatedAt: D(5),
    });

    expect(inputs.firstBookingAt).toEqual(D(5));
  });

  it('matches a stored booking email case-insensitively — capture lowercases, older rows may not', async () => {
    const inputs = await resolveAttributionInputs(
      db({ bookingIntents: [{ practitionerId: P, email: 'CLIENT@EXAMPLE.COM', createdAt: D(2) }] }),
      { practitionerId: P, email: EMAIL, bookingCreatedAt: D(9) },
    );

    expect(inputs.firstBookingAt).toEqual(D(2));
  });

  it('returns referral touches already attached to this client for this practitioner', async () => {
    const inputs = await resolveAttributionInputs(db({ referralTouches: [touchRow()] }), {
      practitionerId: P,
      email: EMAIL,
      bookingCreatedAt: D(5),
    });

    expect(inputs.referralTouches).toEqual([
      { touchId: 't1', referrerPractitionerId: 'X', receivedAt: D(3), expiresAt: D(240) },
    ]);
  });

  it('INCLUDES the touch carried on this booking, which has no client email attached yet', async () => {
    // The copied-link path: the visitor opened /r/<token>, so a touch exists with clientEmailHash
    // still null. Without this clause the referrer would be dropped on the one booking that
    // converted — the whole point of carrying the token.
    const inputs = await resolveAttributionInputs(
      db({
        referralTouches: [
          touchRow({ id: 'carried', clientEmailHash: null, receivedAt: D(3) }),
        ],
      }),
      {
        practitionerId: P,
        email: EMAIL,
        bookingCreatedAt: D(5),
        referralTouchId: 'carried',
      },
    );

    expect(inputs.referralTouches.map((t) => t.touchId)).toEqual(['carried']);
  });

  it('does not duplicate a touch that is both carried and already attached', async () => {
    const inputs = await resolveAttributionInputs(
      db({ referralTouches: [touchRow({ id: 't1' })] }),
      {
        practitionerId: P,
        email: EMAIL,
        bookingCreatedAt: D(5),
        referralTouchId: 't1',
      },
    );

    expect(inputs.referralTouches).toHaveLength(1);
  });
});
