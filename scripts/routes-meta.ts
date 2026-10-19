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
      '<strong>Practitioner profile.</strong> Linktree-style — avatar, name + city, specialty badges, "Book intro consult" (real if bookingUrl set), offerings with Whop checkout through the practitioner\'s connected account, custom sections, bio.',
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
      '<strong>Sign-in form.</strong> Magic-link request via Resend. Email field + "Send magic link" button, with bot checks (honeypot, signed fill-time stamp, rate limits, optional Turnstile). Redirects to /auth/verify-request on submit.',
    audience: 'public',
    status: 'live',
  },
  '/auth/confirm': {
    description:
      '<strong>"Sign me in" confirm page.</strong> Every magic-link email points here, not at the Auth.js callback, so a mail scanner that fetches the link cannot spend the token. Validates the link and shows the address with one "Sign me in" button, which POSTs to /api/auth/callback/resend. Rendering touches neither Auth.js nor the database.',
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
      '<strong>Profile edit form.</strong> displayName, bio, city, yearsInPractice, specialties (multi-select), bookingUrl (Cal.com / Calendly / etc.). Plus the Plan A / Plan B choice, Whop payments setup, offerings, custom sections, the private &ldquo;open to outside work&rdquo; toggle, the practitioner&rsquo;s join link, and a left-hand section navigation with scroll-spy. Reindexes Typesense on save.',
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
      '<strong>Whop connected-account lifecycle + reconciliation.</strong> Per-practitioner payout status (Whop&rsquo;s raw <code>payout_status</code>) and the authoritative <code>payouts_enabled</code> gate, sorted so restricted accounts (<code>connected</code> but not payouts-enabled) surface first. Also joins the live <code>GET /companies?parent_company_id=</code> roster against local rows to surface drift in both directions — webhooks retry only ~70s before dropping events, so drift is expected and this is what catches it. Degrades to the local table if Whop is unreachable.',
    audience: 'admin',
    status: 'live',
  },
  '/admin/commercial-settings': {
    description:
      '<strong>Rate schedules and payouts.</strong> Every price, percentage and term lives in an immutable, content-addressed <code>RateSchedule</code> row; this page shows the current schedule, the practitioners on each, and a form that saves a new schedule for NEW sign-ups only (existing practitioners move through the audited &ldquo;migrate cohort&rdquo; action; a practitioner with no schedule is refused at checkout until an admin assigns one). Also holds the <em>Referral Hold Period</em> (<code>referral_hold_days</code>, 90): only the unclaimed-share window for a referrer who cannot yet receive money. Below: held and <code>expired_unclaimed</code> referral totals, the <strong>transfers needing attention</strong> table (rows whose transfer outcome needs a person) and the recruiting-affiliate ledger. Transfers are off in production (read-only check, 2026-10-14/15); see <code>docs/money-model.md</code> and <code>docs/runbooks/transfers-canary.md</code>.',
    audience: 'admin',
    status: 'live',
  },
  '/admin/signups': {
    description:
      '<strong>Open sign-up cohorts.</strong> Lists sign-up cohorts (for example <code>hhe</code>) with an enable/disable switch, and the invitations each cohort has issued with their progress through onboarding. Disabling a cohort stops invitations already issued as well as new requests.',
    audience: 'admin',
    status: 'live',
  },
  '/admin/attributions': {
    description:
      '<strong>Attribution overrides.</strong> The one sanctioned way past the once-only attribution decision: each override needs a note and writes an adjustment to the fee ledger. Client emails are never shown; rows are identified by practitioner, referrer and date.',
    audience: 'admin',
    status: 'live',
  },
  '/admin/specialties': {
    description:
      '<strong>Specialty taxonomy moderation.</strong> Approve or reject pending aliases, promote proposed specialties and merge duplicates.',
    audience: 'admin',
    status: 'live',
  },
  '/admin/whop-webhooks': {
    description:
      '<strong>Webhook event log.</strong> Last 100 WhopWebhookEvent rows ordered by receivedAt desc, with the <code>error</code> column surfacing events that ran but could not be attributed to a practitioner. While empty it lists the event types actually observed in production (<code>identity_profile.*</code>, <code>payout_account.status_updated</code>, <code>payment.succeeded</code>) in a &lt;details&gt; element. The old list advertised <code>account.verified</code>, which Whop has never delivered.',
    audience: 'admin',
    status: 'scaffold',
  },
  '/api/whop/webhook': {
    description:
      '<strong>Legacy Whop webhook receiver (Layer X).</strong> Live — drives the $49/mo listing subscription: verifies via <code>@whop/api</code>&rsquo;s <code>makeWebhookValidator</code>, flips <code>subscriptionStatus</code>, re-runs the listing gate. <strong>Scheduled for retirement</strong> — <code>@whop/api</code> is deprecated on npm and this handler speaks the old <code>{action,data}</code> shape. Delete once the v1 registrations are observed delivering, then <code>npm rm @whop/api</code>. See docs/PHASE-2C-WHOP-CONNECTED-ACCOUNTS.md §6a step A5.',
    audience: 'api',
    status: 'live',
  },
  '/api/whop/webhook/v1': {
    description:
      '<strong>Whop API v1 webhook receiver.</strong> Standard Webhooks signature verification, deduped on the <code>webhook-id</code> header. Handles <code>identity_profile.*</code> and <code>payout_account.status_updated</code> (payout readiness &rarr; reindex) plus <code>payment.succeeded</code>. Two Whop registrations post here — one for the platform company, one for connected accounts (<code>child_resource_events</code> is exclusive, not additive) — so either signing secret validates. Fails closed with 503 until a secret is set; always 2xx otherwise, because Whop drops events after 3 retries (~70s). Runs ALONGSIDE the legacy /api/whop/webhook.',
    audience: 'api',
    status: 'live',
  },
  '/api/whop/onboarding/return': {
    description:
      '<strong>Whop KYC return redirect.</strong> DELIBERATELY UNAUTHENTICATED and side-effect-free. Whop&rsquo;s callback is a client-side navigation that fetches this URL cross-origin (no cookies possible), and Sumsub&rsquo;s &ldquo;continue on your phone&rdquo; handoff means the practitioner may finish on a device with no session at all — so a cookie here is a coin flip, not a boundary. Redirects an authenticated owner to their payments section; everyone else (unknown slug, someone else&rsquo;s slug, no session) gets the identical redirect to <code>/verification-submitted</code>. Payout state is owned entirely by the <code>identity_profile.*</code> webhook plus <code>/api/cron/whop-reconcile</code>.',
    audience: 'public',
    status: 'live',
  },
  '/api/whop/onboarding/refresh': {
    description:
      '<strong>Whop account-link refresh.</strong> Auth + ownership gated, and STAYS gated — it mints a link carrying payout scopes (create/delete destination, withdraw funds), so an open version would hand anyone a privileged link for any connected account. Whop redirects here when a short-lived account link expires mid-flow; re-mints a fresh <code>account_onboarding</code> link. An unauthenticated hit bounces to sign-in with a callback to the practitioner&rsquo;s own payments section rather than back to this route.',
    audience: 'auth',
    status: 'live',
  },
  '/api/cron/whop-reconcile': {
    description:
      '<strong>Whop payout drift sweep.</strong> The safety net behind the <code>identity_profile.*</code> webhook, which Whop drops permanently after 3 retries (~70s). Reads <code>GET /identity_profiles/{idpf_…}</code> — the only endpoint exposing <code>status</code>, <code>payout_status</code> and <code>payouts_enabled</code> together — and keys completion on <code>status: approved</code>. ONE-WAY: it may OPEN the payout gate, never close it, because a parent-company API key is known to under-report (<code>linked_companies</code> reads empty here but arrives populated on the webhook). Revocation stays with <code>identity_profile.rejected</code>/<code>needs_action</code>. Reports connected accounts that have NO stored Whop ids — the signature of a webhook that never resolved. Bearer <code>CRON_SECRET</code> when set. Hourly (<code>vercel.json</code>); it is also the retry backstop for referral and recruiter share transfers, which do nothing while <code>WHOP_TRANSFERS_ENABLED</code> is not exactly <code>true</code> (off in production per a read-only check on 2026-10-14/15).',
    audience: 'api',
    status: 'live',
  },
  '/verification-submitted': {
    description:
      '<strong>Public KYC return landing.</strong> Where <code>/api/whop/onboarding/return</code> sends anyone it cannot positively identify as the owner. Deliberately generic — no name, slug or status — so it renders identically for the practitioner who just finished, a stale link, and a stranger, which is what lets the return route stay unauthenticated without leaking whether a practitioner exists. ⚠️ The path is load-bearing: middleware gates on <code>startsWith(&apos;/onboarding&apos;)</code>, a PREFIX match, so naming this <code>/onboarding-complete</code> would auth-gate it and reintroduce the dead end it exists to remove.',
    audience: 'public',
    status: 'live',
  },
  '/join/[cohort]': {
    description:
      '<strong>Open sign-up.</strong> Public page for a sign-up cohort (<code>/join/hhe</code>); enter an email to receive a magic link that leads to <code>/onboarding</code>. <code>?nhpa=&lt;recruiterToken&gt;</code> identifies the practitioner who brought the visitor in: middleware stamps it into a signed cookie, and onboarding reads it from the browser that redeems the sign-in link. Unknown or disabled cohorts return 404. Not indexed.',
    audience: 'public',
    status: 'live',
    sampleHref: '/join/hhe',
  },
  '/r/[token]': {
    description:
      '<strong>Client-referral landing.</strong> Records a referral touch, sets a signed fallback cookie, then redirects to the practitioner profile carrying <code>?nhpr=&lt;touchToken&gt;</code>. Public, always dynamic.',
    audience: 'public',
    status: 'live',
  },
  '/practitioners/[slug]/book': {
    description:
      '<strong>Booking capture.</strong> One page for client capture and the practitioner&rsquo;s calendar; accepts <code>link</code>, <code>offering</code> and <code>nhpr</code>. Not indexed.',
    audience: 'public',
    status: 'live',
  },
  '/practitioners/[slug]/book/[token]': {
    description:
      '<strong>Booking flow.</strong> Addressed by the booking intent&rsquo;s random public token, so returning to it is idempotent: capture, schedule, then embedded Whop checkout priced from the practitioner&rsquo;s rate schedule. Not indexed.',
    audience: 'public',
    status: 'live',
  },
  '/auth/confirm-email-change/[token]': {
    description:
      '<strong>Email-change confirmation.</strong> Confirms a pending account-email change from the link sent to the new address; shows an error card for an expired token or an address that is no longer available.',
    audience: 'public',
    status: 'live',
  },
  '/api/cities': {
    description:
      '<strong>City typeahead.</strong> Public, dynamic, capped results from the US Census place catalog, which stays on the server.',
    audience: 'api',
    status: 'live',
  },
  '/api/practitioners/[slug]/photo': {
    description:
      '<strong>Profile photo upload authorisation.</strong> Confirms the signed-in user owns the slug (or is an admin) and returns a short-lived Vercel Blob client token scoped to image types.',
    audience: 'api',
    status: 'live',
  },
  '/api/practitioners/[slug]/section-media': {
    description:
      '<strong>Custom-section media upload authorisation.</strong> Same ownership check as the photo route; pins the destination path, content types and size ceiling server-side. Uploaded video is served under a CSP <code>media-src</code> pinned to the Blob store host.',
    audience: 'api',
    status: 'live',
  },
  '/api/survey/notify': {
    description:
      '<strong>Practitioner-survey notification.</strong> Called by a database trigger on each survey submission; fail-closed authentication, then emails the team.',
    audience: 'api',
    status: 'live',
  },
  '/api/health/search': {
    description:
      '<strong>Search uptime probe.</strong> Vercel Cron every 15 minutes; 200 when the Typesense cluster and a real search both pass, 503 otherwise.',
    audience: 'api',
    status: 'live',
  },
  '/api/cron/booking-sweep': {
    description:
      '<strong>Booking recovery and notices.</strong> Vercel Cron every 15 minutes; recovers stalled booking intents (resume, scheduled and paid notices) and sends referral booked and claim notices.',
    audience: 'api',
    status: 'live',
  },
  '/api/cron/trial-sweep': {
    description:
      '<strong>Pilot-trial sweep.</strong> Vercel Cron daily; warns before <code>trialEndsAt</code> and delists lapsed trials. Warning emails state the Plan A monthly fee from the practitioner&rsquo;s rate schedule.',
    audience: 'api',
    status: 'live',
  },
  '/api/cron/db-backup': {
    description:
      '<strong>Daily database backup.</strong> Vercel Cron; validates database health, writes a dated export to the private Blob store, then prunes beyond 30 days.',
    audience: 'api',
    status: 'live',
  },
  '/api/cron/db-snapshot': {
    description:
      '<strong>Weekly Neon snapshot.</strong> Vercel Cron; validates database health first and touches nothing if it fails.',
    audience: 'api',
    status: 'live',
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
  // /api/whop/onboarding/start was never built as a route — enrolment is the startWhopOnboarding
  // server action instead, so there is no endpoint to plan for. /return and /refresh now exist
  // and have live ROUTE_META entries above.
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
