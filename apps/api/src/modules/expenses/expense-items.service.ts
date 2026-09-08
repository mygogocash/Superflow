/**
 * Expense item (line-item) CRUD and individual-item approval workflow.
 * One expense = one receipt row; reports batch multiple items together.
 */

import * as XLSX from "xlsx";

import { PERMISSIONS } from "@/common/constants/permissions";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@/common/exceptions/http-exception";
import {
  buildUserScopeFilter,
  resolveDataScope,
} from "@/common/utils/data-scope";
import { prisma } from "@/infrastructure/database/prisma";
import { sendEmail } from "@/infrastructure/email/email.service";
import {
  expenseApprovedEmail,
  expenseReimbursedEmail,
  expenseRejectedEmail,
  expenseSubmittedEmail,
} from "@/infrastructure/email/templates";
import {
  createSignedUrl,
  parseStorageUrl,
} from "@/infrastructure/storage/supabase-storage";
import {
  actorFromId,
  trackExpenseApproved,
  trackExpenseSubmittedServer,
} from "@/lib/events";
import { PORTAL_URL } from "@/lib/portal-url";
import { fmtAmount, PRIVATE_BUCKETS } from "@/modules/expenses/expense-shared";
import { expensesRepository } from "@/modules/expenses/expenses.repository";
import type {
  CreateExpenseInput,
  ExpenseQuery,
  UpdateExpenseInput,
} from "@/modules/expenses/expenses.validation";

/** Active entities for expense forms (no admin:read required). */
async function listActiveEntitiesForForms() {
  return prisma.entity.findMany({
    where: { isActive: true },
    select: {
      id: true,
      name: true,
      code: true,
      country: true,
      currency: true,
    },
    orderBy: { name: "asc" },
  });
}

async function listExpenses(
  userId: string,
  userPermissions: string[],
  query: ExpenseQuery,
) {
  const { page, limit, ...filters } = query;
  const scope = await resolveDataScope(userId, userPermissions);

  let scopeUserIds: string[] | undefined;
  if (scope === "self") {
    filters.employeeId = userId;
  } else if (scope === "team") {
    const teamFilter = await buildUserScopeFilter(userId, scope, "employeeId");
    const val = teamFilter.employeeId;
    if (
      val &&
      typeof val === "object" &&
      "in" in (val as Record<string, unknown>)
    ) {
      scopeUserIds = (val as { in: string[] }).in;
    }
  }

  const { data, total } = await expensesRepository.findExpenses(
    filters,
    page,
    limit,
    scopeUserIds,
  );

  return {
    data,
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

async function getExpenseById(
  id: string,
  userId: string,
  userPermissions: string[],
) {
  const expense = await expensesRepository.findExpenseById(id);
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
async function getExpenseReceiptUrl(
  expenseId: string,
  userId: string,
  userPermissions: string[],
): Promise<{ url: string }> {
  const expense = await expensesRepository.findExpenseById(expenseId);
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

  const parsed = parseStorageUrl(expense.receiptUrl);
  if (!parsed) {
    // Historical rows that wrote a non-Supabase URL — hand it back as-is.
    return { url: expense.receiptUrl };
  }
  if (!PRIVATE_BUCKETS.has(parsed.bucket)) {
    // Public bucket — the raw URL works directly.
    return { url: expense.receiptUrl };
  }

  // 5-minute TTL — gives slack for slow networks and popup-blocker
  // fallback clicks while staying well below the 24 h list-response TTL.
  const url = await createSignedUrl(parsed.bucket, parsed.path, 300);
  return { url };
}

async function createExpense(userId: string, input: CreateExpenseInput) {
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

  if (input.travelRequestId) {
    const travel = await prisma.travelRequest.findUnique({
      where: { id: input.travelRequestId },
      select: { id: true, employeeId: true },
    });
    if (!travel) {
      throw new BadRequestException("Linked travel request not found");
    }
    if (travel.employeeId !== userId) {
      throw new ForbiddenException(
        "You can only link expenses to your own travel requests",
      );
    }
  }

  const created = await expensesRepository.createExpense({
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

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, reportingTo: true },
  });
  if (user?.reportingTo) {
    const manager = await prisma.user.findUnique({
      where: { id: user.reportingTo },
      select: { name: true, email: true },
    });
    if (manager?.email) {
      const email = expenseSubmittedEmail({
        approverName: manager.name,
        employeeName: user.name,
        title: input.description,
        amount: fmtAmount(input.amount, input.currency),
        category: created.category?.name ?? "Uncategorized",
        portalUrl: `${PORTAL_URL}/expenses`,
      });
      void sendEmail({ to: manager.email, ...email });
    }
  }

  try {
    const trackingActor = await actorFromId(userId);
    if (trackingActor) {
      let amountThb = input.amount;
      if (input.currency !== "THB") {
        const fx = await expensesRepository.convertAmount(
          input.amount,
          input.currency,
          "THB",
        );
        amountThb = fx?.converted ?? 0;
      }
      trackExpenseSubmittedServer(trackingActor, {
        amount_thb: amountThb,
        category: created.category?.name ?? "uncategorized",
        has_receipt: Boolean(input.receiptUrl),
      });
    }
  } catch {
    // analytics is best-effort
  }

  return created;
}

async function updateExpense(
  expenseId: string,
  userId: string,
  input: UpdateExpenseInput,
) {
  const expense = await expensesRepository.findExpenseById(expenseId);
  if (!expense) throw new NotFoundException("Expense not found");
  if (expense.employeeId !== userId) {
    throw new ForbiddenException("You can only update your own expenses");
  }
  if (expense.status !== "pending") {
    throw new BadRequestException(
      `Cannot update an expense with status "${expense.status}"`,
    );
  }

  return expensesRepository.updateExpense(expenseId, {
    ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
    ...(input.description !== undefined && { description: input.description }),
    ...(input.amount !== undefined && { amount: input.amount }),
    ...(input.currency !== undefined && { currency: input.currency }),
    ...(input.date !== undefined && { date: new Date(input.date) }),
    ...(input.receiptUrl !== undefined && { receiptUrl: input.receiptUrl }),
    ...(input.notes !== undefined && { notes: input.notes }),
  });
}

async function deleteExpense(expenseId: string, userId: string) {
  const expense = await expensesRepository.findExpenseById(expenseId);
  if (!expense) throw new NotFoundException("Expense not found");
  if (expense.employeeId !== userId) {
    throw new ForbiddenException("You can only delete your own expenses");
  }
  if (expense.status !== "pending") {
    throw new BadRequestException(
      `Cannot delete an expense with status "${expense.status}"`,
    );
  }

  return expensesRepository.softDeleteExpense(expenseId);
}

async function restoreExpense(
  expenseId: string,
  userId: string,
  permissions: string[],
) {
  // findExpenseById hides soft-deleted rows; a hit means it's still active.
  const active = await expensesRepository.findExpenseById(expenseId);
  if (active) throw new ConflictException("Expense is not deleted");

  const expense =
    await expensesRepository.findExpenseByIdIncludingDeleted(expenseId);
  if (!expense) throw new NotFoundException("Expense not found");

  const isHr = permissions.includes(PERMISSIONS.EXPENSE_HR_DELETE);
  if (!isHr && expense.employeeId !== userId) {
    throw new ForbiddenException("You can only restore your own expenses");
  }
  return expensesRepository.restoreExpense(expenseId);
}

async function permanentDeleteExpense(
  expenseId: string,
  permissions: string[],
) {
  // Soft-deleted rows are the normal purge target; the live finder would 404 them.
  const expense =
    await expensesRepository.findExpenseByIdIncludingDeleted(expenseId);
  if (!expense) {
    throw new NotFoundException("Expense not found");
  }
  if (!permissions.includes(PERMISSIONS.EXPENSE_HR_DELETE)) {
    throw new ForbiddenException("Only HR can permanently delete expenses");
  }
  return expensesRepository.permanentDeleteExpense(expenseId);
}

async function approveExpense(expenseId: string, approverId: string) {
  const expense = await expensesRepository.findExpenseById(expenseId);
  if (!expense) throw new NotFoundException("Expense not found");
  if (expense.status !== "pending") {
    throw new BadRequestException(
      `Cannot approve an expense with status "${expense.status}"`,
    );
  }

  const result = await expensesRepository.updateExpenseStatus(expenseId, {
    status: "approved",
    approvedBy: approverId,
    approvedAt: new Date(),
  });

  const approver = await prisma.user.findUnique({
    where: { id: approverId },
    select: { name: true },
  });
  const email = expenseApprovedEmail({
    employeeName: expense.employee.name,
    title: expense.description,
    amount: fmtAmount(Number(expense.amount), expense.currency),
    approverName: approver?.name ?? "Your Manager",
    portalUrl: `${PORTAL_URL}/expenses`,
  });
  void sendEmail({ to: expense.employee.email, ...email });

  try {
    const trackingActor = await actorFromId(approverId);
    if (trackingActor) {
      trackExpenseApproved(trackingActor);
    }
  } catch {
    // analytics is best-effort
  }

  return result;
}

async function rejectExpense(
  expenseId: string,
  approverId: string,
  reason: string,
) {
  const expense = await expensesRepository.findExpenseById(expenseId);
  if (!expense) throw new NotFoundException("Expense not found");
  if (expense.status !== "pending") {
    throw new BadRequestException(
      `Cannot reject an expense with status "${expense.status}"`,
    );
  }

  const result = await expensesRepository.updateExpenseStatus(expenseId, {
    status: "rejected",
    approvedBy: approverId,
    approvedAt: new Date(),
    rejectReason: reason,
  });

  const approver = await prisma.user.findUnique({
    where: { id: approverId },
    select: { name: true },
  });
  const email = expenseRejectedEmail({
    employeeName: expense.employee.name,
    title: expense.description,
    amount: fmtAmount(Number(expense.amount), expense.currency),
    approverName: approver?.name ?? "Your Manager",
    rejectionReason: reason,
    portalUrl: `${PORTAL_URL}/expenses`,
  });
  void sendEmail({ to: expense.employee.email, ...email });

  return result;
}

async function reimburseExpense(expenseId: string, actorId: string) {
  const expense = await expensesRepository.findExpenseById(expenseId);
  if (!expense) throw new NotFoundException("Expense not found");
  if (expense.status !== "approved") {
    throw new BadRequestException(
      `Cannot reimburse an expense with status "${expense.status}"`,
    );
  }

  const result = await expensesRepository.updateExpenseStatus(expenseId, {
    status: "reimbursed",
    approvedBy: actorId,
    approvedAt: new Date(),
  });

  await prisma.expense.update({
    where: { id: expenseId },
    data: { reimbursedAt: new Date() },
  });

  const email = expenseReimbursedEmail({
    employeeName: expense.employee.name,
    title: expense.description,
    amount: fmtAmount(Number(expense.amount), expense.currency),
    portalUrl: `${PORTAL_URL}/expenses`,
  });
  void sendEmail({ to: expense.employee.email, ...email });

  return result;
}

async function exportExpensesXlsx(
  query: Parameters<typeof expensesRepository.findAllExpenses>[0],
) {
  const expenses = await expensesRepository.findAllExpenses(query);

  const rows = expenses.map((e) => ({
    ID: e.id,
    Employee: e.employee.name,
    Email: e.employee.email,
    Department: e.employee.department ?? "",
    Entity: e.entity?.name ?? "",
    Category: e.category?.name ?? "",
    Description: e.description,
    Amount: Number(e.amount),
    Currency: e.currency,
    Date: e.date.toISOString().slice(0, 10),
    Status: e.status,
    Approver: e.approver?.name ?? "",
    "Approved At": e.approvedAt?.toISOString() ?? "",
    "Reject Reason": e.rejectReason ?? "",
    "Reimbursed At": e.reimbursedAt?.toISOString() ?? "",
    Notes: e.notes ?? "",
    "Created At": e.createdAt.toISOString(),
  }));

  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Expenses");
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

export const expenseItemsService = {
  listActiveEntitiesForForms,
  listExpenses,
  getExpenseById,
  getExpenseReceiptUrl,
  createExpense,
  updateExpense,
  deleteExpense,
  restoreExpense,
  permanentDeleteExpense,
  approveExpense,
  rejectExpense,
  reimburseExpense,
  exportExpensesXlsx,
};
