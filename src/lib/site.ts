/**
 * The canonical public origin — for the rare code that must build an absolute URL with no
 * request to derive one from (crons, scripts). Anything request-scoped, magic links
 * included, gets its origin from Auth.js/Next and must NOT read this.
 *
 * Not env-driven, deliberately. AUTH_URL / NEXTAUTH_URL / NEXT_PUBLIC_BASE_URL are all UNSET
 * on Vercel (verified 2026-07-16, and the auth loop we debugged proved Auth.js doesn't need
 * them). So `process.env.SOMETHING ?? fallback` is not a fallback here — it IS the value, and
 * the first cut of the trial-warning cron shipped `hhe-directory.vercel.app` into
 * practitioner-facing email exactly that way, in a message branded Natural Health Pros.
 *
 * When the Vercel project is renamed, this constant does not change: naturalhealthpros.com is
 * the apex domain, not the deployment alias.
 */
export const SITE_URL = 'https://naturalhealthpros.com';
