import Link from 'next/link';

/**
 * /onboarding without a usable invitation, for a signed-in account that has no profile yet.
 * Replaces a silent redirect to the homepage.
 */
export function SignUpLinkNeeded({
  joinPath,
  expired = false,
}: {
  joinPath: string | null;
  expired?: boolean;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <div className="w-full max-w-sm space-y-4 rounded-xl border bg-card p-6 text-center sm:p-8">
        <h1 className="text-xl font-semibold tracking-tight">Use the sign-up link from your program</h1>
        <p className="text-sm text-muted-foreground">
          {expired
            ? 'This sign-up link has expired or was already used by another account. '
            : 'Setting up a profile starts from the sign-up link your program shared. '}
          {joinPath
            ? 'Enter your email there and we will send you a fresh link.'
            : 'Please ask your program lead for it.'}
        </p>
        {joinPath && (
          <Link
            href={joinPath}
            className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Get a sign-up link
          </Link>
        )}
      </div>
    </main>
  );
}
