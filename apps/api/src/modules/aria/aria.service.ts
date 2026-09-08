import { createHash } from "node:crypto";

import type Anthropic from "@anthropic-ai/sdk";
import type { Response } from "express";

import { AI_PROMPTS } from "@/common/constants/ai-prompts";
import { PERMISSIONS } from "@/common/constants/permissions";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@/common/exceptions/http-exception";
import { logger } from "@/common/utils/logger";
import { loadUserPermissions } from "@/core/guards/auth.guard";
import {
  ANTHROPIC_MODELS,
  getAnthropicClient,
} from "@/infrastructure/ai/anthropic";
import { actorFromId, trackAriaResponseReceivedServer } from "@/lib/events";
import { ariaRepository } from "@/modules/aria/aria.repository";
import type {
  ChatInput,
  CreateConversationInput,
  CreateKnowledgeInput,
  KnowledgeQuery,
  UpdateKnowledgeInput,
} from "@/modules/aria/aria.validation";
import { ariaAttachmentService } from "@/modules/aria/aria-attachment.service";
import { buildAriaContext } from "@/modules/aria/aria-context";
import {
  articleEmbeddingInput,
  generateEmbedding,
  vectorLiteral,
} from "@/modules/aria/aria-embedding.service";
import {
  extractAndStoreMemory,
  loadMemoryBlock,
  loadSummaryBlock,
  maybeRegenerateSummary,
} from "@/modules/aria/aria-memory.service";
import { runAllSyncs } from "@/modules/aria/aria-sync.service";
import {
  executeTool,
  loadToolContext,
  toolDefinitionsFor,
} from "@/modules/aria/aria-tools";

type NdjsonLine =
  | { t: "meta"; conversationId: string }
  | { t: "delta"; text: string }
  | {
      t: "tool_use";
      id: string;
      name: string;
      status: "running" | "done" | "error";
      summary: string;
    }
  | {
      t: "done";
      message: {
        id: string;
        conversationId: string;
        role: "assistant";
        content: string;
        createdAt: string;
      };
    }
  | { t: "error"; message: string };

function writeNdjson(res: Response, line: NdjsonLine) {
  res.write(`${JSON.stringify(line)}\n`);
}

const TITLE_MAX_LEN = 72;

// Training-data capture (Phase 1). Full-turn traces are written best-effort,
// only when ARIA_TRACE_CAPTURE === "true" (fail-closed: unset = off).
const ARIA_TRACE_CAPTURE_FLAG = "ARIA_TRACE_CAPTURE";
// Short digest of the system prompt in force, so each trace is attributable to
// an exact prompt revision without inlining the whole prompt every turn.
const ARIA_PROMPT_VERSION = createHash("sha256")
  .update(AI_PROMPTS.ARIA_SYSTEM)
  .digest("hex")
  .slice(0, 12);
// Cap each captured tool-result payload so a large result can't bloat the row.
const TRACE_TOOL_RESULT_CAP = 8000;

function isTraceCaptureEnabled(): boolean {
  return process.env[ARIA_TRACE_CAPTURE_FLAG] === "true";
}

type TraceToolCall = {
  name: string;
  input: unknown;
  ok: boolean;
  isError: boolean;
  resultPreview: string;
};

function sanitizeConversationTitle(raw: string): string {
  const oneLine = raw.replace(/\s+/g, " ").trim();
  const noQuotes = oneLine.replace(/^["']|["']$/g, "").trim();
  return noQuotes.length > TITLE_MAX_LEN
    ? `${noQuotes.slice(0, TITLE_MAX_LEN - 1)}…`
    : noQuotes;
}

async function tryGenerateConversationTitle(
  firstUserMessage: string,
): Promise<string | null> {
  const trimmed = firstUserMessage.trim();
  if (!trimmed) return null;

  try {
    const anthropic = getAnthropicClient();
    const response = await anthropic.messages.create({
      model: ANTHROPIC_MODELS.TITLE,
      max_tokens: 48,
      system:
        "Reply with a single short conversation title only: at most 8 words, no quotation marks, no punctuation at the end, plain text.",
      messages: [
        {
          role: "user",
          content: `The user started a chat with this first message (may be long):\n\n${trimmed.slice(0, 800)}`,
        },
      ],
    });

    const block = response.content.find((b) => b.type === "text");
    const text = block && block.type === "text" ? block.text.trim() : "";
    if (!text) return null;
    const sanitized = sanitizeConversationTitle(text);
    return sanitized.length > 0 ? sanitized : null;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn(`ARIA title generation failed: ${detail}`);
    return null;
  }
}

/**
 * Citation payload surfaced to the FE. Aligned 1:1 with the `[N]`
 * markers the model is instructed to emit inline — so `n` here matches
 * the bracket number in the answer text. The FE renders these as a
 * footnote list at the end of the message with click-through to the
 * source article.
 */
export interface RetrievedCitation {
  n: number;
  id: string;
  title: string;
  category: string;
}

interface RetrievalResult {
  /** Final knowledge block injected into the system prompt, or `null` if no rows passed the gate. */
  block: string | null;
  /** Ids of rows that ended up in the prompt, in order. */
  injectedIds: string[];
  /** Cosine distances aligned 1:1 with `injectedIds`. NaN slot = keyword-only hit. */
  injectedDistances: number[];
  /** Lowest distance seen across the full candidate set (incl. filtered-out rows). */
  topDistance: number | null;
  /** "hybrid" = blended vector+keyword; "keyword" = vector unavailable; "none" = no rows. */
  mode: "hybrid" | "keyword" | "none";
  /** Citation metadata for the `aria-citations` block. Empty when nothing was injected. */
  citations: RetrievedCitation[];
}

// Hybrid retrieval weights. 0.7/0.3 favours semantic similarity but
// keeps a strong keyword signal so acronyms / policy codes ("IT-15",
// "SSF", "Manut") that vectors gloss over still surface.
const HYBRID_VECTOR_WEIGHT = 0.7;
const HYBRID_KEYWORD_WEIGHT = 0.3;
// Combined-score threshold (higher is better). Calibrated against the
// existing distance threshold so the corpus behaviour stays similar:
// a pure-vector hit at distance 0.40 maps to vectorScore=0.60 →
// hybridScore≥0.42 before keyword adds anything.
const HYBRID_SCORE_THRESHOLD = 0.42;

/**
 * Pull the top-K knowledge articles for the user's message and fold
 * them into the chat system prompt. Strategy:
 *
 * 1. Embed the message with Gemini text-embedding-004 and run
 *    cosine-distance KNN against the `aria_knowledge_articles`
 *    embedding column.
 * 2. If embedding fails (no API key, transient error) or returns no
 *    rows, fall back to the original keyword-overlap retriever so the
 *    chat path never degrades silently.
 */
/**
 * True when the article is retrievable for a user with `userPerms`.
 * Empty `requiredPermissions` = public to any signed-in user. Non-empty
 * = user must hold AT LEAST ONE of the listed codes (OR semantics).
 */
function isArticleVisibleTo(
  required: string[],
  userPerms: Set<string>,
): boolean {
  if (required.length === 0) return true;
  return required.some((code) => userPerms.has(code));
}

/**
 * Build the embedding query for retrieval. Follow-up turns like "tell
 * me more about that" or "and the timeline?" carry no topical
 * keywords on their own, so we prepend up to the last four prior user
 * turns before the new message. Total length is capped so a runaway
 * conversation doesn't blow past the embedder's input limit.
 */
export function buildRetrievalQuery(
  message: string,
  priorUserTurns: string[],
): string {
  const MAX_CHARS = 2000;
  const recent = priorUserTurns.slice(-4);
  const joined = [...recent, message]
    .map((m) => m.trim())
    .filter(Boolean)
    .join("\n");
  return joined.length > MAX_CHARS
    ? joined.slice(joined.length - MAX_CHARS)
    : joined;
}

/**
 * Hybrid retrieval — run vector + keyword in parallel, then blend
 * their scores into a single ranking. The previous design ran them
 * as fallbacks, so a question with strong keyword overlap but weak
 * semantic embedding ("SSF rate", "IT-15 chain") could miss the
 * canonical policy article entirely.
 *
 * Score (higher is better):
 *   hybridScore = 0.7 * vectorScore + 0.3 * keywordScore
 *   vectorScore  = 1 - cosineDistance   (∈ [0, 1] for distance ∈ [0, 1])
 *   keywordScore = sum(matched keyword char length) / longestKeywordSum
 *
 * Both signals are permission-scoped before they enter the blend.
 */
export async function retrieveKnowledgeContext(
  userId: string,
  message: string,
  maxArticles = 3,
  priorUserTurns: string[] = [],
): Promise<RetrievalResult> {
  const userPerms = await loadUserPermissions(userId);
  const query = buildRetrievalQuery(message, priorUserTurns);
  const lowerQuery = query.toLowerCase();

  // Pull both signals in parallel; either failing degrades to the
  // other rather than collapsing the whole retrieval.
  const [vectorOutcome, keywordOutcome] = await Promise.allSettled([
    (async () => {
      const embedding = await generateEmbedding(query);
      if (!embedding) return [];
      const literal = vectorLiteral(embedding);
      return ariaRepository.findKnowledgeByEmbedding(literal, maxArticles * 5);
    })(),
    ariaRepository.findActiveKnowledgeForRetrieval(),
  ]);

  const vectorRows =
    vectorOutcome.status === "fulfilled" ? vectorOutcome.value : [];
  const keywordRows =
    keywordOutcome.status === "fulfilled" ? keywordOutcome.value : [];

  if (vectorOutcome.status === "rejected") {
    logger.warn("ARIA vector retrieval failed (hybrid)", {
      err:
        vectorOutcome.reason instanceof Error
          ? vectorOutcome.reason.message
          : String(vectorOutcome.reason),
    });
  }
  if (keywordOutcome.status === "rejected") {
    logger.warn("ARIA keyword retrieval failed (hybrid)", {
      err:
        keywordOutcome.reason instanceof Error
          ? keywordOutcome.reason.message
          : String(keywordOutcome.reason),
    });
  }

  // No corpus at all → bail.
  if (vectorRows.length === 0 && keywordRows.length === 0) {
    return {
      block: null,
      injectedIds: [],
      injectedDistances: [],
      topDistance: null,
      mode: "none",
      citations: [],
    };
  }

  // Build the union of candidate articles keyed by id. Keep title /
  // category / body / requiredPermissions from whichever signal saw
  // the row first; vector rows already carry full row shape via the
  // raw SQL select, keyword rows from the active-for-retrieval query.
  interface Candidate {
    id: string;
    title: string;
    category: string;
    body: string;
    requiredPermissions: string[];
    keywords: string[];
    distance: number | null;
    vectorScore: number;
    keywordScore: number;
    hybridScore: number;
  }
  const byId = new Map<string, Candidate>();

  for (const r of vectorRows) {
    const distance = Number(r.distance);
    // Cosine distance > 1 means "no real similarity"; treat as 0 score.
    const vectorScore = Math.max(0, Math.min(1, 1 - distance));
    byId.set(r.id, {
      id: r.id,
      title: r.title,
      category: r.category,
      body: r.body,
      requiredPermissions: r.requiredPermissions,
      keywords: [],
      distance,
      vectorScore,
      keywordScore: 0,
      hybridScore: 0,
    });
  }

  // Compute keyword score for every retrievable article + add to the
  // union map if vector missed it.
  let maxKeywordScore = 0;
  for (const a of keywordRows) {
    let raw = 0;
    for (const kw of a.keywords) {
      const k = kw.toLowerCase().trim();
      if (!k) continue;
      if (lowerQuery.includes(k)) raw += k.length;
    }
    if (raw === 0 && lowerQuery.includes(a.title.toLowerCase())) raw = 5;
    if (raw === 0) continue;
    if (raw > maxKeywordScore) maxKeywordScore = raw;

    const existing = byId.get(a.id);
    if (existing) {
      existing.keywords = a.keywords;
      existing.keywordScore = raw;
    } else {
      byId.set(a.id, {
        id: a.id,
        title: a.title,
        category: a.category,
        body: a.body,
        requiredPermissions: a.requiredPermissions,
        keywords: a.keywords,
        distance: null,
        vectorScore: 0,
        keywordScore: raw,
        hybridScore: 0,
      });
    }
  }

  // Normalise keyword scores to [0, 1] using the max raw score seen
  // this turn — so two questions with very different keyword densities
  // both have a fair shot at the threshold.
  const candidates = Array.from(byId.values()).filter((c) =>
    isArticleVisibleTo(c.requiredPermissions, userPerms),
  );
  for (const c of candidates) {
    const normKeyword =
      maxKeywordScore > 0 ? c.keywordScore / maxKeywordScore : 0;
    c.hybridScore =
      HYBRID_VECTOR_WEIGHT * c.vectorScore +
      HYBRID_KEYWORD_WEIGHT * normKeyword;
  }

  candidates.sort((a, b) => b.hybridScore - a.hybridScore);

  const topDistance =
    vectorRows.length > 0 ? Number(vectorRows[0].distance) : null;
  // Keyword-only fallback (vector unavailable) skips the hybrid
  // threshold — the keyword path historically had no minimum score,
  // just topK by raw overlap, and the eval suite encodes that
  // expectation. Vector + keyword blend retains the threshold so a
  // weak match doesn't sneak into the prompt.
  const usingHybridBlend = vectorRows.length > 0;
  const selected = candidates
    .filter((c) =>
      usingHybridBlend
        ? c.hybridScore >= HYBRID_SCORE_THRESHOLD
        : c.keywordScore > 0,
    )
    .slice(0, maxArticles);

  if (selected.length === 0) {
    // Near-miss telemetry — surface the top 3 candidates that fell
    // below threshold so admins can tune.
    const nearMiss = candidates.slice(0, 3);
    if (nearMiss.length > 0) {
      logger.warn("ARIA hybrid retrieval near-miss", {
        threshold: HYBRID_SCORE_THRESHOLD,
        candidates: nearMiss.map((c) => ({
          id: c.id,
          title: c.title,
          hybrid: c.hybridScore.toFixed(3),
          vector: c.vectorScore.toFixed(3),
          keyword: c.keywordScore.toFixed(1),
        })),
      });
    }
    return {
      block: null,
      injectedIds: [],
      injectedDistances: [],
      topDistance,
      mode: vectorRows.length > 0 ? "hybrid" : "keyword",
      citations: [],
    };
  }

  // Number each article so the model can cite with `[N]` markers that
  // line up 1:1 with the `aria-citations` block we ship to the FE.
  const blocks = selected.map(
    (c, idx) => `[${idx + 1}] ### ${c.title} (${c.category})\n${c.body.trim()}`,
  );
  const citations: RetrievedCitation[] = selected.map((c, idx) => ({
    n: idx + 1,
    id: c.id,
    title: c.title,
    category: c.category,
  }));
  return {
    block: `KNOWLEDGE BASE — relevant articles for this question (cite each fact you use with the bracketed number):\n\n${blocks.join("\n\n---\n\n")}`,
    injectedIds: selected.map((c) => c.id),
    // Distance still in [0,1] for vector-hit slots; NaN sentinel for
    // keyword-only hits so telemetry can tell them apart.
    injectedDistances: selected.map((c) =>
      c.distance === null ? Number.NaN : c.distance,
    ),
    topDistance,
    mode: vectorRows.length > 0 ? "hybrid" : "keyword",
    citations,
  };
}

export const ariaService = {
  async listConversations(userId: string) {
    const conversations = await ariaRepository.findConversations(userId);
    return { data: conversations };
  },

  /**
   * Execute a draft-and-confirm write tool after the user clicks
   * Approve in chat. Token is HMAC-signed by the tool that produced
   * it and carries the action + params verbatim — no DB round-trip
   * needed to pull the draft. Action dispatch is centralised here
   * so write tools never reach into module services directly.
   */
  async confirmAction(actorId: string, token: string) {
    const { verifyActionToken, consumeJti } =
      await import("@/modules/aria/aria-action-tokens");
    const body = verifyActionToken<Record<string, unknown>>(token);
    if (!body) {
      throw new ConflictException(
        "Invalid or expired confirmation token. Ask Manut AI to draft the action again.",
      );
    }
    if (body.userId !== actorId) {
      // Tokens are scoped to the user that drafted them. Same person
      // who saw the `aria-confirm` block must click Approve.
      throw new ConflictException(
        "This confirmation belongs to a different user.",
      );
    }
    // One-shot replay gate. The signature + exp protects against
    // forged tokens but not against a user double-clicking Approve
    // (or a transient 500 leaving the FE in a state where the user
    // clicks again). Two clicks within the 10-minute window would
    // otherwise create two leave requests against the same balance.
    if (!consumeJti(body.jti, body.exp * 1000)) {
      throw new ConflictException(
        "This confirmation has already been processed.",
      );
    }
    if (body.action === "submit_leave_request") {
      const { leaveService } = await import("@/modules/leave/leave.service");
      // Re-load permissions at confirm time so a stale role change
      // since the draft was generated doesn't let a now-revoked perm
      // slip through.
      const perms = await loadUserPermissions(actorId);
      const params = body.params as {
        leaveTypeId: string;
        startDate: string;
        endDate: string;
        reason?: string;
      };
      const result = await leaveService.createRequest(actorId, [...perms], {
        leaveTypeId: params.leaveTypeId,
        startDate: params.startDate,
        endDate: params.endDate,
        reason: params.reason,
        source: "entitled",
      });
      return { action: body.action, result };
    }
    throw new ConflictException(`Unknown Manut AI action: ${body.action}`);
  },

  async getConversation(userId: string, conversationId: string) {
    const conversation =
      await ariaRepository.findConversationWithMessages(conversationId);
    if (!conversation) throw new NotFoundException("Conversation not found");
    if (conversation.userId !== userId) {
      throw new ForbiddenException("Access denied");
    }
    return { data: conversation };
  },

  async createConversation(userId: string, input: CreateConversationInput) {
    const title = input.title ?? "New conversation";
    const conversation = await ariaRepository.createConversation(userId, title);
    return { data: conversation };
  },

  async deleteConversation(userId: string, conversationId: string) {
    const conversation =
      await ariaRepository.findConversationById(conversationId);
    if (!conversation) throw new NotFoundException("Conversation not found");
    if (conversation.userId !== userId) {
      throw new ForbiddenException("Access denied");
    }
    await ariaRepository.deleteConversation(conversationId);
    return { success: true };
  },

  // ── Knowledge corpus CRUD (admin only) ────────────────────────────

  async listKnowledge(query: KnowledgeQuery) {
    const data = await ariaRepository.findKnowledge(query);
    return { data };
  },

  async getKnowledgeById(id: string, viewerPermissions?: string[]) {
    const article = await ariaRepository.findKnowledgeById(id);
    if (!article) throw new NotFoundException("Knowledge article not found");
    // When `viewerPermissions` is supplied the caller is a regular ARIA
    // user (not a knowledge-manage admin) following a citation link.
    // Enforce the article's own permission ACL so private articles
    // don't leak through the citation route. Admins skip this check
    // (they call the method without the arg).
    if (viewerPermissions !== undefined) {
      const viewerPerms = new Set(viewerPermissions);
      const required = article.requiredPermissions ?? [];
      const allowed =
        required.length === 0 ||
        required.some((code) => viewerPerms.has(code)) ||
        viewerPerms.has(PERMISSIONS.ARIA_KNOWLEDGE_MANAGE);
      if (!allowed) {
        throw new ForbiddenException(
          "You do not have permission to view this knowledge article",
        );
      }
    }
    return { data: article };
  },

  async createKnowledge(input: CreateKnowledgeInput, createdById: string) {
    const existing = await ariaRepository.findKnowledge({});
    if (existing.some((a) => a.slug === input.slug)) {
      throw new ConflictException(
        `An article already exists with slug "${input.slug}"`,
      );
    }
    const article = await ariaRepository.createKnowledge({
      category: input.category,
      title: input.title,
      slug: input.slug,
      body: input.body,
      keywords: input.keywords ?? [],
      tags: input.tags ?? [],
      requiredPermissions: input.requiredPermissions ?? [],
      isActive: input.isActive ?? true,
      createdById,
    });
    // Best-effort embedding. Failure here is logged inside
    // `generateEmbedding` and intentionally doesn't fail the create —
    // chat retrieval falls back to the keyword index.
    void this.embedKnowledgeArticle(article.id, {
      title: article.title,
      body: article.body,
      keywords: article.keywords,
    });
    return { data: article };
  },

  async updateKnowledge(id: string, input: UpdateKnowledgeInput) {
    const existing = await ariaRepository.findKnowledgeById(id);
    if (!existing) throw new NotFoundException("Knowledge article not found");
    if (input.slug && input.slug !== existing.slug) {
      const all = await ariaRepository.findKnowledge({});
      if (all.some((a) => a.slug === input.slug && a.id !== id)) {
        throw new ConflictException(
          `Another article already uses slug "${input.slug}"`,
        );
      }
    }
    const article = await ariaRepository.updateKnowledge(id, input);
    // Re-embed if any field that drives retrieval changed. Body /
    // title / keywords are the inputs; slug / tags / isActive aren't
    // worth a re-embed.
    const changedFields =
      input.title !== undefined ||
      input.body !== undefined ||
      input.keywords !== undefined;
    if (changedFields) {
      void this.embedKnowledgeArticle(article.id, {
        title: article.title,
        body: article.body,
        keywords: article.keywords,
      });
    }
    return { data: article };
  },

  /**
   * Background embedding helper. Generates the vector and writes it
   * via raw SQL. Errors are swallowed to logs — keyword fallback
   * keeps the chat working even if the model is briefly unavailable.
   */
  async embedKnowledgeArticle(
    id: string,
    article: { title: string; body: string; keywords: string[] },
  ) {
    try {
      const text = articleEmbeddingInput(article);
      const vec = await generateEmbedding(text);
      if (!vec) return;
      await ariaRepository.setKnowledgeEmbedding(id, vectorLiteral(vec));
    } catch (err) {
      logger.warn("ARIA article embed failed", {
        id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  },

  /**
   * Admin endpoint hook — backfill embeddings for any active article
   * that doesn't have one yet (e.g. seeded rows from the migration).
   * Returns counts so the UI can surface progress.
   */
  async reindexKnowledgeEmbeddings() {
    const rows = await ariaRepository.findKnowledgeMissingEmbedding();
    let succeeded = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        const text = articleEmbeddingInput({
          title: row.title,
          body: row.body,
          keywords: row.keywords,
        });
        const vec = await generateEmbedding(text);
        if (!vec) {
          failed += 1;
          continue;
        }
        await ariaRepository.setKnowledgeEmbedding(row.id, vectorLiteral(vec));
        succeeded += 1;
      } catch (err) {
        logger.warn("ARIA reindex row failed", {
          id: row.id,
          err: err instanceof Error ? err.message : String(err),
        });
        failed += 1;
      }
    }
    return { data: { processed: rows.length, succeeded, failed } };
  },

  async deleteKnowledge(id: string) {
    const existing = await ariaRepository.findKnowledgeById(id);
    if (!existing) throw new NotFoundException("Knowledge article not found");
    await ariaRepository.deleteKnowledge(id);
    return { data: { id } };
  },

  /**
   * Aggregate ARIA chat telemetry for the admin insights page. Gated
   * by `aria:knowledge-manage` at the controller layer.
   */
  async getInsights(days: number) {
    const data = await ariaRepository.getQueryInsights(days);
    return { data };
  },

  /**
   * Phase 4 — run every auto-sync worker against the operational
   * tables (leave types, public holidays, partners, projects, company
   * policies). Returns per-source counts. Gated by
   * `aria:knowledge-manage` at the controller layer.
   */
  async runKnowledgeSync() {
    const report = await runAllSyncs();
    return { data: report };
  },

  // ── Feedback / improvement queue (Phase 6) ──────────────────────

  /**
   * Persist a thumbs rating from the caller on a specific ARIA
   * message. Validates the message exists and belongs to a
   * conversation the caller owns. Returns the upserted row.
   */
  async recordFeedback(
    userId: string,
    input: { messageId?: string; rating?: "up" | "down"; reason?: string },
  ) {
    if (!input.messageId || !input.rating) {
      throw new NotFoundException("messageId and rating are required");
    }
    const message = await ariaRepository.findMessageById(input.messageId);
    if (!message) throw new NotFoundException("Message not found");
    if (message.role !== "assistant") {
      throw new ForbiddenException("Only assistant messages can be rated");
    }
    const conversation = await ariaRepository.findConversationById(
      message.conversationId,
    );
    if (!conversation) throw new NotFoundException("Conversation not found");
    if (conversation.userId !== userId) {
      throw new ForbiddenException("Access denied");
    }
    const row = await ariaRepository.upsertFeedback({
      messageId: input.messageId,
      userId,
      rating: input.rating,
      reason: input.reason ? input.reason.trim() || null : null,
    });
    return { data: row };
  },

  /**
   * Admin: open improvement queue. Returns un-reviewed thumbs-down
   * feedback rows in newest-first order so admins can triage live
   * pain points. Gated by `aria:knowledge-manage` at the controller.
   */
  async getImprovementQueue() {
    const data = await ariaRepository.findImprovementQueue(50);
    return { data };
  },

  /**
   * Admin: mark a feedback row reviewed. Optional `reviewNote` for
   * the audit trail and optional `resultingArticleId` to close the
   * loop when the feedback drove a new knowledge article.
   */
  async reviewFeedback(
    actorId: string,
    feedbackId: string,
    input: { reviewNote?: string; resultingArticleId?: string },
  ) {
    const existing = await ariaRepository.findFeedbackById(feedbackId);
    if (!existing) throw new NotFoundException("Feedback not found");
    const row = await ariaRepository.markFeedbackReviewed({
      feedbackId,
      reviewedById: actorId,
      reviewNote: input.reviewNote?.trim() || null,
      resultingArticleId: input.resultingArticleId ?? null,
    });
    return { data: row };
  },

  /**
   * Admin: ask Haiku to draft a knowledge article from a feedback
   * row's context (question + ARIA's flagged answer + reviewer note).
   * Returns a draft `{title, slug, body, category, keywords, requiredPermissions}`
   * that the admin then reviews + posts through the existing
   * `POST /aria/knowledge` create route.
   *
   * The draft is **not** persisted by this endpoint — humans stay in
   * the loop, the LLM only suggests.
   */
  async draftArticleFromFeedback(feedbackId: string) {
    const ctx = await ariaRepository.findFeedbackContext(feedbackId);
    if (!ctx) throw new NotFoundException("Feedback not found");
    const { feedback, priorUserMessage } = ctx;

    const question =
      priorUserMessage?.content?.trim() ||
      "[no preceding user question recorded]";
    const flaggedAnswer = feedback.message.content.trim();
    const reason = feedback.reason?.trim() ?? "";

    try {
      const anthropic = getAnthropicClient();
      const response = await anthropic.messages.create({
        model: ANTHROPIC_MODELS.TITLE,
        max_tokens: 1500,
        system: [
          "You draft internal knowledge-base articles for Manut AI, the assistant inside the Manut intranet.",
          "Input: a user question + the assistant reply that received thumbs-down + the user's optional reason.",
          'Output: a JSON object with shape {"title": string (<= 80 chars), "slug": string (lowercase a-z0-9 + hyphens, <= 60 chars), "category": one of "immigration" | "hr" | "finance" | "policy" | "other", "body": string (<= 4000 chars, markdown, written as a definitive policy / how-to — NOT as a chat reply), "keywords": string[] (3-8 short retrieval hints)}.',
          "Rules:",
          "- Do not echo the chat conversation. Write the article from a Manut HR / Ops voice, present tense, third person.",
          "- If the input is ambiguous or you would have to invent facts, set `body` to a one-line note asking the admin to supply the source data, and keep the other fields as best-effort scaffolding.",
          "- Output JSON only. No markdown fences, no prose around the object.",
        ].join("\n"),
        messages: [
          {
            role: "user",
            content: [
              `User question:\n${question}`,
              `ARIA reply that received thumbs-down:\n${flaggedAnswer}`,
              reason
                ? `User reason for thumbs-down:\n${reason}`
                : "User reason: (none provided)",
            ].join("\n\n"),
          },
        ],
      });

      const block = response.content.find((b) => b.type === "text");
      const raw = block && block.type === "text" ? block.text.trim() : "";
      const cleaned = raw
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/```\s*$/, "")
        .trim();
      const parsed = JSON.parse(cleaned) as Record<string, unknown>;

      const draft = {
        title:
          typeof parsed.title === "string"
            ? parsed.title.slice(0, 200)
            : "Untitled",
        slug:
          typeof parsed.slug === "string"
            ? parsed.slug
                .toLowerCase()
                .replace(/[^a-z0-9-]+/g, "-")
                .replace(/^-+|-+$/g, "")
                .slice(0, 60) || `draft-${feedbackId.slice(0, 8)}`
            : `draft-${feedbackId.slice(0, 8)}`,
        category:
          typeof parsed.category === "string" &&
          ["immigration", "hr", "finance", "policy", "other"].includes(
            parsed.category,
          )
            ? parsed.category
            : "other",
        body:
          typeof parsed.body === "string"
            ? parsed.body.slice(0, 4000)
            : "Admin: please provide the policy text for this topic.",
        keywords: Array.isArray(parsed.keywords)
          ? parsed.keywords
              .filter((k): k is string => typeof k === "string")
              .map((k) => k.trim())
              .filter(Boolean)
              .slice(0, 8)
          : [],
        requiredPermissions: [] as string[],
      };
      return { data: { feedbackId, draft } };
    } catch (err) {
      logger.warn("ARIA draft-article generation failed", {
        feedbackId,
        err: err instanceof Error ? err.message : String(err),
      });
      throw new NotFoundException(
        "Could not draft an article — Anthropic call failed or returned malformed JSON.",
      );
    }
  },

  /**
   * Redacts the user-supplied prompt text on aged `aria_query_logs`
   * rows. CLAUDE.md retention policy: 30 days (`ARIA_PII_RETENTION_DAYS`
   * overrides). Telemetry counts (latency, tokens, tool names, etc.)
   * stay intact for trend reporting — only the free-text user message
   * is redacted.
   */
  async runPiiPurge() {
    const envValue = process.env.ARIA_PII_RETENTION_DAYS;
    const parsed = envValue ? Number.parseInt(envValue, 10) : NaN;
    const retentionDays = Number.isInteger(parsed) && parsed > 0 ? parsed : 30;
    const redacted = await ariaRepository.purgePiiFromQueryLogs(retentionDays);
    return { data: { redacted, retentionDays } };
  },

  /**
   * Streams assistant output as NDJSON: `meta` → `delta`* → `done` | `error`.
   * Must not throw after the first byte is written; use `next()` only when
   * headers have not been sent yet.
   */
  async chatStream(userId: string, input: ChatInput, res: Response) {
    const startedAt = Date.now();
    let streamErrored = false;
    let streamErrorMessage: string | null = null;
    let streaming = false;

    const beginStream = () => {
      if (streaming) return;
      streaming = true;
      res.status(200);
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      if (typeof res.flushHeaders === "function") {
        res.flushHeaders();
      }
    };

    let conversationId = input.conversationId;
    let isNewConversation = false;

    if (conversationId) {
      const existing =
        await ariaRepository.findConversationById(conversationId);
      if (!existing) throw new NotFoundException("Conversation not found");
      if (existing.userId !== userId) {
        throw new ForbiddenException("Access denied");
      }
    } else {
      // Plain send only. Schema rejects edit/retry without a
      // conversationId so `input.message` is guaranteed here.
      isNewConversation = true;
      const seed = input.message ?? "";
      const provisionalTitle =
        seed.slice(0, 60) + (seed.length > 60 ? "..." : "");
      const conversation = await ariaRepository.createConversation(
        userId,
        provisionalTitle,
      );
      conversationId = conversation.id;
    }

    // ── Attachments (upload-first) ───────────────────────────────
    // Validate + load the caller's unlinked attachments now; they're
    // bound to the user message once it's created below. A mismatch
    // (unknown / already-linked / other-user id) fails the whole send.
    const attachmentIds = input.attachmentIds ?? [];
    if (attachmentIds.length > 0) {
      const found = await ariaRepository.findUnlinkedAttachmentsForUser(
        attachmentIds,
        userId,
      );
      if (found.length !== attachmentIds.length) {
        throw new BadRequestException(
          "One or more attachments could not be found or are already in use.",
        );
      }
    }
    const linkAttachments = async (messageId: string) => {
      if (attachmentIds.length > 0) {
        await ariaRepository.linkAttachmentsToMessage(
          attachmentIds,
          messageId,
          userId,
        );
      }
    };

    // ── Edit / retry handling ────────────────────────────────────
    //
    // Both flows share a "truncate from pivot inclusive" primitive
    // and diverge on what comes next:
    //   - edit  → append the new user message and stream a reply
    //   - retry → leave the prior user message in place and stream
    //             a fresh reply from existing history
    //
    // The pivot's role is validated so a client can't, for instance,
    // pass an assistant message id as an "edit" target and rewrite
    // assistant text directly.
    let effectiveMessage: string;
    if (input.editMessageId) {
      const pivot = await ariaRepository.findMessageById(input.editMessageId);
      if (!pivot || pivot.conversationId !== conversationId) {
        throw new NotFoundException("Message to edit not found");
      }
      if (pivot.role !== "user") {
        throw new ForbiddenException("Only user messages can be edited");
      }
      if (!input.message) {
        // Validation should have caught this; keep a runtime guard so
        // the type narrows cleanly below.
        throw new NotFoundException("message is required for edit");
      }
      await ariaRepository.deleteMessagesFromInclusive(
        conversationId,
        input.editMessageId,
      );
      const editedMsg = await ariaRepository.addMessage(
        conversationId,
        "user",
        input.message,
      );
      await linkAttachments(editedMsg.id);
      effectiveMessage = input.message;
    } else if (input.retryAssistantMessageId) {
      const pivot = await ariaRepository.findMessageById(
        input.retryAssistantMessageId,
      );
      if (!pivot || pivot.conversationId !== conversationId) {
        throw new NotFoundException("Message to retry not found");
      }
      if (pivot.role !== "assistant") {
        throw new ForbiddenException("Only assistant messages can be retried");
      }
      await ariaRepository.deleteMessagesFromInclusive(
        conversationId,
        input.retryAssistantMessageId,
      );
      const lastUser =
        await ariaRepository.findLatestUserMessage(conversationId);
      if (!lastUser) {
        throw new NotFoundException(
          "Cannot retry: no prior user message in this conversation",
        );
      }
      effectiveMessage = lastUser.content;
    } else {
      if (!input.message && attachmentIds.length === 0) {
        throw new NotFoundException("message is required");
      }
      const messageBody = input.message ?? "";
      const userMsg = await ariaRepository.addMessage(
        conversationId,
        "user",
        messageBody,
      );
      await linkAttachments(userMsg.id);
      // Feed a sensible embedding/title seed when the turn is attachments-only.
      effectiveMessage =
        input.message ?? "(shared file for Manut AI to review)";
    }

    beginStream();
    writeNdjson(res, { t: "meta", conversationId });

    const ac = new AbortController();
    const onClose = () => ac.abort();
    res.on("close", onClose);

    const configFallback =
      "Manut AI is not yet configured. Please ask your administrator to set the ANTHROPIC_API_KEY environment variable.";
    const genericFallback =
      "I encountered an error while processing your request. Please try again.";

    let accumulated = "";

    // Telemetry collected through the turn; written to
    // `aria_query_logs` in the post-stream finally block. Best-effort.
    let workspaceBytes = 0;
    let knowledgeBytes = 0;
    let retrieval: RetrievalResult = {
      block: null,
      injectedIds: [],
      injectedDistances: [],
      topDistance: null,
      mode: "none",
      citations: [],
    };
    let tokensIn: number | null = null;
    let tokensOut: number | null = null;
    let cacheReadTokens: number | null = null;
    let cacheCreateTokens: number | null = null;
    const toolUsage: Array<{ name: string; ok: boolean; summary: string }> = [];
    // Trace-only accumulators (Phase 1). Captured every turn but persisted only
    // when the capture flag is on; hoisted to function scope so the post-stream
    // emit (which needs the assistant message id) can read them.
    const traceToolCalls: TraceToolCall[] = [];
    let tracePerms: string[] = [];
    let traceOfferedTools: string[] = [];
    let traceStopReason: string | null = null;
    let traceMaxTokens: number | null = null;

    try {
      const anthropic = getAnthropicClient();

      // Fetch history *before* retrieval so we can feed prior user
      // turns into the embedding query. `getRecentMessages` already
      // includes the message we just appended, so we drop the trailing
      // user message to leave only the actual prior context.
      const history = await ariaRepository.getRecentMessages(conversationId);
      const priorUserTurns = history
        .slice(0, -1)
        .filter((m) => m.role === "user")
        .map((m) => m.content);

      const [workspaceContext, summaryBlock, memoryBlock] = await Promise.all([
        buildAriaContext(userId),
        loadSummaryBlock(conversationId),
        loadMemoryBlock(conversationId),
      ]);
      retrieval = await retrieveKnowledgeContext(
        userId,
        effectiveMessage,
        3,
        priorUserTurns,
      );
      workspaceBytes = Buffer.byteLength(workspaceContext, "utf8");
      knowledgeBytes = retrieval.block
        ? Buffer.byteLength(retrieval.block, "utf8")
        : 0;

      // Anthropic prompt caching: send `system` as an array of blocks so
      // we can mark the static ARIA_SYSTEM prompt (and the per-user
      // workspace snapshot) as cacheable. Cache breakpoints are
      // ephemeral (~5 min TTL) which matches typical chat-session burst
      // patterns. Summary + memory blocks change per conversation —
      // also cacheable per-conversation. Knowledge block stays uncached
      // because it changes per turn based on retrieval.
      const systemBlocks: Array<{
        type: "text";
        text: string;
        cache_control?: { type: "ephemeral" };
      }> = [
        {
          type: "text",
          text: AI_PROMPTS.ARIA_SYSTEM,
          cache_control: { type: "ephemeral" },
        },
        {
          type: "text",
          text: workspaceContext,
          cache_control: { type: "ephemeral" },
        },
      ];
      if (summaryBlock) {
        systemBlocks.push({
          type: "text",
          text: summaryBlock,
          cache_control: { type: "ephemeral" },
        });
      }
      if (memoryBlock) {
        systemBlocks.push({
          type: "text",
          text: memoryBlock,
          cache_control: { type: "ephemeral" },
        });
      }
      if (retrieval.block) {
        systemBlocks.push({ type: "text", text: retrieval.block });
      }

      // Only re-inline image bytes for the most recent turns; older image
      // attachments degrade to a text note (see buildAttachmentBlocks) so a
      // long thread doesn't re-upload every picture every turn.
      const IMAGE_INLINE_RECENT = 6;
      // Content blocks come from buildAttachmentBlocks as `unknown[]` (the
      // attachment pipeline stays deliberately loose), and later turns are
      // pushed with SDK content-block arrays, so the element type stays loose
      // and the array is cast to the SDK's MessageParam[] at the stream call
      // below — runtime correctness is enforced by the Anthropic SDK.
      type ChatTurn = {
        role: "user" | "assistant";
        content: string | unknown[];
      };
      const messages: ChatTurn[] = await Promise.all(
        history.map(async (m, i) => {
          const role =
            m.role === "assistant" ? ("assistant" as const) : ("user" as const);
          // A user turn with attachments becomes a content-block array:
          // the file blocks (image/text) first, then the typed text.
          const atts = "attachments" in m ? m.attachments : undefined;
          if (role === "user" && atts && atts.length > 0) {
            const blocks = await ariaAttachmentService.buildAttachmentBlocks(
              atts,
              { inlineImages: i >= history.length - IMAGE_INLINE_RECENT },
            );
            if (m.content) blocks.push({ type: "text", text: m.content });
            return { role, content: blocks };
          }
          return { role, content: m.content };
        }),
      );

      // Tool-use loop. Cap room enough for multi-person chains
      // (employee → visa → leave) plus one forced synthesis turn.
      const MAX_TOOL_ITERATIONS = 8;
      /** Output budget for board memos / multi-tool answers (was 2048). */
      const CHAT_MAX_TOKENS = 8192;
      const toolContext = await loadToolContext(userId, conversationId);
      const allowedTools = toolDefinitionsFor(toolContext.perms);
      // Snapshot the RBAC context + offered tools for the training trace.
      tracePerms = Array.from(toolContext.perms);
      traceOfferedTools = allowedTools.map((t) => t.name);
      traceMaxTokens = CHAT_MAX_TOKENS;
      let iterations = 0;
      let lastStopReason: string | null = null;

      // Token counters accumulate across all loop iterations so the
      // telemetry row reflects the total Anthropic spend per turn.
      let aggIn = 0;
      let aggOut = 0;
      let aggCacheRead = 0;
      let aggCacheCreate = 0;

      while (iterations < MAX_TOOL_ITERATIONS) {
        iterations += 1;

        // On the final allowed iteration, disable tools so the model
        // must synthesise from tool results already in the transcript
        // instead of burning another tool_use and leaving an empty reply.
        const atCeiling = iterations >= MAX_TOOL_ITERATIONS;
        const toolsThisTurn =
          atCeiling || allowedTools.length === 0 ? undefined : allowedTools;

        // Per-iteration buffer: intermediate "looking that up…" prose from
        // tool_use turns must not pollute the persisted assistant message.
        // The FE replaces streamed text with the `done` payload, so clearing
        // `accumulated` on tool_use keeps the saved answer clean.
        let iterationText = "";

        const stream = anthropic.messages.stream(
          {
            model: ANTHROPIC_MODELS.CHAT,
            max_tokens: CHAT_MAX_TOKENS,
            system: systemBlocks,
            ...(toolsThisTurn ? { tools: toolsThisTurn } : {}),
            messages: messages as Anthropic.MessageParam[],
          },
          { signal: ac.signal },
        );

        stream.on("text", (delta) => {
          if (res.writableEnded || !delta) return;
          iterationText += delta;
          accumulated += delta;
          writeNdjson(res, { t: "delta", text: delta });
        });

        const finalMessage = await stream.finalMessage();
        lastStopReason = finalMessage.stop_reason ?? null;
        const usage = finalMessage.usage as
          | {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            }
          | undefined;
        if (usage) {
          aggIn += usage.input_tokens ?? 0;
          aggOut += usage.output_tokens ?? 0;
          aggCacheRead += usage.cache_read_input_tokens ?? 0;
          aggCacheCreate += usage.cache_creation_input_tokens ?? 0;
        }

        if (lastStopReason !== "tool_use") {
          break;
        }

        // Drop tool-turn narration from the final answer buffer.
        if (iterationText.length > 0 && accumulated.endsWith(iterationText)) {
          accumulated = accumulated.slice(0, -iterationText.length);
        } else {
          accumulated = "";
        }

        // Tool-use turn — execute each tool_use block, then append the
        // assistant message and a user tool_result message for the
        // next iteration.
        const toolUseBlocks = finalMessage.content.filter(
          (b): b is Extract<typeof b, { type: "tool_use" }> =>
            b.type === "tool_use",
        );
        if (toolUseBlocks.length === 0) break;

        messages.push({ role: "assistant", content: finalMessage.content });

        // Emit "running" status for every tool up-front so the UI
        // pills appear immediately. Execution runs in parallel via
        // `Promise.all` — the previous sequential `for await` loop
        // turned a 2-tool turn ("look up Sarah and Vivek's leave")
        // into 2x the latency for no good reason. Tool handlers don't
        // share mutable state, so concurrent execution is safe.
        for (const block of toolUseBlocks) {
          writeNdjson(res, {
            t: "tool_use",
            id: block.id,
            name: block.name,
            status: "running",
            summary: block.name,
          });
        }

        const results = await Promise.all(
          toolUseBlocks.map((block) =>
            executeTool(
              {
                id: block.id,
                name: block.name,
                input: (block.input ?? {}) as Record<string, unknown>,
              },
              toolContext,
            ),
          ),
        );

        const toolResultBlocks: Array<{
          type: "tool_result";
          tool_use_id: string;
          content: string;
          is_error?: boolean;
        }> = [];

        toolUseBlocks.forEach((block, idx) => {
          const result = results[idx]!;
          toolUsage.push({
            name: result.name,
            ok: result.ok,
            summary: result.summary,
          });
          // Full tool detail (args + result) for the training trace — the
          // signal the aggregate query log discards. Result payload is capped.
          traceToolCalls.push({
            name: block.name,
            input: (block.input ?? {}) as Record<string, unknown>,
            ok: result.ok,
            isError: !result.ok,
            resultPreview: (result.resultJson ?? "").slice(
              0,
              TRACE_TOOL_RESULT_CAP,
            ),
          });
          writeNdjson(res, {
            t: "tool_use",
            id: block.id,
            name: block.name,
            status: result.ok ? "done" : "error",
            summary: result.summary,
          });
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: result.resultJson,
            is_error: !result.ok,
          });
        });

        messages.push({ role: "user", content: toolResultBlocks });
      }

      tokensIn = aggIn > 0 ? aggIn : null;
      tokensOut = aggOut > 0 ? aggOut : null;
      cacheReadTokens = aggCacheRead > 0 ? aggCacheRead : null;
      cacheCreateTokens = aggCacheCreate > 0 ? aggCacheCreate : null;
      traceStopReason = lastStopReason;

      if (iterations >= MAX_TOOL_ITERATIONS && lastStopReason === "tool_use") {
        logger.warn("ARIA tool loop hit iteration ceiling", {
          conversationId,
          iterations,
        });
      }

      if (!accumulated.trim()) {
        const fallback = "I could not generate a response.";
        accumulated = fallback;
        writeNdjson(res, { t: "delta", text: fallback });
      }

      // Strip any `aria-citations` fence the *model* emitted itself. The
      // prompt forbids writing a Sources section, but the model still
      // mimics the format it sees in earlier turns of the conversation
      // history (those carry the server-appended block), so on later
      // turns it sometimes reproduces one. The server is the single
      // source of truth for the Sources list — remove model copies here
      // and append exactly one canonical block below. Without this a
      // duplicate "Sources" box renders. The `done` event ships this
      // cleaned `accumulated` to the FE, which replaces the streamed
      // text, so the final render shows one block even though the live
      // stream briefly flashed the model's copy.
      const withoutModelCitations = accumulated.replace(
        /\n*```aria-citations[\s\S]*?```/g,
        "",
      );
      if (withoutModelCitations !== accumulated) {
        accumulated = withoutModelCitations.trimEnd();
      }

      // Append the `aria-citations` interactive block when retrieval
      // surfaced articles. The fence is parsed by the FE renderer
      // (same pipeline as `aria-kpi-tiles` / `aria-actions`) and turned
      // into a footnote list with click-through to the source article.
      // We append even if the model didn't emit any `[N]` markers — the
      // user still sees "Sources" beneath the answer, which is the
      // trust signal we want.
      if (retrieval.citations.length > 0) {
        // Backticks anywhere in the JSON body (most likely inside an
        // article title) close the fenced block early — the JSON tail
        // then leaks into the rendered markdown as raw text. Strip
        // them defensively. Admin-only attack surface today (only HR /
        // admins author articles) but cheap to harden.
        const safeCitations = retrieval.citations.map((c) => ({
          ...c,
          title:
            typeof c.title === "string" ? c.title.replace(/`/g, "'") : c.title,
        }));
        const fence = `\n\n\`\`\`aria-citations\n${JSON.stringify({
          citations: safeCitations,
        })}\n\`\`\``;
        accumulated += fence;
        writeNdjson(res, { t: "delta", text: fence });
      }
    } catch (err) {
      streamErrored = true;
      streamErrorMessage = err instanceof Error ? err.message : String(err);
      logger.error("Anthropic API error", err);
      const isConfigError =
        err instanceof Error && err.message.includes("API key not configured");
      const msg = isConfigError ? configFallback : genericFallback;
      if (!accumulated.trim()) {
        accumulated = msg;
        writeNdjson(res, { t: "delta", text: msg });
      }
    } finally {
      res.off("close", onClose);

      try {
        const trackingActor = await actorFromId(userId);
        if (trackingActor) {
          trackAriaResponseReceivedServer(trackingActor, {
            latency_ms: Date.now() - startedAt,
            streaming: true,
            error: streamErrored,
          });
        }
      } catch {
        // analytics is best-effort
      }

      // Persist per-turn telemetry. Best-effort: a logging failure must
      // never affect the user-visible response. Distances containing
      // NaN (keyword path) are mapped to 0 so Postgres accepts them; the
      // mode column tells consumers how to interpret the column.
      try {
        await ariaRepository.recordQueryLog({
          conversationId,
          userId,
          userMessage: effectiveMessage,
          retrievedArticleIds: retrieval.injectedIds,
          retrievedDistances: retrieval.injectedDistances.map((d) =>
            Number.isFinite(d) ? d : 0,
          ),
          topDistance: retrieval.topDistance,
          retrievalMode: retrieval.mode,
          workspaceBytes,
          knowledgeBytes,
          latencyMs: Date.now() - startedAt,
          tokensIn,
          tokensOut,
          cacheReadTokens,
          cacheCreateTokens,
          model: ANTHROPIC_MODELS.CHAT,
          error: streamErrored,
          errorMessage: streamErrorMessage,
          toolUseCount: toolUsage.length,
          toolNames: toolUsage.map((t) => t.name),
        });
      } catch (logErr) {
        logger.warn("ARIA query log write failed", {
          err: logErr instanceof Error ? logErr.message : String(logErr),
        });
      }
    }

    try {
      const assistantMsg = await ariaRepository.addMessage(
        conversationId,
        "assistant",
        accumulated,
      );
      await ariaRepository.updateConversationTimestamp(conversationId);

      // Training-data trace (Phase 1). Full, replayable capture of the turn —
      // gated behind the fail-closed ARIA_TRACE_CAPTURE flag and best-effort so
      // it never affects chat. Links to the assistant message id so feedback
      // (thumbs / correction) joins at dataset-build time.
      if (isTraceCaptureEnabled()) {
        try {
          const turnKind = input.editMessageId
            ? "edit"
            : input.retryAssistantMessageId
              ? "retry"
              : "send";
          await ariaRepository.recordInteractionTrace({
            conversationId,
            userId,
            assistantMessageId: assistantMsg.id,
            turnKind,
            promptVersion: ARIA_PROMPT_VERSION,
            model: ANTHROPIC_MODELS.CHAT,
            maxTokens: traceMaxTokens,
            userMessage: effectiveMessage,
            permissionsSnapshot: tracePerms,
            offeredTools: traceOfferedTools,
            retrievedArticleIds: retrieval.injectedIds,
            retrievedDistances: retrieval.injectedDistances.map((d) =>
              Number.isFinite(d) ? d : 0,
            ),
            topDistance: retrieval.topDistance,
            retrievalMode: retrieval.mode,
            workspaceBytes,
            knowledgeBytes,
            assistantText: accumulated,
            stopReason: traceStopReason,
            toolCalls: traceToolCalls,
            toolUseCount: toolUsage.length,
            toolNames: toolUsage.map((t) => t.name),
            tokensIn,
            tokensOut,
            cacheReadTokens,
            cacheCreateTokens,
            latencyMs: Date.now() - startedAt,
            error: streamErrored,
            errorMessage: streamErrorMessage,
          });
        } catch (traceErr) {
          logger.warn("ARIA interaction trace write failed", {
            err:
              traceErr instanceof Error ? traceErr.message : String(traceErr),
          });
        }
      }

      if (isNewConversation) {
        const messageCount = await ariaRepository.countMessages(conversationId);
        if (messageCount === 2) {
          const generatedTitle =
            await tryGenerateConversationTitle(effectiveMessage);
          if (generatedTitle) {
            await ariaRepository.updateConversationTitle(
              conversationId,
              generatedTitle,
            );
          }
        }
      }

      writeNdjson(res, {
        t: "done",
        message: {
          id: assistantMsg.id,
          conversationId: assistantMsg.conversationId,
          role: "assistant",
          content: assistantMsg.content,
          createdAt: assistantMsg.createdAt.toISOString(),
        },
      });

      // Phase 2 — fire-and-forget memory maintenance. These calls do
      // their own try/catch, so we don't have to wrap them here. They
      // run after `done` is written so the user never waits on the
      // Haiku round-trip.
      if (!streamErrored && accumulated.trim()) {
        void extractAndStoreMemory({
          conversationId,
          userMessage: effectiveMessage,
          assistantMessage: accumulated,
        });

        // Re-fetch the verbatim window head to decide whether a
        // summary regeneration is due. Cheap indexed query.
        void ariaRepository
          .getRecentMessages(conversationId)
          .then((msgs) => {
            // Only summarise when the verbatim window is saturated —
            // otherwise there are no aged-out messages to compress.
            if (msgs.length >= 40 && msgs[0]) {
              return maybeRegenerateSummary(conversationId, msgs[0].id);
            }
          })
          .catch(() => {
            // already logged inside maybeRegenerateSummary; ignore
          });
      }
    } catch (dbErr) {
      logger.error("ARIA persist error", dbErr);
      writeNdjson(res, {
        t: "error",
        message: "Failed to save the assistant message.",
      });
    } finally {
      res.end();
    }
  },
};
