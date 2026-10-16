import type { PrismaClient } from '@prisma/client';

type SlugLookup = Pick<PrismaClient, 'practitioner'>;

export function slugBase(text: string): string {
  return (
    text
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/, '') || 'practitioner'
  );
}

/** `base`, or `base-1`, `base-2`… — the first slug no OTHER practitioner holds. */
export async function uniqueSlug(db: SlugLookup, base: string, ownerId?: string): Promise<string> {
  let slug = base;
  for (let suffix = 1; ; suffix++) {
    const holder = await db.practitioner.findUnique({ where: { slug }, select: { id: true } });
    if (!holder || holder.id === ownerId) return slug;
    slug = `${base}-${suffix}`;
  }
}

/**
 * The display name earlier builds derived from the email's local part ("kbbunny81@…" →
 * "Kbbunny"). Onboarding no longer writes one; this recognises the ones already stored so the
 * form can ask for a real name instead of prefilling the email-derived one.
 */
export function emailDerivedName(email: string): string {
  return email
    .split('@')[0]
    .split(/[^a-z]+/i)
    .filter(Boolean)
    .map((p) => p[0]!.toUpperCase() + p.slice(1).toLowerCase())
    .join(' ');
}

/** Never drafted: onboarding has not been submitted, so nothing public refers to the slug yet. */
export function isNeverDrafted(p: {
  bio: string | null;
  headline: string | null;
  specialties: unknown[];
}): boolean {
  return !p.bio?.trim() && !p.headline?.trim() && p.specialties.length === 0;
}

/**
 * Still the row onboarding created and nothing else: never drafted, a blank or email-derived name,
 * and nothing that may carry the slug outside the app (booking links and intents, Whop account,
 * products, plan checkout or membership, custom sections). Only such a row may have its slug
 * regenerated from the practitioner's typed name.
 */
export function isPlaceholderProfile(
  p: {
    bio: string | null;
    headline: string | null;
    specialties: unknown[];
    displayName: string;
    plan: string | null;
    subscriptionStatus: string;
    whopCompanyId: string | null;
    whopMembershipId: string | null;
    whopSubscriptionCheckoutUrl: string | null;
    _count: { bookingLinks: number; bookingIntents: number; whopProducts: number; profileSections: number };
  },
  email: string,
): boolean {
  const name = p.displayName.trim();
  return (
    isNeverDrafted(p) &&
    (name === '' || (!!email && name === emailDerivedName(email))) &&
    p.plan === null &&
    p.subscriptionStatus === 'NONE' &&
    !p.whopCompanyId &&
    !p.whopMembershipId &&
    !p.whopSubscriptionCheckoutUrl &&
    Object.values(p._count).every((n) => n === 0)
  );
}
