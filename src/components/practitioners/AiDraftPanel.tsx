'use client';

import { useState } from 'react';
import { useFormStatus } from 'react-dom';
import { Sparkles, ChevronDown } from 'lucide-react';

type Props = {
  /** Bound server action: generateDraftAction.bind(null, slug). */
  action: (formData: FormData) => void;
  /** Whether a live LLM key is configured (affects the helper copy). */
  llmConfigured: boolean;
};

/**
 * AI onboarding DRAFT step (Task B). The practitioner pastes a free-text
 * description of their practice; on submit the server drafts headline, bio,
 * "who I help", modalities, and dual-label specialties, persists them, and
 * reloads the edit form pre-filled for review/override. Collapsible so it
 * stays out of the way once a profile exists.
 */
export function AiDraftPanel({ action, llmConfigured }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
        aria-expanded={open}
      >
        <Sparkles className="h-4 w-4 text-primary" aria-hidden />
        <span className="flex-1 text-sm font-semibold">Draft my profile with AI</span>
        <ChevronDown
          className={`h-4 w-4 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>

      {open && (
        <form action={action} className="space-y-3 border-t border-primary/20 px-4 py-4">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Tell us about your practice in your own words — who you help, what you do, your
            background, any signature results. We&apos;ll draft your headline, bio, &ldquo;who I
            help&rdquo;, and specialties for you to review and edit below.
            {!llmConfigured && (
              <>
                {' '}
                <span className="italic">
                  (AI drafting isn&apos;t configured yet — you&apos;ll get a structured starting
                  template to edit.)
                </span>
              </>
            )}
          </p>
          <textarea
            name="draftSource"
            rows={6}
            placeholder="e.g. I'm a functional nutrition practitioner who helps women in perimenopause rebalance hormones and energy through food, labs, and gut-healing protocols. I trained at… and have worked with clients on bloating, fatigue, and thyroid issues."
            className="w-full rounded-md border bg-card px-3 py-2 text-sm outline-none ring-ring/30 focus-visible:ring-2"
          />
          <DraftSubmitButton />
        </form>
      )}
    </div>
  );
}

function DraftSubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-4 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
    >
      <Sparkles className="h-3.5 w-3.5" aria-hidden />
      {pending ? 'Drafting…' : 'Generate draft'}
    </button>
  );
}
