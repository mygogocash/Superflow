import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { PERMISSIONS } from "@nexora/contracts";
import {
  addAttachmentsSchema,
  createApprovalStepSchema,
  createTravelRequestSchema,
  forwardTravelRequestSchema,
  rejectTravelRequestSchema,
  reorderApprovalStepsSchema,
  travelRequestQuerySchema,
  updateApprovalStepSchema,
  updateTravelRequestSchema,
} from "@nexora/contracts/modules/travel/travel.validation";
import { travelService } from "@nexora/core";
import type { AppEnv } from "../lib/context";
import { requirePermission } from "../middleware/rbac";

const travelRead = [PERMISSIONS.TRAVEL_READ, PERMISSIONS.TRAVEL_HR_READ] as const;
const notificationRecipientsSchema = z.object({
  emails: z.array(z.string()).optional(),
});

export const travel = new Hono<AppEnv>()
  .get("/requests", requirePermission(...travelRead), zValidator("query", travelRequestQuerySchema), async (c) => {
    const result = await travelService.listRequests(
      c.var.db,
      c.var.user!.id,
      c.var.user!.permissions,
      c.req.valid("query"),
    );
    return c.json(result);
  })
  .post("/requests", requirePermission(PERMISSIONS.TRAVEL_REQUEST), zValidator("json", createTravelRequestSchema), async (c) => {
    const data = await travelService.createRequest(c.var.db, c.var.user!.id, c.req.valid("json"));
    return c.json({ data }, 201);
  })
  .get("/export", requirePermission(PERMISSIONS.TRAVEL_HR_READ), zValidator("query", travelRequestQuerySchema), async (c) => {
    const { page: _p, limit: _l, ...filters } = c.req.valid("query");
    await travelService.exportTravelXlsx(c.var.db, filters);
    return c.body(null, 501);
  })
  .get("/requests/:id", requirePermission(...travelRead), async (c) => {
    const data = await travelService.getRequestById(
      c.var.db,
      c.req.param("id"),
      c.var.user!.id,
      c.var.user!.permissions,
    );
    return c.json({ data });
  })
  .put("/requests/:id", requirePermission(PERMISSIONS.TRAVEL_REQUEST), zValidator("json", updateTravelRequestSchema), async (c) => {
    const data = await travelService.updateRequest(
      c.var.db,
      c.req.param("id"),
      c.var.user!.id,
      c.req.valid("json"),
    );
    return c.json({ data });
  })
  .put("/requests/:id/approve", async (c) => {
    const data = await travelService.approveRequest(
      c.var.db,
      c.req.param("id"),
      c.var.user!.id,
      c.var.user!.permissions,
    );
    return c.json({ data });
  })
  .put("/requests/:id/reject", zValidator("json", rejectTravelRequestSchema), async (c) => {
    const { reason } = c.req.valid("json");
    const data = await travelService.rejectRequest(
      c.var.db,
      c.req.param("id"),
      c.var.user!.id,
      reason,
      c.var.user!.permissions,
    );
    return c.json({ data });
  })
  .get("/requests/:id/approvals", requirePermission(...travelRead), async (c) => {
    const data = await travelService.getDecisions(
      c.var.db,
      c.req.param("id"),
      c.var.user!.id,
      c.var.user!.permissions,
    );
    return c.json({ data });
  })
  .put("/requests/:id/cancel", requirePermission(PERMISSIONS.TRAVEL_REQUEST), async (c) => {
    const data = await travelService.cancelRequest(c.var.db, c.req.param("id"), c.var.user!.id);
    return c.json({ data });
  })
  .delete("/requests/:id", requirePermission(PERMISSIONS.TRAVEL_REQUEST, PERMISSIONS.TRAVEL_HR_READ), async (c) => {
    const data = await travelService.deleteRequest(
      c.var.db,
      c.req.param("id"),
      c.var.user!.id,
      c.var.user!.permissions,
    );
    return c.json({ data });
  })
  .put("/requests/:id/complete", requirePermission(PERMISSIONS.TRAVEL_HR_READ), async (c) => {
    const data = await travelService.completeRequest(c.var.db, c.req.param("id"), c.var.user!.id);
    return c.json({ data });
  })
  .put("/requests/:id/archive", requirePermission(PERMISSIONS.TRAVEL_HR_READ), async (c) => {
    const data = await travelService.archiveRequest(c.var.db, c.req.param("id"), c.var.user!.id);
    return c.json({ data });
  })
  .post("/requests/:id/restore", requirePermission(PERMISSIONS.TRAVEL_REQUEST), async (c) => {
    const data = await travelService.restoreRequest(
      c.var.db,
      c.req.param("id"),
      c.var.user!.id,
      c.var.user!.permissions,
    );
    return c.json({ data });
  })
  .delete("/requests/:id/permanent", requirePermission(PERMISSIONS.TRAVEL_HR_READ), async (c) => {
    const data = await travelService.permanentDeleteRequest(
      c.var.db,
      c.req.param("id"),
      c.var.user!.permissions,
    );
    return c.json({ data });
  })
  .post("/requests/:id/forward", zValidator("json", forwardTravelRequestSchema), async (c) => {
    const data = await travelService.forwardRequest(
      c.var.db,
      c.req.param("id"),
      c.var.user!.id,
      c.var.user!.permissions,
      c.req.valid("json"),
    );
    return c.json({ data });
  })
  .post("/requests/:id/attachments", requirePermission(PERMISSIONS.TRAVEL_REQUEST, PERMISSIONS.TRAVEL_HR_READ), zValidator("json", addAttachmentsSchema), async (c) => {
    const data = await travelService.addAttachments(
      c.var.db,
      c.req.param("id"),
      c.var.user!.id,
      c.var.user!.permissions,
      c.req.valid("json"),
    );
    return c.json({ data });
  })
  .get("/requests/:id/expenses", requirePermission(...travelRead), async (c) => {
    const data = await travelService.getLinkedExpenses(
      c.var.db,
      c.req.param("id"),
      c.var.user!.id,
      c.var.user!.permissions,
    );
    return c.json({ data });
  })
  .get("/approval-steps", requirePermission(PERMISSIONS.TRAVEL_HR_SETTINGS), async (c) => {
    const data = await travelService.listApprovalSteps(c.var.db);
    return c.json({ data });
  })
  .post("/approval-steps", requirePermission(PERMISSIONS.TRAVEL_HR_SETTINGS), zValidator("json", createApprovalStepSchema), async (c) => {
    const data = await travelService.createApprovalStep(c.var.db, c.req.valid("json"));
    return c.json({ data }, 201);
  })
  .put("/approval-steps/reorder", requirePermission(PERMISSIONS.TRAVEL_HR_SETTINGS), zValidator("json", reorderApprovalStepsSchema), async (c) => {
    const data = await travelService.reorderApprovalSteps(c.var.db, c.req.valid("json"));
    return c.json({ data });
  })
  .put("/approval-steps/:id", requirePermission(PERMISSIONS.TRAVEL_HR_SETTINGS), zValidator("json", updateApprovalStepSchema), async (c) => {
    const data = await travelService.updateApprovalStep(c.var.db, c.req.param("id"), c.req.valid("json"));
    return c.json({ data });
  })
  .delete("/approval-steps/:id", requirePermission(PERMISSIONS.TRAVEL_HR_SETTINGS), async (c) => {
    const data = await travelService.deleteApprovalStep(c.var.db, c.req.param("id"));
    return c.json({ data });
  })
  .get("/notification-recipients", requirePermission(PERMISSIONS.TRAVEL_HR_SETTINGS), async (c) => {
    const data = await travelService.getNotificationRecipients(c.var.db);
    return c.json({ data });
  })
  .put("/notification-recipients", requirePermission(PERMISSIONS.TRAVEL_HR_SETTINGS), zValidator("json", notificationRecipientsSchema), async (c) => {
    const emails = c.req.valid("json").emails ?? [];
    const data = await travelService.setNotificationRecipients(c.var.db, emails);
    return c.json({ data });
  });
