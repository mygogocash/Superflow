import { ApiError, api, apiRequest } from "@/lib/api-client";

export interface ManutAiConversation {
  id: string;
  userId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  _count?: { messages: number };
}

export interface ManutAiMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface ManutAiConversationWithMessages extends ManutAiConversation {
  messages: ManutAiMessage[];
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
  | { t: "done"; message: ManutAiMessage }
  | { t: "error"; message: string };

export type ToolUseTrace = {
  id: string;
  name: string;
  status: "running" | "done" | "error";
  summary: string;
};

export type ChatAction = { label: string; prompt: string };

export type ConfirmAction = {
  action: string;
  token: string;
  /** Model-authored one-liner — untrusted; prefer signedParams for truth. */
  summary: string;
  /** Model-authored params from the fence (may diverge from signed body). */
  fenceParams: Record<string, unknown>;
  /** Params from the HMAC token body when decodable (authoritative for UI). */
  signedParams: Record<string, unknown> | null;
  signedAction: string | null;
};

function isNdjsonContentType(ct: string | null): boolean {
  if (!ct) return false;
  return ct.includes("application/x-ndjson") || ct.includes("application/ndjson");
}

/**
 * Decode the unsigned body of a `v1:<b64>:<sig>` confirm token for display.
 * Does not verify the HMAC (key stays server-side) — the POST still verifies.
 */
export function peekConfirmTokenBody(token: string): {
  action: string;
  params: Record<string, unknown>;
  exp: number;
} | null {
  const parts = token.split(":");
  if (parts.length !== 3 || parts[0] !== "v1" || !parts[1]) return null;
  try {
    let json: string;
    if (typeof Buffer !== "undefined") {
      json = Buffer.from(parts[1], "base64").toString("utf-8");
    } else if (typeof atob === "function") {
      const binary = atob(parts[1]);
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      json = new TextDecoder().decode(bytes);
    } else {
      return null;
    }
    const body = JSON.parse(json) as Record<string, unknown>;
    if (typeof body.action !== "string" || !body.action.trim()) return null;
    if (typeof body.exp !== "number" || !Number.isFinite(body.exp)) return null;
    const params =
      body.params && typeof body.params === "object" && !Array.isArray(body.params)
        ? (body.params as Record<string, unknown>)
        : {};
    return { action: body.action.trim(), params, exp: body.exp };
  } catch {
    return null;
  }
}

function parseStreamLine(line: string): AriaStreamEvent | "skip" | null {
  const trimmed = line.trim();
  if (!trimmed) return "skip";
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // Soft skip — a single bad line must not terminate the stream.
    return "skip";
  }
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
    return "skip";
  }
  if (t === "tool_use") {
    if (
      typeof obj.id === "string" &&
      typeof obj.name === "string" &&
      (obj.status === "running" || obj.status === "done" || obj.status === "error") &&
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
    return "skip";
  }
  if (t === "error" && typeof obj.message === "string") {
    return { t: "error", message: obj.message };
  }
  return "skip";
}

export async function listConversations(): Promise<ManutAiConversation[]> {
  const res = await api.get<{ data: ManutAiConversation[] }>("/aria/conversations");
  return res.data;
}

export async function getConversation(id: string): Promise<ManutAiConversationWithMessages> {
  const res = await api.get<{ data: ManutAiConversationWithMessages }>(`/aria/conversations/${id}`);
  return res.data;
}

export async function deleteConversation(id: string): Promise<void> {
  await apiRequest(`/aria/conversations/${id}`, { method: "DELETE" });
}

export async function confirmAriaAction(token: string): Promise<void> {
  await api.post("/aria/confirm-action", { token });
}

function emitParsedLines(text: string, onEvent: (event: AriaStreamEvent) => void): {
  sawTerminal: boolean;
} {
  let sawTerminal = false;
  for (const line of text.split("\n")) {
    const event = parseStreamLine(line);
    if (!event || event === "skip") continue;
    if (event.t === "done" || event.t === "error") sawTerminal = true;
    onEvent(event);
  }
  return { sawTerminal };
}

/**
 * POST /aria/chat — NDJSON stream. Web ReadableStream; falls back to full-body
 * text parse when streaming is unavailable (some RN environments).
 */
export async function streamAriaChat(
  message: string,
  opts: {
    conversationId?: string;
    signal?: AbortSignal;
    onEvent: (event: AriaStreamEvent) => void;
  },
): Promise<void> {
  const res = await apiRequest("/aria/chat", {
    method: "POST",
    body: JSON.stringify({
      message,
      conversationId: opts.conversationId,
    }),
    signal: opts.signal,
  });

  if (!res.ok) {
    const raw = await res.text();
    let messageText = `HTTP ${res.status}`;
    try {
      const body = JSON.parse(raw) as { error?: { message?: string } };
      messageText = body.error?.message ?? messageText;
    } catch {
      if (raw.trim()) messageText = raw.trim();
    }
    throw new ApiError(res.status, "STREAM_ERROR", messageText);
  }

  if (!isNdjsonContentType(res.headers.get("content-type"))) {
    throw new ApiError(res.status, "STREAM_ERROR", "Expected NDJSON chat stream");
  }

  let sawTerminal = false;
  const track = (event: AriaStreamEvent) => {
    if (event.t === "done" || event.t === "error") sawTerminal = true;
    opts.onEvent(event);
  };

  const reader = res.body?.getReader?.();
  if (!reader) {
    const text = await res.text();
    const result = emitParsedLines(text, track);
    sawTerminal = result.sawTerminal || sawTerminal;
    if (!sawTerminal) {
      throw new ApiError(502, "STREAM_ERROR", "Chat stream ended without a reply");
    }
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseStreamLine(line);
      if (event && event !== "skip") track(event);
    }
  }
  if (buffer.trim()) {
    const event = parseStreamLine(buffer);
    if (event && event !== "skip") track(event);
  }
  if (!sawTerminal) {
    throw new ApiError(502, "STREAM_ERROR", "Chat stream ended without a reply");
  }
}

/** Strip interactive fences for plain display; extract action chips. */
export function extractChatActions(content: string): {
  display: string;
  actions: ChatAction[];
  confirm?: ConfirmAction;
} {
  const actions: ChatAction[] = [];
  let confirm: ConfirmAction | undefined;
  let display = content;

  const fenceRe = /```(aria-actions|aria-confirm)\s*([\s\S]*?)```/gi;
  display = display.replace(fenceRe, (_full, lang: string, body: string) => {
    try {
      const parsed = JSON.parse(body.trim()) as Record<string, unknown>;
      if (lang.toLowerCase() === "aria-actions" && Array.isArray(parsed.actions)) {
        for (const item of parsed.actions) {
          if (
            item &&
            typeof item === "object" &&
            typeof (item as ChatAction).label === "string" &&
            typeof (item as ChatAction).prompt === "string"
          ) {
            actions.push({
              label: (item as ChatAction).label,
              prompt: (item as ChatAction).prompt,
            });
          }
        }
        return "";
      }
      if (
        lang.toLowerCase() === "aria-confirm" &&
        typeof parsed.token === "string" &&
        typeof parsed.summary === "string" &&
        typeof parsed.action === "string"
      ) {
        const peeked = peekConfirmTokenBody(parsed.token);
        const fenceParams =
          parsed.params && typeof parsed.params === "object" && !Array.isArray(parsed.params)
            ? (parsed.params as Record<string, unknown>)
            : {};
        confirm = {
          action: parsed.action,
          token: parsed.token,
          summary: parsed.summary,
          fenceParams,
          signedParams: peeked?.params ?? null,
          signedAction: peeked?.action ?? null,
        };
        return "";
      }
      // Valid JSON but wrong shape — keep the fence visible rather than stripping.
      return _full;
    } catch {
      // leave fence text if JSON is incomplete mid-stream
      return _full;
    }
  });

  display = display.replace(/\n{3,}/g, "\n\n").trim();
  return { display, actions, confirm };
}
