import { CheckCircle2, FileText } from 'lucide-react';

/**
 * Terms & Conditions click-to-acknowledge (queue item 6, 2026-08-25 engineering queue).
 *
 * This is the REAL draft copy (art_4c702b7a1d2848ddbf33), rendered in full and in context — not a
 * standalone document Sarah/Amy would have to review blind, and not lorem-ipsum. It is still NOT
 * final: the bracketed `[...]` gaps below (chargeback liability, content-license scope, liability
 * cap, governing law) are real open decisions that need Amy + counsel, not a placeholder default.
 * Do not resolve them here — resolving them silently would misrepresent what a practitioner is
 * actually agreeing to. See _handoff-context/tc-draft.md for the full sourcing rationale.
 *
 * Rendered once, not re-required: a practitioner who already has `termsAcceptedAt` sees a plain
 * confirmation line instead of the checkbox, so revisiting /onboarding before finishing their
 * profile does not force re-reading the whole document to save progress.
 */
export function TermsAcknowledgment({ acceptedAt }: { acceptedAt: Date | null }) {
  if (acceptedAt) {
    return (
      <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
        You accepted our Terms &amp; Conditions on{' '}
        {/* This renders server-side with no client re-render to correct it, so an implicit
            server-local (Vercel = UTC) timezone would silently show the wrong calendar day to
            anyone who accepted near a day boundary in their own timezone. Pinned explicitly,
            matching SubscriptionSection's trialEndsAtLabel — same reasoning, same fix. */}
        {acceptedAt.toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
          timeZone: 'UTC',
        })}.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <FileText className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        Terms &amp; Conditions
      </div>

      <div className="max-h-64 overflow-y-auto rounded-md border bg-card p-4 text-xs leading-relaxed text-muted-foreground">
        <TermsBody />
      </div>

      <label className="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          name="termsAccepted"
          required
          className="mt-0.5 h-4 w-4 shrink-0 rounded border"
        />
        <span>
          I have read and agree to the Terms &amp; Conditions above.{' '}
          <span className="text-muted-foreground">
            (Two sections above are still marked as open decisions — that&apos;s expected; this
            draft isn&apos;t final yet.)
          </span>
        </span>
      </label>
    </div>
  );
}

/**
 * Verbatim from the approved draft — do not paraphrase or summarize. Section numbers and
 * bracketed gaps are part of the source document; keep them exactly as written there.
 */
function TermsBody() {
  return (
    <div className="space-y-3">
      <Section n={1} title="Acceptance">
        By creating a practitioner profile on Natural Health Pros, you agree to these Terms. If you
        do not agree, do not create a profile or continue using the platform.
      </Section>

      <Section n={2} title="What Natural Health Pros is — and isn't">
        Natural Health Pros is a <strong>directory and listing platform</strong> for graduates of
        Holistic Health Educators (HHE) programs and other wellness practitioners. We help clients
        discover practitioners and help practitioners present their services;{' '}
        <strong>
          we are not a healthcare provider, we do not practice medicine, and nothing on this
          platform is a substitute for professional medical advice, diagnosis, or treatment.
        </strong>{' '}
        Always consult a qualified healthcare provider with questions about a medical condition.
      </Section>

      <Section n={3} title="Practitioners are independent">
        Every practitioner listed is an <strong>independent professional</strong>, not an employee,
        agent, or contractor of Natural Health Pros. You are solely responsible for the services you
        offer, their description, pricing, delivery, scheduling, and any refund or cancellation
        decisions related to them. Natural Health Pros does not supervise, endorse, or guarantee the
        outcome of any service booked through the platform.
      </Section>

      <Section n={4} title="Payments">
        Payments for paid services are processed through <strong>Whop</strong>, our third-party
        payment processor. Whop acts as merchant of record for payment settlement only;
        practitioners are the supplier of record for all other purposes, including applicable taxes
        and consumer-protection obligations. Natural Health Pros facilitates the connection between
        practitioner and client — refund and dispute decisions for a specific service are the
        practitioner&apos;s, per Whop&apos;s Seller Terms and Buyer Terms.{' '}
        <span className="italic">
          [Confirm: does Natural Health Pros absorb any chargeback fees, or do they pass through to
          the practitioner? Whop&apos;s own terms put chargeback liability on the seller by
          default.]
        </span>
      </Section>

      <Section n={5} title="Your profile and content">
        You retain ownership of the content you submit (bio, photos, offering descriptions). By
        submitting it, you grant Natural Health Pros a non-exclusive license to display, store, and
        moderate it on the platform and in platform promotion, for as long as your profile is
        active.{' '}
        <span className="italic">
          [Confirm scope with Amy — this is the standard marketplace license-back clause, needed so
          displaying a practitioner&apos;s own profile to a visiting client isn&apos;t a copyright
          question.]
        </span>
      </Section>

      <Section n={6} title="Confidentiality and platform expectations">
        Practitioners agree not to use information, materials, or relationships gained through
        Natural Health Pros in a manner that misrepresents the platform, HHE, or other
        practitioners, and to represent their qualifications accurately.
      </Section>

      <Section n={7} title="Fees and subscription">
        Directory listing is billed at <strong>$39/month</strong> following a{' '}
        <strong>90-day trial</strong>, during which no payment is required. Subscriptions may be
        canceled at any time; your profile is never deleted, only unlisted or archived.
      </Section>

      <Section n={8} title="No warranty; limitation of liability">
        The platform is provided &ldquo;as is&rdquo; and &ldquo;as available.&rdquo; Natural Health
        Pros makes no warranty that the platform will be uninterrupted or error-free. To the
        maximum extent permitted by law, Natural Health Pros is not liable for indirect,
        incidental, or consequential damages arising from your use of the platform or any service
        booked through it.{' '}
        <span className="italic">
          [Governing law / liability cap figure — needs Amy + counsel, not a default to guess at.]
        </span>
      </Section>

      <Section n={9} title="Termination">
        Natural Health Pros may suspend or remove a profile that violates these Terms,
        misrepresents qualifications, or (per Whop&apos;s own policy, which flows through here)
        generates excessive payment disputes. Practitioners may request removal of their own
        profile at any time.
      </Section>

      <Section n={10} title="Changes to these Terms">
        We will provide at least 30 days&apos; notice (by email or in-app) before a material change
        to these Terms takes effect. Continued use after that date constitutes acceptance.
      </Section>

      <Section n={11} title="Governing law and disputes">
        <span className="italic">
          [BLANK — needs Amy/Jonathan/counsel: state of incorporation, and whether to mirror
          Whop&apos;s binding arbitration clause or handle disputes differently. Do not leave this
          blank when it ships.]
        </span>
      </Section>
    </div>
  );
}

function Section({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="font-medium text-foreground">
        {n}. {title}
      </p>
      <p>{children}</p>
    </div>
  );
}
