'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { signIn } from '@/auth';
import { normalizeEmail } from '@/lib/email';
import { checkBotGuard, clientIp, type RateRule } from '@/lib/bot-guard';

const RATE_LIMITS: RateRule[] = [
  { prefix: 'signin-ip-15m', by: 'ip', limit: 5, windowSeconds: 15 * 60 },
  { prefix: 'signin-ip-1d', by: 'ip', limit: 20, windowSeconds: 24 * 60 * 60 },
  { prefix: 'signin-email-1h', by: 'email', limit: 3, windowSeconds: 60 * 60 },
];

/** Auth.js's own "check your inbox" destination for the resend provider. */
const VERIFY_REQUEST_PATH = '/auth/verify-request?provider=resend&type=email';

export async function requestSignIn(callbackUrl: string, formData: FormData): Promise<void> {
  const rawEmail = formData.get('email');
  const email = typeof rawEmail === 'string' ? normalizeEmail(rawEmail) : null;

  const guard = await checkBotGuard({
    form: 'signin',
    formData,
    email,
    ip: clientIp(headers()),
    rateLimits: RATE_LIMITS,
  });
  if (!guard.ok) {
    if (guard.outcome === 'pretend-success') redirect(VERIFY_REQUEST_PATH);
    const back = new URLSearchParams({ error: guard.outcome, callbackUrl });
    redirect(`/auth/signin?${back.toString()}`);
  }

  await signIn('resend', {
    email: rawEmail,
    redirectTo: callbackUrl,
  });
}
