import { Router } from "express";

import { PERMISSIONS } from "@/common/constants/permissions";
import { getRequiredParam } from "@/common/utils/params";
import {
  authenticate,
  requireActive,
  requirePermission,
} from "@/core/guards/auth.guard";
import { asyncHandler } from "@/core/middleware/async-handler";
import { legalAnnouncementService } from "@/modules/legal-announcements/legal-announcements.service";
import {
  announcementQuerySchema,
  createAnnouncementSchema,
  updateAnnouncementSchema,
} from "@/modules/legal-announcements/legal-announcements.validation";

const router = Router();

router.use(authenticate, requireActive);

// Lightweight unread counter for the dashboard banner. Counts only
// active, in-scope, requires-ack items the viewer hasn't acked yet.
router.get(
  "/unacked-summary",
  requirePermission(PERMISSIONS.LEGAL_ANNOUNCEMENT_READ),
  asyncHandler(async (req, res) => {
    const result = await legalAnnouncementService.unackedSummary(req.user!.id);
    res.json(result);
  }),
);

router.get(
  "/",
  requirePermission(PERMISSIONS.LEGAL_ANNOUNCEMENT_READ),
  asyncHandler(async (req, res) => {
    const query = announcementQuerySchema.parse(req.query);
    const canManage = (req.user!.permissions ?? []).includes(
      PERMISSIONS.LEGAL_ANNOUNCEMENT_MANAGE,
    );
    const result = await legalAnnouncementService.list(
      req.user!.id,
      req.user!.entityId ?? null,
      canManage,
      query,
    );
    res.json(result);
  }),
);

router.post(
  "/",
  requirePermission(PERMISSIONS.LEGAL_ANNOUNCEMENT_MANAGE),
  asyncHandler(async (req, res) => {
    const input = createAnnouncementSchema.parse(req.body);
    const result = await legalAnnouncementService.create(input, req.user!.id);
    res.status(201).json(result);
  }),
);

router.get(
  "/:id",
  requirePermission(PERMISSIONS.LEGAL_ANNOUNCEMENT_READ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const canManage = (req.user!.permissions ?? []).includes(
      PERMISSIONS.LEGAL_ANNOUNCEMENT_MANAGE,
    );
    const result = await legalAnnouncementService.getById(
      id,
      req.user!.id,
      req.user!.entityId ?? null,
      canManage,
    );
    res.json(result);
  }),
);

router.put(
  "/:id",
  requirePermission(PERMISSIONS.LEGAL_ANNOUNCEMENT_MANAGE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = updateAnnouncementSchema.parse(req.body);
    const result = await legalAnnouncementService.update(
      id,
      input,
      req.user!.id,
    );
    res.json(result);
  }),
);

router.delete(
  "/:id",
  requirePermission(PERMISSIONS.LEGAL_ANNOUNCEMENT_MANAGE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const result = await legalAnnouncementService.remove(id);
    res.json(result);
  }),
);

router.post(
  "/:id/ack",
  requirePermission(PERMISSIONS.LEGAL_ANNOUNCEMENT_READ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const canManage = (req.user!.permissions ?? []).includes(
      PERMISSIONS.LEGAL_ANNOUNCEMENT_MANAGE,
    );
    const ip =
      (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0] ??
      req.socket.remoteAddress ??
      null;
    const result = await legalAnnouncementService.acknowledge(
      id,
      req.user!.id,
      req.user!.entityId ?? null,
      canManage,
      ip,
    );
    res.json(result);
  }),
);

router.get(
  "/:id/acks",
  requirePermission(PERMISSIONS.LEGAL_ANNOUNCEMENT_MANAGE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const canManage = (req.user!.permissions ?? []).includes(
      PERMISSIONS.LEGAL_ANNOUNCEMENT_MANAGE,
    );
    const result = await legalAnnouncementService.listAckers(id, canManage);
    res.json(result);
  }),
);

router.get(
  "/:id/attachments/:attachmentId/download",
  requirePermission(PERMISSIONS.LEGAL_ANNOUNCEMENT_READ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const attachmentId = getRequiredParam(req.params, "attachmentId");
    const canManage = (req.user!.permissions ?? []).includes(
      PERMISSIONS.LEGAL_ANNOUNCEMENT_MANAGE,
    );
    const result = await legalAnnouncementService.getAttachmentDownloadUrl(
      id,
      attachmentId,
      req.user!.id,
      req.user!.entityId ?? null,
      canManage,
    );
    res.json(result);
  }),
);

export default router;
