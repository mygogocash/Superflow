/**
 * Expense module — edge/core port (merged from API sub-services).
 */

import type { Db } from "@nexora/db";
import { PERMISSIONS } from "@nexora/contracts";
import type {
  AddExpenseToReportInput,
  ApproveExpenseReportInput,
  CreateCategoryInput,
  CreateExpenseApprovalStepInput,
  CreateExpenseInput,
  CreateExpenseReportInput,
  ExpenseQuery,
  ExpenseReportQuery,
  MonthlyExpenseSummaryQuery,
  RejectExpenseReportInput,
  ReorderExpenseApprovalStepsInput,
  UpdateCategoryInput,
  UpdateExpenseApprovalStepInput,
  UpdateExpenseInReportInput,
  UpdateExpenseInput,
  UpdateExpenseReportInput,
  UpsertExchangeRateBody,
  UpsertExpenseReminderSettingsInput,
} from "@nexora/contracts/modules/expenses/expenses.validation";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "../http-exception";
import { upsertSetting, getSetting } from "../survey/system-settings.repository";
import * as repo from "./expenses.repository";
import {
  EXPENSE_NOTIFICATION_KEY,
  EXPENSE_REMINDER_DAY_OF_MONTH,
  EXPENSE_REMINDER_TIME,
  EXPENSE_REMINDER_TIMEZONE,
  FILED_EXPENSE_REPORT_STATUSES,
  buildReportSearchCondition,
  currentExpensePeriodInTimezone,
  datePartsInTimezone,
  expensePeriodLabel,
  expenseReminderVariantForEntityCode,
  fmtAmount,
  loadExpenseNotificationRecipients,
  parseR2ReceiptKey,
  recipientEmailsFor,
  withSignedReceipt,
  withSignedReceipts,
  type ExpenseRecipient,
  type ExpenseRecipientMode,
} from "./expense-shared";

export type { ExpenseRecipient, ExpenseRecipientMode };
export {
  currentExpensePeriodBangkok,
  expenseReminderVariantForEntityCode,
  isExpenseReminderDayBangkok,
} from "./expense-shared";

const PORTAL_URL = "";

function sendEmail(_opts: unknown): void {
  // no-op stub on edge
}

/** Active entities for expense forms (no admin:read required). */
export async function listActiveEntitiesForForms(db: Db) {
  return repo.findActiveEntities(db);
}

export async function listExpenses(
  db: Db,
  userId: string,
  userPermissions: string[],
  query: ExpenseQuery,
) {
  const { page, limit, ...filters } = query;
  const hasHrRead = userPermissions.includes(PERMISSIONS.EXPENSE_HR_READ);
  if (!hasHrRead) filters.employeeId = userId;

  const { data, total } = await repo.findExpenses(db, filters, page, limit);

  return {
    data,
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getExpenseById(db: Db, 
  id: string,
  userId: string,
  userPermissions: string[],
) {
  const expense = await repo.findExpenseById(db, id);
  if (!expense) throw new NotFoundException("Expense not found");

  const hasHrRead = userPermissions.includes(PERMISSIONS.EXPENSE_HR_READ);
  if (!hasHrRead && expense.employeeId !== userId) {
    throw new ForbiddenException("You can only view your own expenses");
  }

  return expense;
}

/**
 * Mint a fresh signed URL for an expense receipt.  Authorisation: same
 * shape as `getExpenseById` — owner OR holder of `expense:hr-read` /
 * `expense:approve`.
 */
export async function getExpenseReceiptUrl(
  db: Db,
  expenseId: string,
  userId: string,
  userPermissions: string[],
): Promise<{ url: string }> {
  const expense = await repo.findExpenseById(db, expenseId);
  if (!expense) throw new NotFoundException("Expense not found");

  const isOwner = expense.employeeId === userId;
  const canSeeAll =
    userPermissions.includes(PERMISSIONS.EXPENSE_HR_READ) ||
    userPermissions.includes(PERMISSIONS.EXPENSE_APPROVE) ||
    userPermissions.includes(PERMISSIONS.ACCOUNTING_READ) ||
    userPermissions.includes(PERMISSIONS.ACCOUNTING_ADMIN);
  if (!isOwner && !canSeeAll) {
    throw new ForbiddenException("You do not have access to this receipt");
  }

  if (!expense.receiptUrl) {
    throw new NotFoundException("This expense has no attached receipt");
  }

  const key = parseR2ReceiptKey(expense.receiptUrl);
  if (key) {
    return { url: expense.receiptUrl };
  }
  return { url: expense.receiptUrl };
}

export async function createExpense(db: Db, userId: string, input: CreateExpenseInput) {
  if (input.categoryId) {
    const category = await repo.findCategoryById(db, 
      input.categoryId,
    );
    if (category) {
      if (category.receiptRequired && !input.receiptUrl) {
        throw new BadRequestException(
          `Category "${category.name}" requires a receipt`,
        );
      }
      if (category.spendingLimit) {
        const limit = Number(category.spendingLimit);
        if (input.amount > limit) {
          throw new BadRequestException(
            `Amount exceeds category spending limit of ${limit}`,
          );
        }
      }
    }
  }

  if (input.travelRequestId) {
    const travel = await repo.findTravelRequestForLink(db, input.travelRequestId);
    if (!travel) {
      throw new BadRequestException("Linked travel request not found");
    }
    if (travel.employeeId !== userId) {
      throw new ForbiddenException(
        "You can only link expenses to your own travel requests",
      );
    }
  }

  const created = await repo.createExpense(db, {
    employeeId: userId,
    entityId: input.entityId,
    categoryId: input.categoryId,
    travelRequestId: input.travelRequestId,
    description: input.description,
    amount: input.amount,
    currency: input.currency,
    date: input.date,
    receiptUrl: input.receiptUrl,
    notes: input.notes,
  });

  const user = await repo.findUserById(db, userId);
  if (user?.reportingTo) {
    const manager = await repo.findUserById(db, user.reportingTo);
    if (manager?.email) {
      void sendEmail(null);
    }
  }
  return created;
}

export async function updateExpense(db: Db, 
  expenseId: string,
  userId: string,
  input: UpdateExpenseInput,
) {
  const expense = await repo.findExpenseById(db, expenseId);
  if (!expense) throw new NotFoundException("Expense not found");
  if (expense.employeeId !== userId) {
    throw new ForbiddenException("You can only update your own expenses");
  }
  if (expense.status !== "pending") {
    throw new BadRequestException(
      `Cannot update an expense with status "${expense.status}"`,
    );
  }

  return repo.updateExpense(db, expenseId, {
    ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
    ...(input.description !== undefined && { description: input.description }),
    ...(input.amount !== undefined && { amount: input.amount }),
    ...(input.currency !== undefined && { currency: input.currency }),
    ...(input.date !== undefined && { date: input.date }),
    ...(input.receiptUrl !== undefined && { receiptUrl: input.receiptUrl }),
    ...(input.notes !== undefined && { notes: input.notes }),
  });
}

export async function deleteExpense(db: Db, expenseId: string, userId: string) {
  const expense = await repo.findExpenseById(db, expenseId);
  if (!expense) throw new NotFoundException("Expense not found");
  if (expense.employeeId !== userId) {
    throw new ForbiddenException("You can only delete your own expenses");
  }
  if (expense.status !== "pending") {
    throw new BadRequestException(
      `Cannot delete an expense with status "${expense.status}"`,
    );
  }

  return repo.softDeleteExpense(db, expenseId);
}

export async function restoreExpense(db: Db, 
  expenseId: string,
  userId: string,
  permissions: string[],
) {
  // findExpenseById hides soft-deleted rows; a hit means it's still active.
  const active = await repo.findExpenseById(db, expenseId);
  if (active) throw new ConflictException("Expense is not deleted");

  const expense =
    await repo.findExpenseByIdIncludingDeleted(db, expenseId);
  if (!expense) throw new NotFoundException("Expense not found");

  const isHr = permissions.includes(PERMISSIONS.EXPENSE_HR_DELETE);
  if (!isHr && expense.employeeId !== userId) {
    throw new ForbiddenException("You can only restore your own expenses");
  }
  return repo.restoreExpense(db, expenseId);
}

export async function permanentDeleteExpense(
  db: Db,
  expenseId: string,
  permissions: string[],
) {
  // Soft-deleted rows are the normal purge target; the live finder would 404 them.
  const expense = await repo.findExpenseByIdIncludingDeleted(db, expenseId);
  if (!expense) {
    throw new NotFoundException("Expense not found");
  }
  if (!permissions.includes(PERMISSIONS.EXPENSE_HR_DELETE)) {
    throw new ForbiddenException("Only HR can permanently delete expenses");
  }
  return repo.permanentDeleteExpense(db, expenseId);
}

export async function approveExpense(db: Db, expenseId: string, approverId: string) {
  const expense = await repo.findExpenseById(db, expenseId);
  if (!expense) throw new NotFoundException("Expense not found");
  if (expense.status !== "pending") {
    throw new BadRequestException(
      `Cannot approve an expense with status "${expense.status}"`,
    );
  }

  const result = await repo.updateExpenseStatus(db, expenseId, {
    status: "approved",
    approvedBy: approverId,
    approvedAt: new Date().toISOString(),
  });

  const approver = await repo.findUserById(db, approverId);
  void sendEmail(null);
  return result;
}

export async function rejectExpense(db: Db, 
  expenseId: string,
  approverId: string,
  reason: string,
) {
  const expense = await repo.findExpenseById(db, expenseId);
  if (!expense) throw new NotFoundException("Expense not found");
  if (expense.status !== "pending") {
    throw new BadRequestException(
      `Cannot reject an expense with status "${expense.status}"`,
    );
  }

  const result = await repo.updateExpenseStatus(db, expenseId, {
    status: "rejected",
    approvedBy: approverId,
    approvedAt: new Date().toISOString(),
    rejectReason: reason,
  });

  const approver = await repo.findUserById(db, approverId);
  void sendEmail(null);

  return result;
}

export async function reimburseExpense(db: Db, expenseId: string, actorId: string) {
  const expense = await repo.findExpenseById(db, expenseId);
  if (!expense) throw new NotFoundException("Expense not found");
  if (expense.status !== "approved") {
    throw new BadRequestException(
      `Cannot reimburse an expense with status "${expense.status}"`,
    );
  }

  const result = await repo.updateExpenseStatus(db, expenseId, {
    status: "reimbursed",
    approvedBy: actorId,
    approvedAt: new Date().toISOString(),
    reimbursedAt: new Date().toISOString(),
  });

  void sendEmail(null);
  return result;
}

export async function exportExpensesXlsx(
  _db: Db,
  _query: Parameters<typeof repo.findAllExpenses>[1],
): Promise<Uint8Array> {
  throw new BadRequestException("Expense export is not available on this deployment");
}


// ── Private helpers (module-scoped) ──────────────────────────────

/**
 * Sum a report's expenses into THB. Each foreign line is converted at
 * the rate effective on ITS OWN date (not one rate for the whole
 * report) — so an INR receipt from the 3rd uses the 3rd's rate. Returns
 * the THB total plus the currencies that have NO THB rate on file, so
 * callers can block instead of guessing. Never coerces an unconvertible
 * amount into THB (the old behaviour added e.g. IDR 400,110 straight
 * onto the THB total, inflating it ~400x).
 */
async function convertReportToThb(
  db: Db,
  reportId: string,
): Promise<{ thb: number; missing: string[] }> {
  const lines = await repo.findReportExpenseLines(db, reportId);
  let thb = 0;
  const missing: string[] = [];
  for (const line of lines) {
    const amount = Number(line.amount);
    if (line.currency === "THB") {
      thb += amount;
      continue;
    }
    const fx = await repo.convertAmount(db, 
      amount,
      line.currency,
      "THB",
      typeof line.date === "string" ? new Date(line.date) : line.date,
    );
    if (!fx) {
      if (!missing.includes(line.currency)) missing.push(line.currency);
      continue;
    }
    thb += fx.converted;
  }
  return { thb: Math.round(thb * 100) / 100, missing };
}

/**
 * Guard for money actions (submit / approve / reimburse). A report
 * whose foreign lines have no THB rate can't be routed or paid on a
 * single THB figure, so block with a message pointing finance to the
 * FX manager rather than acting on a silently-wrong number.
 */
function assertReportConvertible(missing: string[], action: string): void {
  if (missing.length > 0) {
    throw new BadRequestException(
      `Cannot ${action}: no exchange rate for ${missing.join(", ")} → THB. ` +
        `Add it in Accounting → Exchange Rates, then try again.`,
    );
  }
}

/**
 * Display-side total for a report, always presented in the base
 * currency (THB) since every entity reports in Baht.
 * - no line items       → 0 THB
 * - single THB          → that THB amount (no FX needed)
 * - single foreign OR mixed → convert every line to THB at its own
 *   date. If any rate is missing, returns `converted: false` (UI shows
 *   "— rate missing") — never a silently-wrong number.
 */
async function computeReportTotal(db: Db, reportId: string): Promise<{
  totalAmount: number;
  totalCurrency: string;
  converted: boolean;
  missingRates: string[];
}> {
  const subtotals =
    await repo.sumReportTotalsByCurrency(db, reportId);
  if (subtotals.length === 0) {
    return {
      totalAmount: 0,
      totalCurrency: "THB",
      converted: true,
      missingRates: [],
    };
  }
  // Only a single THB report skips conversion. A single foreign-currency
  // report (e.g. all-INR / all-LKR) still converts to THB.
  if (subtotals.length === 1 && subtotals[0]!.currency === "THB") {
    return {
      totalAmount: subtotals[0]!.amount,
      totalCurrency: "THB",
      converted: true,
      missingRates: [],
    };
  }
  const { thb, missing } = await convertReportToThb(db, reportId);
  if (missing.length > 0) {
    return {
      totalAmount: 0,
      totalCurrency: "THB",
      converted: false,
      missingRates: missing,
    };
  }
  return {
    totalAmount: thb,
    totalCurrency: "THB",
    converted: true,
    missingRates: [],
  };
}

/**
 * Attach per-line FX detail for the report-detail view: the rate used
 * (THB per 1 unit of the line currency) and the line's converted THB.
 * Uses the SAME `convertAmount` (resolveRate at the line's own date) the
 * report Total uses, so the per-line figures reconcile to the headline
 * Total. THB lines carry nulls (no conversion); a non-THB line with no
 * rate on file is flagged `fxRateMissing` so the UI mirrors the Total's
 * "rate missing" state instead of inventing a number. Rate lookups are
 * memoised by `currency|date` so a report with ten same-day IDR lines
 * does one DB read, not ten.
 */
export async function withFxConversion<
  T extends {
    amount: unknown;
    currency: string;
    date: Date | string;
  },
>(
  db: Db,
  rows: T[],
): Promise<
  (T & {
    fxRate: number | null;
    fxConvertedThb: number | null;
    fxRateMissing: boolean;
  })[]
> {
  const rateCache = new Map<string, number | null>();
  const out = [];
  for (const row of rows) {
    const currency = row.currency?.trim().toUpperCase();
    if (!currency || currency === "THB") {
      out.push({
        ...row,
        fxRate: null,
        fxConvertedThb: null,
        fxRateMissing: false,
      });
      continue;
    }
    const date = typeof row.date === "string" ? new Date(row.date) : row.date instanceof Date ? row.date : new Date(String(row.date));
    const key = `${currency}|${date.toISOString().slice(0, 10)}`;
    let rate = rateCache.get(key);
    if (rate === undefined) {
      const fx = await repo.convertAmount(db, 
        1,
        currency,
        "THB",
        date,
      );
      rate = fx ? fx.rate : null;
      rateCache.set(key, rate);
    }
    if (rate === null) {
      out.push({
        ...row,
        fxRate: null,
        fxConvertedThb: null,
        fxRateMissing: true,
      });
      continue;
    }
    const converted = Math.round(Number(row.amount) * rate * 100) / 100;
    out.push({
      ...row,
      fxRate: rate,
      fxConvertedThb: converted,
      fxRateMissing: false,
    });
  }
  return out;
}

/**
 * `office` is the finance-admin bucket. Anyone without one of the
 * HR-approve perms is rejected so the gate doesn't rely on the FE
 * hiding the option.
 */
function assertCanUseOfficeCategory(
  category: string | undefined,
  actorPermissions: string[],
) {
  if (category !== "office") return;
  const allowed =
    actorPermissions.includes(PERMISSIONS.EXPENSE_HR_APPROVE) ||
    actorPermissions.includes(PERMISSIONS.EXPENSE_HR_READ);
  if (!allowed) {
    throw new ForbiddenException(
      "The Office category is restricted to HR / Admin operators",
    );
  }
}

/**
 * Build the per-report approval-decision snapshot.  Mirrors travel-chain
 * behaviour: filter active steps by submitter conditions, snapshot them
 * into `expense_approval_decisions`.  Falls back to a single "manager"
 * step when no chain is configured.
 */
async function snapshotApprovalDecisions(
  db: Db,
  reportId: string,
  submitterId: string,
  opts?: { category?: string; totalBaht?: number | null },
) {
  const allSteps = await repo.findApprovalSteps(db, {
    activeOnly: true,
  });
  const category = opts?.category ?? "general";
  const totalBaht = opts?.totalBaht ?? null;
  const applicableSteps = allSteps.filter((s) => {
    const skip = Array.isArray(s.skipWhenSubmitterIds)
      ? (s.skipWhenSubmitterIds as string[])
      : [];
    if (skip.includes(submitterId)) return false;
    const only = Array.isArray(s.onlyWhenSubmitterIds)
      ? (s.onlyWhenSubmitterIds as string[])
      : [];
    if (only.length > 0 && !only.includes(submitterId)) return false;

    const cats = Array.isArray(s.categoryFilter)
      ? (s.categoryFilter as string[])
      : [];
    if (cats.length > 0 && !cats.includes(category)) return false;

    const hasAmountFilter = s.amountMinBaht != null || s.amountMaxBaht != null;
    if (hasAmountFilter) {
      if (totalBaht === null) return false;
      const min = s.amountMinBaht != null ? Number(s.amountMinBaht) : null;
      const max = s.amountMaxBaht != null ? Number(s.amountMaxBaht) : null;
      if (min !== null && totalBaht < min) return false;
      if (max !== null && totalBaht > max) return false;
    }
    return true;
  });

  // Resolve the submitter's manager chain so `manager` / `manager_l2`
  // steps can be snapshotted as fixed-user decisions when an actual
  // person sits in those roles. When `reportingTo` is unset (admin
  // accounts, system users, etc.) the corresponding manager step is
  // dropped — Tanny / 2026-05-26: an Office-Admin submitter stalled
  // the chain on a `manager` step that had no approver, so Sid's
  // amount-band step (`approverType=user`) never became active and
  // his Pending approvals tab stayed empty.
  let l1UserId: string | null = null;
  let l2UserId: string | null = null;
  const submitter = await repo.findUserById(db, submitterId);
  if (submitter?.reportingTo) {
    l1UserId = submitter.reportingTo;
    const l1 = submitter?.reportingTo ? await repo.findUserById(db, submitter.reportingTo) : null;
    l2UserId = l1?.reportingTo ?? null;
  }

  type DecisionRow = {
    order: number;
    name: string;
    approverType: string;
    stageRole: string;
    approverUserId: string | null;
  };

  const rawRows: Array<DecisionRow | null> =
    applicableSteps.length > 0
      ? applicableSteps.map((s, idx): DecisionRow | null => {
          if (s.approverType === "manager_l2") {
            if (!l2UserId) return null;
            return {
              order: idx + 1,
              name: s.name,
              approverType: "user",
              stageRole: s.stageRole,
              approverUserId: l2UserId,
            };
          }
          if (s.approverType === "manager") {
            // Submitter has no reporting manager — drop the step so the
            // chain advances to the next applicable approver instead of
            // stalling forever on a row no one can resolve.
            if (!l1UserId) return null;
            return {
              order: idx + 1,
              name: s.name,
              approverType: s.approverType,
              stageRole: s.stageRole,
              approverUserId: null,
            };
          }
          return {
            order: idx + 1,
            name: s.name,
            approverType: s.approverType,
            stageRole: s.stageRole,
            approverUserId: s.approverType === "user" ? s.approverUserId : null,
          };
        })
      : [
          {
            order: 1,
            name: "Manager approval",
            approverType: "manager",
            stageRole: "approve",
            approverUserId: null,
          },
        ];

  // Re-index after L2 rows for absent skip-level managers are dropped.
  const decisionRows: DecisionRow[] = rawRows
    .filter((r): r is DecisionRow => r !== null)
    .map((r, idx) => ({ ...r, order: idx + 1 }));

  // If every step filtered out, fall back to single-step manager approval.
  if (decisionRows.length === 0) {
    decisionRows.push({
      order: 1,
      name: "Manager approval",
      approverType: "manager",
      stageRole: "approve",
      approverUserId: null,
    });
  }

  await repo.deleteDecisionsForReport(db, reportId);
  await repo.createDecisions(db, reportId, decisionRows);
  return decisionRows;
}

/** Returns true when every category in `categoryIds` is flagged `isAllowance`. */
async function areAllAllowanceCategories(
  db: Db,
  categoryIds: string[],
): Promise<boolean> {
  if (categoryIds.length === 0) return false;
  const unique = Array.from(new Set(categoryIds));
  const rows = await repo.findCategoriesByIds(db, unique);
  if (rows.length !== unique.length) return false;
  return rows.every((r) => r.isAllowance);
}

/**
 * True when the org has at least one active approval step whose
 * `categoryFilter` includes `"allowance"`.
 */
async function hasAllowanceApprovalChain(db: Db): Promise<boolean> {
  const steps = await repo.findApprovalSteps(db, {
    activeOnly: true,
  });
  return steps.some((s) => {
    const cats = Array.isArray(s.categoryFilter)
      ? (s.categoryFilter as string[])
      : [];
    return cats.includes("allowance");
  });
}

/**
 * Allowance fast-path: mark report + line items as `reimbursed`,
 * notify submitter, FYI finance-desk.  No approval row is snapshotted.
 */
async function finaliseAllowanceReport(
  db: Db,
  reportId: string,
  userId: string,
  report: NonNullable<
    Awaited<ReturnType<typeof repo.findReportById>>
  >,
) {
  // Allowance reports short-circuit straight to `reimbursed`, so guard
  // the same way submit does: a foreign line with no THB rate can't be
  // paid on a single Baht figure.
  const { missing } = await convertReportToThb(db, reportId);
  assertReportConvertible(missing, "submit this allowance report");

  const now = new Date();
  const updated = await repo.finalizeAllowanceReportTx(db, reportId, userId);

  const { totalAmount, totalCurrency: currency } =
    await computeReportTotal(db, reportId);
  const portalUrl = `${PORTAL_URL}/expenses/${reportId}`;

  void sendEmail(null);
  return updated;
}

// ── Public service methods ────────────────────────────────────────

export async function listReports(db: Db, 
  userId: string,
  userPermissions: string[],
  query: ExpenseReportQuery,
) {
  const { page, limit, ...filters } = query;
  const hasHrRead = userPermissions.includes(PERMISSIONS.EXPENSE_HR_READ);

  let employeeId: string | undefined = filters.employeeId;
  let employeeIds: string[] | undefined;
  let reportIds: string[] | undefined;

  if (filters.pendingForMe) {
    const hasHrApprove = userPermissions.includes(
      PERMISSIONS.EXPENSE_HR_APPROVE,
    );
    if (hasHrApprove) {
      employeeId = undefined;
      filters.status = "submitted";
    } else {
      const reportIdsFromPending = await repo.findPendingReportIdsForApprover(db, userId);
      reportIds = reportIdsFromPending;
      if (reportIds.length === 0) {
        return {
          data: [],
          meta: { page, limit, total: 0, totalPages: 0 },
        };
      }
      employeeId = undefined;
      filters.status = filters.status ?? "submitted";
    }
  } else if (filters.includeAll && !hasHrRead) {
    // Defence in depth — the /expenses page already hides the "All
    // reports" tab from users without expense:hr-read, but a crafted
    // request must not silently fall through to a self-scoped list
    // pretending to be a workspace-wide one. Reject explicitly so the
    // attempt surfaces in audit logs rather than masquerading as a
    // normal "my reports" call.
    throw new ForbiddenException(
      "Listing all reports requires the expense:hr-read permission",
    );
  } else if (hasHrRead && filters.includeAll) {
    // HR opted into the unscoped "every report in the workspace" view.
  } else {
    // Default: scope to the caller's own reports.
    employeeId = userId;
  }

  const { data, total } = await repo.findReports(db, 
    {
      employeeId,
      employeeIds,
      reportIds,
      status: filters.status,
      period: filters.period,
      // Passed straight through: a term must reach the database, or it can only
      // ever match the page already on screen.
      search: filters.search,
    },
    page,
    limit,
  );

  const enriched = await Promise.all(
    data.map(async (r) => {
      const total = await computeReportTotal(db, r.id);
      return { ...r, ...total };
    }),
  );

  return {
    data: enriched,
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/**
 * Workspace-wide monthly roll-up (Admin/HR). Groups every matching report
 * by its YYYY-MM `period` and reports, per month: report count, expense
 * (line) count, total THB, and a count split by status.
 *
 * Totals are computed server-side over the WHOLE filtered set — never by
 * reducing a paginated page. Each foreign line is converted at the rate on
 * its OWN date (memoised by `currency|date`, mirroring `withFxConversion`),
 * so mixed currencies never get summed raw. A month with any unconvertible
 * line is flagged `converted: false`; its `totalThb` still excludes the
 * unconvertible amount (honest, never inflated) and the flag tells the UI
 * to show "—" + a rate-missing warning.
 */
type MonthlyStatusCounts = Record<string, number>;
interface MonthlyRow {
  period: string;
  reportCount: number;
  expenseCount: number;
  totalThb: number;
  converted: boolean;
  missingRates: string[];
  byStatus: MonthlyStatusCounts;
}

export async function monthlySummary(db: Db, 
  userPermissions: string[],
  query: MonthlyExpenseSummaryQuery,
) {
  if (!userPermissions.includes(PERMISSIONS.EXPENSE_HR_READ)) {
    throw new ForbiddenException(
      "The monthly overview requires the expense:hr-read permission",
    );
  }

  const [counts, lines] = await Promise.all([
    repo.summaryReportCounts(db, query),
    repo.findReportLinesForSummary(db, query),
  ]);

  const months = new Map<string, MonthlyRow>();
  const ensure = (period: string): MonthlyRow => {
    let row = months.get(period);
    if (!row) {
      row = {
        period,
        reportCount: 0,
        expenseCount: 0,
        totalThb: 0,
        converted: true,
        missingRates: [],
        byStatus: {},
      };
      months.set(period, row);
    }
    return row;
  };

  // Report counts (per period + status).
  for (const c of counts) {
    const row = ensure(c.period);
    row.reportCount += c._count._all;
    row.byStatus[c.status] = (row.byStatus[c.status] ?? 0) + c._count._all;
  }

  // THB sum from line items, converted per-line at its own date. One
  // shared rate cache across every month/currency/date.
  const rateCache = new Map<string, number | null>();
  for (const line of lines) {
    const period = line.report?.period;
    if (!period) continue;
    const row = ensure(period);
    row.expenseCount += 1;

    const amount = Number(line.amount);
    const currency = line.currency?.trim().toUpperCase();
    if (!currency || currency === "THB") {
      row.totalThb += amount;
      continue;
    }
    const date = new Date(String(line.date));
    const key = `${currency}|${date.toISOString().slice(0, 10)}`;
    let rate = rateCache.get(key);
    if (rate === undefined) {
      const fx = await repo.convertAmount(db, 
        1,
        currency,
        "THB",
        date,
      );
      rate = fx ? fx.rate : null;
      rateCache.set(key, rate);
    }
    if (rate === null) {
      row.converted = false;
      if (!row.missingRates.includes(currency)) row.missingRates.push(currency);
      continue;
    }
    row.totalThb += Math.round(amount * rate * 100) / 100;
  }

  const data = Array.from(months.values())
    .map((row) => ({
      ...row,
      totalThb: Math.round(row.totalThb * 100) / 100,
    }))
    .sort((a, b) => (a.period < b.period ? 1 : a.period > b.period ? -1 : 0));

  const totals = data.reduce(
    (acc, row) => {
      acc.reportCount += row.reportCount;
      acc.expenseCount += row.expenseCount;
      acc.totalThb += row.totalThb;
      if (!row.converted) acc.converted = false;
      for (const cur of row.missingRates) {
        if (!acc.missingRates.includes(cur)) acc.missingRates.push(cur);
      }
      return acc;
    },
    {
      reportCount: 0,
      expenseCount: 0,
      totalThb: 0,
      converted: true,
      missingRates: [] as string[],
    },
  );
  totals.totalThb = Math.round(totals.totalThb * 100) / 100;

  return { data, totals };
}

export async function getReportById(db: Db, 
  id: string,
  userId: string,
  userPermissions: string[],
) {
  const report = await repo.findReportById(db, id);
  if (!report) throw new NotFoundException("Expense report not found");

  const hasHrRead = userPermissions.includes(PERMISSIONS.EXPENSE_HR_READ);
  const hasHrApprove = userPermissions.includes(PERMISSIONS.EXPENSE_HR_APPROVE);
  const hasApprove = userPermissions.includes(PERMISSIONS.EXPENSE_APPROVE);
  const isOwner = report.employeeId === userId;
  let isManager = false;
  let isAssignedApprover = false;

  if (!isOwner) {
    const employee = await repo.findUserById(db, report.employeeId);
    isManager = employee?.reportingTo === userId;
    if (!isManager) {
      const isAssignedApprover = await repo.hasDecisionForUser(db, id, userId);
      
    }
  }
  if (!isOwner && !isManager && !isAssignedApprover && !hasHrRead) {
    throw new ForbiddenException(
      "You can only view your own reports or your direct reports'",
    );
  }

  const canApprove =
    report.status === "submitted" &&
    !isOwner &&
    (isManager || isAssignedApprover || hasApprove || hasHrApprove);

  const total = await computeReportTotal(db, report.id);
  const expenses = await withFxConversion(
    db,
    await withSignedReceipts(report.expenses),
  );
  return { ...report, expenses, ...total, canApprove };
}

export async function createReport(db: Db, 
  userId: string,
  input: CreateExpenseReportInput,
  actorPermissions: string[],
) {
  assertCanUseOfficeCategory(input.category, actorPermissions);
  return repo.createReport(db, {
    employeeId: userId,
    entityId: input.entityId,
    period: input.period,
    title: input.title,
    category: input.category,
    ...(input.notes !== undefined && { notes: input.notes }),
  });
}

export async function updateReport(db: Db, 
  id: string,
  userId: string,
  input: UpdateExpenseReportInput,
  actorPermissions: string[],
) {
  const report = await repo.findReportById(db, id);
  if (!report) throw new NotFoundException("Expense report not found");
  if (report.employeeId !== userId) {
    throw new ForbiddenException("You can only edit your own reports");
  }
  if (report.status !== "draft" && report.status !== "rejected") {
    throw new BadRequestException(
      `Cannot edit a report with status "${report.status}"`,
    );
  }
  assertCanUseOfficeCategory(input.category, actorPermissions);

  return repo.updateReport(db, id, {
    ...(input.title !== undefined && { title: input.title }),
    ...(input.period !== undefined && { period: input.period }),
    ...(input.category !== undefined && { category: input.category }),
    ...(input.notes !== undefined && { notes: input.notes }),
  });
}

export async function deleteReport(db: Db, 
  id: string,
  userId: string,
  actorPermissions: string[],
) {
  const report = await repo.findReportById(db, id);
  if (!report) throw new NotFoundException("Expense report not found");

  const isAdminDelete = actorPermissions.includes(
    PERMISSIONS.EXPENSE_HR_DELETE,
  );
  if (!isAdminDelete) {
    if (report.employeeId !== userId) {
      throw new ForbiddenException("You can only delete your own reports");
    }
    if (report.status !== "draft" && report.status !== "rejected") {
      throw new BadRequestException(
        `Cannot delete a report with status "${report.status}"`,
      );
    }
  }
  return repo.softDeleteReport(db, id);
}

export async function restoreReport(db: Db, 
  id: string,
  userId: string,
  actorPermissions: string[],
) {
  // findReportById hides soft-deleted rows; a hit means it's still active.
  const active = await repo.findReportById(db, id);
  if (active) throw new ConflictException("Report is not deleted");

  const report = await repo.findReportByIdIncludingDeleted(db, id);
  if (!report) throw new NotFoundException("Expense report not found");

  const isAdminDelete = actorPermissions.includes(
    PERMISSIONS.EXPENSE_HR_DELETE,
  );
  if (!isAdminDelete && report.employeeId !== userId) {
    throw new ForbiddenException("You can only restore your own reports");
  }
  return repo.restoreReport(db, id);
}

export async function permanentDeleteReport(
  db: Db,
  id: string,
  permissions: string[],
) {
  // Soft-deleted rows are the normal purge target; the live finder would 404 them.
  const report = await repo.findReportByIdIncludingDeleted(db, id);
  if (!report) {
    throw new NotFoundException("Expense report not found");
  }
  if (!permissions.includes(PERMISSIONS.EXPENSE_HR_DELETE)) {
    throw new ForbiddenException(
      "Only HR can permanently delete expense reports",
    );
  }
  return repo.permanentDeleteReport(db, id);
}

export async function addExpenseToReport(db: Db, 
  reportId: string,
  userId: string,
  input: AddExpenseToReportInput,
) {
  const report = await repo.findReportById(db, reportId);
  if (!report) throw new NotFoundException("Expense report not found");
  if (report.employeeId !== userId) {
    throw new ForbiddenException("You can only edit your own reports");
  }
  if (report.status !== "draft" && report.status !== "rejected") {
    throw new BadRequestException(
      `Cannot add expenses to a report with status "${report.status}"`,
    );
  }

  if (input.categoryId) {
    const category = await repo.findCategoryById(db, 
      input.categoryId,
    );
    if (category) {
      if (category.receiptRequired && !input.receiptUrl) {
        throw new BadRequestException(
          `Category "${category.name}" requires a receipt`,
        );
      }
      if (category.spendingLimit) {
        const limit = Number(category.spendingLimit);
        if (input.amount > limit) {
          throw new BadRequestException(
            `Amount exceeds category spending limit of ${limit}`,
          );
        }
      }
    }
  }

  const expense = await repo.createExpense(db, {
      employeeId: userId,
      entityId: report.entityId,
      reportId: report.id,
      categoryId: input.categoryId,
      travelRequestId: input.travelRequestId,
      description: input.description,
      amount: input.amount,
      currency: input.currency,
      date: input.date,
      receiptUrl: input.receiptUrl,
      notes: input.notes,
    });

  return withSignedReceipt(expense);
}

export async function updateExpenseInReport(db: Db, 
  reportId: string,
  expenseId: string,
  userId: string,
  input: UpdateExpenseInReportInput,
) {
  const report = await repo.findReportById(db, reportId);
  if (!report) throw new NotFoundException("Expense report not found");
  if (report.employeeId !== userId) {
    throw new ForbiddenException("You can only edit your own reports");
  }
  if (report.status !== "draft" && report.status !== "rejected") {
    throw new BadRequestException(
      `Cannot edit expenses in a report with status "${report.status}"`,
    );
  }

  const expense = await repo.findExpenseById(db, expenseId);
  if (!expense || expense.reportId !== reportId) {
    throw new NotFoundException("Expense not found in this report");
  }

  const updated = await repo.updateExpense(db, expenseId, {
    ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
    ...(input.description !== undefined && { description: input.description }),
    ...(input.amount !== undefined && { amount: input.amount }),
    ...(input.currency !== undefined && { currency: input.currency }),
    ...(input.date !== undefined && { date: input.date }),
    ...(input.receiptUrl !== undefined && { receiptUrl: input.receiptUrl }),
    ...(input.notes !== undefined && { notes: input.notes }),
  });
  return withSignedReceipt(updated);
}

export async function removeExpenseFromReport(db: Db, 
  reportId: string,
  expenseId: string,
  userId: string,
) {
  const report = await repo.findReportById(db, reportId);
  if (!report) throw new NotFoundException("Expense report not found");
  if (report.employeeId !== userId) {
    throw new ForbiddenException("You can only edit your own reports");
  }
  if (report.status !== "draft" && report.status !== "rejected") {
    throw new BadRequestException(
      `Cannot remove expenses from a report with status "${report.status}"`,
    );
  }
  const expense = await repo.findExpenseById(db, expenseId);
  if (!expense || expense.reportId !== reportId) {
    throw new NotFoundException("Expense not found in this report");
  }
  return repo.softDeleteExpense(db, expenseId);
}

export async function submitReport(db: Db, reportId: string, userId: string) {
  const report = await repo.findReportById(db, reportId);
  if (!report) throw new NotFoundException("Expense report not found");
  if (report.employeeId !== userId) {
    throw new ForbiddenException("You can only submit your own reports");
  }
  if (report.status !== "draft" && report.status !== "rejected") {
    throw new BadRequestException(
      `Cannot submit a report with status "${report.status}"`,
    );
  }
  if (report.expenses.length === 0) {
    throw new BadRequestException("Add at least one expense before submitting");
  }

  // Allowance routing (IT-15).
  const categoryIds = report.expenses
    .map((e) => e.categoryId)
    .filter((id): id is string => !!id);
  const isAllowanceOnly =
    categoryIds.length === report.expenses.length &&
    categoryIds.length > 0 &&
    (await areAllAllowanceCategories(db, categoryIds));
  let reportCategory = report.category;
  if (isAllowanceOnly) {
    if (await hasAllowanceApprovalChain(db)) {
      await repo.updateReport(db, reportId, {
        category: "allowance",
      });
      reportCategory = "allowance";
    } else {
      return finaliseAllowanceReport(db, reportId, userId, report);
    }
  }

  // THB-equivalent total for amount-band step routing. A foreign line
  // with no THB rate can't be routed on a single Baht figure, so block
  // the submit rather than fall back to an unconverted number.
  const { thb: totalBaht, missing } = await convertReportToThb(db, reportId);
  assertReportConvertible(missing, "submit this report");

  const decisionRows = await snapshotApprovalDecisions(db, reportId, userId, {
    category: reportCategory,
    totalBaht,
  });

  const updated = await repo.updateReport(db, reportId, {
    status: "submitted",
    submittedAt: new Date().toISOString(),
    rejectReason: null,
    currentStepOrder: 1,
  });

  const firstStep = decisionRows[0]!;
  let approverEmail: string | undefined;
  let approverName: string | undefined;
  const employee = await repo.findUserById(db, userId);
  if (firstStep.approverType === "manager" && employee?.reportingTo) {
    const manager = await repo.findUserById(db, employee.reportingTo);
    approverEmail = manager?.email ?? undefined;
    approverName = manager?.name;
  } else if (firstStep.approverType === "user" && firstStep.approverUserId) {
    const approver = await repo.findUserById(db, firstStep.approverUserId!);
    approverEmail = approver?.email ?? undefined;
    approverName = approver?.name;
  }
  if (approverEmail && employee) {
    const { totalAmount, totalCurrency: currency } =
      await computeReportTotal(db, reportId);
    void sendEmail(null);
  }

  try {
    const deskRecipientsAll = await loadExpenseNotificationRecipients(db);
    const desk = recipientEmailsFor(deskRecipientsAll, "everything");
    if (desk.length > 0 && employee) {
      const { totalAmount, totalCurrency: currency } =
        await computeReportTotal(db, reportId);
      const employeeRow = await repo.findUserById(db, userId);
      void sendEmail(null);
    }
  } catch {
    // best-effort
  }

  return updated;
}

export async function approveReport(db: Db, 
  reportId: string,
  approverId: string,
  approverPermissions: string[] = [],
  opts: { approvedAmount?: number; notes?: string } = {},
) {
  const report = await repo.findReportById(db, reportId);
  if (!report) throw new NotFoundException("Expense report not found");
  if (report.status !== "submitted") {
    throw new BadRequestException(
      `Cannot approve a report with status "${report.status}"`,
    );
  }

  // The optional approved-amount override is validated AFTER the current
  // step is resolved, because a `review` stage cannot haircut the amount
  // at all (Q1: reviewers validate, only `approve` stages authorise a
  // reduced figure). Kept null until an `approve` stage supplies a valid one.
  let approvedAmountOverride: number | null = null;

  let decisions = await repo.findDecisions(db, reportId);
  if (decisions.length === 0) {
    await snapshotApprovalDecisions(db, reportId, report.employeeId, {
      category: report.category,
    });
    await repo.updateReport(db, reportId, { currentStepOrder: 1 });
    decisions = await repo.findDecisions(db, reportId);
  }
  const current =
    decisions.find(
      (d) => d.order === (report.currentStepOrder ?? decisions[0]?.order ?? 1),
    ) ?? null;
  if (!current || current.status !== "pending") {
    throw new BadRequestException(
      "No pending approval step is waiting on this report",
    );
  }

  // Amount haircut is an approve-stage power only. A review stage advances
  // the chain untouched; any amount the client sent is ignored rather than
  // errored, so a reviewer's "accept" never mutates the claimed figure.
  if (current.stageRole !== "review" && opts.approvedAmount !== undefined) {
    // Cap against the report's own display total (native for a
    // single-currency report, THB for a converted mixed one). A mixed
    // report with a missing rate can't be capped on one figure → block.
    const { totalAmount, converted, missingRates } =
      await computeReportTotal(db, reportId);
    assertReportConvertible(
      converted ? [] : missingRates,
      "approve this report",
    );
    if (opts.approvedAmount > totalAmount) {
      throw new BadRequestException(
        `Approved amount (${opts.approvedAmount}) cannot exceed submitted total (${totalAmount})`,
      );
    }
    approvedAmountOverride = opts.approvedAmount;
  }

  let isAuthorisedApprover = false;
  if (current.approverType === "user") {
    isAuthorisedApprover = current.approverUserId === approverId;
  } else if (current.approverType === "manager") {
    const owner = await repo.findUserById(db, report.employeeId);
    isAuthorisedApprover = owner?.reportingTo === approverId;
  }
  // Parallel fallback: the submitter's direct manager can always approve.
  if (!isAuthorisedApprover) {
    const owner = await repo.findUserById(db, report.employeeId);
    if (owner?.reportingTo && owner.reportingTo === approverId) {
      isAuthorisedApprover = true;
    }
  }
  // HR escape hatch.
  if (
    !isAuthorisedApprover &&
    approverPermissions.includes(PERMISSIONS.EXPENSE_HR_APPROVE)
  ) {
    isAuthorisedApprover = true;
  }
  if (!isAuthorisedApprover) {
    throw new ForbiddenException(
      "You are not the assigned approver for this stage",
    );
  }

  const approver = await repo.findUserById(db, approverId);

  const remainingPending = decisions.filter(
    (d) => d.order > current.order && d.status === "pending",
  );
  // A `review` stage must NEVER finalise the report — it only advances the
  // chain toward an approval gate. Fail closed if a review stage is the last
  // pending step (a chain misconfigured with no approval after it, or one
  // whose only approval steps were filtered out for this report): completing
  // here would wrongly stamp the report `approved` and release it for
  // reimbursement on a validate-only gate. Block instead of escalating.
  if (current.stageRole === "review" && remainingPending.length === 0) {
    throw new BadRequestException(
      "This review stage has no approval stage after it. Add an approval " +
        "step to the chain before this report can be completed.",
    );
  }
  const isFinalStep =
    current.stageRole !== "review" && remainingPending.length === 0;

  const updated = await repo.approveReportTx(db, {
    reportId,
    currentDecisionId: current.id,
    approverId,
    approvedAmountOverride,
    notes: opts.notes,
    isFinalStep,
    nextStepOrder: isFinalStep ? null : remainingPending[0]!.order,
  });

  const { totalAmount, totalCurrency: currency } =
    await computeReportTotal(db, reportId);
  // Use the approved total for downstream notifications when the
  // final-step approver overrode the amount. `updated.approvedTotal`
  // comes from the in-transaction write above and is a Decimal | null.
  const approvedTotalValue =
    updated.approvedTotal !== null && updated.approvedTotal !== undefined
      ? Number(updated.approvedTotal)
      : null;
  const finalAmount = approvedTotalValue ?? totalAmount;

  if (isFinalStep) {
    void sendEmail(null);

    try {
      const deskRecipientsAll = await loadExpenseNotificationRecipients(db);
      const deskRecipients = recipientEmailsFor(deskRecipientsAll, "any");
      if (deskRecipients.length > 0) {
        void sendEmail(null);
      }
    } catch {
      // best-effort
    }
  } else {
    const next = remainingPending[0]!;
    let nextEmail: string | undefined;
    let nextName: string | undefined;
    if (next.approverType === "user" && next.approverUserId) {
      const u = await repo.findUserById(db, next.approverUserId!);
      nextEmail = u?.email ?? undefined;
      nextName = u?.name;
    } else if (next.approverType === "manager") {
      const owner = await repo.findUserById(db, report.employeeId);
      if (owner?.reportingTo) {
        const m = await repo.findUserById(db, owner.reportingTo);
        nextEmail = m?.email ?? undefined;
        nextName = m?.name;
      }
    }
    if (nextEmail) {
      // Show the running post-haircut total to the next approver so
      // they see exactly the amount they're being asked to sign off.
      const runningAmount = approvedAmountOverride ?? totalAmount;
      void sendEmail(null);
    }
  }

  return updated;
}

export async function rejectReport(db: Db, 
  reportId: string,
  approverId: string,
  reason: string,
  approverPermissions: string[] = [],
) {
  const report = await repo.findReportById(db, reportId);
  if (!report) throw new NotFoundException("Expense report not found");
  if (report.status !== "submitted") {
    throw new BadRequestException(
      `Cannot reject a report with status "${report.status}"`,
    );
  }

  let decisions = await repo.findDecisions(db, reportId);
  if (decisions.length === 0) {
    await snapshotApprovalDecisions(db, reportId, report.employeeId, {
      category: report.category,
    });
    await repo.updateReport(db, reportId, { currentStepOrder: 1 });
    decisions = await repo.findDecisions(db, reportId);
  }
  const current =
    decisions.find(
      (d) => d.order === (report.currentStepOrder ?? decisions[0]?.order ?? 1),
    ) ?? null;
  if (current && current.status === "pending") {
    let canReject = false;
    if (current.approverType === "user") {
      canReject = current.approverUserId === approverId;
    } else if (current.approverType === "manager") {
      const owner = await repo.findUserById(db, report.employeeId);
      canReject = owner?.reportingTo === approverId;
    }
    if (!canReject) {
      const owner = await repo.findUserById(db, report.employeeId);
      if (owner?.reportingTo && owner.reportingTo === approverId) {
        canReject = true;
      }
    }
    if (
      !canReject &&
      approverPermissions.includes(PERMISSIONS.EXPENSE_HR_APPROVE)
    ) {
      canReject = true;
    }
    if (!canReject) {
      throw new ForbiddenException(
        "You are not the assigned approver for this stage",
      );
    }
    await repo.updateDecision(db, current.id, {
      status: "rejected",
      decidedById: approverId,
      decidedAt: new Date().toISOString(),
      notes: reason,
    });
  }

  const updated = await repo.rejectReportTx(db, reportId, approverId, reason);

  const approver = await repo.findUserById(db, approverId);
  const { totalAmount, totalCurrency: currency } =
    await computeReportTotal(db, reportId);
  void sendEmail(null);

  return updated;
}

/**
 * Optional intermediate state between `approved` and `reimbursed`.
 * HR uses this to flag a report added to the next payroll batch but
 * not yet disbursed.  No email — internal bookkeeping flip.
 */
export async function markReportPayrollProcessed(db: Db, reportId: string, actorId: string) {
  const report = await repo.findReportById(db, reportId);
  if (!report) throw new NotFoundException("Expense report not found");
  if (report.status !== "approved") {
    throw new BadRequestException(
      `Cannot mark payroll processed: report status is "${report.status}".`,
    );
  }
  return repo.markPayrollProcessedTx(db, reportId, actorId);
}

export async function reimburseReport(db: Db, reportId: string, actorId: string) {
  const report = await repo.findReportById(db, reportId);
  if (!report) throw new NotFoundException("Expense report not found");
  if (report.status !== "approved" && report.status !== "payroll_processed") {
    throw new BadRequestException(
      `Cannot reimburse a report with status "${report.status}"`,
    );
  }

  const updated = await repo.reimburseReportTx(db, reportId, actorId)

  const { totalAmount, totalCurrency: currency } =
    await computeReportTotal(db, reportId);
  // Prefer the haircut amount stored at approval time so the
  // reimbursement notice matches the actual transfer.
  const reimbursedAmount =
    updated.approvedTotal !== null && updated.approvedTotal !== undefined
      ? Number(updated.approvedTotal)
      : totalAmount;
  void sendEmail(null);

  return updated;
}

/**
 * Reverses an accidental `reimburseReport` call.  Moves the report back
 * to `approved`.  No notification — HR is responsible for telling the
 * employee out-of-band.
 */
export async function revertReportReimbursement(db: Db, reportId: string, actorId: string) {
  const report = await repo.findReportById(db, reportId);
  if (!report) throw new NotFoundException("Expense report not found");
  if (report.status !== "reimbursed") {
    throw new BadRequestException(
      `Cannot revert reimbursement: report status is "${report.status}".`,
    );
  }

  const updated = await repo.revertReimbursementTx(db, reportId)

    return updated;
}

export async function listDecisions(db: Db, reportId: string) {
  return repo.findDecisions(db, reportId);
}


export async function listCategories(db: Db, ) {
  return repo.findCategories(db, );
}

export async function createCategory(db: Db, input: CreateCategoryInput) {
  return repo.createCategory(db, {
    name: input.name,
    description: input.description,
    glAccountId: input.glAccountId,
    isActive: input.isActive,
    spendingLimit: input.spendingLimit,
    limitPeriod: input.limitPeriod,
    receiptRequired: input.receiptRequired,
    isAllowance: input.isAllowance,
  });
}

export async function updateCategory(db: Db, id: string, input: UpdateCategoryInput) {
  const existing = await repo.findCategoryById(db, id);
  if (!existing) throw new NotFoundException("Expense category not found");
  return repo.updateCategory(db, id, input);
}

export async function deleteCategory(db: Db, id: string) {
  const existing = await repo.findCategoryById(db, id);
  if (!existing) throw new NotFoundException("Expense category not found");
  return repo.deleteCategoryById(db, id);
}

export async function getCategorySpendingOverview(
  db: Db,
  userPermissions: string[],
  userId: string,
  startDate?: string,
  endDate?: string,
) {
  const hasHrRead = userPermissions.includes(PERMISSIONS.EXPENSE_HR_READ);
  const rows = await repo.groupSpendingByCategory(db, {
    employeeId: hasHrRead ? undefined : userId,
    startDate,
    endDate,
  });
  const categoryIds = rows.map((r) => r.categoryId).filter((id): id is string => !!id);
  const categories = await repo.findCategoriesByIds(db, categoryIds);
  const catMap = new Map(categories.map((c) => [c.id, c]));

  return {
    data: rows.map((r) => {
      const cat = r.categoryId ? catMap.get(r.categoryId) : null;
      return {
        categoryId: r.categoryId,
        categoryName: cat?.name ?? "Uncategorized",
        totalAmount: r.totalAmount,
        count: r.count,
        spendingLimit: cat?.spendingLimit ? Number(cat.spendingLimit) : null,
        limitPeriod: cat?.limitPeriod ?? null,
      };
    }),
  };
}


// ── Exchange rates ────────────────────────────────────────────────

export async function listExchangeRates(db: Db, baseCurrency: string, date?: string) {
  const rates = await repo.findExchangeRates(db, baseCurrency, date);
  return { data: rates };
}

export async function upsertExchangeRate(db: Db, input: UpsertExchangeRateBody) {
  return repo.upsertExchangeRate(db, input);
}

export async function convertExpenseAmount(db: Db, 
  amount: number,
  fromCurrency: string,
  toCurrency: string,
) {
  const result = await repo.convertAmount(db, 
    amount,
    fromCurrency,
    toCurrency,
  );
  if (!result) {
    throw new BadRequestException(
      `No exchange rate found for ${fromCurrency} → ${toCurrency}`,
    );
  }
  return { data: result };
}

// ── Approval chain admin ──────────────────────────────────────────

export async function listApprovalSteps(db: Db, ) {
  return repo.findApprovalSteps(db, );
}

export async function createApprovalStep(db: Db, input: CreateExpenseApprovalStepInput) {
  const order = await repo.nextStepOrder(db, );
  return repo.createApprovalStep(db, {
    order,
    name: input.name,
    description: input.description,
    approverType: input.approverType,
    stageRole: input.stageRole,
    isActive: input.isActive,
    skipWhenSubmitterIds: input.skipWhenSubmitterIds,
    onlyWhenSubmitterIds: input.onlyWhenSubmitterIds,
    categoryFilter: input.categoryFilter,
    amountMinBaht: input.amountMinBaht ?? null,
    amountMaxBaht: input.amountMaxBaht ?? null,
    approverUserId: input.approverType === "user" ? input.approverUserId ?? null : null,
  });
}

export async function updateApprovalStep(
  db: Db,
  id: string,
  input: UpdateExpenseApprovalStepInput,
) {
  const existing = await repo.findApprovalStepById(db, id);
  if (!existing) throw new NotFoundException("Approval step not found");

  const nextType = input.approverType ?? existing.approverType;
  let nextApproverId: string | null = existing.approverUserId;
  if (nextType === "user") {
    const userId = input.approverUserId ?? existing.approverUserId;
    if (!userId) {
      throw new BadRequestException(
        "approverUserId is required when approverType is 'user'",
      );
    }
    nextApproverId = userId;
  } else if (nextType === "manager") {
    nextApproverId = null;
  }

  const updated = await repo.updateApprovalStep(db, id, {
    ...(input.name !== undefined && { name: input.name }),
    ...(input.description !== undefined && { description: input.description }),
    ...(input.order !== undefined && { order: input.order }),
    ...(input.stageRole !== undefined && { stageRole: input.stageRole }),
    ...(input.isActive !== undefined && { isActive: input.isActive }),
    ...(input.skipWhenSubmitterIds !== undefined && { skipWhenSubmitterIds: input.skipWhenSubmitterIds }),
    ...(input.onlyWhenSubmitterIds !== undefined && { onlyWhenSubmitterIds: input.onlyWhenSubmitterIds }),
    ...(input.categoryFilter !== undefined && { categoryFilter: input.categoryFilter }),
    ...(input.amountMinBaht !== undefined && { amountMinBaht: input.amountMinBaht }),
    ...(input.amountMaxBaht !== undefined && { amountMaxBaht: input.amountMaxBaht }),
    ...(input.approverType !== undefined && { approverType: input.approverType }),
    approverUserId: nextApproverId,
  });

  await repo.reassignPendingDecisionsByStepName(db, existing.name, nextApproverId);
  return updated;
}

export async function deleteApprovalStep(db: Db, id: string) {
  const existing = await repo.findApprovalStepById(db, id);
  if (!existing) throw new NotFoundException("Approval step not found");
  return repo.deleteApprovalStep(db, id);
}

export async function reorderApprovalSteps(db: Db, input: ReorderExpenseApprovalStepsInput) {
  const all = await repo.findApprovalSteps(db, );
  if (all.length !== input.orderedIds.length) {
    throw new BadRequestException(
      "orderedIds must include every existing step exactly once",
    );
  }
  const known = new Set(all.map((s) => s.id));
  for (const id of input.orderedIds) {
    if (!known.has(id)) {
      throw new BadRequestException(
        `Unknown approval step id in reorder: ${id}`,
      );
    }
  }
  return repo.reorderApprovalSteps(db, input.orderedIds);
}

// ── Notification recipients ───────────────────────────────────────

export async function getNotificationRecipients(db: Db, ) {
  return { recipients: await loadExpenseNotificationRecipients(db) };
}

export async function setNotificationRecipients(db: Db, rawRecipients: unknown[]) {
  const seen = new Set<string>();
  const cleaned: ExpenseRecipient[] = [];
  for (const raw of rawRecipients) {
    // Accept either legacy plain-string entries or the new object shape.
    let email: string | undefined;
    let mode: ExpenseRecipientMode = "approved";
    if (typeof raw === "string") {
      email = raw;
    } else if (raw && typeof raw === "object" && "email" in raw) {
      const rec = raw as { email: unknown; mode?: unknown };
      if (typeof rec.email === "string") email = rec.email;
      if (rec.mode === "everything") mode = "everything";
    }
    if (!email) continue;
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) continue;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      throw new BadRequestException(`Invalid email: ${email}`);
    }
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    cleaned.push({ email: trimmed, mode });
  }
  await upsertSetting(db, EXPENSE_NOTIFICATION_KEY, cleaned);
  return { recipients: cleaned };
}

// ── Reminder settings ─────────────────────────────────────────────

const EXPENSE_REMINDER_SETTINGS_KEY = "expense.reminder_settings";

export interface ExpenseReminderSettings {
  reminderDay: number;
  reminderTime: string;
  reminderTimezone: string;
  enableThailand: boolean;
  enableInternational: boolean;
}

const DEFAULT_REMINDER_SETTINGS: ExpenseReminderSettings = {
  reminderDay: EXPENSE_REMINDER_DAY_OF_MONTH,
  reminderTime: EXPENSE_REMINDER_TIME,
  reminderTimezone: EXPENSE_REMINDER_TIMEZONE,
  enableThailand: true,
  enableInternational: true,
};

async function loadReminderSettings(db: Db): Promise<ExpenseReminderSettings> {
  const rowValue = await getSetting(db, EXPENSE_REMINDER_SETTINGS_KEY);
  const row = rowValue ? { value: rowValue } : null;
  if (
    !row?.value ||
    typeof row.value !== "object" ||
    Array.isArray(row.value)
  ) {
    return { ...DEFAULT_REMINDER_SETTINGS };
  }
  const v = row.value as Record<string, unknown>;
  // Validate stored timezone is still a valid IANA name; fall back on error.
  let tz = DEFAULT_REMINDER_SETTINGS.reminderTimezone;
  if (typeof v.reminderTimezone === "string" && v.reminderTimezone) {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: v.reminderTimezone });
      tz = v.reminderTimezone;
    } catch {
      /* keep default */
    }
  }
  return {
    reminderDay:
      typeof v.reminderDay === "number" &&
      v.reminderDay >= 1 &&
      v.reminderDay <= 31
        ? v.reminderDay
        : DEFAULT_REMINDER_SETTINGS.reminderDay,
    reminderTime:
      typeof v.reminderTime === "string" && /^\d{2}:\d{2}$/.test(v.reminderTime)
        ? v.reminderTime
        : DEFAULT_REMINDER_SETTINGS.reminderTime,
    reminderTimezone: tz,
    enableThailand:
      typeof v.enableThailand === "boolean"
        ? v.enableThailand
        : DEFAULT_REMINDER_SETTINGS.enableThailand,
    enableInternational:
      typeof v.enableInternational === "boolean"
        ? v.enableInternational
        : DEFAULT_REMINDER_SETTINGS.enableInternational,
  };
}

export async function getReminderSettings(db: Db, ): Promise<{
  settings: ExpenseReminderSettings;
}> {
  return { settings: await loadReminderSettings(db) };
}

export async function setReminderSettings(db: Db, 
  input: UpsertExpenseReminderSettingsInput,
): Promise<{ settings: ExpenseReminderSettings }> {
  const settings: ExpenseReminderSettings = {
    reminderDay: input.reminderDay,
    reminderTime: input.reminderTime,
    reminderTimezone: input.reminderTimezone,
    enableThailand: input.enableThailand,
    enableInternational: input.enableInternational,
  };
  await upsertSetting(db, EXPENSE_REMINDER_SETTINGS_KEY, settings);
  return { settings };
}

// ── Monthly reminder cron ─────────────────────────────────────────

/**
 * Monthly expense submission reminders (HR request, May 2026).
 * Intended to run on the reminder day (default 22) via Cloud Scheduler
 * (`Asia/Bangkok`). Skips employees who already filed the current period.
 * Pass `{ force: true }` to bypass the day-of-month guard for testing.
 */
export async function processMonthlySubmissionReminders(
  _db: Db,
  _opts: { force?: boolean } = {},
) {
  return { skipped: true as const, reason: "stub" as const };
}
