import { MapPin, Video, Users, BadgeCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

function initials(name: string) {
  return name
    .replace(/^Dr\.\s+/i, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

type Props = {
  displayName: string;
  headline: string | null;
  photoUrl: string | null;
  city: { name: string; state: string } | null;
  telehealth: boolean | null;
  inPerson: boolean | null;
  /** Years in practice — surfaced as a small line under the headline when present. */
  yearsInPractice?: number | null;
  /** Curated canonical specialty names — the clean tag set shown in the identity rail. */
  chips: string[];
  hheCertified?: boolean;
};

/**
 * Variation B identity rail (client go-forward 2026-05-29). Vertical block: avatar →
 * optional HHE-certified badge → name → headline → meta → canonical chips. Lives in the
 * sticky left rail beside PractitionerCTAs; stacks first on mobile.
 */
export function PractitionerHero({
  displayName,
  headline,
  photoUrl,
  city,
  telehealth,
  inPerson,
  yearsInPractice,
  chips,
  hheCertified,
}: Props) {
  return (
    <header className="space-y-5">
      <div className="aspect-[4/5] w-full overflow-hidden rounded-2xl bg-muted shadow-md ring-1 ring-border">
        {photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photoUrl} alt={displayName} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-6xl font-medium text-muted-foreground">
            {initials(displayName)}
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        {hheCertified && (
          <Badge variant="secondary" className="gap-1">
            <BadgeCheck className="h-3.5 w-3.5" aria-hidden />
            HHE Certified
          </Badge>
        )}
        <h1 className="font-serif text-3xl font-semibold tracking-tight">{displayName}</h1>
        {headline && <p className="text-sm text-muted-foreground">{headline}</p>}
        {yearsInPractice != null && yearsInPractice > 0 && (
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {yearsInPractice} {yearsInPractice === 1 ? 'year' : 'years'} in practice
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted-foreground">
        {city && (
          <span className="flex items-center gap-1.5">
            <MapPin className="h-3.5 w-3.5" aria-hidden />
            {city.name}
            {city.name !== 'Virtual Practice' && `, ${city.state}`}
          </span>
        )}
        {telehealth && (
          <span className="flex items-center gap-1.5">
            <Video className="h-3.5 w-3.5" aria-hidden />
            Virtual sessions
          </span>
        )}
        {inPerson && (
          <span className="flex items-center gap-1.5">
            <Users className="h-3.5 w-3.5" aria-hidden />
            In person
          </span>
        )}
      </div>

      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <Badge key={c} variant="default">
              {c}
            </Badge>
          ))}
        </div>
      )}
    </header>
  );
}
