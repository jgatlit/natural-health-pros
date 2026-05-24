import { MapPin } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';

type Specialty = { id: string; name: string };

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
  city: { name: string; state: string } | null;
  specialties: Specialty[];
};

export function PractitionerHeader({ displayName, city, specialties }: Props) {
  const primary = specialties[0];
  const secondary = specialties.slice(1);

  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <Avatar size="lg" className="size-24 ring-2 ring-border">
        <AvatarFallback className="text-2xl font-medium">
          {initials(displayName)}
        </AvatarFallback>
      </Avatar>

      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{displayName}</h1>
        {city && (
          <p className="flex items-center justify-center gap-1.5 text-sm text-muted-foreground">
            <MapPin className="h-3.5 w-3.5" aria-hidden />
            {city.name}, {city.state}
          </p>
        )}
      </div>

      {primary && (
        <div className="flex flex-wrap items-center justify-center gap-1.5">
          <Badge variant="default">{primary.name}</Badge>
          {secondary.map((s) => (
            <Badge key={s.id} variant="secondary">
              {s.name}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
