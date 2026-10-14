'use client';

import { useState, useTransition } from 'react';
import { OUTSIDE_WORK_HELPER, OUTSIDE_WORK_QUESTION } from '@/lib/outside-work';

type Props = {
  initial: boolean;
  /** Bound server action: saves immediately and resolves to the stored value. */
  action: (next: boolean) => Promise<boolean>;
};

/**
 * Saves on click, outside the profile form: it is not part of "Save profile" and must not trip
 * the unsaved-changes guard. A failed save reverts the switch to what it was.
 */
export function OutsideWorkToggle({ initial, action }: Props) {
  const [value, setValue] = useState(initial);
  const [pending, startTransition] = useTransition();
  const [failed, setFailed] = useState(false);

  function toggle() {
    const next = !value;
    setValue(next);
    setFailed(false);
    startTransition(async () => {
      try {
        setValue(await action(next));
      } catch {
        setValue(!next);
        setFailed(true);
      }
    });
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-start justify-between gap-4">
        <span id="outside-work-label" className="block text-xs font-medium">
          {OUTSIDE_WORK_QUESTION}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={value}
          aria-labelledby="outside-work-label"
          aria-describedby="outside-work-help"
          disabled={pending}
          onClick={toggle}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors disabled:opacity-60 ${
            value ? 'bg-primary' : 'bg-muted'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
              value ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>
      <p id="outside-work-help" className="text-[11px] leading-relaxed text-muted-foreground">
        {OUTSIDE_WORK_HELPER}
      </p>
      {failed && (
        <p role="alert" className="text-[11px] text-destructive">
          Could not save that change. Please try again.
        </p>
      )}
    </div>
  );
}
