'use client';

import { useFormState, useFormStatus } from 'react-dom';

import { overrideAttributionAction, type OverrideFormState } from './actions';

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="h-8 rounded-md bg-slate-900 px-3 text-xs font-medium text-white disabled:opacity-60"
    >
      {pending ? 'Applying…' : 'Override'}
    </button>
  );
}

/**
 * The override form for one attribution row.
 *
 * The NOTE IS `required` IN THE MARKUP AND REQUIRED AGAIN ON THE SERVER. The browser attribute is
 * a courtesy; `overrideAttribution` throws without one, because an unexplained change to who gets
 * paid is unauditable the moment the person who made it stops remembering why.
 */
export function OverrideForm({
  attributionId,
  owner,
  referrerPractitionerId,
}: {
  attributionId: string;
  owner: string;
  referrerPractitionerId: string | null;
}) {
  const [state, action] = useFormState<OverrideFormState, FormData>(
    overrideAttributionAction,
    null,
  );

  return (
    <form action={action} className="mt-2 flex flex-wrap items-center gap-2">
      <input type="hidden" name="attributionId" value={attributionId} />
      <select
        name="owner"
        defaultValue={owner}
        aria-label="Owner"
        className="h-8 rounded-md border border-slate-300 px-2 text-xs"
      >
        <option value="NHP">NHP-sourced</option>
        <option value="PRACTITIONER">Practitioner&rsquo;s own (0%)</option>
      </select>
      <input
        name="referrerPractitionerId"
        defaultValue={referrerPractitionerId ?? ''}
        placeholder="Referrer practitioner id (blank = none)"
        className="h-8 w-64 rounded-md border border-slate-300 px-2 text-xs"
      />
      <input
        name="note"
        required
        placeholder="Why? (required)"
        className="h-8 w-72 rounded-md border border-slate-300 px-2 text-xs"
      />
      <Submit />
      {state && (
        <span className={`text-xs ${state.ok ? 'text-emerald-700' : 'text-rose-700'}`}>
          {state.message}
        </span>
      )}
    </form>
  );
}
