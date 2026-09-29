'use client';

/*
 * Global chrome — the production layout.tsx renders bare {children}, so there
 * is currently no header, no wordmark outside <title>, and no way for a listed
 * practitioner to reach their own edit page. This supplies all three.
 *
 * The header starts transparent over the hero field and settles into an opaque
 * navy bar once the field is behind it, so the wordmark never sits on a moving
 * background it cannot hold contrast against.
 *
 * D4: prefers-reduced-motion → the scrolled state still applies (it is a
 *     contrast requirement, not decoration) but without the transition.
 */

import { useEffect, useState } from 'react';
import { Wordmark } from '@/components/frontier/Wordmark';
import { useReducedMotion } from '@/lib/use-reduced-motion';
import { SITE_URL, searchUrl } from '@/lib/search-url';
import { signOutAction } from '@/components/site/actions';
import { cn } from '@/lib/utils';

/**
 * ⚠️ THE FRAGMENT LINKS ARE ROOT-RELATIVE (`/#…`), NOT BARE (`#…`).
 *
 * `#how-it-works` and `#get-listed` are sections of the HOMEPAGE. While this header rendered only
 * on the homepage a bare fragment was correct; the moment it also renders on `/search` and on a
 * practitioner profile, a bare fragment resolves against the CURRENT page and scrolls nowhere —
 * three dead links that still look and behave like live ones, with no error anywhere.
 *
 * `/#get-listed` is correct from every page, the homepage included: the browser sees a matching
 * path and performs an ordinary same-document fragment scroll there, so nothing regresses.
 */
const NAV = [
  { label: 'Find a practitioner', href: searchUrl() },
  { label: 'How it works', href: '/#how-it-works' },
  { label: 'For practitioners', href: '/#get-listed' },
];

/** Shared styling for the identity slot, so the anchor and the sign-out button read as one row. */
const SLOT_LINK =
  'whitespace-nowrap rounded-lg px-2 py-2 text-sm text-white/80 transition-colors hover:bg-white/10 hover:text-white sm:px-3';

type Props = {
  /**
   * The signed-in practitioner's own profile path, or null when signed out (or signed in
   * without a practitioner record — an admin, say). Resolved on the server and passed down:
   * this is a client component and the app has no SessionProvider, so reading the session
   * here would mean mounting one around the whole tree to answer a single question.
   */
  profileHref?: string | null;
  /**
   * Whether anyone is signed in. LOAD-BEARING as a separate prop: `profileHref` is null for
   * signed-out visitors AND for signed-in users with no practitioner record, so it cannot tell
   * the two apart. Deriving sign-out from it would hide sign-out from exactly the accounts that
   * most need it — an admin with no profile — and would look correct today only because all
   * three current admins happen to own one.
   */
  signedIn?: boolean;
};

export function SiteHeader({ profileHref = null, signedIn = false }: Props) {
  const reduced = useReducedMotion();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header
      data-surface="field"
      className={cn(
        'fixed inset-x-0 top-0 z-50',
        reduced ? '' : 'transition-[background-color,box-shadow,backdrop-filter] duration-300',
        scrolled ? 'bg-[var(--ink)]/95 shadow-[0_1px_0_rgba(255,255,255,0.08)] backdrop-blur' : 'bg-transparent',
      )}
    >
      <a
        href="#main"
        className="sr-only rounded-md bg-white px-4 py-2 text-sm font-medium text-foreground focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-10"
      >
        Skip to content
      </a>

      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <a href="/" className="rounded-md" aria-label="Natural Health Pros — home">
          <Wordmark tone="inverse" />
        </a>

        <nav aria-label="Main" className="hidden items-center gap-7 md:flex">
          {NAV.map((item) => (
            <a
              key={item.label}
              href={item.href}
              className="rounded-md text-sm text-white/75 transition-colors hover:text-white"
            >
              {item.label}
            </a>
          ))}
        </nav>

        {/*
          Both actions stay in the bar at every width. The left slot is the only
          door a practitioner has to their own profile, and Get listed is the
          entire paid funnel — hiding either behind a mobile menu would put the
          two things this header exists for one tap further away.

          Signed in, that left slot becomes "My profile" and points at their own
          page rather than a sign-in screen they no longer need. Showing "Sign in"
          to someone already signed in reads as a broken session and sends them
          back through a magic-link round trip to reach a page they could have
          opened directly.

          Sign out is keyed on `signedIn`, never on `profileHref`. Until this
          existed there was no way to end a session anywhere in the product —
          `signOut` was exported from auth.ts and imported by nothing — so the
          only remedies were NextAuth's unstyled /api/auth/signout, clearing
          cookies, or waiting out a 30-day JWT. That also made switching accounts
          impossible, and role changes invisible until the token aged out, since
          the role is stamped into the JWT at sign-in.
        */}
        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
          {profileHref && (
            <a href={profileHref} className={SLOT_LINK}>
              My profile
            </a>
          )}
          {signedIn ? (
            /*
              display:contents so the form adds no box of its own — the buttons stay
              direct flex children of the bar and keep the same gap as the anchors.
            */
            <form action={signOutAction} className="contents">
              <button type="submit" className={SLOT_LINK}>
                Sign out
              </button>
            </form>
          ) : (
            <a href={`${SITE_URL}/auth/signin`} className={SLOT_LINK}>
              Sign in
            </a>
          )}
          <a
            href="/#get-listed"
            className="whitespace-nowrap rounded-lg border border-white/25 px-2.5 py-2 text-sm text-white transition-colors hover:border-white/50 sm:px-3.5"
          >
            Get listed
          </a>
        </div>
      </div>
    </header>
  );
}
