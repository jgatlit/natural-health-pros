/**
 * The two names a referral travels under. A LEAF MODULE ON PURPOSE — no imports at all.
 *
 * `profile-ctas.ts` is imported by every server component that renders a booking CTA, and it is
 * one `'use client'` away from being bundled for the browser. Importing `referrals.ts` for a
 * string constant would drag `node:crypto`, Prisma-adjacent helpers and `SITE_URL` into that
 * graph — the same import-weight problem that blew Vercel's 1 MB Edge limit when middleware
 * reached the Prisma-backed auth module.
 *
 * ⚠️ `nhpr`, NEVER `ref`. `?ref=` already means a practitioner tagging their OWN audience, which
 * resolves to 0% commission (canon D18). A referral link carrying it would make every
 * cross-referral free and pay the referrer nothing — the exact opposite outcome, from a
 * three-character difference.
 */

/** The query parameter carrying a `ReferralTouch.touchToken` through the booking flow. */
export const REFERRAL_PARAM = 'nhpr';

/**
 * The signed, HttpOnly fallback cookie. Distinct from `nhp_attr` (lead attribution), which carries
 * the opposite meaning and must never be confused with this one.
 */
export const REFERRAL_COOKIE = 'nhp_ref';
