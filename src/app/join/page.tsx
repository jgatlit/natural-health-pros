import type { Metadata } from 'next';
import { Send } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { issueFormStamp, turnstileSiteKey } from '@/lib/bot-guard';
import { BotGuardFields } from '@/components/auth/BotGuardFields';
import { JOIN_REQUEST_LIMITS } from '@/lib/join-request';
import { requestToJoin } from './actions';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Request to join Natural Health Pros',
  description:
    'Practitioners trained in natural health can request a listing in the Natural Health Pros directory.',
};

type Props = { searchParams: { sent?: string; error?: string } };

const ERRORS: Record<string, string> = {
  invalid: 'Please fill in your name, a valid email and your training or credential.',
  throttled: 'Too many attempts. Please try again in a little while.',
  retry: 'Please try again.',
};

const inputClass =
  'w-full rounded-md border bg-card px-3 text-sm outline-none ring-ring/30 transition-shadow focus-visible:ring-2';

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted-foreground">
        {label}
        {hint && <span className="font-normal"> {hint}</span>}
      </span>
      {children}
    </label>
  );
}

export default function JoinRequestPage({ searchParams }: Props) {
  const sent = searchParams.sent === '1';
  const error = searchParams.error ? ERRORS[searchParams.error] : undefined;

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <div className="w-full max-w-md">
        <Card className="space-y-5 p-6 sm:p-8">
          <div className="space-y-1.5 text-center">
            <h1 className="text-xl font-semibold tracking-tight">Request to join Natural Health Pros</h1>
            <p className="text-sm text-muted-foreground">
              Tell us a little about your practice. We review every request and email you once
              you are approved.
            </p>
          </div>

          {sent ? (
            <div className="rounded-md border border-primary/40 bg-primary/10 px-3 py-3 text-sm">
              Thank you. We have your request and will email you once it is approved.
            </div>
          ) : (
            <>
              {error && (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  {error}
                </div>
              )}
              <form action={requestToJoin} className="space-y-3">
                <Field label="Full name">
                  <input
                    name="name"
                    required
                    autoComplete="name"
                    maxLength={JOIN_REQUEST_LIMITS.name}
                    className={`h-10 ${inputClass}`}
                  />
                </Field>
                <Field label="Email">
                  <input
                    type="email"
                    name="email"
                    required
                    autoComplete="email"
                    placeholder="you@example.com"
                    className={`h-10 ${inputClass}`}
                  />
                </Field>
                <Field label="Training or credential">
                  <input
                    name="credential"
                    required
                    maxLength={JOIN_REQUEST_LIMITS.credential}
                    placeholder="e.g. Holistic Health Educator certificate"
                    className={`h-10 ${inputClass}`}
                  />
                </Field>
                <Field label="Website or social" hint="(optional)">
                  <input
                    name="website"
                    autoComplete="url"
                    maxLength={JOIN_REQUEST_LIMITS.website}
                    className={`h-10 ${inputClass}`}
                  />
                </Field>
                <Field label="A short note" hint="(optional)">
                  <textarea
                    name="note"
                    rows={3}
                    maxLength={JOIN_REQUEST_LIMITS.note}
                    className={`py-2 ${inputClass}`}
                  />
                </Field>
                <BotGuardFields stamp={issueFormStamp()} turnstileSiteKey={turnstileSiteKey()} />
                <button
                  type="submit"
                  className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  <Send className="h-4 w-4" />
                  Send my request
                </button>
              </form>
              <p className="text-center text-xs text-muted-foreground">
                If your program gave you a sign-up link, use that.
              </p>
            </>
          )}
        </Card>
      </div>
    </main>
  );
}
