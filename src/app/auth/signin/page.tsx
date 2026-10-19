import { Mail } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { BotGuardFields } from '@/components/auth/BotGuardFields';
import { issueFormStamp, turnstileSiteKey } from '@/lib/bot-guard';
import { requestSignIn } from './actions';

// Dynamic so the form stamp is issued per request; a prerendered stamp would age out for everyone.
export const dynamic = 'force-dynamic';

type Props = {
  searchParams: { callbackUrl?: string; error?: string; emailChanged?: string };
};

export default function SignInPage({ searchParams }: Props) {
  const callbackUrl = searchParams.callbackUrl ?? '/';
  const error = searchParams.error;
  // A flag, not the address itself — an email address is not something to carry in a URL
  // (referrer headers, browser history, server logs).
  const emailChanged = searchParams.emailChanged === '1';

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <div className="w-full max-w-sm">
        <Card className="space-y-5 p-6 sm:p-8">
          <div className="space-y-1.5 text-center">
            <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
            <p className="text-sm text-muted-foreground">
              We&apos;ll send a magic link to your email.
            </p>
          </div>

          {emailChanged && (
            <div className="rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-xs">
              Your sign-in email was updated. Sign in with your new address below to continue.
            </div>
          )}

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {error === 'OAuthAccountNotLinked'
                ? 'This email is already linked to another sign-in method.'
                : error === 'throttled'
                ? 'Too many attempts. Please try again in a little while.'
                : error === 'retry'
                ? 'Please try again.'
                : 'Could not sign in. Try again.'}
            </div>
          )}

          <form
            action={requestSignIn.bind(null, callbackUrl)}
            className="space-y-3"
          >
            <label className="block space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Email</span>
              <input
                type="email"
                name="email"
                required
                autoFocus
                placeholder="you@example.com"
                className="h-10 w-full rounded-md border bg-card px-3 text-sm outline-none ring-ring/30 transition-shadow focus-visible:ring-2"
              />
            </label>
            <BotGuardFields stamp={issueFormStamp()} turnstileSiteKey={turnstileSiteKey()} />
            <button
              type="submit"
              className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <Mail className="h-4 w-4" />
              Send magic link
            </button>
          </form>

          <p className="text-center text-xs text-muted-foreground">
            Natural Health Pros is invite-only. If you don&apos;t have an invitation, request one
            from your HHE program lead.
          </p>
        </Card>
      </div>
    </main>
  );
}
