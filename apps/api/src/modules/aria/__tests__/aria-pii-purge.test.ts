import { beforeEach, describe, expect, it, vi } from "vitest";

import { ariaService } from "@/modules/aria/aria.service";

/**
 * Regression test for the ARIA PII purge service entry point.
 * Verifies the repository contract, the env-var override on
 * retention days, and the redaction sentinel.
 */

const prismaMock = vi.hoisted(() => ({
  manutAiQueryLog: { updateMany: vi.fn() },
}));

vi.mock("@/infrastructure/database/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("@/infrastructure/supabase/admin", () => ({
  supabaseAdmin: { auth: { admin: {} } },
}));

vi.mock("@/core/guards/auth.guard", () => ({
  loadUserPermissions: vi.fn().mockResolvedValue(new Set<string>()),
}));

vi.mock("@/modules/aria/aria-embedding.service", () => ({
  generateEmbedding: vi.fn().mockResolvedValue(null),
  vectorLiteral: vi.fn((v: number[]) => `[${v.join(",")}]`),
  articleEmbeddingInput: vi.fn(),
}));

const ORIGINAL_ENV = process.env.ARIA_PII_RETENTION_DAYS;

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.manutAiQueryLog.updateMany.mockResolvedValue({ count: 0 });
  process.env.ARIA_PII_RETENTION_DAYS = ORIGINAL_ENV;
});

describe("ariaService.runPiiPurge", () => {
  it("defaults to 30-day retention and redacts via sentinel", async () => {
    delete process.env.ARIA_PII_RETENTION_DAYS;
    prismaMock.manutAiQueryLog.updateMany.mockResolvedValue({ count: 4 });

    const result = await ariaService.runPiiPurge();

    expect(result.data).toEqual({ redacted: 4, retentionDays: 30 });
    const call = prismaMock.manutAiQueryLog.updateMany.mock.calls[0]?.[0] as {
      where: {
        createdAt: { lt: Date };
        NOT: { userMessage: string };
      };
      data: { userMessage: string };
    };
    // Cutoff is "now minus 30 days" — assert window is between
    // 29 and 31 days back to tolerate test wall-clock jitter.
    const ageMs = Date.now() - call.where.createdAt.lt.getTime();
    expect(ageMs).toBeGreaterThan(29 * 86_400_000);
    expect(ageMs).toBeLessThan(31 * 86_400_000);
    expect(call.data.userMessage).toBe("[redacted by retention policy]");
    expect(call.where.NOT.userMessage).toBe("[redacted by retention policy]");
  });

  it("honours ARIA_PII_RETENTION_DAYS env override", async () => {
    process.env.ARIA_PII_RETENTION_DAYS = "7";
    prismaMock.manutAiQueryLog.updateMany.mockResolvedValue({ count: 0 });

    const result = await ariaService.runPiiPurge();

    expect(result.data.retentionDays).toBe(7);
    const call = prismaMock.manutAiQueryLog.updateMany.mock.calls[0]?.[0] as {
      where: { createdAt: { lt: Date } };
    };
    const ageMs = Date.now() - call.where.createdAt.lt.getTime();
    expect(ageMs).toBeGreaterThan(6 * 86_400_000);
    expect(ageMs).toBeLessThan(8 * 86_400_000);
  });

  it.each(["", "0", "-3", "not-a-number"])(
    "ignores invalid override %j and falls back to 30",
    async (value) => {
      process.env.ARIA_PII_RETENTION_DAYS = value;
      const result = await ariaService.runPiiPurge();
      expect(result.data.retentionDays).toBe(30);
    },
  );
});
