import { Resend } from 'resend';

let _client: Resend | undefined;

function getResend(): Resend | null {
  if (!process.env.RESEND_API_KEY) return null;
  if (!_client) _client = new Resend(process.env.RESEND_API_KEY);
  return _client;
}

const FROM = process.env.EMAIL_FROM ?? 'Natural Health Pros <onboarding@resend.dev>';

export type InvitationEmailParams = {
  to: string;
  acceptUrl: string;
  invitedByName?: string;
};

export async function sendInvitationEmail(params: InvitationEmailParams): Promise<void> {
  const subject = 'You\'re invited to join Natural Health Pros';
  const invitedLine = params.invitedByName
    ? `${params.invitedByName} invited you`
    : 'You were invited';
  const text = [
    `${invitedLine} to join Natural Health Pros — a curated practitioner directory for graduates of Holistic Health Educators programs.`,
    '',
    `Accept your invitation:`,
    params.acceptUrl,
    '',
    `This link expires in 7 days.`,
    '',
    `If you weren't expecting this email, you can ignore it.`,
  ].join('\n');
  const html = `
    <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #1a1a1a;">
      <h2 style="font-size: 18px; margin: 0 0 16px 0;">${invitedLine} to join Natural Health Pros.</h2>
      <p style="font-size: 14px; line-height: 1.6; color: #555;">
        Natural Health Pros is a curated practitioner directory for graduates of Holistic Health Educators
        programs. Click below to claim your profile.
      </p>
      <p style="margin: 24px 0;">
        <a href="${params.acceptUrl}" style="display: inline-block; background: #111; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-size: 14px; font-weight: 500;">
          Accept invitation
        </a>
      </p>
      <p style="font-size: 12px; color: #888;">This link expires in 7 days. If you weren't expecting this, you can ignore it.</p>
    </div>
  `;

  const client = getResend();
  if (!client) {
    // Graceful-degrade: log to console when Resend not configured.
    console.log('[EMAIL-DEGRADED] No RESEND_API_KEY. Would have sent:');
    console.log('  To:', params.to);
    console.log('  Subject:', subject);
    console.log('  Accept URL:', params.acceptUrl);
    return;
  }

  const { error } = await client.emails.send({
    from: FROM,
    to: params.to,
    subject,
    text,
    html,
  });
  if (error) {
    console.error('Resend send failed:', error);
    throw new Error(`Email send failed: ${error.message}`);
  }
}
