'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, ExternalLink, Loader2 } from 'lucide-react';
import {
  CAPTURE_LIMITS,
  CAPTURE_ERRORS,
  type CaptureErrorCode,
  type StartBookingResult,
} from '@/lib/booking-intent';
import { SchedulerPlaceholder } from './SchedulerPlaceholder';
import { SchedulerFrame } from './SchedulerFrame';

type Props = {
  slug: string;
  practitionerName: string;
  /** Resolved server-side. Null means there is no calendar step for this entry (§5 row 3). */
  schedulerUrl: string | null;
  bookingLinkId: string | null;
  offeringId: string | null;
  /** A `ReferralTouch.touchToken` carried in from the profile (§5.4.5 hop 4). */
  referralTouchToken?: string | null;
  subject: string | null;
  /** §22: the selected Offering's own description, when it has one. Never a fallback string —
      omitted entirely rather than restating the title or label. */
  subjectDescription: string | null;
  start: (formData: FormData) => Promise<StartBookingResult>;
  advance: (slug: string, token: string, signal: string) => Promise<{ ok: boolean }>;
};

type Phase = 'capture' | 'starting' | 'scheduling';

/**
 * THE SINGLE VIEW (§5, D12) — capture above a visible, not-yet-loaded scheduler.
 *
 * ⚠️ THE CONSTRAINTS IN THIS FILE ARE LOAD-BEARING, NOT STYLING. Amy rejected the capture-first
 * design on the 2026-08-26 call, and what she rejected was BLINDNESS — a form standing between
 * the visitor and a calendar they cannot see — not being asked for her details. This design
 * answers that by making the calendar frame visible from the first paint. Weaken any one of:
 *
 *   - two fields only (name + email),
 *   - a placeholder that fabricates no availability,
 *   - the frame's top edge anchored with growth unbounded,
 *   - advancing by REVEALING rather than navigating,
 *
 * and it collapses back into the design she rejected. This is shipped to DEMONSTRATE to her; she
 * has not seen it, and it is not a record of her agreement.
 *
 * WHY A CLIENT COMPONENT AT ALL: mounting in place is the whole point. A server-action redirect
 * would be a route change and a history entry, so the buyer's back button would mean "undo a
 * step" instead of "leave", and the frame would arrive as a new page rather than a reveal.
 */
export function BookingCaptureFlow({
  slug,
  practitionerName,
  schedulerUrl,
  bookingLinkId,
  offeringId,
  referralTouchToken,
  subject,
  subjectDescription,
  start,
  advance,
}: Props) {
  const [phase, setPhase] = useState<Phase>('capture');
  const [error, setError] = useState<string | null>(null);
  const [lead, setLead] = useState<{ name: string; email: string } | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [, startTransition] = useTransition();
  const frameRef = useRef<HTMLDivElement>(null);
  const scrolledRef = useRef(false);
  const router = useRouter();

  // SCROLL ONCE, ON MOUNT — never again (§7). There is no resize listener anywhere in this
  // subtree, so "never again" holds by construction rather than by a guard that could rot; the
  // ref is belt-and-braces against a re-render re-running this effect.
  useEffect(() => {
    if (phase !== 'scheduling' || scrolledRef.current) return;
    scrolledRef.current = true;
    frameRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [phase]);

  async function onSubmit(formData: FormData) {
    setError(null);
    setPhase('starting');

    const name = String(formData.get('name') ?? '').trim();
    const email = String(formData.get('email') ?? '').trim();

    let result: StartBookingResult;
    try {
      result = await start(formData);
    } catch (err) {
      console.error('[booking] capture failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      setPhase('capture');
      setError('Something went wrong saving your details. Please try again.');
      return;
    }

    if (!result.ok) {
      setPhase('capture');
      // Fall back to a NEUTRAL message. The previous fallback was EMAIL_INVALID, which told a
      // buyer their email was wrong for any code not in the map — pointing them at the wrong field.
      setError(
        CAPTURE_ERRORS[result.code as CaptureErrorCode] ??
          'Something went wrong saving your details. Please try again.',
      );
      return;
    }

    setToken(result.token);

    // No calendar step for this entry — hand off to the flow shell, which renders checkout or the
    // terminal state. `replace`, not `push`: still no history entry to "undo".
    if (!result.schedulerUrl) {
      router.replace(result.nextUrl);
      return;
    }

    setLead({ name, email });
    setPhase('scheduling');

    // Put the intent token in the URL WITHOUT navigating. Officially supported shallow routing in
    // the App Router — it patches the History API so usePathname/useSearchParams stay in step.
    //
    // This is what makes a mid-flow refresh IDEMPOTENT: reloading lands on the token route, which
    // resumes the same intent instead of creating a second lead for the same person. `replaceState`
    // rather than `pushState`, so no history entry is added and Back still means "leave".
    window.history.replaceState(null, '', result.nextUrl);
  }

  function onAdvance(signal: 'SELF_REPORT' | 'ASSUMED') {
    if (!token) return;
    // Reveal IMMEDIATELY, record in the background. D8 is explicit that our bookkeeping must never
    // gate the buyer, so a slow or failed write must not hold up their journey.
    setAdvanced(true);
    startTransition(() => {
      advance(slug, token, signal)
        .catch((err) => {
          console.error('[booking] schedule signal failed', {
            signal,
            error: err instanceof Error ? err.message : String(err),
          });
          return { ok: false };
        })
        .then(() => {
          // Hand off to the server-rendered flow shell, which decides between embedded checkout,
          // the hosted fallback and the terminal state. Navigating only NOW is deliberate: the
          // reveal above already happened, so the buyer never waits on this.
          router.replace(`/practitioners/${encodeURIComponent(slug)}/book/${token}`);
        });
    });
  }

  const busy = phase === 'starting';

  return (
    <div className="space-y-4">
      {/* ── CAPTURE ─────────────────────────────────────────────────────────────────────────── */}
      {phase !== 'scheduling' && (
        <div className="space-y-3 rounded-md border bg-card p-5 sm:p-6">
          <div className="space-y-1">
            <h1 className="text-base font-semibold">Book with {practitionerName}</h1>
            <p className="text-xs text-muted-foreground">
              {subject ? `${subject} — just your name and email to see live availability.` : 'Just your name and email to see live availability.'}
            </p>
            {/* §22: closes Amy Sprouse's direct ask — "possible to add offer descriptions to
                booking area? (first place they will see/read it)". Same treatment as
                OfferingCard's own description: split on blank lines, not a raw text block. */}
            {subjectDescription && (
              <div className="space-y-1.5 text-xs leading-relaxed text-muted-foreground">
                {subjectDescription
                  .split(/\n{2,}/)
                  .map((para) => para.trim())
                  .filter(Boolean)
                  .map((para, i) => (
                    <p key={i}>{para}</p>
                  ))}
              </div>
            )}
          </div>

          {error && (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
            >
              {error}
            </p>
          )}

          <form action={onSubmit} className="space-y-3">
            {/* Echoed back, then RE-RESOLVED server-side against this practitioner — never trusted
                from here. */}
            {bookingLinkId && <input type="hidden" name="bookingLinkId" value={bookingLinkId} />}
            {offeringId && <input type="hidden" name="offeringId" value={offeringId} />}
            {referralTouchToken && (
              <input type="hidden" name="referralTouchToken" value={referralTouchToken} />
            )}

            {/* TWO FIELDS. Not four. This is lead capture, NOT intake — the practitioner's own
                scheduler asks its intake questions on the very next screen and §6 forbids
                duplicating them. Every field added here is friction in front of the calendar,
                which is precisely the objection this design exists to answer. Prefill is scoped
                to name and email by ruling (D15), so a third field could not even be forwarded. */}
            <label className="block space-y-1">
              <span className="text-xs font-medium">Your name</span>
              <input
                type="text"
                name="name"
                required
                disabled={busy}
                maxLength={CAPTURE_LIMITS.name}
                autoComplete="name"
                className="h-10 w-full rounded-md border bg-card px-3 text-sm outline-none ring-ring/30 focus-visible:ring-2 disabled:opacity-60"
              />
            </label>

            <label className="block space-y-1">
              <span className="text-xs font-medium">Email</span>
              <input
                type="email"
                name="email"
                required
                disabled={busy}
                maxLength={CAPTURE_LIMITS.email}
                autoComplete="email"
                className="h-10 w-full rounded-md border bg-card px-3 text-sm outline-none ring-ring/30 focus-visible:ring-2 disabled:opacity-60"
              />
            </label>

            <button
              type="submit"
              disabled={busy}
              aria-busy={busy}
              className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-primary text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              {busy
                ? 'Opening the calendar…'
                : schedulerUrl
                  ? 'Check Availability & Schedule Now'
                  : 'Continue'}
            </button>
          </form>
        </div>
      )}

      {/* ── SCHEDULER ───────────────────────────────────────────────────────────────────────── */}
      {schedulerUrl && (
        <div ref={frameRef} className="scroll-mt-4 space-y-3">
          {phase === 'scheduling' && (
            <div className="flex items-start gap-2 rounded-md border bg-muted/20 px-3 py-2">
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
              <p className="text-xs text-muted-foreground">
                Thanks{lead?.name ? `, ${lead.name.split(' ')[0]}` : ''} — {practitionerName} has
                your details. Pick a time below.
              </p>
            </div>
          )}

          {phase === 'scheduling' ? (
            <SchedulerFrame
              schedulerUrl={schedulerUrl}
              practitionerName={practitionerName}
              lead={lead}
            />
          ) : (
            <SchedulerPlaceholder practitionerName={practitionerName} loading={busy} />
          )}

          {phase === 'scheduling' && (
            <>
              <p className="text-xs text-muted-foreground">
                Calendar not loading?{' '}
                <a
                  href={schedulerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium underline underline-offset-2 hover:text-foreground"
                >
                  Open it in a new tab
                </a>{' '}
                — some calendars block embedding, and we cannot detect that from here.
              </p>

              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                {/* T2 self-report — the SOLE completion path, uniform across every provider (D13).
                    Soft and buyer-controlled: it is honest that we cannot observe a booking inside
                    a cross-origin frame, rather than pretending to. */}
                <button
                  type="button"
                  disabled={advanced}
                  onClick={() => onAdvance('SELF_REPORT')}
                  className="inline-flex h-10 items-center justify-center gap-1.5 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
                >
                  {advanced ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
                  I&apos;ve booked my time
                  {!advanced && <Check className="h-3.5 w-3.5" aria-hidden />}
                </button>

                <div className="flex items-center gap-3">
                  <a
                    href={schedulerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
                  >
                    <ExternalLink className="h-3 w-3" aria-hidden />
                    Open in a new tab
                  </a>
                  {/* NEVER HARD-GATE (D8). Reachable with no self-report click at all; taking it
                      records ASSUMED rather than blocking. This is the primary safety property of
                      the step, not a convenience. */}
                  <button
                    type="button"
                    disabled={advanced}
                    onClick={() => onAdvance('ASSUMED')}
                    className="text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-60"
                  >
                    Continue
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
