/**
 * The admin's optional pricing note (`pricing_note`). When it is set, every plan surface marks its
 * plans with an asterisk and prints the note beneath; when it is empty, both render nothing.
 */
export function NoteMark({ note }: { note: string | null | undefined }) {
  if (!note) return null;
  return (
    <sup aria-hidden className="ml-0.5" data-testid="pricing-note-mark">
      *
    </sup>
  );
}

export function PricingNoteLine({ note }: { note: string | null | undefined }) {
  if (!note) return null;
  return (
    <p className="text-[11px] text-muted-foreground" data-testid="pricing-note">
      * {note}
    </p>
  );
}
