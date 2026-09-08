import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { PERMISSIONS } from "@nexora/contracts";
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
} from "@nexora/contracts/modules/cash-advance/cash-advance.validation";
import { cashAdvanceService } from "@nexora/core";
import type { AppEnv } from "../lib/context";
import { requirePermission } from "../middleware/rbac";

const cashAdvanceRead = [
  PERMISSIONS.CASH_ADVANCE_READ,
  PERMISSIONS.CASH_ADVANCE_READ_ALL,
  PERMISSIONS.CASH_ADVANCE_APPROVE,
] as const;

export const cashAdvance = new Hono<AppEnv>()
  .get("/", requirePermission(...cashAdvanceRead), zValidator("query", cashAdvanceQuerySchema), async (c) =>
    c.json(await cashAdvanceService.list(c.var.db, c.var.user!.id, c.var.user!.permissions, c.req.valid("query"))),
  )
  .post("/", requirePermission(PERMISSIONS.CASH_ADVANCE_CREATE), zValidator("json", createCashAdvanceSchema), async (c) => {
    const result = await cashAdvanceService.create(c.var.db, c.req.valid("json"), c.var.user!.id);
    return c.json(result, 201);
  })
  .get("/approval-steps", requirePermission(PERMISSIONS.CASH_ADVANCE_APPROVE), async (c) =>
    c.json({ data: await cashAdvanceService.listSteps(c.var.db) }),
  )
  .post("/approval-steps", requirePermission(PERMISSIONS.CASH_ADVANCE_APPROVE), zValidator("json", createCashAdvanceStepSchema), async (c) =>
    c.json({ data: await cashAdvanceService.createStep(c.var.db, c.req.valid("json")) }, 201),
  )
  .put("/approval-steps/reorder", requirePermission(PERMISSIONS.CASH_ADVANCE_APPROVE), zValidator("json", reorderCashAdvanceStepsSchema), async (c) =>
    c.json({ data: await cashAdvanceService.reorderSteps(c.var.db, c.req.valid("json")) }),
  )
  .put("/approval-steps/:id", requirePermission(PERMISSIONS.CASH_ADVANCE_APPROVE), zValidator("json", updateCashAdvanceStepSchema), async (c) =>
    c.json({ data: await cashAdvanceService.updateStep(c.var.db, c.req.param("id"), c.req.valid("json")) }),
  )
  .delete("/approval-steps/:id", requirePermission(PERMISSIONS.CASH_ADVANCE_APPROVE), async (c) =>
    c.json({ data: await cashAdvanceService.deleteStep(c.var.db, c.req.param("id")) }),
  )
  .get("/notification-recipients", requirePermission(PERMISSIONS.CASH_ADVANCE_APPROVE), async (c) =>
    c.json({ data: await cashAdvanceService.getRecipients(c.var.db) }),
  )
  .put("/notification-recipients", requirePermission(PERMISSIONS.CASH_ADVANCE_APPROVE), zValidator("json", cashAdvanceRecipientsSchema), async (c) =>
    c.json({ data: await cashAdvanceService.setRecipients(c.var.db, c.req.valid("json").emails) }),
  )
  .get("/:id", requirePermission(...cashAdvanceRead), async (c) =>
    c.json(await cashAdvanceService.getById(c.var.db, c.req.param("id"), c.var.user!.id, c.var.user!.permissions)),
  )
  .get("/:id/items/:itemId/receipt", requirePermission(...cashAdvanceRead), async (c) =>
    c.json({
      data: await cashAdvanceService.getItemReceiptUrl(
        c.var.db,
        c.req.param("id"),
        c.req.param("itemId"),
        c.var.user!.id,
        c.var.user!.permissions,
      ),
    }),
  )
  .patch("/:id", requirePermission(PERMISSIONS.CASH_ADVANCE_CREATE), zValidator("json", updateCashAdvanceSchema), async (c) =>
    c.json(await cashAdvanceService.update(c.var.db, c.req.param("id"), c.req.valid("json"), c.var.user!.id)),
  )
  .delete("/:id", requirePermission(PERMISSIONS.CASH_ADVANCE_CREATE, PERMISSIONS.CASH_ADVANCE_APPROVE), async (c) =>
    c.json(await cashAdvanceService.remove(c.var.db, c.req.param("id"), c.var.user!.id, c.var.user!.permissions)),
  )
  .post("/:id/restore", requirePermission(PERMISSIONS.CASH_ADVANCE_CREATE), async (c) =>
    c.json({ data: await cashAdvanceService.restore(c.var.db, c.req.param("id"), c.var.user!.id, c.var.user!.permissions) }),
  )
  .delete("/:id/permanent", requirePermission(PERMISSIONS.CASH_ADVANCE_APPROVE), async (c) =>
    c.json({
      data: await cashAdvanceService.permanentDelete(
        c.var.db,
        c.req.param("id"),
        c.var.user!.permissions,
      ),
    }),
  )
  .post("/:id/submit", requirePermission(PERMISSIONS.CASH_ADVANCE_CREATE), async (c) =>
    c.json(await cashAdvanceService.submit(c.var.db, c.req.param("id"), c.var.user!.id)),
  )
  .post("/:id/withdraw", requirePermission(PERMISSIONS.CASH_ADVANCE_CREATE), async (c) =>
    c.json(await cashAdvanceService.withdraw(c.var.db, c.req.param("id"), c.var.user!.id)),
  )
  .post("/:id/approve", requirePermission(...cashAdvanceRead), zValidator("json", approveCashAdvanceSchema), async (c) =>
    c.json(
      await cashAdvanceService.approve(
        c.var.db,
        c.req.param("id"),
        c.req.valid("json"),
        c.var.user!.id,
        c.var.user!.permissions,
      ),
    ),
  )
  .post("/:id/reject", requirePermission(...cashAdvanceRead), zValidator("json", rejectCashAdvanceSchema), async (c) =>
    c.json(
      await cashAdvanceService.reject(
        c.var.db,
        c.req.param("id"),
        c.req.valid("json"),
        c.var.user!.id,
        c.var.user!.permissions,
      ),
    ),
  )
  .get("/:id/disbursement-proof", requirePermission(...cashAdvanceRead), async (c) =>
    c.json({
      data: await cashAdvanceService.getDisbursementProofUrl(
        c.var.db,
        c.req.param("id"),
        c.var.user!.id,
        c.var.user!.permissions,
      ),
    }),
  )
  .post("/:id/disburse", requirePermission(PERMISSIONS.CASH_ADVANCE_APPROVE), zValidator("json", disburseCashAdvanceSchema), async (c) =>
    c.json(
      await cashAdvanceService.markDisbursed(
        c.var.db,
        c.req.param("id"),
        c.req.valid("json"),
        c.var.user!.id,
        c.var.user!.permissions,
      ),
    ),
  )
  .post("/:id/clear", requirePermission(PERMISSIONS.CASH_ADVANCE_APPROVE), async (c) =>
    c.json(
      await cashAdvanceService.markCleared(c.var.db, c.req.param("id"), c.var.user!.id, c.var.user!.permissions),
    ),
  );
