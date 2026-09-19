import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { bookableWhere } from '@/lib/practitioner-indexer';
import { sendEmail } from '@/lib/email';
import { SITE_URL } from '@/lib/site';
import { paymentsLive } from '@/lib/booking-flow';
import { formatBpsAsPercent } from '@/lib/pricing-plans';
import { crossReferralRates } from '@/lib/referral-fees';
import { loadSettings } from '@/lib/platform-settings';
import {
  referralBookedCopy,
  referralHoldCopy,
  referralsNeedingBookedNotice,
  referralsNeedingClaimNotice,
} from '@/lib/referral-notifications';
import {
  COLD_LEAD_MS,
  RESUME_AFTER_CAPTURE_MS,
  paidConfirmationCopy,
  paidNoticeCopy,
  resumeCopy,
  resumeDecision,
  scheduledNoticeCopy,
} from '@/lib/booking-recovery';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * §10 abandonment sweep. Wired as a Vercel Cron in vercel.json, every 15 minutes.
 *
 * Three jobs:
 *
 *   1. RESUME  — a buyer who reached a checkout and did not pay gets one email with a resume link.
 *   2. NOTIFY  — the practitioner is told someone picked a time.
 *   3. PAID    — BOTH sides are told the payment landed.
 *   4. COLD    — a PENDING intent that never reached a checkout is relabelled ABANDONED. NO buyer
 *                email: there is nothing to resume, so mailing them would be marketing.
 *
 * Like trial-sweep, this exists because the thing it reacts to IS NOT AN EVENT. Nobody abandons a
 * checkout; they simply stop, and no request ever arrives to notice it. Without a sweep the
 * scheduled-but-unpaid state is recorded perfectly and acted on never — which is exactly what the
 * first real booking through this flow did.
 *
 * WHY THE PRACTITIONER NOTICE LIVES HERE and not in the server action that performs the
 * transition: sending it inline put a Resend round-trip on the buyer's critical path at the
 * highest-drop-off moment in the flow, which contradicts D8 and the explicit warning in
 * src/lib/email.ts. It also had no burst bound, so it bypassed the one the capture path built —
 * a script could drive unbounded practitioner emails by capturing and then advancing each intent.
 * Moving it here costs at most 15 minutes of latency and removes both problems: the cron's own
 * schedule is the rate limit, and `scheduledNoticeSentAt` makes it exactly-once.
 *
 * EXACTLY-ONCE is the send markers' job, not Resend's. `idempotencyKey` de-duplicates for 24
 * HOURS only, and nothing else ever removes an unpaid intent from the candidate set — so keys
 * alone meant "one email per day forever" for any buyer who simply decided not to buy.
 */

/** Cheap pre-filter only. The real decision is `resumeDecision()`, which owns the §10 rules. */
const CANDIDATE_TAKE = 200;

type Summary = { matched: number; sent: number; skipped: number; failed: number };

export async function GET(request: Request): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  // FAIL CLOSED in production. The "open when unset" shape was inherited from
  // /api/health/search, which is READ-ONLY — this route is not. An unauthenticated GET here
  // relabels rows in bulk and sends buyer-facing email from the verified domain, so a missing or
  // mistyped CRON_SECRET on any deployed environment must not silently expose that.
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[booking-sweep] CRON_SECRET is not set; refusing to run in production');
      return NextResponse.json({ error: 'CRON_SECRET is not configured' }, { status: 503 });
    }
  } else if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const now = new Date();
  const emailConfigured = !!process.env.RESEND_API_KEY;
  const resume: Summary = { matched: 0, sent: 0, skipped: 0, failed: 0 };
  const notify: Summary = { matched: 0, sent: 0, skipped: 0, failed: 0 };
  const paid: Summary = { matched: 0, sent: 0, skipped: 0, failed: 0 };
  const skipReasons: Record<string, number> = {};
  const failures: { job: string; intentId: string; error: string }[] = [];

  if (!emailConfigured) {
    // Loud, but NOT fatal to the whole run. The cold relabel below sends nothing at all, and
    // freezing a state transition because an email key is missing would stall the lead queue
    // indefinitely over a problem it does not depend on.
    console.error('[booking-sweep] RESEND_API_KEY is not set; email jobs skipped this run');
  }

  if (emailConfigured) {
    // Narrow on what an index can serve and leave every §10 rule to resumeDecision(). Restating
    // payments_live as a Prisma `where` would create a second definition of the one condition
    // that decides whether a checkout step exists at all.
    //
    // Both routes into state (b) are selected: SCHEDULED (the common path) and PENDING with a
    // minted checkout session (§5's 1 → 3 subscription cohort, whose status never advances
    // because they never pass a scheduler).
    //
    // NO listing gate. It used to be applied here on the reasoning that "a delisted
    // practitioner's flow page 404s, so a resume link would mail the buyer a dead end" — true at
    // the time, and a symptom of the gate on the flow rather than a reason for one here. Unlisted
    // profiles stay bookable at their direct link, so the resume link resolves and the buyer is
    // recoverable exactly as any other.
    const candidates = await prisma.bookingIntent.findMany({
      where: {
        paidAt: null,
        resumeEmailSentAt: null,
        createdAt: { lte: new Date(now.getTime() - RESUME_AFTER_CAPTURE_MS) },
        practitioner: bookableWhere(),
        OR: [{ status: 'SCHEDULED' }, { status: 'PENDING', whopCheckoutSessionId: { not: null } }],
      },
      select: {
        id: true,
        publicToken: true,
        name: true,
        email: true,
        status: true,
        paidAt: true,
        createdAt: true,
        scheduledAt: true,
        resumeEmailSentAt: true,
        whopCheckoutSessionId: true,
        practitioner: { select: { slug: true, displayName: true, whopPayoutsEnabled: true } },
        offering: {
          select: {
            title: true,
            archived: true,
            acceptsPayments: true,
            whopPlanId: true,
            priceUsdCents: true,
            isConsult: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
      take: CANDIDATE_TAKE,
    });

    resume.matched = candidates.length;
    // A silent cap reads as "covered everything" when it did not. Every row taken here leaves the
    // candidate set — sent ones and permanently-refused ones alike both stamp `resumeEmailSentAt`
    // — so the remainder IS reached on later runs. That is only true because refusals are
    // recorded too: recording sends alone would still let permanently-unsendable rows pile up at
    // the head of the ordering and starve everything behind them.
    if (candidates.length === CANDIDATE_TAKE) {
      console.warn(
        `[booking-sweep] candidate cap hit (${CANDIDATE_TAKE}); the remainder is picked up by subsequent runs as these are marked sent`,
      );
    }

    for (const intent of candidates) {
      const decision = resumeDecision(
        {
          status: intent.status,
          paidAt: intent.paidAt,
          createdAt: intent.createdAt,
          scheduledAt: intent.scheduledAt,
          resumeEmailSentAt: intent.resumeEmailSentAt,
          reachedCheckout: intent.whopCheckoutSessionId !== null,
          offering: intent.offering,
          practitionerPayoutsEnabled: intent.practitioner.whopPayoutsEnabled,
        },
        now,
      );

      if (!decision.send) {
        resume.skipped += 1;
        skipReasons[decision.reason] = (skipReasons[decision.reason] ?? 0) + 1;
        // A PERMANENT refusal is recorded so the row stops matching. Skipping without recording
        // left it in the candidate set forever, and with `orderBy createdAt asc` + a take cap,
        // enough of those at the head of the ordering starve every mailable newer intent — the
        // cap silently stops being a batch size and becomes a ceiling. The column means "no
        // resume email is owed", which covers both sent and never-sendable.
        if (decision.permanent) {
          await prisma.bookingIntent
            .update({ where: { id: intent.id }, data: { resumeEmailSentAt: new Date() } })
            .catch((err) => {
              console.error('[booking-sweep] could not record permanent skip', {
                intentId: intent.id,
                reason: decision.reason,
                error: err instanceof Error ? err.message : String(err),
              });
            });
        }
        continue;
      }

      // SITE_URL, not a request host: a cron has no buyer request to derive an origin from, and
      // this URL is going into an inbox where it must point at production.
      const resumeUrl = `${SITE_URL}/practitioners/${encodeURIComponent(
        intent.practitioner.slug,
      )}/book/${intent.publicToken}`;

      const { subject, text, html } = resumeCopy({
        firstName: intent.name.split(' ')[0] ?? '',
        practitionerName: intent.practitioner.displayName,
        // resumeDecision() refuses every intent with no offering, so this fallback is unreachable
        // — it exists so the type narrows without an assertion.
        offeringTitle: intent.offering?.title ?? 'your booking',
        resumeUrl,
      });

      try {
        await sendEmail({
          to: intent.email,
          subject,
          text,
          html,
          idempotencyKey: `booking-resume/${intent.id}`,
          tags: [{ name: 'feature', value: 'booking-sweep' }],
        });
        // Marked only AFTER a confirmed send. sendEmail throws rather than reporting a non-send
        // as success, so a failure leaves the marker null and the intent is retried next run —
        // which is the correct direction to fail for a recovery email.
        await prisma.bookingIntent.update({
          where: { id: intent.id },
          data: { resumeEmailSentAt: new Date() },
        });
        resume.sent += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        resume.failed += 1;
        failures.push({ job: 'resume', intentId: intent.id, error: message });
        console.error('[booking-sweep] RESUME SEND FAILED', JSON.stringify({ intentId: intent.id, error: message }));
      }
    }

    // ── Practitioner notices ──────────────────────────────────────────────────────────────────
    //
    // NOT gated on `notifyLeadsImmediately`. §11's toggle chooses between "tell me about leads
    // immediately" and "tell me on checkout instead" — but the checkout-time notification it
    // promises DOES NOT EXIST anywhere in this codebase, so honouring the gate here would mean a
    // practitioner who turned lead emails off is never told that a stranger is on their calendar,
    // with no substitute at all. A booked slot is also not a lead: §10 treats it as a service
    // obligation with a client waiting, which is exactly why the dashboard row is ungated too.
    const scheduled = await prisma.bookingIntent.findMany({
      where: {
        status: 'SCHEDULED',
        scheduledNoticeSentAt: null,
        practitioner: bookableWhere(),
      },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        scheduleSignal: true,
        practitioner: {
          select: { slug: true, whopPayoutsEnabled: true, user: { select: { email: true } } },
        },
        offering: {
          select: { title: true, archived: true, priceUsdCents: true, acceptsPayments: true, whopPlanId: true },
        },
      },
      orderBy: { scheduledAt: 'asc' },
      take: CANDIDATE_TAKE,
    });

    notify.matched = scheduled.length;
    for (const intent of scheduled) {
      const to = intent.practitioner.user.email;
      if (!to) {
        notify.skipped += 1;
        continue;
      }
      // An offering archived after capture owes nothing: the flow page stops rendering its
      // checkout entirely, so telling the practitioner to chase a payment would send them after
      // money the buyer has no way to give them.
      const live =
        intent.offering && !intent.offering.archived
          ? paymentsLive({
              acceptsPayments: intent.offering.acceptsPayments,
              practitionerPayoutsEnabled: intent.practitioner.whopPayoutsEnabled,
              whopPlanId: intent.offering.whopPlanId,
            })
          : false;

      const { subject, text, html } = scheduledNoticeCopy({
        buyerName: intent.name,
        buyerEmail: intent.email,
        buyerPhone: intent.phone,
        offeringTitle: intent.offering?.title ?? null,
        signal: intent.scheduleSignal ?? 'ASSUMED',
        profileUrl: `${SITE_URL}/practitioners/${encodeURIComponent(intent.practitioner.slug)}/edit`,
        awaitingPayment: live && (intent.offering?.priceUsdCents ?? 0) > 0,
      });

      try {
        await sendEmail({
          to,
          subject,
          text,
          html,
          idempotencyKey: `booking-scheduled/${intent.id}`,
          tags: [{ name: 'feature', value: 'booking-scheduled' }],
        });
        await prisma.bookingIntent.update({
          where: { id: intent.id },
          data: { scheduledNoticeSentAt: new Date() },
        });
        notify.sent += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        notify.failed += 1;
        failures.push({ job: 'notify', intentId: intent.id, error: message });
        console.error('[booking-sweep] NOTICE SEND FAILED', JSON.stringify({ intentId: intent.id, error: message }));
      }
    }
    // ── Payment confirmations, to BOTH sides ─────────────────────────────────────────────────
    //
    // Sent from HERE and not from the `payment.succeeded` webhook on purpose: Whop retries a
    // webhook 3x over ~70s and then drops it permanently, so that handler must acknowledge fast
    // and never block on an email. src/lib/email.ts says exactly this.
    //
    // Ungated by notification preferences, like the scheduled notice: money changing hands is not
    // a marketing notification, and until now NOTHING was sent on payment to anyone.
    const paidRows = await prisma.bookingIntent.findMany({
      where: { paidAt: { not: null }, paidNoticeSentAt: null },
      select: {
        id: true,
        publicToken: true,
        name: true,
        email: true,
        phone: true,
        status: true,
        scheduledAt: true,
        practitioner: {
          select: { slug: true, displayName: true, user: { select: { email: true } } },
        },
        offering: { select: { title: true, priceUsdCents: true } },
      },
      orderBy: { paidAt: 'asc' },
      take: CANDIDATE_TAKE,
    });

    paid.matched = paidRows.length;
    for (const intent of paidRows) {
      const bookingUrl = `${SITE_URL}/practitioners/${encodeURIComponent(
        intent.practitioner.slug,
      )}/book/${intent.publicToken}`;
      const amount = intent.offering?.priceUsdCents ?? null;

      try {
        // The buyer first: they are the one who just spent money and is waiting to hear.
        await sendEmail({
          to: intent.email,
          ...paidConfirmationCopy({
            firstName: intent.name.split(' ')[0] ?? '',
            practitionerName: intent.practitioner.displayName,
            offeringTitle: intent.offering?.title ?? null,
            amountUsdCents: amount,
            bookingUrl,
            // A buyer CAN pay without picking a time (D8 never hard-gates), so the copy must not
            // tell that person they are all set.
            scheduled: intent.scheduledAt !== null,
          }),
          idempotencyKey: `booking-paid-buyer/${intent.id}`,
          tags: [{ name: 'feature', value: 'booking-paid' }],
        });

        const to = intent.practitioner.user.email;
        if (to) {
          await sendEmail({
            to,
            ...paidNoticeCopy({
              buyerName: intent.name,
              buyerEmail: intent.email,
              buyerPhone: intent.phone,
              offeringTitle: intent.offering?.title ?? null,
              amountUsdCents: amount,
              dashboardUrl: `${SITE_URL}/practitioners/${encodeURIComponent(
                intent.practitioner.slug,
              )}/edit`,
            }),
            idempotencyKey: `booking-paid-practitioner/${intent.id}`,
            tags: [{ name: 'feature', value: 'booking-paid' }],
          });
        }

        // Marked only after BOTH sends. A partial failure retries both next run; Resend's key
        // makes the already-delivered one a no-op, so the buyer cannot be double-mailed.
        await prisma.bookingIntent.update({
          where: { id: intent.id },
          data: { paidNoticeSentAt: new Date() },
        });
        paid.sent += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        paid.failed += 1;
        failures.push({ job: 'paid', intentId: intent.id, error: message });
        console.error('[booking-sweep] PAID NOTICE FAILED', JSON.stringify({ intentId: intent.id, error: message }));
      }
    }
  }

  // ── State (a): captured, never reached a checkout, now cold ────────────────────────────────
  //
  // Runs whether or not email is configured — it sends nothing.
  //
  // `whopCheckoutSessionId: null` is load-bearing, not incidental: a PENDING intent WITH a
  // session is §5's 1 → 3 cohort, who did reach a real checkout and are handled by the resume job
  // above. Sweeping them in here would file a recoverable buyer under "abandoned" while the
  // comment claimed they never reached a checkout.
  //
  // SCHEDULED intents are excluded however old they get: §10 calls that state "a follow-up, not a
  // loss", and relabelling it would bury the one thing this section exists to rescue. See
  // COLD_LEAD_MS for why this transition is a judgment call at all.
  // ── Referral notices (spec v1.4 §5.5 / R10, operator ruling 7 / R15) ───────────────────────
  //
  // HERE, not in the Whop webhook. Whop retries 3× over ~70 s and then drops the event
  // permanently, so a Resend round-trip inside that handler risks the payment record itself — the
  // same reason the paid notices above moved out of it.
  //
  // ⚠️ RULING 7 SAYS "IMMEDIATELY", AND THIS IS EVERY 15 MINUTES. That is the honest trade: the
  // alternative is sending inside the webhook and risking the event. Named rather than papered
  // over, so nobody later reads "immediately" in the ruling and assumes it is wired that way.
  //
  // ⚠️ NEITHER NOTICE IS GATED BY `notifyLeadsImmediately`. That flag suppresses LEAD emails.
  // Being told a referral converted, or that money is waiting on your account setup, is not a
  // marketing preference.
  const referrals: Summary = { matched: 0, sent: 0, skipped: 0, failed: 0 };
  if (emailConfigured) {
    const { referrerFeeBps } = crossReferralRates();
    const rateLabel = formatBpsAsPercent(referrerFeeBps);
    const { leadAttributionTermMonths } = await loadSettings(prisma);

    // 1 — "your referral booked". Keyed on the TOUCH, because one copied link reaches several
    // clients and each of them is a separate conversion the referrer should hear about.
    const bookedCandidates = await prisma.referralTouch.findMany({
      where: { bookedNoticeSentAt: null, status: 'BOOKED' },
      select: {
        id: true,
        referral: {
          select: {
            referrer: { select: { user: { select: { email: true } } } },
            referred: { select: { displayName: true } },
          },
        },
      },
      take: CANDIDATE_TAKE,
    });

    // The durable marker is the real guard; `paidAt` here is derived from the BOOKED status the
    // payment handler sets, so the pure selector is given what it needs to say so explicitly.
    const booked = referralsNeedingBookedNotice(
      bookedCandidates.map((t) => ({ ...t, bookedNoticeSentAt: null as Date | null, paidAt: now })),
    );
    referrals.matched += booked.length;

    for (const touch of booked) {
      const to = touch.referral?.referrer?.user.email;
      const referredName = touch.referral?.referred?.displayName;
      if (!to || !referredName) {
        referrals.skipped += 1;
        continue;
      }
      try {
        await sendEmail({
          to,
          ...referralBookedCopy({ referredName, rateLabel, termMonths: leadAttributionTermMonths }),
          idempotencyKey: `referral-booked/${touch.id}`,
          tags: [{ name: 'feature', value: 'referral-booked' }],
        });
        await prisma.referralTouch.update({
          where: { id: touch.id },
          data: { bookedNoticeSentAt: new Date() },
        });
        referrals.sent += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        referrals.failed += 1;
        failures.push({ job: 'referral-booked', intentId: touch.id, error: message });
        console.error('[booking-sweep] REFERRAL NOTICE FAILED', JSON.stringify({ touchId: touch.id, error: message }));
      }
    }

    // 2 — R15: the share could not be paid. Tell them to claim their Whop account.
    //
    // `EXPIRED_UNCLAIMED` rows are deliberately NOT selected (see referralsNeedingClaimNotice):
    // day-91 policy is unruled, and mailing someone about money whose fate nobody has decided
    // makes a promise the product cannot keep.
    const heldRows = await prisma.referralLedgerEntry.findMany({
      where: { state: 'HELD', notifiedAt: null },
      select: {
        id: true,
        state: true,
        notifiedAt: true,
        referrerShareUsdCents: true,
        holdExpiresAt: true,
        referrerPractitioner: {
          select: { slug: true, user: { select: { email: true } } },
        },
        servingPractitioner: { select: { displayName: true } },
      },
      take: CANDIDATE_TAKE,
    });

    const held = referralsNeedingClaimNotice(heldRows);
    referrals.matched += held.length;

    for (const row of held) {
      const to = row.referrerPractitioner?.user.email;
      if (!to || !row.holdExpiresAt) {
        referrals.skipped += 1;
        continue;
      }
      try {
        await sendEmail({
          to,
          ...referralHoldCopy({
            referredName: row.servingPractitioner?.displayName ?? 'a practitioner',
            amountUsdCents: row.referrerShareUsdCents,
            holdExpiresAt: row.holdExpiresAt,
            onboardingUrl: `${SITE_URL}/practitioners/${encodeURIComponent(
              row.referrerPractitioner!.slug,
            )}/edit#payments`,
          }),
          idempotencyKey: `referral-hold/${row.id}`,
          tags: [{ name: 'feature', value: 'referral-hold' }],
        });
        // The DURABLE marker. Ruling 7 put `notifiedAt` on the row at stage 1 precisely so this
        // send has somewhere idempotent to land — Resend's own key de-duplicates for 24 hours
        // only, and a held row stays a candidate for 90 days.
        await prisma.referralLedgerEntry.update({
          where: { id: row.id },
          data: { notifiedAt: new Date() },
        });
        referrals.sent += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        referrals.failed += 1;
        failures.push({ job: 'referral-hold', intentId: row.id, error: message });
        console.error('[booking-sweep] REFERRAL HOLD NOTICE FAILED', JSON.stringify({ entryId: row.id, error: message }));
      }
    }
  }

  const cold = await prisma.bookingIntent.updateMany({
    where: {
      status: 'PENDING',
      paidAt: null,
      whopCheckoutSessionId: null,
      createdAt: { lte: new Date(now.getTime() - COLD_LEAD_MS) },
    },
    data: { status: 'ABANDONED' },
  });

  const ok = failures.length === 0 && emailConfigured;
  return NextResponse.json(
    { ok, emailConfigured, resume, notify, paid, referrals, skipReasons, abandoned: cold.count, failures },
    { status: failures.length === 0 ? 200 : 207 },
  );
}
