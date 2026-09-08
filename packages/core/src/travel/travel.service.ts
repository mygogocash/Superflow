import { PERMISSIONS } from "@nexora/contracts";
import type { Db } from "@nexora/db";
import type {
  AddAttachmentsInput,
  CreateApprovalStepInput,
  CreateTravelRequestInput,
  ForwardTravelRequestInput,
  ReorderApprovalStepsInput,
  TravelRequestQuery,
  UpdateApprovalStepInput,
  UpdateTravelRequestInput,
} from "@nexora/contracts/modules/travel/travel.validation";
import { findRate } from "../exchange-rates/exchange-rates.repository";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "../http-exception";
import { getSetting, upsertSetting } from "../survey/system-settings.repository";
import * as repo from "./travel.repository";

const TRAVEL_NOTIFICATION_KEY = "travel.notification_recipients";
const PORTAL_URL = "/travel";

function travelSubmittedEmail(_: Record<string, unknown>) {
  return { subject: "", html: "" };
}
function travelApprovedEmail(_: Record<string, unknown>) {
  return { subject: "", html: "" };
}
function travelRejectedEmail(_: Record<string, unknown>) {
  return { subject: "", html: "" };
}
function travelCancelledEmail(_: Record<string, unknown>) {
  return { subject: "", html: "" };
}
function travelDeskSummaryEmail(_: Record<string, unknown>) {
  return { subject: "", html: "" };
}

/** TODO: wire edge email service — fire-and-forget no-op for now */
async function sendEmail(_opts: {
  to: string | string[];
  subject?: string;
  html?: string;
}): Promise<void> {}


function optionalEnv(name: string): string {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  const v = proc?.env?.[name];
  return typeof v === "string" ? v : "";
}

async function loadTravelNotificationRecipients(db: Db): Promise<string[]> {
  const value = await getSetting(db, TRAVEL_NOTIFICATION_KEY);
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  return [];
}

function fmtDate(d: Date | string): string {
  const date =
    typeof d === "string"
      ? new Date(d.includes("T") ? d : `${d}T00:00:00Z`)
      : d;
  return date.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

async function cashAdvanceInThb(
  db: Db,
  amount: number,
  currency: string,
): Promise<number | null> {
  const from = currency.trim().toUpperCase();
  if (from === "THB") return amount;
  const rate = await findRate(db, "THB", from);
  if (rate == null) return null;
  return Math.round(amount * rate * 100) / 100;
}

type DecisionRow = {
  order: number;
  name: string;
  approverType: string;
  approverUserId: string | null;
};

async function attachViewerCanAct<
  R extends {
    id: string;
    status: string;
    currentStepOrder: number | null;
    employee: { reportingTo: string | null };
  },
>(db: Db, requests: R[], actorId: string, permissions: string[]) {
  const isHr = permissions.includes(PERMISSIONS.TRAVEL_HR_APPROVE);
  const pendingIds = requests
    .filter((r) => r.status === "pending")
    .map((r) => r.id);

  if (pendingIds.length === 0) {
    return requests.map((r) => ({ ...r, viewerCanAct: false }));
  }

  const decisions = await repo.findDecisionsForRequests(db, pendingIds);
  const byRequest = new Map<string, typeof decisions>();
  for (const d of decisions) {
    const arr = byRequest.get(d.travelRequestId) ?? [];
    arr.push(d);
    byRequest.set(d.travelRequestId, arr);
  }

  return requests.map((r) => {
    if (r.status !== "pending") return { ...r, viewerCanAct: false };
    if (isHr) return { ...r, viewerCanAct: true };

    const ds = byRequest.get(r.id) ?? [];
    if (ds.length === 0) {
      return {
        ...r,
        viewerCanAct: r.employee.reportingTo === actorId,
      };
    }
    const target =
      r.currentStepOrder ??
      ds.find((d) => d.status === "pending")?.order ??
      ds[0]!.order;
    const current = ds.find((d) => d.order === target);
    if (!current || current.status !== "pending") {
      return { ...r, viewerCanAct: false };
    }
    if (current.approverType === "user") {
      return {
        ...r,
        viewerCanAct: current.approverUserId === actorId,
      };
    }
    if (current.approverType === "manager") {
      return {
        ...r,
        viewerCanAct: r.employee.reportingTo === actorId,
      };
    }
    return { ...r, viewerCanAct: false };
  });
}

async function getCurrentDecision(
  db: Db,
  requestId: string,
  currentStepOrder: number | null,
) {
  const decisions = await repo.findDecisions(db, requestId);
  if (decisions.length === 0) return null;
  const target =
    currentStepOrder ??
    decisions.find((d) => d.status === "pending")?.order ??
    decisions[0]!.order;
  return decisions.find((d) => d.order === target) ?? null;
}

async function assertCanActOnStep(
  decision: {
    approverType: string;
    approverUserId: string | null;
  },
  request: { employee: { reportingTo: string | null } },
  actorId: string,
  actorPermissions: string[],
) {
  const isHr = actorPermissions.includes(PERMISSIONS.TRAVEL_HR_APPROVE);
  if (isHr) return;

  if (decision.approverType === "user") {
    if (decision.approverUserId !== actorId) {
      throw new ForbiddenException(
        "This step is assigned to a different approver",
      );
    }
    return;
  }

  if (request.employee.reportingTo !== actorId) {
    throw new ForbiddenException(
      "Only the employee's direct manager can approve this step",
    );
  }
}

function hasTravelAllRead(permissions: string[]): boolean {
  return (
    permissions.includes(PERMISSIONS.TRAVEL_HR_READ) ||
    permissions.includes(PERMISSIONS.TRAVEL_HR_APPROVE)
  );
}

async function assertCanViewTravelRequest(
  db: Db,
  request: {
    id: string;
    employeeId: string;
    employee: { reportingTo: string | null };
  },
  userId: string,
  userPermissions: string[],
) {
  if (hasTravelAllRead(userPermissions)) return;
  if (request.employeeId === userId) return;
  if (request.employee.reportingTo === userId) return;

  const decisions = await repo.findDecisions(db, request.id);
  if (decisions.some((d) => d.approverUserId === userId)) return;

  throw new ForbiddenException(
    "You can only view travel requests in your management scope",
  );
}

export async function listRequests(
  db: Db,
  userId: string,
  userPermissions: string[],
  query: TravelRequestQuery,
) {
  const { page, limit, ...rest } = query;
  const filters: Parameters<typeof repo.findRequests>[1] = { ...rest };

  if (!hasTravelAllRead(userPermissions)) {
    filters.managerScopeUserId = userId;
  }

  const { data, total } = await repo.findRequests(db, filters, page, limit);
  const enriched = await attachViewerCanAct(db, data, userId, userPermissions);

  return {
    data: enriched,
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getRequestById(
  db: Db,
  id: string,
  userId: string,
  userPermissions: string[],
) {
  const request = await repo.findRequestById(db, id);
  if (!request) throw new NotFoundException("Travel request not found");

  await assertCanViewTravelRequest(db, request, userId, userPermissions);

  const [enriched] = await attachViewerCanAct(
    db,
    [request],
    userId,
    userPermissions,
  );
  return enriched ?? request;
}

export async function createRequest(
  db: Db,
  userId: string,
  input: CreateTravelRequestInput,
) {
  const user = await repo.findUserById(db, userId);

  const created = await repo.createRequest(db, {
    employeeId: userId,
    entityId: user?.entityId ?? null,
    origin: input.origin,
    destination: input.destination,
    purpose: input.purpose,
    departureDate: input.departureDate,
    returnDate: input.returnDate,
    estimatedBudget: input.estimatedBudget,
    cashAdvance: input.cashAdvance,
    currency: input.currency,
    category: input.category,
    flightType: input.flightType,
    departureTimePreference: input.departureTimePreference,
    returnTimePreference: input.returnTimePreference,
    mealPreference: input.mealPreference,
    seatingPreference: input.seatingPreference,
    seatingPreferenceOther: input.seatingPreferenceOther,
    dummyTicketRequired: input.dummyTicketRequired,
    visaRequired: input.visaRequired,
    hotelRequired: input.hotelRequired,
    hotelLocationPreference: input.hotelLocationPreference,
    preferredHotel: input.preferredHotel,
    hotelDetails: input.hotelDetails,
    notes: input.notes,
  });
  if (!created) {
    throw new BadRequestException("Failed to create travel request");
  }

  const allSteps = await repo.findApprovalSteps(db, { activeOnly: true });

  const anyAmountFilter = allSteps.some(
    (s) => s.amountMinBaht != null || s.amountMaxBaht != null,
  );
  let cashAdvanceBaht: number | null = null;
  if (anyAmountFilter && input.cashAdvance !== undefined) {
    cashAdvanceBaht = await cashAdvanceInThb(
      db,
      input.cashAdvance,
      input.currency,
    );
  }

  const requestCategory = input.category ?? "general";
  const applicableSteps = allSteps.filter((s) => {
    const skipIds = Array.isArray(s.skipWhenSubmitterIds)
      ? (s.skipWhenSubmitterIds as string[])
      : [];
    if (skipIds.includes(userId)) return false;
    const onlyIds = Array.isArray(s.onlyWhenSubmitterIds)
      ? (s.onlyWhenSubmitterIds as string[])
      : [];
    if (onlyIds.length > 0 && !onlyIds.includes(userId)) return false;

    const cats = Array.isArray(s.categoryFilter)
      ? (s.categoryFilter as string[])
      : [];
    if (cats.length > 0 && !cats.includes(requestCategory)) return false;

    const hasAmountFilter =
      s.amountMinBaht != null || s.amountMaxBaht != null;
    if (hasAmountFilter) {
      if (cashAdvanceBaht === null) return false;
      const min = s.amountMinBaht != null ? Number(s.amountMinBaht) : null;
      const max = s.amountMaxBaht != null ? Number(s.amountMaxBaht) : null;
      if (min !== null && cashAdvanceBaht < min) return false;
      if (max !== null && cashAdvanceBaht > max) return false;
    }

    return true;
  });

  let l2UserId: string | null = null;
  if (user?.reportingTo) {
    const l1 = await repo.findUserById(db, user.reportingTo);
    l2UserId = l1?.reportingTo ?? null;
  }

  const rawRows: Array<DecisionRow | null> =
    applicableSteps.length > 0
      ? applicableSteps.map((s, idx): DecisionRow | null => {
          if (s.approverType === "manager_l2") {
            if (!l2UserId) return null;
            return {
              order: idx + 1,
              name: s.name,
              approverType: "user",
              approverUserId: l2UserId,
            };
          }
          return {
            order: idx + 1,
            name: s.name,
            approverType: s.approverType,
            approverUserId:
              s.approverType === "user" ? s.approverUserId : null,
          };
        })
      : [
          {
            order: 1,
            name: "Manager approval",
            approverType: "manager",
            approverUserId: null,
          },
        ];

  const decisionRows: DecisionRow[] = rawRows
    .filter((r): r is DecisionRow => r !== null)
    .map((r, idx) => ({ ...r, order: idx + 1 }));

  if (decisionRows.length === 0) {
    decisionRows.push({
      order: 1,
      name: "Manager approval",
      approverType: "manager",
      approverUserId: null,
    });
  }

  await repo.createDecisions(db, created.id, decisionRows);
  await repo.updateRequest(db, created.id, { currentStepOrder: 1 });

  const firstStep = decisionRows[0]!;
  let approverEmail: string | undefined;
  let approverName: string | undefined;
  if (firstStep.approverType === "manager" && user?.reportingTo) {
    const manager = await repo.findUserById(db, user.reportingTo);
    approverEmail = manager?.email ?? undefined;
    approverName = manager?.name;
  } else if (firstStep.approverType === "user" && firstStep.approverUserId) {
    const approver = await repo.findUserById(db, firstStep.approverUserId);
    approverEmail = approver?.email ?? undefined;
    approverName = approver?.name;
  }
  if (approverEmail && user) {
    const email = travelSubmittedEmail({
      approverName: approverName ?? "Approver",
      employeeName: user.name,
      origin: input.origin,
      destination: input.destination,
      startDate: fmtDate(input.departureDate),
      endDate: fmtDate(input.returnDate),
      purpose: input.purpose,
      portalUrl: `${PORTAL_URL}/travel`,
    });
    void sendEmail({ to: approverEmail, ...email });
  }

  return repo.findRequestById(db, created.id);
}

export async function updateRequest(
  db: Db,
  id: string,
  userId: string,
  input: UpdateTravelRequestInput,
) {
  const request = await repo.findRequestById(db, id);
  if (!request) throw new NotFoundException("Travel request not found");
  if (request.employeeId !== userId) {
    throw new ForbiddenException(
      "You can only update your own travel requests",
    );
  }
  if (request.status !== "draft" && request.status !== "pending") {
    throw new BadRequestException(
      `Cannot update a request with status "${request.status}"`,
    );
  }

  return repo.updateRequest(db, id, {
    ...(input.origin !== undefined && { origin: input.origin }),
    ...(input.destination !== undefined && {
      destination: input.destination,
    }),
    ...(input.purpose !== undefined && { purpose: input.purpose }),
    ...(input.departureDate !== undefined && {
      departureDate: input.departureDate,
    }),
    ...(input.returnDate !== undefined && { returnDate: input.returnDate }),
    ...(input.estimatedBudget !== undefined && {
      estimatedBudget: input.estimatedBudget,
    }),
    ...(input.cashAdvance !== undefined && { cashAdvance: input.cashAdvance }),
    ...(input.currency !== undefined && { currency: input.currency }),
    ...(input.flightType !== undefined && { flightType: input.flightType }),
    ...(input.departureTimePreference !== undefined && {
      departureTimePreference: input.departureTimePreference,
    }),
    ...(input.returnTimePreference !== undefined && {
      returnTimePreference: input.returnTimePreference,
    }),
    ...(input.mealPreference !== undefined && {
      mealPreference: input.mealPreference,
    }),
    ...(input.seatingPreference !== undefined && {
      seatingPreference: input.seatingPreference,
    }),
    ...(input.seatingPreferenceOther !== undefined && {
      seatingPreferenceOther: input.seatingPreferenceOther,
    }),
    ...(input.dummyTicketRequired !== undefined && {
      dummyTicketRequired: input.dummyTicketRequired,
    }),
    ...(input.visaRequired !== undefined && {
      visaRequired: input.visaRequired,
    }),
    ...(input.hotelRequired !== undefined && {
      hotelRequired: input.hotelRequired,
    }),
    ...(input.hotelLocationPreference !== undefined && {
      hotelLocationPreference: input.hotelLocationPreference,
    }),
    ...(input.preferredHotel !== undefined && {
      preferredHotel: input.preferredHotel,
    }),
    ...(input.hotelDetails !== undefined && {
      hotelDetails: input.hotelDetails,
    }),
    ...(input.notes !== undefined && { notes: input.notes }),
  });
}

export async function approveRequest(
  db: Db,
  id: string,
  approverId: string,
  permissions: string[],
) {
  const request = await repo.findRequestById(db, id);
  if (!request) throw new NotFoundException("Travel request not found");
  if (request.status !== "pending") {
    throw new BadRequestException(
      `Cannot approve a request with status "${request.status}"`,
    );
  }

  let decision = await getCurrentDecision(db, id, request.currentStepOrder);
  if (!decision) {
    await repo.createDecisions(db, id, [
      {
        order: 1,
        name: "Manager approval",
        approverType: "manager",
        approverUserId: null,
      },
    ]);
    await repo.updateRequest(db, id, { currentStepOrder: 1 });
    decision = await getCurrentDecision(db, id, 1);
  }
  if (!decision) {
    throw new BadRequestException(
      "No approval chain configured for this request",
    );
  }
  if (decision.status !== "pending") {
    throw new BadRequestException(
      "Current step is already decided — refresh and try again",
    );
  }

  await assertCanActOnStep(decision, request, approverId, permissions);

  await repo.updateDecision(db, decision.id, {
    status: "approved",
    decidedById: approverId,
    decidedAt: new Date().toISOString(),
  });

  const decisions = await repo.findDecisions(db, id);
  const next = decisions.find(
    (d) => d.order > decision.order && d.status === "pending",
  );

  if (next) {
    await repo.updateRequest(db, id, { currentStepOrder: next.order });

    let nextEmail: string | undefined;
    let nextName: string | undefined;
    if (next.approverType === "user" && next.approverUserId) {
      const u = await repo.findUserById(db, next.approverUserId);
      nextEmail = u?.email ?? undefined;
      nextName = u?.name;
    } else if (next.approverType === "manager") {
      const employee = await repo.findUserById(db, request.employeeId);
      if (employee?.reportingTo) {
        const manager = await repo.findUserById(db, employee.reportingTo);
        nextEmail = manager?.email ?? undefined;
        nextName = manager?.name;
      }
    }
    if (nextEmail) {
      const email = travelSubmittedEmail({
        approverName: nextName ?? "Approver",
        employeeName: request.employee.name,
        origin: request.origin,
        destination: request.destination,
        startDate: fmtDate(request.departureDate),
        endDate: fmtDate(request.returnDate),
        purpose: request.purpose,
        portalUrl: `${PORTAL_URL}/travel`,
      });
      void sendEmail({ to: nextEmail, ...email });
    }

    return repo.findRequestById(db, id);
  }

  const result = await repo.updateRequestStatus(db, id, {
    status: "approved",
    approvedBy: approverId,
    approvedAt: new Date().toISOString(),
  });

  const approver = await repo.findUserById(db, approverId);
  const email = travelApprovedEmail({
    employeeName: request.employee.name,
    origin: request.origin,
    destination: request.destination,
    startDate: fmtDate(request.departureDate),
    endDate: fmtDate(request.returnDate),
    approverName: approver?.name ?? "Your Manager",
    portalUrl: `${PORTAL_URL}/travel`,
  });

  const recipients = new Set<string>([request.employee.email]);
  if (request.employee.reportingTo) {
    const supervisor = await repo.findUserById(db, request.employee.reportingTo);
    if (supervisor?.email) recipients.add(supervisor.email);
  }
  for (const cc of optionalEnv("TRAVEL_APPROVED_CC")
    .split(",")
    .map((s: string) => s.trim())
    .filter(Boolean)) {
    recipients.add(cc);
  }
  void sendEmail({ to: Array.from(recipients), ...email });

  try {
    const deskRecipients = await loadTravelNotificationRecipients(db);
    if (deskRecipients.length > 0) {
      const expenseTypes: string[] = [];
      if (request.flightType) expenseTypes.push("Flight");
      if (request.hotelRequired) expenseTypes.push("Hotel Stay");
      const remarks: string[] = [];
      if (request.notes) remarks.push(request.notes);
      if (request.dummyTicketRequired) remarks.push("Dummy Return Ticket");
      if (request.visaRequired) remarks.push("Visa Required");
      const deskEmail = travelDeskSummaryEmail({
        employeeName: request.employee.name,
        employeeEmail: request.employee.email,
        approverName: approver?.name ?? "—",
        department: request.employee.department ?? null,
        expenseTypes,
        destination: request.destination,
        hotelLocationPreference: request.hotelLocationPreference,
        preferredHotel: request.preferredHotel,
        hotelDetails: request.hotelDetails,
        departureDate: fmtDate(request.departureDate),
        origin: request.origin,
        returnDate: fmtDate(request.returnDate),
        flightType: request.flightType,
        departureTimePreference: request.departureTimePreference,
        seatingPreference: request.seatingPreference,
        mealPreference: request.mealPreference,
        notes: remarks.join("; ") || null,
        portalUrl: `${PORTAL_URL}/travel`,
      });
      void sendEmail({ to: deskRecipients, ...deskEmail });
    }
  } catch {
    // desk notification is best-effort
  }

  return result;
}

export async function rejectRequest(
  db: Db,
  id: string,
  approverId: string,
  reason: string,
  permissions: string[],
) {
  const request = await repo.findRequestById(db, id);
  if (!request) throw new NotFoundException("Travel request not found");
  if (request.status !== "pending") {
    throw new BadRequestException(
      `Cannot reject a request with status "${request.status}"`,
    );
  }

  const decision = await getCurrentDecision(db, id, request.currentStepOrder);
  if (decision) {
    if (decision.status !== "pending") {
      throw new BadRequestException(
        "Current step is already decided — refresh and try again",
      );
    }
    await assertCanActOnStep(decision, request, approverId, permissions);
    await repo.updateDecision(db, decision.id, {
      status: "rejected",
      decidedById: approverId,
      decidedAt: new Date().toISOString(),
      notes: reason,
    });
  }

  const result = await repo.updateRequestStatus(db, id, {
    status: "rejected",
    approvedBy: approverId,
    approvedAt: new Date().toISOString(),
    rejectReason: reason,
  });

  const approver = await repo.findUserById(db, approverId);
  const email = travelRejectedEmail({
    employeeName: request.employee.name,
    origin: request.origin,
    destination: request.destination,
    startDate: fmtDate(request.departureDate),
    endDate: fmtDate(request.returnDate),
    approverName: approver?.name ?? "Your Manager",
    rejectionReason: reason,
    portalUrl: `${PORTAL_URL}/travel`,
  });
  void sendEmail({ to: request.employee.email, ...email });

  return result;
}

export async function getDecisions(
  db: Db,
  id: string,
  userId: string,
  permissions: string[],
) {
  const request = await repo.findRequestById(db, id);
  if (!request) throw new NotFoundException("Travel request not found");
  await assertCanViewTravelRequest(db, request, userId, permissions);
  return repo.findDecisions(db, id);
}

export async function listApprovalSteps(db: Db) {
  return repo.findApprovalSteps(db);
}

export async function createApprovalStep(
  db: Db,
  input: CreateApprovalStepInput,
) {
  if (input.approverType === "user" && !input.approverUserId) {
    throw new BadRequestException(
      "approverUserId is required when approverType is 'user'",
    );
  }
  const order = await repo.nextStepOrder(db);
  return repo.createApprovalStep(db, {
    order,
    name: input.name,
    description: input.description,
    approverType: input.approverType,
    isActive: input.isActive,
    skipWhenSubmitterIds: input.skipWhenSubmitterIds,
    onlyWhenSubmitterIds: input.onlyWhenSubmitterIds,
    categoryFilter: input.categoryFilter,
    amountMinBaht: input.amountMinBaht ?? null,
    amountMaxBaht: input.amountMaxBaht ?? null,
    approverUserId:
      input.approverType === "user" ? (input.approverUserId ?? null) : null,
  });
}

export async function updateApprovalStep(
  db: Db,
  id: string,
  input: UpdateApprovalStepInput,
) {
  const existing = await repo.findApprovalStepById(db, id);
  if (!existing) throw new NotFoundException("Approval step not found");

  const patch: Parameters<typeof repo.updateApprovalStep>[2] = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.isActive !== undefined) patch.isActive = input.isActive;
  if (input.skipWhenSubmitterIds !== undefined) {
    patch.skipWhenSubmitterIds = input.skipWhenSubmitterIds;
  }
  if (input.onlyWhenSubmitterIds !== undefined) {
    patch.onlyWhenSubmitterIds = input.onlyWhenSubmitterIds;
  }
  if (input.categoryFilter !== undefined) {
    patch.categoryFilter = input.categoryFilter;
  }
  if (input.amountMinBaht !== undefined) {
    patch.amountMinBaht = input.amountMinBaht;
  }
  if (input.amountMaxBaht !== undefined) {
    patch.amountMaxBaht = input.amountMaxBaht;
  }

  const nextType = input.approverType ?? existing.approverType;
  if (input.approverType !== undefined) patch.approverType = nextType;

  let nextApproverId: string | null = null;
  if (nextType === "user") {
    const userId = input.approverUserId ?? existing.approverUserId;
    if (!userId) {
      throw new BadRequestException(
        "approverUserId is required when approverType is 'user'",
      );
    }
    patch.approverUserId = userId;
    nextApproverId = userId;
  } else if (nextType === "manager" || nextType === "manager_l2") {
    patch.approverUserId = null;
    nextApproverId = null;
  }

  const updated = await repo.updateApprovalStep(db, id, patch);

  await repo.reassignPendingDecisionsByStepName(db, existing.name, nextApproverId);

  return updated;
}

export async function deleteApprovalStep(db: Db, id: string) {
  const existing = await repo.findApprovalStepById(db, id);
  if (!existing) throw new NotFoundException("Approval step not found");
  return repo.deleteApprovalStep(db, id);
}

export async function reorderApprovalSteps(
  db: Db,
  input: ReorderApprovalStepsInput,
) {
  const all = await repo.findApprovalSteps(db);
  if (all.length !== input.orderedIds.length) {
    throw new BadRequestException(
      "orderedIds must include every existing step exactly once",
    );
  }
  const knownIds = new Set(all.map((s) => s.id));
  for (const stepId of input.orderedIds) {
    if (!knownIds.has(stepId)) {
      throw new BadRequestException(`Unknown step id: ${stepId}`);
    }
  }
  return repo.reorderApprovalSteps(db, input.orderedIds);
}

export async function getNotificationRecipients(db: Db) {
  return { emails: await loadTravelNotificationRecipients(db) };
}

export async function setNotificationRecipients(db: Db, rawEmails: string[]) {
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const raw of rawEmails) {
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed) continue;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      throw new BadRequestException(`Invalid email: ${raw}`);
    }
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    cleaned.push(trimmed);
  }
  await upsertSetting(db, TRAVEL_NOTIFICATION_KEY, cleaned);
  return { emails: cleaned };
}

export async function cancelRequest(db: Db, id: string, userId: string) {
  const request = await repo.findRequestById(db, id);
  if (!request) throw new NotFoundException("Travel request not found");
  if (request.employeeId !== userId) {
    throw new ForbiddenException("You can only cancel your own requests");
  }
  if (request.status !== "pending" && request.status !== "draft") {
    throw new BadRequestException(
      `Cannot cancel a request with status "${request.status}"`,
    );
  }

  const result = await repo.updateRequestStatus(db, id, { status: "cancelled" });

  const employee = await repo.findUserById(db, userId);
  if (employee?.reportingTo) {
    const manager = await repo.findUserById(db, employee.reportingTo);
    if (manager?.email) {
      const email = travelCancelledEmail({
        recipientName: manager.name,
        employeeName: request.employee.name,
        origin: request.origin,
        destination: request.destination,
        startDate: fmtDate(request.departureDate),
        endDate: fmtDate(request.returnDate),
        portalUrl: `${PORTAL_URL}/travel`,
      });
      void sendEmail({ to: manager.email, ...email });
    }
  }

  return result;
}

export async function deleteRequest(
  db: Db,
  id: string,
  userId: string,
  permissions: string[],
) {
  const request = await repo.findRequestById(db, id);
  if (!request) throw new NotFoundException("Travel request not found");

  const isHr = permissions.includes(PERMISSIONS.TRAVEL_HR_READ);
  if (!isHr && request.employeeId !== userId) {
    throw new ForbiddenException(
      "You can only delete your own travel requests",
    );
  }

  if (!isHr) {
    const DELETABLE = new Set(["draft", "pending", "cancelled", "rejected"]);
    if (!DELETABLE.has(request.status)) {
      throw new BadRequestException(
        `Cannot delete a request with status "${request.status}". Approved or completed requests are retained for audit.`,
      );
    }
  }

  return repo.softDeleteRequest(db, id);
}

export async function restoreRequest(
  db: Db,
  id: string,
  userId: string,
  permissions: string[],
) {
  const active = await repo.findRequestById(db, id);
  if (active) throw new ConflictException("Request is not deleted");

  const request = await repo.findRequestByIdIncludingDeleted(db, id);
  if (!request) throw new NotFoundException("Travel request not found");

  const isHr = permissions.includes(PERMISSIONS.TRAVEL_HR_READ);
  if (!isHr && request.employeeId !== userId) {
    throw new ForbiddenException(
      "You can only restore your own travel requests",
    );
  }
  return repo.restoreRequest(db, id);
}

export async function permanentDeleteRequest(
  db: Db,
  id: string,
  permissions: string[],
) {
  // Soft-deleted rows are the normal purge target; the live finder would 404 them.
  const request = await repo.findRequestByIdIncludingDeleted(db, id);
  if (!request) {
    throw new NotFoundException("Travel request not found");
  }
  if (!permissions.includes(PERMISSIONS.TRAVEL_HR_READ)) {
    throw new ForbiddenException(
      "Only HR can permanently delete travel requests",
    );
  }
  return repo.permanentDeleteRequest(db, id);
}

export async function completeRequest(db: Db, id: string, actorId: string) {
  const request = await repo.findRequestById(db, id);
  if (!request) throw new NotFoundException("Travel request not found");
  if (request.status !== "approved") {
    throw new BadRequestException(
      `Cannot complete a request with status "${request.status}"`,
    );
  }

  return repo.updateRequestStatus(db, id, {
    status: "completed",
    approvedBy: actorId,
    approvedAt: new Date().toISOString(),
  });
}

export async function archiveRequest(db: Db, id: string, actorId: string) {
  const request = await repo.findRequestById(db, id);
  if (!request) throw new NotFoundException("Travel request not found");
  if (request.status !== "completed") {
    throw new BadRequestException(
      `Cannot archive a request with status "${request.status}"`,
    );
  }

  return repo.updateRequestStatus(db, id, {
    status: "archived",
    approvedBy: actorId,
    approvedAt: new Date().toISOString(),
  });
}

export async function getLinkedExpenses(
  db: Db,
  travelId: string,
  userId: string,
  userPermissions: string[],
) {
  const request = await repo.findRequestById(db, travelId);
  if (!request) throw new NotFoundException("Travel request not found");

  await assertCanViewTravelRequest(db, request, userId, userPermissions);

  return repo.findExpensesForTravel(db, travelId);
}

export async function forwardRequest(
  db: Db,
  requestId: string,
  actorId: string,
  userPermissions: string[],
  input: ForwardTravelRequestInput,
) {
  const request = await repo.findRequestById(db, requestId);
  if (!request) throw new NotFoundException("Travel request not found");
  if (request.status !== "pending") {
    throw new BadRequestException(
      `Cannot forward a request with status "${request.status}"`,
    );
  }

  const managerId = request.employee.reportingTo;
  const isHr = userPermissions.includes(PERMISSIONS.TRAVEL_HR_READ);
  if (!isHr && (!managerId || actorId !== managerId)) {
    throw new ForbiddenException(
      "Only the employee's direct manager can forward this request",
    );
  }

  const delegate = await repo.findUserById(db, input.delegateUserId);
  if (!delegate) {
    throw new BadRequestException("Delegate user not found");
  }
  if (delegate.id === request.employeeId) {
    throw new BadRequestException("Cannot delegate to the employee");
  }

  return repo.updateRequest(db, requestId, {
    delegatedTo: input.delegateUserId,
  });
}

export async function addAttachments(
  db: Db,
  requestId: string,
  userId: string,
  userPermissions: string[],
  input: AddAttachmentsInput,
) {
  const request = await repo.findRequestById(db, requestId);
  if (!request) throw new NotFoundException("Travel request not found");

  const isHr = userPermissions.includes(PERMISSIONS.TRAVEL_HR_READ);
  if (!isHr && request.employeeId !== userId) {
    throw new ForbiddenException(
      "You can only add attachments to your own travel requests",
    );
  }

  const existing = Array.isArray(request.attachments)
    ? (request.attachments as Array<{
        name: string;
        url: string;
        type?: string;
      }>)
    : [];
  const merged = [...existing, ...input.attachments];

  return repo.updateRequest(db, requestId, { attachments: merged });
}

export async function exportTravelXlsx(
  _db: Db,
  _query: Omit<TravelRequestQuery, "page" | "limit">,
) {
  throw new BadRequestException("XLSX export is not available on the edge API");
}
