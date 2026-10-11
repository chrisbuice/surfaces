/**
 * send.ts — thin Resend wrapper shared by the nightly summary and auth-health alerts.
 */

const RESEND_API = "https://api.resend.com/emails";
const FROM_EMAIL = "Surfaces <spotify-agent@amberglow.ai>";

export type SendResult = { sent: true } | { sent: false; error: string };

export async function sendEmail(
  resendApiKey: string,
  toEmail: string,
  subject: string,
  html: string,
): Promise<SendResult> {
  try {
    const resp = await fetch(RESEND_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [toEmail],
        subject,
        html,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      return { sent: false, error: `Resend API error: ${resp.status} ${text}` };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, error: String(err) };
  }
}
