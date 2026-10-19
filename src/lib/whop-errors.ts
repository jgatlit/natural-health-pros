import { WhopNotConfigured } from '@/lib/whop';
import type { WhopPublishErrorCode } from '@/lib/whop-limits';

/**
 * Map a thrown Whop call to a code. whopPost throws `Whop <path> failed (<status>): <body>`; a
 * network failure throws before any status. Matching is on Whop's own wording, so anything not
 * recognised falls to `unknown` rather than a guess.
 */
export function classifyWhopPublishError(err: unknown): WhopPublishErrorCode {
  if (err instanceof WhopNotConfigured) return 'not-configured';
  const message = err instanceof Error ? err.message : String(err ?? '');
  if (/purchases over \$?\s?2,?500/i.test(message)) return 'over-limit';
  const status = Number(/failed \((\d{3})\)/.exec(message)?.[1] ?? NaN);
  if (status === 429) return 'busy';
  if (status >= 500) return 'unavailable';
  if (Number.isNaN(status) && /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|network/i.test(message)) {
    return 'unavailable';
  }
  if (/payouts?.{0,40}(not enabled|disabled)|verification|\bkyc\b|restricted|account.{0,40}(incomplete|disabled|not (yet )?(verified|approved))/i.test(message)) {
    return 'account';
  }
  return 'unknown';
}
