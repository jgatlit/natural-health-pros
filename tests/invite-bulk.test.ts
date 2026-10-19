import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Bulk invite (2026-08-25): admin pastes a list of emails on /admin/invites instead of sending
 * one at a time. `createInvitationsBulk` reuses the same `inviteOne` core as the single-invite
 * action per address — this pins that the per-address outcome logic (idempotency, rollback on a
 * failed send) and the batch-level parsing/dedup both hold.
 *
 * Mirrors the pattern in tests/invite-trial-reset-and-email.test.ts: the real actions live in a
 * `'use server'` file whose import graph pulls in next/navigation + the whole auth stack, so the
 * core logic is transcribed here and the production source is pinned by regex at the bottom to
 * catch drift.
 */

type InviteOutcome = 'created' | 'reused' | 'invalid' | 'send-failed';

const mocks = vi.hoisted(() => ({
  invitationFindFirst: vi.fn(),
  invitationCreate: vi.fn(),
  invitationDelete: vi.fn(),
  sendInviteMagicLink: vi.fn(),
}));

beforeEach(() => {
  mocks.invitationFindFirst.mockReset().mockResolvedValue(null);
  mocks.invitationCreate.mockReset().mockImplementation(async ({ data }) => ({ id: `row_${data.email}` }));
  mocks.invitationDelete.mockReset().mockResolvedValue({});
  mocks.sendInviteMagicLink.mockReset().mockResolvedValue(true);
});

// Mirrors src/app/admin/invites/actions.ts's normalizeEmail() — a real regex + length cap, not
// a bare `.includes('@')` check, so "Jane Doe <jane@x.com>" is caught here rather than reaching
// Resend and coming back as an opaque 'send-failed'.
function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (!email || email.length > 320) return null;
  if (!/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

async function inviteOne(rawEmail: string, invitedById: string): Promise<InviteOutcome> {
  const email = normalizeEmail(rawEmail);
  if (!email) return 'invalid';

  const existing = await mocks.invitationFindFirst({ where: { email } });

  let createdId: string | null = null;
  if (!existing) {
    const row = await mocks.invitationCreate({ data: { email, invitedById } });
    createdId = row.id;
  }

  const sent = await mocks.sendInviteMagicLink(email);
  if (!sent) {
    if (createdId) await mocks.invitationDelete({ where: { id: createdId } });
    return 'send-failed';
  }

  return existing ? 'reused' : 'created';
}

function parseBulkEmails(raw: string): string[] {
  return raw
    .split(/[\n,;]+/)
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
}

const MAX_BULK = 50;

async function bulkInvite(raw: string, invitedById: string) {
  const allCandidates = parseBulkEmails(raw);
  const overflow = Math.max(0, allCandidates.length - MAX_BULK);
  const candidates = allCandidates.slice(0, MAX_BULK);

  const seen = new Set<string>();
  let created = 0;
  let reused = 0;
  const invalidEmails: string[] = [];
  const failedEmails: string[] = [];

  for (const candidate of candidates) {
    const normalized = candidate.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    const outcome = await inviteOne(candidate, invitedById);
    if (outcome === 'created') created += 1;
    else if (outcome === 'reused') reused += 1;
    else if (outcome === 'invalid') invalidEmails.push(candidate);
    else failedEmails.push(candidate);
  }

  return { created, reused, invalid: invalidEmails.length, failed: failedEmails.length, invalidEmails, failedEmails, overflow };
}

describe('bulk invite parsing', () => {
  it('splits on newlines, commas, and semicolons', () => {
    expect(parseBulkEmails('a@x.com\nb@x.com,c@x.com;d@x.com')).toEqual([
      'a@x.com',
      'b@x.com',
      'c@x.com',
      'd@x.com',
    ]);
  });

  it('drops blank lines from a ragged paste', () => {
    expect(parseBulkEmails('a@x.com\n\n\nb@x.com\n')).toEqual(['a@x.com', 'b@x.com']);
  });
});

describe('bulk invite outcomes', () => {
  it('creates each new valid address', async () => {
    const result = await bulkInvite('a@x.com\nb@x.com', 'admin_1');
    expect(result).toMatchObject({ created: 2, reused: 0, invalid: 0, failed: 0, overflow: 0 });
    expect(mocks.invitationCreate).toHaveBeenCalledTimes(2);
  });

  it('dedupes case-insensitively within one paste — never double-invites', async () => {
    const result = await bulkInvite('a@x.com\nA@X.COM\na@x.com', 'admin_1');
    expect(result).toMatchObject({ created: 1, reused: 0, invalid: 0, failed: 0 });
    expect(mocks.invitationCreate).toHaveBeenCalledTimes(1);
  });

  it('reuses a pending invitation instead of creating a duplicate row', async () => {
    mocks.invitationFindFirst.mockResolvedValue({ token: 'tok', email: 'a@x.com' });
    const result = await bulkInvite('a@x.com', 'admin_1');
    expect(result).toMatchObject({ created: 0, reused: 1, invalid: 0, failed: 0 });
    expect(mocks.invitationCreate).not.toHaveBeenCalled();
  });

  it('counts unusable addresses as invalid without touching the database', async () => {
    const result = await bulkInvite('not-an-email\na@x.com', 'admin_1');
    expect(result).toMatchObject({ created: 1, reused: 0, invalid: 1, failed: 0 });
    expect(mocks.invitationCreate).toHaveBeenCalledTimes(1);
  });

  it('rejects a mangled paste artifact ("Name <email>") as invalid, not a wasted create+rollback', async () => {
    // Regression for PR review finding #5: the old `.includes('@')` check would have written a
    // row, tried to send, failed, and rolled back — reporting an opaque "failed" instead of
    // "invalid" and costing two writes to learn nothing actionable.
    const result = await bulkInvite('Jane Doe <jane@x.com>\ngood@x.com', 'admin_1');
    expect(result).toMatchObject({ created: 1, invalid: 1, failed: 0 });
    expect(result.invalidEmails).toEqual(['Jane Doe <jane@x.com>']);
    expect(mocks.invitationCreate).toHaveBeenCalledTimes(1);
  });

  it('counts a failed send and rolls back the row it created for that address', async () => {
    mocks.sendInviteMagicLink.mockImplementation(async (email: string) => email !== 'bad@x.com');
    const result = await bulkInvite('good@x.com\nbad@x.com', 'admin_1');
    expect(result).toMatchObject({ created: 1, reused: 0, invalid: 0, failed: 1 });
    expect(result.failedEmails).toEqual(['bad@x.com']);
    expect(mocks.invitationDelete).toHaveBeenCalledWith({ where: { id: 'row_bad@x.com' } });
    expect(mocks.invitationDelete).toHaveBeenCalledTimes(1);
  });

  it('one bad address in a batch does not stop the rest from sending', async () => {
    const result = await bulkInvite('a@x.com\nnope\nb@x.com', 'admin_1');
    expect(result.created).toBe(2);
    expect(result.invalid).toBe(1);
  });

  it('caps a submission at 50 and reports the rest as overflow, not silently', async () => {
    const emails = Array.from({ length: 55 }, (_, i) => `p${i}@x.com`).join('\n');
    const result = await bulkInvite(emails, 'admin_1');
    expect(result.created).toBe(50);
    expect(result.overflow).toBe(5);
    expect(mocks.invitationCreate).toHaveBeenCalledTimes(50);
  });
});

describe('the production source still carries the shared core + batch semantics', () => {
  const read = (...p: string[]) =>
    require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', ...p), 'utf8');
  // The core moved to src/lib/admin-invite.ts (shared with the join-request approval, and kept out
  // of the 'use server' file so it is not a public action). The actions file comes first, so the
  // bounded createInvitationsBulk slice below still falls inside it.
  const src = () => read('app', 'admin', 'invites', 'actions.ts') + read('lib', 'admin-invite.ts');

  // Bounded to the function body, not sliced to end-of-file — an unbounded slice from
  // createInvitationsBulk's start would also cover every unrelated function below it
  // (revokeInvitation, deleteInvitation, resendInvitation, ...), so a Promise.all anywhere
  // later in the file would fail THIS test for the wrong reason.
  const bulkFnBody = () => {
    const s = src();
    const start = s.indexOf('export async function createInvitationsBulk');
    const end = s.indexOf('export async function revokeInvitation');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return s.slice(start, end);
  };

  it('createInvitation and createInvitationsBulk both route through inviteOne', () => {
    const s = src();
    expect(s).toMatch(/async function inviteOne\(/);
    expect(s).toMatch(/const outcome = await inviteOne\(email, session\.user\.id\);/);
    expect(s).toMatch(/const outcome = await inviteOne\(candidate, session\.user\.id\);/);
  });

  it('bulk invite sends sequentially, not via Promise.all', () => {
    const bulkFn = bulkFnBody();
    expect(bulkFn).toMatch(/for \(const candidate of candidates\) \{/);
    expect(bulkFn).not.toMatch(/Promise\.all/);
  });

  it('bulk invite dedupes case-insensitively before inviting', () => {
    const s = src();
    expect(s).toMatch(/const seen = new Set<string>\(\);/);
    expect(s).toMatch(/if \(seen\.has\(normalized\)\) continue;/);
  });

  it('bulk invite requires admin', () => {
    expect(bulkFnBody()).toMatch(/const session = await requireAdmin\(\);/);
  });

  it('bulk invite caps a submission and reports the overflow rather than silently truncating it', () => {
    const bulkFn = bulkFnBody();
    expect(bulkFn).toMatch(/const MAX_BULK = 50|MAX_BULK\)/);
    expect(bulkFn).toMatch(/overflow/);
  });

  // These pin the behaviors PR review (2026-08-25) mutation-tested and found the earlier
  // version of this file did NOT actually catch: deleting either redirect guard, weakening the
  // idempotency lookup to ignore expiry, or deleting the rollback all left the suite green.
  // A regex pin is not a substitute for the mirror tests above, but at least makes those specific
  // four mutations fail loudly instead of silently.
  it('createInvitation redirects on both failure outcomes — not just success', () => {
    const s = src();
    expect(s).toMatch(/if \(outcome === 'invalid'\) redirect\('\/admin\/invites\?error=invalid-email'\);/);
    expect(s).toMatch(/if \(outcome === 'send-failed'\) redirect\('\/admin\/invites\?error=send-failed'\);/);
  });

  it('inviteOne only reuses an invitation that is unaccepted AND unexpired', () => {
    const s = src();
    expect(s).toMatch(
      /where: \{ email, cohortId: null, acceptedAt: null, expiresAt: \{ gt: new Date\(\) \} \}/,
    );
  });

  it('inviteOne rolls back the created row when the send fails', () => {
    const s = src();
    expect(s).toMatch(/\.delete\(\{ where: \{ id: createdId \} \}\)/);
  });

  it('inviteOne validates through the shared normalizeEmail(), not a bare includes check', () => {
    const s = src();
    expect(s).toMatch(/const email = normalizeEmail\(rawEmail\);/);
  });
});
