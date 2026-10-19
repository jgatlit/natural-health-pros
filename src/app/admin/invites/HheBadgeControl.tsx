import { Badge } from '@/components/ui/badge';
import { setHheCertified } from './actions';

type Props = {
  invitationId: string;
  displayName: string;
  certified: boolean;
  /** When the badge was last granted or removed through this control; null if never. */
  changedAt: Date | null;
  /** The admin page the action returns to (allowlisted again server-side). */
  returnTo: '/admin/invites' | '/admin/signups';
};

/** The 'HHE Certified' badge state for one practitioner, with its grant/remove toggle. */
export function HheBadgeControl({ invitationId, displayName, certified, changedAt, returnTo }: Props) {
  const name = displayName || 'this practitioner';
  const label = certified ? 'Remove HHE Certified' : 'Mark HHE Certified';
  return (
    <>
      <Badge
        variant={certified ? 'default' : 'outline'}
        className="whitespace-nowrap text-[10px]"
        title={changedAt ? `Badge last changed ${changedAt.toISOString().slice(0, 10)}` : undefined}
      >
        {certified ? 'HHE Certified' : 'Not HHE Certified'}
      </Badge>
      <form action={setHheCertified}>
        <input type="hidden" name="id" value={invitationId} />
        <input type="hidden" name="on" value={certified ? '0' : '1'} />
        <input type="hidden" name="returnTo" value={returnTo} />
        <button
          type="submit"
          aria-label={`${label} for ${name}`}
          className="whitespace-nowrap rounded-md border px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
        >
          {label}
        </button>
      </form>
    </>
  );
}
