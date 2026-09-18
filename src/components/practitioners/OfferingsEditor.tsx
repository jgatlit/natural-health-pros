'use client';

import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Plus, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { SortableList } from '@/components/practitioners/SortableList';
import { PendingButton } from '@/components/practitioners/PendingButton';
import { OfferingFields, type BookingLinkOption } from '@/components/practitioners/OfferingFields';
import { Separator } from '@/components/ui/separator';

type Offering = {
  id: string;
  title: string;
  description: string | null;
  priceUsdCents: number;
  interval: 'ONE_TIME' | 'MONTHLY' | 'ANNUAL';
  category: string | null;
  duration: number | null;
  isConsult: boolean;
  acceptsPayments: boolean;
  bookingLinkId: string | null;
  listingVisibility: 'LISTED' | 'LINK_ONLY';
  /** Carried for §17.3c, which will address embedded checkout by plan id (D11). NOTE: the
   *  published flag today is still `purchaseUrl` — PublishRow keys off it — so do not read this
   *  as "the published flag" until that step actually switches over. */
  whopPlanId: string | null;
  purchaseUrl: string | null;
};

type Action = (formData: FormData) => void | Promise<void>;

/**
 * Practitioner offerings editor (Phase 2 + Layer Y publish). Offerings are stored locally
 * (WhopProduct); publishOffering()/unpublishOffering() mint or clear the live Whop checkout.
 * Each row is one <form> whose Save button posts to updateAction; Remove, Publish, and
 * Unpublish all override via formAction the same way (so there are no nested forms — a
 * <form> inside a <form> is invalid HTML and browsers hoist the inner one's fields out of
 * it, breaking the row). A separate add form appends a new offering.
 *
 * Order is drag-to-sort (operator finding 2026-08-25: the old up/down-arrows-plus-explicit-save
 * control was confusing in the actual GUI). Offerings are the one sortable list that can't ride
 * along in a shared form the way specialties/booking links do — each row is its OWN <form> behind
 * per-offering create/update/delete/publish actions — so the drag handle calls `reorderAction`
 * (`reorderOfferings`) DIRECTLY on drop, never wrapping the offering forms in a shared container.
 * Reordering is a pure array-position change keyed on `o.id`, so React reuses each row's existing
 * DOM subtree in its new slot rather than remounting it — an in-progress, unsaved edit sitting in
 * a sibling offering's own uncontrolled fields is never touched by dragging a different row.
 */
export function OfferingsEditor({
  offerings,
  payoutsEnabled,
  whopConnected,
  bookingLinks,
  createAction,
  updateAction,
  deleteAction,
  publishAction,
  unpublishAction,
  reorderAction,
}: {
  offerings: Offering[];
  payoutsEnabled: boolean;
  /** Whop account exists. Gates whether "Accept payments" is EDITABLE (§9). */
  whopConnected: boolean;
  bookingLinks: BookingLinkOption[];
  createAction: Action;
  updateAction: Action;
  deleteAction: Action;
  publishAction: Action;
  unpublishAction: Action;
  reorderAction: Action;
}) {
  const [order, setOrder] = useState(offerings);
  const [pendingCount, setPendingCount] = useState(0);
  const [saveFailed, setSaveFailed] = useState(false);
  // Each reorder chains onto the previous one's settlement rather than firing independently.
  // Two calls fired concurrently give Postgres no guarantee the transaction that STARTED second
  // also COMMITS second — a slower first request completing after a faster second one would win,
  // silently reverting the practitioner's actual last move. Chaining serializes them in the order
  // they were issued instead.
  const reorderChain = useRef<Promise<unknown>>(Promise.resolve());

  // Server state wins after any revalidate (delete/create/publish all trigger one) — otherwise a
  // change made elsewhere on the page leaves this list holding a stale row, or missing a new one.
  // Skipped while a reorder is in flight: that OTHER action's revalidate can land mid-drag with a
  // pre-drag `offerings` snapshot (it read the DB before this reorder's transaction committed),
  // which would otherwise snap the visible order back to before the drag with no error shown.
  useEffect(() => {
    if (pendingCount === 0) setOrder(offerings);
  }, [offerings, pendingCount]);

  function handleReorder(next: Offering[]) {
    setOrder(next);
    setSaveFailed(false);
    const formData = new FormData();
    formData.set('orderJson', JSON.stringify(next.map((o) => o.id)));
    setPendingCount((c) => c + 1);
    // Fire-and-persist: there is no separate "save order" step for this list, matching how the
    // old up/down control auto-saved on click. The local `order` state above is what the
    // practitioner sees immediately; reorderAction's own revalidatePath is what makes it durable.
    // A prior failure must not block this attempt from starting — only from being silent.
    reorderChain.current = reorderChain.current
      .catch(() => undefined)
      .then(() => reorderAction(formData))
      .catch((e) => {
        console.error('[offerings-reorder-failed]', e);
        setSaveFailed(true);
      })
      .finally(() => setPendingCount((c) => c - 1));
  }

  const hasMultiple = order.length > 1;

  return (
    <Card id="offerings" className="scroll-mt-8 space-y-5 p-6 sm:p-8">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">Offerings</h2>
        <p className="text-xs text-muted-foreground">
          Consultations, sessions, packages, products, subscriptions — name them and set your own
          prices. They show on your profile now; set up payments on any offering to turn on online
          checkout, or leave it as-is and clients still reach you via your booking link.
        </p>
      </div>

      {hasMultiple && (
        <p className="text-[11px] text-muted-foreground">
          Drag to reorder — this is the order shown on your profile, first to last.
          {pendingCount > 0 && ' Saving…'}
        </p>
      )}

      {saveFailed && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          That reorder didn&apos;t save. Try dragging again.
        </p>
      )}

      {order.length > 0 && (
        // SortableList renders its own wrapping element around the rows (for dnd-kit's
        // DndContext/SortableContext), so a `space-y-*` class placed on ITS parent — as this used
        // to be — has exactly one direct child to apply between and does nothing. Spacing lives on
        // each row itself instead (mb-3 on all but the last), the same way BookingLinksField's rows
        // carry their own `pb-2` rather than relying on a non-adjacent ancestor's `space-y`.
        <SortableList
          items={order}
          onReorder={handleReorder}
          getItemLabel={(o, i) => `Reorder ${o.title || 'offering ' + (i + 1)} — press space, then use the arrow keys`}
        >
          {(o, i, handle) => (
            <div className={`rounded-lg border p-3 ${i < order.length - 1 ? 'mb-3' : ''}`}>
              {hasMultiple && (
                <div className="mb-2 flex items-center gap-1">
                  {handle}
                  <span className="text-[11px] font-medium text-muted-foreground">
                    Offering {i + 1}
                  </span>
                </div>
              )}
              <form action={updateAction} className="space-y-3">
                <input type="hidden" name="offeringId" value={o.id} />
                <OfferingFields
                  offering={o}
                  idPrefix={o.id}
                  bookingLinks={bookingLinks}
                  whopConnected={whopConnected}
                />
                <PublishRow
                  offering={o}
                  payoutsEnabled={payoutsEnabled}
                  publishAction={publishAction}
                  unpublishAction={unpublishAction}
                />
                <div className="flex items-center justify-end gap-2">
                  <button
                    formAction={deleteAction}
                    formNoValidate
                    className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    Remove
                  </button>
                  <button
                    type="submit"
                    className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                  >
                    Save
                  </button>
                </div>
              </form>
            </div>
          )}
        </SortableList>
      )}

      <Separator />

      <form action={createAction} className="space-y-3">
        <p className="flex items-center gap-1.5 text-xs font-medium">
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Add an offering
        </p>
        <OfferingFields
          // createOffering redirects to the SAME route, so React keeps this subtree mounted and
          // the lazy useState initialisers never re-run — the add form would still show the last
          // offering's free-consult / link / visibility choices, and one more click would create
          // a duplicate carrying settings nobody picked for it. Re-keying on the saved set forces
          // a fresh mount. Recorded in project memory as having bitten this repo twice.
          key={`new-${offerings.map((o) => o.id).join(',')}`}
          offering={null}
          idPrefix="new"
          bookingLinks={bookingLinks}
          whopConnected={whopConnected}
        />
        <div className="flex justify-end">
          <button
            type="submit"
            className="inline-flex h-9 items-center gap-1.5 rounded-md border bg-card px-4 text-xs font-medium transition-colors hover:bg-accent"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            Add offering
          </button>
        </div>
      </form>
    </Card>
  );
}

/**
 * Publish/unpublish control for one offering row. Plain markup, NOT its own <form> — it
 * lives inside the row's single <form action={updateAction}>, and its buttons reach
 * publishAction/unpublishAction via formAction exactly the way Remove reaches deleteAction.
 */
function PublishRow({
  offering,
  payoutsEnabled,
  publishAction,
  unpublishAction,
}: {
  offering: Offering;
  payoutsEnabled: boolean;
  publishAction: Action;
  unpublishAction: Action;
}) {
  if (offering.purchaseUrl) {
    return (
      <div className="flex items-center justify-between gap-3 border-t pt-3">
        <Badge variant="secondary" className="gap-1 text-[10px] uppercase tracking-wider">
          <CheckCircle2 className="h-3 w-3" aria-hidden />
          Live — patients can buy this
        </Badge>
        <PendingButton
          intent="unpublish"
          formAction={unpublishAction}
          formNoValidate
          pendingLabel="Unpublishing…"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"
        >
          Unpublish
        </PendingButton>
      </div>
    );
  }

  if (payoutsEnabled) {
    return (
      <div className="flex items-center justify-between gap-3 border-t pt-3">
        {/* §22-B: "Publish" read as jargon and, worse, as a SEPARATE step from "Accept
            payments" above — a practitioner could tick that checkbox, hit Save, and still have
            nothing purchasable, because this is the button that actually calls Whop. Renamed to
            say what it does; it also now turns Accept payments on by itself (actions.ts). */}
        <p className="text-xs text-muted-foreground">Not set up yet — only you can see this.</p>
        <PendingButton
          intent="publish"
          formAction={publishAction}
          formNoValidate
          pendingLabel="Setting up…"
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60"
        >
          Set up payments
        </PendingButton>
      </div>
    );
  }

  // An offering without online checkout is a legitimate state, not an error — keep this
  // matter-of-fact rather than a dead disabled button with no explanation.
  return (
    <p className="border-t pt-3 text-xs text-muted-foreground">
      Set up payouts to sell this online — see{' '}
      <a href="#payments" className="font-medium underline underline-offset-2 hover:text-foreground">
        Client payments
      </a>{' '}
      below. Bookings still work via your booking link either way.
    </p>
  );
}

