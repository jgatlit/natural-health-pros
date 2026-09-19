/**
 * ADMIN OVERRIDE OF AN ATTRIBUTION (spec v1.4 §3.2, §7).
 *
 * §3.1's decision is taken once and is otherwise immutable — that immutability is what stops a
 * list entry added mid-relationship from retro-exempting a client, and what stops a late referral
 * from stealing credit for an introduction somebody else made. This is the one sanctioned way
 * past it, and it carries two obligations that are not optional:
 *
 *  1. A NOTE IS REQUIRED. An unexplained change to who gets paid is unauditable the moment the
 *     person who made it stops remembering why.
 *  2. AN ADJUSTMENT ENTRY IS WRITTEN. A change recorded only on the row is invisible to the
 *     reconciliation that exists to make the ledger trustworthy.
 *
 * ⚠️ THIS DOES NOT RE-PRICE ANYTHING ALREADY CHARGED. `BookingFeeSnapshot` records what was
 * actually collected and Whop has already taken it. The override changes what happens NEXT; the
 * adjustment entry records the difference, for a human to act on if money needs returning.
 */

export type OverrideDb = {
  attributedClient: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findUnique(args: any): Promise<any>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update(args: any): Promise<any>;
  };
  feeLedgerEntry: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    create(args: any): Promise<any>;
  };
};

export async function overrideAttribution(
  db: OverrideDb,
  input: {
    attributionId: string;
    owner?: 'PRACTITIONER' | 'NHP';
    /** Pass `null` to clear the referrer; omit to leave it alone. */
    referrerPractitionerId?: string | null;
    note: string;
    adminUserId: string;
    at?: Date;
  },
): Promise<void> {
  const at = input.at ?? new Date();
  const note = input.note?.trim() ?? '';
  if (!note) {
    throw new Error('USER:An override needs a note explaining why.');
  }

  const row = (await db.attributedClient.findUnique({
    where: { id: input.attributionId },
    select: { id: true, practitionerId: true, owner: true, referrerPractitionerId: true },
  })) as {
    id: string;
    practitionerId: string;
    owner: string | null;
    referrerPractitionerId: string | null;
  } | null;
  if (!row) throw new Error('USER:That attribution no longer exists.');

  const changes: string[] = [];
  const data: Record<string, unknown> = {};

  if (input.owner && input.owner !== (row.owner ?? 'NHP')) {
    changes.push(`owner ${row.owner ?? 'NHP'} → ${input.owner}`);
    data.owner = input.owner;
  }
  if (
    input.referrerPractitionerId !== undefined &&
    input.referrerPractitionerId !== row.referrerPractitionerId
  ) {
    changes.push(
      `referrer ${row.referrerPractitionerId ?? 'none'} → ${input.referrerPractitionerId ?? 'none'}`,
    );
    data.referrerPractitionerId = input.referrerPractitionerId;
  }

  // A no-op override is a mis-click, not an audit event. Recording one would put a change in the
  // log that did not happen and would make the log less trustworthy, not more.
  if (changes.length === 0) {
    throw new Error('USER:Nothing would change.');
  }

  await db.attributedClient.update({
    where: { id: row.id },
    data: {
      ...data,
      decidedByRule: 'ADMIN_OVERRIDE',
      decidedAt: at,
      overriddenByUserId: input.adminUserId,
      overriddenAt: at,
      overrideNote: note,
    },
  });

  await db.feeLedgerEntry.create({
    data: {
      // Unique per override, not per attribution: a row may legitimately be corrected twice, and
      // a key that collided would silently drop the second correction.
      dedupeKey: `ADMIN_ADJUSTMENT:${row.id}:${at.toISOString()}`,
      kind: 'ADMIN_ADJUSTMENT',
      status: 'SETTLED',
      practitionerId: row.practitionerId,
      counterpartyPractitionerId: data.referrerPractitionerId ?? row.referrerPractitionerId ?? null,
      // ZERO, deliberately. This entry does not move money — Whop has already taken what it took.
      // It records that a decision changed, so the difference is visible to somebody who can act.
      amountUsdCents: 0,
      note: `${changes.join('; ')} — ${note}`,
    },
  });
}
