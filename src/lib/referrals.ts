/**
 * ISSUING AND OPENING REFERRALS (spec v1.4 §5.3, §5.4, R12).
 *
 * Two channels, differing in exactly one respect — WHEN the referral becomes attached to a client,
 * which is the timestamp the earliest-touch lock compares against and therefore decides money:
 *
 *   EMAIL — attached at SEND. `receivedAt = openedAt = emailSentAt = now`, because we already know
 *           who it went to.
 *   LINK  — attached at OPEN. A copied link is tied to nobody until somebody opens it, so the first
 *           open is the earliest point it can be attributed to them (§5.4). Y's own list entry must
 *           predate that instant to exempt the client (R5), which is why the touch is written at
 *           `/r/<token>` rather than at payment: writing it later would let Y list a client
 *           mid-flow and take the referrer's share.
 *
 * ⚠️ TWO DIFFERENT TOKENS, AND CONFLATING THEM WOULD BE A LEAK. `Referral.token` is X's and
 * addresses `/r/<token>`; `ReferralTouch.touchToken` is per-visitor and is what rides the booking
 * URL as `?nhpr=`. If the referral token travelled onward, one client could forward another
 * client's link and resolve to the same row.
 *
 * ⚠️ THE PARAM IS `nhpr`, NEVER `ref`. `?ref=` already means the opposite thing — a practitioner
 * tagging their OWN audience, which resolves to 0% (canon D18). A referral link carrying it would
 * make every cross-referral free and pay the referrer nothing.
 */

import { addMonths } from './attribution-term';
import { hashClientEmail } from './attributed-clients';
import { normalizeEmail } from './email';
import { SITE_URL } from './site';
import { newToken } from './tokens';

export { REFERRAL_PARAM } from './referral-param';

export type ReferralsDb = {
  referral: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    create(args: any): Promise<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findUnique(args: any): Promise<any>;
  };
  referralTouch: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    create(args: any): Promise<any>;
  };
  clientListEntry: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    upsert(args: any): Promise<any>;
  };
};

/**
 * The public address of a referral.
 *
 * SITE_URL rather than an env read: `NEXT_PUBLIC_BASE_URL` is deliberately unset on Vercel, so
 * `process.env.X ?? fallback` would not be a fallback — it would silently BE the value. This link
 * is pasted into messages by practitioners and has to be the apex domain, not a deployment alias
 * that stops resolving after the next deploy.
 */
export function referralUrl(token: string): string {
  return `${SITE_URL}/r/${token}`;
}

function assertDistinct(referrerId: string, referredId: string): void {
  if (referrerId === referredId) {
    throw new Error('USER:You cannot refer a client to yourself.');
  }
}

export async function createReferralLink(
  db: ReferralsDb,
  input: { referrerId: string; referredId: string; termMonths: number; at?: Date },
): Promise<{ id: string; token: string; url: string; expiresAt: Date }> {
  assertDistinct(input.referrerId, input.referredId);
  const at = input.at ?? new Date();
  const expiresAt = addMonths(at, input.termMonths);

  const referral = await db.referral.create({
    data: {
      token: newToken(),
      referrerId: input.referrerId,
      referredId: input.referredId,
      channel: 'LINK',
      issuedAt: at,
      // SNAPSHOTTED (R12, §9 test 19). An operator shortening the admin term must not expire links
      // already handed out, and lengthening it must not revive dead ones.
      termMonths: input.termMonths,
      expiresAt,
      status: 'ISSUED',
    },
  });

  // NO TOUCH AND NO LIST ENTRY YET. §5.4.1: the link is not tied to a client at all, and one link
  // may reach several. Creating either here would attribute the referral to a person nobody has
  // identified — and would put an addedAt on X's list that R5 then compares against.
  return {
    id: referral.id,
    token: referral.token,
    url: referralUrl(referral.token),
    expiresAt,
  };
}

export async function createEmailReferral(
  db: ReferralsDb,
  input: {
    referrerId: string;
    referredId: string;
    clientEmail: string;
    clientName: string | null;
    note: string | null;
    termMonths: number;
    at?: Date;
  },
): Promise<{ id: string; token: string; url: string; clientEmail: string; expiresAt: Date }> {
  assertDistinct(input.referrerId, input.referredId);
  const email = normalizeEmail(input.clientEmail);
  // Validated BEFORE any write. A rejected address that had already created a Referral would leave
  // an issued, unsendable link counting against nothing.
  if (!email) throw new Error('USER:That does not look like a valid email address.');

  const at = input.at ?? new Date();
  const expiresAt = addMonths(at, input.termMonths);
  const emailHash = hashClientEmail(email);

  const referral = await db.referral.create({
    data: {
      token: newToken(),
      referrerId: input.referrerId,
      referredId: input.referredId,
      channel: 'EMAIL',
      note: input.note?.trim() || null,
      issuedAt: at,
      termMonths: input.termMonths,
      expiresAt,
      status: 'SENT',
      emailSentAt: at,
    },
  });

  await db.referralTouch.create({
    data: {
      referralId: referral.id,
      touchToken: newToken(),
      openedAt: at,
      clientEmail: email,
      clientEmailHash: emailHash,
      // ATTACHED AT SEND — the email channel's defining property. We know who it went to, so the
      // referral is received the moment it leaves.
      receivedAt: at,
      status: 'OPENED',
    },
  });

  // §5.3.2 — C joins X's OWN list. This is also what makes X's later sight of the address legal
  // under the privacy ruling: "referred that client themselves" is one of the four permitted ways.
  await db.clientListEntry.upsert({
    where: { practitionerId_emailHash: { practitionerId: input.referrerId, emailHash } },
    create: {
      practitionerId: input.referrerId,
      email,
      emailHash,
      name: input.clientName?.trim() || null,
      addedAt: at,
      source: 'REFERRAL_MADE',
    },
    // Never moves `addedAt` — see `addClientEntries`. If C was already on X's list, referring them
    // must not reset the lock that governs X's OWN fees on them.
    update: {},
  });

  return { id: referral.id, token: referral.token, url: referralUrl(referral.token), clientEmail: email, expiresAt };
}

export type ReferralOpen = {
  /** Where to send the visitor. Null when there is nothing to send them to. */
  redirectSlug: string | null;
  /** What rides the URL onward as `?nhpr=`. Null when no referral was recorded. */
  touchToken: string | null;
  /** The touch row's id — what the signed fallback cookie carries. Null with `touchToken`. */
  touchId: string | null;
  /** The practitioner the referral was FOR, so the cookie can be scoped to them. */
  referredId: string | null;
  reason: 'RECORDED' | 'EXPIRED' | 'UNKNOWN' | 'GONE';
};

/**
 * What `/r/<token>` does (§5.4.3, §5.4.7).
 *
 * After expiry the link STILL WORKS as a link — it just records nothing. That asymmetry is spec'd:
 * "the link still goes to Y's page, but no referral is recorded". Dead-ending the visitor would
 * punish the client for the referrer's timing.
 */
export async function resolveReferralOpen(
  db: ReferralsDb,
  input: { token: string; at?: Date },
): Promise<ReferralOpen> {
  const at = input.at ?? new Date();

  const referral = await db.referral.findUnique({
    where: { token: input.token },
    select: {
      id: true,
      referrerId: true,
      referredId: true,
      expiresAt: true,
      referred: { select: { slug: true } },
    },
  });

  if (!referral) {
    return { redirectSlug: null, touchToken: null, touchId: null, referredId: null, reason: 'UNKNOWN' };
  }
  if (!referral.referred) {
    return { redirectSlug: null, touchToken: null, touchId: null, referredId: null, reason: 'GONE' };
  }

  if (at.getTime() >= referral.expiresAt.getTime()) {
    return {
      redirectSlug: referral.referred.slug,
      touchToken: null,
      touchId: null,
      referredId: referral.referredId,
      reason: 'EXPIRED',
    };
  }

  const touchToken = newToken();
  const touch = await db.referralTouch.create({
    data: {
      referralId: referral.id,
      touchToken,
      openedAt: at,
      // §5.4, "why received_at = opened_at": a copied link is tied to nobody, so the first open is
      // the earliest point the referral can be attached to this person. R5 compares Y's list entry
      // against THIS instant.
      receivedAt: at,
      clientEmail: null,
      clientEmailHash: null,
      status: 'OPENED',
    },
  });

  return {
    redirectSlug: referral.referred.slug,
    touchToken,
    touchId: touch.id,
    referredId: referral.referredId,
    reason: 'RECORDED',
  };
}
