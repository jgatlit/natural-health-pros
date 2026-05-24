type Props = { bio: string | null };

export function PractitionerBio({ bio }: Props) {
  if (!bio) return null;
  return (
    <section aria-label="About" className="space-y-2">
      <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        About
      </h2>
      <p className="text-sm leading-relaxed text-foreground">{bio}</p>
    </section>
  );
}
