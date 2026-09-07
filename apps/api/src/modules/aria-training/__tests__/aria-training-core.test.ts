import { describe, expect, it } from "vitest";

import {
  buildDatasetRows,
  buildPreferencePairs,
  datasetChecksum,
  toEvalExample,
  toRetrievalExample,
  toSftExample,
  type TraceExampleInput,
} from "@/modules/aria-training/dataset-format";
import {
  DEFAULT_ARIA_GATE_SPECS,
  evaluateGate,
} from "@/modules/aria-training/eval-gate";
import { redactText, redactTrace } from "@/modules/aria-training/redaction";

function trace(over: Partial<TraceExampleInput> = {}): TraceExampleInput {
  return {
    traceId: "t1",
    conversationId: "c1",
    userMessage: "how much leave do I have?",
    assistantText: "You have 12 days.",
    promptVersion: "v1",
    permissionsSnapshot: ["leave:read"],
    retrievedArticleIds: ["a1"],
    retrievedDistances: [0.1],
    topDistance: 0.1,
    toolNames: ["get_leave_balance"],
    error: false,
    rating: null,
    feedbackReason: null,
    ...over,
  };
}

describe("redaction", () => {
  it("pseudonymizes emails, phones, and long ids in place", () => {
    const { text, redactions } = redactText(
      "reach me at jane.doe@manut.xyz or +66 2 059 0383, passport 123456789",
    );
    // The invariant that matters: no raw PII survives. (Bare long-digit runs
    // may be tagged <PHONE> or <ID> — both redact; the label is cosmetic.)
    expect(text).toContain("<EMAIL>");
    expect(text).not.toContain("jane.doe@manut.xyz");
    expect(text).not.toMatch(/\d{7,}/); // no phone/id digit run remains
    expect(text).not.toMatch(/@manut/);
    expect(redactions).toBeGreaterThanOrEqual(3);
  });

  it("leaves clean text and small numbers untouched", () => {
    const { text, redactions } = redactText("You have 12 days left.");
    expect(text).toBe("You have 12 days left.");
    expect(redactions).toBe(0);
  });

  it("redacts PII inside tool-call args + results", () => {
    const r = redactTrace({
      userMessage: "email boss@manut.xyz",
      assistantText: "done",
      toolCalls: [
        {
          name: "x",
          input: { to: "a@b.com" },
          resultPreview: "call 0812345678",
        },
      ],
    });
    expect(r.userMessage).toContain("<EMAIL>");
    const tc = r.toolCalls as Array<{
      input: { to: string };
      resultPreview: string;
    }>;
    expect(tc[0]!.input.to).toBe("<EMAIL>");
    expect(tc[0]!.resultPreview).toContain("<PHONE>");
    expect(r.redactions).toBeGreaterThanOrEqual(3);
  });
});

describe("dataset formatters", () => {
  it("SFT excludes errored and thumbs-down turns", () => {
    expect(toSftExample(trace({ rating: "up" }))).not.toBeNull();
    expect(toSftExample(trace({ rating: null }))).not.toBeNull();
    expect(toSftExample(trace({ rating: "down" }))).toBeNull();
    expect(toSftExample(trace({ error: true }))).toBeNull();
  });

  it("eval uses only upvoted turns as references", () => {
    expect(toEvalExample(trace({ rating: "up" }))).not.toBeNull();
    expect(toEvalExample(trace({ rating: null }))).toBeNull();
  });

  it("retrieval example carries ids + distances + outcome", () => {
    const r = toRetrievalExample(trace({ rating: "down" }));
    expect(r?.retrievedArticleIds).toEqual(["a1"]);
    expect(r?.rating).toBe("down");
  });

  it("DPO pairs an upvoted + downvoted answer for the SAME prompt", () => {
    const pairs = buildPreferencePairs([
      trace({ traceId: "up", assistantText: "12 days", rating: "up" }),
      trace({ traceId: "down", assistantText: "no idea", rating: "down" }),
      // different prompt — must NOT pair with the above
      trace({
        traceId: "other",
        userMessage: "who is my manager?",
        assistantText: "Sam",
        rating: "down",
      }),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.chosen).toBe("12 days");
    expect(pairs[0]!.rejected).toBe("no idea");
  });

  it("checksum is deterministic and buildDatasetRows dispatches by kind", () => {
    const rows = buildDatasetRows("sft", [trace({ rating: "up" })]);
    expect(rows).toHaveLength(1);
    expect(datasetChecksum(rows)).toBe(datasetChecksum(rows));
    expect(buildDatasetRows("dpo", [])).toEqual([]);
  });
});

describe("eval gate", () => {
  it("passes when candidate holds or improves", () => {
    const res = evaluateGate(
      { hitRate: 0.8, errorRate: 0.02, p95LatencyMs: 2000 },
      { hitRate: 0.82, errorRate: 0.02, p95LatencyMs: 1900 },
      DEFAULT_ARIA_GATE_SPECS,
    );
    expect(res.pass).toBe(true);
    expect(res.regressions).toEqual([]);
  });

  it("fails on a hit-rate regression beyond tolerance", () => {
    const res = evaluateGate(
      { hitRate: 0.8, errorRate: 0.02, p95LatencyMs: 2000 },
      { hitRate: 0.7, errorRate: 0.02, p95LatencyMs: 2000 },
      DEFAULT_ARIA_GATE_SPECS,
    );
    expect(res.pass).toBe(false);
    expect(res.regressions.some((r) => r.metric === "hitRate")).toBe(true);
  });

  it("fails on an absolute floor breach and on missing metrics", () => {
    const floor = evaluateGate(
      { hitRate: 0.62 },
      { hitRate: 0.59 },
      { hitRate: { direction: "higher_is_better", bound: 0.6 } },
    );
    expect(floor.pass).toBe(false);

    const missing = evaluateGate(
      {},
      {},
      { hitRate: { direction: "higher_is_better" } },
    );
    expect(missing.pass).toBe(false);
  });
});
