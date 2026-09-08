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
import { expensesService } from "@/modules/expenses/expenses.service";
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
} from "@/modules/expenses/expenses.validation";

const router = Router();

router.use(authenticate, requireActive);

// ── Static routes MUST come before /:id ──

router.get(
  "/meta/entities",
  requirePermission(
    PERMISSIONS.EXPENSE_READ,
    PERMISSIONS.EXPENSE_CREATE,
    PERMISSIONS.EXPENSE_HR_READ,
  ),
  asyncHandler(async (_req, res) => {
    const data = await expensesService.listActiveEntitiesForForms();
    res.json({ data });
  }),
);

router.get(
  "/categories",
  requirePermission(PERMISSIONS.EXPENSE_READ, PERMISSIONS.EXPENSE_HR_READ),
  asyncHandler(async (_req, res) => {
    const data = await expensesService.listCategories();
    res.json({ data });
  }),
);

router.post(
  "/categories",
  requirePermission(PERMISSIONS.EXPENSE_HR_READ),
  asyncHandler(async (req, res) => {
    const input = createCategorySchema.parse(req.body);
    const data = await expensesService.createCategory(input);
    res.status(201).json({ data });
  }),
);

router.put(
  "/categories/:catId",
  requirePermission(PERMISSIONS.EXPENSE_HR_READ),
  asyncHandler(async (req, res) => {
    const catId = getRequiredParam(req.params, "catId");
    const input = updateCategorySchema.parse(req.body);
    const data = await expensesService.updateCategory(catId, input);
    res.json({ data });
  }),
);

router.delete(
  "/categories/:catId",
  requirePermission(PERMISSIONS.EXPENSE_HR_READ),
  asyncHandler(async (req, res) => {
    const catId = getRequiredParam(req.params, "catId");
    await expensesService.deleteCategory(catId);
    res.json({ data: { success: true } });
  }),
);

router.get(
  "/exchange-rates",
  requirePermission(PERMISSIONS.EXPENSE_READ, PERMISSIONS.EXPENSE_HR_READ),
  asyncHandler(async (req, res) => {
    const baseCurrency =
      typeof req.query.baseCurrency === "string"
        ? req.query.baseCurrency
        : "USD";
    const date =
      typeof req.query.date === "string" ? req.query.date : undefined;
    const result = await expensesService.listExchangeRates(baseCurrency, date);
    res.json(result);
  }),
);

router.post(
  "/exchange-rates",
  requirePermission(PERMISSIONS.EXPENSE_HR_READ),
  asyncHandler(async (req, res) => {
    const input = parseUpsertExchangeRateBody(req.body);
    const data = await expensesService.upsertExchangeRate(input);
    res.json({ data });
  }),
);

router.get(
  "/convert",
  requirePermission(PERMISSIONS.EXPENSE_READ, PERMISSIONS.EXPENSE_HR_READ),
  asyncHandler(async (req, res) => {
    const input = convertAmountSchema.parse(req.query);
    const result = await expensesService.convertExpenseAmount(
      input.amount,
      input.fromCurrency,
      input.toCurrency,
    );
    res.json(result);
  }),
);

router.get(
  "/spending-overview",
  requirePermission(PERMISSIONS.EXPENSE_READ, PERMISSIONS.EXPENSE_HR_READ),
  asyncHandler(async (req, res) => {
    const startDate =
      typeof req.query.startDate === "string" ? req.query.startDate : undefined;
    const endDate =
      typeof req.query.endDate === "string" ? req.query.endDate : undefined;
    const result = await expensesService.getCategorySpendingOverview(
      req.user!.permissions,
      req.user!.id,
      startDate,
      endDate,
    );
    res.json(result);
  }),
);

router.get(
  "/export",
  requirePermission(PERMISSIONS.EXPENSE_HR_READ),
  asyncHandler(async (req, res) => {
    const {
      page: _page,
      limit: _limit,
      ...filters
    } = expenseQuerySchema.parse(req.query);
    const buffer = await expensesService.exportExpensesXlsx(filters);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="expenses-export.xlsx"',
    );
    res.send(buffer);
  }),
);

router.get(
  "/",
  requirePermission(PERMISSIONS.EXPENSE_READ, PERMISSIONS.EXPENSE_HR_READ),
  asyncHandler(async (req, res) => {
    const query = expenseQuerySchema.parse(req.query);
    const result = await expensesService.listExpenses(
      req.user!.id,
      req.user!.permissions,
      query,
    );
    res.json(result);
  }),
);

// ── Expense reports (monthly approval flow) ──
//
// Literal `/reports*` routes must come before `/:id` below or Express
// will hand the GET to the single-expense handler.

// ── Approval chain (admin) ──
//
// Literal `/approval-steps*` routes must come before the `/reports`
// routes so Express's order-sensitive matcher doesn't drop them
// behind the `/reports/:reportId` handler.

router.get(
  "/approval-steps",
  requirePermission(PERMISSIONS.EXPENSE_HR_READ, PERMISSIONS.EXPENSE_APPROVE),
  asyncHandler(async (_req, res) => {
    const data = await expensesService.listApprovalSteps();
    res.json({ data });
  }),
);

router.post(
  "/approval-steps",
  requirePermission(PERMISSIONS.EXPENSE_ASSIGN_APPROVER),
  asyncHandler(async (req, res) => {
    const input = createExpenseApprovalStepSchema.parse(req.body);
    const data = await expensesService.createApprovalStep(input);
    res.status(201).json({ data });
  }),
);

router.post(
  "/approval-steps/reorder",
  requirePermission(PERMISSIONS.EXPENSE_ASSIGN_APPROVER),
  asyncHandler(async (req, res) => {
    const input = reorderExpenseApprovalStepsSchema.parse(req.body);
    const data = await expensesService.reorderApprovalSteps(input);
    res.json({ data });
  }),
);

router.put(
  "/approval-steps/:stepId",
  requirePermission(PERMISSIONS.EXPENSE_ASSIGN_APPROVER),
  asyncHandler(async (req, res) => {
    const stepId = getRequiredParam(req.params, "stepId");
    const input = updateExpenseApprovalStepSchema.parse(req.body);
    const data = await expensesService.updateApprovalStep(stepId, input);
    res.json({ data });
  }),
);

router.delete(
  "/approval-steps/:stepId",
  requirePermission(PERMISSIONS.EXPENSE_ASSIGN_APPROVER),
  asyncHandler(async (req, res) => {
    const stepId = getRequiredParam(req.params, "stepId");
    await expensesService.deleteApprovalStep(stepId);
    res.json({ data: { success: true } });
  }),
);

router.get(
  "/reports",
  requirePermission(PERMISSIONS.EXPENSE_READ, PERMISSIONS.EXPENSE_HR_READ),
  asyncHandler(async (req, res) => {
    const query = expenseReportQuerySchema.parse(req.query);
    const result = await expensesService.listReports(
      req.user!.id,
      req.user!.permissions,
      query,
    );
    res.json(result);
  }),
);

// Literal path — must precede "/reports/:reportId" so it isn't matched
// as an id. Workspace-wide monthly roll-up; HR/Admin only.
router.get(
  "/reports/monthly-summary",
  requirePermission(PERMISSIONS.EXPENSE_HR_READ),
  asyncHandler(async (req, res) => {
    const query = monthlyExpenseSummaryQuerySchema.parse(req.query);
    const result = await expensesService.monthlySummary(
      req.user!.permissions,
      query,
    );
    res.json(result);
  }),
);

router.post(
  "/reports",
  requirePermission(PERMISSIONS.EXPENSE_CREATE),
  asyncHandler(async (req, res) => {
    const input = createExpenseReportSchema.parse(req.body);
    const data = await expensesService.createReport(
      req.user!.id,
      input,
      req.user!.permissions,
    );
    res.status(201).json({ data });
  }),
);

router.get(
  "/reports/:reportId",
  requirePermission(PERMISSIONS.EXPENSE_READ, PERMISSIONS.EXPENSE_HR_READ),
  asyncHandler(async (req, res) => {
    const reportId = getRequiredParam(req.params, "reportId");
    const data = await expensesService.getReportById(
      reportId,
      req.user!.id,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

router.put(
  "/reports/:reportId",
  requirePermission(PERMISSIONS.EXPENSE_CREATE),
  asyncHandler(async (req, res) => {
    const reportId = getRequiredParam(req.params, "reportId");
    const input = updateExpenseReportSchema.parse(req.body);
    const data = await expensesService.updateReport(
      reportId,
      req.user!.id,
      input,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

router.delete(
  "/reports/:reportId",
  requirePermission(PERMISSIONS.EXPENSE_CREATE),
  asyncHandler(async (req, res) => {
    const reportId = getRequiredParam(req.params, "reportId");
    await expensesService.deleteReport(
      reportId,
      req.user!.id,
      req.user!.permissions,
    );
    res.json({ data: { success: true } });
  }),
);

router.post(
  "/reports/:reportId/restore",
  requirePermission(PERMISSIONS.EXPENSE_CREATE),
  asyncHandler(async (req, res) => {
    const reportId = getRequiredParam(req.params, "reportId");
    const data = await expensesService.restoreReport(
      reportId,
      req.user!.id,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

router.delete(
  "/reports/:reportId/permanent",
  requirePermission(PERMISSIONS.EXPENSE_HR_DELETE),
  asyncHandler(async (req, res) => {
    const reportId = getRequiredParam(req.params, "reportId");
    const data = await expensesService.permanentDeleteReport(
      reportId,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

router.post(
  "/reports/:reportId/expenses",
  requirePermission(PERMISSIONS.EXPENSE_CREATE),
  asyncHandler(async (req, res) => {
    const reportId = getRequiredParam(req.params, "reportId");
    const input = addExpenseToReportSchema.parse(req.body);
    const data = await expensesService.addExpenseToReport(
      reportId,
      req.user!.id,
      input,
    );
    res.status(201).json({ data });
  }),
);

router.put(
  "/reports/:reportId/expenses/:expenseId",
  requirePermission(PERMISSIONS.EXPENSE_CREATE),
  asyncHandler(async (req, res) => {
    const reportId = getRequiredParam(req.params, "reportId");
    const expenseId = getRequiredParam(req.params, "expenseId");
    const input = updateExpenseInReportSchema.parse(req.body);
    const data = await expensesService.updateExpenseInReport(
      reportId,
      expenseId,
      req.user!.id,
      input,
    );
    res.json({ data });
  }),
);

router.delete(
  "/reports/:reportId/expenses/:expenseId",
  requirePermission(PERMISSIONS.EXPENSE_CREATE),
  asyncHandler(async (req, res) => {
    const reportId = getRequiredParam(req.params, "reportId");
    const expenseId = getRequiredParam(req.params, "expenseId");
    await expensesService.removeExpenseFromReport(
      reportId,
      expenseId,
      req.user!.id,
    );
    res.json({ data: { success: true } });
  }),
);

// Mint a fresh signed URL on every click rather than relying on the
// 24h-stamped URL returned by the report fetch. Approvers + HR need
// this for the View button on the approval queue — the previously
// stored URL's Supabase JWT was outliving page-open time.
router.get(
  "/reports/:reportId/expenses/:expenseId/receipt",
  requirePermission(
    PERMISSIONS.EXPENSE_READ,
    PERMISSIONS.EXPENSE_HR_READ,
    PERMISSIONS.EXPENSE_APPROVE,
    PERMISSIONS.ACCOUNTING_READ,
    PERMISSIONS.ACCOUNTING_ADMIN,
  ),
  asyncHandler(async (req, res) => {
    const expenseId = getRequiredParam(req.params, "expenseId");
    const data = await expensesService.getExpenseReceiptUrl(
      expenseId,
      req.user!.id,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

router.post(
  "/reports/:reportId/submit",
  requirePermission(PERMISSIONS.EXPENSE_CREATE),
  asyncHandler(async (req, res) => {
    const reportId = getRequiredParam(req.params, "reportId");
    const data = await expensesService.submitReport(reportId, req.user!.id);
    res.json({ data });
  }),
);

// Approve / reject are gated by the service, not by `expense:approve`.
// The service-level authorisation (snapshot chain + parallel manager
// fallback in approveReport / rejectReport) is the source of truth: a
// submitter's direct line manager must be able to act on the report
// even when their role lacks `expense:approve` (e.g. an Employee role
// holder who happens to manage someone). Adding a route-level perm
// guard short-circuits that fallback and surfaces as the bug Sid hit
// where Vivek's manager could view but not approve. Anyone else hits
// `ForbiddenException` from the service.
router.post(
  "/reports/:reportId/approve",
  asyncHandler(async (req, res) => {
    // No `requirePermission(...)` middleware here (see block comment
    // above), so the auth guard ships an empty `permissions` array.
    // The service consults the HR-approve bypass against this list,
    // which then silently no-ops for Sarah / admin. Lazy-load before
    // the service call so the bypass actually sees the caller's
    // perms.
    await ensurePermissionsLoaded(req);
    const reportId = getRequiredParam(req.params, "reportId");
    // Optional body — empty / missing means "approve the full running
    // total". When `approvedAmount` is supplied the service caps it
    // against the report's submitted total.
    const body = approveExpenseReportSchema.parse(req.body ?? {});
    const data = await expensesService.approveReport(
      reportId,
      req.user!.id,
      req.user!.permissions,
      body,
    );
    res.json({ data });
  }),
);

router.post(
  "/reports/:reportId/reject",
  asyncHandler(async (req, res) => {
    // Same lazy-load reason as approve above.
    await ensurePermissionsLoaded(req);
    const reportId = getRequiredParam(req.params, "reportId");
    const { reason } = rejectExpenseReportSchema.parse(req.body);
    const data = await expensesService.rejectReport(
      reportId,
      req.user!.id,
      reason,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

router.post(
  "/reports/:reportId/reimburse",
  requirePermission(PERMISSIONS.EXPENSE_HR_APPROVE),
  asyncHandler(async (req, res) => {
    const reportId = getRequiredParam(req.params, "reportId");
    const data = await expensesService.reimburseReport(reportId, req.user!.id);
    res.json({ data });
  }),
);

// Manual flip from `approved` to the intermediate `payroll_processed`
// state. Same permission gate as reimburse — finance HR who run
// payroll are the ones who'd know the report has been added to a
// payroll batch. No email is sent on this transition; the employee
// hears about it only when the final `reimbursed` flip happens.
router.post(
  "/reports/:reportId/mark-payroll-processed",
  requirePermission(PERMISSIONS.EXPENSE_HR_APPROVE),
  asyncHandler(async (req, res) => {
    const reportId = getRequiredParam(req.params, "reportId");
    const data = await expensesService.markReportPayrollProcessed(
      reportId,
      req.user!.id,
    );
    res.json({ data });
  }),
);

// Reverses an accidental reimbursement. Same permission gate as the
// forward action — only finance HR who can mark a report reimbursed
// is allowed to roll it back.
router.post(
  "/reports/:reportId/revert-reimbursement",
  requirePermission(PERMISSIONS.EXPENSE_HR_APPROVE),
  asyncHandler(async (req, res) => {
    const reportId = getRequiredParam(req.params, "reportId");
    const data = await expensesService.revertReportReimbursement(
      reportId,
      req.user!.id,
    );
    res.json({ data });
  }),
);

router.get(
  "/reports/:reportId/decisions",
  requirePermission(PERMISSIONS.EXPENSE_READ, PERMISSIONS.EXPENSE_HR_READ),
  asyncHandler(async (req, res) => {
    const reportId = getRequiredParam(req.params, "reportId");
    const data = await expensesService.listDecisions(reportId);
    res.json({ data });
  }),
);

router.post(
  "/",
  requirePermission(PERMISSIONS.EXPENSE_CREATE),
  asyncHandler(async (req, res) => {
    const input = createExpenseSchema.parse(req.body);
    const data = await expensesService.createExpense(req.user!.id, input);
    res.status(201).json({ data });
  }),
);

// Finance-desk notification recipients — admin-configurable list of
// emails that receive the long-form summary on final approval. Stored
// in `SystemSetting` under `expense.notification_recipients`. Must be
// declared BEFORE the `/:id` routes so Express doesn't treat the
// literal as an id.
router.get(
  "/notification-recipients",
  requirePermission(PERMISSIONS.EXPENSE_HR_SETTINGS),
  asyncHandler(async (_req, res) => {
    const data = await expensesService.getNotificationRecipients();
    res.json({ data });
  }),
);

router.put(
  "/notification-recipients",
  requirePermission(PERMISSIONS.EXPENSE_HR_SETTINGS),
  asyncHandler(async (req, res) => {
    // Accept both the legacy `{emails: string[]}` body shape and the
    // new `{recipients: Array<{email, mode}>}` shape so an older web
    // bundle still saves cleanly. Service normalises either input.
    const body = req.body as {
      emails?: unknown;
      recipients?: unknown;
    };
    const incoming: unknown[] = Array.isArray(body.recipients)
      ? body.recipients
      : Array.isArray(body.emails)
        ? body.emails
        : [];
    const data = await expensesService.setNotificationRecipients(incoming);
    res.json({ data });
  }),
);

// Monthly reminder settings — day-of-month + per-variant enable/disable.
// Must be declared BEFORE the `/:id` routes.

router.get(
  "/reminder-settings",
  requirePermission(PERMISSIONS.EXPENSE_HR_SETTINGS),
  asyncHandler(async (_req, res) => {
    const data = await expensesService.getReminderSettings();
    res.json({ data });
  }),
);

router.put(
  "/reminder-settings",
  requirePermission(PERMISSIONS.EXPENSE_HR_SETTINGS),
  asyncHandler(async (req, res) => {
    const input = upsertExpenseReminderSettingsSchema.parse(req.body);
    const data = await expensesService.setReminderSettings(input);
    res.json({ data });
  }),
);

// ── Parameterized routes ──

router.get(
  "/:id",
  requirePermission(PERMISSIONS.EXPENSE_READ, PERMISSIONS.EXPENSE_HR_READ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await expensesService.getExpenseById(
      id,
      req.user!.id,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

router.put(
  "/:id",
  requirePermission(PERMISSIONS.EXPENSE_CREATE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = updateExpenseSchema.parse(req.body);
    const data = await expensesService.updateExpense(id, req.user!.id, input);
    res.json({ data });
  }),
);

router.delete(
  "/:id",
  requirePermission(PERMISSIONS.EXPENSE_CREATE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    await expensesService.deleteExpense(id, req.user!.id);
    res.json({ data: { success: true } });
  }),
);

router.post(
  "/:id/restore",
  requirePermission(PERMISSIONS.EXPENSE_CREATE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await expensesService.restoreExpense(
      id,
      req.user!.id,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

router.delete(
  "/:id/permanent",
  requirePermission(PERMISSIONS.EXPENSE_HR_DELETE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await expensesService.permanentDeleteExpense(
      id,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

router.put(
  "/:id/approve",
  requirePermission(PERMISSIONS.EXPENSE_APPROVE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await expensesService.approveExpense(id, req.user!.id);
    res.json({ data });
  }),
);

router.put(
  "/:id/reject",
  requirePermission(PERMISSIONS.EXPENSE_APPROVE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const { reason } = rejectExpenseSchema.parse(req.body);
    const data = await expensesService.rejectExpense(id, req.user!.id, reason);
    res.json({ data });
  }),
);

router.put(
  "/:id/reimburse",
  requirePermission(PERMISSIONS.EXPENSE_HR_APPROVE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await expensesService.reimburseExpense(id, req.user!.id);
    res.json({ data });
  }),
);

export default router;
