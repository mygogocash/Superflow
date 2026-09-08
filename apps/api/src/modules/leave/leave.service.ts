import type { Prisma } from "@nexora/database";

import { PERMISSIONS } from "@/common/constants/permissions";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@/common/exceptions/http-exception";
import { isValidEmail } from "@/common/utils/email";
import { logger } from "@/common/utils/logger";
import { prisma } from "@/infrastructure/database/prisma";
import { sendEmail } from "@/infrastructure/email/email.service";
import {
  leaveApprovedEmail,
  leaveCancelledEmail,
  leaveDeskSummaryEmail,
  leaveEscalationReminderEmail,
  leaveForwardedEmail,
  leaveRejectedEmail,
  leaveSubmittedConfirmationEmail,
  leaveSubmittedDeskEmail,
  leaveSubmittedEmail,
} from "@/infrastructure/email/templates";
import {
  actorFromId,
  trackLeaveRequestApproved,
  trackLeaveRequestRejected,
  trackLeaveRequestSubmittedServer,
} from "@/lib/events";
import { filterExcludedLeaveRecipients } from "@/lib/leave-notification-exclude";
import { PORTAL_URL } from "@/lib/portal-url";
import { leaveRepository } from "@/modules/leave/leave.repository";
import type {
  BalanceQuery,
  BulkImportBalanceRow,
  CreateLeaveApprovalStepInput,
  CreateLeaveRequestInput,
  CreateLeaveTypeInput,
  ForwardLeaveRequestInput,
  LeaveAnalyticsQuery,
  LeaveCalendarQuery,
  LeaveRequestQuery,
  ReorderLeaveApprovalStepsInput,
  SetLeavePolicyApproversInput,
  TeamBalanceQuery,
  UpdateLeaveApprovalStepInput,
  UpdateLeaveBalanceInput,
  UpdateLeaveTypeInput,
  UpsertLeaveBalanceInput,
} from "@/modules/leave/leave.validation";

/** Prisma raises P2025 when an update/delete matches no row. */
function isRecordNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2025"
  );
}

/**
 * Compare-and-swap on a still-pending leave request. Prisma lets a
 * unique `id` be combined with a plain filter in `where`, so the update
 * lands only while the row is `pending`. approveRequest's pre-flight
 * status check reads the row outside the transaction, so on a
 * double-submit both callers can pass it — only one can win here. The
 * loser matches nothing, Prisma raises P2025, and we surface a 409
 * rather than letting it apply a second balance mutation.
 */
async function claimPendingRequest(
  tx: Prisma.TransactionClient,
  requestId: string,
  data: Prisma.LeaveRequestUncheckedUpdateInput,
) {
  try {
    return await tx.leaveRequest.update({
      where: { id: requestId, status: "pending" },
      data,
    });
  } catch (err) {
    if (isRecordNotFound(err)) {
      throw new ConflictException(
        "This leave request was already actioned by someone else",
      );
    }
    throw err;
  }
}

const LEAVE_NOTIFICATION_KEY = "leave.notification_recipients";

async function loadLeaveNotificationRecipients(): Promise<string[]> {
  const row = await prisma.systemSetting.findUnique({
    where: { key: LEAVE_NOTIFICATION_KEY },
  });
  if (!row) return [];
  const value = row.value;
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  return [];
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function countBusinessDays(start: Date, end: Date): number {
  let count = 0;
  const current = new Date(start);
  while (current <= end) {
    const day = current.getDay();
    if (day !== 0 && day !== 6) count++;
    current.setDate(current.getDate() + 1);
  }
  return count;
}

// Does an approval step apply to this request? Shared by the per-policy
// (LeavePolicyApprover) and org-wide (LeaveApprovalStep) snapshot paths.
// Submitter gating mirrors the original global-chain filter; the day band
// (minDays/maxDays, inclusive, null = unbounded) is per-policy only —
// global steps carry no band, so those checks no-op for them.
function stepApplies(
  step: {
    skipWhenSubmitterIds?: unknown;
    onlyWhenSubmitterIds?: unknown;
    minDays?: number | null;
    maxDays?: number | null;
  },
  ctx: { submitterId: string; days: number },
): boolean {
  const skip = Array.isArray(step.skipWhenSubmitterIds)
    ? (step.skipWhenSubmitterIds as string[])
    : [];
  if (skip.includes(ctx.submitterId)) return false;
  const only = Array.isArray(step.onlyWhenSubmitterIds)
    ? (step.onlyWhenSubmitterIds as string[])
    : [];
  if (only.length > 0 && !only.includes(ctx.submitterId)) return false;
  if (step.minDays != null && ctx.days < step.minDays) return false;
  if (step.maxDays != null && ctx.days > step.maxDays) return false;
  return true;
}

export class LeaveService {
  /**
   * Policies visible to the calling user. Resolves the user's entity
   * automatically; passing entityId explicitly lets HR preview a
   * specific entity. Always includes global (entityId = null) policies.
   */
  async getTypes(userId?: string, entityIdOverride?: string | null) {
    let entityId: string | null = null;
    if (entityIdOverride !== undefined) {
      entityId = entityIdOverride;
    } else if (userId) {
      entityId = await leaveRepository.findUserEntityId(userId);
    }
    return leaveRepository.findTypes(entityId);
  }

  async getAllTypes(filters?: { entityId?: string | "global" | null }) {
    return leaveRepository.findAllTypes(filters);
  }

  async createType(input: CreateLeaveTypeInput) {
    const code = input.code.toUpperCase();
    const entityId = input.entityId ?? null;
    const [byName, byCode] = await Promise.all([
      leaveRepository.findTypeByNameInEntity(input.name, entityId),
      leaveRepository.findTypeByCodeInEntity(code, entityId),
    ]);
    if (byName) {
      throw new ConflictException(
        "Leave type name already in use for this entity",
      );
    }
    if (byCode) {
      throw new ConflictException(
        "Leave type code already in use for this entity",
      );
    }

    return leaveRepository.createType({
      name: input.name,
      code,
      description: input.description,
      category: input.category,
      daysPerYear: input.daysPerYear,
      requiresApproval: input.requiresApproval,
      isPaid: input.isPaid,
      isActive: input.isActive,
      ...(entityId ? { entity: { connect: { id: entityId } } } : {}),
    });
  }

  async updateType(id: string, input: UpdateLeaveTypeInput) {
    const existing = await leaveRepository.findTypeById(id);
    if (!existing) throw new NotFoundException("Leave type not found");

    // Allow re-scoping a policy to a different entity (or to "global"
    // by passing null/empty). Default = keep existing scope.
    const nextEntityId =
      input.entityId === undefined
        ? existing.entityId
        : input.entityId
          ? input.entityId
          : null;

    if (
      input.name &&
      (input.name !== existing.name || nextEntityId !== existing.entityId)
    ) {
      const byName = await leaveRepository.findTypeByNameInEntity(
        input.name,
        nextEntityId,
      );
      if (byName && byName.id !== id) {
        throw new ConflictException(
          "Leave type name already in use for this entity",
        );
      }
    }

    const code = input.code ? input.code.toUpperCase() : undefined;
    if (
      code &&
      (code !== existing.code || nextEntityId !== existing.entityId)
    ) {
      const byCode = await leaveRepository.findTypeByCodeInEntity(
        code,
        nextEntityId,
      );
      if (byCode && byCode.id !== id) {
        throw new ConflictException(
          "Leave type code already in use for this entity",
        );
      }
    }

    return leaveRepository.updateType(id, {
      ...(input.name !== undefined && { name: input.name }),
      ...(code !== undefined && { code }),
      ...(input.description !== undefined && {
        description: input.description,
      }),
      ...(input.category !== undefined && { category: input.category }),
      ...(input.daysPerYear !== undefined && {
        daysPerYear: input.daysPerYear,
      }),
      ...(input.requiresApproval !== undefined && {
        requiresApproval: input.requiresApproval,
      }),
      ...(input.isPaid !== undefined && { isPaid: input.isPaid }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
      ...(input.entityId !== undefined && {
        entity: input.entityId
          ? { connect: { id: input.entityId } }
          : { disconnect: true },
      }),
    });
  }

  async deleteType(id: string) {
    const existing = await leaveRepository.findTypeById(id);
    if (!existing) throw new NotFoundException("Leave type not found");

    const refs = await leaveRepository.countTypeReferences(id);
    if (refs.balances > 0 || refs.requests > 0 || refs.transactions > 0) {
      throw new ConflictException(
        `Cannot delete leave policy "${existing.name}" because ${refs.balances} balance(s), ${refs.requests} request(s), and ${refs.transactions} transaction(s) reference it. Deactivate it instead.`,
      );
    }

    await leaveRepository.deleteType(id);
    return { id };
  }

  async getApprovers(leaveTypeId: string) {
    const existing = await leaveRepository.findTypeById(leaveTypeId);
    if (!existing) throw new NotFoundException("Leave type not found");
    return leaveRepository.findApprovers(leaveTypeId);
  }

  async setApprovers(leaveTypeId: string, input: SetLeavePolicyApproversInput) {
    const existing = await leaveRepository.findTypeById(leaveTypeId);
    if (!existing) throw new NotFoundException("Leave type not found");

    const rows = input.approvers.map((a, idx) => ({
      order: idx + 1,
      approverType: a.approverType,
      approverUserId: a.approverType === "user" ? a.approverUserId : null,
      skipWhenSubmitterIds: a.skipWhenSubmitterIds ?? [],
      onlyWhenSubmitterIds: a.onlyWhenSubmitterIds ?? [],
      minDays: a.minDays ?? null,
      maxDays: a.maxDays ?? null,
    }));

    return leaveRepository.replaceApprovers(leaveTypeId, rows);
  }

  async getBalances(
    userId: string,
    userPermissions: string[],
    query: BalanceQuery,
  ) {
    const year = query.year ?? new Date().getFullYear();
    const targetEmployeeId = query.employeeId ?? userId;

    if (targetEmployeeId !== userId) {
      const hasHrRead = userPermissions.includes(PERMISSIONS.LEAVE_HR_READ);
      if (!hasHrRead) {
        throw new ForbiddenException(
          "No permission to view other employee balances",
        );
      }
    }

    // Synthesise balances against the policies that actually apply to
    // this employee (their entity + global), not every active policy.
    const targetEntityId =
      await leaveRepository.findUserEntityId(targetEmployeeId);
    const [rows, types] = await Promise.all([
      leaveRepository.findBalances(targetEmployeeId, year),
      leaveRepository.findTypes(targetEntityId),
    ]);

    // Drop balance rows whose leave type belongs to a different entity.
    // Legacy seed/imports created cross-entity rows that, combined with
    // synthesised entries, surfaced as duplicate cards in the UI.
    const applicableRows = rows.filter(
      (b) =>
        b.leaveType.entityId === null ||
        b.leaveType.entityId === targetEntityId,
    );

    const stored = applicableRows.map((b) => {
      const entitled = Number(b.entitled);
      const used = Number(b.used);
      const carried = Number(b.carried);
      const carriedUsed = Number(b.carriedUsed);
      const adjustment = Number(b.adjustment);
      const carriedExpiry = b.carriedExpiry
        ? b.carriedExpiry.toISOString().slice(0, 10)
        : null;
      const carriedExpired =
        carriedExpiry !== null &&
        carriedExpiry < new Date().toISOString().slice(0, 10);
      // Carried bucket sits OUTSIDE the headline entitled-vs-used tally
      // so HR's expiring carry-over doesn't quietly inflate "remaining"
      // for the entitlement column. Employees pick the bucket on the
      // leave request form.
      const carriedRemaining = carriedExpired
        ? 0
        : Math.max(0, carried - carriedUsed);
      return {
        id: b.id,
        leaveType: b.leaveType,
        year: b.year,
        entitled,
        used,
        carried,
        carriedUsed,
        carriedExpiry,
        carriedExpired,
        carriedRemaining,
        adjustment,
        remaining: entitled + adjustment - used,
      };
    });

    // Synthesise zero-used entries for active policies that don't have
    // a LeaveBalance row yet so the UI shows every policy with the
    // policy's daysPerYear as the entitlement instead of an empty list.
    const seen = new Set(stored.map((b) => b.leaveType.id));
    const synthetic = types
      .filter((t) => !seen.has(t.id))
      .map((t) => ({
        id: `synthetic-${targetEmployeeId}-${t.id}-${year}`,
        leaveType: {
          id: t.id,
          name: t.name,
          code: t.code,
          category: t.category,
        },
        year,
        entitled: t.daysPerYear,
        used: 0,
        carried: 0,
        carriedUsed: 0,
        carriedExpiry: null as string | null,
        carriedExpired: false,
        carriedRemaining: 0,
        adjustment: 0,
        remaining: t.daysPerYear,
      }));

    return [...stored, ...synthetic].sort((a, b) =>
      a.leaveType.name.localeCompare(b.leaveType.name),
    );
  }

  /**
   * Direct reports + their per-leave-type balance for the given year.
   * Visible to anyone with `leave:approve` (line manager) or `leave:hr-read`.
   * Non-HR sees only their own direct reports.
   */
  async getTeamBalances(
    managerId: string,
    userPermissions: string[],
    query: TeamBalanceQuery,
  ) {
    const year = query.year ?? new Date().getFullYear();
    const hasHrRead = userPermissions.includes(PERMISSIONS.LEAVE_HR_READ);

    const reports = hasHrRead
      ? await leaveRepository.findAllReportees()
      : await leaveRepository.findDirectReports(managerId);

    const [balances, types] = await Promise.all([
      leaveRepository.findBalancesForEmployees(
        reports.map((r) => r.id),
        year,
      ),
      leaveRepository.findTypesForEntities(reports.map((r) => r.entityId)),
    ]);

    const byEmployee = new Map<string, typeof balances>();
    for (const b of balances) {
      const arr = byEmployee.get(b.employeeId) ?? [];
      arr.push(b);
      byEmployee.set(b.employeeId, arr);
    }

    return reports.map((r) => {
      // Drop balance rows whose leave type belongs to a different entity
      // before merging with synthesised rows — otherwise legacy
      // cross-entity rows surface as duplicate cards alongside the
      // employee's actual policy.
      const existing = (byEmployee.get(r.id) ?? []).filter(
        (b) =>
          b.leaveType.entityId === null || b.leaveType.entityId === r.entityId,
      );
      const seenTypeIds = new Set(existing.map((b) => b.leaveTypeId));

      // Surface every leave type that applies to the employee. If a
      // balance row exists, use it; otherwise synthesize a zero-used
      // entry from the leave type's `daysPerYear` so managers can see
      // the entitlement instead of "No leave balance configured for {year}".
      const applicableTypes = types.filter(
        (t) => t.entityId === null || t.entityId === r.entityId,
      );

      const real = existing.map((b) => {
        const entitled = Number(b.entitled);
        const used = Number(b.used);
        const carried = Number(b.carried);
        const carriedUsed = Number(b.carriedUsed);
        const adjustment = Number(b.adjustment);
        const carriedExpiry = b.carriedExpiry
          ? b.carriedExpiry.toISOString().slice(0, 10)
          : null;
        const carriedExpired =
          carriedExpiry !== null &&
          carriedExpiry < new Date().toISOString().slice(0, 10);
        const carriedRemaining = carriedExpired
          ? 0
          : Math.max(0, carried - carriedUsed);
        return {
          id: b.id,
          leaveType: b.leaveType,
          year: b.year,
          entitled,
          used,
          carried,
          carriedUsed,
          carriedExpiry,
          carriedExpired,
          carriedRemaining,
          adjustment,
          remaining: entitled + adjustment - used,
          synthesized: false,
        };
      });

      const virtual = applicableTypes
        .filter((t) => !seenTypeIds.has(t.id))
        .map((t) => ({
          id: `virtual-${r.id}-${t.id}-${year}`,
          leaveType: {
            id: t.id,
            name: t.name,
            code: t.code,
            category: t.category,
          },
          year,
          entitled: t.daysPerYear,
          used: 0,
          carried: 0,
          carriedUsed: 0,
          carriedExpiry: null as string | null,
          carriedExpired: false,
          carriedRemaining: 0,
          adjustment: 0,
          remaining: t.daysPerYear,
          synthesized: true,
        }));

      return {
        employee: r,
        year,
        balances: [...real, ...virtual].sort((a, b) =>
          a.leaveType.name.localeCompare(b.leaveType.name, undefined, {
            sensitivity: "base",
          }),
        ),
      };
    });
  }

  async getRequests(
    userId: string,
    userPermissions: string[],
    query: LeaveRequestQuery,
  ) {
    const { page, limit, ...filters } = query;
    const hasHrRead = userPermissions.includes(PERMISSIONS.LEAVE_HR_READ);

    if (!hasHrRead) {
      if (filters.employeeId && filters.employeeId !== userId) {
        const reports = await leaveRepository.findDirectReportIds(userId);
        if (!reports.includes(filters.employeeId)) {
          throw new ForbiddenException(
            "You can only filter leave requests for yourself or your direct reports",
          );
        }
      }
    }

    const { data, total } = await leaveRepository.findRequests(
      {
        ...filters,
        ...(!hasHrRead ? { managerScopeUserId: userId } : {}),
      },
      page,
      limit,
    );

    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getRequestById(
    requestId: string,
    userId: string,
    userPermissions: string[],
  ) {
    const request = await leaveRepository.findRequestById(requestId);
    if (!request) {
      throw new NotFoundException("Leave request not found");
    }

    const hasHrRead = userPermissions.includes(PERMISSIONS.LEAVE_HR_READ);
    if (!hasHrRead && request.employeeId !== userId) {
      const reports = await leaveRepository.findDirectReportIds(userId);
      if (!reports.includes(request.employeeId)) {
        throw new ForbiddenException(
          "You can only view leave requests for yourself or your direct reports",
        );
      }
    }

    return request;
  }

  async createRequest(
    actorId: string,
    userPermissions: string[],
    input: CreateLeaveRequestInput,
  ) {
    const rawTarget = input.employeeId?.trim();
    const forOtherEmployee =
      rawTarget !== undefined && rawTarget !== "" && rawTarget !== actorId;

    const hasRequest = userPermissions.includes(PERMISSIONS.LEAVE_REQUEST);
    const hasOnBehalf = userPermissions.includes(
      PERMISSIONS.LEAVE_HR_ON_BEHALF,
    );

    let employeeId: string;
    if (forOtherEmployee) {
      if (!hasOnBehalf) {
        throw new ForbiddenException(
          "No permission to submit leave on behalf of another employee",
        );
      }
      employeeId = rawTarget;
    } else {
      if (!hasRequest) {
        throw new ForbiddenException(
          "No permission to submit your own leave request",
        );
      }
      employeeId = actorId;
    }

    const startDate = new Date(input.startDate);
    const endDate = new Date(input.endDate);
    const durationType = input.durationType ?? "full_day";

    let days: number;
    if (durationType === "half_day") {
      if (input.startDate !== input.endDate) {
        throw new BadRequestException("Half-day leave must use a single date");
      }
      const weekday = startDate.getDay();
      if (weekday === 0 || weekday === 6) {
        throw new BadRequestException(
          "Half-day leave cannot fall on a weekend",
        );
      }
      days = 0.5;
    } else {
      days = countBusinessDays(startDate, endDate);
      if (days <= 0) {
        throw new BadRequestException(
          "Selected date range contains no business days",
        );
      }
    }

    const leaveType = (await leaveRepository.findTypes()).find(
      (t) => t.id === input.leaveTypeId,
    );
    if (!leaveType) {
      throw new NotFoundException("Leave type not found");
    }

    const targetUser = await leaveRepository.findUserById(employeeId);
    if (!targetUser) {
      throw new NotFoundException("Employee not found");
    }
    if (!targetUser.isActive) {
      throw new BadRequestException("Employee account is not active");
    }

    if (forOtherEmployee) {
      const actor = await leaveRepository.findUserById(actorId);
      const actorEntity = actor?.entityId ?? null;
      const targetEntity = targetUser.entityId ?? null;
      if (actorEntity !== null && targetEntity !== actorEntity) {
        throw new ForbiddenException(
          "You can only submit leave on behalf of employees in your entity",
        );
      }
    }

    const year = startDate.getFullYear();
    const balance = await leaveRepository.findBalance(
      employeeId,
      input.leaveTypeId,
      year,
    );

    if (balance) {
      if (input.source === "carried") {
        const carried = Number(balance.carried);
        const carriedUsed = Number(balance.carriedUsed);
        const expiry = balance.carriedExpiry
          ? balance.carriedExpiry.toISOString().slice(0, 10)
          : null;
        const today = new Date().toISOString().slice(0, 10);
        if (expiry !== null && expiry < today) {
          throw new BadRequestException(
            `Carried leave expired on ${expiry}. Submit against the entitled bucket instead.`,
          );
        }
        const carriedRemaining = Math.max(0, carried - carriedUsed);
        if (days > carriedRemaining) {
          throw new BadRequestException(
            `Insufficient carried leave. Available: ${carriedRemaining} day(s), requested: ${days} day(s)`,
          );
        }
      } else {
        const available =
          Number(balance.entitled) +
          Number(balance.adjustment) -
          Number(balance.used);
        if (days > available) {
          throw new BadRequestException(
            `Insufficient leave balance. Available: ${available} day(s), requested: ${days} day(s)`,
          );
        }
      }
    } else if (input.source === "carried") {
      throw new BadRequestException(
        "No carried balance available for this leave type — submit against the entitled bucket.",
      );
    }

    const overlap = await leaveRepository.checkOverlap(
      employeeId,
      startDate,
      endDate,
    );
    if (overlap) {
      throw new ConflictException(
        "This employee already has a leave request overlapping with these dates",
      );
    }

    const created = await leaveRepository.createRequest({
      employeeId,
      leaveTypeId: input.leaveTypeId,
      entityId: targetUser.entityId,
      startDate,
      endDate,
      days,
      durationType,
      halfDayPeriod:
        durationType === "half_day" ? (input.halfDayPeriod ?? null) : null,
      reason: input.reason,
      source: input.source,
    });

    // Snapshot the resolved approval chain (per-policy → global → manager)
    // so later chain edits can't rewrite in-flight requests. Same pattern
    // as travel / expense chains.
    const decisionRows = await this.snapshotApprovalDecisions(
      created.id,
      employeeId,
      input.leaveTypeId,
      days,
    );
    await leaveRepository.updateRequestStepOrder(created.id, 1);

    try {
      const trackingActor = await actorFromId(actorId);
      if (trackingActor) {
        trackLeaveRequestSubmittedServer(trackingActor, {
          leave_type_code: leaveType.code,
          days,
          is_self: !forOtherEmployee,
        });
      }
    } catch {
      // analytics is best-effort
    }

    // Leave-submit heads-up goes to the resolved first approver of the
    // snapshotted chain: a specific-user first step emails that user; a
    // manager step emails the submitter's line manager. WFH is routed like
    // any other leave type (its legacy executive-line fan-out was removed).
    await this.notifyFirstApprover(decisionRows[0], targetUser, {
      leaveTypeName: leaveType.name,
      startDate,
      endDate,
      reason: input.reason ?? "",
    });

    // Submitter confirmation — they should know the request landed
    // and who's been looped in, not just hear back when it's
    // approved / rejected days later.
    if (targetUser.email) {
      const email = leaveSubmittedConfirmationEmail({
        employeeName: targetUser.name,
        leaveType: leaveType.name,
        startDate: fmtDate(startDate),
        endDate: fmtDate(endDate),
        days,
        reason: input.reason ?? null,
        portalUrl: `${PORTAL_URL}/leave`,
      });
      void sendEmail({ to: targetUser.email, ...email });
    }

    // HR-desk fan-out on submit. The same admin-managed recipients
    // that get the approved-summary email now also get a "submitted"
    // FYI so HR (Sara, Pat, …) are looped in before approval, not
    // only after. Wrapped in try/catch so a mail-server hiccup
    // doesn't blow up the submission itself.
    try {
      const deskRecipients = filterExcludedLeaveRecipients(
        await loadLeaveNotificationRecipients(),
      );
      if (deskRecipients.length > 0) {
        const submitter = await prisma.user.findUnique({
          where: { id: employeeId },
          select: {
            department: true,
            entity: { select: { name: true } },
          },
        });
        const deskEmail = leaveSubmittedDeskEmail({
          employeeName: targetUser.name,
          employeeEmail: targetUser.email,
          department: submitter?.department ?? null,
          entity: submitter?.entity?.name ?? null,
          leaveType: leaveType.name,
          startDate: fmtDate(startDate),
          endDate: fmtDate(endDate),
          days,
          reason: input.reason ?? null,
          portalUrl: `${PORTAL_URL}/leave`,
        });
        void sendEmail({ to: deskRecipients, ...deskEmail });
      }
    } catch {
      // best-effort
    }

    return created;
  }

  // Build the per-request chain snapshot. Resolution precedence:
  //   1. the leave type's own approver chain (LeavePolicyApprover), if any;
  //   2. else the org-wide default chain (LeaveApprovalStep);
  //   3. else a single "manager" step.
  // Steps are filtered by `stepApplies` (submitter gating + day band). A
  // per-policy chain whose rows all filter out for this submitter/day-count
  // falls back to the single manager step (NOT the global chain) — a
  // configured per-policy chain fully overrides the org default.
  private async snapshotApprovalDecisions(
    requestId: string,
    submitterId: string,
    leaveTypeId: string,
    days: number,
  ) {
    const ctx = { submitterId, days };

    const policySteps = await leaveRepository.findApprovers(leaveTypeId);
    let applicableSteps: Array<{
      name?: string;
      approverType: string;
      approverUserId: string | null;
    }>;

    if (policySteps.length > 0) {
      applicableSteps = policySteps
        .filter((s) => stepApplies(s, ctx))
        .map((s, idx) => ({
          name: `Step ${idx + 1} — ${
            s.approverType === "manager" ? "Manager" : "Approver"
          }`,
          approverType: s.approverType,
          approverUserId: s.approverUserId,
        }));
    } else {
      const globalSteps = await leaveRepository.findApprovalSteps({
        activeOnly: true,
      });
      applicableSteps = globalSteps
        .filter((s) => stepApplies(s, ctx))
        .map((s) => ({
          name: s.name,
          approverType: s.approverType,
          approverUserId: s.approverUserId,
        }));
    }

    const decisionRows =
      applicableSteps.length > 0
        ? applicableSteps.map((s, idx) => ({
            order: idx + 1,
            name: s.name ?? `Step ${idx + 1}`,
            approverType: s.approverType,
            approverUserId: s.approverType === "user" ? s.approverUserId : null,
          }))
        : [
            {
              order: 1,
              name: "Manager approval",
              approverType: "manager" as const,
              approverUserId: null,
            },
          ];
    await leaveRepository.deleteDecisionsForRequest(requestId);
    await leaveRepository.createDecisions(requestId, decisionRows);
    return decisionRows;
  }

  // Email the resolved approver of the first (pending) decision step on
  // submit. `user` → that specific user; `manager` → the submitter's
  // reportingTo. Logs and no-ops when no approver can be resolved (e.g. a
  // manager step for a submitter with no reportingTo) so the gap is
  // observable rather than silent.
  private async notifyFirstApprover(
    first: { approverType: string; approverUserId: string | null } | undefined,
    submitter: { name: string; reportingTo: string | null },
    details: {
      leaveTypeName: string;
      startDate: Date;
      endDate: Date;
      reason: string;
    },
  ) {
    if (!first) return;
    let approverEmail: string | null | undefined;
    let approverName: string | undefined;
    if (first.approverType === "user" && first.approverUserId) {
      const approver = await leaveRepository.findUserById(first.approverUserId);
      approverEmail = approver?.email;
      approverName = approver?.name;
    } else if (first.approverType === "manager" && submitter.reportingTo) {
      const manager = await leaveRepository.findUserById(submitter.reportingTo);
      approverEmail = manager?.email;
      approverName = manager?.name;
    }
    if (!approverEmail) {
      logger.warn("leave submit: no resolvable first approver to notify", {
        approverType: first.approverType,
        approverUserId: first.approverUserId,
        submitterReportingTo: submitter.reportingTo,
      });
      return;
    }
    const email = leaveSubmittedEmail({
      approverName: approverName ?? "Approver",
      employeeName: submitter.name,
      leaveType: details.leaveTypeName,
      startDate: fmtDate(details.startDate),
      endDate: fmtDate(details.endDate),
      reason: details.reason,
      portalUrl: `${PORTAL_URL}/leave`,
    });
    void sendEmail({ to: approverEmail, ...email });
  }

  // ── Approval chain admin ────────────────────────────────

  async listApprovalSteps() {
    return leaveRepository.findApprovalSteps();
  }

  async createApprovalStep(input: CreateLeaveApprovalStepInput) {
    const nextOrder = await leaveRepository.nextApprovalStepOrder();
    return leaveRepository.createApprovalStep({
      order: nextOrder,
      name: input.name,
      description: input.description ?? null,
      approverType: input.approverType,
      ...(input.approverType === "user" && input.approverUserId
        ? { approverUser: { connect: { id: input.approverUserId } } }
        : {}),
      skipWhenSubmitterIds: input.skipWhenSubmitterIds,
      onlyWhenSubmitterIds: input.onlyWhenSubmitterIds,
      isActive: input.isActive,
    });
  }

  async updateApprovalStep(id: string, input: UpdateLeaveApprovalStepInput) {
    const existing = await leaveRepository.findApprovalStepById(id);
    if (!existing) throw new NotFoundException("Approval step not found");
    const data: Parameters<typeof leaveRepository.updateApprovalStep>[1] = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) {
      data.description = input.description ?? null;
    }
    if (input.approverType !== undefined) {
      data.approverType = input.approverType;
    }
    if (input.approverType === "manager") {
      data.approverUser = { disconnect: true };
    } else if (input.approverUserId !== undefined) {
      data.approverUser = input.approverUserId
        ? { connect: { id: input.approverUserId } }
        : { disconnect: true };
    }
    if (input.skipWhenSubmitterIds !== undefined) {
      data.skipWhenSubmitterIds = input.skipWhenSubmitterIds;
    }
    if (input.onlyWhenSubmitterIds !== undefined) {
      data.onlyWhenSubmitterIds = input.onlyWhenSubmitterIds;
    }
    if (input.isActive !== undefined) data.isActive = input.isActive;
    return leaveRepository.updateApprovalStep(id, data);
  }

  async deleteApprovalStep(id: string) {
    const existing = await leaveRepository.findApprovalStepById(id);
    if (!existing) throw new NotFoundException("Approval step not found");
    return leaveRepository.deleteApprovalStep(id);
  }

  async reorderApprovalSteps(input: ReorderLeaveApprovalStepsInput) {
    return leaveRepository.reorderApprovalSteps(input.orderedIds);
  }

  async getNotificationRecipients() {
    return { emails: await loadLeaveNotificationRecipients() };
  }

  async setNotificationRecipients(rawEmails: string[]) {
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const raw of rawEmails) {
      const trimmed = raw.trim().toLowerCase();
      if (!trimmed) continue;
      if (!isValidEmail(trimmed)) {
        throw new BadRequestException(`Invalid email: ${raw}`);
      }
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      cleaned.push(trimmed);
    }
    await prisma.systemSetting.upsert({
      where: { key: LEAVE_NOTIFICATION_KEY },
      update: { value: cleaned },
      create: { key: LEAVE_NOTIFICATION_KEY, value: cleaned },
    });
    return { emails: cleaned };
  }

  private async assertCanApproveOrReject(
    request: NonNullable<
      Awaited<ReturnType<typeof leaveRepository.findRequestById>>
    >,
    approverId: string,
    userPermissions: string[],
  ): Promise<void> {
    const isHr = userPermissions.includes(PERMISSIONS.LEAVE_HR_READ);
    if (isHr) return;

    const canApproveWfh = userPermissions.includes(
      PERMISSIONS.LEAVE_APPROVE_WFH,
    );
    const isWfh = request.leaveType.code === "WFH";

    if (isWfh && canApproveWfh) return;

    const delegatedId = request.delegatedToId;
    const managerId = request.employee.reportingTo;

    if (delegatedId) {
      if (approverId !== delegatedId && approverId !== managerId) {
        throw new ForbiddenException(
          "Only the delegated approver or the employee's direct manager can act on this request",
        );
      }
      return;
    }

    // Org-wide approval-chain snapshot takes precedence when present.
    // The decision row for the current step says who can act now;
    // submitter's manager is always allowed as a parallel approver so
    // stale snapshots (chain edited mid-flight) don't strand requests.
    const decisions = await leaveRepository.findDecisions(request.id);
    if (decisions.length > 0) {
      const current =
        decisions.find(
          (d) =>
            d.order === (request.currentStepOrder ?? decisions[0]?.order ?? 1),
        ) ?? null;
      if (current && current.status === "pending") {
        if (current.approverType === "user") {
          if (current.approverUserId === approverId) return;
        } else if (current.approverType === "manager") {
          if (managerId && managerId === approverId) return;
        }
      }
      // Parallel fallback: submitter's direct manager always allowed.
      if (managerId && managerId === approverId) return;
      throw new ForbiddenException(
        "You are not the assigned approver for this stage",
      );
    }

    // Legacy paths — no chain snapshot exists. Per-policy approver list
    // (set on the LeaveType) takes priority, otherwise fall back to the
    // submitter's direct manager.
    const policyApprovers = await leaveRepository.findApprovers(
      request.leaveTypeId,
    );
    if (policyApprovers.length > 0) {
      const allowed = new Set<string>();
      for (const a of policyApprovers) {
        if (a.approverType === "manager" && managerId) allowed.add(managerId);
        if (a.approverType === "user" && a.approverUserId) {
          allowed.add(a.approverUserId);
        }
      }
      if (allowed.has(approverId)) return;
      throw new ForbiddenException(
        "You are not configured as an approver for this leave policy",
      );
    }

    if (isWfh) {
      throw new ForbiddenException(
        "WFH requests must be approved by a user with leave:approve-wfh (executive line)",
      );
    }

    if (!managerId || approverId !== managerId) {
      throw new ForbiddenException(
        "Only the employee's direct manager can approve or reject this request",
      );
    }
  }

  async getCalendar(
    userId: string,
    userPermissions: string[],
    query: LeaveCalendarQuery,
  ) {
    const hasHrRead = userPermissions.includes(PERMISSIONS.LEAVE_HR_READ);
    const from = new Date(query.from);
    const to = new Date(query.to);
    const rows = await leaveRepository.findCalendarRows(
      from,
      to,
      query.department,
    );

    if (!hasHrRead) {
      const reportIds = await leaveRepository.findDirectReportIds(userId);
      const allowed = new Set<string>([userId, ...reportIds]);
      return {
        data: rows.filter((r) => allowed.has(r.employeeId)),
      };
    }

    return { data: rows };
  }

  async getAnalytics(
    userId: string,
    userPermissions: string[],
    query: LeaveAnalyticsQuery,
  ) {
    const year = query.year ?? new Date().getFullYear();
    const hasHrRead = userPermissions.includes(PERMISSIONS.LEAVE_HR_READ);
    const start = new Date(year, 0, 1);
    const end = new Date(year, 11, 31, 23, 59, 59, 999);

    const baseWhere = {
      createdAt: { gte: start, lte: end },
      ...(hasHrRead ? {} : { employeeId: userId }),
    };

    const [byStatus, byType] = await Promise.all([
      prisma.leaveRequest.groupBy({
        by: ["status"],
        where: baseWhere,
        _count: { _all: true },
      }),
      prisma.leaveRequest.groupBy({
        by: ["leaveTypeId"],
        where: baseWhere,
        _count: { _all: true },
      }),
    ]);

    const typeIds = byType.map((b) => b.leaveTypeId);
    const types = await prisma.leaveType.findMany({
      where: { id: { in: typeIds } },
      select: { id: true, name: true, code: true },
    });
    const typeNameById = new Map(types.map((t) => [t.id, t.name]));

    return {
      data: {
        year,
        byStatus: byStatus.map((r) => ({
          status: r.status,
          count: r._count._all,
        })),
        byLeaveType: byType.map((r) => ({
          leaveTypeId: r.leaveTypeId,
          leaveTypeName: typeNameById.get(r.leaveTypeId) ?? r.leaveTypeId,
          count: r._count._all,
        })),
      },
    };
  }

  async getBalanceTransactions(
    userId: string,
    userPermissions: string[],
    employeeId: string,
    year: number,
    leaveTypeId?: string,
  ) {
    const hasHrRead = userPermissions.includes(PERMISSIONS.LEAVE_HR_READ);
    if (employeeId !== userId && !hasHrRead) {
      const reports = await leaveRepository.findDirectReportIds(userId);
      if (!reports.includes(employeeId)) {
        throw new ForbiddenException(
          "You can only view balance transactions for yourself or your direct reports",
        );
      }
    }

    const transactions = await leaveRepository.findBalanceTransactions(
      employeeId,
      year,
      leaveTypeId,
    );
    // `amount` is Decimal — Prisma serialises those as strings over JSON,
    // so normalise to a number the way the balance endpoints do.
    return {
      data: transactions.map((t) => ({ ...t, amount: Number(t.amount) })),
    };
  }

  /**
   * Balances whose stored `used` counter disagrees with the sum of the
   * employee's visible approved requests.
   *
   * `LeaveBalance.used` is a stored counter with three independent
   * writers (approval, refund, HR manual/bulk overwrite) and nothing
   * recomputes it, so it can drift from the request list silently — the
   * employee sees one number on the balance card and a different total
   * in "My requests", and the first anyone hears of it is a complaint.
   * This is the read model that surfaces it instead.
   *
   * Each row carries the likely cause alongside the delta:
   * - `deletedApprovedDays` — days sitting on soft-deleted approved
   *   requests. Before #1118 those were never refunded, so they are the
   *   classic source of a card reading high.
   * - `undeductedApprovedDays` — visible approved days NOT flagged
   *   `balanceDeducted`, i.e. the opposite error: approved but never
   *   charged.
   * - `ledgerRowCount` — how many times HR wrote to this balance by
   *   hand or by xlsx import. Zero means no human touched it, so the
   *   drift is code-caused and safe to correct mechanically. Non-zero
   *   means ask HR before touching it.
   *
   * `ledgerDelta` is reported but deliberately NOT subtracted from the
   * drift: `manual_adjustment` rows written before #1118 recorded the
   * change to `entitled`, not to `used`, so summing across the boundary
   * mixes two meanings. Treat the count as the signal and the delta as
   * indicative.
   */
  async getBalanceDrift(year?: number) {
    const scopedYear = year ?? null;
    const [rows, scanned] = await Promise.all([
      leaveRepository.findBalanceDrift(scopedYear),
      leaveRepository.countBalances(scopedYear),
    ]);

    const data = rows.map((r) => ({
      balanceId: r.balance_id,
      employee: {
        id: r.employee_id,
        name: r.employee_name,
        email: r.employee_email,
      },
      leaveType: { id: r.leave_type_id, name: r.leave_type_name },
      year: r.year,
      entitled: r.entitled,
      used: r.used,
      carriedUsed: r.carried_used,
      approvedDays: r.approved_days,
      approvedCarriedDays: r.approved_carried_days,
      drift: r.drift,
      carriedDrift: r.carried_drift,
      deletedApprovedDays: r.deleted_approved_days,
      undeductedApprovedDays: r.undeducted_approved_days,
      ledgerRowCount: r.ledger_row_count,
      ledgerDelta: r.ledger_delta,
    }));

    return {
      data,
      meta: {
        year: scopedYear,
        scanned,
        drifted: data.length,
        // Drift on a balance no human ever edited is code-caused, so it
        // is the subset a mechanical repair can safely take.
        untouchedByHr: data.filter((r) => r.ledgerRowCount === 0).length,
      },
    };
  }

  async previewApprovers(
    employeeId: string,
    actorId: string,
    userPermissions: string[],
  ) {
    const hasHrRead = userPermissions.includes(PERMISSIONS.LEAVE_HR_READ);
    if (employeeId !== actorId) {
      if (!hasHrRead) {
        const reports = await leaveRepository.findDirectReportIds(actorId);
        if (!reports.includes(employeeId)) {
          throw new ForbiddenException(
            "You can only preview approvers for yourself or your direct reports",
          );
        }
      }
    }

    const chain: Array<{
      step: number;
      userId: string;
      name: string;
      email: string | null;
      role: string;
    }> = [];

    let currentEmployeeId = employeeId;
    for (let step = 0; step < 6; step++) {
      const emp = await leaveRepository.findUserById(currentEmployeeId);
      if (!emp?.reportingTo) break;
      const mgr = await leaveRepository.findUserById(emp.reportingTo);
      if (!mgr) break;
      chain.push({
        step: step + 1,
        userId: mgr.id,
        name: mgr.name,
        email: mgr.email,
        role: step === 0 ? "manager" : "upline",
      });
      currentEmployeeId = mgr.id;
    }

    return { data: chain };
  }

  async forwardRequest(
    requestId: string,
    actorId: string,
    userPermissions: string[],
    input: ForwardLeaveRequestInput,
  ) {
    const request = await leaveRepository.findRequestById(requestId);
    if (!request) throw new NotFoundException("Leave request not found");
    if (request.status !== "pending") {
      throw new BadRequestException(
        `Cannot forward a request with status "${request.status}"`,
      );
    }

    const managerId = request.employee.reportingTo;
    const isHr = userPermissions.includes(PERMISSIONS.LEAVE_HR_READ);
    if (!isHr) {
      if (!managerId || actorId !== managerId) {
        throw new ForbiddenException(
          "Only the employee's direct manager can forward this request",
        );
      }
    }

    const delegate = await leaveRepository.findUserById(input.delegateUserId);
    if (!delegate?.isActive) {
      throw new BadRequestException("Delegate user not found or inactive");
    }
    if (delegate.id === request.employeeId) {
      throw new BadRequestException("Cannot delegate approval to the employee");
    }

    const employee = await leaveRepository.findUserById(request.employeeId);
    if (
      employee?.entityId &&
      delegate.entityId &&
      employee.entityId !== delegate.entityId
    ) {
      throw new BadRequestException(
        "Delegate should belong to the same entity as the employee",
      );
    }

    await leaveRepository.updateRequest(requestId, {
      delegatedToId: input.delegateUserId,
    });

    const actor = await leaveRepository.findUserById(actorId);
    if (delegate.email) {
      const email = leaveForwardedEmail({
        delegateName: delegate.name,
        forwardedByName: actor?.name ?? "Manager",
        employeeName: request.employee.name,
        leaveType: request.leaveType.name,
        startDate: fmtDate(request.startDate),
        endDate: fmtDate(request.endDate),
        portalUrl: `${PORTAL_URL}/leave`,
      });
      void sendEmail({ to: delegate.email, ...email });
    }

    return leaveRepository.findRequestById(requestId);
  }

  async processEscalationReminders(): Promise<{ reminded: number }> {
    const stale = await leaveRepository.findPendingForReminder(72, 24, 3);
    let reminded = 0;
    for (const req of stale) {
      const mgrId = req.employee.reportingTo;
      if (!mgrId) continue;
      const manager = await leaveRepository.findUserById(mgrId);
      if (!manager?.email) continue;

      const nextCount = req.reminderCount + 1;
      await leaveRepository.updateRequest(req.id, {
        reminderCount: nextCount,
        lastReminderAt: new Date(),
      });

      const email = leaveEscalationReminderEmail({
        approverName: manager.name,
        employeeName: req.employee.name,
        leaveType: req.leaveType.name,
        startDate: fmtDate(req.startDate),
        endDate: fmtDate(req.endDate),
        portalUrl: `${PORTAL_URL}/leave`,
        reminderCount: nextCount,
      });
      void sendEmail({ to: manager.email, ...email });
      reminded++;
    }
    return { reminded };
  }

  async approveRequest(
    requestId: string,
    approverId: string,
    userPermissions: string[],
  ) {
    const request = await leaveRepository.findRequestById(requestId);
    if (!request) {
      throw new NotFoundException("Leave request not found");
    }
    if (request.status !== "pending") {
      throw new BadRequestException(
        `Cannot approve a request with status "${request.status}"`,
      );
    }

    await this.assertCanApproveOrReject(request, approverId, userPermissions);

    // Advance the chain. Lazy-snapshot for legacy rows that pre-date
    // the chain landing, so older requests still flow through.
    let decisions = await leaveRepository.findDecisions(requestId);
    if (decisions.length === 0) {
      await this.snapshotApprovalDecisions(
        requestId,
        request.employeeId,
        request.leaveTypeId,
        Number(request.days),
      );
      await leaveRepository.updateRequestStepOrder(requestId, 1);
      decisions = await leaveRepository.findDecisions(requestId);
    }
    const currentOrder = request.currentStepOrder ?? decisions[0]?.order ?? 1;
    const current = decisions.find((d) => d.order === currentOrder) ?? null;

    const remainingPending = decisions.filter(
      (d) => d.order > currentOrder && d.status === "pending",
    );
    const isFinalStep = remainingPending.length === 0;

    const year = request.startDate.getFullYear();
    const days = Number(request.days);
    const source = (request.source === "carried" ? "carried" : "entitled") as
      "entitled" | "carried";

    const result = await prisma.$transaction(async (tx) => {
      if (current && current.status === "pending") {
        await tx.leaveApprovalDecision.update({
          where: { id: current.id },
          data: {
            status: "approved",
            decidedById: approverId,
            decidedAt: new Date(),
          },
        });
      }

      if (isFinalStep) {
        // `status: "pending"` in the where clause makes this a
        // compare-and-swap: the pre-flight guard above read the row
        // outside any transaction, so two concurrent approvals could
        // both pass it. Only one can flip the row here; the loser
        // matches nothing and Prisma raises P2025, which we translate
        // to a 409 below. Without this the balance was decremented
        // once per racing call.
        const r = await claimPendingRequest(tx, requestId, {
          status: "approved",
          approvedBy: approverId,
          approvedAt: new Date(),
          currentStepOrder: null,
          balanceDeducted: true,
        });

        // Mutate balance only after the *whole* chain approves so a
        // mid-chain reject doesn't have to claw back balance. Bucket
        // (`entitled` vs `carried`) comes from the request.source set
        // at create time — main's #362 carried-bucket support. Both
        // writes ride the same transaction as the status flip, so a
        // failure here can no longer leave a request approved with its
        // days never deducted.
        await leaveRepository.updateBalance(
          request.employeeId,
          request.leaveTypeId,
          year,
          days,
          source,
          tx,
        );

        await leaveRepository.createBalanceTransaction(
          {
            employeeId: request.employeeId,
            leaveTypeId: request.leaveTypeId,
            year,
            type: source === "carried" ? "used_carried" : "used",
            amount: days,
            description: `Leave approved (${source}): ${fmtDate(request.startDate)} – ${fmtDate(request.endDate)}`,
            referenceId: requestId,
          },
          tx,
        );

        return r;
      }

      const r = await claimPendingRequest(tx, requestId, {
        currentStepOrder: remainingPending[0]!.order,
      });
      return r;
    });

    if (isFinalStep) {
      const approver = await leaveRepository.findUserById(approverId);
      const email = leaveApprovedEmail({
        employeeName: request.employee.name,
        leaveType: request.leaveType.name,
        startDate: fmtDate(request.startDate),
        endDate: fmtDate(request.endDate),
        approverName: approver?.name ?? "Your Manager",
        portalUrl: `${PORTAL_URL}/leave`,
      });
      void sendEmail({ to: request.employee.email, ...email });

      // HR-desk long-form summary on final approval. Admin-managed
      // recipients receive a one-row summary email so HR can act on the
      // approved leave without opening the portal. Wrapped in try/catch
      // so a missing template / mail-server hiccup doesn't roll back
      // the approval itself.
      try {
        const deskRecipients = filterExcludedLeaveRecipients(
          await loadLeaveNotificationRecipients(),
        );
        if (deskRecipients.length > 0) {
          const employee = await prisma.user.findUnique({
            where: { id: request.employeeId },
            select: {
              department: true,
              entity: { select: { name: true } },
            },
          });
          const deskEmail = leaveDeskSummaryEmail({
            employeeName: request.employee.name,
            employeeEmail: request.employee.email,
            department: employee?.department ?? null,
            entity: employee?.entity?.name ?? null,
            leaveType: request.leaveType.name,
            startDate: fmtDate(request.startDate),
            endDate: fmtDate(request.endDate),
            days,
            reason: request.reason ?? null,
            approverName: approver?.name ?? "Your Manager",
            portalUrl: `${PORTAL_URL}/leave`,
          });
          void sendEmail({ to: deskRecipients, ...deskEmail });
        }
      } catch {
        // best-effort
      }
    } else {
      // Mid-chain: notify the next approver if they're a specific user.
      // Manager-step routing has no single email to target without
      // re-resolving the submitter's reportingTo each time, so we keep
      // it simple and skip the courtesy mail for that case.
      const next = remainingPending[0]!;
      if (next.approverType === "user" && next.approverUserId) {
        const nextUser = await leaveRepository.findUserById(
          next.approverUserId,
        );
        if (nextUser?.email) {
          const email = leaveSubmittedEmail({
            approverName: nextUser.name,
            employeeName: request.employee.name,
            leaveType: request.leaveType.name,
            startDate: fmtDate(request.startDate),
            endDate: fmtDate(request.endDate),
            reason: request.reason ?? "",
            portalUrl: `${PORTAL_URL}/leave`,
          });
          void sendEmail({ to: nextUser.email, ...email });
        }
      }
    }

    try {
      const actor = await actorFromId(approverId);
      if (actor) {
        trackLeaveRequestApproved(actor, {
          leave_request_id: requestId,
        });
      }
    } catch {
      // analytics is best-effort
    }

    return result;
  }

  async rejectRequest(
    requestId: string,
    approverId: string,
    reason: string,
    userPermissions: string[],
  ) {
    const request = await leaveRepository.findRequestById(requestId);
    if (!request) {
      throw new NotFoundException("Leave request not found");
    }
    if (request.status !== "pending") {
      throw new BadRequestException(
        `Cannot reject a request with status "${request.status}"`,
      );
    }

    await this.assertCanApproveOrReject(request, approverId, userPermissions);

    // Mark the current snapshot decision rejected (audit trail) before
    // flipping the request itself. Lazy-snapshot for legacy rows.
    let decisions = await leaveRepository.findDecisions(requestId);
    if (decisions.length === 0) {
      await this.snapshotApprovalDecisions(
        requestId,
        request.employeeId,
        request.leaveTypeId,
        Number(request.days),
      );
      await leaveRepository.updateRequestStepOrder(requestId, 1);
      decisions = await leaveRepository.findDecisions(requestId);
    }
    const currentOrder = request.currentStepOrder ?? decisions[0]?.order ?? 1;
    const current = decisions.find((d) => d.order === currentOrder) ?? null;
    if (current && current.status === "pending") {
      await leaveRepository.updateDecision(current.id, {
        status: "rejected",
        decidedBy: { connect: { id: approverId } },
        decidedAt: new Date(),
        notes: reason,
      });
    }

    const result = await leaveRepository.updateRequestStatus(requestId, {
      status: "rejected",
      approvedBy: approverId,
      approvedAt: new Date(),
      rejectReason: reason,
    });
    await leaveRepository.updateRequestStepOrder(requestId, null);

    const approver = await leaveRepository.findUserById(approverId);
    const email = leaveRejectedEmail({
      employeeName: request.employee.name,
      leaveType: request.leaveType.name,
      startDate: fmtDate(request.startDate),
      endDate: fmtDate(request.endDate),
      approverName: approver?.name ?? "Your Manager",
      rejectionReason: reason,
      portalUrl: `${PORTAL_URL}/leave`,
    });
    void sendEmail({ to: request.employee.email, ...email });

    try {
      const actor = await actorFromId(approverId);
      if (actor) {
        trackLeaveRequestRejected(actor, { leave_request_id: requestId });
      }
    } catch {
      // analytics is best-effort
    }

    return result;
  }

  /**
   * Give back the days an approved leave drew down at final approval.
   * Mirrors the deduction in the approval final-step (updateBalance with
   * +days, transaction type `used`) with the opposite sign, and writes a
   * refund BalanceTransaction so the employee's balance history stays
   * auditable.
   *
   * Guarded on `balanceDeducted`, so it is idempotent: calling it for a
   * request whose days are not currently drawn down (a pending request,
   * or one already refunded by an earlier cancel) is a no-op. That is
   * what lets the cancel, cancellation-approval, soft-delete and
   * permanent-delete paths all call it without any of them handing the
   * employee free days.
   */
  private async refundLeaveBalance(
    request: NonNullable<
      Awaited<ReturnType<typeof leaveRepository.findRequestById>>
    >,
    context: "cancellation" | "deletion" = "cancellation",
  ) {
    if (!request.balanceDeducted) return;

    const year = request.startDate.getFullYear();
    const days = Number(request.days);
    const source = (request.source === "carried" ? "carried" : "entitled") as
      "entitled" | "carried";
    const prefix =
      context === "deletion" ? "deletion_refund" : "cancellation_refund";
    const verb = context === "deletion" ? "deleted" : "cancelled";

    await leaveRepository.updateBalance(
      request.employeeId,
      request.leaveTypeId,
      year,
      -days,
      source,
    );
    await leaveRepository.createBalanceTransaction({
      employeeId: request.employeeId,
      leaveTypeId: request.leaveTypeId,
      year,
      type: source === "carried" ? `${prefix}_carried` : prefix,
      amount: -days,
      description: `Leave ${verb} (${source}): ${fmtDate(request.startDate)} – ${fmtDate(request.endDate)}`,
      referenceId: request.id,
    });
    await leaveRepository.setBalanceDeducted(request.id, false);
  }

  /**
   * Re-draw the days for a request whose refund is being undone — today
   * only the restore-a-soft-deleted-approved-request path. The inverse
   * of refundLeaveBalance, and guarded the same way so restoring twice
   * cannot charge the employee twice.
   */
  private async deductLeaveBalance(
    request: NonNullable<
      Awaited<
        ReturnType<typeof leaveRepository.findRequestByIdIncludingDeleted>
      >
    >,
  ) {
    if (request.balanceDeducted) return;

    const year = request.startDate.getFullYear();
    const days = Number(request.days);
    const source = (request.source === "carried" ? "carried" : "entitled") as
      "entitled" | "carried";

    await leaveRepository.updateBalance(
      request.employeeId,
      request.leaveTypeId,
      year,
      days,
      source,
    );
    await leaveRepository.createBalanceTransaction({
      employeeId: request.employeeId,
      leaveTypeId: request.leaveTypeId,
      year,
      type: source === "carried" ? "used_carried" : "used",
      amount: days,
      description: `Leave restored (${source}): ${fmtDate(request.startDate)} – ${fmtDate(request.endDate)}`,
      referenceId: request.id,
    });
    await leaveRepository.setBalanceDeducted(request.id, true);
  }

  async cancelRequest(requestId: string, userId: string) {
    const request = await leaveRepository.findRequestById(requestId);
    if (!request) {
      throw new NotFoundException("Leave request not found");
    }
    if (request.employeeId !== userId) {
      throw new ForbiddenException("You can only cancel your own requests");
    }
    if (request.status !== "pending" && request.status !== "approved") {
      throw new BadRequestException(
        `Cannot cancel a request with status "${request.status}"`,
      );
    }

    // Instant self-cancel (product decision 2026-06-03): an employee can
    // pull back their own leave without a second approval round. An
    // approved request already drew its days down at final approval, so
    // cancelling refunds the balance immediately; a pending request was
    // never deducted, so refundLeaveBalance no-ops and it just flips to
    // cancelled.
    await this.refundLeaveBalance(request);

    const result = await leaveRepository.updateRequestStatus(requestId, {
      status: "cancelled",
    });

    const employee = await leaveRepository.findUserById(userId);
    if (employee?.reportingTo) {
      const manager = await leaveRepository.findUserById(employee.reportingTo);
      if (manager?.email) {
        const email = leaveCancelledEmail({
          recipientName: manager.name,
          employeeName: request.employee.name,
          leaveType: request.leaveType.name,
          startDate: fmtDate(request.startDate),
          endDate: fmtDate(request.endDate),
          portalUrl: `${PORTAL_URL}/leave`,
        });
        void sendEmail({ to: manager.email, ...email });
      }
    }

    return result;
  }

  async approveCancellation(
    requestId: string,
    approverId: string,
    userPermissions: string[],
  ) {
    const request = await leaveRepository.findRequestById(requestId);
    if (!request) throw new NotFoundException("Leave request not found");
    if (request.status !== "pending_cancellation") {
      throw new BadRequestException(
        `Request is not pending cancellation (current: "${request.status}")`,
      );
    }

    await this.assertCanApproveOrReject(request, approverId, userPermissions);

    // Legacy path: pre-2026-06-03 reports could sit in
    // `pending_cancellation` awaiting a manager. New self-cancels refund
    // inline (see cancelRequest); this still resolves any such rows.
    await this.refundLeaveBalance(request);

    return leaveRepository.updateRequestStatus(requestId, {
      status: "cancelled",
      approvedBy: approverId,
      approvedAt: new Date(),
    });
  }

  async rejectCancellation(
    requestId: string,
    approverId: string,
    userPermissions: string[],
  ) {
    const request = await leaveRepository.findRequestById(requestId);
    if (!request) throw new NotFoundException("Leave request not found");
    if (request.status !== "pending_cancellation") {
      throw new BadRequestException(
        `Request is not pending cancellation (current: "${request.status}")`,
      );
    }

    await this.assertCanApproveOrReject(request, approverId, userPermissions);

    return leaveRepository.updateRequestStatus(requestId, {
      status: "approved",
    });
  }

  /**
   * HR-driven manual edit of a single LeaveBalance. Writes a
   * BalanceTransaction (type=`manual_adjustment`) that captures the
   * before/after snapshot and any reason. `amount` carries the change to
   * `used` — the ledger exists to explain how `used` got where it is, and
   * recording the entitled-delta there (as this did) made a manual edit
   * of `used` invisible to any reconciliation. Every other field is in
   * the description.
   */
  async updateBalance(
    balanceId: string,
    input: UpdateLeaveBalanceInput,
    actorId: string,
  ) {
    const existing = await prisma.leaveBalance.findUnique({
      where: { id: balanceId },
    });
    if (!existing) throw new NotFoundException("Leave balance not found");

    const next = {
      entitled: input.entitled ?? Number(existing.entitled),
      used: input.used ?? Number(existing.used),
      carried: input.carried ?? Number(existing.carried),
      carriedUsed: input.carriedUsed ?? Number(existing.carriedUsed),
      adjustment: input.adjustment ?? Number(existing.adjustment),
      // `carriedExpiry` is the only `null`-meaningful field — pass it
      // through explicitly so `undefined` (no change) is distinguishable
      // from `null` (clear the expiry).
      carriedExpiry:
        input.carriedExpiry === undefined
          ? existing.carriedExpiry
          : input.carriedExpiry === null
            ? null
            : new Date(`${input.carriedExpiry}T00:00:00Z`),
    };

    const fmtExpiry = (d: Date | null) =>
      d ? d.toISOString().slice(0, 10) : "none";
    const before = `entitled=${existing.entitled}, used=${existing.used}, carried=${existing.carried}, carriedUsed=${existing.carriedUsed}, carriedExpiry=${fmtExpiry(existing.carriedExpiry)}, adjustment=${existing.adjustment}`;
    const after = `entitled=${next.entitled}, used=${next.used}, carried=${next.carried}, carriedUsed=${next.carriedUsed}, carriedExpiry=${fmtExpiry(next.carriedExpiry)}, adjustment=${next.adjustment}`;
    const reasonSuffix = input.reason ? ` | Reason: ${input.reason}` : "";

    const updated = await prisma.leaveBalance.update({
      where: { id: balanceId },
      data: next,
    });

    await leaveRepository.createBalanceTransaction({
      employeeId: existing.employeeId,
      leaveTypeId: existing.leaveTypeId,
      year: existing.year,
      type: "manual_adjustment",
      amount: next.used - Number(existing.used),
      description: `Manual adjustment by ${actorId}: before [${before}], after [${after}]${reasonSuffix}`,
    });

    return updated;
  }

  /**
   * Create-or-update a LeaveBalance keyed on (employeeId, leaveTypeId,
   * year). Used when HR edits a synthesized row that hasn't been
   * persisted yet — clicking the pencil on a "from policy default" card
   * calls this. Existing rows fall through to the same write path as
   * `updateBalance` so the audit trail stays consistent.
   */
  async upsertBalance(input: UpsertLeaveBalanceInput, actorId: string) {
    const user = await prisma.user.findUnique({
      where: { id: input.employeeId },
      select: { id: true, entityId: true },
    });
    if (!user) throw new NotFoundException("Employee not found");

    const type = await prisma.leaveType.findUnique({
      where: { id: input.leaveTypeId },
      select: { id: true, entityId: true, isActive: true },
    });
    if (!type) throw new NotFoundException("Leave type not found");
    if (!type.isActive) {
      throw new BadRequestException("Leave type is inactive");
    }
    if (type.entityId !== null && type.entityId !== user.entityId) {
      throw new BadRequestException(
        "Leave type does not apply to this employee's entity",
      );
    }

    const existing = await leaveRepository.findBalance(
      user.id,
      type.id,
      input.year,
    );

    if (existing) {
      return this.updateBalance(
        existing.id,
        {
          entitled: input.entitled,
          used: input.used,
          carried: input.carried,
          carriedUsed: input.carriedUsed,
          carriedExpiry: input.carriedExpiry,
          adjustment: input.adjustment,
          reason: input.reason,
        },
        actorId,
      );
    }

    const created = await prisma.leaveBalance.create({
      data: {
        employeeId: user.id,
        leaveTypeId: type.id,
        year: input.year,
        entitled: input.entitled,
        used: input.used,
        carried: input.carried,
        carriedUsed: input.carriedUsed,
        carriedExpiry: input.carriedExpiry
          ? new Date(`${input.carriedExpiry}T00:00:00Z`)
          : null,
        adjustment: input.adjustment,
      },
    });

    const reasonSuffix = input.reason ? ` | Reason: ${input.reason}` : "";
    await leaveRepository.createBalanceTransaction({
      employeeId: user.id,
      leaveTypeId: type.id,
      year: input.year,
      type: "manual_adjustment",
      amount: Math.round(input.entitled),
      description: `HR create by ${actorId}: entitled=${input.entitled}, used=${input.used}, carried=${input.carried}, adjustment=${input.adjustment}${reasonSuffix}`,
    });

    return created;
  }

  async previewBulkImport(rows: BulkImportBalanceRow[]) {
    const leaveTypes = (await leaveRepository.findAllTypes()).filter(
      (t) => t.isActive,
    );

    const emails = [...new Set(rows.map((r) => r.employeeEmail))];
    const users = await prisma.user.findMany({
      where: { email: { in: emails } },
      select: { id: true, email: true, name: true, entityId: true },
    });
    const userByEmail = new Map(users.map((u) => [u.email, u]));

    const resolveType = (entityId: string | null, code: string) =>
      leaveTypes.find((t) => t.entityId === entityId && t.code === code) ??
      leaveTypes.find((t) => t.entityId === null && t.code === code) ??
      null;

    const preview: Array<{
      row: number;
      employeeEmail: string;
      employeeName: string | null;
      leaveTypeCode: string;
      leaveTypeName: string | null;
      year: number;
      entitled: number | null;
      carried: number;
      adjustment: number;
      used: number;
      errors: string[];
    }> = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      const errors: string[] = [];
      const user = userByEmail.get(r.employeeEmail);
      const type = user
        ? resolveType(user.entityId ?? null, r.leaveTypeCode)
        : null;
      if (!user) {
        errors.push(`Employee not found: ${r.employeeEmail}`);
      }
      if (user && !type) {
        errors.push(
          `Leave type not found for ${r.employeeEmail}: ${r.leaveTypeCode}`,
        );
      }

      preview.push({
        row: i + 1,
        employeeEmail: r.employeeEmail,
        employeeName: user?.name ?? null,
        leaveTypeCode: r.leaveTypeCode,
        leaveTypeName: type?.name ?? null,
        year: r.year,
        entitled: r.entitled ?? null,
        carried: r.carried,
        adjustment: r.adjustment,
        used: r.used ?? 0,
        errors,
      });
    }

    const valid = preview.filter((p) => p.errors.length === 0).length;
    const invalid = preview.length - valid;

    return { data: preview, meta: { total: preview.length, valid, invalid } };
  }

  async commitBulkImport(rows: BulkImportBalanceRow[]) {
    const leaveTypes = (await leaveRepository.findAllTypes()).filter(
      (t) => t.isActive,
    );

    const emails = [...new Set(rows.map((r) => r.employeeEmail))];
    const users = await prisma.user.findMany({
      where: { email: { in: emails } },
      select: { id: true, email: true, entityId: true },
    });
    const userByEmail = new Map(users.map((u) => [u.email, u]));

    const resolveType = (entityId: string | null, code: string) =>
      leaveTypes.find((t) => t.entityId === entityId && t.code === code) ??
      leaveTypes.find((t) => t.entityId === null && t.code === code) ??
      null;

    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const r of rows) {
      const user = userByEmail.get(r.employeeEmail);
      const type = user
        ? resolveType(user.entityId ?? null, r.leaveTypeCode)
        : null;
      if (!user || !type) {
        skipped++;
        continue;
      }

      const existing = await leaveRepository.findBalance(
        user.id,
        type.id,
        r.year,
      );
      const usedValue = r.used ?? (existing ? Number(existing.used) : 0);
      // Preserve existing entitled if the import row didn't specify one —
      // a roster that only carries "used" data must NOT wipe the policy.
      const entitledValue =
        r.entitled ?? (existing ? Number(existing.entitled) : 0);
      if (existing) {
        await prisma.leaveBalance.update({
          where: { id: existing.id },
          data: {
            ...(r.entitled !== undefined && { entitled: r.entitled }),
            carried: r.carried,
            adjustment: r.adjustment,
            ...(r.used !== undefined && { used: r.used }),
          },
        });
        // `amount` is the change to `used` so the ledger can explain the
        // balance card; the description carries every other field.
        await leaveRepository.createBalanceTransaction({
          employeeId: user.id,
          leaveTypeId: type.id,
          year: r.year,
          type: "bulk_import",
          amount: usedValue - Number(existing.used),
          description: `Bulk import update: entitled=${entitledValue}, used=${usedValue}, carried=${r.carried}, adj=${r.adjustment}`,
        });
        updated++;
      } else {
        await prisma.leaveBalance.create({
          data: {
            employeeId: user.id,
            leaveTypeId: type.id,
            year: r.year,
            entitled: entitledValue,
            carried: r.carried,
            adjustment: r.adjustment,
            used: usedValue,
          },
        });
        await leaveRepository.createBalanceTransaction({
          employeeId: user.id,
          leaveTypeId: type.id,
          year: r.year,
          type: "bulk_import",
          amount: usedValue,
          description: `Bulk import: entitled=${entitledValue}, used=${usedValue}, carried=${r.carried}, adj=${r.adjustment}`,
        });
        created++;
      }
    }

    return { data: { created, updated, skipped } };
  }

  // ── Soft delete ──

  async removeRequest(id: string, actorId: string, permissions: string[]) {
    const existing = await leaveRepository.findRequestById(id);
    if (!existing) throw new NotFoundException("Leave request not found");

    const isHr = permissions.includes(PERMISSIONS.LEAVE_HR_READ);
    if (!isHr && existing.employeeId !== actorId) {
      throw new ForbiddenException(
        "You can only delete your own leave requests",
      );
    }
    if (!isHr) {
      const DELETABLE = new Set(["draft", "pending", "cancelled", "rejected"]);
      if (!DELETABLE.has(existing.status)) {
        throw new BadRequestException(
          `Cannot delete a request with status "${existing.status}". Approved requests are retained for audit.`,
        );
      }
    }

    // HR can delete an approved request, and the list query filters on
    // deletedAt — so without this the row vanishes from the employee's
    // history while its days stay charged against the balance forever.
    // That silent drift is exactly what makes the balance card disagree
    // with "My requests".
    await this.refundLeaveBalance(existing, "deletion");

    return leaveRepository.softDeleteRequest(id);
  }

  async restoreRequest(id: string, actorId: string, permissions: string[]) {
    // findRequestById hides soft-deleted rows; a hit means it's still active.
    const active = await leaveRepository.findRequestById(id);
    if (active) throw new ConflictException("Request is not deleted");

    const existing = await leaveRepository.findRequestByIdIncludingDeleted(id);
    if (!existing) throw new NotFoundException("Leave request not found");

    const isHr = permissions.includes(PERMISSIONS.LEAVE_HR_READ);
    if (!isHr && existing.employeeId !== actorId) {
      throw new ForbiddenException(
        "You can only restore your own leave requests",
      );
    }

    // Bringing an approved request back into the employee's history has
    // to re-charge the days that removeRequest refunded, or the restore
    // hands out free leave. Deduct before restoring: if the balance
    // write fails, the row stays deleted and the two remain consistent.
    if (existing.status === "approved") {
      await this.deductLeaveBalance(existing);
    }

    return leaveRepository.restoreRequest(id);
  }

  async permanentDeleteRequest(id: string) {
    // Include deleted rows — the normal flow is soft-delete first, and
    // findRequestById hides those, so the old lookup 404'd on exactly
    // the rows this route exists to purge.
    const existing = await leaveRepository.findRequestByIdIncludingDeleted(id);
    if (!existing) {
      throw new NotFoundException("Leave request not found");
    }
    // Hard-deleting the row destroys the only record of why the days
    // were charged, so give them back first. No-ops when the soft-delete
    // already refunded them.
    await this.refundLeaveBalance(existing, "deletion");
    return leaveRepository.permanentDeleteRequest(id);
  }
}

export const leaveService = new LeaveService();
