import crypto from "node:crypto";

import sanitizeHtml from "sanitize-html";

import {
  BadRequestException,
  InternalServerErrorException,
} from "@/common/exceptions/http-exception";
import { PreconditionRequiredException } from "@/common/exceptions/precondition-required.exception";
import { logger } from "@/common/utils/logger";
import { prisma } from "@/infrastructure/database/prisma";
import { actorFromId, trackIntegrationConnectedServer } from "@/lib/events";
import {
  buildAuthUrl,
  exchangeCode,
  fetchUserInfo,
  revoke,
} from "@/modules/integrations/google-oauth.service";
import {
  hasGmailSendScope,
  isGoogleInsufficientScopeError,
} from "@/modules/integrations/google-scopes";
import { googleTokenRepository } from "@/modules/integrations/google-token.repository";

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1";
const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";

// System Gmail labels exposed to the FE. Maps the FE's short folder
// name to Gmail's well-known label ID. `snoozed` is rendered under the
// "Scheduled" sidebar entry — Gmail still tags those threads with the
// SNOOZED label even though the UI calls them scheduled.
export type GmailFolder =
  | "inbox"
  | "sent"
  | "drafts"
  | "starred"
  | "important"
  | "snoozed"
  | "spam"
  | "trash";

const FOLDER_LABEL: Record<GmailFolder, string> = {
  inbox: "INBOX",
  sent: "SENT",
  drafts: "DRAFT",
  starred: "STARRED",
  important: "IMPORTANT",
  snoozed: "SNOOZED",
  spam: "SPAM",
  trash: "TRASH",
};

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailMessagePart {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailMessagePart[];
}

interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailMessagePart & { headers?: GmailHeader[] };
}

interface GmailListResponse {
  messages?: Array<{ id: string; threadId: string }>;
  resultSizeEstimate?: number;
  nextPageToken?: string;
}

interface DriveFile {
  id?: string;
  name?: string;
  mimeType?: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
  shared?: boolean;
}

interface DriveListResponse {
  files?: DriveFile[];
  nextPageToken?: string;
}

async function googleGet<T>(url: string, accessToken: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Google API ${res.status} ${res.statusText}: ${body.slice(0, 500)}`,
    );
  }
  return (await res.json()) as T;
}

async function googlePost<T>(
  url: string,
  accessToken: string,
  body: unknown,
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    // Pull the human-friendly message from Google's error envelope
    // (`{ error: { code, message, status } }`) when present so the FE
    // toast can show "Recipient address required" rather than a
    // generic "Internal server error".
    let detail = text.slice(0, 500);
    try {
      const parsed = JSON.parse(text) as {
        error?: { message?: string };
      };
      if (parsed?.error?.message) detail = parsed.error.message;
    } catch {
      /* fall through to raw text */
    }
    // Insufficient-scope detection — handled here so callers see the
    // proper PreconditionRequiredException with the
    // GOOGLE_SEND_SCOPE_REQUIRED code regardless of the surrounding
    // try/catch shape.
    if (isGoogleInsufficientScopeError(res.status, text)) {
      throw new PreconditionRequiredException(
        "Google rejected send — your account needs updated permissions. Disconnect and reconnect Google in Settings.",
        "GOOGLE_SEND_SCOPE_REQUIRED",
      );
    }
    // Pass other 4xx through as a client error so the UI doesn't
    // render a generic 500 for user-fixable problems (bad recipient,
    // attachment too big, etc.).
    if (res.status >= 400 && res.status < 500) {
      throw new BadRequestException(`Gmail: ${detail}`);
    }
    throw new InternalServerErrorException(
      `Google API ${res.status} ${res.statusText}: ${detail}`,
    );
  }
  return (await res.json()) as T;
}

function findHeader(
  headers: GmailHeader[] | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  return headers.find((h) => h.name.toLowerCase() === target)?.value;
}

function decodeBase64Url(data: string): string {
  // Gmail returns base64url; Buffer can decode 'base64url' since Node 16.
  return Buffer.from(data, "base64url").toString("utf-8");
}

function findFirstPart(
  payload: GmailMessage["payload"],
  mimeType: string,
): string | null {
  if (!payload) return null;
  const queue: GmailMessagePart[] = [payload];
  while (queue.length > 0) {
    const part = queue.shift();
    if (!part) continue;
    const data = part.body?.data;
    if (data && part.mimeType === mimeType) {
      return decodeBase64Url(data);
    }
    if (part.parts) queue.push(...part.parts);
  }
  return null;
}

// Basic named entities that sanitize-html leaves encoded in text output.
// Decoded in a single left-to-right pass (see decodeBasicEntities) so we never
// double-decode, unlike a sequential .replace() chain (CodeQL js/double-escaping).
const BASIC_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
};

function decodeBasicEntities(text: string): string {
  return text.replace(
    /&(?:amp|lt|gt|quot|apos|#39);/g,
    (m) => BASIC_ENTITIES[m] ?? m,
  );
}

function htmlToReadableText(html: string): string {
  // Preserve line structure from common block elements before stripping tags.
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|h[1-6]|li|tr)\s*>/gi, "\n\n");
  // sanitize-html removes ALL tags and drops the *content* of script/style/head
  // (nonTextTags), replacing the hand-rolled regex chain that CodeQL flagged as
  // an incomplete / bad-tag-filter sanitizer. Output is used as plain text.
  const stripped = sanitizeHtml(withBreaks, {
    allowedTags: [],
    allowedAttributes: {},
    nonTextTags: ["style", "script", "textarea", "option", "head", "noscript"],
  });
  return decodeBasicEntities(stripped)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractBodies(payload: GmailMessage["payload"]): {
  bodyText: string;
  bodyHtml: string;
} {
  const plain = findFirstPart(payload, "text/plain");
  const html = findFirstPart(payload, "text/html");
  const bodyText = plain ?? (html ? htmlToReadableText(html) : "");
  return { bodyText, bodyHtml: html ?? "" };
}

function stripHtmlToPlain(html: string): string {
  // Same safe HTML->text path as htmlToReadableText (was a near-duplicate
  // hand-rolled regex chain flagged by CodeQL).
  return htmlToReadableText(html);
}

function foldBase64(data: string): string {
  const lines: string[] = [];
  for (let i = 0; i < data.length; i += 76) {
    lines.push(data.slice(i, i + 76));
  }
  return lines.join("\r\n");
}

/**
 * Encode a header value as an RFC 2047 encoded-word when it contains
 * non-ASCII characters. Headers are otherwise restricted to 7-bit
 * ASCII — HR users typing Thai script in the Subject field or in
 * recipient display names previously broke `buildRfc822`, which made
 * Gmail's API reject the message with "Invalid value for raw" and the
 * UI surface a generic 500. We pick base64 over quoted-printable
 * because the worst case (mostly multi-byte Thai script) is shorter
 * and avoids the soft-line-break edge cases that QP needs.
 */
function encodeHeaderValue(value: string): string {
  // Pure ASCII? Pass through — keeps `In-Reply-To:` Message-IDs and
  // bare email addresses untouched.
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  // RFC 2047 caps each encoded-word at 75 bytes. Split into chunks so
  // multi-line subjects (or long Thai strings) stay parseable.
  const bytes = Buffer.from(value, "utf-8");
  const chunkSize = 45; // base64 of 45 bytes = 60 chars + 12 wrapper = 72
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize).toString("base64");
    chunks.push(`=?UTF-8?B?${slice}?=`);
  }
  return chunks.join("\r\n ");
}

/**
 * Encode an address-list header. Splits on commas (top-level only),
 * then for each address detects an optional `"Display" <addr@x>` form
 * — only the display-name portion needs RFC 2047 encoding, the angle-
 * bracket addr-spec must stay 7-bit ASCII.
 */
function encodeAddressList(value: string): string {
  return value
    .split(",")
    .map((entry) => {
      const trimmed = entry.trim();
      if (!trimmed) return trimmed;
      const m = trimmed.match(/^(.+?)\s*<([^>]+)>\s*$/);
      if (m) {
        const display = m[1]!.trim().replace(/^"|"$/g, "");
        const addr = m[2]!.trim();
        const encoded = encodeHeaderValue(display);
        // Wrap display in quotes only when it already contained spaces
        // or special chars — keeps simple ASCII names un-quoted.
        const needsQuotes = /[\s,;:<>@()[\]\\]/.test(display);
        const name =
          encoded === display && needsQuotes ? `"${display}"` : encoded;
        return `${name} <${addr}>`;
      }
      return trimmed;
    })
    .join(", ");
}

function buildAlternativePart(plain: string, html: string | undefined): string {
  const altBoundary = `alt_${crypto.randomBytes(8).toString("hex")}`;
  // Bodies use base64 transfer encoding so non-ASCII (Thai script,
  // emoji, accented Latin) survives the SMTP / Gmail-API hop. The old
  // `7bit` declaration was a lie when the body contained UTF-8 bytes
  // — Gmail's API rejected the message as malformed, surfaced as a
  // generic 500 to the user.
  const plainB64 = foldBase64(Buffer.from(plain, "utf-8").toString("base64"));
  if (html?.trim()) {
    const htmlB64 = foldBase64(
      Buffer.from(html.trim(), "utf-8").toString("base64"),
    );
    return [
      `Content-Type: multipart/alternative; boundary="${altBoundary}"`,
      "",
      `--${altBoundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      plainB64,
      `--${altBoundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      htmlB64,
      `--${altBoundary}--`,
    ].join("\r\n");
  }
  return [
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    plainB64,
  ].join("\r\n");
}

function buildRfc822(input: {
  to: string;
  cc?: string;
  subject: string;
  body?: string;
  bodyHtml?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: Array<{
    filename: string;
    mimeType: string;
    contentBase64: string;
  }>;
}): string {
  const headers: string[] = [
    `To: ${encodeAddressList(input.to)}`,
    ...(input.cc?.trim() ? [`Cc: ${encodeAddressList(input.cc.trim())}`] : []),
    `Subject: ${encodeHeaderValue(input.subject)}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`] : []),
    ...(input.references ? [`References: ${input.references}`] : []),
    "MIME-Version: 1.0",
  ];

  const html = input.bodyHtml?.trim();
  const plain =
    (input.body ?? "").trim() || (html ? stripHtmlToPlain(html) : "");
  const attachments = input.attachments ?? [];

  if (attachments.length === 0) {
    return [...headers, buildAlternativePart(plain, html)].join("\r\n");
  }

  const mixedBoundary = `mix_${crypto.randomBytes(8).toString("hex")}`;
  const parts: string[] = [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
    "",
    `--${mixedBoundary}`,
    buildAlternativePart(plain, html),
  ];

  for (const file of attachments) {
    const safeName = file.filename.replace(/"/g, "'");
    // Encode non-ASCII filenames per RFC 2047 so Gmail accepts the
    // header. Keep the raw quoted form for the `Content-Disposition`
    // `filename=` parameter as a fallback for clients that don't
    // understand encoded-words; modern clients prefer the RFC 5987
    // `filename*=UTF-8''<percent-encoded>` parameter we also emit.
    const headerName = encodeHeaderValue(safeName);
    const pctName = encodeURIComponent(safeName);
    parts.push(
      `--${mixedBoundary}`,
      `Content-Type: ${file.mimeType}; name="${headerName}"`,
      `Content-Disposition: attachment; filename="${headerName}"; filename*=UTF-8''${pctName}`,
      "Content-Transfer-Encoding: base64",
      "",
      foldBase64(file.contentBase64),
    );
  }
  parts.push(`--${mixedBoundary}--`);
  return parts.join("\r\n");
}

function base64UrlEncode(s: string): string {
  return Buffer.from(s, "utf-8").toString("base64url");
}

async function loadGoogleAccessToken(userId: string): Promise<string> {
  try {
    const { accessToken } = await googleTokenRepository.getValid(userId);
    return accessToken;
  } catch (err) {
    if (err instanceof Error && err.message === "GOOGLE_NOT_CONNECTED") {
      throw new PreconditionRequiredException();
    }
    throw err;
  }
}

async function loadGoogleConnection(userId: string) {
  try {
    return await googleTokenRepository.getValid(userId);
  } catch (err) {
    if (err instanceof Error && err.message === "GOOGLE_NOT_CONNECTED") {
      throw new PreconditionRequiredException();
    }
    throw err;
  }
}

function requireGmailSendScope(scope: string): void {
  if (hasGmailSendScope(scope)) return;
  throw new PreconditionRequiredException(
    "Your Google connection can read mail but cannot send. Disconnect and reconnect Google in Settings, then approve send access.",
    "GOOGLE_SEND_SCOPE_REQUIRED",
  );
}

function rethrowGmailSendApiError(err: unknown): never {
  if (err instanceof PreconditionRequiredException) throw err;
  if (err instanceof Error) {
    const match = err.message.match(/^Google API (\d+) [^:]+:([\s\S]*)$/);
    if (match) {
      const status = Number(match[1]);
      const body = match[2] ?? "";
      if (isGoogleInsufficientScopeError(status, body)) {
        throw new PreconditionRequiredException(
          "Google rejected send — your account needs updated permissions. Disconnect and reconnect Google in Settings.",
          "GOOGLE_SEND_SCOPE_REQUIRED",
        );
      }
    }
  }
  throw err;
}

function requireGoogleEnv() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!clientId) {
    throw new Error(
      "GOOGLE_OAUTH_CLIENT_ID is not set. Configure Google OAuth in env.",
    );
  }
  if (!clientSecret) {
    throw new Error("GOOGLE_OAUTH_CLIENT_SECRET is not set.");
  }
  if (!redirectUri) {
    throw new Error("GOOGLE_OAUTH_REDIRECT_URI is not set.");
  }
  return { clientId, clientSecret, redirectUri };
}

export const integrationsService = {
  async getStatus(userId: string) {
    const hasGoogleEnv =
      !!process.env.GOOGLE_OAUTH_CLIENT_ID &&
      !!process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const conn = await googleTokenRepository.findByUserId(userId);
    const google = conn.connected
      ? {
          connected: true as const,
          accountEmail: conn.accountEmail,
          scope: conn.scope,
          expiresAt: conn.expiresAt?.toISOString(),
          canSendMail: hasGmailSendScope(conn.scope),
        }
      : { connected: false as const };

    return {
      anthropic: {
        configured: !!process.env.ANTHROPIC_API_KEY,
        status: process.env.ANTHROPIC_API_KEY ? "connected" : "not_configured",
      },
      gmail: {
        configured: hasGoogleEnv,
        status: hasGoogleEnv ? "connected" : "not_configured",
      },
      drive: {
        configured: hasGoogleEnv,
        status: hasGoogleEnv ? "connected" : "not_configured",
      },
      google,
    };
  },

  async startOauth({
    userId,
    redirect,
  }: {
    userId: string;
    redirect?: string;
  }): Promise<{ url: string }> {
    const { clientId, redirectUri } = requireGoogleEnv();
    const state = crypto.randomBytes(32).toString("hex");

    await prisma.googleOauthState.create({
      data: {
        state,
        userId,
        redirect: redirect ?? null,
        expiresAt: new Date(Date.now() + STATE_TTL_MS),
      },
    });

    const url = buildAuthUrl({ state, redirectUri, clientId });
    return { url };
  },

  async completeOauth({
    code,
    state,
  }: {
    code: string;
    state: string;
  }): Promise<{ accountEmail: string; redirect?: string }> {
    const { clientId, clientSecret, redirectUri } = requireGoogleEnv();

    const row = await prisma.googleOauthState.findUnique({ where: { state } });
    if (!row) {
      throw new Error("INVALID_OR_EXPIRED_STATE");
    }
    // Single-use: delete immediately whether expired or valid
    await prisma.googleOauthState.delete({ where: { state } });
    if (row.expiresAt.getTime() < Date.now()) {
      throw new Error("INVALID_OR_EXPIRED_STATE");
    }

    const tokens = await exchangeCode({
      code,
      redirectUri,
      clientId,
      clientSecret,
    });

    const info = await fetchUserInfo(tokens.accessToken);

    await googleTokenRepository.upsert({
      userId: row.userId,
      accountEmail: info.email,
      tokens,
    });

    try {
      const trackingActor = await actorFromId(row.userId);
      if (trackingActor) {
        // The Gmail + Drive features ride on the same Google OAuth grant —
        // emit one event labelled `gmail` since that's what the UI markets.
        trackIntegrationConnectedServer(trackingActor, { provider: "gmail" });
      }
    } catch {
      // analytics is best-effort
    }

    return {
      accountEmail: info.email,
      redirect: row.redirect ?? undefined,
    };
  },

  async disconnect({ userId }: { userId: string }): Promise<{ ok: boolean }> {
    let accessToken: string | null = null;
    try {
      const valid = await googleTokenRepository.getValid(userId);
      accessToken = valid.accessToken;
    } catch (err) {
      // Either GOOGLE_NOT_CONNECTED or refresh failed; proceed to delete anyway.
      logger.warn("disconnect: could not load token; skipping revoke", {
        message: (err as Error).message,
      });
    }

    if (accessToken) {
      try {
        await revoke(accessToken);
      } catch (err) {
        // Best-effort: revoke can fail if token already revoked.
        logger.warn("disconnect: revoke failed (best-effort)", {
          message: (err as Error).message,
        });
      }
    }

    await googleTokenRepository.delete(userId);
    return { ok: true };
  },

  async listGmail(
    userId: string,
    opts: {
      folder?: GmailFolder;
      // Optional override — when set, the caller's own Gmail label ID
      // is used directly. Lets the FE list user-defined labels
      // (`Label_*`) without the BE knowing their human names.
      labelId?: string;
      // Optional Gmail search query — passed through as the `q` param.
      // Used by the CRM email-sync worker (`after:UNIX_TIMESTAMP`) to
      // pull messages newer than the last cursor without scanning the
      // whole mailbox. When set without folder/labelId, lists across
      // all mailboxes (Gmail treats absent `labelIds` as "everything").
      q?: string;
      pageSize?: number;
      pageToken?: string;
    },
  ) {
    const accessToken = await loadGoogleAccessToken(userId);
    const labelId =
      opts.labelId ??
      (opts.folder ? FOLDER_LABEL[opts.folder] : opts.q ? "" : "INBOX");
    const pageSize = opts.pageSize ?? 25;

    try {
      const params = new URLSearchParams({
        maxResults: String(pageSize),
      });
      if (labelId) params.set("labelIds", labelId);
      if (opts.q) params.set("q", opts.q);
      if (opts.pageToken) params.set("pageToken", opts.pageToken);
      const listUrl = `${GMAIL_API_BASE}/users/me/messages?${params.toString()}`;
      const list = await googleGet<GmailListResponse>(listUrl, accessToken);
      const ids = (list.messages ?? []).map((m) => m.id);

      const headerParams =
        "format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date";
      const messages = await Promise.all(
        ids.map((id) =>
          googleGet<GmailMessage>(
            `${GMAIL_API_BASE}/users/me/messages/${id}?${headerParams}`,
            accessToken,
          ),
        ),
      );

      const data = messages.map((m) => ({
        id: m.id,
        threadId: m.threadId,
        from: findHeader(m.payload?.headers, "From"),
        to: findHeader(m.payload?.headers, "To"),
        subject: findHeader(m.payload?.headers, "Subject"),
        snippet: m.snippet,
        // Surface labelIds so the FE can render star/unread badges
        // without a second round-trip per row.
        labelIds: m.labelIds ?? [],
        date:
          findHeader(m.payload?.headers, "Date") ??
          (m.internalDate
            ? new Date(Number(m.internalDate)).toISOString()
            : undefined),
      }));

      return { data, nextPageToken: list.nextPageToken ?? null };
    } catch (err) {
      logger.error("Gmail list failed", err);
      throw err;
    }
  },

  /**
   * Return the caller's full Gmail label list. Split into `system`
   * (Gmail's built-ins like INBOX/SENT/IMPORTANT/STARRED) and `user`
   * (`Label_*` ids — the labels the user manually created). FE
   * renders user labels under a separate sidebar section.
   */
  async listGmailLabels(userId: string) {
    const accessToken = await loadGoogleAccessToken(userId);
    interface LabelsResponse {
      labels?: Array<{
        id: string;
        name: string;
        type: "system" | "user";
        messageListVisibility?: string;
        labelListVisibility?: string;
        messagesUnread?: number;
        messagesTotal?: number;
      }>;
    }
    try {
      const res = await googleGet<LabelsResponse>(
        `${GMAIL_API_BASE}/users/me/labels`,
        accessToken,
      );
      const labels = res.labels ?? [];
      // Gmail hides certain system labels from sidebars by default
      // (CHAT, CATEGORY_*); we still return them so the FE can decide
      // — but pre-classify so the picker doesn't have to.
      return {
        system: labels.filter((l) => l.type === "system"),
        user: labels.filter((l) => l.type === "user"),
      };
    } catch (err) {
      logger.error("Gmail labels list failed", err);
      throw err;
    }
  },

  /**
   * Apply / remove labels on a Gmail message. Used for star toggle,
   * mark-as-read / unread, manual label assignment, and any operation
   * Gmail models as a label modification.
   */
  async modifyGmail(
    userId: string,
    messageId: string,
    opts: { addLabelIds?: string[]; removeLabelIds?: string[] },
  ) {
    const accessToken = await loadGoogleAccessToken(userId);
    try {
      const result = await googlePost<GmailMessage>(
        `${GMAIL_API_BASE}/users/me/messages/${messageId}/modify`,
        accessToken,
        {
          addLabelIds: opts.addLabelIds ?? [],
          removeLabelIds: opts.removeLabelIds ?? [],
        },
      );
      return {
        id: result.id,
        labelIds: result.labelIds ?? [],
      };
    } catch (err) {
      logger.error("Gmail modify failed", err);
      throw err;
    }
  },

  /**
   * Move a message into Gmail's TRASH (Bin). Distinct from
   * `users.messages.delete` which is irreversible; trash auto-purges
   * after 30 days and the user can restore until then.
   */
  async trashGmail(userId: string, messageId: string) {
    const accessToken = await loadGoogleAccessToken(userId);
    try {
      const result = await googlePost<GmailMessage>(
        `${GMAIL_API_BASE}/users/me/messages/${messageId}/trash`,
        accessToken,
        {},
      );
      return { id: result.id, labelIds: result.labelIds ?? [] };
    } catch (err) {
      logger.error("Gmail trash failed", err);
      throw err;
    }
  },

  async untrashGmail(userId: string, messageId: string) {
    const accessToken = await loadGoogleAccessToken(userId);
    try {
      const result = await googlePost<GmailMessage>(
        `${GMAIL_API_BASE}/users/me/messages/${messageId}/untrash`,
        accessToken,
        {},
      );
      return { id: result.id, labelIds: result.labelIds ?? [] };
    } catch (err) {
      logger.error("Gmail untrash failed", err);
      throw err;
    }
  },

  async readGmail(userId: string, messageId: string) {
    const accessToken = await loadGoogleAccessToken(userId);
    try {
      const message = await googleGet<GmailMessage>(
        `${GMAIL_API_BASE}/users/me/messages/${messageId}?format=full`,
        accessToken,
      );

      const headers = message.payload?.headers;
      const from = findHeader(headers, "From") ?? "";
      const to = findHeader(headers, "To") ?? "";
      const cc = findHeader(headers, "Cc") ?? "";
      const subject = findHeader(headers, "Subject") ?? "";
      const date = findHeader(headers, "Date") ?? "";
      const rfcMessageId = findHeader(headers, "Message-ID") ?? "";
      const { bodyText, bodyHtml } = extractBodies(message.payload);

      return {
        messageId,
        threadId: message.threadId ?? "",
        rfcMessageId,
        from,
        to,
        cc,
        subject,
        date,
        bodyText,
        bodyHtml,
      };
    } catch (err) {
      logger.error("Gmail read failed", err);
      throw err;
    }
  },

  async sendGmail(
    userId: string,
    input: {
      to: string;
      cc?: string;
      subject: string;
      body?: string;
      bodyHtml?: string;
      inReplyTo?: string;
      references?: string;
      threadId?: string;
      attachments?: Array<{
        filename: string;
        mimeType: string;
        contentBase64: string;
      }>;
    },
  ) {
    const { accessToken, scope } = await loadGoogleConnection(userId);
    requireGmailSendScope(scope);
    const raw = base64UrlEncode(
      buildRfc822({
        to: input.to,
        cc: input.cc,
        subject: input.subject,
        body: input.body,
        bodyHtml: input.bodyHtml,
        inReplyTo: input.inReplyTo,
        references: input.references,
        attachments: input.attachments,
      }),
    );

    const payload: { raw: string; threadId?: string } = { raw };
    if (input.threadId) payload.threadId = input.threadId;

    try {
      const sent = await googlePost<{ id: string; threadId: string }>(
        `${GMAIL_API_BASE}/users/me/messages/send`,
        accessToken,
        payload,
      );
      return { result: `Sent. Message ID: ${sent.id}` };
    } catch (err) {
      logger.error("Gmail send failed", err);
      rethrowGmailSendApiError(err);
    }
  },

  async listDrive(
    userId: string,
    query?: string,
    pageSize = 25,
    pageToken?: string,
  ) {
    const accessToken = await loadGoogleAccessToken(userId);
    const params = new URLSearchParams({
      pageSize: String(pageSize),
      fields:
        "nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,shared)",
      orderBy: "modifiedTime desc",
    });
    if (query) {
      // Escape backslashes first, then single quotes, so a value containing a
      // backslash cannot break out of the quoted Drive query literal (CodeQL
      // js/incomplete-sanitization — the previous version escaped only `'`).
      const safeQuery = query.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      params.set("q", `name contains '${safeQuery}'`);
    }
    if (pageToken) params.set("pageToken", pageToken);

    try {
      const result = await googleGet<DriveListResponse>(
        `${DRIVE_API_BASE}/files?${params.toString()}`,
        accessToken,
      );
      return {
        data: result.files ?? [],
        nextPageToken: result.nextPageToken ?? null,
      };
    } catch (err) {
      logger.error("Drive list failed", err);
      throw err;
    }
  },
};
