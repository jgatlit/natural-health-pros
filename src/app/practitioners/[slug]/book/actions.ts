'use server';

import { headers, cookies } from 'next/headers';
import { ATTRIBUTION_COOKIE, verifyAttribution } from '@/lib/attribution';
import { REFERRAL_COOKIE, resolveReferralCarriage } from '@/lib/referral-cookie';
import { prisma } from '@/lib/prisma';
import { bookableWhere } from '@/lib/practitioner-indexer';
import { rateLimit } from '@/lib/rate-limit';
import {
  parseCapture,
  type CaptureErrorCode,
  type StartBookingResult,
} from '@/lib/booking-intent';
import { sendEmail } from '@/lib/email';
import { SITE_URL } from '@/lib/site';

/**
 * Step 1 (§5) — CAPTURE. Creates the BookingIntent the rest of the flow hangs off.
 *
 * PUBLIC AND UNAUTHENTICATED by design: the buyer is not a user and never will be, so
 * `withAuth(...)` does not apply and everything arriving here is untrusted.
 *
 * ⚠️ THERE IS NO EFFECTIVE RATE LIMIT IN PRODUCTION TODAY, and this comment does not pretend
 * otherwise. `src/lib/rate-limit.ts` no-ops when KV envs are absent, and no KV_REST_API_* is set
 * on production (verified 2026-08-14). The result IS checked below, so the throttle becomes real
 * the moment a store is provisioned — but until then a script varying the email address can
 * insert rows freely. An earlier version of this file claimed a dedupe window bounded that; it
 * did not, because varying the email defeats it entirely.
 *
 * 🚧 KV IS STILL UNPROVISIONED **AND THIS ROUTE IS NOW PUBLICLY LINKED** from every profile
 * (§17.4a). The obscurity that previously bounded the exposure is gone. The only bound in force
 * is the per-practitioner email suppression below, which protects a practitioner's inbox and
 * nothing else. See vault tsk_4ed1cffe7423469eba7c.
 */
export async function startBookingIntent(
  slug: string,
  formData: FormData,
): Promise<StartBookingResult> {
  const raw = {
    name: String(formData.get('name') ?? ''),
    email: String(formData.get('email') ?? ''),
    // Still parsed, still nullable, but NO LONGER COLLECTED: the single view is two fields by
    // ruling (§5). Reading them here keeps the resume/import paths and the older token route
    // working unchanged, and costs nothing when the form does not send them.
    phone: String(formData.get('phone') ?? ''),
    note: String(formData.get('note') ?? ''),
  };
  const linkId = String(formData.get('bookingLinkId') ?? '').trim();
  const offeringId = String(formData.get('offeringId') ?? '').trim();
  const referralTouchToken = String(formData.get('referralTouchToken') ?? '').trim();

  /**
   * Refuse with an ERROR CODE, never a message.
   *
   * The caller renders it through a fixed lookup, so a crafted value cannot put attacker-chosen
   * text inside a branded alert box on a public page carrying the practitioner's real name — a
   * phishing surface that used to be reachable by link alone, back when this bounced through
   * `?error=` on a redirect.
   *
   * Returning rather than redirecting is what preserves what the buyer typed: the form is never
   * re-rendered, so there is nothing to repopulate and nothing to lose.
   */
  const refuse = (code: CaptureErrorCode): StartBookingResult => ({ ok: false, code });

  const parsed = parseCapture(raw);
  if (!parsed.ok) return refuse(parsed.code);

  // Gated by `bookableWhere()`, NOT `listedWhere()`. Unlisted practitioners stay bookable at
  // their direct link — that is what trial-sweep's warning email promises them — so the only
  // refusal here is a RETIRED row, whose owner mailbox is typically dead and whose leads would
  // therefore be captured, acknowledged to the buyer, and read by nobody.
  // IDOR discipline: "no such practitioner" and "not bookable" are one response.
  const practitioner = await prisma.practitioner.findFirst({
    where: { slug, ...bookableWhere() },
    select: {
      id: true,
      displayName: true,
      notifyLeadsImmediately: true,
      primaryBookingLinkId: true,
      user: { select: { email: true } },
    },
  });
  // IDOR discipline: "no such practitioner" and "not bookable" produce one identical refusal,
  // the same one a stale offering id produces.
  if (!practitioner) return refuse('CONTEXT_GONE');

  // Both ids are user-supplied; resolve each scoped to THIS practitioner.
  const [bookingLink, offering] = await Promise.all([
    linkId
      ? prisma.bookingLink.findFirst({
          where: { id: linkId, practitionerId: practitioner.id },
          select: { id: true },
        })
      : null,
    offeringId
      ? prisma.whopProduct.findFirst({
          where: { id: offeringId, practitionerId: practitioner.id, archived: false },
          select: { id: true, title: true, bookingLinkId: true },
        })
      : null,
  ]);

  // A supplied id that does not resolve is a BROKEN LINK — matching the capture page, which 404s
  // on the same condition. Silently dropping it would downgrade a paid booking into a generic
  // enquiry without telling the buyer, and hand the practitioner a lead with no offering
  // attached and no indication anything was lost. (An offering can be archived while the buyer
  // has the form open, so this is reachable without any forgery at all.)
  if (linkId && !bookingLink) return refuse('CONTEXT_GONE');
  if (offeringId && !offering) return refuse('CONTEXT_GONE');

  const ip =
    headers().get('x-forwarded-for')?.split(',')[0]?.trim() ||
    headers().get('x-real-ip')?.trim() ||
    'unknown';
  const limited = await rateLimit('booking-capture', ip, { limit: 20, windowSeconds: 600 });
  // CHECK the result. An earlier version awaited this and discarded it, so the limiter could
  // never block — not now, and not after KV is provisioned either.
  if (!limited.success) return refuse('TOO_MANY');

  // A per-practitioner burst bound that suppresses the EMAIL, never the capture.
  //
  // An earlier version REJECTED the capture past this threshold, which was a denial-of-service on
  // the victim rather than a defence: this endpoint is unauthenticated and the bound is keyed on
  // the PRACTITIONER, so anyone could fire 15 requests at a slug and make that practitioner
  // unbookable for ten minutes, renewably, at no cost. It also destroyed the lead — the one
  // artefact §5 says capture exists to guarantee.
  //
  // Bounding the email instead keeps both properties: a practitioner's inbox cannot be flooded,
  // and a genuine buyer arriving during a burst still has their details recorded and still
  // reaches the scheduler. Throttling the SUBMITTER is the KV limiter's job; this one only ever
  // protects the inbox.
  const recentForPractitioner = await prisma.bookingIntent.count({
    where: {
      practitionerId: practitioner.id,
      createdAt: { gte: new Date(Date.now() - 10 * 60 * 1000) },
    },
  });
  const emailSuppressed = recentForPractitioner >= 15;
  if (emailSuppressed) {
    // Visible, because the practitioner is not being told about leads they can still see in the
    // dashboard, and a silent suppression is indistinguishable from a broken sender.
    console.warn('[booking-capture] lead email suppressed by burst bound', {
      practitionerId: practitioner.id,
      recentForPractitioner,
    });
  }

  // §14.3 — with no explicit context, fall back to the practitioner's designated hero link rather
  // than dead-ending the buyer on "they will be in touch" while a live calendar exists.
  const resolvedLinkId =
    bookingLink?.id ?? offering?.bookingLinkId ?? practitioner.primaryBookingLinkId ?? null;

  // entryPoint is a DIAGNOSTIC (§4) — it proxies buyer intent at entry, so it must reflect what
  // the buyer actually clicked. Recording BOOKING_LINK for a context-less capture would poison it.
  const entryPoint = offering ? 'OFFERING_CARD' : 'BOOKING_LINK';

  // Always a NEW intent. A previous version resumed an existing PENDING row matched on
  // (practitioner, email) — which, with nothing binding the submitter to that address, let anyone
  // who knew a buyer's email read that buyer's intent and overwrite their name, phone and note.
  // On a health-adjacent directory the note is the most sensitive field we hold. It also
  // collapsed two genuinely distinct enquiries into one whenever a buyer asked about a second
  // service. Duplicate leads are the lesser failure; the pending-state button covers double-click.
  // §16 — SNAPSHOT the first-touch attribution onto the row, at creation.
  //
  // The cookie is written at LANDING by middleware, not here, and this action never resolves
  // attribution itself (D14). That decoupling is deliberate: it is what lets attribution cover
  // visitors who never reach this form, and what stops a future reordering of the flow from
  // silently changing who gets paid.
  //
  // Snapshotting is what makes the record durable. The cookie expires at the end of the window;
  // without this copy a completed booking's attribution would change or vanish when it did, and
  // commission is calculated from it. Null is an honest outcome (no cookie, tampered, expired) —
  // never a reason to refuse a lead.
  const attribution = process.env.AUTH_SECRET
    ? await verifyAttribution(
        cookies().get(ATTRIBUTION_COOKIE)?.value,
        process.env.AUTH_SECRET,
        Date.now(),
      )
    : null;

  // §5.4.5 — THE REFERRAL'S DURABLE CARRIER. After this row exists, the URL param, the cookie and
  // the Whop metadata are all redundant: this column is what decides who is paid.
  //
  // Both inputs are untrusted — the param is attacker-supplied and the cookie is client-supplied —
  // so the touch is looked up scoped to THIS practitioner and to a referral that has not expired.
  // A token minted for somebody else resolves to nothing rather than attaching here.
  //
  // `carriage` records URL / COOKIE / NONE. §9 test 13 requires the fallback's outcome to be
  // logged whichever way it goes: an unrecorded NONE cannot be told apart from "nobody referred
  // them", which is the difference between a broken carriage and an ordinary booking.
  const referral = await resolveReferralCarriage(prisma, {
    practitionerId: practitioner.id,
    paramToken: referralTouchToken || null,
    cookieValue: cookies().get(REFERRAL_COOKIE)?.value,
    secret: process.env.AUTH_SECRET,
    at: new Date(),
  });

  const intent = await prisma.bookingIntent.create({
    data: {
      practitionerId: practitioner.id,
      ...parsed.value,
      entryPoint,
      bookingLinkId: resolvedLinkId,
      offeringId: offering?.id ?? null,
      referralTouchId: referral.referralTouchId,
      referralCarriage: referral.carriage,
      attributionParty: attribution?.party ?? null,
      attributionSource: attribution?.source ?? null,
      attribution: attribution
        ? {
            referrerHost: attribution.referrerHost,
            campaign: attribution.campaign,
            landingPath: attribution.landingPath,
            ts: attribution.ts,
          }
        : undefined,
    },
    // publicToken is generated by Postgres (see the column's docstring), so it has to be read
    // BACK rather than supplied — it is what the redirect below addresses the flow by.
    select: { id: true, publicToken: true },
  });

  // §5 — "this step is ours; the only point where lead capture is GUARANTEED." The whole reason
  // step 1 precedes the scheduler is that the practitioner keeps the lead even when the buyer
  // abandons at step 2. Creating the row without telling anyone would leave that promise unkept.
  //
  // Out of band and never fatal: a failed send must not lose a lead that is already committed,
  // and the buyer must not see an error for something that is not their problem.
  if (practitioner.notifyLeadsImmediately && practitioner.user.email && !emailSuppressed) {
    await sendLeadEmail({
      to: practitioner.user.email,
      practitionerName: practitioner.displayName,
      slug,
      intentId: intent.id,
      lead: parsed.value,
      offeringTitle: offering?.title ?? null,
    }).catch((err) => {
      console.error('[booking-capture] lead email failed', {
        intentId: intent.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // Resolve the calendar URL the caller will MOUNT IN PLACE. Selected as `{ url }` only —
  // deliberately WITHOUT `provider` (D16). The adapter derives the provider from the URL at use,
  // because the column is a reporting cache with a known-stale row: one live bookable link holds
  // a `calendly.com` URL under `provider = OTHER`, and reading it here would silently drop that
  // practitioner's buyers to the null adapter and lose their prefill.
  const scheduler = resolvedLinkId
    ? await prisma.bookingLink.findUnique({
        where: { id: resolvedLinkId },
        select: { url: true },
      })
    : null;

  // The token in the URL is what makes returning IDEMPOTENT — the T3 new-tab fallback and §10's
  // resume link both depend on it (§5, §8 failure table). A random token rather than the row's id,
  // because this URL is an unauthenticated bearer credential that §10 puts into inboxes.
  //
  // RETURNED, not redirected. The caller writes it into the address bar with `replaceState` and
  // reveals the scheduler in place — no route change and no history entry, so the buyer's Back
  // button still means "leave" rather than "undo a step" (§5, §8).
  return {
    ok: true,
    token: intent.publicToken,
    schedulerUrl: scheduler?.url ?? null,
    nextUrl: `/practitioners/${encodeURIComponent(slug)}/book/${intent.publicToken}`,
  };
}

async function sendLeadEmail(params: {
  to: string;
  practitionerName: string;
  slug: string;
  intentId: string;
  lead: { name: string; email: string; phone: string | null; note: string | null };
  offeringTitle: string | null;
}): Promise<void> {
  const { lead } = params;
  const subject = params.offeringTitle
    ? `New enquiry — ${lead.name} · ${params.offeringTitle}`
    : `New enquiry — ${lead.name}`;

  const lines = [
    `${lead.name} just started booking with you on Natural Health Pros.`,
    '',
    `Email: ${lead.email}`,
    ...(lead.phone ? [`Phone: ${lead.phone}`] : []),
    ...(params.offeringTitle ? [`Interested in: ${params.offeringTitle}`] : []),
    ...(lead.note ? ['', 'They said:', lead.note] : []),
    '',
    // States what is true AT SEND TIME and nothing more. The previous wording — "they may still
    // be choosing a time" — was an assertion about a live state this email could never update:
    // on the first real booking the flow took it went stale 22 seconds later, and nothing told
    // the practitioner. The follow-up it promises is now real (see notifyScheduled).
    'They have not picked a time yet. We will email you again if they do, and their details stay',
    'in your dashboard either way.',
    `${SITE_URL}/practitioners/${params.slug}/edit`,
  ];

  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  await sendEmail({
    to: params.to,
    subject,
    text: lines.join('\n'),
    html: `<p>${esc(lead.name)} just started booking with you on Natural Health Pros.</p>
<p><strong>Email:</strong> ${esc(lead.email)}${lead.phone ? `<br><strong>Phone:</strong> ${esc(lead.phone)}` : ''}${
      params.offeringTitle ? `<br><strong>Interested in:</strong> ${esc(params.offeringTitle)}` : ''
    }</p>
${lead.note ? `<p><strong>They said:</strong><br>${esc(lead.note).replace(/\n/g, '<br>')}</p>` : ''}
<p>They have not picked a time yet. We&rsquo;ll email you again if they do, and their details stay in your dashboard either way.</p>
<p><a href="${SITE_URL}/practitioners/${encodeURIComponent(params.slug)}/edit">View your dashboard</a></p>`,
    // Keyed on the intent so a retry or replay cannot double-send the same lead.
    idempotencyKey: `booking-lead/${params.intentId}`,
    tags: [{ name: 'type', value: 'booking-lead' }],
  });
}
