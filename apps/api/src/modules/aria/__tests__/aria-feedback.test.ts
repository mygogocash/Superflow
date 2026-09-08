import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ForbiddenException,
  NotFoundException,
} from "@/common/exceptions/http-exception";
import { ariaService } from "@/modules/aria/aria.service";

/**
 * Phase 6 — feedback / improvement queue service tests.
 * Mocks the repository so we can drive `recordFeedback` and
 * `reviewFeedback` through their RBAC + ownership guards.
 */

const repositoryMock = vi.hoisted(() => ({
  findMessageById: vi.fn(),
  findConversationById: vi.fn(),
  upsertFeedback: vi.fn(),
  findFeedbackById: vi.fn(),
  findImprovementQueue: vi.fn(),
  markFeedbackReviewed: vi.fn(),
}));

vi.mock("@/modules/aria/aria.repository", () => ({
  ariaRepository: repositoryMock,
}));

vi.mock("@/infrastructure/database/prisma", () => ({ prisma: {} }));

vi.mock("@/infrastructure/supabase/admin", () => ({
  supabaseAdmin: { auth: { admin: {} } },
}));

vi.mock("@/core/guards/auth.guard", () => ({
  loadUserPermissions: vi.fn().mockResolvedValue(new Set<string>()),
}));

vi.mock("@/modules/aria/aria-embedding.service", () => ({
  generateEmbedding: vi.fn().mockResolvedValue(null),
  vectorLiteral: vi.fn(),
  articleEmbeddingInput: vi.fn(),
}));

const CALLER = "00000000-0000-0000-0000-0000000000aa";
const OTHER = "00000000-0000-0000-0000-0000000000bb";
const MSG_ID = "11111111-1111-1111-1111-111111111111";
const CONV_ID = "22222222-2222-2222-2222-222222222222";
const FB_ID = "33333333-3333-3333-3333-333333333333";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ariaService.recordFeedback", () => {
  it("persists thumbs-up + reason when caller owns the conversation", async () => {
    repositoryMock.findMessageById.mockResolvedValue({
      id: MSG_ID,
      role: "assistant",
      conversationId: CONV_ID,
    });
    repositoryMock.findConversationById.mockResolvedValue({
      id: CONV_ID,
      userId: CALLER,
    });
    repositoryMock.upsertFeedback.mockResolvedValue({
      id: FB_ID,
      rating: "up",
    });

    const result = await ariaService.recordFeedback(CALLER, {
      messageId: MSG_ID,
      rating: "up",
      reason: "  Helpful  ",
    });

    expect(result.data.id).toBe(FB_ID);
    expect(repositoryMock.upsertFeedback).toHaveBeenCalledWith({
      messageId: MSG_ID,
      userId: CALLER,
      rating: "up",
      reason: "Helpful",
    });
  });

  it("rejects when the caller does not own the conversation", async () => {
    repositoryMock.findMessageById.mockResolvedValue({
      id: MSG_ID,
      role: "assistant",
      conversationId: CONV_ID,
    });
    repositoryMock.findConversationById.mockResolvedValue({
      id: CONV_ID,
      userId: OTHER,
    });
    await expect(
      ariaService.recordFeedback(CALLER, {
        messageId: MSG_ID,
        rating: "down",
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repositoryMock.upsertFeedback).not.toHaveBeenCalled();
  });

  it("rejects rating a user message", async () => {
    repositoryMock.findMessageById.mockResolvedValue({
      id: MSG_ID,
      role: "user",
      conversationId: CONV_ID,
    });
    await expect(
      ariaService.recordFeedback(CALLER, {
        messageId: MSG_ID,
        rating: "down",
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("404s when the message is missing", async () => {
    repositoryMock.findMessageById.mockResolvedValue(null);
    await expect(
      ariaService.recordFeedback(CALLER, { messageId: MSG_ID, rating: "up" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("normalises an empty reason to null", async () => {
    repositoryMock.findMessageById.mockResolvedValue({
      id: MSG_ID,
      role: "assistant",
      conversationId: CONV_ID,
    });
    repositoryMock.findConversationById.mockResolvedValue({
      id: CONV_ID,
      userId: CALLER,
    });
    repositoryMock.upsertFeedback.mockResolvedValue({ id: FB_ID });
    await ariaService.recordFeedback(CALLER, {
      messageId: MSG_ID,
      rating: "down",
      reason: "   ",
    });
    expect(repositoryMock.upsertFeedback.mock.calls[0]?.[0]?.reason).toBeNull();
  });
});

describe("ariaService.reviewFeedback", () => {
  it("marks the row reviewed with reviewer + note + article id", async () => {
    repositoryMock.findFeedbackById.mockResolvedValue({ id: FB_ID });
    repositoryMock.markFeedbackReviewed.mockResolvedValue({
      id: FB_ID,
      reviewed: true,
    });
    await ariaService.reviewFeedback(CALLER, FB_ID, {
      reviewNote: "Promoted to article",
      resultingArticleId: "44444444-4444-4444-4444-444444444444",
    });
    expect(repositoryMock.markFeedbackReviewed).toHaveBeenCalledWith({
      feedbackId: FB_ID,
      reviewedById: CALLER,
      reviewNote: "Promoted to article",
      resultingArticleId: "44444444-4444-4444-4444-444444444444",
    });
  });

  it("404s when the feedback row is missing", async () => {
    repositoryMock.findFeedbackById.mockResolvedValue(null);
    await expect(
      ariaService.reviewFeedback(CALLER, FB_ID, {}),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
