/**
 * Specialty wording rules (operator ruling 2026-10-15: "Specialties should not be awarded/added by
 * the application"). Every specialty a practitioner shows is one they wrote. Onboarding may
 * normalise WORDING — case, whitespace, punctuation, plural, role suffix — but must never assign a
 * different concept. If no existing specialty is the same words, the practitioner's own label
 * becomes a new specialty.
 *
 * Deliberately conservative: a false negative only creates a near-duplicate node an admin can
 * merge, while a false positive puts a concept on a profile the practitioner never claimed.
 */

/** Trailing role words that name the person rather than the practice ("Reiki Master" = Reiki). */
const ROLE_TAIL = new Set([
  'practitioner',
  'master',
  'teacher',
  'instructor',
  'specialist',
  'provider',
]);

/** Whole-word equivalents for role nouns whose forms the suffix rules below cannot pair. */
const WORD_FORMS: Record<string, string> = {
  coaching: 'coach',
  coaches: 'coach',
  therapist: 'therapy',
  therapists: 'therapy',
  therapies: 'therapy',
  healer: 'heal',
  healers: 'heal',
  healing: 'heal',
  trainer: 'train',
  trainers: 'train',
  training: 'train',
  counselor: 'counsel',
  counsellor: 'counsel',
  counselors: 'counsel',
  counsellors: 'counsel',
  counseling: 'counsel',
  counselling: 'counsel',
  mentoring: 'mentor',
  mentors: 'mentor',
  consultant: 'consult',
  consultants: 'consult',
  consulting: 'consult',
};

function stemToken(token: string): string {
  let t = WORD_FORMS[token] ?? token;
  // Plural. 'ss' (stress), 'us' (focus) and 'is' (hypnosis) are not plurals.
  if (t.length > 4 && t.endsWith('ies')) t = `${t.slice(0, -3)}y`;
  else if (t.length > 3 && t.endsWith('s') && !/(ss|us|is)$/.test(t)) t = t.slice(0, -1);
  t = WORD_FORMS[t] ?? t;
  // -therapy / -therapist / -ist / -y all name the same practice: Hypnotist = Hypnotherapy,
  // Reflexologist = Reflexology, Nutritionist = Nutrition, Naturopath = Naturopathy.
  if (t.length > 9 && t.endsWith('therapist')) return t.slice(0, -'therapist'.length);
  if (t.length > 7 && t.endsWith('therapy')) return t.slice(0, -'therapy'.length);
  if (t.length > 5 && t.endsWith('tist')) return t.slice(0, -'tist'.length);
  if (t.length > 5 && t.endsWith('ist')) return t.slice(0, -'ist'.length);
  if (t.length > 4 && t.endsWith('y') && !/[aeiou]y$/.test(t)) return t.slice(0, -1);
  return t;
}

/**
 * Comparison key for a specialty label. Two labels with the same key are the same words in a
 * different form; nothing else (no synonyms, no parent concepts, no aliases) produces a match.
 */
export function specialtyMatchKey(label: string): string {
  const words = label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  while (words.length > 1 && ROLE_TAIL.has(words[words.length - 1].replace(/s$/, ''))) words.pop();
  return words.map(stemToken).filter(Boolean).join(' ');
}

/** True when `rawLabel` is `canonicalName` in different wording (case, plural, role suffix). */
export function isWordingVariant(rawLabel: string, canonicalName: string): boolean {
  const a = specialtyMatchKey(rawLabel);
  return a !== '' && a === specialtyMatchKey(canonicalName);
}

/** Lowercased, trimmed, whitespace-collapsed: the form SpecialtyAlias.label is stored in. */
export const normalizeAliasLabel = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

const SMALL_WORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with',
]);

/**
 * The practitioner's label tidied into a specialty name: whitespace collapsed and Title Case.
 * A word already carrying capitals past its first letter (AO, BC-HHP, CranioSacral) is the
 * practitioner's deliberate styling and is kept as written.
 */
export function specialtyNameFromLabel(rawLabel: string): string {
  const words = rawLabel.trim().replace(/\s+/g, ' ').split(' ');
  return words
    .map((word, i) => {
      if (/[A-Z]/.test(word.slice(1))) return word;
      return word
        .split(/([-/])/)
        .map((part, j) => {
          if (part === '-' || part === '/' || !part) return part;
          const lower = part.toLowerCase();
          if (i > 0 && j === 0 && SMALL_WORDS.has(lower)) return lower;
          return lower.charAt(0).toUpperCase() + lower.slice(1);
        })
        .join('');
    })
    .join(' ');
}
