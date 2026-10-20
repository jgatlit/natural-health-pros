'use client';

import { useFormState, useFormStatus } from 'react-dom';

import { saveDisplaySettingAction, type SettingFormState } from './actions';

function Submit({ children, value }: { children: React.ReactNode; value?: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name={value === undefined ? undefined : 'value'}
      value={value}
      disabled={pending}
      className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
    >
      {pending ? 'Saving…' : children}
    </button>
  );
}

function Result({ state }: { state: SettingFormState }) {
  if (!state) return null;
  return <p className={`mt-2 text-sm ${state.ok ? 'text-emerald-700' : 'text-red-700'}`}>{state.message}</p>;
}

/** One switch, its own form, so turning one on can never change the other on the same submit. */
function SwitchForm({
  name,
  label,
  help,
  on,
}: {
  name: 'showPlanRates' | 'showCommissionTerms';
  label: string;
  help: string;
  on: boolean;
}) {
  const [state, action] = useFormState<SettingFormState, FormData>(saveDisplaySettingAction, null);
  return (
    <form action={action} className="border-t border-slate-100 pt-4 first:border-t-0 first:pt-0">
      <input type="hidden" name="name" value={name} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-900">
            {label}{' '}
            <span
              className={`ml-1 rounded px-1.5 py-0.5 text-xs font-medium ${on ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-700'}`}
            >
              {on ? 'On' : 'Off'}
            </span>
          </p>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-600">{help}</p>
        </div>
        <Submit value={on ? 'off' : 'on'}>{on ? 'Turn off' : 'Turn on'}</Submit>
      </div>
      <Result state={state} />
    </form>
  );
}

function NoteForm({ label, help, note, maxLength }: { label: string; help: string; note: string | null; maxLength: number }) {
  const [state, action] = useFormState<SettingFormState, FormData>(saveDisplaySettingAction, null);
  return (
    <div className="border-t border-slate-100 pt-4">
      <form action={action}>
        <input type="hidden" name="name" value="pricingNote" />
        <label htmlFor="display-pricing-note" className="block text-sm font-semibold text-slate-900">
          {label}
        </label>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-600">{help}</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <input
            id="display-pricing-note"
            name="value"
            type="text"
            maxLength={maxLength}
            defaultValue={note ?? ''}
            placeholder="e.g. Founding-member pricing is guaranteed for 12 months."
            className="w-full max-w-xl rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <Submit>Save note</Submit>
        </div>
      </form>
      {note && (
        <form action={action} className="mt-2">
          <input type="hidden" name="name" value="pricingNote" />
          <input type="hidden" name="value" value="" />
          <button type="submit" className="text-sm text-slate-600 underline hover:text-slate-900">
            Clear the note
          </button>
        </form>
      )}
      <Result state={state} />
    </div>
  );
}

/**
 * "WHAT PRACTITIONERS SEE" — whether plan and commission figures are published, and the optional
 * pricing note. Changes apply on the next page load; no deploy.
 */
export function DisplaySettingsCard({
  showPlanRates,
  showCommissionTerms,
  pricingNote,
  defs,
  warnings,
}: {
  showPlanRates: boolean;
  showCommissionTerms: boolean;
  pricingNote: string | null;
  defs: {
    showPlanRates: { label: string; help: string };
    showCommissionTerms: { label: string; help: string };
    pricingNote: { label: string; help: string; maxLength: number };
  };
  warnings: string[];
}) {
  return (
    <section className="rounded-lg border border-slate-200 p-5" id="what-practitioners-see">
      <h2 className="text-sm font-semibold text-slate-900">What practitioners see</h2>
      <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-600">
        Whether practitioner-facing screens publish the figures from the rate schedule. Nothing here
        changes a rate or what anyone is charged, and the checkout buttons always show the price.
      </p>
      {warnings.length > 0 && (
        <ul className="mt-3 space-y-2" data-testid="display-warnings">
          {warnings.map((w) => (
            <li key={w} role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              {w}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 space-y-4">
        <SwitchForm name="showPlanRates" label={defs.showPlanRates.label} help={defs.showPlanRates.help} on={showPlanRates} />
        <SwitchForm
          name="showCommissionTerms"
          label={defs.showCommissionTerms.label}
          help={defs.showCommissionTerms.help}
          on={showCommissionTerms}
        />
        <NoteForm
          label={defs.pricingNote.label}
          help={defs.pricingNote.help}
          note={pricingNote}
          maxLength={defs.pricingNote.maxLength}
        />
      </div>
    </section>
  );
}
