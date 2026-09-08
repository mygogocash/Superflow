import type { Prisma } from "@nexora/database";

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
  cashAdvanceApprovedEmail,
  cashAdvanceHrSummaryEmail,
  cashAdvanceRejectedEmail,
  cashAdvanceSubmittedEmail,
} from "@/infrastructure/email/templates";
import { PORTAL_URL } from "@/lib/portal-url";
import {
  cashAdvanceRepository,
  type CashAdvanceWithRelations,
} from "@/modules/cash-advance/cash-advance.repository";
import type {
  ApproveCashAdvanceInput,
  CashAdvanceQuery,
  CreateCashAdvanceInput,
  CreateCashAdvanceStepInput,
  DisburseCashAdvanceInput,
  RejectCashAdvanceInput,
  ReorderCashAdvanceStepsInput,
  UpdateCashAdvanceInput,
  UpdateCashAdvanceStepInput,
} from "@/modules/cash-advance/cash-advance.validation";
import { signReceiptUrlIfNeeded } from "@/modules/expenses/expense-shared";

const CASH_ADVANCE_NOTIFICATION_KEY = "cash-advance.notification_recipients";

async function loadCashAdvanceRecipients(): Promise<string[]> {
  const row = await prisma.systemSetting.findUnique({
    where: { key: CASH_ADVANCE_NOTIFICATION_KEY },
  });
  const value = row?.value;
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

function fmtMoney(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

interface DecisionRow {
  order: number;
  name: string;
  approverType: string;
  approverUserId: string | null;
}

// Workflow rules:
//   - Submitter owns draft / rejected rows; they can edit + delete + resubmit
//   - HR/Finance (`cash-advance:approve`) owns approval transitions
//   - `disbursed` flips when finance actually pays out
//   - `cleared` flips when receipts close the advance — analogous to the
//     existing expense reimbursement state
const EDITABLE_STATUSES = new Set(["draft", "rejected"]);

function toDTO(row: CashAdvanceWithRelations) {
  return {
    id: row.id,
    requestNumber: row.requestNumber,
    employeeId: row.employeeId,
    employee: row.employee,
    entityId: row.entityId,
    entity: row.entity ?? null,
    requestDate: row.requestDate.toISOString().slice(0, 10),
    position: row.position,
    department: row.department,
    directManager: row.directManager,
    payoutMode: row.payoutMode,
    bankName: row.bankName,
    bankCountry: row.bankCountry,
    bankAccountNo: row.bankAccountNo,
    swiftCode: row.swiftCode,
    currency: row.currency,
    status: row.status,
    currentStepOrder: row.currentStepOrder ?? null,
    approvalChain: row.approvalDecisions.map((d) => ({
      order: d.order,
      name: d.name,
      approverType: d.approverType,
      approverUser: d.approverUser ?? null,
      status: d.status,
      decidedBy: d.decidedBy ?? null,
      decidedAt: d.decidedAt?.toISOString() ?? null,
      notes: d.notes,
    })),
    requestedTotal: Number(row.requestedTotal),
    approvedTotal: Number(row.approvedTotal),
    notes: row.notes,
    rejectReason: row.rejectReason,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    approvedById: row.approvedById,
    approver: row.approver ?? null,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    disbursedAt: row.disbursedAt?.toISOString() ?? null,
    disbursementProofUrl: row.disbursementProofUrl ?? null,
    clearedAt: row.clearedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    items: row.items.map((it) => ({
      id: it.id,
      position: it.position,
      description: it.description,
      categoryId: it.categoryId ?? null,
      category: it.category
        ? { id: it.category.id, name: it.category.name }
        : null,
      requestedAmount: Number(it.requestedAmount),
      approvedAmount: Number(it.approvedAmount),
      // Raw stored URL — the View action re-signs via the receipt route.
      receiptUrl: it.receiptUrl ?? null,
    })),
  };
}

export type CashAdvanceDTO = ReturnType<typeof toDTO>;

// Loose type — zod's inferred shape for items inside a `.superRefine`
// schema has the coerced fields as optional in some TS environments.
// We only consume `requestedAmount` here, so leave the rest unsanitised.
function sumRequested(
  items: ReadonlyArray<{ requestedAmount?: number | null }>,
): number {
  return items.reduce((sum, it) => sum + Number(it.requestedAmount ?? 0), 0);
}

function canSeeAll(permissions: string[]): boolean {
  return (
    permissions.includes(PERMISSIONS.CASH_ADVANCE_READ_ALL) ||
    permissions.includes(PERMISSIONS.CASH_ADVANCE_APPROVE)
  );
}

function ensureCanRead(
  row: CashAdvanceWithRelations,
  actorId: string,
  permissions: string[],
) {
  if (row.employeeId === actorId) return;
  if (canSeeAll(permissions)) return;
  throw new ForbiddenException(
    "You do not have access to this cash advance request",
  );
}

export class CashAdvanceService {
  async list(actorId: string, permissions: string[], query: CashAdvanceQuery) {
    const where: Prisma.CashAdvanceRequestWhereInput = {};
    const wantsAll = query.scope === "all" && canSeeAll(permissions);
    if (!wantsAll) {
      where.employeeId = actorId;
    } else if (query.employeeId) {
      where.employeeId = query.employeeId;
    }
    if (query.status) where.status = query.status;

    const [rows, total] = await Promise.all([
      cashAdvanceRepository.list({
        where,
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      cashAdvanceRepository.count(where),
    ]);
    return {
      data: rows.map(toDTO),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        pages: Math.max(1, Math.ceil(total / query.limit)),
      },
    };
  }

  async getById(id: string, actorId: string, permissions: string[]) {
    const row = await cashAdvanceRepository.findById(id);
    if (!row) throw new NotFoundException("Cash advance request not found");
    ensureCanRead(row, actorId, permissions);
    return { data: toDTO(row) };
  }

  /**
   * Fresh signed URL for a line item's receipt (private bucket). Minted
   * on click so the link never outlives its Supabase JWT. Access is
   * gated by the same owner-or-read-all rule as the request itself.
   */
  async getItemReceiptUrl(
    requestId: string,
    itemId: string,
    actorId: string,
    permissions: string[],
  ): Promise<{ url: string }> {
    const row = await cashAdvanceRepository.findById(requestId);
    if (!row) throw new NotFoundException("Cash advance request not found");
    ensureCanRead(row, actorId, permissions);
    const item = row.items.find((i) => i.id === itemId);
    if (!item?.receiptUrl) {
      throw new NotFoundException("No receipt on this line item");
    }
    const signed = await signReceiptUrlIfNeeded(item.receiptUrl);
    if (!signed) throw new NotFoundException("No receipt on this line item");
    return { url: signed };
  }

  async getDisbursementProofUrl(
    requestId: string,
    actorId: string,
    permissions: string[],
  ): Promise<{ url: string }> {
    const row = await cashAdvanceRepository.findById(requestId);
    if (!row) throw new NotFoundException("Cash advance request not found");
    ensureCanRead(row, actorId, permissions);
    if (!row.disbursementProofUrl) {
      throw new NotFoundException("No disbursement proof on this request");
    }
    const signed = await signReceiptUrlIfNeeded(row.disbursementProofUrl);
    if (!signed) {
      throw new NotFoundException("No disbursement proof on this request");
    }
    return { url: signed };
  }

  async create(input: CreateCashAdvanceInput, actorId: string) {
    const requestedTotal = sumRequested(input.items);
    const row = await cashAdvanceRepository.create({
      employeeId: actorId,
      entityId: input.entityId || null,
      requestDate: input.requestDate
        ? new Date(`${input.requestDate}T00:00:00Z`)
        : new Date(),
      position: input.position ?? null,
      department: input.department ?? null,
      directManager: input.directManager ?? null,
      payoutMode: input.payoutMode,
      bankName: input.bankName ?? null,
      bankCountry: input.bankCountry ?? null,
      bankAccountNo: input.bankAccountNo ?? null,
      swiftCode: input.swiftCode ?? null,
      currency: input.currency,
      notes: input.notes ?? null,
      requestedTotal,
      items: {
        create: input.items.map((it, idx) => ({
          position: idx + 1,
          description: String(it.description ?? ""),
          requestedAmount: Number(it.requestedAmount ?? 0),
          approvedAmount: 0,
          categoryId: it.categoryId ?? null,
          receiptUrl: it.receiptUrl ?? null,
        })),
      },
    });
    return { data: toDTO(row) };
  }

  async update(id: string, input: UpdateCashAdvanceInput, actorId: string) {
    const existing = await cashAdvanceRepository.findById(id);
    if (!existing) {
      throw new NotFoundException("Cash advance request not found");
    }
    if (existing.employeeId !== actorId) {
      throw new ForbiddenException("You can only edit your own requests");
    }
    if (!EDITABLE_STATUSES.has(existing.status)) {
      throw new BadRequestException(
        `Cannot edit a request with status "${existing.status}"`,
      );
    }

    const data: Prisma.CashAdvanceRequestUncheckedUpdateInput = {};
    if (input.entityId !== undefined) data.entityId = input.entityId;
    if (input.requestDate !== undefined) {
      data.requestDate = new Date(`${input.requestDate}T00:00:00Z`);
    }
    if (input.position !== undefined) data.position = input.position;
    if (input.department !== undefined) data.department = input.department;
    if (input.directManager !== undefined) {
      data.directManager = input.directManager;
    }
    if (input.payoutMode !== undefined) data.payoutMode = input.payoutMode;
    if (input.bankName !== undefined) data.bankName = input.bankName;
    if (input.bankCountry !== undefined) data.bankCountry = input.bankCountry;
    if (input.bankAccountNo !== undefined) {
      data.bankAccountNo = input.bankAccountNo;
    }
    if (input.swiftCode !== undefined) data.swiftCode = input.swiftCode;
    if (input.currency !== undefined) data.currency = input.currency;
    if (input.notes !== undefined) data.notes = input.notes;

    if (input.items) {
      data.requestedTotal = sumRequested(input.items);
      await cashAdvanceRepository.replaceItems(
        id,
        input.items.map((it) => ({
          description: String(it.description ?? ""),
          requestedAmount: Number(it.requestedAmount ?? 0),
          approvedAmount: it.approvedAmount ?? undefined,
          categoryId: it.categoryId ?? null,
          receiptUrl: it.receiptUrl ?? null,
        })),
      );
    }
    const row = await cashAdvanceRepository.update(id, data);
    return { data: toDTO(row) };
  }

  async remove(id: string, actorId: string, permissions: string[]) {
    const existing = await cashAdvanceRepository.findById(id);
    if (!existing) {
      throw new NotFoundException("Cash advance request not found");
    }
    const isOwner = existing.employeeId === actorId;
    const isAdmin = permissions.includes(PERMISSIONS.CASH_ADVANCE_APPROVE);
    if (!isOwner && !isAdmin) {
      throw new ForbiddenException("You cannot delete this request");
    }
    if (!isAdmin && existing.status !== "draft") {
      throw new BadRequestException(
        "Only draft requests can be deleted by the requester",
      );
    }
    await cashAdvanceRepository.softDelete(id);
    return { data: { id } };
  }

  async restore(id: string, actorId: string, permissions: string[]) {
    // findById hides soft-deleted rows; a hit means it's still active.
    const active = await cashAdvanceRepository.findById(id);
    if (active) throw new ConflictException("Request is not deleted");

    const existing = await cashAdvanceRepository.findByIdIncludingDeleted(id);
    if (!existing) {
      throw new NotFoundException("Cash advance request not found");
    }

    const isOwner = existing.employeeId === actorId;
    const isAdmin = permissions.includes(PERMISSIONS.CASH_ADVANCE_APPROVE);
    if (!isOwner && !isAdmin) {
      throw new ForbiddenException("You cannot restore this request");
    }
    return cashAdvanceRepository.restore(id);
  }

  async permanentDelete(id: string, permissions: string[]) {
    // Soft-deleted rows are the normal purge target; the live finder would 404 them.
    const existing =
      await cashAdvanceRepository.findByIdIncludingDeleted(id);
    if (!existing) {
      throw new NotFoundException("Cash advance request not found");
    }
    if (!permissions.includes(PERMISSIONS.CASH_ADVANCE_APPROVE)) {
      throw new ForbiddenException(
        "Only approvers can permanently delete cash advance requests",
      );
    }
    return cashAdvanceRepository.permanentDelete(id);
  }

  async submit(id: string, actorId: string) {
    const existing = await cashAdvanceRepository.findById(id);
    if (!existing) {
      throw new NotFoundException("Cash advance request not found");
    }
    if (existing.employeeId !== actorId) {
      throw new ForbiddenException("You can only submit your own request");
    }
    if (!EDITABLE_STATUSES.has(existing.status)) {
      throw new BadRequestException(
        `Cannot submit a request with status "${existing.status}"`,
      );
    }
    if (existing.items.length === 0) {
      throw new BadRequestException(
        "Add at least one line item before submitting",
      );
    }
    // Snapshot the active approval chain into per-request decision rows.
    // Each step's conditions are evaluated against THIS request: amount
    // band (vs requestedTotal in the request's own currency), submitter
    // skip/only-when, and payout-mode filter. Empty chain → single
    // manager step (employee.reportingTo) so the legacy flow still works.
    const decisionRows = await this.buildDecisionRows(existing, actorId);
    await prisma.cashAdvanceApprovalDecision.deleteMany({
      where: { requestId: id },
    });
    await cashAdvanceRepository.createDecisions(id, decisionRows);

    const row = await cashAdvanceRepository.update(id, {
      status: "submitted",
      submittedAt: new Date(),
      rejectReason: null,
      currentStepOrder: 1,
    });
    logger.info(`Cash advance CA-${row.requestNumber} submitted by ${actorId}`);

    await this.notifyApprover(decisionRows[0]!, row);
    return { data: toDTO(row) };
  }

  // Pull a submitted request back to draft so the owner can edit + resubmit.
  // Per product decision the owner may unsubmit any time while it is still
  // "submitted" — any partial approvals are discarded (the snapshot decision
  // rows are deleted and the chain is rebuilt on the next submit).
  async withdraw(id: string, actorId: string) {
    const existing = await cashAdvanceRepository.findById(id);
    if (!existing) {
      throw new NotFoundException("Cash advance request not found");
    }
    if (existing.employeeId !== actorId) {
      throw new ForbiddenException("You can only unsubmit your own request");
    }
    if (existing.status !== "submitted") {
      throw new BadRequestException(
        `Only submitted requests can be unsubmitted (status is "${existing.status}")`,
      );
    }
    await prisma.cashAdvanceApprovalDecision.deleteMany({
      where: { requestId: id },
    });
    const row = await cashAdvanceRepository.update(id, {
      status: "draft",
      submittedAt: null,
      currentStepOrder: null,
      rejectReason: null,
    });
    logger.info(
      `Cash advance CA-${row.requestNumber} unsubmitted by ${actorId}`,
    );
    return { data: toDTO(row) };
  }

  // Resolve which configured steps apply to this request + snapshot them
  // as ordered decision rows. Manager steps resolve to the submitter's
  // reportingTo at action time, so the snapshot keeps approverType.
  private async buildDecisionRows(
    request: CashAdvanceWithRelations,
    submitterId: string,
  ): Promise<DecisionRow[]> {
    const steps = await cashAdvanceRepository.findApprovalSteps({
      activeOnly: true,
    });
    const requested = Number(request.requestedTotal);
    const applicable = steps.filter((s) => {
      const skip = Array.isArray(s.skipWhenSubmitterIds)
        ? (s.skipWhenSubmitterIds as string[])
        : [];
      if (skip.includes(submitterId)) return false;
      const only = Array.isArray(s.onlyWhenSubmitterIds)
        ? (s.onlyWhenSubmitterIds as string[])
        : [];
      if (only.length > 0 && !only.includes(submitterId)) return false;
      const modes = Array.isArray(s.payoutModeFilter)
        ? (s.payoutModeFilter as string[])
        : [];
      if (modes.length > 0 && !modes.includes(request.payoutMode)) return false;
      // Amount band — compared against requestedTotal in the request's
      // own currency (per product decision; most advances are THB).
      if (s.amountMin != null && requested < Number(s.amountMin)) return false;
      if (s.amountMax != null && requested > Number(s.amountMax)) return false;
      return true;
    });

    const rows: DecisionRow[] =
      applicable.length > 0
        ? applicable.map((s, idx) => ({
            order: idx + 1,
            name: s.name,
            approverType: s.approverType,
            approverUserId: s.approverType === "user" ? s.approverUserId : null,
          }))
        : [
            {
              order: 1,
              name: "Manager approval",
              approverType: "manager",
              approverUserId: null,
            },
          ];
    return rows;
  }

  // Email the approver for a given decision step. Manager steps resolve
  // to the requester's reportingTo; user steps to the assigned user.
  private async notifyApprover(
    decision: DecisionRow,
    request: CashAdvanceWithRelations,
  ) {
    let email: string | undefined;
    let name: string | undefined;
    if (decision.approverType === "user" && decision.approverUserId) {
      const u = await cashAdvanceRepository.findUserById(
        decision.approverUserId,
      );
      email = u?.email ?? undefined;
      name = u?.name;
    } else if (decision.approverType === "manager") {
      const emp = await cashAdvanceRepository.findUserById(request.employeeId);
      if (emp?.reportingTo) {
        const mgr = await cashAdvanceRepository.findUserById(emp.reportingTo);
        email = mgr?.email ?? undefined;
        name = mgr?.name;
      }
    }
    if (!email) return;
    const mail = cashAdvanceSubmittedEmail({
      approverName: name ?? "Approver",
      employeeName: request.employee.name,
      requestCode: `CA-${request.requestNumber}`,
      amount: fmtMoney(Number(request.requestedTotal), request.currency),
      stepName: decision.name,
      portalUrl: `${PORTAL_URL}/cash-advance`,
    });
    void sendEmail({ to: email, ...mail });
  }

  // HR with cash-advance:approve can act on any step; a user step needs
  // the assigned user; a manager step needs the requester's reportingTo.
  private async assertCanActOnStep(
    decision: { approverType: string; approverUserId: string | null },
    request: CashAdvanceWithRelations,
    actorId: string,
    permissions: string[],
  ) {
    if (permissions.includes(PERMISSIONS.CASH_ADVANCE_APPROVE)) return;
    if (decision.approverType === "user") {
      if (decision.approverUserId !== actorId) {
        throw new ForbiddenException(
          "This step is assigned to a different approver",
        );
      }
      return;
    }
    const emp = await cashAdvanceRepository.findUserById(request.employeeId);
    if (emp?.reportingTo !== actorId) {
      throw new ForbiddenException(
        "Only the employee's direct manager can approve this step",
      );
    }
  }

  async approve(
    id: string,
    input: ApproveCashAdvanceInput,
    actorId: string,
    permissions: string[],
  ) {
    const existing = await cashAdvanceRepository.findById(id);
    if (!existing) {
      throw new NotFoundException("Cash advance request not found");
    }
    if (existing.status !== "submitted") {
      throw new BadRequestException(
        `Can only approve a submitted request (current: ${existing.status})`,
      );
    }

    // Backfill a manager-only chain for legacy rows submitted before the
    // chain shipped (no decisions / no currentStepOrder).
    let decisions = await cashAdvanceRepository.findDecisions(id);
    if (decisions.length === 0) {
      await cashAdvanceRepository.createDecisions(id, [
        {
          order: 1,
          name: "Manager approval",
          approverType: "manager",
          approverUserId: null,
        },
      ]);
      await cashAdvanceRepository.update(id, { currentStepOrder: 1 });
      decisions = await cashAdvanceRepository.findDecisions(id);
    }
    const stepOrder = existing.currentStepOrder ?? 1;
    const decision = decisions.find((d) => d.order === stepOrder);
    if (!decision || decision.status !== "pending") {
      throw new BadRequestException(
        "Current approval step is already decided — refresh and try again",
      );
    }

    await this.assertCanActOnStep(decision, existing, actorId, permissions);

    // Optional per-line approved amounts (any step may set/adjust them).
    if (input.items && input.items.length > 0) {
      const itemsById = new Map(existing.items.map((it) => [it.id, it]));
      for (const it of input.items) {
        if (!itemsById.has(it.id)) {
          throw new BadRequestException(`Unknown item id ${it.id}`);
        }
      }
      await prisma.$transaction(
        input.items.map((it) =>
          prisma.cashAdvanceItem.update({
            where: { id: it.id },
            data: { approvedAmount: it.approvedAmount },
          }),
        ),
      );
    }

    await cashAdvanceRepository.updateDecision(decision.id, {
      status: "approved",
      decidedById: actorId,
      decidedAt: new Date(),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    });

    const next = decisions.find(
      (d) => d.order > decision.order && d.status === "pending",
    );
    if (next) {
      const row = await cashAdvanceRepository.update(id, {
        currentStepOrder: next.order,
      });
      await this.notifyApprover(
        {
          order: next.order,
          name: next.name,
          approverType: next.approverType,
          approverUserId: next.approverUserId,
        },
        row,
      );
      logger.info(
        `Cash advance CA-${row.requestNumber} step ${decision.order} approved by ${actorId}; advanced to ${next.order}`,
      );
      return { data: toDTO(row) };
    }

    // No more pending steps → finalise. approvedTotal = sum of per-line
    // approved amounts if any were set, else fall back to requestedTotal.
    const fresh = await cashAdvanceRepository.findById(id);
    const itemSum = (fresh?.items ?? []).reduce(
      (s, it) => s + Number(it.approvedAmount),
      0,
    );
    const approvedTotal =
      itemSum > 0 ? itemSum : Number(existing.requestedTotal);
    const row = await cashAdvanceRepository.update(id, {
      status: "approved",
      approvedTotal,
      approvedById: actorId,
      approvedAt: new Date(),
      rejectReason: null,
    });
    logger.info(`Cash advance CA-${row.requestNumber} fully approved`);

    // Notify the employee + the HR/finance recipients (to disburse).
    const approvedMail = cashAdvanceApprovedEmail({
      employeeName: row.employee.name,
      requestCode: `CA-${row.requestNumber}`,
      approvedAmount: fmtMoney(approvedTotal, row.currency),
      portalUrl: `${PORTAL_URL}/cash-advance`,
    });
    void sendEmail({ to: row.employee.email, ...approvedMail });
    try {
      const recipients = await loadCashAdvanceRecipients();
      if (recipients.length > 0) {
        const hrMail = cashAdvanceHrSummaryEmail({
          employeeName: row.employee.name,
          requestCode: `CA-${row.requestNumber}`,
          approvedAmount: fmtMoney(approvedTotal, row.currency),
          payoutMode: row.payoutMode,
          bankName: row.bankName,
          bankAccountNo: row.bankAccountNo,
          bankCountry: row.bankCountry,
          swiftCode: row.swiftCode,
          notes: row.notes,
          portalUrl: `${PORTAL_URL}/cash-advance`,
        });
        void sendEmail({ to: recipients, ...hrMail });
      }
    } catch {
      // A recipient-notification failure must not roll back the approval.
    }
    return { data: toDTO(row) };
  }

  async reject(
    id: string,
    input: RejectCashAdvanceInput,
    actorId: string,
    permissions: string[],
  ) {
    const existing = await cashAdvanceRepository.findById(id);
    if (!existing) {
      throw new NotFoundException("Cash advance request not found");
    }
    if (existing.status !== "submitted") {
      throw new BadRequestException(
        `Can only reject a submitted request (current: ${existing.status})`,
      );
    }
    const decisions = await cashAdvanceRepository.findDecisions(id);
    const stepOrder = existing.currentStepOrder ?? 1;
    const decision = decisions.find((d) => d.order === stepOrder);
    // Legacy rows (no decisions) → only HR/Finance can reject.
    if (decision) {
      await this.assertCanActOnStep(decision, existing, actorId, permissions);
      await cashAdvanceRepository.updateDecision(decision.id, {
        status: "rejected",
        decidedById: actorId,
        decidedAt: new Date(),
        notes: input.reason,
      });
    } else if (!permissions.includes(PERMISSIONS.CASH_ADVANCE_APPROVE)) {
      throw new ForbiddenException("Approve permission required");
    }

    const row = await cashAdvanceRepository.update(id, {
      status: "rejected",
      rejectReason: input.reason,
      approvedById: actorId,
      approvedAt: new Date(),
    });
    logger.info(`Cash advance CA-${row.requestNumber} rejected by ${actorId}`);

    const approver = await cashAdvanceRepository.findUserById(actorId);
    const mail = cashAdvanceRejectedEmail({
      employeeName: row.employee.name,
      requestCode: `CA-${row.requestNumber}`,
      approverName: approver?.name ?? "Approver",
      reason: input.reason,
      portalUrl: `${PORTAL_URL}/cash-advance`,
    });
    void sendEmail({ to: row.employee.email, ...mail });
    return { data: toDTO(row) };
  }

  // ── Approval-chain config (gated on cash-advance:approve at the route) ──
  async listSteps() {
    return cashAdvanceRepository.findApprovalSteps();
  }

  async createStep(input: CreateCashAdvanceStepInput) {
    const order = (await cashAdvanceRepository.maxStepOrder()) + 1;
    return cashAdvanceRepository.createStep({
      order,
      name: input.name,
      description: input.description ?? null,
      approverType: input.approverType,
      approverUserId:
        input.approverType === "user" ? (input.approverUserId ?? null) : null,
      skipWhenSubmitterIds: input.skipWhenSubmitterIds,
      onlyWhenSubmitterIds: input.onlyWhenSubmitterIds,
      payoutModeFilter: input.payoutModeFilter,
      amountMin: input.amountMin ?? null,
      amountMax: input.amountMax ?? null,
      isActive: input.isActive,
    });
  }

  async updateStep(id: string, input: UpdateCashAdvanceStepInput) {
    const existing = await cashAdvanceRepository.findStepById(id);
    if (!existing) throw new NotFoundException("Approval step not found");
    return cashAdvanceRepository.updateStep(id, {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && {
        description: input.description,
      }),
      ...(input.approverType !== undefined && {
        approverType: input.approverType,
        approverUserId:
          input.approverType === "user"
            ? (input.approverUserId ?? existing.approverUserId)
            : null,
      }),
      ...(input.approverType === undefined &&
        input.approverUserId !== undefined && {
          approverUserId: input.approverUserId,
        }),
      ...(input.skipWhenSubmitterIds !== undefined && {
        skipWhenSubmitterIds: input.skipWhenSubmitterIds,
      }),
      ...(input.onlyWhenSubmitterIds !== undefined && {
        onlyWhenSubmitterIds: input.onlyWhenSubmitterIds,
      }),
      ...(input.payoutModeFilter !== undefined && {
        payoutModeFilter: input.payoutModeFilter,
      }),
      ...(input.amountMin !== undefined && { amountMin: input.amountMin }),
      ...(input.amountMax !== undefined && { amountMax: input.amountMax }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
    });
  }

  async deleteStep(id: string) {
    const existing = await cashAdvanceRepository.findStepById(id);
    if (!existing) throw new NotFoundException("Approval step not found");
    await cashAdvanceRepository.deleteStep(id);
    return { success: true };
  }

  async reorderSteps(input: ReorderCashAdvanceStepsInput) {
    await cashAdvanceRepository.reorderSteps(input.orderedIds);
    return cashAdvanceRepository.findApprovalSteps();
  }

  async getRecipients() {
    return { emails: await loadCashAdvanceRecipients() };
  }

  async setRecipients(emails: string[]) {
    await prisma.systemSetting.upsert({
      where: { key: CASH_ADVANCE_NOTIFICATION_KEY },
      create: { key: CASH_ADVANCE_NOTIFICATION_KEY, value: emails },
      update: { value: emails },
    });
    return { emails };
  }

  async markDisbursed(
    id: string,
    input: DisburseCashAdvanceInput,
    actorId: string,
    permissions: string[],
  ) {
    if (!permissions.includes(PERMISSIONS.CASH_ADVANCE_APPROVE)) {
      throw new ForbiddenException("Approve permission required");
    }
    const existing = await cashAdvanceRepository.findById(id);
    if (!existing) {
      throw new NotFoundException("Cash advance request not found");
    }
    if (existing.status !== "approved") {
      throw new BadRequestException(
        `Only approved requests can be marked disbursed (current: ${existing.status})`,
      );
    }
    const row = await cashAdvanceRepository.update(id, {
      status: "disbursed",
      disbursedAt: new Date(),
      disbursementProofUrl: input.proofUrl,
    });
    logger.info(`Cash advance CA-${row.requestNumber} disbursed by ${actorId}`);
    return { data: toDTO(row) };
  }

  async markCleared(id: string, actorId: string, permissions: string[]) {
    if (!permissions.includes(PERMISSIONS.CASH_ADVANCE_APPROVE)) {
      throw new ForbiddenException("Approve permission required");
    }
    const existing = await cashAdvanceRepository.findById(id);
    if (!existing) {
      throw new NotFoundException("Cash advance request not found");
    }
    if (existing.status !== "disbursed") {
      throw new BadRequestException(
        `Only disbursed requests can be cleared (current: ${existing.status})`,
      );
    }
    const row = await cashAdvanceRepository.update(id, {
      status: "cleared",
      clearedAt: new Date(),
    });
    logger.info(`Cash advance CA-${row.requestNumber} cleared by ${actorId}`);
    return { data: toDTO(row) };
  }
}

export const cashAdvanceService = new CashAdvanceService();
