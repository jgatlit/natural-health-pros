import { WhopNotConfigured } from '@/lib/whop';
import type { WhopPublishErrorCode } from '@/lib/whop-limits';

// The practitioner's own account, in Whop's words. Only trusted on a 4xx Whop answer: a bare
// "verification" or "restricted" anywhere else says nothing about whose account it is.
const ACCOUNT_NOT_READY =
  /payouts? (are |is )?(not enabled|disabled)|requires? (identity )?verification|not (yet )?(verified|approved)|\bkyc\b|account (is )?(restricted|disabled|incomplete)/i;

/**
 * Map a thrown publish failure to a code. whopPost throws `Whop <path> failed (<status>): <body>`;
 * a network failure throws a TypeError before any status. Anything else (our own database write
 * after Whop succeeded, say) and anything not recognised falls to `unknown`, whose copy blames no
 * one, rather than a guess that sends the practitioner to fix the wrong thing.
 */
export function classifyWhopPublishError(err: unknown): WhopPublishErrorCode {
  if (err instanceof WhopNotConfigured) return 'not-configured';
  const message = err instanceof Error ? err.message : String(err ?? '');
  if (err instanceof TypeError && /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|network/i.test(message)) {
    return 'unavailable';
  }
  const whop = /^Whop \S+ failed \((\d{3})\)/.exec(message);
  if (!whop) return 'unknown';
  const status = Number(whop[1]);
  if (/purchases over \$?\s?2,?500/i.test(message)) return 'over-limit';
  if (status === 429) return 'busy';
  if (status >= 500) return 'unavailable';
  // 401 is our platform key, never the practitioner. A 403 is the practitioner's account only
  // when Whop says so; otherwise it is our key's permissions too.
  if ([400, 403, 422].includes(status) && ACCOUNT_NOT_READY.test(message)) return 'account';
  if (status === 401 || status === 403) return 'not-configured';
  return 'unknown';
}
