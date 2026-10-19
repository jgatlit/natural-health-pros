/** Form field names shared by the bot-guard server check and its form fields. No server imports. */
export const BOT_GUARD_FIELDS = {
  /** Hidden from people; anything typed here is a bot. Not `website`: a later form has a real one. */
  honeypot: 'nhp_extra_info',
  stamp: 'nhp_form_stamp',
  /** Written by the Turnstile widget itself. */
  turnstile: 'cf-turnstile-response',
} as const;
