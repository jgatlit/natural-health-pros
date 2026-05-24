import Link from 'next/link';
import { MapPin } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';

export type PractitionerHit = {
  id: string;
  slug: string;
  displayName: string;
  bio?: string;
  cityName: string;
  cityState: string;
  specialtyNames: string[];
};

function initials(name: string) {
  return name
    .replace(/^Dr\.\s+/i, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

export function PractitionerHitCard({ hit }: { hit: PractitionerHit }) {
  const primary = hit.specialtyNames[0];
  const secondary = hit.specialtyNames.slice(1, 3);

  return (
    <Link href={`/practitioners/${hit.slug}`} className="group block">
      <Card className="flex h-full gap-4 p-4 transition-colors group-hover:bg-accent/30">
        <Avatar size="lg" className="size-14 shrink-0 ring-1 ring-border">
          <AvatarFallback className="text-base font-medium">
            {initials(hit.displayName)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="space-y-0.5">
            <p className="truncate text-sm font-semibold leading-tight">{hit.displayName}</p>
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <MapPin className="h-3 w-3" aria-hidden />
              {hit.cityName}, {hit.cityState}
            </p>
          </div>
          {primary && (
            <div className="flex flex-wrap gap-1">
              <Badge variant="default" className="text-[10px]">
                {primary}
              </Badge>
              {secondary.map((s) => (
                <Badge key={s} variant="secondary" className="text-[10px]">
                  {s}
                </Badge>
              ))}
            </div>
          )}
          {hit.bio && (
            <p className="line-clamp-2 text-xs leading-snug text-muted-foreground">{hit.bio}</p>
          )}
        </div>
      </Card>
    </Link>
  );
}
