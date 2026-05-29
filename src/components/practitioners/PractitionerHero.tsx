import { MapPin, Video, Users } from 'lucide-react';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
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
  /** practitioner's own phrasing (rawLabel) — their voice, shown as chips */
  specialtyLabels: string[];
};

export function PractitionerHero({
  displayName,
  headline,
  photoUrl,
  city,
  telehealth,
  inPerson,
  specialtyLabels,
}: Props) {
  const [primary, ...secondary] = specialtyLabels;

  return (
    <header className="flex flex-col items-center gap-5 text-center sm:flex-row sm:items-start sm:text-left">
      <Avatar size="lg" className="size-28 shrink-0 ring-2 ring-border sm:size-32">
        {photoUrl && <AvatarImage src={photoUrl} alt={displayName} />}
        <AvatarFallback className="text-3xl font-medium">{initials(displayName)}</AvatarFallback>
      </Avatar>

      <div className="flex flex-1 flex-col items-center gap-3 sm:items-start">
        <div className="space-y-1.5">
          <h1 className="text-3xl font-semibold tracking-tight">{displayName}</h1>
          {headline && <p className="text-base text-muted-foreground">{headline}</p>}
        </div>

        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 text-sm text-muted-foreground sm:justify-start">
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

        {primary && (
          <div className="flex flex-wrap items-center justify-center gap-1.5 sm:justify-start">
            <Badge variant="default">{primary}</Badge>
            {secondary.map((label) => (
              <Badge key={label} variant="secondary">
                {label}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </header>
  );
}
