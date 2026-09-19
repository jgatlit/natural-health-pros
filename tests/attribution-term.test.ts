import { describe, expect, it } from 'vitest';

import { addMonths, holdExpiry, isChargeable, snapshotTerm, termState } from '@/lib/attribution-term';

/**
 * The term is the number the whole fee model hangs off, so its EDGES are tested directly rather
 * than inferred from a fee assertion. Every case here maps to spec v1.4 §9 or to an operator
 * ruling of 2026-09-18.
 */
describe('lead attribution term', () => {
  it('adds whole calendar months, not 30-day blocks', () => {
    expect(addMonths(new Date('2026-01-15T00:00:00Z'), 8).toISOString()).toBe(
      '2026-09-15T00:00:00.000Z',
    );
  });

  it('clamps to the end of a short month instead of spilling into the next one', () => {
    // 31 Jan + 1 month is 28 Feb, NOT 3 March. Naive date maths gives the practitioner three
    // extra days of term, on every row, forever.
    expect(addMonths(new Date('2026-01-31T00:00:00Z'), 1).toISOString()).toBe(
      '2026-02-28T00:00:00.000Z',
    );
    expect(addMonths(new Date('2024-01-31T00:00:00Z'), 1).toISOString()).toBe(
      '2024-02-29T00:00:00.000Z',
    );
  });

  it('anchors on the first booked session, not on the payment', () => {
    const snap = snapshotTerm({ termMonths: 8, anchorAt: new Date('2026-03-01T00:00:00Z') });
    expect(snap.termAnchorAt?.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(snap.termEndsAt?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('leaves the clock unstarted when no session is scheduled yet', () => {
    const snap = snapshotTerm({ termMonths: 8, anchorAt: null });
    expect(snap.termEndsAt).toBeNull();
    expect(termState({ termAnchorAt: null, termEndsAt: null })).toBe('PENDING_ANCHOR');
    // A term cannot expire before it begins — an unanchored claim still charges.
    expect(isChargeable('PENDING_ANCHOR')).toBe(true);
  });

  it('treats month 8 of an 8-month term as OUTSIDE it (§9 test 3)', () => {
    const anchor = new Date('2026-01-15T00:00:00Z');
    const { termAnchorAt, termEndsAt } = snapshotTerm({ termMonths: 8, anchorAt: anchor });
    const row = { termAnchorAt, termEndsAt };

    // months 0, 3, 6 — inside, all chargeable
    expect(termState(row, anchor)).toBe('IN_TERM');
    expect(termState(row, addMonths(anchor, 3))).toBe('IN_TERM');
    expect(termState(row, addMonths(anchor, 6))).toBe('IN_TERM');
    // the boundary instant itself is OUT. This exclusive `<` is the off-by-one that moves money.
    expect(termState(row, addMonths(anchor, 8))).toBe('OUT_OF_TERM');
    expect(termState(row, addMonths(anchor, 9))).toBe('OUT_OF_TERM');
    // and one millisecond before it is still IN
    expect(termState(row, new Date(addMonths(anchor, 8).getTime() - 1))).toBe('IN_TERM');
  });

  it('reports a client we have never seen as NONE, not as expired', () => {
    // NONE means "this session introduces them" and CHARGES. Collapsing it into OUT_OF_TERM would
    // make every genuinely new client free.
    expect(termState(null)).toBe('NONE');
    expect(isChargeable('NONE')).toBe(true);
    expect(isChargeable('OUT_OF_TERM')).toBe(false);
  });

  it('holds a referral share for 90 days from the day it could not be paid', () => {
    // Operator ruling 7, 2026-09-18. Per ROW: two shares owed on different days lapse on
    // different days.
    const owedJan = holdExpiry(new Date('2026-01-01T00:00:00Z'), 90);
    const owedFeb = holdExpiry(new Date('2026-02-01T00:00:00Z'), 90);
    expect(owedJan.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(owedFeb.toISOString()).toBe('2026-05-02T00:00:00.000Z');
    expect(owedJan.getTime()).not.toBe(owedFeb.getTime());
  });

  it('refuses a nonsense term or hold rather than silently charging forever', () => {
    expect(() => snapshotTerm({ termMonths: 0, anchorAt: new Date() })).toThrow(/positive integer/);
    expect(() => holdExpiry(new Date(), 0)).toThrow(/positive integer/);
  });
});
