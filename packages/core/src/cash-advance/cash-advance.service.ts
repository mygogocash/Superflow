import { PERMISSIONS } from "@nexora/contracts";
import type { Db } from "@nexora/db";
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
} from "@nexora/contracts/modules/cash-advance/cash-advance.validation";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "../http-exception";
import { getSetting, upsertSetting } from "../survey/system-settings.repository";
import * as repo from "./cash-advance.repository";
import type { CashAdvanceWithRelations } from "./cash-advance.repository";

const CASH_ADVANCE_NOTIFICATION_KEY = "cash-advance.notification_recipients";

// TODO: wire Resend when edge email infra lands
async function sendEmail(_opts: { to: string | string[]; subject?: string }): Promise<void> {}

// TODO: R2 signed URL for private receipt downloads
async function signReceiptUrlIfNeeded(url: string): Promise<string | null> {
  return url;
}

async function loadCashAdvanceRecipients(db: Db): Promise<string[]> {
  const value = await getSetting(db, CASH_ADVANCE_NOTIFICATION_KEY);
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
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
    requestDate: String(row.requestDate).slice(0, 10),
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
      decidedAt: d.decidedAt ?? null,
      notes: d.notes,
    })),
    requestedTotal: Number(row.requestedTotal),
    approvedTotal: Number(row.approvedTotal),
    notes: row.notes,
    rejectReason: row.rejectReason,
    submittedAt: row.submittedAt ?? null,
    approvedBy: row.approvedBy ?? null,
    approver: row.approver ?? null,
    approvedAt: row.approvedAt ?? null,
    disbursedAt: row.disbursedAt ?? null,
    disbursementProofUrl: row.disbursementProofUrl ?? null,
    clearedAt: row.clearedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
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


export async function list(db: Db, actorId: string, permissions: string[], query: CashAdvanceQuery) {
  const wantsAll = query.scope === "all" && canSeeAll(permissions);
  const filters: { employeeId?: string; status?: string } = {};
  if (!wantsAll) {
    filters.employeeId = actorId;
  } else if (query.employeeId) {
    filters.employeeId = query.employeeId;
  }
  if (query.status) filters.status = query.status;

  const skip = (query.page - 1) * query.limit;
  const { data: rows, total } = await repo.list(db, filters, skip, query.limit);
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

export async function getById(db: Db, id: string, actorId: string, permissions: string[]) {
  const row = await repo.findById(db, id);
  if (!row) throw new NotFoundException("Cash advance request not found");
  ensureCanRead(row, actorId, permissions);
  if (!row) throw new NotFoundException("Cash advance request not found");
  return { data: toDTO(row) };
}

/**
 * Fresh signed URL for a line item's receipt (private bucket). Minted
 * on click so the link never outlives its Supabase JWT. Access is
 * gated by the same owner-or-read-all rule as the request itself.
 */
export async function getItemReceiptUrl(db: Db, 
  requestId: string,
  itemId: string,
  actorId: string,
  permissions: string[],
): Promise<{ url: string }> {
  const row = await repo.findById(db, requestId);
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

export async function getDisbursementProofUrl(db: Db, 
  requestId: string,
  actorId: string,
  permissions: string[],
): Promise<{ url: string }> {
  const row = await repo.findById(db, requestId);
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

export async function create(db: Db, input: CreateCashAdvanceInput, actorId: string) {
  const requestedTotal = sumRequested(input.items);
  const row = await repo.create(db, {
    employeeId: actorId,
    entityId: input.entityId || null,
    requestDate: input.requestDate ?? new Date().toISOString().slice(0, 10),
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
    items: input.items.map((it) => ({
      description: String(it.description ?? ""),
      requestedAmount: Number(it.requestedAmount ?? 0),
      approvedAmount: 0,
      categoryId: it.categoryId ?? null,
      receiptUrl: it.receiptUrl ?? null,
    })),
  });
  if (!row) throw new NotFoundException("Cash advance request not found");
  return { data: toDTO(row) };
}

export async function update(db: Db, id: string, input: UpdateCashAdvanceInput, actorId: string) {
  const existing = await repo.findById(db, id);
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

  const data: Parameters<typeof repo.update>[2] = {};
  if (input.entityId !== undefined) data.entityId = input.entityId;
  if (input.requestDate !== undefined) {
    data.requestDate = input.requestDate;
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
    await repo.replaceItems(db, 
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
  const row = await repo.update(db, id, data);
  if (!row) throw new NotFoundException("Cash advance request not found");
  return { data: toDTO(row) };
}

export async function remove(db: Db, id: string, actorId: string, permissions: string[]) {
  const existing = await repo.findById(db, id);
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
  await repo.softDelete(db, id);
  return { data: { id } };
}

export async function restore(db: Db, id: string, actorId: string, permissions: string[]) {
  // findById hides soft-deleted rows; a hit means it's still active.
  const active = await repo.findById(db, id);
  if (active) throw new ConflictException("Request is not deleted");

  const existing = await repo.findByIdIncludingDeleted(db, id);
  if (!existing) {
    throw new NotFoundException("Cash advance request not found");
  }

  const isOwner = existing.employeeId === actorId;
  const isAdmin = permissions.includes(PERMISSIONS.CASH_ADVANCE_APPROVE);
  if (!isOwner && !isAdmin) {
    throw new ForbiddenException("You cannot restore this request");
  }
  return repo.restore(db, id);
}

export async function permanentDelete(
  db: Db,
  id: string,
  permissions: string[],
) {
  // Soft-deleted rows are the normal purge target; the live finder would 404 them.
  const existing = await repo.findByIdIncludingDeleted(db, id);
  if (!existing) {
    throw new NotFoundException("Cash advance request not found");
  }
  if (!permissions.includes(PERMISSIONS.CASH_ADVANCE_APPROVE)) {
    throw new ForbiddenException(
      "Only approvers can permanently delete cash advance requests",
    );
  }
  return repo.permanentDelete(db, id);
}

export async function submit(db: Db, id: string, actorId: string) {
  const existing = await repo.findById(db, id);
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
  const decisionRows = await buildDecisionRows(db, existing, actorId);
  await repo.deleteDecisions(db, id);
  await repo.createDecisions(db, id, decisionRows);

  const row = await repo.update(db, id, {
    status: "submitted",
    submittedAt: new Date().toISOString(),
    rejectReason: null,
    currentStepOrder: 1,
  });
  if (!row) throw new NotFoundException("Cash advance request not found");
  console.info(JSON.stringify({ level: 'info', msg: `Cash advance CA-${row.requestNumber} submitted by ${actorId}` }));

  await notifyApprover(db, decisionRows[0]!, row);
  return { data: toDTO(row) };
}

// Pull a submitted request back to draft so the owner can edit + resubmit.
// Per product decision the owner may unsubmit any time while it is still
// "submitted" — any partial approvals are discarded (the snapshot decision
// rows are deleted and the chain is rebuilt on the next submit).
export async function withdraw(db: Db, id: string, actorId: string) {
  const existing = await repo.findById(db, id);
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
  await repo.deleteDecisions(db, id);
  const row = await repo.update(db, id, {
    status: "draft",
    submittedAt: null,
    currentStepOrder: null,
    rejectReason: null,
  });
  if (!row) throw new NotFoundException("Cash advance request not found");
  console.info(JSON.stringify({ level: 'info', msg: 
    `Cash advance CA-${row.requestNumber} unsubmitted by ${actorId}`,
   }));
  return { data: toDTO(row) };
}

// Resolve which configured steps apply to this request + snapshot them
// as ordered decision rows. Manager steps resolve to the submitter's
// reportingTo at action time, so the snapshot keeps approverType.
async function buildDecisionRows(db: Db, request: CashAdvanceWithRelations,
  submitterId: string,
): Promise<DecisionRow[]> {
  const steps = await repo.findApprovalSteps(db, {
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
async function notifyApprover(db: Db, decision: DecisionRow,
  request: CashAdvanceWithRelations,
) {
  let email: string | undefined;
  let name: string | undefined;
  if (decision.approverType === "user" && decision.approverUserId) {
    const u = await repo.findUserById(db, 
      decision.approverUserId,
    );
    email = u?.email ?? undefined;
    name = u?.name;
  } else if (decision.approverType === "manager") {
    const emp = await repo.findUserById(db, request.employeeId);
    if (emp?.reportingTo) {
      const mgr = await repo.findUserById(db, emp.reportingTo);
      email = mgr?.email ?? undefined;
      name = mgr?.name;
    }
  }
  if (!email) return;
  void sendEmail({ to: email, subject: "Cash advance submitted" });
}

// HR with cash-advance:approve can act on any step; a user step needs
// the assigned user; a manager step needs the requester's reportingTo.
async function assertCanActOnStep(db: Db, decision: { approverType: string; approverUserId: string | null },
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
  const emp = await repo.findUserById(db, request.employeeId);
  if (emp?.reportingTo !== actorId) {
    throw new ForbiddenException(
      "Only the employee's direct manager can approve this step",
    );
  }
}

export async function approve(db: Db, 
  id: string,
  input: ApproveCashAdvanceInput,
  actorId: string,
  permissions: string[],
) {
  const existing = await repo.findById(db, id);
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
  let decisions = await repo.findDecisions(db, id);
  if (decisions.length === 0) {
    await repo.createDecisions(db, id, [
      {
        order: 1,
        name: "Manager approval",
        approverType: "manager",
        approverUserId: null,
      },
    ]);
    await repo.update(db, id, { currentStepOrder: 1 });
    decisions = await repo.findDecisions(db, id);
  }
  const stepOrder = existing.currentStepOrder ?? 1;
  const decision = decisions.find((d) => d.order === stepOrder);
  if (!decision || decision.status !== "pending") {
    throw new BadRequestException(
      "Current approval step is already decided — refresh and try again",
    );
  }

  await assertCanActOnStep(db, decision, existing, actorId, permissions);

  // Optional per-line approved amounts (any step may set/adjust them).
  if (input.items && input.items.length > 0) {
    const itemsById = new Map(existing.items.map((it) => [it.id, it]));
    for (const it of input.items) {
      if (!itemsById.has(it.id)) {
        throw new BadRequestException(`Unknown item id ${it.id}`);
      }
    }
    await Promise.all(input.items.map((it) => repo.updateItemApprovedAmount(db, it.id, it.approvedAmount)));
  }

  await repo.updateDecision(db, decision.id, {
    status: "approved",
    decidedById: actorId,
    decidedAt: new Date().toISOString(),
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
  });

  const next = decisions.find(
    (d) => d.order > decision.order && d.status === "pending",
  );
  if (next) {
    const row = await repo.update(db, id, {
      currentStepOrder: next.order,
    });
    if (!row) throw new NotFoundException("Cash advance request not found");
    await notifyApprover(db,
      {
        order: next.order,
        name: next.name,
        approverType: next.approverType,
        approverUserId: next.approverUserId,
      },
      row,
    );
    console.info(JSON.stringify({ level: 'info', msg: 
      `Cash advance CA-${row.requestNumber} step ${decision.order} approved by ${actorId}; advanced to ${next.order}`,
     }));
    return { data: toDTO(row) };
  }

  // No more pending steps → finalise. approvedTotal = sum of per-line
  // approved amounts if any were set, else fall back to requestedTotal.
  const fresh = await repo.findById(db, id);
  const itemSum = (fresh?.items ?? []).reduce(
    (s, it) => s + Number(it.approvedAmount),
    0,
  );
  const approvedTotal =
    itemSum > 0 ? itemSum : Number(existing.requestedTotal);
  const row = await repo.update(db, id, {
    status: "approved",
    approvedTotal,
    approvedBy: actorId,
    approvedAt: new Date().toISOString(),
    rejectReason: null,
  });
  if (!row) throw new NotFoundException("Cash advance request not found");
  console.info(JSON.stringify({ level: 'info', msg: `Cash advance CA-${row.requestNumber} fully approved` }));

  // Notify the employee + the HR/finance recipients (to disburse).
  void sendEmail({ to: row.employee!.email, subject: "Cash advance approved" });
  try {
    const recipients = await loadCashAdvanceRecipients(db);
    if (recipients.length > 0) {
      void sendEmail({ to: recipients, subject: "Cash advance HR summary" });
    }
  } catch {
    // A recipient-notification failure must not roll back the approval.
  }
  return { data: toDTO(row) };
}

export async function reject(db: Db, 
  id: string,
  input: RejectCashAdvanceInput,
  actorId: string,
  permissions: string[],
) {
  const existing = await repo.findById(db, id);
  if (!existing) {
    throw new NotFoundException("Cash advance request not found");
  }
  if (existing.status !== "submitted") {
    throw new BadRequestException(
      `Can only reject a submitted request (current: ${existing.status})`,
    );
  }
  const decisions = await repo.findDecisions(db, id);
  const stepOrder = existing.currentStepOrder ?? 1;
  const decision = decisions.find((d) => d.order === stepOrder);
  // Legacy rows (no decisions) → only HR/Finance can reject.
  if (decision) {
    await assertCanActOnStep(db, decision, existing, actorId, permissions);
    await repo.updateDecision(db, decision.id, {
      status: "rejected",
      decidedById: actorId,
      decidedAt: new Date().toISOString(),
      notes: input.reason,
    });
  } else if (!permissions.includes(PERMISSIONS.CASH_ADVANCE_APPROVE)) {
    throw new ForbiddenException("Approve permission required");
  }

  const row = await repo.update(db, id, {
    status: "rejected",
    rejectReason: input.reason,
    approvedBy: actorId,
    approvedAt: new Date().toISOString(),
  });
  if (!row) throw new NotFoundException("Cash advance request not found");
  console.info(JSON.stringify({ level: 'info', msg: `Cash advance CA-${row.requestNumber} rejected by ${actorId}` }));

  const approver = await repo.findUserById(db, actorId);
  void sendEmail({ to: row.employee!.email, subject: "Cash advance rejected" });
  return { data: toDTO(row) };
}

// ── Approval-chain config (gated on cash-advance:approve at the route) ──
export async function listSteps(db: Db) {
  return repo.findApprovalSteps(db);
}

export async function createStep(db: Db, input: CreateCashAdvanceStepInput) {
  const order = (await repo.maxStepOrder(db)) + 1;
  return repo.createStep(db, {
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

export async function updateStep(db: Db, id: string, input: UpdateCashAdvanceStepInput) {
  const existing = await repo.findStepById(db, id);
  if (!existing) throw new NotFoundException("Approval step not found");
  return repo.updateStep(db, id, {
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

export async function deleteStep(db: Db, id: string) {
  const existing = await repo.findStepById(db, id);
  if (!existing) throw new NotFoundException("Approval step not found");
  await repo.deleteStep(db, id);
  return { success: true };
}

export async function reorderSteps(db: Db, input: ReorderCashAdvanceStepsInput) {
  await repo.reorderSteps(db, input.orderedIds);
  return repo.findApprovalSteps(db);
}

export async function getRecipients(db: Db, ) {
  return { emails: await loadCashAdvanceRecipients(db) };
}

export async function setRecipients(db: Db, emails: string[]) {
  await upsertSetting(db, CASH_ADVANCE_NOTIFICATION_KEY, emails);
  return { emails };
}

export async function markDisbursed(db: Db, 
  id: string,
  input: DisburseCashAdvanceInput,
  actorId: string,
  permissions: string[],
) {
  if (!permissions.includes(PERMISSIONS.CASH_ADVANCE_APPROVE)) {
    throw new ForbiddenException("Approve permission required");
  }
  const existing = await repo.findById(db, id);
  if (!existing) {
    throw new NotFoundException("Cash advance request not found");
  }
  if (existing.status !== "approved") {
    throw new BadRequestException(
      `Only approved requests can be marked disbursed (current: ${existing.status})`,
    );
  }
  const row = await repo.update(db, id, {
    status: "disbursed",
    disbursedAt: new Date().toISOString(),
    disbursementProofUrl: input.proofUrl,
  });
  if (!row) throw new NotFoundException("Cash advance request not found");
  console.info(JSON.stringify({ level: 'info', msg: `Cash advance CA-${row.requestNumber} disbursed by ${actorId}` }));
  return { data: toDTO(row) };
}

export async function markCleared(db: Db, id: string, actorId: string, permissions: string[]) {
  if (!permissions.includes(PERMISSIONS.CASH_ADVANCE_APPROVE)) {
    throw new ForbiddenException("Approve permission required");
  }
  const existing = await repo.findById(db, id);
  if (!existing) {
    throw new NotFoundException("Cash advance request not found");
  }
  if (existing.status !== "disbursed") {
    throw new BadRequestException(
      `Only disbursed requests can be cleared (current: ${existing.status})`,
    );
  }
  const row = await repo.update(db, id, {
    status: "cleared",
    clearedAt: new Date().toISOString(),
  });
  if (!row) throw new NotFoundException("Cash advance request not found");
  console.info(JSON.stringify({ level: 'info', msg: `Cash advance CA-${row.requestNumber} cleared by ${actorId}` }));
  return { data: toDTO(row) };
}
