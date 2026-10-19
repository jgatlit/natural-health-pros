import { Eye, EyeOff, Archive, ArchiveRestore } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { setDelisted, setArchived } from './actions';
import { ConfirmActionButton } from './ConfirmActionButton';

type Props = {
  invitationId: string;
  displayName: string;
  delisted: boolean;
  archived: boolean;
  /** The admin page the action returns to (allowlisted again server-side). */
  returnTo: '/admin/invites' | '/admin/signups';
};

/**
 * Directory controls for one practitioner, shared by /admin/invites and /admin/signups.
 *
 * Delist and archive are deliberately separate controls rather than one three-state widget:
 * delisting hides a WORKING practice from search while her own booking link keeps taking clients,
 * and archiving closes the practice. Collapsing them would make the safe action and the
 * destructive one adjacent positions of the same switch.
 */
export function DirectoryControls({ invitationId, displayName, delisted, archived, returnTo }: Props) {
  const name = displayName || 'this practitioner';
  if (archived) {
    return (
      <>
        <Badge variant="outline" className="whitespace-nowrap text-[10px]">
          Archived
        </Badge>
        <form action={setArchived}>
          <input type="hidden" name="id" value={invitationId} />
          <input type="hidden" name="on" value="0" />
          <input type="hidden" name="returnTo" value={returnTo} />
          <button
            type="submit"
            aria-label={`Restore ${name}'s profile`}
            title="Restore — returns to the directory and to booking"
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
          >
            <ArchiveRestore className="h-3.5 w-3.5" />
          </button>
        </form>
      </>
    );
  }
  return (
    <>
      <Badge variant={delisted ? 'outline' : 'secondary'} className="whitespace-nowrap text-[10px]">
        {delisted ? 'Hidden' : 'Listed'}
      </Badge>
      <form action={setDelisted}>
        <input type="hidden" name="id" value={invitationId} />
        <input type="hidden" name="on" value={delisted ? '0' : '1'} />
        <input type="hidden" name="returnTo" value={returnTo} />
        <button
          type="submit"
          aria-label={
            delisted ? `List ${name} in the directory again` : `Hide ${name} from the directory`
          }
          title={
            delisted
              ? 'Show in directory again'
              : 'Hide from directory — profile URL and booking keep working'
          }
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
        >
          {delisted ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
        </button>
      </form>
      <ConfirmActionButton
        action={setArchived}
        fields={{ id: invitationId, on: '1', returnTo }}
        icon={<Archive className="h-3.5 w-3.5" />}
        idleLabel={`Archive ${name}'s profile`}
        idleTitle="Archive — removes from directory and stops booking. Reversible."
        confirmText="Archive"
        confirmLabel={`Confirm archiving ${name}'s profile`}
      />
    </>
  );
}
