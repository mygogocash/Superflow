import { beforeEach, describe, expect, it, vi } from "vitest";

import { runAllSyncs } from "@/modules/aria/aria-sync.service";

/**
 * ARIA Phase 5 — auto-sync eval.
 *
 * Mocks Prisma + the embedding service and runs every sync worker
 * once against a fixed set of fixture rows. Verifies the deterministic
 * slug shape, tag list, and permission-gate values that the chat-time
 * lookup relies on. A regression here would silently break the corpus
 * (e.g. articles created with no perm gate when the source is private).
 */

// ── Hoisted mocks ───────────────────────────────────────────────────

const prismaMock = vi.hoisted(() => ({
  leaveType: { findMany: vi.fn() },
  publicHoliday: { findMany: vi.fn() },
  partner: { findMany: vi.fn() },
  project: { findMany: vi.fn() },
  companyPolicy: { findMany: vi.fn() },
  manutAiKnowledgeArticle: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
    updateMany: vi.fn(),
  },
}));

vi.mock("@/infrastructure/database/prisma", () => ({ prisma: prismaMock }));

vi.mock("@/infrastructure/supabase/admin", () => ({
  supabaseAdmin: { auth: { admin: {} } },
}));

vi.mock("@/core/guards/auth.guard", () => ({
  loadUserPermissions: vi.fn().mockResolvedValue(new Set<string>()),
}));

vi.mock("@/modules/aria/aria.repository", () => ({
  ariaRepository: {
    setKnowledgeEmbedding: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/modules/aria/aria-embedding.service", () => ({
  generateEmbedding: vi.fn().mockResolvedValue(null),
  vectorLiteral: vi.fn((vec: number[]) => `[${vec.join(",")}]`),
  articleEmbeddingInput: vi.fn((a: { title: string }) => a.title),
}));

// ── Fixture rows ────────────────────────────────────────────────────

const fakeEntity = { id: "ent-th", name: "TBH Thailand", code: "TH" };

beforeEach(() => {
  vi.clearAllMocks();

  prismaMock.leaveType.findMany.mockResolvedValue([
    {
      id: "lt-annual",
      name: "Annual Leave",
      code: "AL",
      category: "earned",
      daysPerYear: 14,
      isPaid: true,
      requiresApproval: true,
      description: "Standard annual entitlement.",
      entity: { name: fakeEntity.name, code: fakeEntity.code },
    },
  ]);

  prismaMock.publicHoliday.findMany.mockResolvedValue([
    {
      id: "ph-1",
      date: new Date("2026-04-13"),
      name: "Songkran (Day 1)",
      notes: null,
      entity: fakeEntity,
    },
    {
      id: "ph-2",
      date: new Date("2026-04-14"),
      name: "Songkran (Day 2)",
      notes: null,
      entity: fakeEntity,
    },
  ]);

  prismaMock.partner.findMany.mockResolvedValue([
    {
      id: "pt-acme",
      company: "Acme Corp",
      type: "vendor",
      status: "active",
      region: "APAC",
      country: "Thailand",
      website: "https://acme.example.com",
      contractValue: null,
      contractStart: null,
      contractEnd: null,
      description: "Trusted hardware supplier.",
      notes: null,
    },
  ]);

  prismaMock.project.findMany.mockResolvedValue([
    {
      id: "proj-atlas",
      name: "Atlas",
      slug: "atlas",
      status: "active",
      progress: 60,
      startDate: new Date("2026-01-01"),
      endDate: new Date("2026-12-31"),
      productionLiveDate: null,
      budget: null,
      description: "Internal platform rebuild.",
      owner: { name: "Alice Lee", email: "alice@example.com" },
      partner: { company: "Acme Corp" },
    },
  ]);

  prismaMock.companyPolicy.findMany.mockResolvedValue([
    {
      id: "cp-1",
      title: "Employee Handbook 2026",
      category: "handbook",
      description: "Master employee handbook.",
      fileName: "handbook-2026.pdf",
      version: "2026.1",
      effectiveDate: new Date("2026-01-01"),
      entity: { name: fakeEntity.name, code: fakeEntity.code },
    },
  ]);

  // Every upsert returns a deterministic id derived from slug so tests
  // can assert which rows passed through the writer.
  prismaMock.manutAiKnowledgeArticle.findUnique.mockResolvedValue(null);
  prismaMock.manutAiKnowledgeArticle.upsert.mockImplementation(
    async (args: { where: { slug: string } }) => ({
      id: `art-${args.where.slug}`,
    }),
  );
  prismaMock.manutAiKnowledgeArticle.updateMany.mockResolvedValue({ count: 0 });
});

// ── Tests ──────────────────────────────────────────────────────────

describe("ARIA auto-sync eval", () => {
  it("runs every source worker without errors", async () => {
    const report = await runAllSyncs();
    expect(report.errors).toHaveLength(0);
    expect(report.perSource.map((s) => s.source).sort()).toEqual(
      [
        "company-policy",
        "leave-type",
        "partner",
        "project",
        "public-holiday",
      ].sort(),
    );
    expect(report.perSource.every((s) => s.upserted >= 1)).toBe(true);
  });

  it("writes deterministic slugs per source", async () => {
    await runAllSyncs();
    const slugs = prismaMock.manutAiKnowledgeArticle.upsert.mock.calls.map(
      (call) => (call[0] as { where: { slug: string } }).where.slug,
    );
    expect(slugs).toContain("auto-leave-type-lt-annual");
    expect(slugs).toContain("auto-public-holiday-th-2026");
    expect(slugs).toContain("auto-partner-pt-acme");
    expect(slugs).toContain("auto-project-proj-atlas");
    expect(slugs).toContain("auto-company-policy-cp-1");
  });

  it("tags every upsert with auto-synced + source key", async () => {
    await runAllSyncs();
    for (const call of prismaMock.manutAiKnowledgeArticle.upsert.mock.calls) {
      const data = (
        call[0] as {
          create: { tags: string[]; slug: string };
        }
      ).create;
      expect(data.tags).toContain("auto-synced");
      expect(data.tags.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("gates partner/project articles with the right perm code", async () => {
    await runAllSyncs();
    const calls = prismaMock.manutAiKnowledgeArticle.upsert.mock.calls;
    const findCreate = (slug: string) => {
      const call = calls.find(
        (c) => (c[0] as { where: { slug: string } }).where.slug === slug,
      );
      return call
        ? (
            call[0] as {
              create: { requiredPermissions: string[] };
            }
          ).create.requiredPermissions
        : [];
    };
    expect(findCreate("auto-partner-pt-acme")).toEqual(["partners:read"]);
    expect(findCreate("auto-project-proj-atlas")).toEqual(["projects:read"]);
    expect(findCreate("auto-leave-type-lt-annual")).toEqual([]);
    expect(findCreate("auto-public-holiday-th-2026")).toEqual([]);
    expect(findCreate("auto-company-policy-cp-1")).toEqual([]);
  });

  it("buckets public holidays per entity-year", async () => {
    await runAllSyncs();
    const calls = prismaMock.manutAiKnowledgeArticle.upsert.mock.calls;
    const phCall = calls.find(
      (c) =>
        (c[0] as { where: { slug: string } }).where.slug ===
        "auto-public-holiday-th-2026",
    );
    expect(phCall).toBeTruthy();
    const data = (
      phCall![0] as {
        create: { body: string; title: string };
      }
    ).create;
    expect(data.title).toContain("2026");
    expect(data.body).toContain("Songkran (Day 1)");
    expect(data.body).toContain("Songkran (Day 2)");
  });
});
