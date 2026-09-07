// Phase 2 — PII redaction transform. Unlike the aria_query_logs purge (which
// nukes user_message to a sentinel), training data must stay *useful*: we
// pseudonymize PII in place (emails, phones, long id/account numbers) with
// typed placeholders while keeping the surrounding text. Pure + deterministic
// so it is unit-tested and safe to run before any export.

// Char classes are bounded and linear (no catastrophic backtracking), so these
// are ReDoS-safe even on large assistant answers.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Phone-like: optional +, then 9+ digits possibly grouped by space/()-. Bounded
// separators between digits.
const PHONE_RE = /\+?\d(?:[\d\s().-]{7,}\d)/g;
// A standalone run of 9+ digits (passport / national id / bank account).
const LONG_ID_RE = /\b\d{9,}\b/g;

export interface RedactionResult {
  text: string;
  redactions: number;
}

/** Redact PII from a single string, returning the count of replacements. */
export function redactText(input: string): RedactionResult {
  if (!input) return { text: input, redactions: 0 };
  let redactions = 0;
  const bump = (token: string) => {
    redactions += 1;
    return token;
  };
  // Order matters: emails first (they contain digits that PHONE/ID would
  // otherwise grab), then phones, then bare long-digit ids.
  const text = input
    .replace(EMAIL_RE, () => bump("<EMAIL>"))
    .replace(PHONE_RE, () => bump("<PHONE>"))
    .replace(LONG_ID_RE, () => bump("<ID>"));
  return { text, redactions };
}

/**
 * Recursively redact string leaves of an arbitrary JSON-ish value (tool-call
 * args / results). Non-strings pass through; the redaction count accumulates.
 */
export function redactValue(value: unknown, counter: { n: number }): unknown {
  if (typeof value === "string") {
    const { text, redactions } = redactText(value);
    counter.n += redactions;
    return text;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, counter));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v, counter);
    }
    return out;
  }
  return value;
}

export interface RedactableTrace {
  userMessage: string;
  assistantText: string;
  toolCalls: unknown;
}

export interface RedactedTraceFields {
  userMessage: string;
  assistantText: string;
  toolCalls: unknown;
  redactions: number;
}

/** Redact every PII-bearing field of a trace; returns the redacted fields. */
export function redactTrace(trace: RedactableTrace): RedactedTraceFields {
  const counter = { n: 0 };
  const userMessage = redactText(trace.userMessage);
  const assistantText = redactText(trace.assistantText);
  counter.n += userMessage.redactions + assistantText.redactions;
  const toolCalls = redactValue(trace.toolCalls, counter);
  return {
    userMessage: userMessage.text,
    assistantText: assistantText.text,
    toolCalls,
    redactions: counter.n,
  };
}
