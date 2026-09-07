import { type Prisma } from "@nexora/database";

import { prisma } from "@/infrastructure/database/prisma";

export const ariaRepository = {
  async findConversations(userId: string) {
    return prisma.ariaConversation.findMany({
      where: { userId },
      include: { _count: { select: { messages: true } } },
      orderBy: { updatedAt: "desc" },
    });
  },

  async findConversationById(id: string) {
    return prisma.ariaConversation.findUnique({ where: { id } });
  },

  async findConversationWithMessages(id: string) {
    return prisma.ariaConversation.findUnique({
      where: { id },
      include: {
        messages: {
          orderBy: { createdAt: "asc" },
          include: { attachments: { orderBy: { createdAt: "asc" } } },
        },
      },
    });
  },

  // Window sized so a multi-turn back-and-forth keeps continuity in
  // the chat. 40 messages ≈ 20 user/assistant pairs — wide enough to
  // hold a long thread without bloating prompt tokens.
  async getRecentMessages(conversationId: string, take = 40) {
    const messages = await prisma.ariaMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: "desc" },
      take,
      include: { attachments: { orderBy: { createdAt: "asc" } } },
    });
    return messages.reverse();
  },

  /**
   * Older messages that have aged out of the verbatim window.
   * Returned in chronological order so the summariser can fold them
   * into a single block.
   */
  async getMessagesOlderThan(conversationId: string, beforeId: string) {
    const pivot = await prisma.ariaMessage.findUnique({
      where: { id: beforeId },
      select: { createdAt: true },
    });
    if (!pivot) return [];
    return prisma.ariaMessage.findMany({
      where: { conversationId, createdAt: { lt: pivot.createdAt } },
      orderBy: { createdAt: "asc" },
    });
  },

  async countMessagesOlderThan(conversationId: string, beforeId: string) {
    const pivot = await prisma.ariaMessage.findUnique({
      where: { id: beforeId },
      select: { createdAt: true },
    });
    if (!pivot) return 0;
    return prisma.ariaMessage.count({
      where: { conversationId, createdAt: { lt: pivot.createdAt } },
    });
  },

  async createConversation(userId: string, title: string) {
    return prisma.ariaConversation.create({ data: { userId, title } });
  },

  async updateConversationTimestamp(id: string) {
    return prisma.ariaConversation.update({
      where: { id },
      data: { updatedAt: new Date() },
    });
  },

  async updateConversationTitle(id: string, title: string) {
    return prisma.ariaConversation.update({
      where: { id },
      data: { title },
    });
  },

  async countMessages(conversationId: string) {
    return prisma.ariaMessage.count({ where: { conversationId } });
  },

  async deleteConversation(id: string) {
    await prisma.ariaMessage.deleteMany({ where: { conversationId: id } });
    return prisma.ariaConversation.delete({ where: { id } });
  },

  async addMessage(conversationId: string, role: string, content: string) {
    return prisma.ariaMessage.create({
      data: { conversationId, role, content },
    });
  },

  /**
   * Truncate a conversation by deleting `pivotMessageId` and every
   * message persisted after it. Used by the edit + retry flows so the
   * UI can rewrite history without leaving orphaned turns behind.
   * Returns the count of deleted rows.
   */
  async deleteMessagesFromInclusive(
    conversationId: string,
    pivotMessageId: string,
  ): Promise<number> {
    const pivot = await prisma.ariaMessage.findUnique({
      where: { id: pivotMessageId },
      select: { conversationId: true, createdAt: true },
    });
    if (!pivot || pivot.conversationId !== conversationId) return 0;
    const result = await prisma.ariaMessage.deleteMany({
      where: {
        conversationId,
        createdAt: { gte: pivot.createdAt },
      },
    });
    return result.count;
  },

  /** Last persisted user message in the conversation (or `null`). */
  async findLatestUserMessage(conversationId: string) {
    return prisma.ariaMessage.findFirst({
      where: { conversationId, role: "user" },
      orderBy: { createdAt: "desc" },
    });
  },

  async findMessageById(id: string) {
    return prisma.ariaMessage.findUnique({ where: { id } });
  },

  // ── Attachments ───────────────────────────────────────────────────

  async createAttachment(data: {
    userId: string;
    kind: string;
    name: string;
    mimeType: string;
    size: number;
    storageBucket: string;
    storagePath: string;
    extractedText?: string | null;
    status?: string;
  }) {
    return prisma.ariaAttachment.create({ data });
  },

  async findAttachmentById(id: string) {
    return prisma.ariaAttachment.findUnique({ where: { id } });
  },

  /**
   * Load the caller's attachments by id for a chat send. Scoped to the
   * uploader and to still-unlinked rows (messageId null) so a client can't
   * attach another user's file or re-use one already bound to a message.
   */
  async findUnlinkedAttachmentsForUser(ids: string[], userId: string) {
    if (ids.length === 0) return [];
    return prisma.ariaAttachment.findMany({
      where: { id: { in: ids }, userId, messageId: null },
    });
  },

  async linkAttachmentsToMessage(
    ids: string[],
    messageId: string,
    userId: string,
  ) {
    if (ids.length === 0) return;
    // Re-scope to owner + still-unlinked so the method is safe in isolation,
    // not just because the caller pre-validated.
    await prisma.ariaAttachment.updateMany({
      where: { id: { in: ids }, userId, messageId: null },
      data: { messageId },
    });
  },

  // ── Knowledge corpus ──────────────────────────────────────────────

  async findKnowledge(filters: {
    category?: string;
    isActive?: boolean;
    search?: string;
  }) {
    return prisma.ariaKnowledgeArticle.findMany({
      where: {
        ...(filters.category && { category: filters.category }),
        ...(filters.isActive !== undefined && { isActive: filters.isActive }),
        ...(filters.search && {
          OR: [
            { title: { contains: filters.search, mode: "insensitive" } },
            { body: { contains: filters.search, mode: "insensitive" } },
          ],
        }),
      },
      orderBy: [{ category: "asc" }, { title: "asc" }],
      include: {
        createdBy: { select: { id: true, name: true, email: true } },
      },
    });
  },

  async findKnowledgeById(id: string) {
    return prisma.ariaKnowledgeArticle.findUnique({
      where: { id },
      include: {
        createdBy: { select: { id: true, name: true, email: true } },
      },
    });
  },

  async createKnowledge(data: {
    category: string;
    title: string;
    slug: string;
    body: string;
    keywords: string[];
    tags: string[];
    requiredPermissions: string[];
    isActive: boolean;
    createdById?: string;
  }) {
    return prisma.ariaKnowledgeArticle.create({
      data,
      include: {
        createdBy: { select: { id: true, name: true, email: true } },
      },
    });
  },

  async updateKnowledge(
    id: string,
    data: Partial<{
      category: string;
      title: string;
      slug: string;
      body: string;
      keywords: string[];
      tags: string[];
      requiredPermissions: string[];
      isActive: boolean;
    }>,
  ) {
    return prisma.ariaKnowledgeArticle.update({
      where: { id },
      data,
      include: {
        createdBy: { select: { id: true, name: true, email: true } },
      },
    });
  },

  async deleteKnowledge(id: string) {
    return prisma.ariaKnowledgeArticle.delete({ where: { id } });
  },

  // Lightweight retrieval — used by chatStream. Pulls all active rows
  // and lets the service rank by keyword overlap. Volumes are tiny
  // (curated articles), so loading them all per chat is fine. Used as
  // a fallback when vector retrieval fails or the row has no
  // embedding yet.
  async findActiveKnowledgeForRetrieval() {
    return prisma.ariaKnowledgeArticle.findMany({
      where: { isActive: true },
      select: {
        id: true,
        category: true,
        title: true,
        body: true,
        keywords: true,
        requiredPermissions: true,
      },
    });
  },

  /**
   * Cosine-similarity nearest-neighbour search over the active rows
   * with embeddings. Lower distance = more similar; pgvector's `<=>`
   * returns cosine distance ∈ [0, 2]. Caller filters by distance
   * threshold + active flag.
   */
  async findKnowledgeByEmbedding(
    vectorLiteral: string,
    limit: number,
  ): Promise<
    Array<{
      id: string;
      category: string;
      title: string;
      body: string;
      distance: number;
      requiredPermissions: string[];
    }>
  > {
    return prisma.$queryRawUnsafe(
      `SELECT id, category, title, body, required_permissions AS "requiredPermissions",
              (embedding <=> $1::vector) AS distance
         FROM aria_knowledge_articles
        WHERE is_active = TRUE
          AND embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT $2`,
      vectorLiteral,
      limit,
    );
  },

  async setKnowledgeEmbedding(id: string, vectorLiteral: string) {
    await prisma.$executeRawUnsafe(
      `UPDATE aria_knowledge_articles
          SET embedding = $1::vector,
              updated_at = NOW()
        WHERE id = $2::uuid`,
      vectorLiteral,
      id,
    );
  },

  async findKnowledgeMissingEmbedding() {
    return prisma.$queryRawUnsafe<
      Array<{ id: string; title: string; body: string; keywords: string[] }>
    >(
      `SELECT id, title, body, keywords
         FROM aria_knowledge_articles
        WHERE embedding IS NULL`,
    );
  },

  // ── Conversation memory ───────────────────────────────────────────

  async getSummary(conversationId: string) {
    return prisma.ariaConversationSummary.findUnique({
      where: { conversationId },
    });
  },

  async upsertSummary(input: {
    conversationId: string;
    summary: string;
    coversThroughMessageId: string | null;
    messageCount: number;
    model: string;
  }) {
    return prisma.ariaConversationSummary.upsert({
      where: { conversationId: input.conversationId },
      create: {
        conversationId: input.conversationId,
        summary: input.summary,
        coversThroughMessageId: input.coversThroughMessageId,
        messageCount: input.messageCount,
        model: input.model,
      },
      update: {
        summary: input.summary,
        coversThroughMessageId: input.coversThroughMessageId,
        messageCount: input.messageCount,
        model: input.model,
      },
    });
  },

  async getMemory(conversationId: string) {
    return prisma.ariaConversationMemory.findMany({
      where: { conversationId },
      orderBy: { updatedAt: "desc" },
    });
  },

  async upsertMemoryEntries(
    conversationId: string,
    entries: Array<{ key: string; value: string }>,
  ) {
    if (entries.length === 0) return;
    await prisma.$transaction(
      entries.map((e) =>
        prisma.ariaConversationMemory.upsert({
          where: {
            conversationId_key: { conversationId, key: e.key },
          },
          create: { conversationId, key: e.key, value: e.value },
          update: { value: e.value },
        }),
      ),
    );
  },

  /**
   * Delete memory entries on this conversation whose value (or key)
   * contains `needle` (case-insensitive). Used by the
   * `aria_memory_forget` tool when the user says "forget …".
   * Returns the deleted entries so the tool can echo them back.
   */
  async deleteMemoryEntriesMatching(conversationId: string, needle: string) {
    const trimmed = needle.trim();
    if (!trimmed) return [];
    const found = await prisma.ariaConversationMemory.findMany({
      where: {
        conversationId,
        OR: [
          { key: { contains: trimmed, mode: "insensitive" } },
          { value: { contains: trimmed, mode: "insensitive" } },
        ],
      },
    });
    if (found.length === 0) return [];
    await prisma.ariaConversationMemory.deleteMany({
      where: { id: { in: found.map((f) => f.id) } },
    });
    return found.map((f) => ({ key: f.key, value: f.value }));
  },

  // ── Query telemetry ───────────────────────────────────────────────

  async recordQueryLog(input: {
    conversationId: string | null;
    userId: string;
    userMessage: string;
    retrievedArticleIds: string[];
    retrievedDistances: number[];
    topDistance: number | null;
    retrievalMode: string;
    workspaceBytes: number;
    knowledgeBytes: number;
    latencyMs: number;
    tokensIn: number | null;
    tokensOut: number | null;
    cacheReadTokens: number | null;
    cacheCreateTokens: number | null;
    model: string;
    error: boolean;
    errorMessage: string | null;
    toolUseCount?: number;
    toolNames?: string[];
  }) {
    return prisma.ariaQueryLog.create({
      data: {
        conversationId: input.conversationId,
        userId: input.userId,
        userMessage: input.userMessage,
        retrievedArticleIds: input.retrievedArticleIds,
        retrievedDistances: input.retrievedDistances,
        topDistance: input.topDistance ?? undefined,
        retrievalMode: input.retrievalMode,
        workspaceBytes: input.workspaceBytes,
        knowledgeBytes: input.knowledgeBytes,
        latencyMs: input.latencyMs,
        tokensIn: input.tokensIn ?? undefined,
        tokensOut: input.tokensOut ?? undefined,
        cacheReadTokens: input.cacheReadTokens ?? undefined,
        cacheCreateTokens: input.cacheCreateTokens ?? undefined,
        model: input.model,
        error: input.error,
        errorMessage: input.errorMessage ?? undefined,
        toolUseCount: input.toolUseCount ?? 0,
        toolNames: input.toolNames ?? [],
      },
    });
  },

  // ── Training-data trace (Phase 1) ─────────────────────────────────
  // Append-only full-turn capture. Best-effort caller; gated behind the
  // ARIA_TRACE_CAPTURE flag. Never joined into the live chat path.
  async recordInteractionTrace(input: {
    conversationId: string | null;
    userId: string;
    assistantMessageId: string | null;
    turnKind: string;
    promptVersion: string;
    model: string;
    maxTokens: number | null;
    userMessage: string;
    permissionsSnapshot: string[];
    offeredTools: string[];
    retrievedArticleIds: string[];
    retrievedDistances: number[];
    topDistance: number | null;
    retrievalMode: string;
    workspaceBytes: number;
    knowledgeBytes: number;
    assistantText: string;
    stopReason: string | null;
    toolCalls: unknown[];
    toolUseCount: number;
    toolNames: string[];
    tokensIn: number | null;
    tokensOut: number | null;
    cacheReadTokens: number | null;
    cacheCreateTokens: number | null;
    latencyMs: number;
    error: boolean;
    errorMessage: string | null;
  }) {
    return prisma.ariaInteractionTrace.create({
      data: {
        conversationId: input.conversationId,
        userId: input.userId,
        assistantMessageId: input.assistantMessageId,
        turnKind: input.turnKind,
        promptVersion: input.promptVersion,
        model: input.model,
        maxTokens: input.maxTokens ?? undefined,
        userMessage: input.userMessage,
        permissionsSnapshot: input.permissionsSnapshot,
        offeredTools: input.offeredTools,
        retrievedArticleIds: input.retrievedArticleIds,
        retrievedDistances: input.retrievedDistances,
        topDistance: input.topDistance ?? undefined,
        retrievalMode: input.retrievalMode,
        workspaceBytes: input.workspaceBytes,
        knowledgeBytes: input.knowledgeBytes,
        assistantText: input.assistantText,
        stopReason: input.stopReason ?? undefined,
        toolCalls: input.toolCalls as Prisma.InputJsonValue,
        toolUseCount: input.toolUseCount,
        toolNames: input.toolNames,
        tokensIn: input.tokensIn ?? undefined,
        tokensOut: input.tokensOut ?? undefined,
        cacheReadTokens: input.cacheReadTokens ?? undefined,
        cacheCreateTokens: input.cacheCreateTokens ?? undefined,
        latencyMs: input.latencyMs,
        error: input.error,
        errorMessage: input.errorMessage ?? undefined,
      },
    });
  },

  /**
   * Aggregate insights over the last `days` days. Powers the admin
   * insights page. Returns NDJSON-friendly shapes only (no Decimal /
   * BigInt).
   */
  async getQueryInsights(days: number) {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const [
      totals,
      latency,
      tokens,
      modeBreakdown,
      topEmptyQueries,
      recentErrors,
      toolStats,
      topTools,
    ] = await Promise.all([
      prisma.$queryRawUnsafe<
        Array<{ total: bigint; with_hits: bigint; errors: bigint }>
      >(
        `SELECT COUNT(*)::bigint AS total,
                COUNT(*) FILTER (WHERE cardinality(retrieved_article_ids) > 0)::bigint AS with_hits,
                COUNT(*) FILTER (WHERE error)::bigint AS errors
           FROM aria_query_logs
          WHERE created_at >= $1`,
        since,
      ),
      prisma.$queryRawUnsafe<
        Array<{ p50: number | null; p95: number | null; avg: number | null }>
      >(
        `SELECT
            percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)::double precision AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::double precision AS p95,
            AVG(latency_ms)::double precision AS avg
           FROM aria_query_logs
          WHERE created_at >= $1`,
        since,
      ),
      prisma.$queryRawUnsafe<
        Array<{
          tokens_in: number | null;
          tokens_out: number | null;
          cache_read: number | null;
          cache_create: number | null;
        }>
      >(
        `SELECT
            SUM(COALESCE(tokens_in,0))::double precision AS tokens_in,
            SUM(COALESCE(tokens_out,0))::double precision AS tokens_out,
            SUM(COALESCE(cache_read_tokens,0))::double precision AS cache_read,
            SUM(COALESCE(cache_create_tokens,0))::double precision AS cache_create
           FROM aria_query_logs
          WHERE created_at >= $1`,
        since,
      ),
      prisma.$queryRawUnsafe<Array<{ retrieval_mode: string; n: bigint }>>(
        `SELECT retrieval_mode, COUNT(*)::bigint AS n
           FROM aria_query_logs
          WHERE created_at >= $1
          GROUP BY retrieval_mode`,
        since,
      ),
      prisma.$queryRawUnsafe<
        Array<{ user_message: string; n: bigint; top_distance: number | null }>
      >(
        `SELECT user_message,
                COUNT(*)::bigint AS n,
                MIN(top_distance)::double precision AS top_distance
           FROM aria_query_logs
          WHERE created_at >= $1
            AND cardinality(retrieved_article_ids) = 0
            AND NOT error
          GROUP BY user_message
          ORDER BY n DESC, user_message ASC
          LIMIT 20`,
        since,
      ),
      prisma.$queryRawUnsafe<
        Array<{
          id: string;
          user_message: string;
          error_message: string | null;
          created_at: Date;
        }>
      >(
        `SELECT id, user_message, error_message, created_at
           FROM aria_query_logs
          WHERE created_at >= $1 AND error
          ORDER BY created_at DESC
          LIMIT 20`,
        since,
      ),
      prisma.$queryRawUnsafe<
        Array<{
          turns_with_tools: bigint;
          total_tool_invocations: bigint;
        }>
      >(
        `SELECT
            COUNT(*) FILTER (WHERE tool_use_count > 0)::bigint AS turns_with_tools,
            COALESCE(SUM(tool_use_count), 0)::bigint AS total_tool_invocations
           FROM aria_query_logs
          WHERE created_at >= $1`,
        since,
      ),
      prisma.$queryRawUnsafe<Array<{ tool: string; n: bigint }>>(
        `SELECT tool, COUNT(*)::bigint AS n
           FROM (
             SELECT unnest(tool_names) AS tool
               FROM aria_query_logs
              WHERE created_at >= $1
           ) AS t
          GROUP BY tool
          ORDER BY n DESC
          LIMIT 10`,
        since,
      ),
    ]);

    const t = totals[0] ?? { total: 0n, with_hits: 0n, errors: 0n };
    const total = Number(t.total);
    const withHits = Number(t.with_hits);
    const errors = Number(t.errors);
    const lat = latency[0] ?? { p50: null, p95: null, avg: null };
    const tk = tokens[0] ?? {
      tokens_in: 0,
      tokens_out: 0,
      cache_read: 0,
      cache_create: 0,
    };

    return {
      windowDays: days,
      since: since.toISOString(),
      total,
      withHits,
      hitRate: total > 0 ? withHits / total : null,
      errors,
      errorRate: total > 0 ? errors / total : null,
      latency: {
        p50: lat.p50 ?? null,
        p95: lat.p95 ?? null,
        avg: lat.avg ?? null,
      },
      tokens: {
        in: Number(tk.tokens_in ?? 0),
        out: Number(tk.tokens_out ?? 0),
        cacheRead: Number(tk.cache_read ?? 0),
        cacheCreate: Number(tk.cache_create ?? 0),
      },
      retrievalModes: modeBreakdown.map((m) => ({
        mode: m.retrieval_mode,
        count: Number(m.n),
      })),
      emptyRetrievalQueries: topEmptyQueries.map((q) => ({
        message: q.user_message,
        count: Number(q.n),
        topDistance: q.top_distance,
      })),
      recentErrors: recentErrors.map((r) => ({
        id: r.id,
        message: r.user_message,
        errorMessage: r.error_message,
        createdAt: r.created_at.toISOString(),
      })),
      tools: {
        turnsWithTools: Number(toolStats[0]?.turns_with_tools ?? 0),
        totalInvocations: Number(toolStats[0]?.total_tool_invocations ?? 0),
        topTools: topTools.map((t) => ({
          tool: t.tool,
          count: Number(t.n),
        })),
      },
    };
  },

  // ── Feedback (Phase 6) ────────────────────────────────────────────

  async upsertFeedback(input: {
    messageId: string;
    userId: string;
    rating: "up" | "down";
    reason: string | null;
  }) {
    return prisma.ariaFeedback.upsert({
      where: {
        messageId_userId: {
          messageId: input.messageId,
          userId: input.userId,
        },
      },
      create: {
        messageId: input.messageId,
        userId: input.userId,
        rating: input.rating,
        reason: input.reason,
      },
      update: {
        rating: input.rating,
        reason: input.reason,
        // Re-rating clears any prior admin review so the row pops back
        // into the queue if the user marks it down again.
        reviewed: false,
        reviewedById: null,
        reviewedAt: null,
        reviewNote: null,
      },
    });
  },

  async findFeedbackById(id: string) {
    return prisma.ariaFeedback.findUnique({
      where: { id },
      include: {
        message: {
          include: {
            conversation: { select: { id: true, userId: true, title: true } },
          },
        },
        user: { select: { id: true, name: true, email: true } },
      },
    });
  },

  /**
   * Admin improvement queue — un-reviewed thumbs-down feedback,
   * newest first. Includes the assistant message body and the
   * conversation title for context.
   */
  async findImprovementQueue(limit = 50) {
    return prisma.ariaFeedback.findMany({
      where: { rating: "down", reviewed: false },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: {
        message: {
          select: {
            id: true,
            content: true,
            createdAt: true,
            conversationId: true,
            conversation: { select: { title: true, userId: true } },
          },
        },
        user: { select: { id: true, name: true, email: true } },
      },
    });
  },

  async markFeedbackReviewed(input: {
    feedbackId: string;
    reviewedById: string;
    reviewNote: string | null;
    resultingArticleId: string | null;
  }) {
    return prisma.ariaFeedback.update({
      where: { id: input.feedbackId },
      data: {
        reviewed: true,
        reviewedById: input.reviewedById,
        reviewedAt: new Date(),
        reviewNote: input.reviewNote,
        resultingArticleId: input.resultingArticleId,
      },
    });
  },

  /**
   * Pull the user/assistant turn pair that produced a feedback row,
   * plus the immediately preceding user message (the question that
   * triggered the assistant reply). Used by the draft-article
   * generator so Haiku can see both Q and A.
   */
  async findFeedbackContext(feedbackId: string) {
    const feedback = await prisma.ariaFeedback.findUnique({
      where: { id: feedbackId },
      include: {
        message: {
          select: {
            id: true,
            content: true,
            createdAt: true,
            conversationId: true,
            role: true,
          },
        },
      },
    });
    if (!feedback) return null;
    const prior = await prisma.ariaMessage.findFirst({
      where: {
        conversationId: feedback.message.conversationId,
        role: "user",
        createdAt: { lt: feedback.message.createdAt },
      },
      orderBy: { createdAt: "desc" },
    });
    return { feedback, priorUserMessage: prior };
  },

  /**
   * Phase 1 follow-up: PII purge.
   *
   * `aria_query_logs.user_message` stores the verbatim turn so admins
   * can audit retrieval quality. CLAUDE.md's retention policy is
   * 30 days — past that the row stays (telemetry counts + tool names
   * are still useful) but the user-supplied content is redacted with
   * a sentinel string. Filtered by `user_message != sentinel` so re-
   * running is a cheap no-op once the corpus is fully redacted.
   */
  async purgePiiFromQueryLogs(retentionDays: number): Promise<number> {
    const sentinel = "[redacted by retention policy]";
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    const result = await prisma.ariaQueryLog.updateMany({
      where: {
        createdAt: { lt: cutoff },
        NOT: { userMessage: sentinel },
      },
      data: { userMessage: sentinel },
    });
    return result.count;
  },
};
