/**
 * "Open to outside work and collaboration" (v1.5 L1c).
 *
 * PRIVATE field. It is read by the owner's /edit toggle and the admin list and by nothing public:
 * not the profile, not the Typesense document, not search. tests/outside-work.test.ts pins that.
 */

export const OUTSIDE_WORK_QUESTION =
  'Are you open to outside work and collaboration with other clinics and practitioners?';

export const OUTSIDE_WORK_HELPER =
  'Turn this on to hear about care-team, contract and collaboration opportunities. You can change it any time.';

export const OUTSIDE_WORK_FIELD = 'openToOutsideWork';

/** Onboarding radio value -> boolean. Anything else (absent, empty, forged) is "unanswered". */
export function parseOutsideWorkAnswer(raw: FormDataEntryValue | null): boolean | null {
  if (raw === 'yes') return true;
  if (raw === 'no') return false;
  return null;
}

export type OutsideWorkCurrent = {
  openToOutsideWork: boolean;
  openToOutsideWorkUpdatedAt: Date | null;
};

/**
 * The columns to write for a new answer, or null when nothing should be written.
 *
 * - The /edit toggle (`recordFirstAnswer: false`) writes only on a real change, so the timestamp
 *   means "when the value last changed".
 * - Onboarding (`recordFirstAnswer: true`) also writes when the timestamp is still null: an
 *   answer of "No" equals the column default, but it is still the first answer and must be
 *   recorded as one.
 */
export function outsideWorkWrite(
  current: OutsideWorkCurrent,
  next: boolean,
  now: Date,
  opts: { recordFirstAnswer: boolean },
): OutsideWorkCurrent | null {
  const changed = current.openToOutsideWork !== next;
  const firstAnswer = opts.recordFirstAnswer && current.openToOutsideWorkUpdatedAt === null;
  if (!changed && !firstAnswer) return null;
  return { openToOutsideWork: next, openToOutsideWorkUpdatedAt: now };
}

export type OutsideWorkFilter = 'all' | 'open' | 'not-open';

export function parseOutsideWorkFilter(raw: unknown): OutsideWorkFilter {
  return raw === 'open' || raw === 'not-open' ? raw : 'all';
}

export function matchesOutsideWorkFilter(
  filter: OutsideWorkFilter,
  practitioner: { openToOutsideWork: boolean } | null | undefined,
): boolean {
  if (filter === 'all') return true;
  if (!practitioner) return false;
  return filter === 'open' ? practitioner.openToOutsideWork : !practitioner.openToOutsideWork;
}
