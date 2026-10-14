'use client';

import { useMemo, useState } from 'react';
import { useFormState, useFormStatus } from 'react-dom';

import {
  annualPlanAPriceCents,
  parseScheduleForm,
  rateScheduleViolations,
  SCHEDULE_FORM_FIELDS,
  toFormValue,
  type RateScheduleNumbers,
} from '@/lib/rate-schedule';

import { migrateRateScheduleCohort, saveRateSchedule, type SettingFormState } from './actions';

function Button({ children }: { children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
    >
      {pending ? 'Working…' : children}
    </button>
  );
}

function Result({ state }: { state: SettingFormState }) {
  if (!state) return null;
  return (
    <p className={`mt-3 text-sm ${state.ok ? 'text-emerald-700' : 'text-red-700'}`} role="status">
      {state.message}
    </p>
  );
}

/**
 * Edit the CURRENT rate schedule. Saving never edits a stored schedule — it finds an identical one
 * or creates a new one, and makes it the schedule for NEW sign-ups.
 *
 * The live validation and the derived yearly price here use the same pure functions as the server
 * (`rate-schedule.ts`), so the preview cannot disagree with what the server will accept. The server
 * action re-validates everything: this panel is a courtesy, not the gate.
 */
export function RateScheduleForm({
  initial,
  currentLabel,
}: {
  initial: RateScheduleNumbers;
  currentLabel: string;
}) {
  const [state, action] = useFormState<SettingFormState, FormData>(saveRateSchedule, null);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      SCHEDULE_FORM_FIELDS.map((f) => [f.name, toFormValue(f.unit, initial[f.field])]),
    ),
  );
  const [label, setLabel] = useState('');

  const parsed = useMemo(() => parseScheduleForm((n) => values[n]), [values]);
  const violations = useMemo(() => rateScheduleViolations(parsed), [parsed]);
  const annual = violations.length === 0 ? annualPlanAPriceCents(parsed as RateScheduleNumbers) : null;

  return (
    <form action={action} className="rounded-lg border border-slate-200 p-5">
      <h2 className="text-sm font-semibold text-slate-900">Rate schedule for new sign-ups</h2>
      <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-600">
        Currently <strong>{currentLabel}</strong>. Saving finds an identical schedule or creates a new
        one, then makes it the schedule for <strong>new sign-ups only</strong>. Practitioners who
        already have a schedule keep it until you migrate them below, and a client already
        attributed keeps the rates they were sold under.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        {SCHEDULE_FORM_FIELDS.map((f) => (
          <div key={f.name}>
            <label htmlFor={`rs-${f.name}`} className="block text-sm font-medium text-slate-900">
              {f.label}
            </label>
            <div className="mt-1 flex items-center gap-2">
              {f.unit === 'dollars' && <span className="text-sm text-slate-500">$</span>}
              <input
                id={`rs-${f.name}`}
                name={f.name}
                inputMode="decimal"
                value={values[f.name]}
                onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
                className="w-28 rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
              {f.unit === 'percent' && <span className="text-sm text-slate-500">%</span>}
              {f.unit === 'months' && <span className="text-sm text-slate-500">months</span>}
            </div>
            <p className="mt-1 text-xs leading-snug text-slate-500">{f.help}</p>
          </div>
        ))}
      </div>

      <div className="mt-4">
        <label htmlFor="rs-label" className="block text-sm font-medium text-slate-900">
          Label (only used if this creates a new schedule)
        </label>
        <input
          id="rs-label"
          name="label"
          value={label}
          maxLength={80}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. Founding — 2026-11"
          className="mt-1 w-full max-w-md rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
      </div>

      <div className="mt-4 rounded-md bg-slate-50 p-3 text-sm">
        <p className="text-slate-700">
          Yearly Plan A price (derived):{' '}
          <strong>{annual === null ? '—' : `$${(annual / 100).toFixed(2)}`}</strong>
        </p>
        {violations.length > 0 ? (
          <ul className="mt-2 list-disc pl-5 text-red-700" aria-live="polite">
            {violations.map((v) => (
              <li key={v}>{v}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-emerald-700">All invariants hold.</p>
        )}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <Button>Save as current schedule</Button>
      </div>
      <Result state={state} />
    </form>
  );
}

export function MigrateCohortForm({
  schedules,
}: {
  schedules: { id: string; label: string; members: number }[];
}) {
  const [state, action] = useFormState<SettingFormState, FormData>(migrateRateScheduleCohort, null);
  return (
    <form action={action} className="rounded-lg border border-slate-200 p-5">
      <h2 className="text-sm font-semibold text-slate-900">Migrate a cohort</h2>
      <p className="mt-1 max-w-2xl text-sm leading-relaxed text-slate-600">
        Moves <strong>every practitioner</strong> on the source schedule to the destination. This is
        the only way an existing practitioner changes schedule. It needs a reason and is recorded in
        the change history below. Clients already attributed keep the rates they were sold under.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="block font-medium text-slate-900">From</span>
          <select name="fromScheduleId" className="mt-1 rounded-md border border-slate-300 px-3 py-2 text-sm" defaultValue="">
            <option value="" disabled>
              Choose…
            </option>
            {schedules.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} ({s.members})
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="block font-medium text-slate-900">To</span>
          <select name="toScheduleId" className="mt-1 rounded-md border border-slate-300 px-3 py-2 text-sm" defaultValue="">
            <option value="" disabled>
              Choose…
            </option>
            {schedules.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} ({s.members})
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-[16rem] flex-1 text-sm">
          <span className="block font-medium text-slate-900">Reason (required)</span>
          <input
            name="reason"
            required
            minLength={3}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        <Button>Migrate cohort</Button>
      </div>
      <Result state={state} />
    </form>
  );
}
