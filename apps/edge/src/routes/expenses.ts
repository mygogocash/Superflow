import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { PERMISSIONS } from "@nexora/contracts";
import {
  addExpenseToReportSchema,
  approveExpenseReportSchema,
  convertAmountSchema,
  createCategorySchema,
  createExpenseApprovalStepSchema,
  createExpenseReportSchema,
  createExpenseSchema,
  expenseQuerySchema,
  expenseReportQuerySchema,
  monthlyExpenseSummaryQuerySchema,
  parseUpsertExchangeRateBody,
  rejectExpenseReportSchema,
  rejectExpenseSchema,
  reorderExpenseApprovalStepsSchema,
  updateCategorySchema,
  updateExpenseApprovalStepSchema,
  updateExpenseInReportSchema,
  updateExpenseReportSchema,
  updateExpenseSchema,
  upsertExpenseReminderSettingsSchema,
} from "@nexora/contracts/modules/expenses/expenses.validation";
import { expensesService, parseR2ReceiptKey } from "@nexora/core";
import type { AppEnv } from "../lib/context";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import { NotFoundException } from "../lib/errors";

const expenseRead = [
  PERMISSIONS.EXPENSE_READ,
  PERMISSIONS.EXPENSE_HR_READ,
] as const;

const expenseReceiptRead = [
  PERMISSIONS.EXPENSE_READ,
  PERMISSIONS.EXPENSE_HR_READ,
  PERMISSIONS.EXPENSE_APPROVE,
  PERMISSIONS.ACCOUNTING_READ,
  PERMISSIONS.ACCOUNTING_ADMIN,
] as const;

export const expenses = new Hono<AppEnv>()
  .get(
    "/meta/entities",
    requirePermission(PERMISSIONS.EXPENSE_READ, PERMISSIONS.EXPENSE_CREATE, PERMISSIONS.EXPENSE_HR_READ),
    async (c) => c.json({ data: await expensesService.listActiveEntitiesForForms(c.var.db) }),
  )
  .get("/categories", requirePermission(...expenseRead), async (c) =>
    c.json({ data: await expensesService.listCategories(c.var.db) }),
  )
  .post("/categories", requirePermission(PERMISSIONS.EXPENSE_HR_READ), zValidator("json", createCategorySchema), async (c) =>
    c.json({ data: await expensesService.createCategory(c.var.db, c.req.valid("json")) }, 201),
  )
  .put("/categories/:catId", requirePermission(PERMISSIONS.EXPENSE_HR_READ), zValidator("json", updateCategorySchema), async (c) =>
    c.json({ data: await expensesService.updateCategory(c.var.db, c.req.param("catId"), c.req.valid("json")) }),
  )
  .delete("/categories/:catId", requirePermission(PERMISSIONS.EXPENSE_HR_READ), async (c) => {
    await expensesService.deleteCategory(c.var.db, c.req.param("catId"));
    return c.json({ data: { success: true } });
  })
  .get("/exchange-rates", requirePermission(...expenseRead), async (c) => {
    const baseCurrency = c.req.query("baseCurrency") ?? "USD";
    const date = c.req.query("date");
    return c.json(await expensesService.listExchangeRates(c.var.db, baseCurrency, date));
  })
  .post("/exchange-rates", requirePermission(PERMISSIONS.EXPENSE_HR_READ), async (c) => {
    const input = parseUpsertExchangeRateBody(await c.req.json());
    return c.json({ data: await expensesService.upsertExchangeRate(c.var.db, input) });
  })
  .get("/convert", requirePermission(...expenseRead), zValidator("query", convertAmountSchema), async (c) => {
    const input = c.req.valid("query");
    return c.json(
      await expensesService.convertExpenseAmount(c.var.db, input.amount, input.fromCurrency, input.toCurrency),
    );
  })
  .get("/spending-overview", requirePermission(...expenseRead), async (c) =>
    c.json(
      await expensesService.getCategorySpendingOverview(
        c.var.db,
        c.var.user!.permissions,
        c.var.user!.id,
        c.req.query("startDate"),
        c.req.query("endDate"),
      ),
    ),
  )
  .get("/export", requirePermission(PERMISSIONS.EXPENSE_HR_READ), async (c) =>
    c.json({ error: { code: "NOT_IMPLEMENTED", message: "Expense export is not available on edge yet" } }, 501),
  )
  .get("/", requirePermission(...expenseRead), zValidator("query", expenseQuerySchema), async (c) =>
    c.json(await expensesService.listExpenses(c.var.db, c.var.user!.id, c.var.user!.permissions, c.req.valid("query"))),
  )
  .get(
    "/approval-steps",
    requirePermission(PERMISSIONS.EXPENSE_HR_READ, PERMISSIONS.EXPENSE_APPROVE),
    async (c) => c.json({ data: await expensesService.listApprovalSteps(c.var.db) }),
  )
  .post(
    "/approval-steps",
    requirePermission(PERMISSIONS.EXPENSE_ASSIGN_APPROVER),
    zValidator("json", createExpenseApprovalStepSchema),
    async (c) => c.json({ data: await expensesService.createApprovalStep(c.var.db, c.req.valid("json")) }, 201),
  )
  .post(
    "/approval-steps/reorder",
    requirePermission(PERMISSIONS.EXPENSE_ASSIGN_APPROVER),
    zValidator("json", reorderExpenseApprovalStepsSchema),
    async (c) => c.json({ data: await expensesService.reorderApprovalSteps(c.var.db, c.req.valid("json")) }),
  )
  .put(
    "/approval-steps/:stepId",
    requirePermission(PERMISSIONS.EXPENSE_ASSIGN_APPROVER),
    zValidator("json", updateExpenseApprovalStepSchema),
    async (c) =>
      c.json({ data: await expensesService.updateApprovalStep(c.var.db, c.req.param("stepId"), c.req.valid("json")) }),
  )
  .delete("/approval-steps/:stepId", requirePermission(PERMISSIONS.EXPENSE_ASSIGN_APPROVER), async (c) => {
    await expensesService.deleteApprovalStep(c.var.db, c.req.param("stepId"));
    return c.json({ data: { success: true } });
  })
  .get("/reports", requirePermission(...expenseRead), zValidator("query", expenseReportQuerySchema), async (c) =>
    c.json(await expensesService.listReports(c.var.db, c.var.user!.id, c.var.user!.permissions, c.req.valid("query"))),
  )
  .get(
    "/reports/monthly-summary",
    requirePermission(PERMISSIONS.EXPENSE_HR_READ),
    zValidator("query", monthlyExpenseSummaryQuerySchema),
    async (c) => c.json(await expensesService.monthlySummary(c.var.db, c.var.user!.permissions, c.req.valid("query"))),
  )
  .post(
    "/reports",
    requirePermission(PERMISSIONS.EXPENSE_CREATE),
    zValidator("json", createExpenseReportSchema),
    async (c) =>
      c.json(
        { data: await expensesService.createReport(c.var.db, c.var.user!.id, c.req.valid("json"), c.var.user!.permissions) },
        201,
      ),
  )
  .get("/reports/:reportId", requirePermission(...expenseRead), async (c) =>
    c.json({
      data: await expensesService.getReportById(c.var.db, c.req.param("reportId"), c.var.user!.id, c.var.user!.permissions),
    }),
  )
  .put(
    "/reports/:reportId",
    requirePermission(PERMISSIONS.EXPENSE_CREATE),
    zValidator("json", updateExpenseReportSchema),
    async (c) =>
      c.json({
        data: await expensesService.updateReport(
          c.var.db,
          c.req.param("reportId"),
          c.var.user!.id,
          c.req.valid("json"),
          c.var.user!.permissions,
        ),
      }),
  )
  .delete("/reports/:reportId", requirePermission(PERMISSIONS.EXPENSE_CREATE), async (c) => {
    await expensesService.deleteReport(c.var.db, c.req.param("reportId"), c.var.user!.id, c.var.user!.permissions);
    return c.json({ data: { success: true } });
  })
  .post("/reports/:reportId/restore", requirePermission(PERMISSIONS.EXPENSE_CREATE), async (c) =>
    c.json({
      data: await expensesService.restoreReport(c.var.db, c.req.param("reportId"), c.var.user!.id, c.var.user!.permissions),
    }),
  )
  .delete("/reports/:reportId/permanent", requirePermission(PERMISSIONS.EXPENSE_HR_DELETE), async (c) =>
    c.json({
      data: await expensesService.permanentDeleteReport(
        c.var.db,
        c.req.param("reportId"),
        c.var.user!.permissions,
      ),
    }),
  )
  .post(
    "/reports/:reportId/expenses",
    requirePermission(PERMISSIONS.EXPENSE_CREATE),
    zValidator("json", addExpenseToReportSchema),
    async (c) =>
      c.json(
        {
          data: await expensesService.addExpenseToReport(
            c.var.db,
            c.req.param("reportId"),
            c.var.user!.id,
            c.req.valid("json"),
          ),
        },
        201,
      ),
  )
  .put(
    "/reports/:reportId/expenses/:expenseId",
    requirePermission(PERMISSIONS.EXPENSE_CREATE),
    zValidator("json", updateExpenseInReportSchema),
    async (c) =>
      c.json({
        data: await expensesService.updateExpenseInReport(
          c.var.db,
          c.req.param("reportId"),
          c.req.param("expenseId"),
          c.var.user!.id,
          c.req.valid("json"),
        ),
      }),
  )
  .delete("/reports/:reportId/expenses/:expenseId", requirePermission(PERMISSIONS.EXPENSE_CREATE), async (c) => {
    await expensesService.removeExpenseFromReport(
      c.var.db,
      c.req.param("reportId"),
      c.req.param("expenseId"),
      c.var.user!.id,
    );
    return c.json({ data: { success: true } });
  })
  .get("/reports/:reportId/expenses/:expenseId/receipt", requirePermission(...expenseReceiptRead), async (c) => {
    const expenseId = c.req.param("expenseId");
    const { url } = await expensesService.getExpenseReceiptUrl(
      c.var.db,
      expenseId,
      c.var.user!.id,
      c.var.user!.permissions,
    );
    const key = parseR2ReceiptKey(url);
    if (key) {
      const obj = await c.env.R2_PRIVATE.get(key);
      if (!obj) throw new NotFoundException("Receipt file is not available");
      return new Response(obj.body, {
        headers: {
          "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream",
          "Content-Disposition": `inline; filename="receipt-${expenseId}"`,
        },
      });
    }
    return c.json({ data: { url } });
  })
  .post("/reports/:reportId/submit", requirePermission(PERMISSIONS.EXPENSE_CREATE), async (c) =>
    c.json({ data: await expensesService.submitReport(c.var.db, c.req.param("reportId"), c.var.user!.id) }),
  )
  .post("/reports/:reportId/approve", requireAuth, zValidator("json", approveExpenseReportSchema), async (c) =>
    c.json({
      data: await expensesService.approveReport(
        c.var.db,
        c.req.param("reportId"),
        c.var.user!.id,
        c.var.user!.permissions,
        c.req.valid("json"),
      ),
    }),
  )
  .post("/reports/:reportId/reject", requireAuth, zValidator("json", rejectExpenseReportSchema), async (c) =>
    c.json({
      data: await expensesService.rejectReport(
        c.var.db,
        c.req.param("reportId"),
        c.var.user!.id,
        c.req.valid("json").reason,
        c.var.user!.permissions,
      ),
    }),
  )
  .post("/reports/:reportId/reimburse", requirePermission(PERMISSIONS.EXPENSE_HR_APPROVE), async (c) =>
    c.json({ data: await expensesService.reimburseReport(c.var.db, c.req.param("reportId"), c.var.user!.id) }),
  )
  .post("/reports/:reportId/mark-payroll-processed", requirePermission(PERMISSIONS.EXPENSE_HR_APPROVE), async (c) =>
    c.json({ data: await expensesService.markReportPayrollProcessed(c.var.db, c.req.param("reportId"), c.var.user!.id) }),
  )
  .post("/reports/:reportId/revert-reimbursement", requirePermission(PERMISSIONS.EXPENSE_HR_APPROVE), async (c) =>
    c.json({ data: await expensesService.revertReportReimbursement(c.var.db, c.req.param("reportId"), c.var.user!.id) }),
  )
  .get("/reports/:reportId/decisions", requirePermission(...expenseRead), async (c) =>
    c.json({ data: await expensesService.listDecisions(c.var.db, c.req.param("reportId")) }),
  )
  .post("/", requirePermission(PERMISSIONS.EXPENSE_CREATE), zValidator("json", createExpenseSchema), async (c) =>
    c.json({ data: await expensesService.createExpense(c.var.db, c.var.user!.id, c.req.valid("json")) }, 201),
  )
  .get("/notification-recipients", requirePermission(PERMISSIONS.EXPENSE_HR_SETTINGS), async (c) =>
    c.json({ data: await expensesService.getNotificationRecipients(c.var.db) }),
  )
  .put("/notification-recipients", requirePermission(PERMISSIONS.EXPENSE_HR_SETTINGS), async (c) => {
    const body = (await c.req.json()) as { emails?: unknown; recipients?: unknown };
    const incoming: unknown[] = Array.isArray(body.recipients)
      ? body.recipients
      : Array.isArray(body.emails)
        ? body.emails
        : [];
    return c.json({ data: await expensesService.setNotificationRecipients(c.var.db, incoming) });
  })
  .get("/reminder-settings", requirePermission(PERMISSIONS.EXPENSE_HR_SETTINGS), async (c) =>
    c.json({ data: await expensesService.getReminderSettings(c.var.db) }),
  )
  .put(
    "/reminder-settings",
    requirePermission(PERMISSIONS.EXPENSE_HR_SETTINGS),
    zValidator("json", upsertExpenseReminderSettingsSchema),
    async (c) => c.json({ data: await expensesService.setReminderSettings(c.var.db, c.req.valid("json")) }),
  )
  .get("/:id", requirePermission(...expenseRead), async (c) =>
    c.json({
      data: await expensesService.getExpenseById(c.var.db, c.req.param("id"), c.var.user!.id, c.var.user!.permissions),
    }),
  )
  .put("/:id", requirePermission(PERMISSIONS.EXPENSE_CREATE), zValidator("json", updateExpenseSchema), async (c) =>
    c.json({ data: await expensesService.updateExpense(c.var.db, c.req.param("id"), c.var.user!.id, c.req.valid("json")) }),
  )
  .delete("/:id", requirePermission(PERMISSIONS.EXPENSE_CREATE), async (c) => {
    await expensesService.deleteExpense(c.var.db, c.req.param("id"), c.var.user!.id);
    return c.json({ data: { success: true } });
  })
  .post("/:id/restore", requirePermission(PERMISSIONS.EXPENSE_CREATE), async (c) =>
    c.json({
      data: await expensesService.restoreExpense(c.var.db, c.req.param("id"), c.var.user!.id, c.var.user!.permissions),
    }),
  )
  .delete("/:id/permanent", requirePermission(PERMISSIONS.EXPENSE_HR_DELETE), async (c) =>
    c.json({
      data: await expensesService.permanentDeleteExpense(
        c.var.db,
        c.req.param("id"),
        c.var.user!.permissions,
      ),
    }),
  )
  .put("/:id/approve", requirePermission(PERMISSIONS.EXPENSE_APPROVE), async (c) =>
    c.json({ data: await expensesService.approveExpense(c.var.db, c.req.param("id"), c.var.user!.id) }),
  )
  .put("/:id/reject", requirePermission(PERMISSIONS.EXPENSE_APPROVE), zValidator("json", rejectExpenseSchema), async (c) =>
    c.json({
      data: await expensesService.rejectExpense(c.var.db, c.req.param("id"), c.var.user!.id, c.req.valid("json").reason),
    }),
  )
  .put("/:id/reimburse", requirePermission(PERMISSIONS.EXPENSE_HR_APPROVE), async (c) =>
    c.json({ data: await expensesService.reimburseExpense(c.var.db, c.req.param("id"), c.var.user!.id) }),
  );
