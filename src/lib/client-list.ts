/**
 * A PRACTITIONER'S OWN CLIENT LIST (spec v1.4 §5.2, R4/R5) — and the privacy rule around it.
 *
 * This list is the only thing that can make a session free, so two properties matter more than
 * anything else here:
 *
 *  1. `addedAt` IS IMMUTABLE. R5 compares it against the first booking and against any referral.
 *     A re-add that moved it would let a practitioner retro-exempt a client after a fee was owed,
 *     so the upsert's `update` branch touches the NAME and nothing else.
 *
 *  2. 🔒 EVERY READ IS SCOPED BY PRACTITIONER. Operator ruling 2026-09-18: a practitioner may see
 *     a client's email where they serviced, invited/added, were referred, or referred that client.
 *     Every source this table accepts is one of those four, which is why the address is readable
 *     HERE and hashed in `AttributedClient`. That model carries a bare `@@index([emailHash])` for
 *     the cross-practitioner leakage sweep — precisely the index that makes a hash-only lookup
 *     cheap, and precisely the query that would return another practitioner's clients. No read in
 *     this module is shaped that way, and `tests/client-list-privacy.test.ts` asserts it.
 *
 * ⚠️ X LEARNS NOTHING ABOUT Y. A referral row serialises its status and no more (§5.2A, §9 test
 * 12): X must not be able to tell "C was already Y's client, so you earned nothing" apart from
 * "not booked yet". The row type has no field that could say so — by construction, not omission.
 */

import { hashClientEmail } from './attributed-clients';
import { normalizeEmail } from './email';

export type ClientListSource =
  | 'MANUAL_ADD'
  | 'CSV_IMPORT'
  | 'EMAIL_INVITE'
  | 'SHARE_LINK'
  | 'REFERRAL_MADE'
  | 'BOOKED';

export type AddClientsDb = {
  clientListEntry: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    upsert(args: any): Promise<any>;
  };
};

export type AddClientsResult = {
  added: number;
  /** Addresses that could not be parsed — reported back rather than silently dropped. */
  rejected: string[];
  /** The rows touched, so a caller that needs to send an invite knows what to send it for. */
  entries: { id: string | null; email: string; emailHash: string }[];
};

/**
 * Add clients to a practitioner's list, idempotently.
 *
 * Deliberately NOT a `createMany`: the whole point is the upsert's asymmetry — create writes
 * `addedAt` and `source`, update writes neither.
 */
export async function addClientEntries(
  db: AddClientsDb,
  input: {
    practitionerId: string;
    source: ClientListSource;
    entries: { email: string; name: string | null }[];
    at?: Date;
    /** Stamped on create AND on update, because a re-invite genuinely re-sends. */
    invitedAt?: Date | null;
  },
): Promise<AddClientsResult> {
  const at = input.at ?? new Date();
  const rejected: string[] = [];
  const seen = new Set<string>();
  const entries: AddClientsResult['entries'] = [];

  for (const raw of input.entries) {
    const email = normalizeEmail(raw.email);
    if (!email) {
      rejected.push(raw.email.trim());
      continue;
    }
    // De-duplicate WITHIN the submission. A pasted list routinely repeats an address in two cases,
    // and two upserts in the same call would have the second one's `update` branch run against a
    // row the first had just created — harmless today, but it makes the "create only once"
    // property depend on ordering rather than on the loop.
    if (seen.has(email)) continue;
    seen.add(email);

    const emailHash = hashClientEmail(email);
    const row = await db.clientListEntry.upsert({
      where: { practitionerId_emailHash: { practitionerId: input.practitionerId, emailHash } },
      create: {
        practitionerId: input.practitionerId,
        email,
        emailHash,
        name: raw.name?.trim() || null,
        addedAt: at,
        source: input.source,
        invitedAt: input.invitedAt ?? null,
      },
      // ⚠️ NO `addedAt` AND NO `source`. Moving either is how a client gets retro-exempted after
      // money was owed — see the module docstring. The name may be corrected; the lock may not.
      update: {
        ...(raw.name?.trim() ? { name: raw.name.trim() } : {}),
        ...(input.invitedAt ? { invitedAt: input.invitedAt } : {}),
      },
    });
    entries.push({ id: (row as { id?: string } | null)?.id ?? null, email, emailHash });
  }

  return { added: entries.length, rejected, entries };
}

export type ClientListRow = {
  email: string;
  name: string | null;
  addedAt: Date;
  source: string;
  status: 'BOOKED' | 'INVITED' | 'ADDED';
  /** Who sourced them, once they have actually booked. Null until then. */
  sourcedBy: 'PRACTITIONER' | 'NHP' | null;
  termEndsAt: Date | null;
  /** Referrals THIS practitioner made for this client. Status only — never Y's side. */
  referrals: ReferralSummary[];
};

/**
 * What X may know about a referral X made.
 *
 * Four fields, and the absence of a fifth is the point. Adding anything about the referred
 * practitioner's own relationship with the client — whether they were already listed, whether the
 * referral earned — would violate §5.2A, and spec §9 test 12 turns on exactly that distinction.
 */
export type ReferralSummary = {
  referredName: string;
  referredSlug: string;
  /** ISSUED | SENT | OPENED | BOOKED | EXPIRED. */
  status: string;
  expiresAt: Date;
};

export function buildClientList(input: {
  entries: {
    email: string;
    emailHash: string;
    name: string | null;
    addedAt: Date;
    source: string;
    invitedAt: Date | null;
  }[];
  /** Hashes with at least one PAID booking for this practitioner. */
  paidEmailHashes: Set<string>;
  attributions: Map<string, { owner: string; termEndsAt: Date | null }>;
  referralsByEmailHash: Map<string, ReferralSummary[]>;
}): ClientListRow[] {
  return input.entries.map((e) => {
    const booked = input.paidEmailHashes.has(e.emailHash);
    const attribution = booked ? input.attributions.get(e.emailHash) : undefined;
    return {
      email: e.email,
      name: e.name,
      addedAt: e.addedAt,
      source: e.source,
      status: booked ? 'BOOKED' : e.invitedAt || e.source === 'EMAIL_INVITE' ? 'INVITED' : 'ADDED',
      // Only shown once they have booked. Before that there is no decision, and rendering the
      // column default would tell the practitioner a claim exists that does not.
      sourcedBy: attribution ? (attribution.owner === 'PRACTITIONER' ? 'PRACTITIONER' : 'NHP') : null,
      termEndsAt: attribution?.termEndsAt ?? null,
      referrals: input.referralsByEmailHash.get(e.emailHash) ?? [],
    };
  });
}

export type ClientListDb = {
  clientListEntry: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany(args: any): Promise<any>;
  };
  bookingIntent: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany(args: any): Promise<any>;
  };
  attributedClient: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany(args: any): Promise<any>;
  };
  referral: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany(args: any): Promise<any>;
  };
};

/** How many list rows one page will render. A practitioner's list is not a data export. */
export const CLIENT_LIST_PAGE_SIZE = 200;

export async function loadClientList(
  db: ClientListDb,
  practitionerId: string,
): Promise<ClientListRow[]> {
  const [entries, paidIntents, attributions, referrals] = (await Promise.all([
    db.clientListEntry.findMany({
      where: { practitionerId },
      orderBy: { addedAt: 'desc' },
      take: CLIENT_LIST_PAGE_SIZE,
      select: {
        email: true,
        emailHash: true,
        name: true,
        addedAt: true,
        source: true,
        invitedAt: true,
      },
    }),
    // PAID only. `status: 'PAID'` and a non-null `paidAt` say the same thing today and are both
    // checked, because `paidAt` is the one the webhook writes and `status` is the one the UI reads.
    db.bookingIntent.findMany({
      where: { practitionerId, status: 'PAID', paidAt: { not: null } },
      select: { email: true },
    }),
    db.attributedClient.findMany({
      where: { practitionerId },
      select: { emailHash: true, owner: true, termEndsAt: true },
    }),
    // Referrals THIS practitioner made. Scoped on `referrerId`, never on the client hash alone —
    // the latter would surface referrals other practitioners made for the same person.
    db.referral.findMany({
      where: { referrerId: practitionerId },
      orderBy: { issuedAt: 'desc' },
      select: {
        status: true,
        expiresAt: true,
        referred: { select: { displayName: true, slug: true } },
        touches: { select: { clientEmailHash: true, status: true } },
      },
    }),
  ])) as [
    Parameters<typeof buildClientList>[0]['entries'],
    { email: string }[],
    { emailHash: string; owner: string | null; termEndsAt: Date | null }[],
    {
      status: string;
      expiresAt: Date;
      referred: { displayName: string; slug: string } | null;
      touches: { clientEmailHash: string | null; status: string }[];
    }[],
  ];

  const paidEmailHashes = new Set(paidIntents.map((i) => hashClientEmail(i.email)));

  const attributionMap = new Map(
    attributions.map((a) => [a.emailHash, { owner: a.owner ?? 'NHP', termEndsAt: a.termEndsAt }]),
  );

  const referralsByEmailHash = new Map<string, ReferralSummary[]>();
  for (const r of referrals) {
    if (!r.referred) continue;
    for (const touch of r.touches) {
      if (!touch.clientEmailHash) continue;
      const list = referralsByEmailHash.get(touch.clientEmailHash) ?? [];
      list.push({
        referredName: r.referred.displayName,
        referredSlug: r.referred.slug,
        // The TOUCH's status, not the referral's: one copied link reaches several clients, and the
        // referral-level status cannot say which of them booked.
        status: touch.status,
        expiresAt: r.expiresAt,
      });
      referralsByEmailHash.set(touch.clientEmailHash, list);
    }
  }

  return buildClientList({ entries, paidEmailHashes, attributions: attributionMap, referralsByEmailHash });
}
