import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Check } from 'lucide-react';
import { prisma } from '@/lib/prisma';
import { bookableWhere } from '@/lib/practitioner-indexer';
import { Card } from '@/components/ui/card';
import { flowShape, paymentsLive } from '@/lib/booking-flow';
import { SchedulerStep } from '@/components/booking/SchedulerStep';
import { recordScheduleSignal } from './actions';
import { createBookingCheckoutConfig } from '@/lib/whop';
import { effectivePlan, sessionFeeCents } from '@/lib/pricing-plans';
import { attributionTermState } from '@/lib/attributed-clients';
import { CheckoutStep } from '@/components/booking/CheckoutStep';
import { headers } from 'next/headers';

type Props = { params: { slug: string; token: string } };

export const dynamic = 'force-dynamic';
export const metadata = { robots: { index: false, follow: false } };

/**
 * The flow shell, addressed by BookingIntent.publicToken (§5).
 *
 * THE TOKEN IN THE URL IS THE POINT. It is what makes returning here IDEMPOTENT, which is what
 * lets the T3 new-tab fallback and §10's resume link work at all — a buyer who leaves for their
 * scheduler, or returns from an abandonment email an hour later, lands on the same intent rather
 * than starting over or creating a second lead.
 *
 * It is a RANDOM token rather than the primary key precisely because it is an unauthenticated
 * bearer credential that §10 mails out. See the column's own docstring for why a cuid was not
 * good enough for that job.
 */
export default async function BookingFlowPage({ params }: Props) {
  // Scoped by slug and by `bookableWhere()` — deliberately NOT by the listing gate.
  //
  // "Unlisted" means absent from directory search — it does not mean the profile is switched off.
  // trial-sweep's own warning email promises exactly this: "your profile stays live at its direct
  // link, but stops appearing in directory search once the trial ends." Gating the flow on
  // listedWhere() broke that promise: the profile rendered with Book buttons that 404'd, so a
  // practitioner sending her own link to a client watched them dead-end, and neither side was
  // told why. It also silently applied a COMPLETENESS test (bio, city, specialty) to booking,
  // which has nothing to do with whether someone may book.
  //
  // IDOR discipline is unchanged: the slug scoping stays, so a token that does not belong to this
  // practitioner still produces one identical 404.
  const intent = await prisma.bookingIntent.findFirst({
    where: { publicToken: params.token, practitioner: { slug: params.slug, ...bookableWhere() } },
    select: {
      id: true,
      publicToken: true,
      name: true,
      status: true,
      practitionerId: true,
      practitioner: {
        select: {
          slug: true,
          displayName: true,
          whopPayoutsEnabled: true,
          whopCompanyId: true,
          plan: true,
        },
      },
      email: true,
      whopCheckoutSessionId: true,
      whopCheckoutPurchaseUrl: true,
      paidAt: true,
      offering: {
        select: {
          id: true,
          title: true,
          description: true,
          archived: true,
          acceptsPayments: true,
          whopPlanId: true,
          whopCheckoutConfigId: true,
          purchaseUrl: true,
          priceUsdCents: true,
        },
      },
      bookingLink: { select: { url: true, label: true } },
    },
  });
  if (!intent) notFound();

  // An offering archived after capture must stop driving this flow — otherwise the buyer can pay
  // for something the practitioner has retired (archiving and unpublishing are separate actions,
  // so the Whop fields may still be populated). Both other entry points already scope on this.
  const offering = intent.offering && !intent.offering.archived ? intent.offering : null;

  const live = offering
    ? paymentsLive({
        acceptsPayments: offering.acceptsPayments,
        practitionerPayoutsEnabled: intent.practitioner.whopPayoutsEnabled,
        whopPlanId: offering.whopPlanId,
      })
    : false;

  const shape = flowShape({
    hasSchedulerUrl: !!intent.bookingLink?.url,
    paymentsLive: live,
  });

  // A settled intent must not render an actionable screen: showing "pick a time" to someone who
  // already paid invites a second booking of a session they hold, and §10's resume link points
  // at this exact URL.
  const settled = intent.status === 'PAID' || intent.paidAt !== null;
  // Already past step 2. Rendering the scheduler again would hide the payment CTA behind a
  // second trip through a calendar they have already used — and §10's resume email points here.
  const alreadyScheduled = intent.status === 'SCHEDULED';
  const schedulerUrl = intent.bookingLink?.url ?? null;
  const needsSchedule = shape.showSchedule && schedulerUrl !== null && !alreadyScheduled;
  const checkoutUrl = live ? (offering?.purchaseUrl ?? null) : null;

  // Mint ONE checkout configuration per booking, only when the checkout step will actually
  // render, and reuse it forever after.
  //
  // An earlier revision minted on every render of this public force-dynamic page — including the
  // scheduler branch, which never used the result — so an ordinary refresh, prefetch or crawler
  // drove unbounded POSTs to Whop and blocked TTFB for nothing.
  //
  // NO EXPIRY CHECK, deliberately. The previous revision stored a `chs_` SESSION, which expires in
  // 24h and had to be aged out. Configurations carry no `expires_at` at all, so the stored id
  // stays valid however late §10's resume email brings the buyer back. See
  // createBookingCheckoutConfig for why sessions were abandoned entirely — they render a 404.
  const canEmbed = live && !settled && !!offering?.whopPlanId && !!offering.whopCheckoutConfigId;
  const willRenderCheckout = canEmbed && !needsSchedule;
  // After the buyer advances past step 2 the server re-renders into the embed, so step 2 must not
  // offer the unattributed hosted link in the meantime.
  const willEmbedAfterSchedule = canEmbed && needsSchedule;

  let checkoutConfigId: string | null = intent.whopCheckoutSessionId;
  let intentPurchaseUrl: string | null = intent.whopCheckoutPurchaseUrl;

  if (willRenderCheckout && !checkoutConfigId) {
    // THE FEE IS RESOLVED PER BOOKING, NOT PER OFFERING. Both plans take their share of every
    // platform-sourced session INSIDE the lead attribution term and nothing after it, so the same
    // offering owes a different fee depending on who is buying and when — which only the
    // attribution ledger can answer.
    //
    // A practitioner who has not chosen a plan (`plan` null — every pre-2026-09-18 listing) is
    // charged nothing. Enrolling them in a split they never picked would be worse than collecting
    // late.
    // An unchosen plan resolves to Plan B (operator ruling 2026-09-18) rather than to "no fee":
    // the stored column stays null, but the commercial default is real.
    const planKey = effectivePlan(intent.practitioner.plan);
    // THE TERM, not the old claim state. A client inside the attribution term is chargeable on
    // EVERY sourced session (operator ruling, 2026-09-18); outside it, both plans charge 0% and
    // there is no branch left that can re-charge a first-session fee on someone we introduced
    // years ago.
    const term = await attributionTermState(prisma, {
      practitionerId: intent.practitionerId,
      email: intent.email,
    });
    const feeCents = sessionFeeCents({
      plan: planKey,
      term,
      priceUsdCents: offering!.priceUsdCents,
    });

    const minted = await createBookingCheckoutConfig({
      planId: offering!.whopPlanId!,
      practitionerId: intent.practitionerId,
      offeringId: offering!.id,
      bookingIntentId: intent.id,
      slug: params.slug,
      publicToken: intent.publicToken,
      applicationFeeCents: feeCents,
      companyId: intent.practitioner.whopCompanyId,
      title: offering!.title,
      priceUsdCents: offering!.priceUsdCents,
    })
      // Never fatal — a failed mint degrades to the offering's hosted checkout (§8) rather than
      // stranding a buyer who is ready to pay.
      .catch((err) => {
        console.error('[booking] checkout config mint failed', {
          intentId: intent.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      });

    if (minted) {
      // Guarded write, not a bare update. Two requests can reach the mint before either stores
      // (a resume link opened twice, a double-click, a prefetch racing the navigation); a plain
      // update would let the second overwrite the first and orphan a configuration on Whop.
      // Whoever writes first wins, and the loser re-reads and uses the winner's.
      const claimed = await prisma.bookingIntent.updateMany({
        where: { id: intent.id, whopCheckoutSessionId: null },
        data: {
          whopCheckoutSessionId: minted.checkoutConfigId,
          whopCheckoutPurchaseUrl: minted.purchaseUrl,
        },
      });
      if (claimed.count > 0) {
        checkoutConfigId = minted.checkoutConfigId;
        intentPurchaseUrl = minted.purchaseUrl;
      } else {
        const winner = await prisma.bookingIntent.findUnique({
          where: { id: intent.id },
          select: { whopCheckoutSessionId: true, whopCheckoutPurchaseUrl: true },
        });
        checkoutConfigId = winner?.whopCheckoutSessionId ?? minted.checkoutConfigId;
        intentPurchaseUrl = winner?.whopCheckoutPurchaseUrl ?? minted.purchaseUrl;
      }
    }
  }

  const h = headers();
  const host = h.get('host') ?? 'naturalhealthpros.com';
  // Trust the proxy's own scheme header first — Vercel sets it, and it is right for every
  // deployment. The local fallback tests for a PRIVATE host rather than the literal string
  // "localhost": `127.0.0.1:3000` and a LAN IP are both ordinary ways to run this (the latter is
  // what `next dev` binds when reached from a phone), and both would otherwise be handed an
  // https:// return url that refuses the connection mid-payment.
  const forwardedProto = h.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const hostname = host.split(':')[0];
  const isLocal =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]' ||
    hostname.endsWith('.local') ||
    /^(10|127)\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(hostname);
  const proto = forwardedProto === 'http' || forwardedProto === 'https'
    ? forwardedProto
    : isLocal
      ? 'http'
      : 'https';
  const intentUrl = `${proto}://${host}/practitioners/${encodeURIComponent(params.slug)}/book/${intent.publicToken}`;

  const advance = recordScheduleSignal.bind(null, params.slug, intent.publicToken);
  const firstName = intent.name.split(' ')[0];

  return (
    <main className="mx-auto max-w-2xl px-4 py-10 sm:py-14">
      <Card className="space-y-4 p-6 sm:p-8">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
            <Check className="h-4 w-4 text-primary" aria-hidden />
          </span>
          <div className="space-y-0.5">
            <h1 className="text-sm font-semibold">
              Thanks{firstName ? `, ${firstName}` : ''} — {intent.practitioner.displayName} has
              your details.
            </h1>
            <p className="text-xs text-muted-foreground">
              {offering?.title ?? intent.bookingLink?.label ?? 'Booking'}
            </p>
            {/* §22: same description shown pre-capture on /book — carried through so the buyer
                still sees it after submitting, not just before. */}
            {offering?.description && (
              <div className="space-y-1.5 pt-1 text-xs leading-relaxed text-muted-foreground">
                {offering.description
                  .split(/\n{2,}/)
                  .map((para) => para.trim())
                  .filter(Boolean)
                  .map((para, i) => (
                    <p key={i}>{para}</p>
                  ))}
              </div>
            )}
          </div>
        </div>

        {settled ? (
          <p className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
            This booking is already complete — nothing further to do. If you need to change it,
            contact {intent.practitioner.displayName} directly.
          </p>
        ) : needsSchedule ? (
          <SchedulerStep
            schedulerUrl={schedulerUrl!}
            practitionerName={intent.practitioner.displayName}
            onAdvance={advance}
            // NULL when an embed is possible. The hosted URL carries practitioner_id and
            // offering_id but NOT booking_intent_id, so a buyer who took it would pay through an
            // unattributable session and never be recorded. After advancing, the step refreshes
            // and the server renders the embedded checkout instead. The hosted link survives only
            // where no embed can be minted (§8).
            checkoutUrl={willEmbedAfterSchedule ? null : checkoutUrl}
            checkoutComing={willEmbedAfterSchedule}
          />
        ) : canEmbed && checkoutConfigId ? (
          // D11 — embedded, addressed by the SESSION, so the flow never leaves our page. Reached
          // two ways: §5's "subscription / no scheduling" row (1 → 3), and a returning buyer whose
          // intent is already SCHEDULED.
          //
          // Gated on `canEmbed`, NOT on the stored session alone. A session outlives the
          // conditions it was minted under: if the practitioner unticks "accepts payments", or a
          // payout_account.status_updated / identity_profile.rejected webhook clears
          // whopPayoutsEnabled, `live` goes false — and a session-only gate would keep serving a
          // working payment form into an account that may not be able to withdraw, which
          // publishOffering's own hard gate calls the worst possible failure.
          <CheckoutStep
            checkoutConfigId={checkoutConfigId}
            email={intent.email}
            returnUrl={intentUrl}
            // The PER-INTENT purchase url, which carries booking_intent_id — unlike the
            // offering-level one, which carries only practitioner_id and offering_id and would
            // reconcile to no booking. Falls back to the offering's only if this intent has none.
            fallbackUrl={intentPurchaseUrl ?? checkoutUrl}
          />
        ) : checkoutUrl ? (
          // §8 fallback — the session mint failed, so hand over the hosted checkout rather than
          // stranding a buyer who is ready to pay.
          <div className="space-y-2 rounded-md border bg-muted/20 p-3">
            <p className="text-xs text-muted-foreground">
              {alreadyScheduled ? 'Last step — payment.' : 'No scheduling needed — just payment.'}
            </p>
            <a
              href={checkoutUrl}
              className="inline-flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Continue to payment
            </a>
          </div>
        ) : alreadyScheduled ? (
          <p className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
            You&apos;re all set — {intent.practitioner.displayName} has your details and your time.
          </p>
        ) : (
          <p className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
            {intent.practitioner.displayName} will be in touch to arrange a time.
          </p>
        )}

        <Link
          href={`/practitioners/${intent.practitioner.slug}`}
          className="block text-center text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          Back to profile
        </Link>
      </Card>
    </main>
  );
}
