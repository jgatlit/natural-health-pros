import type { PlanCardView } from './PlanChoice';
import { StrikePrice } from './StrikePrice';
import { NoteMark, PricingNoteLine } from './PricingNote';
import { PLAN_VALUE, REFERRAL_TERMS_PENDING, type ReferralTermsView } from '@/lib/pricing-plans';
import type { DisplaySettings } from '@/lib/platform-settings';

type Props = {
  plans: PlanCardView[];
  referral: ReferralTermsView;
  display: DisplaySettings;
};

/**
 * Every plan value, stated once, before a practitioner commits to anything.
 *
 * The public homepage deliberately shows no prices or percentages (Amy, 2026-09-18; operator
 * ruling 2026-09-28). Onboarding and the edit page are the opposite: operator ruling — publish all
 * values, for clarity and transparency. Every figure arrives as a pre-formatted string from
 * `planComparison()` and the admin term setting, so nothing here can show a number the checkout
 * does not charge.
 *
 * Unless the admin has published plan rates (`display.showPlanRates`), the table is replaced by
 * what each plan includes; the referral split likewise waits on `display.showCommissionTerms`.
 */
export function PlanTermsSummary({ plans, referral, display }: Props) {
  const { termMonths } = referral;
  const { showPlanRates, showCommissionTerms, pricingNote } = display;
  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-4">
      <div className="space-y-0.5">
        <p className="text-sm font-medium">How Natural Health Pros is paid</p>
        <p className="text-xs text-muted-foreground">
          You choose a plan in your dashboard after this step, and you can switch later. Nothing is
          charged until you do.
        </p>
      </div>

      {showPlanRates ? (
      <table className="w-full text-xs">
        <thead className="text-muted-foreground">
          <tr>
            <th className="py-1 text-left font-normal" scope="col">
              <span className="sr-only">Term</span>
            </th>
            {plans.map((p) => (
              <th key={p.key} className="py-1 text-right font-medium text-foreground" scope="col">
                {p.label}
                <NoteMark note={pricingNote} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className="border-t">
            <th className="py-1.5 text-left font-normal text-muted-foreground" scope="row">
              Monthly
            </th>
            {plans.map((p) => (
              <td key={p.key} className="py-1.5 text-right">
                <StrikePrice listLabel={p.monthlyListLabel} priceLabel={p.monthlyLabel} />
                {p.discountLabel && <span className="block text-muted-foreground">{p.discountLabel}</span>}
              </td>
            ))}
          </tr>
          <tr className="border-t">
            <th className="py-1.5 text-left font-normal text-muted-foreground" scope="row">
              Clients we send you, for {termMonths} months
            </th>
            {plans.map((p) => (
              <td key={p.key} className="py-1.5 text-right">
                {p.sourcedSessionLabel}
              </td>
            ))}
          </tr>
          <tr className="border-t">
            <th className="py-1.5 text-left font-normal text-muted-foreground" scope="row">
              After {termMonths} months
            </th>
            {plans.map((p) => (
              <td key={p.key} className="py-1.5 text-right">
                {p.afterTermLabel}
              </td>
            ))}
          </tr>
          <tr className="border-t">
            <th className="py-1.5 text-left font-normal text-muted-foreground" scope="row">
              Your own clients
            </th>
            {plans.map((p) => (
              <td key={p.key} className="py-1.5 text-right">
                We take nothing
              </td>
            ))}
          </tr>
        </tbody>
      </table>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {plans.map((p) => (
            <div key={p.key} className="space-y-1" data-testid="plan-value-points">
              <p className="text-xs font-medium">
                {p.label}
                <NoteMark note={pricingNote} />
                <span className="font-normal text-muted-foreground"> · {PLAN_VALUE[p.key].kicker}</span>
              </p>
              <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
                {PLAN_VALUE[p.key].points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      <PricingNoteLine note={pricingNote} />

      {showPlanRates ? (
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        The {termMonths} months run from each client&rsquo;s first payment to you. Clients on your
        own list, and anyone you invite, are always 0%.
      </p>
      ) : (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Clients on your own list, and anyone you invite, are always fee-free. Current rates are
          confirmed to you before any share applies.
        </p>
      )}

      {showCommissionTerms ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          When another practitioner refers a client to you, {referral.referralTotalLabel} of those
          sessions is taken for the first {referral.referrerTermMonths} months, on either plan:{' '}
          {referral.referrerRateLabel} goes to them and {referral.nhpReferralRateLabel} to Natural
          Health Pros. After that, your plan&rsquo;s rate applies until month {termMonths}.
        </p>
      ) : (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Members refer clients to each other. {REFERRAL_TERMS_PENDING}
        </p>
      )}
    </div>
  );
}
