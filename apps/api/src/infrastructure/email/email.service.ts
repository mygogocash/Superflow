import { logger } from "@/common/utils/logger";
import {
  renderGenericEmail,
  welcomeEmail,
} from "@/infrastructure/email/templates";

const RESEND_API_KEY = process.env.RESEND_API_KEY?.trim();
// A Resend-verified sender. Set EMAIL_FROM per environment.
const EMAIL_FROM =
  process.env.EMAIL_FROM?.trim() || "Manut <noreply@manut.xyz>";
const RESEND_ENDPOINT = "https://api.resend.com/emails";

export type EmailTemplateVariables = Record<
  string,
  string | number | boolean | null | undefined
>;

export interface SendEmailInput {
  to: string | string[];
  /** Retained for logging / Resend tagging; content is the local `html`. */
  templateId: string;
  variables: EmailTemplateVariables;
  subject?: string;
  html?: string;
  replyTo?: string;
}

interface SendWelcomeTemplateEmailInput {
  to: string;
  name: string;
  email: string;
  temporaryPassword: string;
  portalUrl: string;
}

/** Outcome of a delivery attempt. `retryable` distinguishes a transient
 * transport/5xx failure from a permanent rejection (4xx / not configured). */
export interface EmailDeliveryResult {
  ok: boolean;
  error?: string;
  retryable?: boolean;
}

// Resend tag values allow only ASCII letters, numbers, underscores and dashes.
function toTagValue(templateId: string): string {
  return templateId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 256) || "email";
}

/**
 * Attempts one delivery via Resend and REPORTS the outcome, so callers that
 * need retry or an audit trail can observe failures. `sendEmail` wraps this and
 * keeps its original fire-and-forget behaviour for every existing caller.
 *
 * Content: callers that build an `EmailContent` pass a rendered `html` +
 * `subject`; senders that only pass a `templateId` + `variables` (legacy
 * server-template callers) are rendered on-brand via `renderGenericEmail`.
 */
export async function deliverEmail(
  input: SendEmailInput,
): Promise<EmailDeliveryResult> {
  if (!RESEND_API_KEY) {
    logger.warn("Email not sent (Resend not configured)", {
      to: input.to,
      templateId: input.templateId,
    });
    // Misconfiguration is permanent until an operator sets RESEND_API_KEY —
    // retrying the same request would only burn attempts.
    return {
      ok: false,
      error: "email service not configured",
      retryable: false,
    };
  }

  const rendered =
    input.html && input.subject
      ? { subject: input.subject, html: input.html }
      : renderGenericEmail(input.templateId, input.variables);

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: input.to,
        subject: rendered.subject,
        html: rendered.html,
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
        tags: [{ name: "template", value: toTagValue(input.templateId) }],
      }),
    });

    if (!response.ok) {
      const responseBody = await response.text();
      logger.error("Resend API error", {
        status: response.status,
        body: responseBody,
        to: input.to,
        templateId: input.templateId,
      });
      return {
        ok: false,
        error: `HTTP ${response.status}: ${responseBody.slice(0, 300)}`,
        // 5xx / 429 are worth another attempt; a 4xx is a bad request.
        retryable: response.status >= 500 || response.status === 429,
      };
    }

    logger.info("Email sent successfully", {
      to: input.to,
      templateId: input.templateId,
    });
    return { ok: true };
  } catch (err) {
    logger.error("Failed to send email", {
      error: err,
      to: input.to,
      templateId: input.templateId,
    });
    // Network-level failure — always worth retrying.
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      retryable: true,
    };
  }
}

export async function sendEmail(input: SendEmailInput): Promise<void> {
  // Behaviour preserved exactly: never throws, never reports.
  await deliverEmail(input);
}

export async function sendWelcomeTemplateEmail(
  input: SendWelcomeTemplateEmailInput,
): Promise<void> {
  await sendEmail({
    to: input.to,
    ...welcomeEmail({
      name: input.name,
      email: input.email,
      temporaryPassword: input.temporaryPassword,
      portalUrl: input.portalUrl,
    }),
  });
}
