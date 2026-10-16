import Anthropic from '@anthropic-ai/sdk';
import { isWordingVariant } from './specialty-match';

/**
 * AI onboarding draft step (Task B). Produces a first-pass practitioner profile
 * from raw self-description, which the practitioner then reviews/overrides in the
 * edit form before publishing.
 *
 * The LLM call is gated behind ONBOARDING_LLM_API_KEY. When no key is configured
 * the same interface returns a deterministic TEMPLATE draft (no network), so the
 * onboarding flow works end-to-end without a key — the practitioner just edits a
 * sparser starting point. Set ONBOARDING_LLM_MODEL to override the model
 * (default: claude-opus-4-8).
 */

export type DraftSpecialty = {
  /** Practitioner's own phrasing (their voice; becomes PractitionerSpecialty.rawLabel). */
  rawLabel: string;
  /** Catalog slug ONLY when it is the same words as rawLabel (else a kebab of rawLabel). A hint:
   *  the server ignores it unless it is a wording variant of rawLabel. */
  canonicalSlug: string;
  /** Catalog name under the same rule; never a different concept from rawLabel. */
  canonicalName: string;
  /** 0..1 mapping confidence; written onto the IMPORT/PENDING SpecialtyAlias. */
  confidence: number;
};

export type DraftCaseStudy = {
  title: string;
  summary: string;
  outcome?: string;
};

export type ProfileDraft = {
  headline: string;
  /** Short hook rendered above whoIHelp. Null when the source has no usable one — see the
   *  extractive rule in the tool schema; we never manufacture a claim to fill this. */
  tagline: string | null;
  whoIHelp: string;
  bio: string;
  modalities: string[];
  /** Credentials, certifications and education — one per entry, EXTRACTIVE ONLY (see the tool
   *  schema). A drafted credential the practitioner never claimed is not a wording problem, it
   *  is a fabricated qualification on a health directory. */
  qualifications: string[];
  specialties: DraftSpecialty[];
  caseStudies: DraftCaseStudy[];
};

export type DraftInput = {
  displayName: string;
  /** Free text the practitioner pasted / typed about their practice. */
  rawSource: string;
  /** Existing values to extend rather than discard (whoIHelp is already LLM-synthesized in intake). */
  existing?: {
    headline?: string | null;
    tagline?: string | null;
    whoIHelp?: string | null;
    bio?: string | null;
    rawLabels?: string[];
  };
  /** Existing specialty names, so a label that is the same words can reuse the existing spelling. */
  canonicalCatalog: { slug: string; name: string }[];
};

export type DraftResult = { draft: ProfileDraft; source: 'llm' | 'template' };

const DEFAULT_MODEL = 'claude-opus-4-8';

export function isLlmConfigured(): boolean {
  return !!process.env.ONBOARDING_LLM_API_KEY;
}

/**
 * Draft a profile. Uses the LLM when a key is configured, else a template
 * fallback. Never throws on LLM failure — it logs and falls back to template so
 * onboarding is never blocked by an LLM outage.
 */
export async function draftProfile(input: DraftInput): Promise<DraftResult> {
  if (isLlmConfigured()) {
    try {
      return { draft: await llmDraft(input), source: 'llm' };
    } catch (err) {
      console.error('Onboarding LLM draft failed; falling back to template:', err);
    }
  }
  return { draft: templateDraft(input), source: 'template' };
}

// ---------------------------------------------------------------------------
// LLM path
// ---------------------------------------------------------------------------

const DRAFT_TOOL: Anthropic.Tool = {
  name: 'emit_profile_draft',
  description: 'Emit the drafted practitioner profile fields.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      headline: { type: 'string', description: 'Credentials / professional title line (≤ 90 chars).' },
      tagline: {
        type: ['string', 'null'],
        description:
          'Short hook (≤ 70 chars, hard limit) shown above the "who I help" paragraph. ' +
          'GROUNDED, not verbatim: every idea in it must already be stated in the source — never ' +
          'introduce an outcome, benefit, promise or condition the practitioner did not claim. ' +
          'Within that limit you SHOULD reword. Plain English a patient would say out loud: if ' +
          "the source's punchiest phrase is industry jargon, insider shorthand or a coined term " +
          '(e.g. "slideware", "biohacking stack"), restate that same idea in ordinary words — do ' +
          'NOT import the jargon just because it is theirs. Must read as a distinct line from ' +
          'headline (their credential/title), not a restatement of it. Practitioner\'s voice — ' +
          'second person or imperative, never third person. If the source supports no honest ' +
          'hook, return null; never invent one.',
      },
      whoIHelp: {
        type: 'string',
        description: 'Plain-English "who I help and how" paragraph — the matching signal.',
      },
      bio: { type: 'string', description: 'First-person bio, 2-4 sentences.' },
      modalities: {
        type: 'array',
        items: { type: 'string' },
        description: 'Distinct practice modalities / methods named in the source.',
      },
      qualifications: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Credentials, certifications, degrees and formal training stated in the source — one ' +
          'per entry, e.g. "BS in Nutrition, Bastyr University" or "Certified Herbalist, HHE". ' +
          'STRICTLY EXTRACTIVE: include ONLY qualifications the source actually states. Never ' +
          'infer a credential from a modality they practise, never upgrade an unaccredited ' +
          'course to a degree, and never add a licence. Return an empty array if the source ' +
          'names none — an empty section is correct, an invented credential is not. ' +
          'THIS RENDERS UNDER A HEADING READING "Certifications & Education", so it must ' +
          'contain ONLY things that are actually a qualification. EXCLUDE, even when the ' +
          'source states them plainly: books authored, podcasts hosted, apps or programmes ' +
          'created, companies founded, awards, media appearances, follower counts, and years ' +
          'of experience or self-study — those are accomplishments, not credentials, and they ' +
          'belong in the bio. ALSO EXCLUDE anything still in progress ("studying for", ' +
          '"preparing for", "currently pursuing"): listing an unearned certification under ' +
          'this heading reads as a claim to hold it. A practitioner with real accomplishments ' +
          'but no stated credential must return an EMPTY array.',
      },
      specialties: {
        type: 'array',
        description:
          "The practitioner's own specialties, in their own words. rawLabel = their wording, " +
          'never replaced by a broader, related or "standard" concept. Use a catalog slug + name ' +
          'ONLY when it is the same words as rawLabel (differing at most in case, plural or a ' +
          'role suffix such as coach/coaching, therapist/therapy, -ist/-y, practitioner, master); ' +
          'otherwise set canonicalSlug to the kebab-case of rawLabel and canonicalName to rawLabel.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            rawLabel: { type: 'string' },
            canonicalSlug: { type: 'string' },
            canonicalName: { type: 'string' },
            confidence: { type: 'number', description: '0..1 confidence that rawLabel is a specialty the source states.' },
          },
          required: ['rawLabel', 'canonicalSlug', 'canonicalName', 'confidence'],
        },
      },
      caseStudies: {
        type: 'array',
        description: 'Optional anonymized client outcomes drawn ONLY from the source. Empty if none stated.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string' },
            summary: { type: 'string' },
            outcome: { type: 'string' },
          },
          required: ['title', 'summary'],
        },
      },
    },
    required: [
      'headline', 'tagline', 'whoIHelp', 'bio', 'modalities', 'qualifications', 'specialties',
      'caseStudies',
    ],
  },
};

async function llmDraft(input: DraftInput): Promise<ProfileDraft> {
  const client = new Anthropic({ apiKey: process.env.ONBOARDING_LLM_API_KEY });
  const model = process.env.ONBOARDING_LLM_MODEL || DEFAULT_MODEL;

  const catalog = input.canonicalCatalog
    .map((c) => `- ${c.name} (slug: ${c.slug})`)
    .join('\n');

  const prompt = [
    `You are drafting a directory profile for a Holistic Health Educators (HHE) practitioner.`,
    `Practitioner name: ${input.displayName}`,
    input.existing?.whoIHelp ? `Existing "who I help" (extend, don't discard): ${input.existing.whoIHelp}` : '',
    input.existing?.headline ? `Existing headline: ${input.existing.headline}` : '',
    input.existing?.tagline ? `Existing tagline (extend, don't discard): ${input.existing.tagline}` : '',
    input.existing?.bio ? `Existing bio: ${input.existing.bio}` : '',
    input.existing?.rawLabels?.length ? `Existing specialty phrasings: ${input.existing.rawLabels.join('; ')}` : '',
    '',
    `Raw self-description from the practitioner:`,
    '"""',
    input.rawSource || '(none provided — draft conservatively from name + existing fields only)',
    '"""',
    '',
    `Existing specialty names. Reuse one ONLY when it is the same words as the practitioner's label (case, plural or role suffix aside) — never map a label to a different or broader concept; otherwise use the practitioner's label as its own specialty:`,
    catalog || '(empty)',
    '',
    `Draft warm, specific, plain-English copy. Keep the practitioner's own wording in each specialty rawLabel.`,
    `Only include caseStudies that are actually stated in the source — never invent outcomes.`,
    `Tagline: GROUNDED, not verbatim. Every idea must already be in the source — never invent a benefit, outcome or promise. But DO reword into plain English a patient would say out loud: if their punchiest phrase is jargon or insider shorthand, say the same thing in ordinary words rather than importing the term. Distinct from the headline. Their voice, never third person. Max 70 chars. Null if the source supports no honest hook.`,
    `Call emit_profile_draft with the result.`,
  ]
    .filter(Boolean)
    .join('\n');

  const response = await client.messages.create({
    model,
    max_tokens: 2048,
    tools: [DRAFT_TOOL],
    tool_choice: { type: 'tool', name: 'emit_profile_draft' },
    messages: [{ role: 'user', content: prompt }],
  });

  const block = response.content.find((b) => b.type === 'tool_use');
  if (!block || block.type !== 'tool_use') {
    throw new Error('LLM did not return a tool_use block');
  }
  return normalizeDraft(block.input as Partial<ProfileDraft>, input);
}

// ---------------------------------------------------------------------------
// Template fallback (deterministic, no network)
// ---------------------------------------------------------------------------

function templateDraft(input: DraftInput): ProfileDraft {
  const source = input.rawSource.trim();
  const sentences = source
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const headline =
    input.existing?.headline?.trim() ||
    `${input.displayName} · Holistic Health Practitioner`;

  // No LLM here, so there is no way to compress the source into a hook without inventing one —
  // which the extractive rule forbids. Carry an existing tagline through; otherwise leave null
  // and let the field simply not render.
  const tagline = input.existing?.tagline?.trim() || null;

  const whoIHelp =
    input.existing?.whoIHelp?.trim() ||
    sentences.slice(0, 2).join(' ') ||
    `${input.displayName} supports clients pursuing a holistic, root-cause approach to their health.`;

  const bioBase = input.existing?.bio?.trim() || source;
  const bio =
    bioBase.length >= 20
      ? bioBase
      : `${input.displayName} is a holistic health practitioner. ${whoIHelp}`.trim();

  // Only labels the practitioner already wrote. A catalog name merely MENTIONED in the source is
  // not a claim ("I'm not a yoga teacher and I don't do reiki" mentions both), and without an
  // LLM there is no reading of intent, so the template never adds a specialty of its own.
  const phrasings = input.existing?.rawLabels ?? [];
  const seenRaw = new Set<string>();
  const specialties: DraftSpecialty[] = [];
  for (const rawLabel of phrasings) {
    const key = rawLabel.toLowerCase().trim();
    if (!key || seenRaw.has(key)) continue;
    seenRaw.add(key);
    const match = matchCatalog(rawLabel, input.canonicalCatalog);
    specialties.push(
      match
        ? { rawLabel, canonicalSlug: match.slug, canonicalName: match.name, confidence: 0.5 }
        : {
            rawLabel,
            canonicalSlug: kebab(rawLabel),
            canonicalName: rawLabel,
            confidence: 0.3,
          },
    );
  }

  // Modalities feed searchText. For the same reason as above, substring mentions are not one.
  const modalities: string[] = [];

  // Template never fabricates outcomes — and, for the same reason, never a tagline: `tagline`
  // is only ever carried through from an existing value here, else null.
  // `qualifications: []` for the same reason as `caseStudies: []` — the template path does no
  // extraction, and guessing a credential from keyword matching would put a qualification the
  // practitioner never claimed onto a health-directory profile.
  return normalizeDraft(
    { headline, tagline, whoIHelp, bio, modalities, qualifications: [], specialties, caseStudies: [] },
    input,
  );
}

function matchCatalog(
  rawLabel: string,
  catalog: { slug: string; name: string }[],
): { slug: string; name: string } | null {
  const norm = rawLabel.toLowerCase().trim();
  return (
    catalog.find((c) => c.name.toLowerCase() === norm) ||
    catalog.find((c) => isWordingVariant(rawLabel, c.name)) ||
    null
  );
}

function kebab(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'specialty'
  );
}

// ---------------------------------------------------------------------------
// Shared normalization — defends against partial/odd LLM output
// ---------------------------------------------------------------------------

function normalizeDraft(raw: Partial<ProfileDraft>, input: DraftInput): ProfileDraft {
  const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v.trim() : fallback);
  const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

  const specialties: DraftSpecialty[] = arr<Partial<DraftSpecialty>>(raw.specialties)
    .map((s) => {
      const rawLabel = str(s.rawLabel);
      if (!rawLabel) return null;
      const canonicalName = str(s.canonicalName) || rawLabel;
      const canonicalSlug = str(s.canonicalSlug) || kebab(canonicalName);
      const confidence =
        typeof s.confidence === 'number' && s.confidence >= 0 && s.confidence <= 1
          ? s.confidence
          : 0.5;
      return { rawLabel, canonicalSlug, canonicalName, confidence };
    })
    .filter((s): s is DraftSpecialty => s !== null);

  const caseStudies: DraftCaseStudy[] = arr<Partial<DraftCaseStudy>>(raw.caseStudies)
    .map((c) => {
      const title = str(c.title);
      const summary = str(c.summary);
      if (!title || !summary) return null;
      const outcome = str(c.outcome);
      return outcome ? { title, summary, outcome } : { title, summary };
    })
    .filter((c): c is DraftCaseStudy => c !== null);

  const modalities = Array.from(
    new Set(arr<string>(raw.modalities).map((m) => str(m)).filter(Boolean)),
  );

  const qualifications = Array.from(
    new Set(arr<string>(raw.qualifications).map((q) => str(q).trim()).filter(Boolean)),
  );

  const taglineRaw = str(raw.tagline).trim();

  return {
    headline: str(raw.headline) || `${input.displayName} · Holistic Health Practitioner`,
    // Preserve the model's null. An empty string means "no usable hook" just as much as null
    // does, and persisting '' would render an empty line — normalise both to null.
    tagline: taglineRaw || null,
    whoIHelp: str(raw.whoIHelp),
    bio: str(raw.bio),
    modalities,
    qualifications,
    specialties,
    caseStudies,
  };
}
