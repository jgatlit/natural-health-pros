import { auth } from '@/auth';
import { prisma } from '@/lib/prisma';
import { rateLimit } from '@/lib/rate-limit';
import { headers } from 'next/headers';
import type { Session } from 'next-auth';
import type { Practitioner } from '@prisma/client';

/**
 * Shared utilities for server actions.
 * Centralizes auth checks and error handling to eliminate duplication
 * and ensure consistent behavior across all actions.
 */

export type ActionError = { success: false; error: string };
export type ActionResult = { success: boolean; error?: string; redirect?: string };
type AuthSuccess = { session: Session & { user: Session['user'] & { id: string } } };
type AuthResult = { error: ActionError } | AuthSuccess;

/**
 * Require an authenticated session. Returns the session or an action error.
 */
export async function requireAuth(): Promise<AuthResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { error: { success: false, error: 'Unauthorized' } };
  }
  return { session: session as AuthSuccess['session'] };
}

/**
 * Require an authenticated practitioner. Returns the session and practitioner,
 * or an action error if not logged in or no practitioner record exists.
 *
 * Pass `select` to pick specific scalar fields, or `include` to eagerly load
 * relations (e.g. `{ include: { wallet: true, user: true } }`).
 */
export async function requirePractitioner(
  opts?: { select?: Record<string, boolean> } | { include?: Record<string, boolean | object> },
) {
  const result = await requireAuth();
  if ('error' in result) return result;

  const queryArgs: Record<string, unknown> = {
    where: { userId: result.session.user.id },
  };

  if (opts) {
    if ('select' in opts && opts.select) queryArgs.select = opts.select;
    if ('include' in opts && opts.include) queryArgs.include = opts.include;
  }

  const practitioner = await (prisma.practitioner.findUnique as (args: unknown) => Promise<Practitioner | null>)(queryArgs);

  if (!practitioner) {
    return { error: { success: false, error: 'Practitioner not found' } as ActionError };
  }

  return { session: result.session, practitioner };
}

/**
 * Require an authenticated admin. Returns the session or an action error.
 */
export async function requireAdmin() {
  const result = await requireAuth();
  if ('error' in result) return result;

  if (result.session.user.role !== 'ADMIN') {
    return { error: { success: false, error: 'Unauthorized: Admin access required' } as ActionError };
  }

  return { session: result.session };
}

/**
 * Extract a user-friendly error message from a caught error.
 *
 * Only returns the raw message for errors explicitly marked as safe for
 * the client (thrown by our own code with a known prefix). All other
 * errors — Prisma internals, network failures, etc. — return the
 * fallback so we never leak implementation details.
 */
export function extractError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.startsWith('USER:')) {
    return error.message.slice(5);
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Pagination helper
// ---------------------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export interface PaginationParams {
  page?: number;
  pageSize?: number;
}

export interface PaginationMeta {
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

/**
 * Compute safe `skip` / `take` values and build pagination metadata.
 *
 * Clamps pageSize to MAX_PAGE_SIZE (100) to prevent clients from requesting
 * unbounded result sets. Returns `skip`, `take` for Prisma, and a `meta`
 * builder that accepts the total count.
 */
export function paginate(params?: PaginationParams) {
  const page = Math.max(1, Math.floor(params?.page || 1));
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.floor(params?.pageSize || DEFAULT_PAGE_SIZE)),
  );
  const skip = (page - 1) * pageSize;

  return {
    skip,
    take: pageSize,
    meta(total: number): PaginationMeta {
      return {
        total,
        page,
        pageSize,
        pages: Math.ceil(total / pageSize),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Action wrappers — eliminate the 3-line auth boilerplate
// ---------------------------------------------------------------------------

type ActionFn<TAuth, TArgs extends unknown[], TResult> = (auth: TAuth, ...args: TArgs) => Promise<TResult>;

/**
 * Wrap a server action that requires authentication.
 * Handles the try/catch and auth check so the caller only writes business logic.
 *
 * Usage:
 *   export const myAction = withAuth('Failed to do thing', async ({ session }, id: string) => {
 *     // ... business logic
 *     return { success: true, data: ... };
 *   });
 */
export function withAuth<T extends ActionResult, TArgs extends unknown[]>(
  fallbackError: string,
  fn: ActionFn<AuthSuccess, TArgs, T>,
): (...args: TArgs) => Promise<T | ActionError> {
  return async (...args: TArgs) => {
    try {
      const result = await requireAuth();
      if ('error' in result) return result.error;
      return await fn(result, ...args);
    } catch (error) {
      return { success: false, error: extractError(error, fallbackError) };
    }
  };
}

/**
 * Wrap a server action that requires admin access.
 */
export function withAdmin<T extends ActionResult, TArgs extends unknown[]>(
  fallbackError: string,
  fn: ActionFn<{ session: AuthSuccess['session'] }, TArgs, T>,
): (...args: TArgs) => Promise<T | ActionError> {
  return async (...args: TArgs) => {
    try {
      const result = await requireAdmin();
      if ('error' in result) return result.error;
      return await fn(result, ...args);
    } catch (error) {
      return { success: false, error: extractError(error, fallbackError) };
    }
  };
}

type PractitionerOpts = Parameters<typeof requirePractitioner>[0];

type PractitionerSuccess = { session: AuthSuccess['session']; practitioner: Practitioner };

/**
 * Wrap a server action that requires an authenticated practitioner.
 * Pass `opts` to control which practitioner fields are loaded (select/include).
 *
 * Usage:
 *   export const myAction = withPractitioner(
 *     'Failed to do thing',
 *     async ({ session, practitioner }, id: string) => {
 *       return { success: true };
 *     },
 *     { select: { id: true, calAccessToken: true } },
 *   );
 */
export function withPractitioner<T extends ActionResult, TArgs extends unknown[]>(
  fallbackError: string,
  fn: ActionFn<PractitionerSuccess, TArgs, T>,
  opts?: PractitionerOpts,
): (...args: TArgs) => Promise<T | ActionError> {
  return async (...args: TArgs) => {
    try {
      const result = await requirePractitioner(opts);
      if ('error' in result) return result.error;
      return await fn(result, ...args);
    } catch (error) {
      return { success: false, error: extractError(error, fallbackError) };
    }
  };
}

// ---------------------------------------------------------------------------
// Rate limiting for server actions
// ---------------------------------------------------------------------------

interface ActionRateLimitConfig {
  /** Namespace prefix for the rate limiter (e.g. 'auth-login') */
  prefix: string;
  /** Maximum requests allowed in the window */
  limit: number;
  /** Window size in seconds */
  windowSeconds: number;
}

/**
 * Rate limit a server action by client IP.
 *
 * Returns `null` if under the limit, or an `ActionError` if exceeded.
 * Uses the same Vercel KV / in-memory backend as the API rate limiter.
 *
 * Usage:
 *   const rl = await rateLimitAction({ prefix: 'auth-login', limit: 5, windowSeconds: 60 });
 *   if (rl) return rl;
 */
export async function rateLimitAction(
  config: ActionRateLimitConfig,
): Promise<ActionError | null> {
  try {
    const hdrs = await headers();
    const ip =
      hdrs.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      hdrs.get('x-real-ip') ||
      'unknown';

    const result = await rateLimit(config.prefix, ip, {
      limit: config.limit,
      windowSeconds: config.windowSeconds,
    });

    if (!result.success) {
      return {
        success: false,
        error: 'Too many requests. Please try again later.',
      };
    }

    return null;
  } catch (error) {
    // Never block users if rate limiter itself fails
    console.error('[rateLimitAction]', error);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Ownership check helper — prevents IDOR information disclosure
// ---------------------------------------------------------------------------

/**
 * Verify that a fetched entity belongs to the current user.
 *
 * Combines the null check and ownership check into a single step so that
 * "entity doesn't exist" and "entity exists but you don't own it" return
 * the **same** error message. This prevents attackers from probing valid
 * IDs on a HIPAA-adjacent platform.
 *
 * Supports two shapes:
 *   - Direct ownership: `entity.userId === sessionUserId`
 *   - Via relation:     `entity.practitioner.userId === sessionUserId`
 *
 * Usage:
 *   const check = requireOwnership(credential, session.user.id, 'Credential');
 *   if (check) return check; // ActionError
 *   // credential is now narrowed to non-null
 */
export function requireOwnership<T extends Record<string, unknown> | null | undefined>(
  entity: T,
  sessionUserId: string,
  entityLabel: string,
): ActionError | null {
  if (!entity) {
    return { success: false, error: `${entityLabel} not found` };
  }

  // Direct userId field
  if ('userId' in entity && entity.userId === sessionUserId) return null;

  // Via practitioner relation (entity.practitioner.userId)
  if (
    'practitioner' in entity &&
    entity.practitioner &&
    typeof entity.practitioner === 'object' &&
    'userId' in (entity.practitioner as Record<string, unknown>) &&
    (entity.practitioner as Record<string, unknown>).userId === sessionUserId
  ) {
    return null;
  }

  // Via practitionerId matching a known practitioner.id
  // (Caller should use the direct or relation pattern instead)

  // Ownership failed — return same message as "not found"
  return { success: false, error: `${entityLabel} not found` };
}

// ---------------------------------------------------------------------------
// Phase 3 helpers (DEFERRED — reintroduce when models land)
// ---------------------------------------------------------------------------
//
// requireConversationAccess(): requires Conversation model (Decisions-JSON
// `direct-messaging: YES Phase 3`). Lifted from fork; reintroduce alongside
// the Conversation schema in Phase 3.
