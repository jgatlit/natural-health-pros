'use client';

import { useFormState, useFormStatus } from 'react-dom';

import { saveCommercialSetting, type SettingFormState } from './actions';

/**
 * ⚠️ `useFormState` FROM react-dom, NOT `useActionState` FROM react.
 *
 * This file shipped importing `useActionState`, which does not exist in React 18 — it lands in
 * React 19. `next build` reported it as a WARNING ("Attempted import error"), not an error, so
 * tsc passed, the suite passed and the page compiled while the form would have thrown on render
 * the first time an operator opened it. The build table and its warnings are an oracle the tests
 * are not.
 *
 * `pending` moves to a child component because `useFormState` does not return it; `useFormStatus`
 * has to be read from inside the form it describes.
 */
function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
    >
      {pending ? 'Saving…' : 'Save'}
    </button>
  );
}

/**
 * One number, one save button, and the sentence explaining what it does to money.
 *
 * Deliberately NOT a combined "save all settings" form: each value governs a different
 * mechanisms and an operator editing the hold period should not be able to nudge the attribution
 * term by accident on the same submit.
 */
export function SettingForm({
  name,
  label,
  help,
  unit,
  current,
  min,
  max,
  requiresReason = false,
}: {
  name: 'referralHoldDays' | 'affiliateHoldDays';
  label: string;
  help: string;
  unit: string;
  current: number;
  min: number;
  max: number;
  /** Shows a mandatory "why" box; the server refuses the change without one. */
  requiresReason?: boolean;
}) {
  const [state, action] = useFormState<SettingFormState, FormData>(saveCommercialSetting, null);

  return (
    <form action={action} className="rounded-lg border border-slate-200 p-5">
      <input type="hidden" name="name" value={name} />
      <label htmlFor={`setting-${name}`} className="block text-sm font-semibold text-slate-900">
        {label}
      </label>
      <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-600">{help}</p>
      <div className="mt-3 flex items-center gap-3">
        <input
          id={`setting-${name}`}
          name="value"
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          defaultValue={current}
          className="w-28 rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
        <span className="text-sm text-slate-600">{unit}</span>
        <SaveButton />
      </div>
      {requiresReason && (
        <div className="mt-3">
          <label htmlFor={`setting-${name}-reason`} className="block text-xs font-medium text-slate-700">
            Reason for the change (kept in the change history)
          </label>
          <input
            id={`setting-${name}-reason`}
            name="reason"
            type="text"
            required
            minLength={3}
            maxLength={500}
            className="mt-1 w-full max-w-xl rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </div>
      )}
      {state ? (
        <p className={`mt-3 text-sm ${state.ok ? 'text-emerald-700' : 'text-red-700'}`}>
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
