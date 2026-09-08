import type { AuthEmailSender } from "@nexora/auth";

type EmailBindings = {
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  APP_URL: string;
};

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_FROM = "Manut <noreply@manut.xyz>";

/**
 * Auth email sender backed by Resend (POST https://api.resend.com/emails).
 * Magic-link / reset use a simple inline HTML body.
 */
export function createEmailSender(env: EmailBindings): AuthEmailSender {
  return {
    async sendMagicLink({ email, url }) {
      await deliver(env, {
        to: email,
        templateId: "auth-magic-link",
        subject: "Your Manut sign-in link",
        html: `<p>Sign in to Manut:</p><p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`,
      });
    },
    async sendResetPassword({ email, url }) {
      await deliver(env, {
        to: email,
        templateId: "auth-reset-password",
        subject: "Reset your Manut password",
        html: `<p>Reset your password:</p><p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`,
      });
    },
  };
}

async function deliver(
  env: EmailBindings,
  input: {
    to: string;
    templateId: string;
    subject: string;
    html: string;
  },
): Promise<void> {
  const key = env.RESEND_API_KEY;
  if (!key) {
    console.warn(
      JSON.stringify({
        level: "warn",
        msg: "email_not_configured",
        to: input.to,
        templateId: input.templateId,
      }),
    );
    return;
  }
  const res = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM || DEFAULT_FROM,
      to: input.to,
      subject: input.subject,
      html: input.html,
    }),
  });
  if (!res.ok) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "email_send_failed",
        status: res.status,
        templateId: input.templateId,
      }),
    );
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
