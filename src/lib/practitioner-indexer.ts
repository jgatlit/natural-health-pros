import type {
  Practitioner,
  City,
  Specialty,
  PractitionerSpecialty,
  SubscriptionStatus,
  Role,
  Prisma,
} from '@prisma/client';
import { prisma } from './prisma';
import { SPECIALTY_ORDER } from './practitioner-ordering';
import { getTypesenseAdmin, TYPESENSE_COLLECTION } from './typesense-server';

type PractitionerForIndex = Practitioner & {
  city: City | null;
  specialties: (PractitionerSpecialty & { specialty: Specialty })[];
  user: { role: Role };
};

export type PractitionerDoc = {
  id: string;
  slug: string;
  displayName: string;
  bio?: string;
  photoUrl?: string;
  cityName: string;
  cityState: string;
  location?: [number, number];
  specialtyNames: string[];
  specialtySlugs: string[];
  // Dual-label model: the practitioner's own phrasing (rawLabel). Searchable so their
  // voice is findable, but kept OUT of the facet list (specialtyNames stays the curated facet).
  specialtyLabels: string[];
  acceptedAt: number;
  yearsInPractice?: number;
  searchText?: string;
  isComplete: boolean;
};

const MIN_BIO_LENGTH = 20;

/**
 * Completeness gate (Phase 2.5): the four signals that make a profile
 * worth showing on public discovery surfaces. Direct profile URLs still
 * work for incomplete practitioners (shareability preserved) — they're
 * just hidden from /search + / recently-joined until the practitioner
 * fills these in.
 */
export type CompletenessSignals = {
  hasDisplayName: boolean;
  hasCity: boolean;
  hasBio: boolean;
  hasSpecialty: boolean;
};

export function profileCompletenessSignals(p: {
  displayName: string | null;
  cityId: string | null;
  bio: string | null;
  specialties: { specialtyId: string }[];
}): CompletenessSignals {
  return {
    hasDisplayName: !!p.displayName && p.displayName.trim().length > 0,
    hasCity: !!p.cityId,
    hasBio: !!p.bio && p.bio.trim().length >= MIN_BIO_LENGTH,
    hasSpecialty: p.specialties.length >= 1,
  };
}

export function isProfileComplete(p: Parameters<typeof profileCompletenessSignals>[0]): boolean {
  const s = profileCompletenessSignals(p);
  return s.hasDisplayName && s.hasCity && s.hasBio && s.hasSpecialty;
}

/**
 * Listing gate (Layer X + 90-day trial clock — see
 * docs/superpowers/specs/2026-07-16-pilot-trial-design.md): a profile is publicly
 * discoverable only when it's complete AND one of:
 *   - subscriptionStatus is ACTIVE or PAST_DUE (Whop's dunning window — grace for
 *     payers, so a failed card doesn't delist someone instantly)
 *   - trialEndsAt is null (pre-trial, operator-seeded, never onboarded — the 12
 *     existing pilots) or still in the future (trial running)
 *   - the owning user is ADMIN (staff/client are not customers; read server-side
 *     from the DB so the stale-JWT gap can't affect listing)
 * Direct profile URLs still resolve for everyone — this only controls /search +
 * recently-joined + the home page's featured list.
 *
 * `comped` is DEPRECATED and no longer read here — see the schema comment on that column.
 */
export function isListed(
  p: Parameters<typeof profileCompletenessSignals>[0] & {
    subscriptionStatus: SubscriptionStatus;
    trialEndsAt: Date | null;
    delistedAt: Date | null;
    archivedAt: Date | null;
    user: { role: Role };
  },
): boolean {
  // Operator overrides are checked FIRST and deliberately sit OUTSIDE the OR below. They are not
  // one more exemption to be weighed against the others — they are a veto. Folding either into
  // the OR would make them unable to beat `role === 'ADMIN'`, i.e. an admin's own profile could
  // never be hidden, which is precisely the case the toggle was asked for.
  if (p.delistedAt !== null || p.archivedAt !== null) return false;
  const trialActive = p.trialEndsAt === null || p.trialEndsAt > new Date();
  return (
    isProfileComplete(p) &&
    (p.subscriptionStatus === 'ACTIVE' ||
      p.subscriptionStatus === 'PAST_DUE' ||
      trialActive ||
      p.user.role === 'ADMIN')
  );
}

/**
 * The same rule as isListed(), expressed as a Prisma `where` clause so callers can
 * filter inside a query instead of fetching every practitioner and filtering in memory
 * (the home page's featured + count queries). Single source of truth: consumers import
 * this rather than re-deriving the OR — isListed() and listedWhere() must never drift, in code OR in time.
 */
export function listedWhere(): Prisma.PractitionerWhereInput {
  // MUST be a function, not a module-level const. `new Date()` in a const is evaluated once,
  // at module load, and then frozen — and Vercel's Fluid Compute reuses function instances
  // across requests, so the module stays resident and the trial cutoff would never advance.
  // Every practitioner whose trial expired after boot would linger on the home page while
  // isListed() (which calls new Date() per invocation) correctly dropped them from Typesense.
  // That is exactly the drift this pair exists to prevent — just in time rather than in code.
  return {
    // Operator vetoes, ANDed with everything else — never members of the OR, for the reason
    // spelled out in isListed(). These two clauses are the only reason this pair can drift:
    // add a veto here and you MUST add it there, and vice versa.
    delistedAt: null,
    archivedAt: null,
    displayName: { not: '' },
    cityId: { not: null },
    bio: { not: null },
    specialties: { some: {} },
    OR: [
      { subscriptionStatus: 'ACTIVE' },
      { subscriptionStatus: 'PAST_DUE' },
      { trialEndsAt: null },
      { trialEndsAt: { gt: new Date() } },
      { user: { role: 'ADMIN' } },
    ],
  };
}

/**
 * The RETIREMENT sentinel: `trialEndsAt` backdated to the epoch.
 *
 * Not a great marker, and named here so it is at least a marker rather than a magic date buried
 * in two scripts. `scripts/retire-duplicate-sarah-row.ts` and `scripts/retire-operator-test-listing.ts`
 * retire a row by backdating its trial clock, because that was the only lever that existed. The
 * invitation table uses the same convention (`expiresAt` epoch 0 = revoked).
 *
 * ⚠️ A dedicated `retiredAt` column would be the honest fix. Until then, anything that must
 * distinguish "retired" from "merely unlisted" has to key on this, and it must do so THROUGH
 * `bookableWhere()` rather than re-deriving the comparison.
 */
export const RETIREMENT_SENTINEL = new Date('1971-01-01T00:00:00.000Z');

/**
 * Who may be BOOKED — as distinct from who may be DISCOVERED.
 *
 * `listedWhere()` conflates two unrelated predicates: profile COMPLETENESS (displayName, city,
 * bio, specialties) and BILLING standing. That is right for the directory, which is a promotional
 * surface, and wrong for the booking flow, which was rejecting people for both reasons:
 *
 *   - A practitioner mid-onboarding with no bio could not take a lead through her own link.
 *   - A practitioner past her trial had a live profile whose Book buttons 404'd — contradicting
 *     trial-sweep's own warning email, which promises the profile "stays live at its direct link,
 *     but stops appearing in directory search".
 *
 * So booking gates on ONE thing: the row has not been retired. A retired row is an operator
 * artefact — a duplicate created by a corrected email, or a test listing — and is typically owned
 * by a mailbox nobody reads. `sarah-schindler` is exactly that: retired 2026-08-12, owner
 * `hello@livingaligned.love`, which Sarah confirmed on the 2026-08-11 call is dead. Capturing a
 * lead there sends it to no one while telling the buyer their details were received.
 *
 * ⚠️ NOTE WHAT THIS DELIBERATELY DOES NOT DO. It does not test billing standing, so a practitioner
 * whose trial lapsed keeps a working checkout. That follows from the operator's rule that unlisted
 * profiles stay bookable, and today no row is in that state (every live trialEndsAt is null). It
 * becomes a live policy question the moment `scripts/backfill-trial-dates.ts` starts the pilot
 * clocks — flagged rather than decided here.
 */
export function bookableWhere(): Prisma.PractitionerWhereInput {
  return {
    // `archivedAt` is here and `delistedAt` is NOT, and that asymmetry is the whole point.
    // Delisting hides a working practice from the directory — she keeps taking bookings through
    // the link she sends clients herself (§17, PR #70). Archiving is a soft DELETE, so it must
    // also close the door: an archived row's Book buttons stop, exactly as a hard delete would,
    // while the booking intents a hard delete would have cascaded away are preserved.
    archivedAt: null,
    OR: [{ trialEndsAt: null }, { trialEndsAt: { gt: RETIREMENT_SENTINEL } }],
  };
}

export function toTypesenseDoc(p: PractitionerForIndex): PractitionerDoc {
  const specialtyNames = new Set<string>();
  const specialtySlugs = new Set<string>();
  const specialtyLabels = new Set<string>();
  for (const ps of p.specialties) {
    specialtyNames.add(ps.specialty.name);
    specialtySlugs.add(ps.specialty.slug);
    if (ps.rawLabel && ps.rawLabel.trim()) specialtyLabels.add(ps.rawLabel.trim());
  }

  const location: [number, number] | undefined =
    p.latitude != null && p.longitude != null ? [p.latitude, p.longitude] : undefined;

  return {
    id: p.id,
    slug: p.slug,
    displayName: p.displayName,
    bio: p.bio ?? undefined,
    photoUrl: p.photoUrl ?? undefined,
    cityName: p.city?.name ?? '',
    cityState: p.city?.state ?? '',
    location,
    specialtyNames: Array.from(specialtyNames),
    specialtySlugs: Array.from(specialtySlugs),
    specialtyLabels: Array.from(specialtyLabels),
    acceptedAt: p.acceptedAt ? Math.floor(p.acceptedAt.getTime() / 1000) : 0,
    yearsInPractice: p.yearsInPractice ?? undefined,
    searchText: p.searchText ?? undefined,
    isComplete: isProfileComplete(p),
  };
}

const PRACTITIONER_INCLUDE = {
  city: true,
  // Ordered so the indexed document matches what the profile renders; without this the
  // Typesense doc's specialty order was whatever Postgres happened to return.
  specialties: {
    include: { specialty: true },
    orderBy: SPECIALTY_ORDER,
  },
  user: { select: { role: true } },
} as const;

export async function indexPractitioner(id: string): Promise<void> {
  if (!process.env.TYPESENSE_ADMIN_API_KEY) return;
  const p = await prisma.practitioner.findUnique({
    where: { id },
    include: PRACTITIONER_INCLUDE,
  });
  if (!p) return;
  // Listing gate: an unsubscribed/incomplete practitioner is removed from discovery.
  if (!isListed(p)) {
    await deleteFromIndex(id);
    return;
  }
  await getTypesenseAdmin()
    .collections(TYPESENSE_COLLECTION)
    .documents()
    .upsert(toTypesenseDoc(p));
}

export async function indexAllPractitioners(): Promise<{ indexed: number }> {
  const practitioners = await prisma.practitioner.findMany({ include: PRACTITIONER_INCLUDE });
  // Listing gate: only index listed practitioners; drop any that are no longer listed.
  await Promise.all(
    practitioners.filter((p) => !isListed(p)).map((p) => deleteFromIndex(p.id).catch(() => {})),
  );
  const docs = practitioners.filter(isListed).map(toTypesenseDoc);
  if (docs.length === 0) return { indexed: 0 };
  const result = await getTypesenseAdmin()
    .collections(TYPESENSE_COLLECTION)
    .documents()
    .import(docs, { action: 'upsert' });
  const failed = result.filter((r: { success: boolean }) => !r.success);
  if (failed.length > 0) {
    console.error('Typesense indexing errors:', failed.slice(0, 5));
    throw new Error(`Typesense indexing failed for ${failed.length}/${docs.length} documents`);
  }
  return { indexed: docs.length };
}

/**
 * Reindex one practitioner AND CONFIRM Typesense agrees.
 *
 * `indexPractitioner()` + `deleteFromIndex()` cannot report failure: the latter swallows every
 * error in a bare catch, so a delist that never reached Typesense is indistinguishable from one
 * that did. That is tolerable for the cron sweeps, which run again tomorrow. It is NOT tolerable
 * for an operator toggle, where the whole interaction is a person asserting "this practitioner is
 * now hidden" and being shown a screen that says it worked.
 *
 * So this writes, then READS BACK, and reports the disagreement. Note the delete path
 * distinguishes 404 (already absent — success) from every other error (a real failure): treating
 * them alike is how "absent" and "unreachable" became the same answer in the first place.
 *
 * `verified: false` means Typesense is not configured in this environment, so the write was a
 * no-op and nothing was checked — a distinct outcome from a confirmed sync, and never reported
 * as one.
 */
export type IndexSyncResult =
  | { ok: true; listed: boolean; verified: boolean }
  | { ok: false; reason: string };

async function documentExists(id: string): Promise<boolean> {
  try {
    await getTypesenseAdmin().collections(TYPESENSE_COLLECTION).documents(id).retrieve();
    return true;
  } catch (err) {
    if ((err as { httpStatus?: number })?.httpStatus === 404) return false;
    throw err;
  }
}

export async function indexPractitionerVerified(id: string): Promise<IndexSyncResult> {
  const p = await prisma.practitioner.findUnique({ where: { id }, include: PRACTITIONER_INCLUDE });
  if (!p) return { ok: false, reason: 'practitioner-not-found' };

  const listed = isListed(p);
  if (!process.env.TYPESENSE_ADMIN_API_KEY) return { ok: true, listed, verified: false };

  try {
    if (listed) {
      await getTypesenseAdmin()
        .collections(TYPESENSE_COLLECTION)
        .documents()
        .upsert(toTypesenseDoc(p));
    } else {
      try {
        await getTypesenseAdmin().collections(TYPESENSE_COLLECTION).documents(id).delete();
      } catch (err) {
        if ((err as { httpStatus?: number })?.httpStatus !== 404) throw err;
      }
    }
  } catch (err) {
    return { ok: false, reason: `write-failed: ${(err as Error)?.message ?? String(err)}` };
  }

  let present: boolean;
  try {
    present = await documentExists(id);
  } catch (err) {
    return { ok: false, reason: `verify-failed: ${(err as Error)?.message ?? String(err)}` };
  }
  if (present !== listed) {
    return { ok: false, reason: `mismatch: expected indexed=${listed}, found ${present}` };
  }
  return { ok: true, listed, verified: true };
}

export async function deleteFromIndex(id: string): Promise<void> {
  if (!process.env.TYPESENSE_ADMIN_API_KEY) return;
  try {
    await getTypesenseAdmin().collections(TYPESENSE_COLLECTION).documents(id).delete();
  } catch {
    // Doc may not exist; safe to swallow.
  }
}
