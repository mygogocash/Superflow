import { Router } from "express";

import { PERMISSIONS } from "@/common/constants/permissions";
import { getRequiredParam } from "@/common/utils/params";
import {
  authenticate,
  requireActive,
  requirePermission,
} from "@/core/guards/auth.guard";
import { asyncHandler } from "@/core/middleware/async-handler";
import { cashAdvanceService } from "@/modules/cash-advance/cash-advance.service";
import {
  approveCashAdvanceSchema,
  cashAdvanceQuerySchema,
  cashAdvanceRecipientsSchema,
  createCashAdvanceSchema,
  createCashAdvanceStepSchema,
  disburseCashAdvanceSchema,
  rejectCashAdvanceSchema,
  reorderCashAdvanceStepsSchema,
  updateCashAdvanceSchema,
  updateCashAdvanceStepSchema,
} from "@/modules/cash-advance/cash-advance.validation";

const router = Router();
router.use(authenticate, requireActive);

router.get(
  "/",
  requirePermission(
    PERMISSIONS.CASH_ADVANCE_READ,
    PERMISSIONS.CASH_ADVANCE_READ_ALL,
    PERMISSIONS.CASH_ADVANCE_APPROVE,
  ),
  asyncHandler(async (req, res) => {
    const query = cashAdvanceQuerySchema.parse(req.query);
    const result = await cashAdvanceService.list(
      req.user!.id,
      req.user!.permissions,
      query,
    );
    res.json(result);
  }),
);

router.post(
  "/",
  requirePermission(PERMISSIONS.CASH_ADVANCE_CREATE),
  asyncHandler(async (req, res) => {
    const input = createCashAdvanceSchema.parse(req.body);
    const result = await cashAdvanceService.create(input, req.user!.id);
    res.status(201).json(result);
  }),
);

// ── Approval-chain config (literal paths BEFORE "/:id" — route-order
// pitfall per CLAUDE.md). Gated on cash-advance:approve (HR/Finance). ──
router.get(
  "/approval-steps",
  requirePermission(PERMISSIONS.CASH_ADVANCE_APPROVE),
  asyncHandler(async (_req, res) => {
    res.json({ data: await cashAdvanceService.listSteps() });
  }),
);
router.post(
  "/approval-steps",
  requirePermission(PERMISSIONS.CASH_ADVANCE_APPROVE),
  asyncHandler(async (req, res) => {
    const input = createCashAdvanceStepSchema.parse(req.body);
    res.status(201).json({ data: await cashAdvanceService.createStep(input) });
  }),
);
router.put(
  "/approval-steps/reorder",
  requirePermission(PERMISSIONS.CASH_ADVANCE_APPROVE),
  asyncHandler(async (req, res) => {
    const input = reorderCashAdvanceStepsSchema.parse(req.body);
    res.json({ data: await cashAdvanceService.reorderSteps(input) });
  }),
);
router.put(
  "/approval-steps/:id",
  requirePermission(PERMISSIONS.CASH_ADVANCE_APPROVE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = updateCashAdvanceStepSchema.parse(req.body);
    res.json({ data: await cashAdvanceService.updateStep(id, input) });
  }),
);
router.delete(
  "/approval-steps/:id",
  requirePermission(PERMISSIONS.CASH_ADVANCE_APPROVE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    res.json({ data: await cashAdvanceService.deleteStep(id) });
  }),
);
router.get(
  "/notification-recipients",
  requirePermission(PERMISSIONS.CASH_ADVANCE_APPROVE),
  asyncHandler(async (_req, res) => {
    res.json({ data: await cashAdvanceService.getRecipients() });
  }),
);
router.put(
  "/notification-recipients",
  requirePermission(PERMISSIONS.CASH_ADVANCE_APPROVE),
  asyncHandler(async (req, res) => {
    const input = cashAdvanceRecipientsSchema.parse(req.body);
    res.json({ data: await cashAdvanceService.setRecipients(input.emails) });
  }),
);

router.get(
  "/:id",
  requirePermission(
    PERMISSIONS.CASH_ADVANCE_READ,
    PERMISSIONS.CASH_ADVANCE_READ_ALL,
    PERMISSIONS.CASH_ADVANCE_APPROVE,
  ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const result = await cashAdvanceService.getById(
      id,
      req.user!.id,
      req.user!.permissions,
    );
    res.json(result);
  }),
);

// Fresh signed URL for a line item's receipt (private bucket), minted on
// click so the link never outlives its Supabase JWT.
router.get(
  "/:id/items/:itemId/receipt",
  requirePermission(
    PERMISSIONS.CASH_ADVANCE_READ,
    PERMISSIONS.CASH_ADVANCE_READ_ALL,
    PERMISSIONS.CASH_ADVANCE_APPROVE,
  ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const itemId = getRequiredParam(req.params, "itemId");
    const data = await cashAdvanceService.getItemReceiptUrl(
      id,
      itemId,
      req.user!.id,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

router.patch(
  "/:id",
  requirePermission(PERMISSIONS.CASH_ADVANCE_CREATE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = updateCashAdvanceSchema.parse(req.body);
    const result = await cashAdvanceService.update(id, input, req.user!.id);
    res.json(result);
  }),
);

router.delete(
  "/:id",
  requirePermission(
    PERMISSIONS.CASH_ADVANCE_CREATE,
    PERMISSIONS.CASH_ADVANCE_APPROVE,
  ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const result = await cashAdvanceService.remove(
      id,
      req.user!.id,
      req.user!.permissions,
    );
    res.json(result);
  }),
);

router.post(
  "/:id/restore",
  requirePermission(PERMISSIONS.CASH_ADVANCE_CREATE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const result = await cashAdvanceService.restore(
      id,
      req.user!.id,
      req.user!.permissions,
    );
    res.json({ data: result });
  }),
);

router.delete(
  "/:id/permanent",
  requirePermission(PERMISSIONS.CASH_ADVANCE_APPROVE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const result = await cashAdvanceService.permanentDelete(
      id,
      req.user!.permissions,
    );
    res.json({ data: result });
  }),
);

router.post(
  "/:id/submit",
  requirePermission(PERMISSIONS.CASH_ADVANCE_CREATE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const result = await cashAdvanceService.submit(id, req.user!.id);
    res.json(result);
  }),
);

// Owner pulls a submitted request back to draft to edit + resubmit.
// Ownership is enforced in the service, like submit.
router.post(
  "/:id/withdraw",
  requirePermission(PERMISSIONS.CASH_ADVANCE_CREATE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const result = await cashAdvanceService.withdraw(id, req.user!.id);
    res.json(result);
  }),
);

// Approve / reject open to any cash-advance reader; the service's
// assertCanActOnStep enforces that only the current step's approver
// (manager / assigned user) or HR-with-approve can actually act.
router.post(
  "/:id/approve",
  requirePermission(
    PERMISSIONS.CASH_ADVANCE_READ,
    PERMISSIONS.CASH_ADVANCE_READ_ALL,
    PERMISSIONS.CASH_ADVANCE_APPROVE,
  ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = approveCashAdvanceSchema.parse(req.body);
    const result = await cashAdvanceService.approve(
      id,
      input,
      req.user!.id,
      req.user!.permissions,
    );
    res.json(result);
  }),
);

router.post(
  "/:id/reject",
  requirePermission(
    PERMISSIONS.CASH_ADVANCE_READ,
    PERMISSIONS.CASH_ADVANCE_READ_ALL,
    PERMISSIONS.CASH_ADVANCE_APPROVE,
  ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = rejectCashAdvanceSchema.parse(req.body);
    const result = await cashAdvanceService.reject(
      id,
      input,
      req.user!.id,
      req.user!.permissions,
    );
    res.json(result);
  }),
);

router.get(
  "/:id/disbursement-proof",
  requirePermission(
    PERMISSIONS.CASH_ADVANCE_READ,
    PERMISSIONS.CASH_ADVANCE_READ_ALL,
    PERMISSIONS.CASH_ADVANCE_APPROVE,
  ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await cashAdvanceService.getDisbursementProofUrl(
      id,
      req.user!.id,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

router.post(
  "/:id/disburse",
  requirePermission(PERMISSIONS.CASH_ADVANCE_APPROVE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = disburseCashAdvanceSchema.parse(req.body);
    const result = await cashAdvanceService.markDisbursed(
      id,
      input,
      req.user!.id,
      req.user!.permissions,
    );
    res.json(result);
  }),
);

router.post(
  "/:id/clear",
  requirePermission(PERMISSIONS.CASH_ADVANCE_APPROVE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const result = await cashAdvanceService.markCleared(
      id,
      req.user!.id,
      req.user!.permissions,
    );
    res.json(result);
  }),
);

export default router;
