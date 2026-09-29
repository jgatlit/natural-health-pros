import type { PlanCardView } from './PlanChoice';

type Props = {
  plans: PlanCardView[];
  termMonths: number;
  referralRateLabel: string;
};

/**
 * Every plan value, stated once, before a practitioner commits to anything.
 *
 * The public homepage deliberately shows no prices or percentages (Amy, 2026-09-18; operator
 * ruling 2026-09-28). Onboarding and the edit page are the opposite: operator ruling — publish all
 * values, for clarity and transparency. Every figure arrives as a pre-formatted string from
 * `planComparison()` and the admin term setting, so nothing here can show a number the checkout
 * does not charge.
 */
export function PlanTermsSummary({ plans, termMonths, referralRateLabel }: Props) {
  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-4">
      <div className="space-y-0.5">
        <p className="text-sm font-medium">How Natural Health Pros is paid</p>
        <p className="text-xs text-muted-foreground">
          You choose a plan in your dashboard after this step, and you can switch later. Nothing is
          charged until you do.
        </p>
      </div>

      <table className="w-full text-xs">
        <thead className="text-muted-foreground">
          <tr>
            <th className="py-1 text-left font-normal" scope="col">
              <span className="sr-only">Term</span>
            </th>
            {plans.map((p) => (
              <th key={p.key} className="py-1 text-right font-medium text-foreground" scope="col">
                {p.label}
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
                {p.monthlyLabel}
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

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        The {termMonths} months run from each client&rsquo;s first payment to you. Clients on your
        own list, and anyone you invite, are always 0%. When another practitioner refers a client to
        you, {referralRateLabel} of those sessions goes to them and {referralRateLabel} to Natural
        Health Pros for the same term, on either plan.
      </p>
    </div>
  );
}
