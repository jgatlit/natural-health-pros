import { Card } from '@/components/ui/card';
import { AtSign, AlertTriangle } from 'lucide-react';

type Props = {
  /** The PROFILE OWNER's address — never the viewer's. An admin editing someone else must see theirs. */
  email: string;
  /** True when the viewer is an admin editing a profile that is not their own. */
  editingSomeoneElse: boolean;
  action: (formData: FormData) => void | Promise<void>;
  error?: 'bad-email' | 'email-taken' | 'email-send-failed' | null;
  /** Set once, right after the OLD flow's immediate write. Superseded by `pending` below —
   *  requesting a change no longer completes on this page at all. Kept for the (unlikely)
   *  case of a stale bookmarked `?saved=email` URL from before this change shipped. */
  saved?: boolean;
  /** A confirmation email was just sent — the request succeeded, but nothing has changed yet. */
  pending?: boolean;
  /** The address a not-yet-confirmed request is waiting on, if one exists (even on a page load
   *  that didn't just create it — e.g. the practitioner left and came back). Null when there is
   *  no outstanding request. */
  pendingEmail: string | null;
};

/**
 * Change the address that signs you in.
 *
 * Rendered with the OWNER's email, not `session.user.email`. Those differ whenever an admin is
 * editing another practitioner's profile, and showing the viewer's own address on a form that
 * writes the owner's record is how an operator changes their own login by accident — the same
 * viewer-vs-owner conflation that once told Amy every pilot she inspected was billing-exempt.
 *
 * Verify-before-switch: submitting this form does not change `email` above — it sends a
 * confirmation link to the address entered, and only a click on that link (from
 * /auth/confirm-email-change) moves the sign-in identity. The warning below says so, because a
 * warning that only frightens is worse than one that tells you what actually happens.
 */
export function AccountEmailSection({
  email,
  editingSomeoneElse,
  action,
  error,
  saved,
  pending,
  pendingEmail,
}: Props) {
  return (
    <Card id="account" className="scroll-mt-24 space-y-3 p-5">
      <div className="flex items-center gap-2">
        <AtSign className="h-4 w-4 text-muted-foreground" aria-hidden />
        <h2 className="text-sm font-semibold">Account email</h2>
      </div>

      <p className="text-xs text-muted-foreground">
        {editingSomeoneElse
          ? 'This is the address this practitioner signs in with. Changing it changes who can access this profile.'
          : 'This is the address you sign in with. We email your sign-in link and your booking notifications here.'}
      </p>

      {saved && (
        <p className="rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-xs">
          Email updated. Your next sign-in link will go to the new address.
        </p>
      )}

      {pending && (
        <p className="rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-xs">
          Check <strong>{pendingEmail}</strong> for a confirmation link. Nothing changes here until
          it&apos;s clicked — this address keeps working until then.
        </p>
      )}

      {!pending && pendingEmail && (
        <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          A change to <strong>{pendingEmail}</strong> is waiting on a confirmation click. Submitting
          below replaces that pending request instead of adding another one.
        </p>
      )}

      {error && (
        <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden />
          <span>
            {error === 'email-taken'
              ? 'That address already belongs to another account, so nothing was changed.'
              : error === 'email-send-failed'
                ? "We couldn't send the confirmation email — nothing was changed. Try again in a moment."
                : 'That is not a usable email address, so nothing was changed.'}
          </span>
        </p>
      )}

      <form action={action} className="flex flex-col gap-2 sm:flex-row">
        <input
          type="email"
          name="email"
          defaultValue={pendingEmail ?? email}
          required
          aria-label="New account email address"
          className="h-10 flex-1 rounded-md border bg-card px-3 text-sm outline-none ring-ring/30 focus-visible:ring-2"
        />
        <button
          type="submit"
          className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Send confirmation link
        </button>
      </form>

      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>
          The address above only takes effect once you click the confirmation link sent to it —
          your current sign-in address keeps working in the meantime, so a typo here costs nothing
          more than requesting again with the right one.
        </span>
      </p>
    </Card>
  );
}
