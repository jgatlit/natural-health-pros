'use client';

import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { SortableList } from '@/components/practitioners/SortableList';
import { SectionMediaField, type MediaMode } from '@/components/practitioners/SectionMediaField';

export type EditableSection = {
  id: string;
  title: string;
  bodyHtml: string | null;
  mediaMode: MediaMode;
  embedUrl: string;
  mediaUrl: string;
  posterUrl: string;
  caption: string | null;
  published: boolean;
};

type Action = (formData: FormData) => void | Promise<void>;

/**
 * Custom profile sections editor (L1b). Same shape as OfferingsEditor: each section is its own
 * <form> (Save / Remove via formAction), a separate form adds one, and order is persisted by
 * calling `reorderAction` directly on drop. Drag handle plus explicit Move up / Move down buttons
 * so ordering never depends on a pointer.
 */
export function SectionsEditor({
  slug,
  practitionerId,
  sections,
  max,
  maxVideoMb,
  maxImageMb,
  attestationEnabled,
  createAction,
  updateAction,
  deleteAction,
  reorderAction,
}: {
  slug: string;
  practitionerId: string;
  sections: EditableSection[];
  max: number;
  maxVideoMb: number;
  maxImageMb: number;
  attestationEnabled: boolean;
  createAction: Action;
  updateAction: Action;
  deleteAction: Action;
  reorderAction: Action;
}) {
  const [order, setOrder] = useState(sections);
  const [pending, setPending] = useState(0);
  const [failed, setFailed] = useState(false);
  const chain = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    if (pending === 0) setOrder(sections);
  }, [sections, pending]);

  function persist(next: EditableSection[]) {
    setOrder(next);
    setFailed(false);
    const fd = new FormData();
    fd.set('orderJson', JSON.stringify(next.map((s) => s.id)));
    setPending((c) => c + 1);
    chain.current = chain.current
      .catch(() => undefined)
      .then(() => reorderAction(fd))
      .catch((e) => {
        console.error('[sections-reorder-failed]', e);
        setFailed(true);
      })
      .finally(() => setPending((c) => c - 1));
  }

  function move(index: number, delta: -1 | 1) {
    const to = index + delta;
    if (to < 0 || to >= order.length) return;
    const next = order.slice();
    [next[index], next[to]] = [next[to], next[index]];
    persist(next);
  }

  const atCap = sections.length >= max;
  const mediaProps = { slug, practitionerId, maxVideoMb, maxImageMb };
  const input = 'h-9 w-full rounded-md border bg-background px-3 text-sm';
  const saveBtn =
    'inline-flex h-8 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90';
  const smallBtn =
    'inline-flex h-7 w-7 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40';

  // A plain render helper, NOT a component: a component defined here would get a new identity
  // every render and remount (wiping typed text) whenever reorder state changes.
  const fields = (s: EditableSection | null, prefix: string) => {
    return (
      <>
        <div className="space-y-1">
          <label className="text-xs font-medium" htmlFor={`${prefix}-title`}>
            Section name
          </label>
          <input
            id={`${prefix}-title`}
            name="title"
            required
            maxLength={80}
            defaultValue={s?.title ?? ''}
            placeholder="e.g. My approach, A day in the clinic"
            className={input}
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium" htmlFor={`${prefix}-body`}>
            Text (optional)
          </label>
          <textarea
            id={`${prefix}-body`}
            name="bodyHtml"
            rows={5}
            defaultValue={s?.bodyHtml ?? ''}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
          <p className="text-[11px] text-muted-foreground">
            Basic formatting only: paragraphs, headings, bold, italic, lists, quotes and https links.
            Anything else is removed when you save.
          </p>
        </div>
        <SectionMediaField
          {...mediaProps}
          idPrefix={prefix}
          initialMode={s?.mediaMode ?? ''}
          initialEmbedUrl={s?.embedUrl ?? ''}
          initialMediaUrl={s?.mediaUrl ?? ''}
          initialPosterUrl={s?.posterUrl ?? ''}
        />
        <div className="space-y-1">
          <label className="text-xs font-medium" htmlFor={`${prefix}-caption`}>
            Caption (optional)
          </label>
          <input
            id={`${prefix}-caption`}
            name="caption"
            maxLength={200}
            defaultValue={s?.caption ?? ''}
            className={input}
          />
        </div>
        {attestationEnabled && (
          <label className="flex items-start gap-2 text-xs">
            <input type="checkbox" name="attested" className="mt-0.5" />
            <span>
              If this section contains testimonials, I confirm they are genuine and I have
              permission to share them.
            </span>
          </label>
        )}
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" name="published" defaultChecked={s ? s.published : true} />
          Show this section on my public profile
        </label>
      </>
    );
  }

  return (
    <Card id="sections" className="scroll-mt-24 space-y-5 p-6 sm:p-8">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">Custom sections</h2>
        <p className="text-xs text-muted-foreground">
          Add your own sections - your approach, a welcome video, what to expect. They appear on your
          profile below your standard sections, in the order shown here ({sections.length} of {max}{' '}
          used).
        </p>
      </div>

      {order.length > 1 && (
        <p className="text-[11px] text-muted-foreground">
          Drag to reorder, or use the arrows.{pending > 0 && ' Saving...'}
        </p>
      )}
      {failed && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          That reorder didn&apos;t save. Try again.
        </p>
      )}

      {order.length > 0 && (
        <SortableList
          items={order}
          onReorder={persist}
          getItemLabel={(s, i) => `Reorder ${s.title || 'section ' + (i + 1)} - press space, then use the arrow keys`}
        >
          {(s, i, handle) => (
            <div className={`rounded-lg border p-3 ${i < order.length - 1 ? 'mb-3' : ''}`}>
              <div className="mb-2 flex items-center gap-1">
                {order.length > 1 && handle}
                <span className="text-[11px] font-medium text-muted-foreground">Section {i + 1}</span>
                {!s.published && (
                  <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                    Hidden
                  </span>
                )}
                {order.length > 1 && (
                  <span className="ml-auto flex gap-1">
                    <button type="button" className={smallBtn} disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${s.title} up`}>
                      <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                    </button>
                    <button type="button" className={smallBtn} disabled={i === order.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${s.title} down`}>
                      <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </span>
                )}
              </div>
              <form action={updateAction} className="space-y-3">
                <input type="hidden" name="sectionId" value={s.id} />
                {fields(s, s.id)}
                <div className="flex items-center justify-end gap-2">
                  <button
                    formAction={deleteAction}
                    formNoValidate
                    onClick={(e) => {
                      if (!window.confirm('Remove this section? Any uploaded file is deleted too.')) {
                        e.preventDefault();
                      }
                    }}
                    className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    Remove
                  </button>
                  <button type="submit" className={saveBtn}>
                    Save
                  </button>
                </div>
              </form>
            </div>
          )}
        </SortableList>
      )}

      <Separator />

      {atCap ? (
        <p className="text-xs text-muted-foreground">
          You&apos;ve used all {max} sections. Remove one to add another.
        </p>
      ) : (
        <form
          action={createAction}
          // createSection redirects to the same route, so the subtree stays mounted; re-key on the
          // saved set so the add form starts blank instead of re-offering the last entry.
          key={`new-${sections.map((s) => s.id).join(',')}`}
          className="space-y-3"
        >
          <p className="flex items-center gap-1.5 text-xs font-medium">
            <Plus className="h-3.5 w-3.5" aria-hidden />
            Add a section
          </p>
          {fields(null, 'new-section')}
          <div className="flex justify-end">
            <button
              type="submit"
              className="inline-flex h-9 items-center gap-1.5 rounded-md border bg-card px-4 text-xs font-medium transition-colors hover:bg-accent"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              Add section
            </button>
          </div>
        </form>
      )}
    </Card>
  );
}
