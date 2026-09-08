import { Prisma } from "@nexora/database";

import { prisma } from "@/infrastructure/database/prisma";
import type { TraceExampleInput } from "@/modules/aria-training/dataset-format";
import { redactTrace } from "@/modules/aria-training/redaction";

/** Reduce a message's feedback rows to one training signal. */
function reduceRating(
  feedback: Array<{ rating: string; reason: string | null }>,
): { rating: "up" | "down" | null; reason: string | null } {
  const down = feedback.find((f) => f.rating === "down");
  if (down) return { rating: "down", reason: down.reason };
  const up = feedback.find((f) => f.rating === "up");
  if (up) return { rating: "up", reason: up.reason };
  return { rating: null, reason: null };
}

export const ariaTrainingRepository = {
  // ── Phase 2: redaction retention transform ──────────────────────
  /**
   * Redact a bounded batch of un-redacted traces older than the cutoff, in
   * place, flipping pii_redacted. Idempotent (redacted rows are excluded), so
   * the cron can run daily and converge.
   */
  async redactPendingTraces(
    olderThanDays: number,
    batchSize = 1000,
  ): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
    const pending = await prisma.manutAiInteractionTrace.findMany({
      where: { piiRedacted: false, createdAt: { lt: cutoff } },
      select: {
        id: true,
        userMessage: true,
        assistantText: true,
        toolCalls: true,
      },
      take: batchSize,
    });
    let redactedCount = 0;
    for (const t of pending) {
      const r = redactTrace({
        userMessage: t.userMessage,
        assistantText: t.assistantText,
        toolCalls: t.toolCalls,
      });
      await prisma.manutAiInteractionTrace.update({
        where: { id: t.id },
        data: {
          userMessage: r.userMessage,
          assistantText: r.assistantText,
          toolCalls: r.toolCalls as Prisma.InputJsonValue,
          piiRedacted: true,
        },
      });
      redactedCount += 1;
    }
    return redactedCount;
  },

  // ── Phase 2: dataset source ─────────────────────────────────────
  /**
   * Redacted traces (only) up to `until`, with their feedback rating joined
   * via the assistant message. Restricting to redacted + a frozen upper bound
   * makes a dataset build deterministic (append-only traces + idempotent
   * redaction below `until` never change).
   */
  async fetchRedactedTracesForDataset(opts: {
    until: Date;
    requirePermission?: string;
    limit?: number;
  }): Promise<TraceExampleInput[]> {
    const rows = await prisma.manutAiInteractionTrace.findMany({
      where: {
        piiRedacted: true,
        createdAt: { lte: opts.until },
        ...(opts.requirePermission
          ? { permissionsSnapshot: { has: opts.requirePermission } }
          : {}),
      },
      orderBy: { createdAt: "asc" },
      take: opts.limit ?? 50000,
      select: {
        id: true,
        conversationId: true,
        userMessage: true,
        assistantText: true,
        promptVersion: true,
        permissionsSnapshot: true,
        retrievedArticleIds: true,
        retrievedDistances: true,
        topDistance: true,
        toolNames: true,
        error: true,
        assistantMessage: {
          select: { feedback: { select: { rating: true, reason: true } } },
        },
      },
    });

    return rows.map((r) => {
      const { rating, reason } = reduceRating(
        r.assistantMessage?.feedback ?? [],
      );
      return {
        traceId: r.id,
        conversationId: r.conversationId,
        userMessage: r.userMessage,
        assistantText: r.assistantText,
        promptVersion: r.promptVersion,
        permissionsSnapshot: r.permissionsSnapshot,
        retrievedArticleIds: r.retrievedArticleIds,
        retrievedDistances: r.retrievedDistances,
        topDistance: r.topDistance,
        toolNames: r.toolNames,
        error: r.error,
        rating,
        feedbackReason: reason,
      };
    });
  },

  // ── Phase 2: dataset registry ───────────────────────────────────
  async nextDatasetVersion(kind: string): Promise<number> {
    const latest = await prisma.manutAiTrainingDataset.findFirst({
      where: { kind },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    return (latest?.version ?? 0) + 1;
  },

  async createDataset(input: {
    kind: string;
    version: number;
    rowCount: number;
    filters: Prisma.InputJsonValue;
    stats: Prisma.InputJsonValue;
    checksum: string;
    createdById: string | null;
  }) {
    return prisma.manutAiTrainingDataset.create({ data: input });
  },

  async listDatasets(kind?: string) {
    return prisma.manutAiTrainingDataset.findMany({
      where: kind ? { kind } : undefined,
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  },

  async getDataset(id: string) {
    return prisma.manutAiTrainingDataset.findUnique({ where: { id } });
  },

  // ── Phase 4: model-version registry ─────────────────────────────
  async createModelVersion(input: {
    name: string;
    baseModel: string;
    method: string;
    datasetId: string | null;
    externalRef: string | null;
    notes: string | null;
    createdById: string | null;
  }) {
    return prisma.manutAiModelVersion.create({ data: input });
  },

  async getModelVersion(id: string) {
    return prisma.manutAiModelVersion.findUnique({ where: { id } });
  },

  async listModelVersions(status?: string) {
    return prisma.manutAiModelVersion.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: "desc" },
      take: 200,
    });
  },

  async updateModelVersionStatus(
    id: string,
    status: string,
    evalSummary: unknown,
    promotedAt: Date | null,
  ) {
    return prisma.manutAiModelVersion.update({
      where: { id },
      data: {
        status,
        evalSummary: evalSummary as Prisma.InputJsonValue,
        promotedAt: promotedAt ?? undefined,
      },
    });
  },

  // ── Phase 5: monitoring read-model ──────────────────────────────
  async trainingMetrics(sinceDays: number) {
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
    const [agg, errorCount, feedback, distance] = await Promise.all([
      prisma.manutAiInteractionTrace.aggregate({
        where: { createdAt: { gte: since } },
        _count: { _all: true },
        _avg: { tokensIn: true, tokensOut: true, latencyMs: true },
        _sum: { toolUseCount: true },
      }),
      prisma.manutAiInteractionTrace.count({
        where: { createdAt: { gte: since }, error: true },
      }),
      prisma.manutAiFeedback.groupBy({
        by: ["rating"],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
      }),
      prisma.$queryRaw<Array<{ p50: number | null; p95: number | null }>>(
        Prisma.sql`
          SELECT
            percentile_cont(0.5) WITHIN GROUP (ORDER BY top_distance) AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY top_distance) AS p95
          FROM aria_interaction_traces
          WHERE created_at >= ${since} AND top_distance IS NOT NULL
        `,
      ),
    ]);

    const total = agg._count._all;
    const fb = { up: 0, down: 0 };
    for (const row of feedback) {
      if (row.rating === "up") fb.up = row._count._all;
      else if (row.rating === "down") fb.down = row._count._all;
    }

    return {
      sinceDays,
      totalTraces: total,
      errorRate: total > 0 ? errorCount / total : null,
      avgTokensIn: agg._avg.tokensIn,
      avgTokensOut: agg._avg.tokensOut,
      avgLatencyMs: agg._avg.latencyMs,
      totalToolCalls: agg._sum.toolUseCount ?? 0,
      feedback: fb,
      retrievalTopDistanceP50: distance[0]?.p50 ?? null,
      retrievalTopDistanceP95: distance[0]?.p95 ?? null,
    };
  },
};
