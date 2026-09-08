import { logger } from "@/common/utils/logger";
import {
  ANTHROPIC_MODELS,
  getAnthropicClient,
} from "@/infrastructure/ai/anthropic";
import { ariaRepository } from "@/modules/aria/aria.repository";

// When more than this many messages have aged out of the verbatim
// window we maintain a rolling summary. 10 covers a typical "long
// thread" without paying for a Haiku call on routine usage.
export const SUMMARY_TRIGGER_THRESHOLD = 10;

// Max pinned facts we surface per conversation. Keeps the system
// prompt bounded even if the extractor goes wide.
export const MEMORY_MAX_ENTRIES = 20;

const SUMMARY_SYSTEM_PROMPT = `You compress Manut AI chat history for an enterprise assistant.
Produce a single short summary (<= 1500 characters, plain text, no markdown headings) covering:
- The factual asks the user has made and the answers Manut AI gave.
- Any decisions, deadlines, or open questions referenced.
- Names, entities, and identifiers that recurred.
Do not invent new facts. Do not refer to "the previous conversation" or "above" — write a self-contained briefing.`;

const MEMORY_SYSTEM_PROMPT = `You extract durable facts from a Manut AI chat turn for re-injection into future turns.
Return a JSON array (no prose, no markdown) of up to 5 objects with shape: {"key": string, "value": string}.
- key: lowercase snake_case, <= 40 chars (e.g. "user_topic", "preferred_currency", "active_entity")
- value: <= 200 chars, factual, present-tense
Skip ephemeral content (greetings, acknowledgements, single-turn questions). If nothing durable, return [].`;

interface MemoryEntry {
  key: string;
  value: string;
}

function tryParseMemoryArray(raw: string): MemoryEntry[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  // Anthropic sometimes wraps JSON in a fence — strip it defensively.
  const cleaned = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    const out: MemoryEntry[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const key = typeof obj.key === "string" ? obj.key.trim() : "";
      const value = typeof obj.value === "string" ? obj.value.trim() : "";
      if (!key || !value) continue;
      out.push({
        key: key
          .slice(0, 40)
          .toLowerCase()
          .replace(/[^a-z0-9_]/g, "_"),
        value: value.slice(0, 200),
      });
    }
    return out.slice(0, 5);
  } catch {
    return [];
  }
}

/**
 * Build a "EARLIER CONVERSATION SUMMARY" block for the system prompt.
 * Returns `null` when the conversation has not aged out enough
 * messages yet, or when the summary call has not run yet.
 *
 * The summariser itself is fire-and-forget — callers should run
 * `maybeRegenerateSummary` after persisting the new assistant reply
 * so the next turn picks up a fresher block.
 */
export async function loadSummaryBlock(
  conversationId: string,
): Promise<string | null> {
  const summary = await ariaRepository.getSummary(conversationId);
  if (!summary?.summary) return null;
  return `EARLIER CONVERSATION SUMMARY (messages before the verbatim window):\n${summary.summary.trim()}`;
}

/**
 * Build a "PINNED CONTEXT" block from the conversation memory. Cheap
 * read — one indexed query.
 */
export async function loadMemoryBlock(
  conversationId: string,
): Promise<string | null> {
  const entries = await ariaRepository.getMemory(conversationId);
  if (entries.length === 0) return null;
  const lines = entries
    .slice(0, MEMORY_MAX_ENTRIES)
    .map((e) => `- ${e.key}: ${e.value}`);
  return `PINNED CONTEXT (facts Manut AI has remembered from this conversation):\n${lines.join("\n")}`;
}

/**
 * Regenerate the rolling summary if enough new messages have aged out
 * of the verbatim window since the last summary was written. Safe to
 * call after every assistant reply — short-circuits when not needed.
 *
 * `verbatimOldestId` is the id of the oldest message we are still
 * sending verbatim (i.e. the first item from `getRecentMessages`).
 */
export async function maybeRegenerateSummary(
  conversationId: string,
  verbatimOldestId: string,
): Promise<void> {
  try {
    const existing = await ariaRepository.getSummary(conversationId);
    const olderCount = await ariaRepository.countMessagesOlderThan(
      conversationId,
      verbatimOldestId,
    );

    if (olderCount < SUMMARY_TRIGGER_THRESHOLD) return;

    // Skip if the summary already covers everything before the
    // current verbatim window. We re-summarise when the window has
    // moved past the pivot we last covered.
    if (
      existing &&
      existing.coversThroughMessageId === verbatimOldestId &&
      existing.messageCount === olderCount
    ) {
      return;
    }

    const messages = await ariaRepository.getMessagesOlderThan(
      conversationId,
      verbatimOldestId,
    );
    if (messages.length === 0) return;

    const formatted = messages
      .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
      .join("\n\n");
    // Bound the summariser input — long conversations would otherwise
    // grow the Haiku call unboundedly. 8k chars covers ~30-40
    // exchanges, more than enough context for a useful summary.
    const truncated = formatted.slice(-8000);

    const anthropic = getAnthropicClient();
    const response = await anthropic.messages.create({
      model: ANTHROPIC_MODELS.TITLE,
      max_tokens: 800,
      system: SUMMARY_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Summarise this Manut AI chat history:\n\n${truncated}`,
        },
      ],
    });

    const block = response.content.find((b) => b.type === "text");
    const summaryText = block && block.type === "text" ? block.text.trim() : "";
    if (!summaryText) return;

    await ariaRepository.upsertSummary({
      conversationId,
      summary: summaryText,
      coversThroughMessageId: verbatimOldestId,
      messageCount: olderCount,
      model: ANTHROPIC_MODELS.TITLE,
    });
  } catch (err) {
    logger.warn("ARIA summary regeneration failed", {
      conversationId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Extract pinned facts from the latest user turn + assistant reply
 * and upsert them into `aria_conversation_memory`. Best-effort: any
 * failure logs a warn line and returns silently so chat is unaffected.
 */
export async function extractAndStoreMemory(args: {
  conversationId: string;
  userMessage: string;
  assistantMessage: string;
}): Promise<void> {
  try {
    const anthropic = getAnthropicClient();
    const response = await anthropic.messages.create({
      model: ANTHROPIC_MODELS.TITLE,
      max_tokens: 400,
      system: MEMORY_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `USER: ${args.userMessage}\n\nASSISTANT: ${args.assistantMessage}`,
        },
      ],
    });

    const block = response.content.find((b) => b.type === "text");
    const raw = block && block.type === "text" ? block.text : "";
    const entries = tryParseMemoryArray(raw);
    if (entries.length === 0) return;

    await ariaRepository.upsertMemoryEntries(args.conversationId, entries);
  } catch (err) {
    logger.warn("ARIA memory extraction failed", {
      conversationId: args.conversationId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
