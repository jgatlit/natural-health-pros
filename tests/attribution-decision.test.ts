import { describe, expect, it } from 'vitest';

import { decideAttribution, eligibleReferralTouches } from '@/lib/attribution-decision';

/**
 * THE EARLIEST-TOUCH LOCK (spec v1.4 §3.1, R5) — who owns a client, decided once.
 *
 * The rule reads as a two-line comparison and is worth more care than that, because every branch
 * of it moves 20–40% of every session for eight months:
 *
 *   L = the earliest entry for this client on THIS practitioner's own list
 *   B = when the client's first booking with them was created
 *   R = the earliest unexpired referral of this client to them
 *   owner = practitioner  iff  L exists and L < min(B, R)
 *
 * The trap is the `< min(B, R)` rather than `< B`. Without R in the cutoff, a practitioner could
 * watch a referred client arrive and add them to their list before the booking completed — which
 * would take the referrer's share away after the introduction had already been made. Spec §9
 * test 11 is exactly that sequence, and it is the reason the referral's timestamp is part of the
 * cutoff rather than merely a tie-break.
 */

const D = (day: number, hours = 0) =>
  new Date(Date.UTC(2026, 0, 1 + day, hours, 0, 0));

/** A referral touch as the resolver hands it to the decision: already scoped to (C, Y). */
function touch(overrides: {
  touchId: string;
  referrerPractitionerId: string;
  receivedAt: Date;
  expiresAt?: Date;
}) {
  return {
    touchId: overrides.touchId,
    referrerPractitionerId: overrides.referrerPractitionerId,
    receivedAt: overrides.receivedAt,
    // Eight months past the epoch above unless a test is specifically about expiry.
    expiresAt: overrides.expiresAt ?? D(240),
  };
}

describe('decideAttribution — ownership', () => {
  it('spec §9 test 1 — a list entry made before the first booking makes the client the practitioner’s own', () => {
    const decision = decideAttribution({
      practitionerId: 'Y',
      listEntryAddedAt: D(0),
      firstBookingAt: D(5),
      referralTouches: [],
    });

    expect(decision.owner).toBe('PRACTITIONER');
    expect(decision.decidedByRule).toBe('LIST_BEFORE_CUTOFF');
    expect(decision.referrerPractitionerId).toBeNull();
  });

  it('spec §9 test 2 — a client on no list at all is NHP-sourced', () => {
    const decision = decideAttribution({
      practitionerId: 'Y',
      listEntryAddedAt: null,
      firstBookingAt: D(5),
      referralTouches: [],
    });

    expect(decision.owner).toBe('NHP');
    expect(decision.decidedByRule).toBe('NHP_SOURCED');
    expect(decision.referrerPractitionerId).toBeNull();
  });

  it('a list entry made AFTER the first booking is kept for the records but ignored for attribution (§3.2)', () => {
    const decision = decideAttribution({
      practitionerId: 'Y',
      listEntryAddedAt: D(6),
      firstBookingAt: D(5),
      referralTouches: [],
    });

    expect(decision.owner).toBe('NHP');
  });

  it('a list entry made at exactly the cutoff instant does NOT exempt — the rule is STRICTLY before (R5)', () => {
    const decision = decideAttribution({
      practitionerId: 'Y',
      listEntryAddedAt: D(5),
      firstBookingAt: D(5),
      referralTouches: [],
    });

    expect(decision.owner).toBe('NHP');
  });
});

describe('decideAttribution — cross-referral', () => {
  it('spec §9 test 10 — a link opened on day 3 and paid on day 4 is cross-referred from the OPEN', () => {
    const decision = decideAttribution({
      practitionerId: 'Y',
      listEntryAddedAt: null,
      firstBookingAt: D(4),
      referralTouches: [touch({ touchId: 't1', referrerPractitionerId: 'X', receivedAt: D(3) })],
    });

    expect(decision.owner).toBe('NHP');
    expect(decision.decidedByRule).toBe('CROSS_REFERRED');
    expect(decision.referrerPractitionerId).toBe('X');
    expect(decision.referralTouchId).toBe('t1');
  });

  it('spec §9 test 11 — Y adding the client AFTER the referral cannot take the referrer’s share', () => {
    // Link opened day 3; Y adds C to their own list at day 3.5; C pays day 4.
    // The cutoff is min(B, R) = the referral, so Y's entry is too late.
    const decision = decideAttribution({
      practitionerId: 'Y',
      listEntryAddedAt: D(3, 12),
      firstBookingAt: D(4),
      referralTouches: [touch({ touchId: 't1', referrerPractitionerId: 'X', receivedAt: D(3) })],
    });

    expect(decision.owner).toBe('NHP');
    expect(decision.decidedByRule).toBe('CROSS_REFERRED');
    expect(decision.referrerPractitionerId).toBe('X');
  });

  it('spec §9 test 12 — a list entry that predates the referral wins, and no referrer is named', () => {
    const decision = decideAttribution({
      practitionerId: 'Y',
      listEntryAddedAt: D(0),
      firstBookingAt: D(5),
      referralTouches: [touch({ touchId: 't1', referrerPractitionerId: 'X', receivedAt: D(3) })],
    });

    expect(decision.owner).toBe('PRACTITIONER');
    expect(decision.referrerPractitionerId).toBeNull();
    expect(decision.referralTouchId).toBeNull();
  });

  it('spec §9 test 14 — with two referrals of the same client, the EARLIEST received wins', () => {
    const decision = decideAttribution({
      practitionerId: 'Y',
      listEntryAddedAt: null,
      firstBookingAt: D(10),
      referralTouches: [
        touch({ touchId: 't2', referrerPractitionerId: 'X2', receivedAt: D(5) }),
        touch({ touchId: 't1', referrerPractitionerId: 'X1', receivedAt: D(3) }),
      ],
    });

    expect(decision.referrerPractitionerId).toBe('X1');
    expect(decision.referralTouchId).toBe('t1');
  });

  it('breaks a same-instant tie DETERMINISTICALLY on touch id, so two runs cannot pay different people', () => {
    const same = D(3);
    const first = decideAttribution({
      practitionerId: 'Y',
      listEntryAddedAt: null,
      firstBookingAt: D(10),
      referralTouches: [
        touch({ touchId: 'b', referrerPractitionerId: 'XB', receivedAt: same }),
        touch({ touchId: 'a', referrerPractitionerId: 'XA', receivedAt: same }),
      ],
    });
    const reversed = decideAttribution({
      practitionerId: 'Y',
      listEntryAddedAt: null,
      firstBookingAt: D(10),
      referralTouches: [
        touch({ touchId: 'a', referrerPractitionerId: 'XA', receivedAt: same }),
        touch({ touchId: 'b', referrerPractitionerId: 'XB', receivedAt: same }),
      ],
    });

    expect(first.referrerPractitionerId).toBe('XA');
    expect(reversed.referrerPractitionerId).toBe('XA');
  });

  it('ignores a referral whose referrer IS the booked practitioner — nobody is paid for referring to themselves', () => {
    const decision = decideAttribution({
      practitionerId: 'Y',
      listEntryAddedAt: null,
      firstBookingAt: D(4),
      referralTouches: [touch({ touchId: 't1', referrerPractitionerId: 'Y', receivedAt: D(3) })],
    });

    expect(decision.owner).toBe('NHP');
    expect(decision.decidedByRule).toBe('NHP_SOURCED');
    expect(decision.referrerPractitionerId).toBeNull();
  });

  it('a self-referral does not enter the cutoff either — it cannot make a later list entry too late', () => {
    // Y's own "referral" received day 3, Y's list entry day 3.5, booking day 4. If the self-referral
    // counted toward min(B, R) the client would be NHP-sourced; it must not.
    const decision = decideAttribution({
      practitionerId: 'Y',
      listEntryAddedAt: D(3, 12),
      firstBookingAt: D(4),
      referralTouches: [touch({ touchId: 't1', referrerPractitionerId: 'Y', receivedAt: D(3) })],
    });

    expect(decision.owner).toBe('PRACTITIONER');
  });

  it('spec §9 test 8 — the referrer needs no session with the client of their own (R9)', () => {
    // Nothing in the input carries X's own booking history, by construction: R9 says a referral
    // earns regardless. This asserts the shape — if a future change adds such a precondition it
    // has to add a field, and this test is where that decision surfaces.
    const decision = decideAttribution({
      practitionerId: 'Y',
      listEntryAddedAt: null,
      firstBookingAt: D(4),
      referralTouches: [touch({ touchId: 't1', referrerPractitionerId: 'X', receivedAt: D(3) })],
    });

    expect(decision.decidedByRule).toBe('CROSS_REFERRED');
  });
});

describe('eligibleReferralTouches — expiry', () => {
  it('spec §9 test 15 — a touch received after its referral expired is not eligible', () => {
    const rows = [
      {
        touchId: 't1',
        referrerPractitionerId: 'X',
        receivedAt: D(250),
        expiresAt: D(240),
      },
    ];

    expect(eligibleReferralTouches(rows, 'Y')).toEqual([]);
  });

  it('judges expiry against when the referral was RECEIVED, not when the client eventually booked', () => {
    // Opened inside the term, paid after it. The introduction demonstrably happened while the
    // link was live, and §5.4.7 gates the link at OPEN — so this stays eligible. Judging it at
    // booking time would silently unpay a referrer whose referral worked.
    const rows = [
      {
        touchId: 't1',
        referrerPractitionerId: 'X',
        receivedAt: D(239),
        expiresAt: D(240),
      },
    ];

    expect(eligibleReferralTouches(rows, 'Y').map((r) => r.touchId)).toEqual(['t1']);
  });

  it('drops a touch with no receivedAt — an unattached link open is not yet a referral of anyone', () => {
    const rows = [
      {
        touchId: 't1',
        referrerPractitionerId: 'X',
        receivedAt: null,
        expiresAt: D(240),
      },
    ];

    expect(eligibleReferralTouches(rows, 'Y')).toEqual([]);
  });
});
