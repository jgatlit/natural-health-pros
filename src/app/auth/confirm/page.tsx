import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { AlertTriangle, LogIn } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { parseConfirmTarget } from '@/lib/magic-link-confirm';

// Rendering this page must never redeem the token: mail scanners GET and HEAD every link in a
// message. So it imports neither Auth.js nor Prisma (tests/magic-link-confirm.test.ts checks), and
// the token is only spent by the POST the button makes.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Sign in to Natural Health Pros',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

type Props = { searchParams: Record<string, string | string[] | undefined> };

function requestOrigin(): string {
  const h = headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost';
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
  return `${proto.split(',')[0].trim()}://${host.split(',')[0].trim()}`;
}

export default function ConfirmSignInPage({ searchParams }: Props) {
  const target = parseConfirmTarget(searchParams, requestOrigin());

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <div className="w-full max-w-sm">
        <Card className="space-y-5 p-6 text-center sm:p-8">
          {target ? (
            <>
              <div className="space-y-1.5">
                <h1 className="text-xl font-semibold tracking-tight">Sign in to Natural Health Pros</h1>
                <p className="text-sm text-muted-foreground">
                  Signing in as <span className="font-medium text-foreground">{target.email}</span>
                </p>
              </div>
              <form method="post" action={target.action}>
                <button
                  type="submit"
                  className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  <LogIn className="h-4 w-4" aria-hidden />
                  Sign me in
                </button>
              </form>
              <p className="text-xs text-muted-foreground">
                The link expires in 24 hours and can only be used once.
              </p>
            </>
          ) : (
            <>
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
                <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden />
              </div>
              <div className="space-y-1.5">
                <h1 className="text-xl font-semibold tracking-tight">This link is not valid</h1>
                <p className="text-sm text-muted-foreground">Request a new sign-in link.</p>
              </div>
              <Link
                href="/auth/signin"
                className="inline-flex h-10 w-full items-center justify-center rounded-md border text-sm font-medium transition-colors hover:bg-muted"
              >
                Back to sign-in
              </Link>
            </>
          )}
        </Card>
      </div>
    </main>
  );
}
