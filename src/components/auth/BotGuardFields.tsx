import { BOT_GUARD_FIELDS } from '@/lib/bot-guard-fields';
import { TurnstileWidget } from './TurnstileWidget';

type Props = {
  /** From `issueFormStamp()`, issued while rendering the page that holds the form. */
  stamp: string;
  /** From `turnstileSiteKey()`; null renders no widget. */
  turnstileSiteKey: string | null;
};

/** Place inside the `<form>`; `checkBotGuard` in the action reads these fields. */
export function BotGuardFields({ stamp, turnstileSiteKey }: Props) {
  return (
    <>
      <div
        aria-hidden="true"
        style={{ position: 'absolute', left: '-10000px', top: 'auto', width: 1, height: 1, overflow: 'hidden' }}
      >
        <label>
          Leave this field empty
          <input type="text" name={BOT_GUARD_FIELDS.honeypot} tabIndex={-1} autoComplete="off" defaultValue="" />
        </label>
      </div>
      <input type="hidden" name={BOT_GUARD_FIELDS.stamp} value={stamp} />
      {turnstileSiteKey && <TurnstileWidget siteKey={turnstileSiteKey} />}
    </>
  );
}
