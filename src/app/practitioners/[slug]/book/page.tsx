import { notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { prisma } from '@/lib/prisma';
import { bookableWhere } from '@/lib/practitioner-indexer';
import { startBookingIntent } from './actions';
import { recordScheduleSignal } from './[token]/actions';
import { BookingCaptureFlow } from '@/components/booking/BookingCaptureFlow';

type Props = {
  params: { slug: string };
  searchParams: {
    link?: string;
    offering?: string;
    /** A `ReferralTouch.touchToken` (spec §5.4.5 hop 4). Re-validated server-side at capture. */
    nhpr?: string;
  };
};

// Reads searchParams; there is nothing cacheable here.
export const dynamic = 'force-dynamic';

export const metadata = { robots: { index: false, follow: false } };

/**
 * THE SINGLE VIEW (§5, D12) — capture and the practitioner's calendar on ONE page.
 *
 * Public and unauthenticated: the buyer is not a user. Gated by `bookableWhere()`, NOT
 * `listedWhere()` — see that function for the distinction. "Unlisted" means absent from directory
 * search, not switched off, and trial-sweep's own email promises the profile "stays live at its
 * direct link". What IS still refused is a RETIRED row: an operator artefact whose owner mailbox
 * is typically dead, so a lead captured there is silently lost while the buyer is told otherwise.
 *
 * This page no longer takes `?error=`/`?name=`/`?email=` — the flow does not bounce through a
 * redirect any more, so there is nothing to repopulate and one less public page that echoed
 * URL-supplied text back to the visitor.
 */
export default async function BookCapturePage({ params, searchParams }: Props) {
  const practitioner = await prisma.practitioner.findFirst({
    where: { slug: params.slug, ...bookableWhere() },
    select: { id: true, slug: true, displayName: true, primaryBookingLinkId: true },
  });
  if (!practitioner) notFound();

  // Both ids are user-supplied. Resolve scoped to this practitioner; a supplied id that does not
  // resolve is a BROKEN LINK, not a reason to silently downgrade the buyer into a different flow
  // — quietly dropping an offering id would turn a paid booking into a free consultation.
  // IDOR discipline: "does not exist" and "belongs to someone else" produce one identical 404.
  const [offering, bookingLink] = await Promise.all([
    searchParams.offering
      ? prisma.whopProduct.findFirst({
          where: { id: searchParams.offering, practitionerId: practitioner.id, archived: false },
          select: { id: true, title: true, description: true, bookingLinkId: true },
        })
      : null,
    searchParams.link
      ? prisma.bookingLink.findFirst({
          where: { id: searchParams.link, practitionerId: practitioner.id },
          select: { id: true, label: true },
        })
      : null,
  ]);
  if (searchParams.offering && !offering) notFound();
  if (searchParams.link && !bookingLink) notFound();

  // §14.3 — the same precedence the capture action applies, so the placeholder the buyer sees and
  // the calendar they get are the same link. Computing it differently here would let the page
  // promise a calendar the action then declines to mount.
  const resolvedLinkId =
    bookingLink?.id ?? offering?.bookingLinkId ?? practitioner.primaryBookingLinkId ?? null;

  // `{ url }` only, deliberately WITHOUT `provider` (D16, §6). Provider is derived from the URL
  // by the adapter at use; the stored column is a reporting cache with a known-stale row.
  const scheduler = resolvedLinkId
    ? await prisma.bookingLink.findUnique({
        where: { id: resolvedLinkId },
        select: { url: true },
      })
    : null;

  const start = startBookingIntent.bind(null, params.slug);

  return (
    <main className="mx-auto max-w-2xl px-4 py-8 sm:py-12">
      <Link
        href={`/practitioners/${practitioner.slug}`}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        Back to {practitioner.displayName}
      </Link>

      <div className="mt-4">
        <BookingCaptureFlow
          slug={practitioner.slug}
          practitionerName={practitioner.displayName}
          schedulerUrl={scheduler?.url ?? null}
          bookingLinkId={bookingLink?.id ?? null}
          offeringId={offering?.id ?? null}
          subject={offering?.title ?? bookingLink?.label ?? null}
          subjectDescription={offering?.description ?? null}
          // Rendered as a hidden field, exactly like the two ids above. The capture action
          // re-validates it against this practitioner before storing anything — the param is
          // attacker-supplied, and it decides who receives 20% of the session.
          referralTouchToken={searchParams.nhpr?.trim() || null}
          start={start}
          advance={recordScheduleSignal}
        />
      </div>
    </main>
  );
}
