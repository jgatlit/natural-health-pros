/**
 * Route description manifest — consumed by scripts/generate-routes-index.ts.
 * Add a new entry here when introducing a new route. The generator warns
 * (and exits non-zero in CI) when a discovered route has no metadata.
 */

export type Audience = 'public' | 'auth' | 'admin' | 'api';
export type Status = 'live' | 'scaffold' | 'not-yet';

export type RouteMeta = {
  /** One-paragraph description rendered on the routes-index.html card. Use **strong** for emphasis. */
  description: string;
  /** Drives the section grouping + badge color. */
  audience: Audience;
  /** Drives the "Live" / "Scaffold" / "Not yet" badge. */
  status: Status;
  /** Concrete URL for the demo link. If route has [param] segments, fill these in. */
  sampleHref?: string;
  /** Additional sample slugs to render as a small chip list under the description. */
  additionalSamples?: Array<{ label: string; href: string }>;
  /** Auth requirement chip label (defaults: Public/Auth required/Admin/API). */
  authBadge?: string;
};

export const ROUTE_META: Record<string, RouteMeta> = {
  '/': {
    description:
      '<strong>Landing.</strong> Hero, "Find a practitioner you can trust", "Browse the directory" CTA → /search, recently-joined practitioner cards (4), invite-only directory note, link to holistichealtheducators.com (the HHE school).',
    audience: 'public',
    status: 'live',
  },
  '/search': {
    description:
      '<strong>Faceted search.</strong> InstantSearchNext + Typesense Cloud. Specialty (multi-select), city + state (single-select), years-in-practice range, faceted autocomplete, mobile Sheet, URL state, typo tolerance.',
    audience: 'public',
    status: 'live',
  },
  '/practitioners/[slug]': {
    description:
      '<strong>Practitioner profile.</strong> Linktree-style — avatar, name + city, specialty badges, "Book intro consult" (real if bookingUrl set), "Browse offerings" + "Request invoice" (placeholders pending Wedge 2C), bio.',
    audience: 'public',
    status: 'live',
    sampleHref: '/practitioners/maya-sullivan',
    additionalSamples: [
      { label: 'cameron-liddell', href: '/practitioners/cameron-liddell' },
      { label: 'indira-ashland', href: '/practitioners/indira-ashland' },
      { label: 'jordan-beaumont', href: '/practitioners/jordan-beaumont' },
      { label: 'solene-marchetti', href: '/practitioners/solene-marchetti' },
    ],
  },
  '/auth/signin': {
    description:
      '<strong>Sign-in form.</strong> Magic-link request via Resend. Email field + "Send magic link" button. Redirects to /auth/verify-request on submit.',
    audience: 'public',
    status: 'live',
  },
  '/auth/verify-request': {
    description:
      '<strong>"Check your inbox" page.</strong> Shown after magic-link request. Link expires in 24h.',
    audience: 'public',
    status: 'live',
  },
  '/auth/error': {
    description:
      '<strong>Auth error page.</strong> Shown on verification failure, access denied, or configuration errors. Has "Back to sign-in" link.',
    audience: 'public',
    status: 'live',
  },
  '/auth/invite-accept/[token]': {
    description:
      '<strong>Invitation acceptance landing.</strong> Validates the token, shows "You\'re invited" with the inviter\'s name, "Send sign-in link" button. On click, calls signIn(\'resend\') with redirectTo=/onboarding?invitation=TOKEN.',
    audience: 'public',
    status: 'live',
    sampleHref: '/auth/invite-accept/EXAMPLE_TOKEN',
  },
  '/onboarding': {
    description:
      "<strong>Post-invite onboarding.</strong> Validates signed-in email matches the invitation, creates a Practitioner record with a slug derived from email, sets Role to PRACTITIONER, indexes Typesense, marks invitation accepted, redirects to /practitioners/[slug]/edit?welcome=1.",
    audience: 'auth',
    status: 'live',
    sampleHref: '/onboarding?invitation=EXAMPLE_TOKEN',
    authBadge: 'Auth required',
  },
  '/practitioners/[slug]/edit': {
    description:
      '<strong>Profile edit form.</strong> displayName, bio, city, yearsInPractice, specialties (multi-select), bookingUrl (Cal.com / Calendly / etc.). Plus a "Payments" section showing Whop sub-merchant status (currently "Pending access"). Reindexes Typesense on save.',
    audience: 'auth',
    status: 'live',
    sampleHref: '/practitioners/maya-sullivan/edit',
    authBadge: 'Ownership required',
  },
  '/admin': {
    description:
      '<strong>Admin tools index.</strong> Three Linktree-style cards: Invitations, Connected accounts (Whop), Whop webhooks. Live counts on each card.',
    audience: 'admin',
    status: 'live',
  },
  '/admin/invites': {
    description:
      '<strong>Practitioner invitations.</strong> Send a new invitation by email (uses Resend), list + status of pending/accepted/expired, revoke pending. Idempotent — resending to same email reuses the existing token.',
    audience: 'admin',
    status: 'live',
  },
  '/admin/connected-accounts': {
    description:
      '<strong>Whop sub-merchant lifecycle.</strong> 5-cell summary strip (Total / Verified / Pending / Not-started / Rejected) + sorted list per practitioner with KYC status badge + product count. Will populate once Whop Platforms access is granted; currently all NOT_STARTED.',
    audience: 'admin',
    status: 'scaffold',
  },
  '/admin/whop-webhooks': {
    description:
      '<strong>Webhook event log.</strong> Last 100 WhopWebhookEvent rows ordered by receivedAt desc. Empty today; lists the 8 expected event types (company.created, account.verified, payment.succeeded, payout.paid, etc.) in a &lt;details&gt; element while empty.',
    audience: 'admin',
    status: 'scaffold',
  },
  '/api/auth/[...nextauth]': {
    description:
      '<strong>NextAuth handlers.</strong> Catches /api/auth/signin, /signout, /session, /callback/*, /csrf, etc. Magic-link verification callback runs here.',
    audience: 'api',
    status: 'live',
    sampleHref: '/api/auth/session',
  },
};

/**
 * Routes that are designed but don't have a file yet. The generator emits these
 * as "Not yet" entries in the API section so the routes-index reflects intent
 * even when the route hasn't been implemented. Remove entries here when the
 * corresponding file is created.
 */
export const PLANNED_API_ROUTES: Array<{ path: string; meta: RouteMeta }> = [
  {
    path: '/api/whop/webhook',
    meta: {
      description:
        '<strong>Whop webhook receiver.</strong> Designed in docs/PHASE-2C-WHOP-DESIGN.md but not yet implemented. Will verify HMAC + dedupe via whopEventId + persist to WhopWebhookEvent + process by eventType.',
      audience: 'api',
      status: 'not-yet',
    },
  },
  {
    path: '/api/whop/onboarding/start',
    meta: {
      description:
        '<strong>Whop sub-merchant onboarding kickoff.</strong> Designed; will create the sub-merchant + KYC link. Gated on Whop for Platforms API access.',
      audience: 'api',
      status: 'not-yet',
    },
  },
  {
    path: '/api/whop/onboarding/return',
    meta: {
      description:
        '<strong>Whop sub-merchant onboarding return.</strong> Receives the KYC completion redirect. Updates Practitioner.whopKycStatus optimistically; webhook is authoritative.',
      audience: 'api',
      status: 'not-yet',
    },
  },
];

export const AUDIENCE_LABELS: Record<Audience, { title: string; intro: string }> = {
  public: {
    title: 'Public — no auth required',
    intro:
      'Anyone with the URL can reach these. Most of the user-discovery journey lives here.',
  },
  auth: {
    title: 'Practitioner-facing — auth required',
    intro:
      'Wedge 2A self-service. Middleware-gated to require a session; in-page ownership check ensures only the practitioner themselves (or an admin) can edit their profile.',
  },
  admin: {
    title: 'Admin-facing — Role.ADMIN required',
    intro:
      'Operator surfaces. Middleware redirects non-admins to /auth/error?error=AccessDenied. Admin auto-promoted from ADMIN_EMAILS env (currently jgatlit@gmail.com) on first sign-in.',
  },
  api: {
    title: 'API routes — programmatic, not for humans',
    intro: 'Not intended for direct browser visits, but listed for completeness.',
  },
};
