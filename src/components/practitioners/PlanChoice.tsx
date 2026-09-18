import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { CheckCircle2 } from 'lucide-react';
import { PendingButton } from './PendingButton';

export type PlanCardView = {
  key: 'PLAN_A' | 'PLAN_B';
  label: string;
  monthlyLabel: string;
  firstSessionLabel: string;
  laterSessionLabel: string;
  suits: string;
};

type Props = {
  chosen: 'PLAN_A' | 'PLAN_B' | null;
  plans: PlanCardView[];
  /** Rows of "at $X/mo of platform-sourced bookings you'd pay …" — computed server-side. */
  breakEven: { volumeLabel: string; planACost: string; planBCost: string; better: string }[];
  chooseAction: (formData: FormData) => void | Promise<void>;
};

/**
 * Plan A / Plan B choice, rendered at the TOP of "Premium Accounts & Directory Listing".
 *
 * It is a step of its own rather than a field in the profile form on purpose: it is a commercial
 * commitment, and a pricing term buried among bio fields is how someone later says they never
 * agreed to it. It sits above the status card because the status card is meaningless until a plan
 * exists.
 *
 * NO "RECOMMENDED" BADGE, and equal visual weight for both cards. Amy was explicit on 2026-09-14
 * that these are a choice and not tiers — "tiers imply hierarchy" — and a highlighted card would
 * quietly re-impose the hierarchy the naming was chosen to avoid.
 *
 * Every number comes from src/lib/pricing-plans.ts. No price is ever written into this file: the
 * figures are still Amy's decision and are expected to change before launch.
 */
export function PlanChoice({ chosen, plans, breakEven, chooseAction }: Props) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {chosen ? 'Your plan' : 'Choose how you want to pay'}
        </h3>
        {chosen && (
          <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
            {plans.find((p) => p.key === chosen)?.label ?? chosen}
          </Badge>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {plans.map((plan) => {
          const isChosen = chosen === plan.key;
          return (
            <Card
              key={plan.key}
              className={`flex flex-col gap-3 p-4 ${isChosen ? 'border-primary' : ''}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold">{plan.label}</span>
                {isChosen && (
                  <CheckCircle2 className="h-4 w-4 text-primary" aria-label="Current plan" />
                )}
              </div>

              <dl className="space-y-1 text-xs">
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">Monthly</dt>
                  <dd className="font-medium">{plan.monthlyLabel}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">First session we source</dt>
                  <dd className="font-medium">{plan.firstSessionLabel}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-muted-foreground">After that</dt>
                  <dd className="font-medium">{plan.laterSessionLabel}</dd>
                </div>
              </dl>

              <p className="text-xs text-muted-foreground">{plan.suits}</p>

              <form action={chooseAction} className="mt-auto">
                <input type="hidden" name="plan" value={plan.key} />
                <PendingButton
                  pendingLabel="Saving…"
                  className={`inline-flex h-9 w-full items-center justify-center rounded-md text-sm font-medium transition-colors disabled:opacity-60 ${
                    isChosen
                      ? 'border bg-muted/40 text-muted-foreground'
                      : 'bg-primary text-primary-foreground hover:bg-primary/90'
                  }`}
                >
                  {isChosen ? 'Current plan' : `Choose ${plan.label}`}
                </PendingButton>
              </form>
            </Card>
          );
        })}
      </div>

      {/* Amy's break-even framing, 2026-09-14 — the single most persuasive thing said on that call,
          and it belongs where the decision is made rather than in a sales email. Rendered as a
          table of real volumes instead of a slider: it needs no client JavaScript, it prints, and
          it cannot disagree with the cards above because every figure comes from the same config. */}
      <Card className="p-4">
        <p className="text-xs font-medium">What each plan would cost you</p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          Based on first sessions we source for you in a month. Sessions you book yourself are never
          counted.
        </p>
        <table className="mt-2 w-full text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 text-left font-normal">Sourced /mo</th>
              <th className="py-1 text-right font-normal">{plans[0]?.label}</th>
              <th className="py-1 text-right font-normal">{plans[1]?.label}</th>
              <th className="py-1 text-right font-normal">Cheaper</th>
            </tr>
          </thead>
          <tbody>
            {breakEven.map((row) => (
              <tr key={row.volumeLabel} className="border-t">
                <td className="py-1">{row.volumeLabel}</td>
                <td className="py-1 text-right">{row.planACost}</td>
                <td className="py-1 text-right">{row.planBCost}</td>
                <td className="py-1 text-right font-medium">{row.better}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <p className="text-[11px] text-muted-foreground">
        You can switch plans later from this page. Both plans need a connected Whop account —
        that is how payments reach you.
      </p>
    </div>
  );
}
