import { Ratelimit } from '@upstash/ratelimit';
import { kv } from '@vercel/kv';

// Env-gated: if Upstash/Vercel KV envs are missing, rate-limit no-ops (always allows).
// Wire real limits in Phase 2 per Decisions-JSON `rate-limiting: YES Phase 2`.

const hasKv = !!process.env.KV_REST_API_URL && !!process.env.KV_REST_API_TOKEN;

type RateLimitConfig = {
  limit: number;
  windowSeconds: number;
};

type RateLimitResult = {
  success: boolean;
  remaining: number;
  reset: number;
};

// Signature mirrors fork's action-utils.ts caller contract: (prefix, identifier, config)
export async function rateLimit(
  prefix: string,
  identifier: string,
  config: RateLimitConfig,
): Promise<RateLimitResult> {
  if (!hasKv) return { success: true, remaining: Infinity, reset: 0 };

  const limiter = new Ratelimit({
    redis: kv,
    limiter: Ratelimit.slidingWindow(config.limit, `${config.windowSeconds} s`),
    analytics: false,
    prefix,
  });

  const { success, remaining, reset } = await limiter.limit(identifier);
  return { success, remaining, reset };
}
