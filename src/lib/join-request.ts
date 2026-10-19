import { escapeHtml, normalizeEmail, sendEmail } from '@/lib/email';
import { SITE_URL } from '@/lib/site';

export const JOIN_REQUEST_LIMITS = {
  name: 120,
  credential: 300,
  website: 300,
  note: 1000,
} as const;

export type JoinRequestInput = {
  name: string;
  email: string;
  credential: string;
  website: string | null;
  note: string | null;
};

function field(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim();
}

/** Trimmed and bounded, or null when a required field is missing or any field is too long. */
export function parseJoinRequest(formData: FormData): JoinRequestInput | null {
  const name = field(formData, 'name');
  const email = normalizeEmail(field(formData, 'email'));
  const credential = field(formData, 'credential');
  const website = field(formData, 'website');
  const note = field(formData, 'note');

  if (!name || !email || !credential) return null;
  if (
    name.length > JOIN_REQUEST_LIMITS.name ||
    credential.length > JOIN_REQUEST_LIMITS.credential ||
    website.length > JOIN_REQUEST_LIMITS.website ||
    note.length > JOIN_REQUEST_LIMITS.note
  ) {
    return null;
  }
  return { name, email, credential, website: website || null, note: note || null };
}

/** Every address in ADMIN_EMAILS, the list that grants ADMIN at sign-in. */
export function adminRecipients(): string[] {
  return Array.from(
    new Set(
      (process.env.ADMIN_EMAILS ?? '')
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
  );
}

/** Only http(s) links are rendered as links; anything else stays text. */
export function safeHttpUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Tell every admin a request arrived. Never throws: the request is already stored and is
 * visible at /admin/requests, so a failed send is logged rather than lost with the request.
 */
export async function notifyAdminsOfJoinRequest(
  request: JoinRequestInput & { id: string },
): Promise<void> {
  const to = adminRecipients();
  if (to.length === 0) {
    console.error('[join-request] ADMIN_EMAILS unset; nobody notified', { id: request.id });
    return;
  }

  const link = `${SITE_URL}/admin/requests`;
  const rows: Array<[string, string | null]> = [
    ['Name', request.name],
    ['Email', request.email],
    ['Training or credential', request.credential],
    ['Website or social', request.website],
    ['Note', request.note],
  ];
  const present = rows.filter((r): r is [string, string] => Boolean(r[1]));

  const html = `<p>A new request to join Natural Health Pros is waiting for review.</p>
<table cellpadding="4">${present
    .map(([k, v]) => `<tr><td><strong>${escapeHtml(k)}</strong></td><td>${escapeHtml(v)}</td></tr>`)
    .join('')}</table>
<p><a href="${link}">Review join requests</a></p>`;
  const text = `A new request to join Natural Health Pros is waiting for review.\n\n${present
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')}\n\nReview: ${link}\n`;

  for (const admin of to) {
    try {
      await sendEmail({
        to: admin,
        subject: `Join request: ${request.name.replace(/[\r\n]+/g, ' ').slice(0, 80)}`,
        html,
        text,
        idempotencyKey: `join-request/${request.id}/${admin}`,
        tags: [{ name: 'feature', value: 'join-request' }],
      });
    } catch (e) {
      console.error('[join-request] admin notification failed', { id: request.id, admin }, e);
    }
  }
}

/** Optional note to a declined requester. Their name is the only text of theirs echoed back. */
export async function sendDeclineEmail(
  requestId: string,
  email: string,
  name: string,
): Promise<boolean> {
  const greeting = name.replace(/[\r\n]+/g, ' ').trim();
  const text = `Hello${greeting ? ` ${greeting}` : ''},

Thank you for your interest in Natural Health Pros. We are not able to add you to the directory at this time.

We appreciate you reaching out, and we wish you well in your practice.

Natural Health Pros
`;
  const html = text
    .trim()
    .split('\n\n')
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
  try {
    await sendEmail({
      to: email,
      subject: 'Your request to join Natural Health Pros',
      html,
      text,
      idempotencyKey: `join-request-declined/${requestId}`,
      tags: [{ name: 'feature', value: 'join-request' }],
    });
    return true;
  } catch (e) {
    console.error('[join-request] decline email failed', { id: requestId }, e);
    return false;
  }
}
