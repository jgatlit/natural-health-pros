import { createHmac, timingSafeEqual } from 'node:crypto';
import { rateLimit } from '@/lib/rate-limit';
import { maskEmail } from '@/lib/sign-in-recovery';
import { BOT_GUARD_FIELDS } from '@/lib/bot-guard-fields';

/**
 * Bot protection for the public forms that send email (sign-in, cohort join).
 *
 * Layers, cheapest first: a honeypot field, Gmail addresses padded with dots (the pattern every
 * observed bot used), a signed render stamp that rejects submissions faster than a person can
 * type, per-IP and per-email rate limits, and Cloudflare Turnstile when both keys are set.
 *
 * A rejection never sends mail. Honeypot and dotted-Gmail rejections are reported as
 * `pretend-success` so the caller shows the normal "check your inbox" result and a bot learns
 * nothing; the others ask the person to try again.
 */

export { BOT_GUARD_FIELDS };

export const MIN_FILL_MS = 3_000;
export const MAX_STAMP_AGE_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 60_000;
const STAMP_CONTEXT = 'nhp-form-stamp:v1:';
const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const SITEVERIFY_TIMEOUT_MS = 8_000;
const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);
const GMAIL_MAX_DOTS = 3;

export type BotGuardReason =
  | 'honeypot'
  | 'dotted-gmail'
  | 'stamp-missing'
  | 'stamp-invalid'
  | 'stamp-expired'
  | 'too-fast'
  | 'turnstile'
  | 'turnstile-error'
  | 'throttled';

export type BotGuardOutcome = 'pretend-success' | 'retry' | 'throttled';

export type BotGuardResult =
  | { ok: true }
  | { ok: false; reason: BotGuardReason; outcome: BotGuardOutcome };

export type RateRule = {
  /** Distinct per form and window, e.g. `signin-ip-15m`. */
  prefix: string;
  by: 'ip' | 'email';
  limit: number;
  windowSeconds: number;
};

export type BotGuardInput = {
  /** Short form name for logs, e.g. `signin`, `join`. */
  form: string;
  formData: FormData;
  /** Normalised address, or null when the form had none worth keying on. */
  email: string | null;
  ip: string;
  rateLimits: RateRule[];
  now?: number;
};

const OUTCOME: Record<BotGuardReason, BotGuardOutcome> = {
  honeypot: 'pretend-success',
  'dotted-gmail': 'pretend-success',
  'stamp-missing': 'retry',
  'stamp-invalid': 'retry',
  'stamp-expired': 'retry',
  'too-fast': 'retry',
  turnstile: 'retry',
  'turnstile-error': 'retry',
  throttled: 'throttled',
};

function sign(ts: string, secret: string): string {
  return createHmac('sha256', secret).update(`${STAMP_CONTEXT}${ts}`).digest('base64url');
}

/** A render-time stamp for the form, `<ms>.<hmac>`. Call it while rendering, never cache it. */
export function issueFormStamp(now: number = Date.now(), secret = process.env.AUTH_SECRET): string {
  if (!secret) return '';
  const ts = String(Math.floor(now));
  return `${ts}.${sign(ts, secret)}`;
}

export function checkFormStamp(
  raw: string | null | undefined,
  now: number = Date.now(),
  secret = process.env.AUTH_SECRET,
): { ok: true } | { ok: false; reason: 'stamp-missing' | 'stamp-invalid' | 'stamp-expired' | 'too-fast' } {
  if (!raw) return { ok: false, reason: 'stamp-missing' };
  if (!secret) {
    console.error('[bot-guard] AUTH_SECRET unset; form stamps cannot be verified');
    return { ok: false, reason: 'stamp-invalid' };
  }
  const m = /^(\d{1,15})\.([A-Za-z0-9_-]{43})$/.exec(raw);
  if (!m) return { ok: false, reason: 'stamp-invalid' };
  const expected = Buffer.from(sign(m[1], secret));
  const given = Buffer.from(m[2]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'stamp-invalid' };
  }
  const age = now - Number(m[1]);
  if (age < -CLOCK_SKEW_MS) return { ok: false, reason: 'stamp-invalid' };
  if (age > MAX_STAMP_AGE_MS) return { ok: false, reason: 'stamp-expired' };
  if (age < MIN_FILL_MS) return { ok: false, reason: 'too-fast' };
  return { ok: true };
}

/** Gmail ignores dots, so `j.a.n.e.d.o.e@gmail.com` is free padding; bots pad, people rarely do. */
export function isDottedGmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const at = email.lastIndexOf('@');
  if (at < 1) return false;
  if (!GMAIL_DOMAINS.has(email.slice(at + 1).toLowerCase())) return false;
  const local = email.slice(0, at).split('+')[0];
  return (local.match(/\./g)?.length ?? 0) > GMAIL_MAX_DOTS;
}

/** The site key to render, or null when Turnstile is not fully configured (both keys required). */
export function turnstileSiteKey(): string | null {
  const site = process.env.TURNSTILE_SITE_KEY?.trim();
  const secret = process.env.TURNSTILE_SECRET_KEY?.trim();
  return site && secret ? site : null;
}

let warnedTurnstileOff = false;
function warnTurnstileOff() {
  if (warnedTurnstileOff) return;
  warnedTurnstileOff = true;
  console.warn(
    '[bot-guard] TURNSTILE_SITE_KEY/TURNSTILE_SECRET_KEY not both set; Turnstile is OFF and the public forms rely on the honeypot, the fill-time stamp and rate limits',
  );
}

/** Server-side Turnstile check. Fails closed on a missing token, a refusal, or a network error. */
export async function verifyTurnstile(
  token: string | null | undefined,
  ip: string,
): Promise<'ok' | 'turnstile' | 'turnstile-error'> {
  const secret = process.env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret) return 'turnstile-error';
  if (!token) return 'turnstile';
  const body = new URLSearchParams({ secret, response: token });
  if (ip && ip !== 'unknown') body.set('remoteip', ip);
  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error('[bot-guard] Turnstile siteverify HTTP error', { status: res.status });
      return 'turnstile-error';
    }
    const data = (await res.json()) as { success?: unknown; 'error-codes'?: unknown };
    if (data.success === true) return 'ok';
    console.warn('[bot-guard] Turnstile refused', { codes: data['error-codes'] });
    return 'turnstile';
  } catch (err) {
    console.error('[bot-guard] Turnstile siteverify failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 'turnstile-error';
  }
}

/** The caller's IP as Vercel reports it. */
export function clientIp(h: Headers): string {
  return h.get('x-forwarded-for')?.split(',')[0]?.trim() || h.get('x-real-ip')?.trim() || 'unknown';
}

function reject(input: BotGuardInput, reason: BotGuardReason): BotGuardResult {
  console.warn('[bot-guard] rejected', {
    form: input.form,
    reason,
    email: input.email ? maskEmail(input.email) : null,
  });
  return { ok: false, reason, outcome: OUTCOME[reason] };
}

export async function checkBotGuard(input: BotGuardInput): Promise<BotGuardResult> {
  const { formData, email, ip } = input;
  const now = input.now ?? Date.now();

  const honeypot = formData.get(BOT_GUARD_FIELDS.honeypot);
  if (typeof honeypot === 'string' && honeypot.trim() !== '') return reject(input, 'honeypot');

  if (isDottedGmail(email)) return reject(input, 'dotted-gmail');

  const stamp = formData.get(BOT_GUARD_FIELDS.stamp);
  const stampCheck = checkFormStamp(typeof stamp === 'string' ? stamp : null, now);
  if (!stampCheck.ok) return reject(input, stampCheck.reason);

  const results = await Promise.all(
    input.rateLimits
      .filter((r) => r.by === 'ip' || email)
      .map((r) =>
        rateLimit(r.prefix, r.by === 'ip' ? ip : email!, {
          limit: r.limit,
          windowSeconds: r.windowSeconds,
        }),
      ),
  );
  if (results.some((r) => !r.success)) return reject(input, 'throttled');

  if (turnstileSiteKey()) {
    const token = formData.get(BOT_GUARD_FIELDS.turnstile);
    const verdict = await verifyTurnstile(typeof token === 'string' ? token : null, ip);
    if (verdict !== 'ok') return reject(input, verdict);
  } else {
    warnTurnstileOff();
  }

  return { ok: true };
}
