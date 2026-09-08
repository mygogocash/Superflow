import { Router } from "express";

import { PERMISSIONS } from "@/common/constants/permissions";
import { getRequiredParam } from "@/common/utils/params";
import {
  authenticate,
  ensurePermissionsLoaded,
  requireActive,
  requirePermission,
} from "@/core/guards/auth.guard";
import { asyncHandler } from "@/core/middleware/async-handler";
import { travelService } from "@/modules/travel/travel.service";
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
} from "@/modules/travel/travel.validation";

const router = Router();

router.use(authenticate, requireActive);

router.get(
  "/requests",
  requirePermission(PERMISSIONS.TRAVEL_READ, PERMISSIONS.TRAVEL_HR_READ),
  asyncHandler(async (req, res) => {
    const query = travelRequestQuerySchema.parse(req.query);
    const result = await travelService.listRequests(
      req.user!.id,
      req.user!.permissions,
      query,
    );
    res.json(result);
  }),
);

router.post(
  "/requests",
  requirePermission(PERMISSIONS.TRAVEL_REQUEST),
  asyncHandler(async (req, res) => {
    const input = createTravelRequestSchema.parse(req.body);
    const data = await travelService.createRequest(req.user!.id, input);
    res.status(201).json({ data });
  }),
);

router.get(
  "/export",
  requirePermission(PERMISSIONS.TRAVEL_HR_READ),
  asyncHandler(async (req, res) => {
    const {
      page: _p,
      limit: _l,
      ...filters
    } = travelRequestQuerySchema.parse(req.query);
    const buffer = await travelService.exportTravelXlsx(filters);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="travel-requests-${Date.now()}.xlsx"`,
    );
    res.send(buffer);
  }),
);

router.get(
  "/requests/:id",
  requirePermission(PERMISSIONS.TRAVEL_READ, PERMISSIONS.TRAVEL_HR_READ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await travelService.getRequestById(
      id,
      req.user!.id,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

router.put(
  "/requests/:id",
  requirePermission(PERMISSIONS.TRAVEL_REQUEST),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = updateTravelRequestSchema.parse(req.body);
    const data = await travelService.updateRequest(id, req.user!.id, input);
    res.json({ data });
  }),
);

// Authorisation for approve/reject is intentionally delegated to the
// service via `assertCanActOnStep`. A user assigned as an approval-step
// approver (configured by HR in the chain admin) may not hold the static
// `travel:approve` perm — gating the route on that perm locked them out
// even though the chain made them the right person to act.
//
// `ensurePermissionsLoaded` is REQUIRED here: `authenticate` ships the
// request with `permissions: []` and the service-side
// `assertCanActOnStep` checks `actorPermissions.includes(TRAVEL_HR_APPROVE)`
// to decide HR bypass. Without this call HR users were silently denied
// because the array was empty (#518). Expenses approve/reject has the
// same shape and explicitly loads permissions for the same reason.
router.put(
  "/requests/:id/approve",
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    await ensurePermissionsLoaded(req);
    const data = await travelService.approveRequest(
      id,
      req.user!.id,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

router.put(
  "/requests/:id/reject",
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    await ensurePermissionsLoaded(req);
    const { reason } = rejectTravelRequestSchema.parse(req.body);
    const data = await travelService.rejectRequest(
      id,
      req.user!.id,
      reason,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

router.get(
  "/requests/:id/approvals",
  requirePermission(PERMISSIONS.TRAVEL_READ, PERMISSIONS.TRAVEL_HR_READ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await travelService.getDecisions(
      id,
      req.user!.id,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

router.put(
  "/requests/:id/cancel",
  requirePermission(PERMISSIONS.TRAVEL_REQUEST),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await travelService.cancelRequest(id, req.user!.id);
    res.json({ data });
  }),
);

router.delete(
  "/requests/:id",
  requirePermission(PERMISSIONS.TRAVEL_REQUEST, PERMISSIONS.TRAVEL_HR_READ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await travelService.deleteRequest(
      id,
      req.user!.id,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

router.put(
  "/requests/:id/complete",
  requirePermission(PERMISSIONS.TRAVEL_HR_READ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await travelService.completeRequest(id, req.user!.id);
    res.json({ data });
  }),
);

router.put(
  "/requests/:id/archive",
  requirePermission(PERMISSIONS.TRAVEL_HR_READ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await travelService.archiveRequest(id, req.user!.id);
    res.json({ data });
  }),
);

router.post(
  "/requests/:id/restore",
  requirePermission(PERMISSIONS.TRAVEL_REQUEST),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await travelService.restoreRequest(
      id,
      req.user!.id,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

router.delete(
  "/requests/:id/permanent",
  requirePermission(PERMISSIONS.TRAVEL_HR_READ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await travelService.permanentDeleteRequest(
      id,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

// Forwarding to a delegate is gated by the service: only the direct
// manager (or HR) may forward. Same rationale as approve/reject —
// don't require a static perm the user may not hold. Same
// `ensurePermissionsLoaded` requirement (#518) so the HR bypass in
// the service sees a populated permissions array.
router.post(
  "/requests/:id/forward",
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    await ensurePermissionsLoaded(req);
    const body = forwardTravelRequestSchema.parse(req.body);
    const data = await travelService.forwardRequest(
      id,
      req.user!.id,
      req.user!.permissions,
      body,
    );
    res.json({ data });
  }),
);

router.post(
  "/requests/:id/attachments",
  requirePermission(PERMISSIONS.TRAVEL_REQUEST, PERMISSIONS.TRAVEL_HR_READ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const body = addAttachmentsSchema.parse(req.body);
    const data = await travelService.addAttachments(
      id,
      req.user!.id,
      req.user!.permissions,
      body,
    );
    res.json({ data });
  }),
);

router.get(
  "/requests/:id/expenses",
  requirePermission(PERMISSIONS.TRAVEL_READ, PERMISSIONS.TRAVEL_HR_READ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await travelService.getLinkedExpenses(
      id,
      req.user!.id,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

// ── Approval chain admin ────────────────────────────────────────────────

router.get(
  "/approval-steps",
  requirePermission(PERMISSIONS.TRAVEL_HR_SETTINGS),
  asyncHandler(async (_req, res) => {
    const data = await travelService.listApprovalSteps();
    res.json({ data });
  }),
);

router.post(
  "/approval-steps",
  requirePermission(PERMISSIONS.TRAVEL_HR_SETTINGS),
  asyncHandler(async (req, res) => {
    const input = createApprovalStepSchema.parse(req.body);
    const data = await travelService.createApprovalStep(input);
    res.status(201).json({ data });
  }),
);

// Literal /approval-steps/reorder must come before /approval-steps/:id.
router.put(
  "/approval-steps/reorder",
  requirePermission(PERMISSIONS.TRAVEL_HR_SETTINGS),
  asyncHandler(async (req, res) => {
    const input = reorderApprovalStepsSchema.parse(req.body);
    const data = await travelService.reorderApprovalSteps(input);
    res.json({ data });
  }),
);

router.put(
  "/approval-steps/:id",
  requirePermission(PERMISSIONS.TRAVEL_HR_SETTINGS),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = updateApprovalStepSchema.parse(req.body);
    const data = await travelService.updateApprovalStep(id, input);
    res.json({ data });
  }),
);

router.delete(
  "/approval-steps/:id",
  requirePermission(PERMISSIONS.TRAVEL_HR_SETTINGS),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await travelService.deleteApprovalStep(id);
    res.json({ data });
  }),
);

// Travel-desk notification recipients — admin-configurable list of
// emails that receive the long-form approved-request summary. Stored
// in `SystemSetting` under `travel.notification_recipients`. Read is
// open to anyone who can see the approval chain; writes gated on
// settings.
router.get(
  "/notification-recipients",
  requirePermission(PERMISSIONS.TRAVEL_HR_SETTINGS),
  asyncHandler(async (_req, res) => {
    const data = await travelService.getNotificationRecipients();
    res.json({ data });
  }),
);

router.put(
  "/notification-recipients",
  requirePermission(PERMISSIONS.TRAVEL_HR_SETTINGS),
  asyncHandler(async (req, res) => {
    const body = req.body as { emails?: unknown };
    const emails = Array.isArray(body.emails)
      ? (body.emails as unknown[]).filter(
          (v): v is string => typeof v === "string",
        )
      : [];
    const data = await travelService.setNotificationRecipients(emails);
    res.json({ data });
  }),
);

export default router;
