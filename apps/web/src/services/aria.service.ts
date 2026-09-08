import {
  api,
  apiBaseUrl,
  ApiError,
  apiFetch,
  tryRefreshToken,
} from "@/lib/api-client";
import { trackAriaMessageSent } from "@/lib/events";

// ─── Types ──────────────────────────────────────────────

export interface AriaConversation {
  id: string;
  userId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  _count: { messages: number };
}

export interface AriaAttachment {
  id: string;
  name: string;
  kind: "image" | "document" | "video";
  mimeType: string;
  size: number;
  status: "ready" | "processing" | "failed";
}

export interface AriaMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  attachments?: AriaAttachment[];
}

export interface AriaConversationWithMessages extends AriaConversation {
  messages: AriaMessage[];
}

export type AriaStreamEvent =
  | { t: "meta"; conversationId: string }
  | { t: "delta"; text: string }
  | {
      t: "tool_use";
      id: string;
      name: string;
      status: "running" | "done" | "error";
      summary: string;
    }
  | { t: "done"; message: AriaMessage }
  | { t: "error"; message: string };

/** Gemini receipt parse (`POST /aria/parse-receipt`) */
export interface AriaParsedReceiptLine {
  description: string;
  amount?: number;
  quantity?: number;
}

export interface AriaParsedReceipt {
  merchantName: string;
  transactionDate: string;
  currency: string;
  totalAmount: number;
  taxAmount: number;
  subtotal?: number;
  paymentMethod: string;
  lineItems: AriaParsedReceiptLine[];
  suggestedDescription: string;
  parsingNotes: string;
}

/** Gemini invoice parse (`POST /aria/parse-invoice`) */
export interface AriaParsedInvoiceLine {
  description: string;
  amount?: number;
  quantity?: number;
}

export interface AriaParsedInvoice {
  vendorName: string;
  vendorTaxId: string;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  totalAmount: number;
  taxAmount: number;
  lineItems: AriaParsedInvoiceLine[];
  suggestedMemo: string;
  parsingNotes: string;
}

interface ListConversationsResponse {
  data: AriaConversation[];
}

interface GetConversationResponse {
  data: AriaConversationWithMessages;
}

interface CreateConversationResponse {
  data: AriaConversation;
}

function parseApiErrorBody(text: string): {
  code: string;
  message: string;
  details?: Array<{ field?: string; message: string }>;
} {
  try {
    const body = JSON.parse(text) as unknown;
    const err =
      body && typeof body === "object" && "error" in body
        ? ((body as Record<string, unknown>).error ?? {})
        : {};
    const errObj =
      typeof err === "object" && err !== null
        ? (err as Record<string, unknown>)
        : null;
    return {
      code: typeof err === "string" ? err : String(errObj?.code ?? "UNKNOWN"),
      message:
        typeof err === "string"
          ? err
          : String(errObj?.message ?? "Unknown error"),
      details: errObj?.details as
        Array<{ field?: string; message: string }> | undefined,
    };
  } catch {
    return {
      code: "UNKNOWN",
      message: text || "Request failed",
    };
  }
}

function isNdjsonContentType(ct: string | null): boolean {
  if (!ct) return false;
  return (
    ct.includes("application/x-ndjson") || ct.includes("application/ndjson")
  );
}

function parseStreamLine(line: string): AriaStreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const obj = JSON.parse(trimmed) as Record<string, unknown>;
  const t = obj.t;
  if (t === "meta" && typeof obj.conversationId === "string") {
    return { t: "meta", conversationId: obj.conversationId };
  }
  if (t === "delta" && typeof obj.text === "string") {
    return { t: "delta", text: obj.text };
  }
  if (t === "done" && obj.message && typeof obj.message === "object") {
    const m = obj.message as Record<string, unknown>;
    if (
      typeof m.id === "string" &&
      typeof m.conversationId === "string" &&
      (m.role === "assistant" || m.role === "user") &&
      typeof m.content === "string" &&
      typeof m.createdAt === "string"
    ) {
      return {
        t: "done",
        message: {
          id: m.id,
          conversationId: m.conversationId,
          role: m.role,
          content: m.content,
          createdAt: m.createdAt,
        },
      };
    }
  }
  if (t === "tool_use") {
    if (
      typeof obj.id === "string" &&
      typeof obj.name === "string" &&
      (obj.status === "running" ||
        obj.status === "done" ||
        obj.status === "error") &&
      typeof obj.summary === "string"
    ) {
      return {
        t: "tool_use",
        id: obj.id,
        name: obj.name,
        status: obj.status,
        summary: obj.summary,
      };
    }
  }
  if (t === "error" && typeof obj.message === "string") {
    return { t: "error", message: obj.message };
  }
  return null;
}

// ─── Service ────────────────────────────────────────────

export async function listConversations(): Promise<AriaConversation[]> {
  const res = await api.get<ListConversationsResponse>("/aria/conversations");
  return res.data;
}

export async function getConversation(
  id: string,
): Promise<AriaConversationWithMessages> {
  const res = await api.get<GetConversationResponse>(
    `/aria/conversations/${id}`,
  );
  return res.data;
}

export async function createConversation(
  title?: string,
): Promise<AriaConversation> {
  const res = await api.post<CreateConversationResponse>(
    "/aria/conversations",
    title ? { title } : {},
  );
  return res.data;
}

export async function deleteConversation(
  id: string,
): Promise<{ success: boolean }> {
  return api.delete<{ success: boolean }>(`/aria/conversations/${id}`);
}

/**
 * Confirm an ARIA draft-and-confirm write tool (ARIA improvement #7).
 * Token comes from the `aria-confirm` block in chat; the server
 * verifies the HMAC + re-checks permissions before dispatching.
 */
export async function confirmAriaAction(token: string): Promise<{
  data: { action: string; result: unknown };
}> {
  return api.post<{ data: { action: string; result: unknown } }>(
    "/aria/confirm-action",
    { token },
  );
}

/**
 * POST /aria/attachments — upload one chat attachment (image / PDF / text
 * doc). Returns the stored attachment; pass its id in the next streamAriaChat
 * `attachmentIds`. The shared `api` helper detects FormData and skips JSON
 * encoding + sets the CSRF header.
 */
export async function uploadAriaAttachment(
  file: File,
): Promise<AriaAttachment> {
  const formData = new FormData();
  formData.append("file", file);
  // apiFetch (not api.post) — api.post JSON-stringifies the body, which would
  // corrupt the multipart form. apiFetch leaves FormData intact + sets no
  // Content-Type so the browser adds the multipart boundary.
  const res = await apiFetch<{ data: AriaAttachment }>("/aria/attachments", {
    method: "POST",
    body: formData,
  });
  return res.data;
}

/**
 * POST /aria/chat — NDJSON stream (`meta`, `delta`, `done` | `error`).
 * Retries once on 401 after cookie refresh (same behavior as `apiFetch`).
 *
 * Three modes (mutually exclusive on the server, validated by Zod):
 * - plain send — pass `message`, no edit/retry ids.
 * - edit       — pass `message` plus `opts.editMessageId` (a user
 *                message id). Server truncates from that message
 *                inclusive and appends the new content.
 * - retry      — pass empty `message` and `opts.retryAssistantMessageId`
 *                (an assistant message id). Server truncates from that
 *                message inclusive and re-streams using existing prior
 *                user history.
 */
export async function streamAriaChat(
  message: string,
  conversationId: string | undefined,
  onEvent: (event: AriaStreamEvent) => void,
  init?: {
    signal?: AbortSignal;
    editMessageId?: string;
    retryAssistantMessageId?: string;
    attachmentIds?: string[];
  },
): Promise<void> {
  trackAriaMessageSent({ prompt_length: message.length });

  const url = `${apiBaseUrl}/aria/chat`;
  const body = JSON.stringify({
    // For retry the body is `undefined` server-side; sending the empty
    // string would fail the min(1) zod gate. Skip the field instead.
    ...(message ? { message } : {}),
    conversationId,
    ...(init?.editMessageId ? { editMessageId: init.editMessageId } : {}),
    ...(init?.retryAssistantMessageId
      ? { retryAssistantMessageId: init.retryAssistantMessageId }
      : {}),
    ...(init?.attachmentIds && init.attachmentIds.length > 0
      ? { attachmentIds: init.attachmentIds }
      : {}),
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Requested-With": "XMLHttpRequest",
  };

  async function postStream(isRetry: boolean): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers,
        body,
        signal: init?.signal,
      });
    } catch (err) {
      throw new ApiError(
        0,
        "NETWORK_ERROR",
        err instanceof Error ? err.message : "Network request failed",
      );
    }

    if (
      res.status === 401 &&
      !isRetry &&
      typeof window !== "undefined" &&
      !url.includes("/auth/refresh")
    ) {
      const refreshed = await tryRefreshToken();
      if (refreshed) return postStream(true);
      if (!window.location.pathname.includes("/sign-in")) {
        window.location.replace("/sign-in");
      }
    }

    if (!res.ok) {
      const text = await res.text();
      const parsed = parseApiErrorBody(text);
      throw new ApiError(
        res.status,
        parsed.code,
        parsed.message,
        parsed.details,
      );
    }

    const ct = res.headers.get("content-type");
    if (!isNdjsonContentType(ct)) {
      throw new ApiError(
        res.status || 0,
        "UNEXPECTED_RESPONSE",
        "Expected NDJSON stream from Manut AI chat",
      );
    }

    return res;
  }

  const res = await postStream(false);
  const reader = res.body?.getReader();
  if (!reader) {
    throw new ApiError(0, "NO_BODY", "No response body from Manut AI chat");
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let sawDone = false;
  let sawError = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const ev = parseStreamLine(line);
        if (!ev) continue;
        onEvent(ev);
        if (ev.t === "done") sawDone = true;
        if (ev.t === "error") sawError = true;
      }
    }
    const tail = buffer.trim();
    if (tail) {
      const ev = parseStreamLine(tail);
      if (ev) {
        onEvent(ev);
        if (ev.t === "done") sawDone = true;
        if (ev.t === "error") sawError = true;
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!sawDone && !sawError) {
    throw new ApiError(
      0,
      "STREAM_INCOMPLETE",
      "Stream ended before assistant reply finished",
    );
  }
}

interface ParseReceiptResponse {
  data: AriaParsedReceipt;
}

interface ParseInvoiceResponse {
  data: AriaParsedInvoice;
}

/**
 * Multipart upload to `POST /aria/parse-receipt` (requires `aria:parse`).
 */
export async function parseAriaReceipt(
  file: File,
  init?: { signal?: AbortSignal },
): Promise<AriaParsedReceipt> {
  const body = new FormData();
  body.append("file", file);
  const res = await apiFetch<ParseReceiptResponse>("/aria/parse-receipt", {
    method: "POST",
    body,
    signal: init?.signal,
  });
  return res.data;
}

/**
 * Multipart upload to `POST /aria/parse-invoice` (requires `aria:parse`).
 */
export async function parseAriaInvoice(
  file: File,
  init?: { signal?: AbortSignal },
): Promise<AriaParsedInvoice> {
  const body = new FormData();
  body.append("file", file);
  const res = await apiFetch<ParseInvoiceResponse>("/aria/parse-invoice", {
    method: "POST",
    body,
    signal: init?.signal,
  });
  return res.data;
}

// ─── Insights (admin) ───────────────────────────────────

export interface AriaInsights {
  windowDays: number;
  since: string;
  total: number;
  withHits: number;
  hitRate: number | null;
  errors: number;
  errorRate: number | null;
  latency: {
    p50: number | null;
    p95: number | null;
    avg: number | null;
  };
  tokens: {
    in: number;
    out: number;
    cacheRead: number;
    cacheCreate: number;
  };
  retrievalModes: Array<{ mode: string; count: number }>;
  emptyRetrievalQueries: Array<{
    message: string;
    count: number;
    topDistance: number | null;
  }>;
  recentErrors: Array<{
    id: string;
    message: string;
    errorMessage: string | null;
    createdAt: string;
  }>;
  tools: {
    turnsWithTools: number;
    totalInvocations: number;
    topTools: Array<{ tool: string; count: number }>;
  };
}

/** GET /aria/insights — admin telemetry rollup. */
export async function getAriaInsights(days = 7): Promise<AriaInsights> {
  const res = await api.get<{ data: AriaInsights }>(
    `/aria/insights?days=${days}`,
  );
  return res.data;
}

// ─── Feedback / improvement queue (Phase 6) ─────────────────────

export interface AriaFeedbackRecord {
  id: string;
  messageId: string;
  userId: string;
  rating: "up" | "down";
  reason: string | null;
  reviewed: boolean;
  createdAt: string;
}

export interface AriaImprovementItem {
  id: string;
  rating: "up" | "down";
  reason: string | null;
  createdAt: string;
  message: {
    id: string;
    content: string;
    createdAt: string;
    conversationId: string;
    conversation: { title: string | null; userId: string };
  };
  user: { id: string; name: string; email: string };
}

export interface AriaDraftArticle {
  feedbackId: string;
  draft: {
    title: string;
    slug: string;
    category: string;
    body: string;
    keywords: string[];
    requiredPermissions: string[];
  };
}

/** POST /aria/feedback — persist a thumbs rating + optional reason. */
export async function submitAriaFeedback(input: {
  messageId: string;
  rating: "up" | "down";
  reason?: string;
}): Promise<AriaFeedbackRecord> {
  const res = await api.post<{ data: AriaFeedbackRecord }>(
    "/aria/feedback",
    input,
  );
  return res.data;
}

/** GET /aria/improvement-queue — admin queue of un-reviewed thumbs-down. */
export async function listAriaImprovementQueue(): Promise<
  AriaImprovementItem[]
> {
  const res = await api.get<{ data: AriaImprovementItem[] }>(
    "/aria/improvement-queue",
  );
  return res.data;
}

/** POST /aria/feedback/:id/draft-article — Haiku-drafted article. */
export async function draftArticleFromFeedback(
  feedbackId: string,
): Promise<AriaDraftArticle> {
  const res = await api.post<{ data: AriaDraftArticle }>(
    `/aria/feedback/${feedbackId}/draft-article`,
    {},
  );
  return res.data;
}

/** POST /aria/feedback/:id/review — clear from queue + optional link to article. */
export async function reviewAriaFeedback(
  feedbackId: string,
  input: { reviewNote?: string; resultingArticleId?: string },
): Promise<AriaFeedbackRecord> {
  const res = await api.post<{ data: AriaFeedbackRecord }>(
    `/aria/feedback/${feedbackId}/review`,
    input,
  );
  return res.data;
}

// ─── Knowledge sync (admin) ─────────────────────────────

export interface AriaSyncReport {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  perSource: Array<{
    source: string;
    upserted: number;
    deactivated: number;
  }>;
  errors: Array<{ source: string; message: string }>;
}

/**
 * POST /aria/sync — manually trigger the knowledge auto-sync workers.
 * Idempotent; safe to fire on demand.
 */
export async function runAriaKnowledgeSync(): Promise<AriaSyncReport> {
  const res = await api.post<{ data: AriaSyncReport }>("/aria/sync", {});
  return res.data;
}

// ─── Daily brief subscription + inbox (Phase 8) ─────────────────────

export type BriefChannel = "in_app" | "email";
export type BriefSectionId =
  | "calendar"
  | "approvals"
  | "leave-balance"
  | "expiring-visas"
  | "pipeline"
  | "helpdesk-mine";

export interface BriefSubscription {
  userId: string;
  enabled: boolean;
  hourLocal: number;
  timezone: string;
  channels: BriefChannel[];
  /** Empty array means "every section the user qualifies for". */
  sections: BriefSectionId[];
  weekdaysOnly: boolean;
  lastDeliveredAt: string | null;
  /** True when the BE synthesised defaults and no row exists yet. */
  virtual: boolean;
}

export interface BriefSection {
  id: BriefSectionId;
  title: string;
  headline: string;
  count: number;
  markdown: string;
  href?: string;
}

export interface BriefPayload {
  generatedAt: string;
  deliveredOn: string;
  sections: BriefSection[];
  totalAttention: number;
}

export interface BriefDelivery {
  id: string;
  deliveredOn: string;
  generatedAt: string;
  payloadJson: BriefPayload;
  channelStatus: Record<string, string>;
}

export async function getAriaBriefSubscription(): Promise<{
  subscription: BriefSubscription;
  availableSections: BriefSectionId[];
}> {
  const res = await api.get<{
    data: {
      subscription: BriefSubscription;
      availableSections: BriefSectionId[];
    };
  }>("/aria/brief/subscription");
  return res.data;
}

export async function updateAriaBriefSubscription(
  patch: Partial<{
    enabled: boolean;
    hourLocal: number;
    timezone: string;
    channels: BriefChannel[];
    sections: BriefSectionId[];
    weekdaysOnly: boolean;
  }>,
): Promise<BriefSubscription> {
  const res = await api.put<{ data: { subscription: BriefSubscription } }>(
    "/aria/brief/subscription",
    patch,
  );
  return res.data.subscription;
}

export async function listAriaBriefDeliveries(
  limit = 14,
): Promise<BriefDelivery[]> {
  const res = await api.get<{ data: BriefDelivery[] }>(
    `/aria/brief/deliveries?limit=${limit}`,
  );
  return res.data;
}

export async function runAriaBriefNow(): Promise<
  | { empty: true }
  | { empty?: false; payload: BriefPayload; conversationId: string }
> {
  const res = await api.post<{
    data:
      | { empty: true }
      | { empty?: false; payload: BriefPayload; conversationId: string };
  }>("/aria/brief/run", {});
  return res.data;
}
