import { Plus, Trash2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';

type Offering = {
  id: string;
  title: string;
  description: string | null;
  priceUsdCents: number;
  interval: 'ONE_TIME' | 'MONTHLY' | 'ANNUAL';
  category: string | null;
};

type Action = (formData: FormData) => void | Promise<void>;

const CATEGORY_SUGGESTIONS = [
  'Consultation',
  'Session',
  'Package',
  'Program',
  'Product',
  'Treatment',
  'Subscription',
];

const dollars = (cents: number) => (cents > 0 ? (cents / 100).toString() : '');

/**
 * Practitioner offerings editor (Phase 2). Offerings are stored locally (WhopProduct);
 * online checkout is wired in Layer Y. Each row is one <form> whose Save button posts to
 * updateAction and whose Remove button overrides via formAction=deleteAction (so there are
 * no nested forms). A separate add form appends a new offering.
 */
export function OfferingsEditor({
  offerings,
  createAction,
  updateAction,
  deleteAction,
}: {
  offerings: Offering[];
  createAction: Action;
  updateAction: Action;
  deleteAction: Action;
}) {
  return (
    <Card id="offerings" className="scroll-mt-8 space-y-5 p-6 sm:p-8">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">Offerings</h2>
        <p className="text-xs text-muted-foreground">
          Consultations, sessions, packages, products, subscriptions — name them and set your own
          prices. They show on your profile now; online checkout turns on once your Whop payments
          account is connected. Until then, clients reach you via your booking link.
        </p>
      </div>

      {offerings.length > 0 && (
        <ul className="space-y-3">
          {offerings.map((o) => (
            <li key={o.id} className="rounded-lg border p-3">
              <form action={updateAction} className="space-y-3">
                <input type="hidden" name="offeringId" value={o.id} />
                <OfferingFields offering={o} idPrefix={o.id} />
                <div className="flex items-center justify-end gap-2">
                  <button
                    formAction={deleteAction}
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
            </li>
          ))}
        </ul>
      )}

      <Separator />

      <form action={createAction} className="space-y-3">
        <p className="flex items-center gap-1.5 text-xs font-medium">
          <Plus className="h-3.5 w-3.5" aria-hidden />
          Add an offering
        </p>
        <OfferingFields offering={null} idPrefix="new" />
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

function OfferingFields({ offering, idPrefix }: { offering: Offering | null; idPrefix: string }) {
  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-[1fr_9rem]">
        <input
          type="text"
          name="title"
          required
          defaultValue={offering?.title ?? ''}
          placeholder="e.g. 60-min initial consultation"
          className="h-9 w-full rounded-md border bg-card px-3 text-sm outline-none ring-ring/30 focus-visible:ring-2"
        />
        <div className="flex items-center gap-1.5 rounded-md border bg-card px-2">
          <span className="text-sm text-muted-foreground">$</span>
          <input
            type="text"
            inputMode="decimal"
            name="price"
            defaultValue={offering ? dollars(offering.priceUsdCents) : ''}
            placeholder="150"
            className="h-9 w-full bg-transparent text-sm outline-none"
          />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <select
          name="interval"
          defaultValue={offering?.interval === 'MONTHLY' ? 'MONTHLY' : 'ONE_TIME'}
          className="h-9 w-full rounded-md border bg-card px-2 text-sm outline-none ring-ring/30 focus-visible:ring-2"
        >
          <option value="ONE_TIME">One-time (flat fee)</option>
          <option value="MONTHLY">Monthly (subscription)</option>
        </select>
        <input
          type="text"
          name="category"
          list={`offering-cats-${idPrefix}`}
          defaultValue={offering?.category ?? ''}
          placeholder="Type (e.g. Consultation)"
          className="h-9 w-full rounded-md border bg-card px-3 text-sm outline-none ring-ring/30 focus-visible:ring-2"
        />
        <datalist id={`offering-cats-${idPrefix}`}>
          {CATEGORY_SUGGESTIONS.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </div>
      <textarea
        name="description"
        rows={2}
        defaultValue={offering?.description ?? ''}
        placeholder="Optional — what's included."
        className="w-full rounded-md border bg-card px-3 py-2 text-sm outline-none ring-ring/30 focus-visible:ring-2"
      />
    </div>
  );
}
