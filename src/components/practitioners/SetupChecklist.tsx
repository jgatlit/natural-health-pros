import { Check } from 'lucide-react';
import { Card } from '@/components/ui/card';

export type SetupStep = {
  key: string;
  label: string;
  /** One line on why the step exists — what it unlocks, not what the field is called. */
  hint: string;
  done: boolean;
  href: string;
  cta: string;
};

/**
 * The practitioner's setup path, in the order the page below is laid out.
 *
 * Every `done` is derived by the caller from state that already exists (profile completeness, the
 * chosen plan, Whop payouts, offerings and booking links) — this component stores nothing and adds
 * no column. It disappears once every step is done, at which point the page reorders itself around
 * running the practice (Bookings and Clients first).
 *
 * Exactly one step is "current": the first that is not done. Highlighting more than one is how a
 * checklist stops telling anyone what to do next.
 */
export function SetupChecklist({ steps }: { steps: SetupStep[] }) {
  const doneCount = steps.filter((s) => s.done).length;
  const currentKey = steps.find((s) => !s.done)?.key;

  return (
    <Card className="space-y-4 p-6">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Get set up</h2>
        <p className="text-xs text-muted-foreground">
          {doneCount} of {steps.length} done
        </p>
      </div>

      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={steps.length}
        aria-valuenow={doneCount}
        aria-label="Setup progress"
      >
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${(doneCount / steps.length) * 100}%` }}
        />
      </div>

      <ol className="divide-y">
        {steps.map((step, i) => {
          const current = step.key === currentKey;
          return (
            <li
              key={step.key}
              className={`flex items-center gap-3 py-3 ${current ? 'rounded-md bg-primary/5 px-3 -mx-3' : ''}`}
            >
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                  step.done
                    ? 'bg-primary text-primary-foreground'
                    : current
                      ? 'border-2 border-primary text-primary'
                      : 'border text-muted-foreground'
                }`}
                aria-hidden
              >
                {step.done ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className={`text-sm ${step.done ? 'text-muted-foreground' : 'font-medium'}`}>
                  {step.label}
                  {step.done && <span className="sr-only"> (done)</span>}
                </p>
                {!step.done && <p className="text-xs text-muted-foreground">{step.hint}</p>}
              </div>
              {!step.done && (
                <a
                  href={step.href}
                  className={`shrink-0 text-xs font-medium underline-offset-2 hover:underline ${
                    current ? 'text-primary' : 'text-muted-foreground'
                  }`}
                >
                  {step.cta}
                </a>
              )}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
