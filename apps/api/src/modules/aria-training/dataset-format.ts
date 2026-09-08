import { createHash } from "node:crypto";

// Phase 2/3 — pure dataset formatters over redacted interaction traces (with
// their joined feedback). Each builder emits the canonical shape for one
// training target; the service persists a versioned AriaTrainingDataset row +
// exports these rows as JSONL. No DB, no PII logic here — inputs are assumed
// already redacted.

export type DatasetKind = "sft" | "dpo" | "eval" | "retrieval";

/** The trace fields (post-redaction) + joined feedback the builders consume. */
export interface TraceExampleInput {
  traceId: string;
  conversationId: string | null;
  userMessage: string;
  assistantText: string;
  promptVersion: string;
  permissionsSnapshot: string[];
  retrievedArticleIds: string[];
  retrievedDistances: number[];
  topDistance: number | null;
  toolNames: string[];
  error: boolean;
  /** Joined from AriaFeedback (via assistantMessageId): "up" | "down" | null. */
  rating: "up" | "down" | null;
  feedbackReason: string | null;
}

export interface SftExample {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  meta: {
    traceId: string;
    promptVersion: string;
    permissions: string[];
    tools: string[];
  };
}

/**
 * SFT: (user → assistant) chat example. A turn is a *good* example only if it
 * didn't error and wasn't thumbs-downed. Returns null to exclude.
 */
export function toSftExample(t: TraceExampleInput): SftExample | null {
  if (t.error) return null;
  if (t.rating === "down") return null;
  if (!t.userMessage.trim() || !t.assistantText.trim()) return null;
  return {
    messages: [
      { role: "user", content: t.userMessage },
      { role: "assistant", content: t.assistantText },
    ],
    meta: {
      traceId: t.traceId,
      promptVersion: t.promptVersion,
      permissions: t.permissionsSnapshot,
      tools: t.toolNames,
    },
  };
}

export interface EvalExample {
  input: string;
  reference: string;
  meta: { traceId: string; promptVersion: string };
}

/**
 * Eval: use upvoted turns as reference answers (a held-out subset gates
 * candidate models). Only explicit thumbs-up so the reference is trusted.
 */
export function toEvalExample(t: TraceExampleInput): EvalExample | null {
  if (t.error || t.rating !== "up") return null;
  if (!t.userMessage.trim() || !t.assistantText.trim()) return null;
  return {
    input: t.userMessage,
    reference: t.assistantText,
    meta: { traceId: t.traceId, promptVersion: t.promptVersion },
  };
}

export interface RetrievalExample {
  query: string;
  retrievedArticleIds: string[];
  retrievedDistances: number[];
  topDistance: number | null;
  rating: "up" | "down" | null;
  meta: { traceId: string };
}

/** Retrieval-tuning: query → what was retrieved + the outcome signal. */
export function toRetrievalExample(
  t: TraceExampleInput,
): RetrievalExample | null {
  if (!t.userMessage.trim()) return null;
  return {
    query: t.userMessage,
    retrievedArticleIds: t.retrievedArticleIds,
    retrievedDistances: t.retrievedDistances,
    topDistance: t.topDistance,
    rating: t.rating,
    meta: { traceId: t.traceId },
  };
}

export interface PreferencePair {
  prompt: string;
  chosen: string;
  rejected: string;
  meta: {
    conversationId: string | null;
    chosenTraceId: string;
    rejectedTraceId: string;
  };
}

/**
 * DPO (Phase 3): (prompt, chosen, rejected) preference pairs. Grouped by
 * (conversationId, normalized prompt); within a group, an upvoted answer is
 * `chosen` and a downvoted answer to the *same* prompt is `rejected`. Pairing
 * on the same prompt is what makes the preference valid — arbitrary up/down
 * across different prompts is not a DPO signal. Distinct answers only.
 */
export function buildPreferencePairs(
  traces: TraceExampleInput[],
): PreferencePair[] {
  const groups = new Map<string, TraceExampleInput[]>();
  for (const t of traces) {
    if (t.error || !t.userMessage.trim() || !t.assistantText.trim()) continue;
    const key = `${t.conversationId ?? "_"}::${t.userMessage.trim().toLowerCase()}`;
    const arr = groups.get(key);
    if (arr) arr.push(t);
    else groups.set(key, [t]);
  }

  const pairs: PreferencePair[] = [];
  for (const group of groups.values()) {
    const chosen = group.find((t) => t.rating === "up");
    const rejected = group.find(
      (t) => t.rating === "down" && t.assistantText !== chosen?.assistantText,
    );
    if (chosen && rejected) {
      pairs.push({
        prompt: chosen.userMessage,
        chosen: chosen.assistantText,
        rejected: rejected.assistantText,
        meta: {
          conversationId: chosen.conversationId,
          chosenTraceId: chosen.traceId,
          rejectedTraceId: rejected.traceId,
        },
      });
    }
  }
  return pairs;
}

/** Serialize dataset rows to JSONL (one JSON object per line). */
export function toJsonl(rows: unknown[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n");
}

/** Deterministic content checksum for a built dataset (build verifiability). */
export function datasetChecksum(rows: unknown[]): string {
  return createHash("sha256").update(toJsonl(rows)).digest("hex");
}

/** Build the rows for a dataset kind from the trace/feedback inputs. */
export function buildDatasetRows(
  kind: DatasetKind,
  traces: TraceExampleInput[],
): unknown[] {
  switch (kind) {
    case "sft":
      return traces
        .map(toSftExample)
        .filter((x): x is SftExample => x !== null);
    case "eval":
      return traces
        .map(toEvalExample)
        .filter((x): x is EvalExample => x !== null);
    case "retrieval":
      return traces
        .map(toRetrievalExample)
        .filter((x): x is RetrievalExample => x !== null);
    case "dpo":
      return buildPreferencePairs(traces);
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}
