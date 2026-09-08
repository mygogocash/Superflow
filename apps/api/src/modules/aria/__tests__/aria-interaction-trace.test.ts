import { beforeEach, describe, expect, it, vi } from "vitest";

import { ariaRepository } from "@/modules/aria/aria.repository";

/**
 * Contract test for the Phase 1 training-data trace writer. Verifies the
 * field mapping (arrays, tool-call JSON, and nullable -> undefined coercion so
 * Prisma applies column defaults) that the ARIA_TRACE_CAPTURE emit relies on.
 */
const prismaMock = vi.hoisted(() => ({
  manutAiInteractionTrace: { create: vi.fn() },
}));

vi.mock("@/infrastructure/database/prisma", () => ({
  prisma: prismaMock,
}));

function baseInput() {
  return {
    conversationId: "conv-1",
    userId: "user-1",
    assistantMessageId: "msg-1",
    turnKind: "send",
    promptVersion: "abc123def456",
    model: "claude-x",
    maxTokens: 8192,
    userMessage: "how many leave days do I have?",
    permissionsSnapshot: ["leave:read", "hrms:read"],
    offeredTools: ["get_leave_balance", "get_employee"],
    retrievedArticleIds: ["art-1", "art-2"],
    retrievedDistances: [0.11, 0.22],
    topDistance: 0.11,
    retrievalMode: "vector",
    workspaceBytes: 100,
    knowledgeBytes: 200,
    assistantText: "You have 12 days.",
    stopReason: "end_turn",
    toolCalls: [
      {
        name: "get_leave_balance",
        input: { employeeId: "MNT-001" },
        ok: true,
        isError: false,
        resultPreview: '{"days":12}',
      },
    ],
    toolUseCount: 1,
    toolNames: ["get_leave_balance"],
    tokensIn: 1200,
    tokensOut: 80,
    cacheReadTokens: 500,
    cacheCreateTokens: null,
    latencyMs: 1340,
    error: false,
    errorMessage: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.manutAiInteractionTrace.create.mockResolvedValue({ id: "trace-1" });
});

describe("ariaRepository.recordInteractionTrace", () => {
  it("maps the full turn, preserving the RBAC snapshot + tool-call JSON", async () => {
    await ariaRepository.recordInteractionTrace(baseInput());

    expect(prismaMock.manutAiInteractionTrace.create).toHaveBeenCalledTimes(1);
    const { data } = prismaMock.manutAiInteractionTrace.create.mock.calls[0]![0];

    expect(data.assistantMessageId).toBe("msg-1");
    expect(data.promptVersion).toBe("abc123def456");
    // RBAC snapshot + offered tools are what make the dataset RBAC-aware.
    expect(data.permissionsSnapshot).toEqual(["leave:read", "hrms:read"]);
    expect(data.offeredTools).toEqual(["get_leave_balance", "get_employee"]);
    // Full tool detail (args + result) is the signal the query log discards.
    expect(data.toolCalls).toEqual([
      {
        name: "get_leave_balance",
        input: { employeeId: "MNT-001" },
        ok: true,
        isError: false,
        resultPreview: '{"days":12}',
      },
    ]);
    expect(data.retrievedArticleIds).toEqual(["art-1", "art-2"]);
    expect(data.tokensIn).toBe(1200);
  });

  it("coerces null nullable fields to undefined so column defaults apply", async () => {
    await ariaRepository.recordInteractionTrace({
      ...baseInput(),
      maxTokens: null,
      topDistance: null,
      cacheCreateTokens: null,
      errorMessage: null,
    });

    const { data } = prismaMock.manutAiInteractionTrace.create.mock.calls[0]![0];
    expect(data.maxTokens).toBeUndefined();
    expect(data.topDistance).toBeUndefined();
    expect(data.cacheCreateTokens).toBeUndefined();
    expect(data.errorMessage).toBeUndefined();
  });
});
