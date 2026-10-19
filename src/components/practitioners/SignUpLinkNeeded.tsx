import Link from 'next/link';

/**
 * /onboarding without a usable invitation, for a signed-in account that has no profile yet.
 * Points to the public request form; a cohort link is never revealed here, since anyone signed
 * in could otherwise read it off this page and skip review.
 */
export function SignUpLinkNeeded({ expired = false }: { expired?: boolean }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <div className="w-full max-w-sm space-y-4 rounded-xl border bg-card p-6 text-center sm:p-8">
        <h1 className="text-xl font-semibold tracking-tight">Request to join Natural Health Pros</h1>
        <p className="text-sm text-muted-foreground">
          {expired
            ? 'This sign-up link has expired or was already used by another account. '
            : 'Your account does not have a practitioner profile yet. '}
          Send us a request and we will email you once you are approved.
        </p>
        <p className="text-sm text-muted-foreground">If your program gave you a sign-up link, use that.</p>
        <Link
          href="/join"
          className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Request to join
        </Link>
      </div>
    </main>
  );
}
