import { describe, expect, it } from 'vitest';

import {
  createEmailReferral,
  createReferralLink,
  referralUrl,
  resolveReferralOpen,
} from '@/lib/referrals';
import { hashClientEmail } from '@/lib/attributed-clients';

/**
 * ISSUING AND OPENING REFERRALS (spec v1.4 §5.3, §5.4, R12).
 *
 * The two channels differ in exactly one way, and it decides money: WHEN the referral becomes
 * attached to a client.
 *
 *   EMAIL — attached at send. `receivedAt = emailSentAt = now`, because we know who it went to.
 *   LINK  — attached at OPEN. A copied link is tied to nobody until somebody opens it, so the
 *           first open is the earliest point it can be attributed to them (§5.4, "why received_at
 *           = opened_at"). Y's list entry must predate THAT to exempt the client (R5).
 *
 * ⚠️ THE TERM IS SNAPSHOTTED AT ISSUE (R12, §9 test 19). An operator shortening the admin term
 * must not expire links already handed out, and lengthening it must not revive dead ones.
 */

const X = 'practitioner-X';
const Y = 'practitioner-Y';
const NOW = new Date(Date.UTC(2026, 0, 1));

function fake(seed: { referral?: Record<string, unknown> | null } = {}) {
  const referrals: Record<string, unknown>[] = [];
  const touches: Record<string, unknown>[] = [];
  const listEntries: Record<string, unknown>[] = [];
  return {
    referrals,
    touches,
    listEntries,
    referral: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async create(args: any) {
        const row = { id: `ref_${referrals.length + 1}`, ...args.data };
        referrals.push(row);
        return row;
      },
      async findUnique() {
        return seed.referral ?? null;
      },
    },
    referralTouch: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async create(args: any) {
        const row = { id: `touch_${touches.length + 1}`, ...args.data };
        touches.push(row);
        return row;
      },
    },
    clientListEntry: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async upsert(args: any) {
        listEntries.push(args);
        return { id: 'entry_1' };
      },
    },
  };
}

describe('createReferralLink', () => {
  it('snapshots the term so a later admin change cannot move this link’s expiry (R12)', async () => {
    const db = fake();
    const result = await createReferralLink(db, {
      referrerId: X,
      referredId: Y,
      termMonths: 8,
      at: NOW,
    });

    const [row] = db.referrals;
    expect(row!.channel).toBe('LINK');
    expect(row!.termMonths).toBe(8);
    expect(row!.expiresAt).toEqual(new Date(Date.UTC(2026, 8, 1)));
    expect(result.url).toContain(`/r/${row!.token}`);
  });

  it('creates NO touch — a copied link is tied to nobody until somebody opens it (§5.4)', async () => {
    const db = fake();
    await createReferralLink(db, { referrerId: X, referredId: Y, termMonths: 8, at: NOW });

    expect(db.touches).toHaveLength(0);
    expect(db.listEntries).toHaveLength(0);
  });

  it('refuses a self-referral — nobody is paid for referring to themselves', async () => {
    const db = fake();
    await expect(
      createReferralLink(db, { referrerId: X, referredId: X, termMonths: 8, at: NOW }),
    ).rejects.toThrow(/USER:/);
  });

  it('mints a token with real entropy, not a guessable id', async () => {
    const db = fake();
    await createReferralLink(db, { referrerId: X, referredId: Y, termMonths: 8, at: NOW });
    await createReferralLink(db, { referrerId: X, referredId: Y, termMonths: 8, at: NOW });

    const [a, b] = db.referrals;
    expect(a!.token).not.toBe(b!.token);
    expect(String(a!.token).length).toBeGreaterThanOrEqual(32);
  });
});

describe('createEmailReferral', () => {
  it('spec §9 test 9 — attaches the client at SEND, and adds them to the referrer’s own list', async () => {
    const db = fake();
    await createEmailReferral(db, {
      referrerId: X,
      referredId: Y,
      clientEmail: 'Client@Example.com',
      clientName: 'Dana',
      note: 'She has been asking about sleep.',
      termMonths: 8,
      at: NOW,
    });

    const [referral] = db.referrals;
    expect(referral!.channel).toBe('EMAIL');
    expect(referral!.status).toBe('SENT');
    expect(referral!.emailSentAt).toEqual(NOW);

    const [touch] = db.touches;
    expect(touch!.clientEmail).toBe('client@example.com');
    expect(touch!.clientEmailHash).toBe(hashClientEmail('client@example.com'));
    // The whole point of the email channel: received the moment it was sent.
    expect(touch!.receivedAt).toEqual(NOW);
    expect(touch!.openedAt).toEqual(NOW);

    // §5.3.2 — C joins X's list, so X may see their address from then on.
    const [entry] = db.listEntries as { create: Record<string, unknown> }[];
    expect(entry!.create.source).toBe('REFERRAL_MADE');
    expect(entry!.create.addedAt).toEqual(NOW);
  });

  it('refuses an unparseable client address before writing anything', async () => {
    const db = fake();
    await expect(
      createEmailReferral(db, {
        referrerId: X,
        referredId: Y,
        clientEmail: 'nope',
        clientName: null,
        note: null,
        termMonths: 8,
        at: NOW,
      }),
    ).rejects.toThrow(/USER:/);

    expect(db.referrals).toHaveLength(0);
    expect(db.touches).toHaveLength(0);
  });
});

describe('resolveReferralOpen — what /r/<token> does', () => {
  const live = {
    id: 'ref_1',
    token: 'tok',
    referrerId: X,
    referredId: Y,
    channel: 'LINK',
    expiresAt: new Date(Date.UTC(2026, 8, 1)),
    referred: { slug: 'dr-y' },
  };

  it('creates a touch and hands back the redirect and the touch token', async () => {
    const db = fake({ referral: live });
    const result = await resolveReferralOpen(db, { token: 'tok', at: NOW });

    expect(result.redirectSlug).toBe('dr-y');
    expect(result.touchToken).toBeTruthy();
    const [touch] = db.touches;
    // §5.4: received_at = opened_at for a link. This is the timestamp R5 compares Y's list entry
    // against, so writing it at open rather than at payment is what stops Y listing the client
    // mid-flow and taking the referrer's share.
    expect(touch!.receivedAt).toEqual(NOW);
    expect(touch!.openedAt).toEqual(NOW);
    expect(touch!.clientEmailHash).toBeNull();
  });

  it('spec §9 test 15 — after expiry it still redirects, but records NOTHING', async () => {
    const db = fake({ referral: { ...live, expiresAt: new Date(Date.UTC(2025, 0, 1)) } });
    const result = await resolveReferralOpen(db, { token: 'tok', at: NOW });

    expect(result.redirectSlug).toBe('dr-y');
    expect(result.touchToken).toBeNull();
    expect(result.reason).toBe('EXPIRED');
    expect(db.touches).toHaveLength(0);
  });

  it('returns nothing to redirect to for an unknown token, rather than inventing a destination', async () => {
    const db = fake({ referral: null });
    const result = await resolveReferralOpen(db, { token: 'nope', at: NOW });

    expect(result.redirectSlug).toBeNull();
    expect(result.touchToken).toBeNull();
    expect(result.reason).toBe('UNKNOWN');
  });

  it('records no touch when the referred practitioner has gone', async () => {
    const db = fake({ referral: { ...live, referred: null } });
    const result = await resolveReferralOpen(db, { token: 'tok', at: NOW });

    expect(result.redirectSlug).toBeNull();
    expect(db.touches).toHaveLength(0);
  });
});

describe('referralUrl', () => {
  it('uses the apex domain, never a deployment alias — this link is pasted into messages', () => {
    expect(referralUrl('abc')).toMatch(/^https?:\/\/[^/]+\/r\/abc$/);
  });

  it('is deliberately NOT a ?ref= link — that param already means the opposite thing (canon D18)', () => {
    // `?ref=` marks a practitioner's OWN audience and resolves to 0%. A referral link resolving to
    // that would silently make every cross-referral free and pay the referrer nothing.
    expect(referralUrl('abc')).not.toContain('ref=');
  });
});
