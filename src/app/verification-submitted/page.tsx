import Link from 'next/link';
import { CheckCircle2 } from 'lucide-react';
import { Card } from '@/components/ui/card';

export const metadata = {
  title: 'Verification submitted · Natural Health Pros',
  robots: { index: false, follow: false },
};

/**
 * Public landing for the Whop KYC return trip.
 *
 * ⚠️ ROUTE NAME IS LOAD-BEARING. Middleware gates on `pathname.startsWith('/onboarding')`,
 * which is a PREFIX match, not a segment match — so `/onboarding-complete` and
 * `/onboarding/verified` would both be auth-gated and would reintroduce exactly the sign-in
 * dead end this page exists to remove. Keep this path outside every matcher in middleware.ts.
 *
 * Deliberately says nothing specific: no name, no slug, no status. It renders identically for
 * the practitioner who just finished, for someone who followed a stale link, and for a stranger
 * who guessed the URL — which is what lets the return route stay unauthenticated without
 * leaking whether a given practitioner exists.
 *
 * The copy avoids promising a timeline or an outcome. Whop owns both, the authoritative signal
 * arrives by webhook, and this page has not read any state to know either.
 */
export default function VerificationSubmittedPage() {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-lg items-center px-4 py-16">
      <Card className="w-full space-y-4 p-6 sm:p-8">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted">
            <CheckCircle2 className="h-4 w-4 text-muted-foreground" aria-hidden />
          </span>
          <div>
            <h1 className="text-sm font-semibold">Verification submitted</h1>
            <p className="mt-1 text-xs text-muted-foreground">
              Thanks — Whop has your details and is reviewing them. You can close this tab; you
              don&apos;t need to stay on this page.
            </p>
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          If you finished this step on your phone, head back to whichever device you were using
          before. Your payment status updates automatically on your profile once Whop confirms.
        </p>

        <Link
          href="/auth/signin"
          className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Sign in to your profile
        </Link>
      </Card>
    </main>
  );
}
