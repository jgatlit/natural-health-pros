/*
 * Client-authored landing copy, supplied 2026-08-10 by Holistic Health Network, LLC / HHE.
 *
 * Strings in this file are the client's words. The disclaimer and the
 * scope-of-service ("is / is not") blocks are use-as-written and must not be
 * paraphrased — they carry legal weight. Anything the build team wrote is
 * marked `authoredByBuild: true` and is safe to revise.
 *
 * Source: docs/brand/2026-08-10-client-landing-copy.md.
 *
 * ⚠️ Four of these claims have NO SUPPORTING DATA in production, measured
 * 2026-08-10. They were briefly held, then RESTORED AS WRITTEN by operator
 * decision on the same day: this is the client's document, and the client owns
 * the claim. They are flagged rather than softened, and are pending a joint
 * Jonathan + Amy review — see docs/brand/CLAIMS-REVIEW-JONATHAN-AMY.md.
 *
 *   priceBand          0 of 13 practitioners priced; 0 Offering rows exist
 *   trustRow[0]        hheCertified is @default(true); no code path sets it
 *   trustRow[2]        1 of 13 has a booking link
 *   scopeOfService.is  no in-area inventory; 13 of 13 are virtual
 *
 * Each carries an inline marker below. The acceptance test that would make each
 * one TRUE is in docs/brand/2026-08-10-client-landing-copy.md → "Re-enable
 * conditions". Do not treat their presence here as evidence they are accurate.
 */

export const hero = {
  title: 'Natural Health Professional Directory',
  subhead: 'Affordable, life-changing holistic health services at your fingertips',
  body: 'Access Certified Holistic Health Coaches, Holistic Health Practitioners, Therapeutic Nutritional Counselors, National Board Certified Health & Wellness Coaches, Emotion Code Practitioners, FLY Facilitators, Gut Health Specialists, Live Blood Microscopy Specialists, and more.',
  positioningLine:
    "No need to find your alternatives to mainstream medicine through TikTok, ChatGPT, or your grandma's old medicine cabinet.",
  primaryCta: 'Book a session with a trained professional in the health and wellness field.',
  wordmark: 'Natural Health Pros',
  /** UNSUBSTANTIATED (2026-08-10): 0 of 13 listed practitioners have a price set,
   *  and 0 Offering rows exist. Client's wording, restored on operator decision. */
  priceBand: 'Sessions from $29 – $219+',
} as const;

/*
 * Client's wording, restored as written 2026-08-10.
 *
 * Row 0 "Training and credential-verified" — UNSUBSTANTIATED. `hheCertified` is
 *   `@default(true)` in prisma/schema.prisma and no code path ever sets it, so
 *   this asserts a verification step that has never run for any practitioner.
 *   It is also the product's core value proposition, which makes it the most
 *   expensive of the four to be wrong about.
 * Row 2 "Easy scheduling" — UNSUBSTANTIATED. 1 of 13 listed practitioners has a
 *   booking link.
 */
export const trustRow = [
  'Training and credential-verified',
  'Affordable pricing',
  'Easy scheduling',
  'Searchable directory',
] as const;

export const scopeOfService = {
  isHeading: 'Natural Health Pros is:',
  is: [
    // UNSUBSTANTIATED: "in your area" has no inventory behind it — 13 of 13
    // listed practitioners are Virtual Practice, and only 2 City rows have any
    // practitioner at all. Client's wording, restored on operator decision.
    'A searchable directory that helps you find trained holistic health professionals (virtually or in your area).',
    'A place to book sessions directly with independent practitioners.',
    "A way to see a variety of practitioners' training, specialty, and pricing before you book.",
  ],
  isNotHeading: 'Natural Health Pros is not:',
  isNot: [
    'A doctor’s office, medical clinic, or medical provider, or a replacement for your doctor or for medical care.',
    'The employer of the practitioners — each one works independently and is responsible for their own services.',
    'A guarantee of any specific health result.',
  ],
} as const;

export const socialProofMotif = '♥ Supported Professionals ♥ Happy Consumers';

export const footerIdentity = [
  'Natural Health Pros is the professional online directory for Holistic Health Network, LLC, which works in tandem with Holistic Health Educators, PMA, to elevate the standard of education and care among holistic health professionals, and to ensure greater access to these life-changing services for consumers.',
  'Practitioners listed with Natural Health Pros have received formal training in their specialty. Each practitioner is an independent provider.',
] as const;

/** USE AS WRITTEN. Do not paraphrase, truncate, or reflow into bullets. */
export const disclaimer =
  'DISCLAIMER: This is not a replacement for medical care. The practitioners listed in this directory provide holistic and complementary services that are not intended to diagnose, treat, cure, or prevent any disease. Always consult your physician or a qualified healthcare provider before making changes to your health, and never disregard or delay professional medical advice because of something you accessed through this site. If you are experiencing a medical emergency, call 911.';

/** Layer X — the practitioner-acquisition funnel. Build-authored copy. */
export const getListed = {
  authoredByBuild: true,
  eyebrow: 'For practitioners',
  heading: 'Trained through HHE? Take the listing.',
  body: 'Your listing carries your training, your specialties, your own booking link, and your own prices. You keep the client relationship — Natural Health Pros just makes you findable.',
  price: '$39',
  interval: 'per month',
  bullets: [
    'A profile page you control, with your photo, bio, and specialties',
    'Your own scheduling link — Cal.com, Calendly, Acuity, whatever you already use',
    'Listed in search the moment your profile is complete',
  ],
  cta: 'Get listed',
  secondary: 'Already listed? Sign in',
} as const;
