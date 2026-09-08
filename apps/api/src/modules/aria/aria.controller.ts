import { Router } from "express";
import multer from "multer";

import { PERMISSIONS } from "@/common/constants/permissions";
import { getRequiredParam } from "@/common/utils/params";
import {
  authenticate,
  requirePermission,
  requireSystemAdmin,
} from "@/core/guards/auth.guard";
import { asyncHandler } from "@/core/middleware/async-handler";
import { prisma } from "@/infrastructure/database/prisma";
import { ariaService } from "@/modules/aria/aria.service";
import {
  briefInboxQuerySchema,
  briefSubscriptionUpdateSchema,
  chatSchema,
  conversationIdParamSchema,
  createConversationSchema,
  createKnowledgeSchema,
  feedbackSchema,
  insightsQuerySchema,
  knowledgeQuerySchema,
  reviewFeedbackSchema,
  updateKnowledgeSchema,
} from "@/modules/aria/aria.validation";
import {
  ARIA_ATTACHMENT_MAX_BYTES,
  ariaAttachmentService,
} from "@/modules/aria/aria-attachment.service";
import {
  BRIEF_SECTION_IDS,
  buildBrief,
  deliverBrief,
  getBriefSubscription,
  listBriefDeliveries,
  upsertBriefSubscription,
} from "@/modules/aria/aria-brief.service";
import {
  ariaDocumentParseService,
  PARSE_DOCUMENT_MAX_BYTES,
} from "@/modules/aria/aria-document-parse.service";

const router = Router();

const parseUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PARSE_DOCUMENT_MAX_BYTES },
});

const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: ARIA_ATTACHMENT_MAX_BYTES },
});

router.get(
  "/conversations",
  authenticate,
  requirePermission(PERMISSIONS.ARIA_USE),
  asyncHandler(async (req, res) => {
    const result = await ariaService.listConversations(req.user!.id);
    res.json(result);
  }),
);

router.post(
  "/conversations",
  authenticate,
  requirePermission(PERMISSIONS.ARIA_USE),
  asyncHandler(async (req, res) => {
    const input = createConversationSchema.parse(req.body);
    const result = await ariaService.createConversation(req.user!.id, input);
    res.status(201).json(result);
  }),
);

router.get(
  "/conversations/:id",
  authenticate,
  requirePermission(PERMISSIONS.ARIA_USE),
  asyncHandler(async (req, res) => {
    const { id } = conversationIdParamSchema.parse(req.params);
    const result = await ariaService.getConversation(req.user!.id, id);
    res.json(result);
  }),
);

router.delete(
  "/conversations/:id",
  authenticate,
  requirePermission(PERMISSIONS.ARIA_USE),
  asyncHandler(async (req, res) => {
    const { id } = conversationIdParamSchema.parse(req.params);
    const result = await ariaService.deleteConversation(req.user!.id, id);
    res.json(result);
  }),
);

router.post(
  "/chat",
  authenticate,
  requirePermission(PERMISSIONS.ARIA_USE),
  async (req, res, next) => {
    try {
      const input = chatSchema.parse(req.body);
      await ariaService.chatStream(req.user!.id, input, res);
    } catch (err) {
      if (res.headersSent) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
        return;
      }
      next(err);
    }
  },
);

// Upload a chat attachment (image / PDF / text doc) — upload-first: the
// file is stored + validated now, and the returned id is passed back in the
// next /chat call's `attachmentIds`. Gated on ARIA_USE (same as chat).
router.post(
  "/attachments",
  authenticate,
  requirePermission(PERMISSIONS.ARIA_USE),
  attachmentUpload.single("file"),
  asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({
        error: {
          code: "BAD_REQUEST",
          message:
            'No file uploaded. Send multipart/form-data with field "file".',
        },
      });
      return;
    }
    const att = await ariaAttachmentService.uploadAttachment(req.user!.id, {
      buffer: file.buffer,
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
    });
    res.status(201).json({
      data: {
        id: att.id,
        name: att.name,
        kind: att.kind,
        mimeType: att.mimeType,
        size: att.size,
        status: att.status,
      },
    });
  }),
);

// Confirm a draft-and-confirm write tool (ARIA improvement #7,
// 2026-05-25). The chat stream emits an `aria-confirm` block carrying
// an HMAC-signed token; the FE posts the token here when the user
// clicks Approve. Token shape + signature: see aria-action-tokens.ts.
router.post(
  "/confirm-action",
  authenticate,
  requirePermission(PERMISSIONS.ARIA_USE),
  asyncHandler(async (req, res) => {
    const token = (req.body as { token?: unknown })?.token;
    if (typeof token !== "string" || !token) {
      res.status(400).json({ error: { message: "Missing token" } });
      return;
    }
    const data = await ariaService.confirmAction(req.user!.id, token);
    res.json({ data });
  }),
);

router.post(
  "/parse-receipt",
  authenticate,
  requirePermission(PERMISSIONS.ARIA_PARSE),
  parseUpload.single("file"),
  asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({
        error: {
          code: "BAD_REQUEST",
          message:
            'No file uploaded. Send multipart/form-data with field "file".',
        },
      });
      return;
    }
    const data = await ariaDocumentParseService.parseReceipt(
      file.buffer,
      file.mimetype,
    );
    res.json({ data });
  }),
);

router.post(
  "/parse-invoice",
  authenticate,
  requirePermission(PERMISSIONS.ARIA_PARSE),
  parseUpload.single("file"),
  asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({
        error: {
          code: "BAD_REQUEST",
          message:
            'No file uploaded. Send multipart/form-data with field "file".',
        },
      });
      return;
    }
    const data = await ariaDocumentParseService.parseInvoice(
      file.buffer,
      file.mimetype,
    );
    res.json({ data });
  }),
);

// ── Knowledge corpus admin routes (gated on aria:knowledge-manage) ──

router.get(
  "/knowledge",
  authenticate,
  requirePermission(PERMISSIONS.ARIA_KNOWLEDGE_MANAGE),
  asyncHandler(async (req, res) => {
    const query = knowledgeQuerySchema.parse(req.query);
    const result = await ariaService.listKnowledge(query);
    res.json(result);
  }),
);

// Knowledge-article GET is accessible to any ARIA user — citations in
// chat link here, so an admin-only gate would 404 every source link
// for end users. The service enforces the article's own
// `requiredPermissions` ACL against the caller, and knowledge-manage
// admins always pass through.
router.get(
  "/knowledge/:id",
  authenticate,
  requirePermission(PERMISSIONS.ARIA_USE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const result = await ariaService.getKnowledgeById(
      id,
      req.user!.permissions,
    );
    res.json(result);
  }),
);

router.post(
  "/knowledge",
  authenticate,
  requirePermission(PERMISSIONS.ARIA_KNOWLEDGE_MANAGE),
  asyncHandler(async (req, res) => {
    const input = createKnowledgeSchema.parse(req.body);
    const result = await ariaService.createKnowledge(input, req.user!.id);
    res.status(201).json(result);
  }),
);

router.post(
  "/knowledge/reindex",
  authenticate,
  requirePermission(PERMISSIONS.ARIA_KNOWLEDGE_MANAGE),
  asyncHandler(async (_req, res) => {
    const result = await ariaService.reindexKnowledgeEmbeddings();
    res.json(result);
  }),
);

router.put(
  "/knowledge/:id",
  authenticate,
  requirePermission(PERMISSIONS.ARIA_KNOWLEDGE_MANAGE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = updateKnowledgeSchema.parse(req.body);
    const result = await ariaService.updateKnowledge(id, input);
    res.json(result);
  }),
);

router.delete(
  "/knowledge/:id",
  authenticate,
  requirePermission(PERMISSIONS.ARIA_KNOWLEDGE_MANAGE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const result = await ariaService.deleteKnowledge(id);
    res.json(result);
  }),
);

// Insights / improvement queue / draft+review expose other users'
// chat text. Gate on system admin (same bar as aria-training) — not
// aria:knowledge-manage, which a custom role can hold.
router.get(
  "/insights",
  authenticate,
  requireSystemAdmin(),
  asyncHandler(async (req, res) => {
    const { days } = insightsQuerySchema.parse(req.query);
    const result = await ariaService.getInsights(days);
    res.json(result);
  }),
);

// Phase 4 — manual trigger of the auto-sync workers. Same code path
// the daily cron uses; useful for ad-hoc rebuilds after a bulk import.
router.post(
  "/sync",
  authenticate,
  requirePermission(PERMISSIONS.ARIA_KNOWLEDGE_MANAGE),
  asyncHandler(async (_req, res) => {
    const result = await ariaService.runKnowledgeSync();
    res.json(result);
  }),
);

// ── Phase 6 — self-improvement loop ────────────────────────────────

// Any ARIA user can rate an assistant reply (thumbs up / down + optional
// reason). Service validates the message belongs to the caller's
// conversation.
router.post(
  "/feedback",
  authenticate,
  requirePermission(PERMISSIONS.ARIA_USE),
  asyncHandler(async (req, res) => {
    const input = feedbackSchema.parse(req.body);
    const result = await ariaService.recordFeedback(req.user!.id, input);
    res.status(201).json(result);
  }),
);

// Admin improvement queue — open thumbs-down feedback (contains other
// users' messages). System admin only.
router.get(
  "/improvement-queue",
  authenticate,
  requireSystemAdmin(),
  asyncHandler(async (_req, res) => {
    const result = await ariaService.getImprovementQueue();
    res.json(result);
  }),
);

// Admin draft-article generator. Returns a Haiku-drafted article
// payload that the admin reviews + posts through the standard
// `POST /aria/knowledge` create route. Reads feedback chat context.
router.post(
  "/feedback/:id/draft-article",
  authenticate,
  requireSystemAdmin(),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const result = await ariaService.draftArticleFromFeedback(id);
    res.json(result);
  }),
);

// Admin: clear a feedback row from the queue. Optional review note
// + optional `resultingArticleId` to link the row to whatever
// knowledge article it produced (closes the feedback loop).
router.post(
  "/feedback/:id/review",
  authenticate,
  requireSystemAdmin(),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = reviewFeedbackSchema.parse(req.body);
    const result = await ariaService.reviewFeedback(req.user!.id, id, input);
    res.json(result);
  }),
);

// ── Phase 8 — proactive daily brief ────────────────────────────────

// Returns the caller's current subscription (or a virtual default row
// if they have never customised). Also exposes the section catalogue
// so the FE can build the multi-select without hard-coding ids.
router.get(
  "/brief/subscription",
  authenticate,
  requirePermission(PERMISSIONS.ARIA_BRIEF_SUBSCRIBE),
  asyncHandler(async (req, res) => {
    const subscription = await getBriefSubscription(req.user!.id);
    res.json({
      data: {
        subscription,
        availableSections: BRIEF_SECTION_IDS,
      },
    });
  }),
);

router.put(
  "/brief/subscription",
  authenticate,
  requirePermission(PERMISSIONS.ARIA_BRIEF_SUBSCRIBE),
  asyncHandler(async (req, res) => {
    const input = briefSubscriptionUpdateSchema.parse(req.body);
    const subscription = await upsertBriefSubscription(req.user!.id, input);
    res.json({ data: { subscription } });
  }),
);

// Inbox view — most-recent deliveries first. Used by the FE to render
// the "Past briefs" list on the settings page and the inbox card on
// the dashboard.
router.get(
  "/brief/deliveries",
  authenticate,
  requirePermission(PERMISSIONS.ARIA_BRIEF_SUBSCRIBE),
  asyncHandler(async (req, res) => {
    const { limit } = briefInboxQuerySchema.parse(req.query);
    const deliveries = await listBriefDeliveries(req.user!.id, limit);
    res.json({ data: deliveries });
  }),
);

// On-demand brief — useful for "preview" buttons on the settings
// page and for QA. Runs the same code path as the cron but bypasses
// the (user, day) idempotency by sending channels=[in_app] only when
// already delivered today.
router.post(
  "/brief/run",
  authenticate,
  requirePermission(PERMISSIONS.ARIA_BRIEF_SUBSCRIBE),
  asyncHandler(async (req, res) => {
    const sub = await getBriefSubscription(req.user!.id);
    const payload = await buildBrief({
      userId: req.user!.id,
      timezone: sub.timezone,
      sectionFilter: sub.sections,
    });
    if (!payload) {
      res.json({ data: { empty: true } });
      return;
    }
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { email: true, name: true },
    });
    const result = await deliverBrief({
      userId: req.user!.id,
      payload,
      channels: sub.channels as ("in_app" | "email")[],
      email: user?.email ?? undefined,
      displayName: user?.name ?? undefined,
    });
    res.json({ data: { payload, ...result } });
  }),
);

export default router;
