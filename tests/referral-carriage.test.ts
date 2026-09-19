import { describe, expect, it } from 'vitest';

import {
  REFERRAL_COOKIE,
  resolveReferralCarriage,
  signReferralCookie,
  verifyReferralCookie,
} from '@/lib/referral-cookie';
import { bookingLinkTarget, chooserOptionTarget, offeringTarget } from '@/lib/profile-ctas';

/**
 * CARRYING A REFERRAL FROM THE LINK TO THE BOOKING (spec v1.4 §5.4.5) — "the fragile step".
 *
 * The rule: THE CARRIER IS A ROW IN OUR DATABASE FROM THE FIRST MILLISECOND. `/r/<token>` writes a
 * `ReferralTouch` before redirecting anywhere; the URL is a pointer to it, the cookie is a fallback
 * for one scenario, and the Whop metadata is reconciliation. After the booking intent stores
 * `referralTouchId`, all three are redundant — which is the property §5.4.5 asks for and the reason
 * this is not cookie-only (§10: "attribution relies only on events NHP records, not on cookies").
 *
 * ⚠️ THE PARAM IS `nhpr`. `?ref=` is already taken by lead attribution and means the OPPOSITE
 * thing — a practitioner tagging their own audience, which resolves to 0% (canon D18). A referral
 * link carrying `?ref=` would make every cross-referral free and pay the referrer nothing.
 */

const SECRET = 'test-secret-value';
const NOW = Date.UTC(2026, 0, 10);

describe('the referral cookie is signed, scoped and expiring', () => {
  it('round-trips a touch through a signature', async () => {
    const raw = await signReferralCookie({ touchId: 't1', referredId: 'Y', ts: NOW }, SECRET);
    expect(await verifyReferralCookie(raw, SECRET, NOW)).toEqual({
      touchId: 't1',
      referredId: 'Y',
      ts: NOW,
    });
  });

  it('refuses a tampered payload — HttpOnly stops a script READING it, not a client SENDING one', async () => {
    const raw = await signReferralCookie({ touchId: 't1', referredId: 'Y', ts: NOW }, SECRET);
    const forged = raw.replace(/^[^.]+/, (p) =>
      Buffer.from(JSON.stringify({ touchId: 'other', referredId: 'Y', ts: NOW })).toString('base64url'),
    );

    expect(await verifyReferralCookie(forged, SECRET, NOW)).toBeNull();
  });

  it('refuses a cookie signed with a different secret', async () => {
    const raw = await signReferralCookie({ touchId: 't1', referredId: 'Y', ts: NOW }, 'other-secret');
    expect(await verifyReferralCookie(raw, SECRET, NOW)).toBeNull();
  });

  it('expires — a referral cookie outlives its usefulness, not its term', async () => {
    const raw = await signReferralCookie({ touchId: 't1', referredId: 'Y', ts: NOW }, SECRET);
    const wayLater = NOW + 400 * 86_400_000;
    expect(await verifyReferralCookie(raw, SECRET, wayLater)).toBeNull();
  });

  it('is named distinctly from the lead-attribution cookie, which means the opposite thing', () => {
    expect(REFERRAL_COOKIE).toBe('nhp_ref');
    expect(REFERRAL_COOKIE).not.toBe('nhp_attr');
  });
});

describe('resolveReferralCarriage', () => {
  function db(touches: Array<Record<string, unknown>>) {
    const queries: unknown[] = [];
    return {
      queries,
      referralTouch: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async findFirst(args: any) {
          queries.push(args);
          return (
            touches.find((t) => {
              const referral = (t as { referral: { referredId: string; expiresAt: Date } }).referral;
              const byToken = args.where.touchToken ? t.touchToken === args.where.touchToken : true;
              const byId = args.where.id ? t.id === args.where.id : true;
              const forPractitioner = referral.referredId === args.where.referral.referredId;
              // ⚠️ HONOUR THE EXPIRY FILTER. A fake that ignored `expiresAt: { gt }` would return
              // a dead referral and the expiry test would pass against an implementation that
              // never checked — a fake weaker than production asserts nothing.
              const live =
                referral.expiresAt.getTime() >
                (args.where.referral.expiresAt.gt as Date).getTime();
              return byToken && byId && forPractitioner && live;
            }) ?? null
          );
        },
      },
    };
  }

  const touch = (over: Record<string, unknown> = {}) => ({
    id: 't1',
    touchToken: 'ttok',
    referral: { referredId: 'Y', expiresAt: new Date(Date.UTC(2026, 8, 1)) },
    ...over,
  });

  it('prefers the URL and records that it came from there', async () => {
    const result = await resolveReferralCarriage(db([touch()]), {
      practitionerId: 'Y',
      paramToken: 'ttok',
      cookieValue: undefined,
      secret: SECRET,
      at: new Date(NOW),
    });

    expect(result).toEqual({ referralTouchId: 't1', carriage: 'URL' });
  });

  it('spec §9 test 13 — falls back to the cookie when the visitor returns without the param', async () => {
    const cookie = await signReferralCookie({ touchId: 't1', referredId: 'Y', ts: NOW }, SECRET);
    const result = await resolveReferralCarriage(db([touch()]), {
      practitionerId: 'Y',
      paramToken: null,
      cookieValue: cookie,
      secret: SECRET,
      at: new Date(NOW + 2 * 86_400_000),
    });

    expect(result).toEqual({ referralTouchId: 't1', carriage: 'COOKIE' });
  });

  it('spec §9 test 13 — records NONE when neither survives, so the outcome is logged either way', async () => {
    const result = await resolveReferralCarriage(db([touch()]), {
      practitionerId: 'Y',
      paramToken: null,
      cookieValue: undefined,
      secret: SECRET,
      at: new Date(NOW),
    });

    expect(result).toEqual({ referralTouchId: null, carriage: 'NONE' });
  });

  it('ignores a cookie whose referral was for a DIFFERENT practitioner', async () => {
    // A visitor referred to Y and then browsing to Z must not pay Y's referrer out of Z's session.
    const cookie = await signReferralCookie({ touchId: 't1', referredId: 'Y', ts: NOW }, SECRET);
    const result = await resolveReferralCarriage(db([touch()]), {
      practitionerId: 'Z',
      paramToken: null,
      cookieValue: cookie,
      secret: SECRET,
      at: new Date(NOW),
    });

    expect(result).toEqual({ referralTouchId: null, carriage: 'NONE' });
  });

  it('RE-VALIDATES a URL token server-side against the practitioner being booked', async () => {
    // The param is attacker-controllable. A token minted for a different practitioner must not
    // attach here — otherwise anyone could paste a referral token onto any booking URL.
    const result = await resolveReferralCarriage(
      db([touch({ referral: { referredId: 'SOMEONE_ELSE', expiresAt: new Date(Date.UTC(2026, 8, 1)) } })]),
      {
        practitionerId: 'Y',
        paramToken: 'ttok',
        cookieValue: undefined,
        secret: SECRET,
        at: new Date(NOW),
      },
    );

    expect(result).toEqual({ referralTouchId: null, carriage: 'NONE' });
  });

  it('refuses a token whose referral has since expired', async () => {
    const result = await resolveReferralCarriage(
      db([touch({ referral: { referredId: 'Y', expiresAt: new Date(Date.UTC(2025, 0, 1)) } })]),
      {
        practitionerId: 'Y',
        paramToken: 'ttok',
        cookieValue: undefined,
        secret: SECRET,
        at: new Date(NOW),
      },
    );

    expect(result.referralTouchId).toBeNull();
  });

  it('degrades to NONE rather than throwing when no signing secret is configured', async () => {
    const cookie = await signReferralCookie({ touchId: 't1', referredId: 'Y', ts: NOW }, SECRET);
    const result = await resolveReferralCarriage(db([touch()]), {
      practitionerId: 'Y',
      paramToken: null,
      cookieValue: cookie,
      secret: undefined,
      at: new Date(NOW),
    });

    expect(result.carriage).toBe('NONE');
  });
});

describe('the referral rides the three — and only three — booking URL builders', () => {
  const link = { id: 'link_1', label: null, url: 'https://cal.com/x', ctaLabel: null };
  const offering = {
    id: 'o1',
    title: 't',
    priceUsdCents: 100,
    duration: null,
    isConsult: false,
    bookingLinkId: null,
    listingVisibility: 'LISTED' as const,
  };

  it('bookingLinkTarget carries nhpr', () => {
    const target = bookingLinkTarget('dr-y', link, [], 'ttok');
    expect(target).toMatchObject({ kind: 'flow' });
    expect((target as { href: string }).href).toContain('nhpr=ttok');
  });

  it('offeringTarget carries nhpr', () => {
    const href = offeringTarget('dr-y', offering, 'ttok');
    expect(href).toContain('nhpr=ttok');
  });

  it('chooserOptionTarget carries nhpr into the flow', () => {
    const href = chooserOptionTarget(
      'dr-y',
      'link_1',
      { id: 'o1', listingVisibility: 'LINK_ONLY' },
      'ttok',
    );
    expect(href).toContain('nhpr=ttok');
  });

  it('omits the param entirely when there is no referral — no empty nhpr= in a shared URL', () => {
    expect((bookingLinkTarget('dr-y', link, []) as { href: string }).href).not.toContain('nhpr');
    expect(offeringTarget('dr-y', offering)).not.toContain('nhpr');
  });

  it('never emits ?ref= — that param means the opposite thing (canon D18)', () => {
    const href = (bookingLinkTarget('dr-y', link, [], 'ttok') as { href: string }).href;
    expect(href).not.toMatch(/[?&]ref=/);
  });
});

describe('a referral arrival is labelled NHP, not the practitioner’s own audience', () => {
  it('⚠️ LOAD-BEARING AND INVISIBLE — /r/<token> resolves to DIRECTORY, so the /r hop is required', async () => {
    const { resolveAttribution } = await import('@/lib/attribution');

    // Rule 3: anything that is not a practitioner's own profile page is the DIRECTORY, and ours.
    const viaReferralRoute = resolveAttribution({
      pathname: '/r/some-token',
      searchParams: new URLSearchParams(),
      referrer: null,
      selfHost: 'naturalhealthpros.com',
      now: NOW,
    });
    expect(viaReferralRoute.party).toBe('NHP');
    expect(viaReferralRoute.source).toBe('DIRECTORY');

    // WITHOUT the /r hop — a link straight to the profile — the SAME visitor resolves to
    // PRACTITIONER, i.e. the practitioner's own audience at 0%. That is the exact opposite of R7,
    // and middleware's first-touch-wins rule is what makes the /r hop decide it. Linking a
    // referral directly at a profile would silently make every cross-referral free.
    const straightToProfile = resolveAttribution({
      pathname: '/practitioners/dr-y',
      searchParams: new URLSearchParams(),
      referrer: null,
      selfHost: 'naturalhealthpros.com',
      now: NOW,
    });
    expect(straightToProfile.party).toBe('PRACTITIONER');
  });
});
