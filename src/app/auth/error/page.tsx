import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { Card } from '@/components/ui/card';

const MESSAGES: Record<string, string> = {
  Configuration: 'There is a configuration problem with the sign-in service.',
  AccessDenied: 'You do not have permission to sign in.',
  Verification: 'This link is invalid or has expired. Request a new one.',
  Default: 'Could not complete sign-in. Try again.',
};

type Props = { searchParams: { error?: string } };

export default function AuthErrorPage({ searchParams }: Props) {
  const message = MESSAGES[searchParams.error ?? 'Default'] ?? MESSAGES.Default;

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <div className="w-full max-w-sm">
        <Card className="space-y-5 p-6 sm:p-8 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10">
            <AlertTriangle className="h-5 w-5 text-destructive" aria-hidden />
          </div>
          <div className="space-y-1.5">
            <h1 className="text-xl font-semibold tracking-tight">Sign-in problem</h1>
            <p className="text-sm text-muted-foreground">{message}</p>
          </div>
          <Link
            href="/auth/signin"
            className="inline-flex h-9 w-full items-center justify-center rounded-md border bg-card text-sm font-medium transition-colors hover:bg-accent"
          >
            Back to sign-in
          </Link>
        </Card>
      </div>
    </main>
  );
}
