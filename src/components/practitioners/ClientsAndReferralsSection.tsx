import { Link2, UserPlus, Users } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import type { ClientListRow } from '@/lib/client-list';

export type ReferablePractitioner = { slug: string; displayName: string };

type Props = {
  slug: string;
  rows: ClientListRow[];
  referable: ReferablePractitioner[];
  /** Rendered so the practitioner can copy it, right after `createReferralLinkFor` mints one. */
  newReferralLink: string | null;
  /** Pre-rendered copy for the disclosure, so no component formats a percentage a second way. */
  referralRateLabel: string;
  termMonths: number;
  addAction: (formData: FormData) => void | Promise<void>;
  inviteAction: (formData: FormData) => void | Promise<void>;
  referByEmailAction: (formData: FormData) => void | Promise<void>;
  createLinkAction: (formData: FormData) => void | Promise<void>;
  notice: string | null;
};

/**
 * CLIENTS & REFERRALS (spec v1.4 §5.2) — the practitioner's own list, and the referrals they made.
 *
 * Placed between Bookings and the plan choice, following the page's own ordering rule: Bookings
 * leads because someone holding a slot is the most time-sensitive thing here, and this is the same
 * population one step later. Both belong above commercial configuration.
 *
 * 🔒 WHAT THIS SCREEN MAY SHOW, AND WHAT IT MUST NOT. A practitioner sees a client's email address
 * because they serviced, invited/added, were referred, or referred that client (operator ruling,
 * 2026-09-18) — every row here is one of those four. What it never shows is anything about the
 * REFERRED practitioner's side: not whether the client was already theirs, not whether the
 * referral earned anything. §5.2A, and spec §9 test 12 turns on exactly that distinction, so the
 * row type has no field that could say it.
 *
 * ⚠️ WHY A CLIENT ON THIS LIST MATTERS COMMERCIALLY. An entry made BEFORE the client's first
 * booking makes them the practitioner's own — 0% forever, on either plan (R4/R5). The copy says so
 * plainly, because a practitioner who does not know that will not use the feature, and the feature
 * is the only way they can avoid being charged for clients they brought themselves.
 */
export function ClientsAndReferralsSection({
  rows,
  referable,
  newReferralLink,
  referralRateLabel,
  termMonths,
  addAction,
  inviteAction,
  referByEmailAction,
  createLinkAction,
  notice,
}: Props) {
  return (
    <Card id="clients" className="space-y-5 p-6 scroll-mt-24">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-primary" aria-hidden />
          <h2 className="text-sm font-semibold">Clients &amp; referrals</h2>
        </div>
        <p className="text-xs text-muted-foreground">
          Add the clients you already have. Anyone on this list <strong>before</strong> their first
          booking is yours — we take nothing on their sessions, on either plan, for as long as they
          keep booking.
        </p>
      </div>

      {notice && (
        <p className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs">
          {notice}
        </p>
      )}

      <Separator />

      {/* B — Invite or Add Client(s) (§5.2B).
          The form's own `action` is Add, and Send invite overrides it with `formAction`. Two
          submit buttons on one form is the HTML-native way to express "same data, two verbs", and
          it keeps the textarea a single source rather than duplicating it into two forms. */}
      <form action={addAction} className="space-y-2">
        <label htmlFor="clients" className="text-xs font-medium">
          Add clients
        </label>
        <textarea
          id="clients"
          name="clients"
          rows={3}
          placeholder={'dana@example.com\nSam Ellis <sam@example.com>'}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
        />
        <p className="text-xs text-muted-foreground">
          One per line, up to 50 at a time. <strong>Add</strong> just records them.{' '}
          <strong>Send invite</strong> also emails them your own booking link.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            className="inline-flex h-9 items-center rounded-md border bg-card px-3 text-sm font-medium hover:bg-accent"
          >
            <UserPlus className="mr-1.5 h-3.5 w-3.5" aria-hidden />
            Add
          </button>
          <button
            type="submit"
            formAction={inviteAction}
            className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Send invite
          </button>
        </div>
      </form>

      <Separator />

      {/* C — Refer a practitioner (§5.2C) */}
      <div className="space-y-3">
        <div className="space-y-1">
          <h3 className="text-xs font-semibold">Refer a client to another practitioner</h3>
          <p className="text-xs text-muted-foreground">
            Earn {referralRateLabel} of what they book with that practitioner for {termMonths}{' '}
            months.
          </p>
        </div>

        {referable.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            There is nobody else to refer to yet.
          </p>
        ) : (
          <>
            <form action={referByEmailAction} className="grid gap-2 sm:grid-cols-2">
              <select
                name="referredSlug"
                required
                aria-label="Practitioner to refer to"
                className="h-9 rounded-md border bg-background px-2 text-sm"
              >
                <option value="">Choose a practitioner…</option>
                {referable.map((p) => (
                  <option key={p.slug} value={p.slug}>
                    {p.displayName}
                  </option>
                ))}
              </select>
              <input
                name="clientEmail"
                type="email"
                required
                placeholder="Client’s email"
                className="h-9 rounded-md border bg-background px-3 text-sm"
              />
              <input
                name="clientName"
                placeholder="Client’s name (optional)"
                className="h-9 rounded-md border bg-background px-3 text-sm"
              />
              <input
                name="note"
                maxLength={500}
                placeholder="A short note for them (optional)"
                className="h-9 rounded-md border bg-background px-3 text-sm"
              />
              <button
                type="submit"
                className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 sm:col-span-2"
              >
                Send referral
              </button>
            </form>

            <form action={createLinkAction} className="flex flex-wrap items-center gap-2">
              <select
                name="referredSlug"
                required
                aria-label="Practitioner to create a referral link for"
                className="h-9 rounded-md border bg-background px-2 text-sm"
              >
                <option value="">Choose a practitioner…</option>
                {referable.map((p) => (
                  <option key={p.slug} value={p.slug}>
                    {p.displayName}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                className="inline-flex h-9 items-center rounded-md border bg-card px-3 text-sm font-medium hover:bg-accent"
              >
                <Link2 className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                Create a referral link
              </button>
            </form>
          </>
        )}

        {newReferralLink && (
          <div className="space-y-1 rounded-md border bg-muted/40 p-3">
            <p className="text-xs font-medium">Your referral link — send it however you like</p>
            {/* Read-only rather than a copy button: this is a server component, and a link the
                practitioner can select is worth more than a button that needs client JS. */}
            <input
              readOnly
              value={newReferralLink}
              className="w-full rounded border bg-background px-2 py-1 font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Valid for {termMonths} months. Anyone who opens it and books counts as your referral.
            </p>
          </div>
        )}

        {/* REQUIRED DISCLOSURE (spec §8.1). Stated on the screen where referrals are MADE, because
            a practitioner referring someone should know what it costs the practitioner receiving
            them — it is the same arrangement seen from the other side. */}
        <p className="text-xs text-muted-foreground">
          When another practitioner refers a client to you, {referralRateLabel} of those sessions
          goes to them and {referralRateLabel} to Natural Health Pros, for {termMonths} months, on
          either plan.
        </p>
      </div>

      <Separator />

      {/* A — the list itself (§5.2A) */}
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No clients yet. Add the ones you already see — it is what keeps their sessions at 0%.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li
              key={row.email}
              className="flex flex-wrap items-baseline justify-between gap-2 rounded-md border p-3"
            >
              <div className="min-w-0 space-y-0.5">
                <p className="truncate text-sm font-medium">{row.name || row.email}</p>
                {row.name && (
                  <p className="truncate text-xs text-muted-foreground">{row.email}</p>
                )}
                {row.referrals.map((r, i) => (
                  <p key={`${r.referredSlug}-${i}`} className="text-xs text-muted-foreground">
                    Referred to {r.referredName} · {referralStatusLabel(r.status)}
                  </p>
                ))}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Badge variant={row.status === 'BOOKED' ? 'default' : 'secondary'}>
                  {statusLabel(row.status)}
                </Badge>
                {/* Shown only once they have booked. Before that there is no decision, and
                    rendering one would claim a commercial state that does not exist. */}
                {row.sourcedBy === 'PRACTITIONER' && <Badge variant="outline">Your client · 0%</Badge>}
                {row.sourcedBy === 'NHP' && row.termEndsAt && (
                  <Badge variant="outline">
                    Ours until {row.termEndsAt.toISOString().slice(0, 10)}
                  </Badge>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function statusLabel(status: ClientListRow['status']): string {
  if (status === 'BOOKED') return 'Booked';
  if (status === 'INVITED') return 'Invited';
  return 'Added';
}

/**
 * The referral's outcome, in the only four words X is entitled to.
 *
 * "Not booked yet" covers both "they have not got round to it" and "they were already that
 * practitioner's client, so nothing was earned" — and must, because telling those apart would
 * disclose the other practitioner's relationship with this person (§5.2A, §9 test 12).
 */
function referralStatusLabel(status: string): string {
  if (status === 'BOOKED') return 'booked';
  if (status === 'EXPIRED') return 'expired';
  return 'not booked yet';
}
