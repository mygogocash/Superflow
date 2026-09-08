import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadUserPermissions } from "@/core/guards/auth.guard";
import { sendEmail } from "@/infrastructure/email/email.service";
import {
  buildBrief,
  deliverBrief,
  runBriefDispatcher,
} from "@/modules/aria/aria-brief.service";

/**
 * Unit tests for the proactive daily brief.
 *
 * Three behaviours we care about most:
 *
 * 1. The dispatcher only fires for subscriptions whose `hourLocal`
 *    matches the current local hour in their timezone. A 07:00
 *    Asia/Bangkok user and a 07:00 Asia/Kolkata user should both
 *    receive their brief from a single hourly cron, but only at the
 *    right tick.
 * 2. `buildBrief` honours the `sectionFilter` allowlist. An empty
 *    array means "all" (preserves the FE empty-state shortcut),
 *    while a non-empty list strictly gates which sections run.
 * 3. `deliverBrief` is idempotent per (userId, deliveredOn) — a
 *    same-day re-run must NOT re-create the conversation or re-send
 *    the email.
 */

const prismaMock = vi.hoisted(() => {
  const manutAiBriefSubscription = {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    upsert: vi.fn(),
    update: vi.fn(),
  };
  const manutAiBriefDelivery = {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    findMany: vi.fn(),
  };
  const manutAiConversation = {
    create: vi.fn(),
    findFirst: vi.fn(),
  };
  const manutAiMessage = { create: vi.fn() };
  const user = { findUnique: vi.fn() };
  return {
    manutAiBriefSubscription,
    manutAiBriefDelivery,
    manutAiConversation,
    manutAiMessage,
    user,
    // Stubs for any section query that may run during a build. Every
    // section returns "empty" by default so the brief is well-behaved.
    leaveApprovalDecision: { findMany: vi.fn().mockResolvedValue([]) },
    travelApprovalDecision: { findMany: vi.fn().mockResolvedValue([]) },
    expenseApprovalDecision: { findMany: vi.fn().mockResolvedValue([]) },
    leaveBalance: { findMany: vi.fn().mockResolvedValue([]) },
    visaRecord: { findMany: vi.fn().mockResolvedValue([]) },
    opportunity: { findMany: vi.fn().mockResolvedValue([]) },
    helpdeskTicket: { findMany: vi.fn().mockResolvedValue([]) },
  };
});

vi.mock("@/infrastructure/database/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("@/infrastructure/email/email.service", () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/modules/integrations/google-token.repository", () => ({
  googleTokenRepository: {
    getValid: vi.fn().mockRejectedValue(new Error("GOOGLE_NOT_CONNECTED")),
  },
}));

vi.mock("@/core/guards/auth.guard", () => ({
  loadUserPermissions: vi.fn().mockResolvedValue([]),
}));

beforeEach(() => {
  vi.clearAllMocks();
  // Default empty mocks so every test starts from a clean slate.
  prismaMock.manutAiBriefSubscription.findMany.mockResolvedValue([]);
  prismaMock.manutAiBriefDelivery.findUnique.mockResolvedValue(null);
  prismaMock.manutAiBriefDelivery.create.mockResolvedValue({ id: "delivery-1" });
  prismaMock.manutAiBriefDelivery.update.mockResolvedValue({ id: "delivery-1" });
  prismaMock.manutAiConversation.create.mockResolvedValue({ id: "conv-1" });
  prismaMock.manutAiMessage.create.mockResolvedValue({ id: "msg-1" });
  prismaMock.manutAiBriefSubscription.update.mockResolvedValue({});
  (loadUserPermissions as ReturnType<typeof vi.fn>).mockResolvedValue([]);
});

// ── runBriefDispatcher ──────────────────────────────────────────────

describe("runBriefDispatcher", () => {
  it("skips subscribers whose local hour doesn't match the current tick", async () => {
    // Pick a wall-clock that won't be 07:00 anywhere — 12:00 UTC is
    // 19:00 Asia/Bangkok and 17:30 Asia/Kolkata, neither of which
    // matches a 07:00 subscription.
    const now = new Date("2026-05-24T12:00:00Z");
    prismaMock.manutAiBriefSubscription.findMany.mockResolvedValue([
      {
        userId: "u1",
        hourLocal: 7,
        timezone: "Asia/Bangkok",
        channels: ["in_app"],
        sections: [],
        weekdaysOnly: false,
        user: { email: "a@b.c", name: "Alice" },
      },
    ]);

    const summary = await runBriefDispatcher(now);

    expect(summary.considered).toBe(1);
    expect(summary.built).toBe(0);
    expect(summary.delivered).toBe(0);
    expect(prismaMock.manutAiConversation.create).not.toHaveBeenCalled();
  });

  it("fires for subscribers whose local hour matches", async () => {
    // 00:00 UTC == 07:00 Asia/Bangkok exactly.
    const now = new Date("2026-05-24T00:00:00Z");
    prismaMock.manutAiBriefSubscription.findMany.mockResolvedValue([
      {
        userId: "u1",
        hourLocal: 7,
        timezone: "Asia/Bangkok",
        channels: ["in_app"],
        sections: [],
        weekdaysOnly: false,
        user: { email: "a@b.c", name: "Alice" },
      },
    ]);
    // Stub one section to return rows so the brief isn't empty.
    prismaMock.leaveApprovalDecision.findMany.mockResolvedValueOnce([
      {
        leaveRequest: {
          startDate: new Date("2026-05-25"),
          endDate: new Date("2026-05-26"),
          employee: { name: "Bob" },
        },
      },
    ]);

    const summary = await runBriefDispatcher(now);

    expect(summary.considered).toBe(1);
    expect(summary.built).toBe(1);
    expect(summary.delivered).toBe(1);
    expect(prismaMock.manutAiConversation.create).toHaveBeenCalledTimes(1);
  });

  it("isolates per-user failures so one bad subscription doesn't poison the batch", async () => {
    const now = new Date("2026-05-24T00:00:00Z");
    prismaMock.manutAiBriefSubscription.findMany.mockResolvedValue([
      {
        userId: "u-bad",
        hourLocal: 7,
        timezone: "Asia/Bangkok",
        channels: ["in_app"],
        sections: [],
        weekdaysOnly: false,
        user: { email: "x@y.z", name: "Carol" },
      },
      {
        userId: "u-good",
        hourLocal: 7,
        timezone: "Asia/Bangkok",
        channels: ["in_app"],
        sections: [],
        weekdaysOnly: false,
        user: { email: "a@b.c", name: "Alice" },
      },
    ]);
    // First call throws (bad user), second call returns one item.
    prismaMock.leaveApprovalDecision.findMany
      .mockRejectedValueOnce(new Error("simulated DB outage"))
      .mockResolvedValueOnce([
        {
          leaveRequest: {
            startDate: new Date("2026-05-25"),
            endDate: new Date("2026-05-26"),
            employee: { name: "Bob" },
          },
        },
      ]);

    const summary = await runBriefDispatcher(now);

    expect(summary.considered).toBe(2);
    // u-bad's section threw but buildBrief swallows section errors and
    // returns the rest of the (empty) sections, so the brief is empty
    // and counts as skippedEmpty rather than errors.
    expect(summary.errors).toBe(0);
    expect(summary.skippedEmpty + summary.delivered).toBe(2);
  });
});

// ── buildBrief section filter ───────────────────────────────────────

describe("buildBrief sectionFilter", () => {
  it("empty filter runs every section", async () => {
    prismaMock.leaveApprovalDecision.findMany.mockResolvedValueOnce([
      {
        leaveRequest: {
          startDate: new Date("2026-05-25"),
          endDate: new Date("2026-05-26"),
          employee: { name: "Bob" },
        },
      },
    ]);

    const payload = await buildBrief({
      userId: "u1",
      timezone: "Asia/Bangkok",
    });

    // The approvals query ran and produced a section.
    expect(prismaMock.leaveApprovalDecision.findMany).toHaveBeenCalled();
    expect(payload?.sections.find((s) => s.id === "approvals")).toBeTruthy();
  });

  it("explicit allowlist skips disallowed sections", async () => {
    prismaMock.leaveApprovalDecision.findMany.mockResolvedValueOnce([
      {
        leaveRequest: {
          startDate: new Date("2026-05-25"),
          endDate: new Date("2026-05-26"),
          employee: { name: "Bob" },
        },
      },
    ]);

    const payload = await buildBrief({
      userId: "u1",
      timezone: "Asia/Bangkok",
      sectionFilter: ["calendar"], // approvals excluded
    });

    // Approvals must NOT have been queried because the filter excludes it.
    expect(prismaMock.leaveApprovalDecision.findMany).not.toHaveBeenCalled();
    // Whole brief is empty because the calendar section needs a Google
    // token (mocked to throw), and approvals is filtered out.
    expect(payload).toBeNull();
  });
});

// ── deliverBrief idempotency ────────────────────────────────────────

describe("deliverBrief idempotency", () => {
  const payload = {
    generatedAt: "2026-05-24T00:00:00.000Z",
    deliveredOn: "2026-05-24",
    sections: [
      {
        id: "approvals" as const,
        title: "Pending your approval",
        headline: "1 item needs approval",
        count: 1,
        markdown: "- foo",
      },
    ],
    totalAttention: 1,
  };

  it("first delivery creates the delivery row, the conversation, and sends email", async () => {
    // No P2002 — the create succeeds, so the rest of the flow runs.
    prismaMock.manutAiBriefDelivery.create.mockResolvedValueOnce({
      id: "delivery-1",
    });

    const result = await deliverBrief({
      userId: "u1",
      payload,
      channels: ["in_app", "email"],
      email: "alice@example.com",
      displayName: "Alice",
    });

    // Delivery row reserved FIRST as the atomic dedupe gate.
    expect(prismaMock.manutAiBriefDelivery.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.manutAiConversation.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.manutAiMessage.create).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(result.channelStatus.in_app).toBe("ok");
    expect(result.channelStatus.email).toBe("ok");
  });

  it("concurrent re-run gets P2002 from the unique key and short-circuits", async () => {
    // Simulate the second cron tick: insert collides with the row the
    // first tick already created. We must NOT create a second
    // conversation or fire a second email.
    const p2002 = Object.assign(new Error("unique violation"), {
      code: "P2002",
    });
    prismaMock.manutAiBriefDelivery.create.mockRejectedValueOnce(p2002);
    prismaMock.manutAiBriefDelivery.findUnique.mockResolvedValueOnce({
      id: "delivery-1",
    });
    prismaMock.manutAiConversation.findFirst.mockResolvedValueOnce({
      id: "conv-existing",
    });

    const result = await deliverBrief({
      userId: "u1",
      payload,
      channels: ["in_app", "email"],
      email: "alice@example.com",
    });

    expect(prismaMock.manutAiConversation.create).not.toHaveBeenCalled();
    expect(prismaMock.manutAiMessage.create).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
    expect(result.conversationId).toBe("conv-existing");
    for (const status of Object.values(result.channelStatus)) {
      expect(status).toMatch(/^skipped:already_delivered$/);
    }
  });

  it("email channel reports skipped when no address available", async () => {
    prismaMock.manutAiBriefDelivery.create.mockResolvedValueOnce({
      id: "delivery-1",
    });

    const result = await deliverBrief({
      userId: "u1",
      payload,
      channels: ["in_app", "email"],
      // no email
    });

    expect(sendEmail).not.toHaveBeenCalled();
    expect(result.channelStatus.email).toBe("skipped:no_email");
  });
});
