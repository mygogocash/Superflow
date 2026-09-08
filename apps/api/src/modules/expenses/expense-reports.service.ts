/**
 * Expense report workflow: create → submit → approve/reject → reimburse.
 * Also owns the approval-decision snapshot, allowance fast-path, and
 * line-item management (add / update / remove expenses within a report).
 */

import { PERMISSIONS } from "@/common/constants/permissions";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@/common/exceptions/http-exception";
import { logger } from "@/common/utils/logger";
import { prisma } from "@/infrastructure/database/prisma";
import { sendEmail } from "@/infrastructure/email/email.service";
import {
  expenseAllowanceFiledEmail,
  expenseApprovedEmail,
  expenseDeskSummaryEmail,
  expenseReimbursedEmail,
  expenseRejectedEmail,
  expenseSubmittedEmail,
} from "@/infrastructure/email/templates";
import { PORTAL_URL } from "@/lib/portal-url";
import {
  fmtAmount,
  loadExpenseNotificationRecipients,
  recipientEmailsFor,
  withSignedReceipt,
  withSignedReceipts,
} from "@/modules/expenses/expense-shared";
import { expensesRepository } from "@/modules/expenses/expenses.repository";
import type {
  AddExpenseToReportInput,
  CreateExpenseReportInput,
  ExpenseReportQuery,
  MonthlyExpenseSummaryQuery,
  UpdateExpenseInReportInput,
  UpdateExpenseReportInput,
} from "@/modules/expenses/expenses.validation";

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
  reportId: string,
): Promise<{ thb: number; missing: string[] }> {
  const lines = await expensesRepository.findReportExpenseLines(reportId);
  let thb = 0;
  const missing: string[] = [];
  for (const line of lines) {
    const amount = Number(line.amount);
    if (line.currency === "THB") {
      thb += amount;
      continue;
    }
    const fx = await expensesRepository.convertAmount(
      amount,
      line.currency,
      "THB",
      line.date,
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
async function computeReportTotal(reportId: string): Promise<{
  totalAmount: number;
  totalCurrency: string;
  converted: boolean;
  missingRates: string[];
}> {
  const subtotals =
    await expensesRepository.sumReportTotalsByCurrency(reportId);
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
  const { thb, missing } = await convertReportToThb(reportId);
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
    const date = row.date instanceof Date ? row.date : new Date(row.date);
    const key = `${currency}|${date.toISOString().slice(0, 10)}`;
    let rate = rateCache.get(key);
    if (rate === undefined) {
      const fx = await expensesRepository.convertAmount(
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
  reportId: string,
  submitterId: string,
  opts?: { category?: string; totalBaht?: number | null },
) {
  const allSteps = await expensesRepository.findApprovalSteps({
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
  const submitter = await prisma.user.findUnique({
    where: { id: submitterId },
    select: { reportingTo: true },
  });
  if (submitter?.reportingTo) {
    l1UserId = submitter.reportingTo;
    const l1 = await prisma.user.findUnique({
      where: { id: submitter.reportingTo },
      select: { reportingTo: true },
    });
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

  await expensesRepository.deleteDecisionsForReport(reportId);
  await expensesRepository.createDecisions(reportId, decisionRows);
  return decisionRows;
}

/** Returns true when every category in `categoryIds` is flagged `isAllowance`. */
async function areAllAllowanceCategories(
  categoryIds: string[],
): Promise<boolean> {
  if (categoryIds.length === 0) return false;
  const unique = Array.from(new Set(categoryIds));
  const rows = await prisma.expenseCategory.findMany({
    where: { id: { in: unique } },
    select: { id: true, isAllowance: true },
  });
  if (rows.length !== unique.length) return false;
  return rows.every((r) => r.isAllowance);
}

/**
 * True when the org has at least one active approval step whose
 * `categoryFilter` includes `"allowance"`.
 */
async function hasAllowanceApprovalChain(): Promise<boolean> {
  const steps = await expensesRepository.findApprovalSteps({
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
  reportId: string,
  userId: string,
  report: NonNullable<
    Awaited<ReturnType<typeof expensesRepository.findReportById>>
  >,
) {
  // Allowance reports short-circuit straight to `reimbursed`, so guard
  // the same way submit does: a foreign line with no THB rate can't be
  // paid on a single Baht figure.
  const { missing } = await convertReportToThb(reportId);
  assertReportConvertible(missing, "submit this allowance report");

  const now = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    const r = await tx.expenseReport.update({
      where: { id: reportId },
      data: {
        status: "reimbursed",
        submittedAt: now,
        approvedBy: userId,
        approvedAt: now,
        reimbursedAt: now,
        rejectReason: null,
        currentStepOrder: null,
      },
      include: {
        employee: { select: { id: true, name: true, email: true } },
      },
    });
    await tx.expense.updateMany({
      where: { reportId },
      data: {
        status: "reimbursed",
        approvedBy: userId,
        approvedAt: now,
        reimbursedAt: now,
      },
    });
    return r;
  });

  const { totalAmount, totalCurrency: currency } =
    await computeReportTotal(reportId);
  const portalUrl = `${PORTAL_URL}/expenses/${reportId}`;

  if (updated.employee.email) {
    const email = expenseAllowanceFiledEmail({
      recipientName: updated.employee.name,
      employeeName: updated.employee.name,
      reportTitle: report.title,
      amount: fmtAmount(totalAmount, currency),
      expenseCount: report.expenses.length,
      portalUrl,
      forSubmitter: true,
    });
    void sendEmail({ to: updated.employee.email, ...email });
  }

  try {
    const deskRecipientsAll = await loadExpenseNotificationRecipients();
    const deskRecipients = recipientEmailsFor(deskRecipientsAll, "any");
    if (deskRecipients.length > 0) {
      const employee = await prisma.user.findUnique({
        where: { id: report.employeeId },
        select: {
          department: true,
          entity: { select: { name: true } },
        },
      });
      const deskEmail = expenseAllowanceFiledEmail({
        recipientName: "Team",
        employeeName: updated.employee.name,
        employeeEmail: updated.employee.email,
        department: employee?.department ?? null,
        entity: employee?.entity?.name ?? null,
        reportTitle: report.title,
        amount: fmtAmount(totalAmount, currency),
        expenseCount: report.expenses.length,
        notes: report.notes ?? null,
        portalUrl,
        forSubmitter: false,
      });
      void sendEmail({ to: deskRecipients, ...deskEmail });
    }
  } catch {
    // best-effort
  }

  return updated;
}

// ── Public service methods ────────────────────────────────────────

async function listReports(
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
      const pendingDecisions = await prisma.expenseApprovalDecision.findMany({
        where: {
          status: "pending",
          expenseReport: { status: "submitted" },
          OR: [
            { approverType: "user", approverUserId: userId },
            {
              approverType: "manager",
              expenseReport: {
                employee: { reportingTo: userId, isActive: true },
              },
            },
          ],
        },
        select: {
          expenseReportId: true,
          order: true,
          expenseReport: { select: { currentStepOrder: true } },
        },
      });
      const currentStepIds = pendingDecisions
        .filter((d) => d.order === d.expenseReport.currentStepOrder)
        .map((d) => d.expenseReportId);

      const legacy = await prisma.expenseReport.findMany({
        where: {
          status: "submitted",
          approvalDecisions: { none: {} },
          employee: { reportingTo: userId, isActive: true },
        },
        select: { id: true },
      });

      // Manager parallel-approver fallback: any submitted report from a
      // direct report should land in the inbox.
      const managerBackup = await prisma.expenseReport.findMany({
        where: {
          status: "submitted",
          employee: { reportingTo: userId, isActive: true },
        },
        select: { id: true },
      });

      reportIds = Array.from(
        new Set([
          ...currentStepIds,
          ...legacy.map((r) => r.id),
          ...managerBackup.map((r) => r.id),
        ]),
      );
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

  const { data, total } = await expensesRepository.findReports(
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
      const total = await computeReportTotal(r.id);
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

async function monthlySummary(
  userPermissions: string[],
  query: MonthlyExpenseSummaryQuery,
) {
  if (!userPermissions.includes(PERMISSIONS.EXPENSE_HR_READ)) {
    throw new ForbiddenException(
      "The monthly overview requires the expense:hr-read permission",
    );
  }

  const [counts, lines] = await Promise.all([
    expensesRepository.summaryReportCounts(query),
    expensesRepository.findReportLinesForSummary(query),
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
    const date = line.date instanceof Date ? line.date : new Date(line.date);
    const key = `${currency}|${date.toISOString().slice(0, 10)}`;
    let rate = rateCache.get(key);
    if (rate === undefined) {
      const fx = await expensesRepository.convertAmount(
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

async function getReportById(
  id: string,
  userId: string,
  userPermissions: string[],
) {
  const report = await expensesRepository.findReportById(id);
  if (!report) throw new NotFoundException("Expense report not found");

  const hasHrRead = userPermissions.includes(PERMISSIONS.EXPENSE_HR_READ);
  const hasHrApprove = userPermissions.includes(PERMISSIONS.EXPENSE_HR_APPROVE);
  const hasApprove = userPermissions.includes(PERMISSIONS.EXPENSE_APPROVE);
  const isOwner = report.employeeId === userId;
  let isManager = false;
  let isAssignedApprover = false;

  if (!isOwner) {
    const employee = await prisma.user.findUnique({
      where: { id: report.employeeId },
      select: { reportingTo: true },
    });
    isManager = employee?.reportingTo === userId;
    if (!isManager) {
      const decision = await prisma.expenseApprovalDecision.findFirst({
        where: { expenseReportId: id, approverUserId: userId },
        select: { id: true },
      });
      isAssignedApprover = !!decision;
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

  const total = await computeReportTotal(report.id);
  const expenses = await withFxConversion(
    await withSignedReceipts(report.expenses),
  );
  return { ...report, expenses, ...total, canApprove };
}

async function createReport(
  userId: string,
  input: CreateExpenseReportInput,
  actorPermissions: string[],
) {
  assertCanUseOfficeCategory(input.category, actorPermissions);
  return expensesRepository.createReport({
    employeeId: userId,
    entityId: input.entityId,
    period: input.period,
    title: input.title,
    category: input.category,
    ...(input.notes !== undefined && { notes: input.notes }),
  });
}

async function updateReport(
  id: string,
  userId: string,
  input: UpdateExpenseReportInput,
  actorPermissions: string[],
) {
  const report = await expensesRepository.findReportById(id);
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

  return expensesRepository.updateReport(id, {
    ...(input.title !== undefined && { title: input.title }),
    ...(input.period !== undefined && { period: input.period }),
    ...(input.category !== undefined && { category: input.category }),
    ...(input.notes !== undefined && { notes: input.notes }),
  });
}

async function deleteReport(
  id: string,
  userId: string,
  actorPermissions: string[],
) {
  const report = await expensesRepository.findReportById(id);
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
  return expensesRepository.softDeleteReport(id);
}

async function restoreReport(
  id: string,
  userId: string,
  actorPermissions: string[],
) {
  // findReportById hides soft-deleted rows; a hit means it's still active.
  const active = await expensesRepository.findReportById(id);
  if (active) throw new ConflictException("Report is not deleted");

  const report = await expensesRepository.findReportByIdIncludingDeleted(id);
  if (!report) throw new NotFoundException("Expense report not found");

  const isAdminDelete = actorPermissions.includes(
    PERMISSIONS.EXPENSE_HR_DELETE,
  );
  if (!isAdminDelete && report.employeeId !== userId) {
    throw new ForbiddenException("You can only restore your own reports");
  }
  return expensesRepository.restoreReport(id);
}

async function permanentDeleteReport(id: string, permissions: string[]) {
  // Soft-deleted rows are the normal purge target; the live finder would 404 them.
  const report = await expensesRepository.findReportByIdIncludingDeleted(id);
  if (!report) {
    throw new NotFoundException("Expense report not found");
  }
  if (!permissions.includes(PERMISSIONS.EXPENSE_HR_DELETE)) {
    throw new ForbiddenException(
      "Only HR can permanently delete expense reports",
    );
  }
  return expensesRepository.permanentDeleteReport(id);
}

async function addExpenseToReport(
  reportId: string,
  userId: string,
  input: AddExpenseToReportInput,
) {
  const report = await expensesRepository.findReportById(reportId);
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
    const category = await expensesRepository.findCategoryById(
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

  const expense = await prisma.expense.create({
    data: {
      employeeId: userId,
      entityId: report.entityId,
      reportId: report.id,
      ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
      ...(input.travelRequestId !== undefined && {
        travelRequestId: input.travelRequestId,
      }),
      description: input.description,
      amount: input.amount,
      currency: input.currency,
      date: new Date(input.date),
      ...(input.receiptUrl !== undefined && { receiptUrl: input.receiptUrl }),
      ...(input.notes !== undefined && { notes: input.notes }),
    },
    include: {
      employee: {
        select: { id: true, name: true, email: true, department: true },
      },
      entity: { select: { id: true, name: true } },
      category: { select: { id: true, name: true } },
    },
  });

  return withSignedReceipt(expense);
}

async function updateExpenseInReport(
  reportId: string,
  expenseId: string,
  userId: string,
  input: UpdateExpenseInReportInput,
) {
  const report = await expensesRepository.findReportById(reportId);
  if (!report) throw new NotFoundException("Expense report not found");
  if (report.employeeId !== userId) {
    throw new ForbiddenException("You can only edit your own reports");
  }
  if (report.status !== "draft" && report.status !== "rejected") {
    throw new BadRequestException(
      `Cannot edit expenses in a report with status "${report.status}"`,
    );
  }

  const expense = await expensesRepository.findExpenseById(expenseId);
  if (!expense || expense.reportId !== reportId) {
    throw new NotFoundException("Expense not found in this report");
  }

  const updated = await expensesRepository.updateExpense(expenseId, {
    ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
    ...(input.description !== undefined && { description: input.description }),
    ...(input.amount !== undefined && { amount: input.amount }),
    ...(input.currency !== undefined && { currency: input.currency }),
    ...(input.date !== undefined && { date: new Date(input.date) }),
    ...(input.receiptUrl !== undefined && { receiptUrl: input.receiptUrl }),
    ...(input.notes !== undefined && { notes: input.notes }),
  });
  return withSignedReceipt(updated);
}

async function removeExpenseFromReport(
  reportId: string,
  expenseId: string,
  userId: string,
) {
  const report = await expensesRepository.findReportById(reportId);
  if (!report) throw new NotFoundException("Expense report not found");
  if (report.employeeId !== userId) {
    throw new ForbiddenException("You can only edit your own reports");
  }
  if (report.status !== "draft" && report.status !== "rejected") {
    throw new BadRequestException(
      `Cannot remove expenses from a report with status "${report.status}"`,
    );
  }
  const expense = await expensesRepository.findExpenseById(expenseId);
  if (!expense || expense.reportId !== reportId) {
    throw new NotFoundException("Expense not found in this report");
  }
  return expensesRepository.softDeleteExpense(expenseId);
}

async function submitReport(reportId: string, userId: string) {
  const report = await expensesRepository.findReportById(reportId);
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
    (await areAllAllowanceCategories(categoryIds));
  let reportCategory = report.category;
  if (isAllowanceOnly) {
    if (await hasAllowanceApprovalChain()) {
      await expensesRepository.updateReport(reportId, {
        category: "allowance",
      });
      reportCategory = "allowance";
    } else {
      return finaliseAllowanceReport(reportId, userId, report);
    }
  }

  // THB-equivalent total for amount-band step routing. A foreign line
  // with no THB rate can't be routed on a single Baht figure, so block
  // the submit rather than fall back to an unconverted number.
  const { thb: totalBaht, missing } = await convertReportToThb(reportId);
  assertReportConvertible(missing, "submit this report");

  const decisionRows = await snapshotApprovalDecisions(reportId, userId, {
    category: reportCategory,
    totalBaht,
  });

  const updated = await expensesRepository.updateReport(reportId, {
    status: "submitted",
    submittedAt: new Date(),
    rejectReason: null,
    currentStepOrder: 1,
  });

  const firstStep = decisionRows[0]!;
  let approverEmail: string | undefined;
  let approverName: string | undefined;
  const employee = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, reportingTo: true },
  });
  if (firstStep.approverType === "manager" && employee?.reportingTo) {
    const manager = await prisma.user.findUnique({
      where: { id: employee.reportingTo },
      select: { name: true, email: true },
    });
    approverEmail = manager?.email ?? undefined;
    approverName = manager?.name;
  } else if (firstStep.approverType === "user" && firstStep.approverUserId) {
    const approver = await prisma.user.findUnique({
      where: { id: firstStep.approverUserId },
      select: { name: true, email: true },
    });
    approverEmail = approver?.email ?? undefined;
    approverName = approver?.name;
  }
  if (approverEmail && employee) {
    const { totalAmount, totalCurrency: currency } =
      await computeReportTotal(reportId);
    const email = expenseSubmittedEmail({
      approverName: approverName ?? "Approver",
      employeeName: employee.name,
      title: report.title,
      amount: fmtAmount(totalAmount, currency),
      category: `${report.expenses.length} expense(s)`,
      portalUrl: `${PORTAL_URL}/expenses/${reportId}`,
    });
    void sendEmail({ to: approverEmail, ...email });
  }

  try {
    const deskRecipientsAll = await loadExpenseNotificationRecipients();
    const desk = recipientEmailsFor(deskRecipientsAll, "everything");
    if (desk.length > 0 && employee) {
      const { totalAmount, totalCurrency: currency } =
        await computeReportTotal(reportId);
      const employeeRow = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          email: true,
          department: true,
          entity: { select: { name: true } },
        },
      });
      const deskEmail = expenseDeskSummaryEmail({
        employeeName: employee.name,
        employeeEmail: employeeRow?.email ?? "",
        department: employeeRow?.department ?? null,
        entity: employeeRow?.entity?.name ?? null,
        reportTitle: report.title,
        amount: fmtAmount(totalAmount, currency),
        expenseCount: report.expenses.length,
        notes: report.notes ?? null,
        approverName: employee.name,
        portalUrl: `${PORTAL_URL}/expenses/${reportId}`,
        event: "submitted",
      });
      void sendEmail({ to: desk, ...deskEmail });
    }
  } catch {
    // best-effort
  }

  return updated;
}

async function approveReport(
  reportId: string,
  approverId: string,
  approverPermissions: string[] = [],
  opts: { approvedAmount?: number; notes?: string } = {},
) {
  const report = await expensesRepository.findReportById(reportId);
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

  let decisions = await expensesRepository.findDecisions(reportId);
  if (decisions.length === 0) {
    await snapshotApprovalDecisions(reportId, report.employeeId, {
      category: report.category,
    });
    await expensesRepository.updateReport(reportId, { currentStepOrder: 1 });
    decisions = await expensesRepository.findDecisions(reportId);
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
      await computeReportTotal(reportId);
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
    const owner = await prisma.user.findUnique({
      where: { id: report.employeeId },
      select: { reportingTo: true },
    });
    isAuthorisedApprover = owner?.reportingTo === approverId;
  }
  // Parallel fallback: the submitter's direct manager can always approve.
  if (!isAuthorisedApprover) {
    const owner = await prisma.user.findUnique({
      where: { id: report.employeeId },
      select: { reportingTo: true },
    });
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

  const approver = await prisma.user.findUnique({
    where: { id: approverId },
    select: { name: true },
  });

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

  const updated = await prisma.$transaction(async (tx) => {
    await tx.expenseApprovalDecision.update({
      where: { id: current.id },
      data: {
        status: "approved",
        decidedById: approverId,
        decidedAt: new Date(),
        approvedAmount: approvedAmountOverride,
        notes: opts.notes ?? undefined,
      },
    });

    // Compute the running approved total to mirror onto the report on
    // the final step. The latest non-null override across approved
    // decisions wins; if no step ever overrode, leave it null (= the
    // submitted total).
    let finalApprovedTotal: number | null = null;
    if (isFinalStep) {
      const allDecisions = await tx.expenseApprovalDecision.findMany({
        where: { expenseReportId: reportId },
        orderBy: { order: "asc" },
      });
      // Include the just-updated decision since the in-tx select
      // already reflects the write above.
      const overrides = allDecisions
        .filter((d) => d.approvedAmount !== null)
        .map((d) => Number(d.approvedAmount));
      if (overrides.length > 0) {
        finalApprovedTotal = overrides[overrides.length - 1]!;
      }
    }

    const r = await tx.expenseReport.update({
      where: { id: reportId },
      data: {
        status: isFinalStep ? "approved" : "submitted",
        approvedBy: isFinalStep ? approverId : undefined,
        approvedAt: isFinalStep ? new Date() : undefined,
        approvedTotal: isFinalStep ? finalApprovedTotal : undefined,
        rejectReason: null,
        currentStepOrder: isFinalStep ? null : remainingPending[0]!.order,
      },
      include: {
        employee: { select: { id: true, name: true, email: true } },
      },
    });

    if (isFinalStep) {
      await tx.expense.updateMany({
        where: { reportId },
        data: {
          status: "approved",
          approvedBy: approverId,
          approvedAt: new Date(),
        },
      });
    }
    return r;
  });

  const { totalAmount, totalCurrency: currency } =
    await computeReportTotal(reportId);
  // Use the approved total for downstream notifications when the
  // final-step approver overrode the amount. `updated.approvedTotal`
  // comes from the in-transaction write above and is a Decimal | null.
  const approvedTotalValue =
    updated.approvedTotal !== null && updated.approvedTotal !== undefined
      ? Number(updated.approvedTotal)
      : null;
  const finalAmount = approvedTotalValue ?? totalAmount;

  if (isFinalStep) {
    const email = expenseApprovedEmail({
      employeeName: updated.employee.name,
      title: report.title,
      amount: fmtAmount(finalAmount, currency),
      approverName: approver?.name ?? "Your Manager",
      portalUrl: `${PORTAL_URL}/expenses/${reportId}`,
    });
    void sendEmail({ to: updated.employee.email, ...email });

    try {
      const deskRecipientsAll = await loadExpenseNotificationRecipients();
      const deskRecipients = recipientEmailsFor(deskRecipientsAll, "any");
      if (deskRecipients.length > 0) {
        const employee = await prisma.user.findUnique({
          where: { id: report.employeeId },
          select: {
            department: true,
            entity: { select: { name: true } },
          },
        });
        const deskEmail = expenseDeskSummaryEmail({
          employeeName: updated.employee.name,
          employeeEmail: updated.employee.email,
          department: employee?.department ?? null,
          entity: employee?.entity?.name ?? null,
          reportTitle: report.title,
          amount: fmtAmount(finalAmount, currency),
          expenseCount: report.expenses.length,
          notes: report.notes ?? null,
          approverName: approver?.name ?? "Your Manager",
          portalUrl: `${PORTAL_URL}/expenses/${reportId}`,
        });
        void sendEmail({ to: deskRecipients, ...deskEmail });
      }
    } catch {
      // best-effort
    }
  } else {
    const next = remainingPending[0]!;
    let nextEmail: string | undefined;
    let nextName: string | undefined;
    if (next.approverType === "user" && next.approverUserId) {
      const u = await prisma.user.findUnique({
        where: { id: next.approverUserId },
        select: { name: true, email: true },
      });
      nextEmail = u?.email ?? undefined;
      nextName = u?.name;
    } else if (next.approverType === "manager") {
      const owner = await prisma.user.findUnique({
        where: { id: report.employeeId },
        select: { reportingTo: true },
      });
      if (owner?.reportingTo) {
        const m = await prisma.user.findUnique({
          where: { id: owner.reportingTo },
          select: { name: true, email: true },
        });
        nextEmail = m?.email ?? undefined;
        nextName = m?.name;
      }
    }
    if (nextEmail) {
      // Show the running post-haircut total to the next approver so
      // they see exactly the amount they're being asked to sign off.
      const runningAmount = approvedAmountOverride ?? totalAmount;
      const email = expenseSubmittedEmail({
        approverName: nextName ?? "Approver",
        employeeName: updated.employee.name,
        title: report.title,
        amount: fmtAmount(runningAmount, currency),
        category: `${report.expenses.length} expense(s)`,
        portalUrl: `${PORTAL_URL}/expenses/${reportId}`,
      });
      void sendEmail({ to: nextEmail, ...email });
    }
  }

  return updated;
}

async function rejectReport(
  reportId: string,
  approverId: string,
  reason: string,
  approverPermissions: string[] = [],
) {
  const report = await expensesRepository.findReportById(reportId);
  if (!report) throw new NotFoundException("Expense report not found");
  if (report.status !== "submitted") {
    throw new BadRequestException(
      `Cannot reject a report with status "${report.status}"`,
    );
  }

  let decisions = await expensesRepository.findDecisions(reportId);
  if (decisions.length === 0) {
    await snapshotApprovalDecisions(reportId, report.employeeId, {
      category: report.category,
    });
    await expensesRepository.updateReport(reportId, { currentStepOrder: 1 });
    decisions = await expensesRepository.findDecisions(reportId);
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
      const owner = await prisma.user.findUnique({
        where: { id: report.employeeId },
        select: { reportingTo: true },
      });
      canReject = owner?.reportingTo === approverId;
    }
    if (!canReject) {
      const owner = await prisma.user.findUnique({
        where: { id: report.employeeId },
        select: { reportingTo: true },
      });
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
    await expensesRepository.updateDecision(current.id, {
      status: "rejected",
      decidedBy: { connect: { id: approverId } },
      decidedAt: new Date(),
      notes: reason,
    });
  }

  const updated = await prisma.expenseReport.update({
    where: { id: reportId },
    data: {
      status: "rejected",
      approvedBy: approverId,
      approvedAt: new Date(),
      rejectReason: reason,
      currentStepOrder: null,
    },
    include: {
      employee: { select: { id: true, name: true, email: true } },
    },
  });

  const approver = await prisma.user.findUnique({
    where: { id: approverId },
    select: { name: true },
  });
  const { totalAmount, totalCurrency: currency } =
    await computeReportTotal(reportId);
  const email = expenseRejectedEmail({
    employeeName: updated.employee.name,
    title: report.title,
    amount: fmtAmount(totalAmount, currency),
    approverName: approver?.name ?? "Your Manager",
    rejectionReason: reason,
    portalUrl: `${PORTAL_URL}/expenses/${reportId}`,
  });
  void sendEmail({ to: updated.employee.email, ...email });

  return updated;
}

/**
 * Optional intermediate state between `approved` and `reimbursed`.
 * HR uses this to flag a report added to the next payroll batch but
 * not yet disbursed.  No email — internal bookkeeping flip.
 */
async function markReportPayrollProcessed(reportId: string, actorId: string) {
  const report = await expensesRepository.findReportById(reportId);
  if (!report) throw new NotFoundException("Expense report not found");
  if (report.status !== "approved") {
    throw new BadRequestException(
      `Cannot mark payroll processed: report status is "${report.status}".`,
    );
  }
  return prisma.$transaction(async (tx) => {
    const r = await tx.expenseReport.update({
      where: { id: reportId },
      data: {
        status: "payroll_processed",
        approvedBy: actorId,
      },
    });
    await tx.expense.updateMany({
      where: { reportId, status: "approved" },
      data: { status: "payroll_processed" },
    });
    return r;
  });
}

async function reimburseReport(reportId: string, actorId: string) {
  const report = await expensesRepository.findReportById(reportId);
  if (!report) throw new NotFoundException("Expense report not found");
  if (report.status !== "approved" && report.status !== "payroll_processed") {
    throw new BadRequestException(
      `Cannot reimburse a report with status "${report.status}"`,
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    const r = await tx.expenseReport.update({
      where: { id: reportId },
      data: {
        status: "reimbursed",
        reimbursedAt: new Date(),
        approvedBy: actorId,
      },
      include: {
        employee: { select: { id: true, name: true, email: true } },
      },
    });
    await tx.expense.updateMany({
      where: { reportId },
      data: {
        status: "reimbursed",
        reimbursedAt: new Date(),
      },
    });
    return r;
  });

  const { totalAmount, totalCurrency: currency } =
    await computeReportTotal(reportId);
  // Prefer the haircut amount stored at approval time so the
  // reimbursement notice matches the actual transfer.
  const reimbursedAmount =
    updated.approvedTotal !== null && updated.approvedTotal !== undefined
      ? Number(updated.approvedTotal)
      : totalAmount;
  const email = expenseReimbursedEmail({
    employeeName: updated.employee.name,
    title: report.title,
    amount: fmtAmount(reimbursedAmount, currency),
    portalUrl: `${PORTAL_URL}/expenses/${reportId}`,
  });
  void sendEmail({ to: updated.employee.email, ...email });

  return updated;
}

/**
 * Reverses an accidental `reimburseReport` call.  Moves the report back
 * to `approved`.  No notification — HR is responsible for telling the
 * employee out-of-band.
 */
async function revertReportReimbursement(reportId: string, actorId: string) {
  const report = await expensesRepository.findReportById(reportId);
  if (!report) throw new NotFoundException("Expense report not found");
  if (report.status !== "reimbursed") {
    throw new BadRequestException(
      `Cannot revert reimbursement: report status is "${report.status}".`,
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    const r = await tx.expenseReport.update({
      where: { id: reportId },
      data: {
        status: "approved",
        reimbursedAt: null,
      },
      include: {
        employee: { select: { id: true, name: true, email: true } },
      },
    });
    await tx.expense.updateMany({
      where: { reportId, status: "reimbursed" },
      data: {
        status: "approved",
        reimbursedAt: null,
      },
    });
    return r;
  });

  logger.info("Expense report reimbursement reverted", {
    reportId,
    actorId,
    employeeId: report.employeeId,
  });

  return updated;
}

async function listDecisions(reportId: string) {
  return expensesRepository.findDecisions(reportId);
}

export const expenseReportsService = {
  listReports,
  monthlySummary,
  getReportById,
  createReport,
  updateReport,
  deleteReport,
  restoreReport,
  permanentDeleteReport,
  addExpenseToReport,
  updateExpenseInReport,
  removeExpenseFromReport,
  submitReport,
  approveReport,
  rejectReport,
  markReportPayrollProcessed,
  reimburseReport,
  revertReportReimbursement,
  listDecisions,
};
