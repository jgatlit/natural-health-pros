'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import * as Sentry from '@sentry/nextjs';
import { Card } from '@/components/ui/card';

// Route-level error boundary for the public profile. Without this a Prisma/DB
// failure during SSR renders an unstyled 500; here it degrades gracefully and
// reports to Sentry. (The /search surface already has its own SearchUnavailable.)
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-16">
      <Card className="max-w-md space-y-4 p-8 text-center">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-destructive/10">
          <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden />
        </div>
        <div className="space-y-1.5">
          <h1 className="text-lg font-semibold tracking-tight">This profile didn&apos;t load</h1>
          <p className="text-sm text-muted-foreground">
            Something went wrong on our end. Please try again in a moment.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
          <button
            type="button"
            onClick={reset}
            className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <Link
            href="/search"
            className="inline-flex h-10 items-center justify-center rounded-md border bg-card px-5 text-sm font-medium hover:bg-accent"
          >
            Browse practitioners
          </Link>
        </div>
      </Card>
    </main>
  );
}
