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
import { isValidEmail } from "@/common/utils/email";
import { prisma } from "@/infrastructure/database/prisma";
import { sendEmail } from "@/infrastructure/email/email.service";
import {
  travelApprovedEmail,
  travelCancelledEmail,
  travelDeskSummaryEmail,
  travelRejectedEmail,
  travelSubmittedEmail,
} from "@/infrastructure/email/templates";
import {
  actorFromId,
  trackTravelRequestApproved,
  trackTravelRequestSubmittedServer,
} from "@/lib/events";
import { PORTAL_URL } from "@/lib/portal-url";
import { expensesRepository } from "@/modules/expenses/expenses.repository";
import { travelRepository } from "@/modules/travel/travel.repository";
import type {
  AddAttachmentsInput,
  CreateApprovalStepInput,
  CreateTravelRequestInput,
  ForwardTravelRequestInput,
  ReorderApprovalStepsInput,
  TravelRequestQuery,
  UpdateApprovalStepInput,
  UpdateTravelRequestInput,
} from "@/modules/travel/travel.validation";

const TRAVEL_NOTIFICATION_KEY = "travel.notification_recipients";

async function loadTravelNotificationRecipients(): Promise<string[]> {
  const row = await prisma.systemSetting.findUnique({
    where: { key: TRAVEL_NOTIFICATION_KEY },
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

export class TravelService {
  async listRequests(
    userId: string,
    userPermissions: string[],
    query: TravelRequestQuery,
  ) {
    const { page, limit, ...filters } = query;

    // Travel Admin / HR holders see every request regardless of the
    // generic admin:* perm. Without this override they fall back to
    // resolveDataScope's "team" branch and only see direct reports.
    const hasTravelAllRead =
      userPermissions.includes(PERMISSIONS.TRAVEL_HR_READ) ||
      userPermissions.includes(PERMISSIONS.TRAVEL_HR_APPROVE);

    const scope = hasTravelAllRead
      ? "all"
      : await resolveDataScope(userId, userPermissions);

    let scopeUserIds: string[] | undefined;
    if (scope === "self") {
      filters.employeeId = userId;
    } else if (scope === "team") {
      const teamFilter = await buildUserScopeFilter(
        userId,
        scope,
        "employeeId",
      );
      const val = teamFilter.employeeId;
      if (
        val &&
        typeof val === "object" &&
        "in" in (val as Record<string, unknown>)
      ) {
        scopeUserIds = (val as { in: string[] }).in;
      }
    }

    const { data, total } = await travelRepository.findRequests(
      filters,
      page,
      limit,
      scopeUserIds,
    );

    const enriched = await this.attachViewerCanAct(
      data,
      userId,
      userPermissions,
    );

    return {
      data: enriched,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async getRequestById(id: string, userId: string, userPermissions: string[]) {
    const request = await travelRepository.findRequestById(id);
    if (!request) throw new NotFoundException("Travel request not found");

    const hasHrRead = userPermissions.includes(PERMISSIONS.TRAVEL_HR_READ);
    if (!hasHrRead && request.employeeId !== userId) {
      throw new ForbiddenException(
        "You can only view your own travel requests",
      );
    }

    const [enriched] = await this.attachViewerCanAct(
      [request],
      userId,
      userPermissions,
    );
    return enriched ?? request;
  }

  // `viewerCanAct` tells the client whether the requesting user is
  // authorised to approve/reject the current step. Designated approvers
  // (chain user-step or the employee's direct manager) may not hold the
  // static `travel:approve` perm, so the UI can't rely on that alone.
  private async attachViewerCanAct<
    R extends {
      id: string;
      status: string;
      currentStepOrder: number | null;
      employee: { reportingTo: string | null };
    },
  >(requests: R[], actorId: string, permissions: string[]) {
    const isHr = permissions.includes(PERMISSIONS.TRAVEL_HR_APPROVE);
    const pendingIds = requests
      .filter((r) => r.status === "pending")
      .map((r) => r.id);

    if (pendingIds.length === 0) {
      return requests.map((r) => ({ ...r, viewerCanAct: false }));
    }

    const decisions = await prisma.travelApprovalDecision.findMany({
      where: { travelRequestId: { in: pendingIds } },
      select: {
        travelRequestId: true,
        order: true,
        status: true,
        approverType: true,
        approverUserId: true,
      },
    });

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
        // No chain → legacy manager fallback (matches createRequest).
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

  async createRequest(userId: string, input: CreateTravelRequestInput) {
    const user = await travelRepository.findUserById(userId);

    const created = await travelRepository.createRequest({
      employeeId: userId,
      entityId: user?.entityId,
      origin: input.origin,
      destination: input.destination,
      purpose: input.purpose,
      departureDate: new Date(input.departureDate),
      returnDate: new Date(input.returnDate),
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

    // Snapshot the active approval chain into per-request decision rows.
    // If no chain is configured, fall back to a single "manager" stage so
    // existing behaviour (employee.reportingTo approves) is preserved.
    //
    // Each step carries optional submitter-conditional routing:
    //   - skipWhenSubmitterIds: skip the step entirely if the
    //     submitter is on the list (e.g. don't ask Sid to approve his
    //     own request).
    //   - onlyWhenSubmitterIds: when non-empty, the step only fires
    //     for these submitters; everyone else skips it (e.g. "CEO
    //     approval" only routes when Sid is the submitter).
    const allSteps = await travelRepository.findApprovalSteps({
      activeOnly: true,
    });

    // Convert this request's cashAdvance to THB so step amount bands
    // can be compared in a single currency. Skip the FX round-trip if
    // no step actually has an amount filter — keeps the common path
    // (no amount-band rules configured) free of FX-table reads.
    const anyAmountFilter = allSteps.some(
      (s) => s.amountMinBaht != null || s.amountMaxBaht != null,
    );
    let cashAdvanceBaht: number | null = null;
    if (anyAmountFilter && input.cashAdvance !== undefined) {
      if (input.currency === "THB") {
        cashAdvanceBaht = input.cashAdvance;
      } else {
        const fx = await expensesRepository.convertAmount(
          input.cashAdvance,
          input.currency,
          "THB",
        );
        cashAdvanceBaht = fx?.converted ?? null;
      }
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

      // Category filter — empty list = match all, else require the
      // request's category to be present.
      const cats = Array.isArray(s.categoryFilter)
        ? (s.categoryFilter as string[])
        : [];
      if (cats.length > 0 && !cats.includes(requestCategory)) return false;

      // Amount band — applied against the THB-converted cashAdvance.
      // If conversion failed (no FX rate) or no cashAdvance was given,
      // the step's amount filter is treated as not-matching so the
      // request doesn't silently slip past an intended Sarah/Sid gate.
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
    // Resolve the submitter's skip-level manager once so `manager_l2`
    // steps can be snapshotted as fixed-user decisions. Org-chart top
    // → no L2 → the step is silently dropped from the chain. Read
    // through the repository so the mocked layer in unit tests is
    // honoured.
    let l2UserId: string | null = null;
    if (user?.reportingTo) {
      const l1 = await travelRepository.findUserById(user.reportingTo);
      l2UserId = l1?.reportingTo ?? null;
    }

    type DecisionRow = {
      order: number;
      name: string;
      approverType: string;
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

    // Fall back to single-step Manager approval if every configured
    // step filtered out (rare: only manager_l2 steps + no L2 user).
    if (decisionRows.length === 0) {
      decisionRows.push({
        order: 1,
        name: "Manager approval",
        approverType: "manager",
        approverUserId: null,
      });
    }

    await travelRepository.createDecisions(created.id, decisionRows);
    await travelRepository.updateRequest(created.id, {
      currentStepOrder: 1,
    });

    // Notify the first approver. For a manager step, that's the employee's
    // reportingTo. For a user step, the assigned user.
    const firstStep = decisionRows[0]!;
    let approverEmail: string | undefined;
    let approverName: string | undefined;
    if (firstStep.approverType === "manager" && user?.reportingTo) {
      const manager = await travelRepository.findUserById(user.reportingTo);
      approverEmail = manager?.email ?? undefined;
      approverName = manager?.name;
    } else if (firstStep.approverType === "user" && firstStep.approverUserId) {
      const approver = await travelRepository.findUserById(
        firstStep.approverUserId,
      );
      approverEmail = approver?.email ?? undefined;
      approverName = approver?.name;
    }
    if (approverEmail && user) {
      const email = travelSubmittedEmail({
        approverName: approverName ?? "Approver",
        employeeName: user.name,
        origin: input.origin,
        destination: input.destination,
        startDate: fmtDate(new Date(input.departureDate)),
        endDate: fmtDate(new Date(input.returnDate)),
        purpose: input.purpose,
        portalUrl: `${PORTAL_URL}/travel`,
      });
      void sendEmail({ to: approverEmail, ...email });
    }

    try {
      const trackingActor = await actorFromId(userId);
      if (trackingActor) {
        // trip_type defaults to "domestic" — schema has no domestic/intl flag.
        // estimated_cost_thb passes raw budget when currency is THB; otherwise
        // omitted (FX conversion is a finance concern, not a telemetry one).
        trackTravelRequestSubmittedServer(trackingActor, {
          trip_type: "domestic",
          destination_country: input.destination,
          estimated_cost_thb:
            input.currency === "THB" && input.estimatedBudget != null
              ? input.estimatedBudget
              : undefined,
        });
      }
    } catch {
      // analytics is best-effort
    }

    return travelRepository.findRequestById(created.id);
  }

  async updateRequest(
    id: string,
    userId: string,
    input: UpdateTravelRequestInput,
  ) {
    const request = await travelRepository.findRequestById(id);
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

    return travelRepository.updateRequest(id, {
      ...(input.origin !== undefined && { origin: input.origin }),
      ...(input.destination !== undefined && {
        destination: input.destination,
      }),
      ...(input.purpose !== undefined && { purpose: input.purpose }),
      ...(input.departureDate !== undefined && {
        departureDate: new Date(input.departureDate),
      }),
      ...(input.returnDate !== undefined && {
        returnDate: new Date(input.returnDate),
      }),
      ...(input.estimatedBudget !== undefined && {
        estimatedBudget: input.estimatedBudget,
      }),
      ...(input.cashAdvance !== undefined && {
        cashAdvance: input.cashAdvance,
      }),
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

  /** Resolve the decision pending at the request's current step. */
  private async getCurrentDecision(
    requestId: string,
    currentStepOrder: number | null,
  ) {
    const decisions = await travelRepository.findDecisions(requestId);
    if (decisions.length === 0) return null;
    const target =
      currentStepOrder ??
      decisions.find((d) => d.status === "pending")?.order ??
      decisions[0]!.order;
    return decisions.find((d) => d.order === target) ?? null;
  }

  /** Throws ForbiddenException when actor is not authorised for the stage. */
  private async assertCanActOnStep(
    decision: {
      approverType: string;
      approverUserId: string | null;
    },
    request: { employee: { reportingTo: string | null } },
    actorId: string,
    actorPermissions: string[],
  ) {
    // HR approvers can always act, and the existing `travel:approve` perm
    // also satisfies a manager step (that's how the legacy behaviour worked).
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

    // manager type → must be the employee's direct manager
    if (request.employee.reportingTo !== actorId) {
      throw new ForbiddenException(
        "Only the employee's direct manager can approve this step",
      );
    }
  }

  async approveRequest(id: string, approverId: string, permissions: string[]) {
    const request = await travelRepository.findRequestById(id);
    if (!request) throw new NotFoundException("Travel request not found");
    if (request.status !== "pending") {
      throw new BadRequestException(
        `Cannot approve a request with status "${request.status}"`,
      );
    }

    // Legacy requests created before the approval-chain feature shipped
    // have no decision rows. Backfill the manager-only fallback (matches
    // the empty-chain branch in `createRequest`) so HR / managers can
    // still act on those tickets instead of being stuck behind a 400.
    let decision = await this.getCurrentDecision(id, request.currentStepOrder);
    if (!decision) {
      await travelRepository.createDecisions(id, [
        {
          order: 1,
          name: "Manager approval",
          approverType: "manager",
          approverUserId: null,
        },
      ]);
      await travelRepository.updateRequest(id, { currentStepOrder: 1 });
      decision = await this.getCurrentDecision(id, 1);
    }
    if (!decision) {
      // createDecisions silently dropped the row — surface the original
      // error rather than crash on the assertion below.
      throw new BadRequestException(
        "No approval chain configured for this request",
      );
    }
    if (decision.status !== "pending") {
      throw new BadRequestException(
        "Current step is already decided — refresh and try again",
      );
    }

    await this.assertCanActOnStep(decision, request, approverId, permissions);

    await travelRepository.updateDecision(decision.id, {
      status: "approved",
      decidedBy: { connect: { id: approverId } },
      decidedAt: new Date(),
    });

    const decisions = await travelRepository.findDecisions(id);
    const next = decisions.find(
      (d) => d.order > decision.order && d.status === "pending",
    );

    if (next) {
      // Advance: stay pending, point at the next step, notify the next approver.
      await travelRepository.updateRequest(id, {
        currentStepOrder: next.order,
      });

      let nextEmail: string | undefined;
      let nextName: string | undefined;
      if (next.approverType === "user" && next.approverUserId) {
        const u = await travelRepository.findUserById(next.approverUserId);
        nextEmail = u?.email ?? undefined;
        nextName = u?.name;
      } else if (next.approverType === "manager") {
        const employee = await travelRepository.findUserById(
          request.employeeId,
        );
        if (employee?.reportingTo) {
          const manager = await travelRepository.findUserById(
            employee.reportingTo,
          );
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

      return travelRepository.findRequestById(id);
    }

    // No more pending steps → finalise as approved.
    const result = await travelRepository.updateRequestStatus(id, {
      status: "approved",
      approvedBy: approverId,
      approvedAt: new Date(),
    });

    const approver = await travelRepository.findUserById(approverId);
    const email = travelApprovedEmail({
      employeeName: request.employee.name,
      origin: request.origin,
      destination: request.destination,
      startDate: fmtDate(request.departureDate),
      endDate: fmtDate(request.returnDate),
      approverName: approver?.name ?? "Your Manager",
      portalUrl: `${PORTAL_URL}/travel`,
    });
    // Notify applicant + their direct supervisor on the approved email
    // (HR feedback May 2026). HR can also subscribe via TRAVEL_APPROVED_CC
    // if they want a copy of every approval.
    const recipients = new Set<string>([request.employee.email]);
    if (request.employee.reportingTo) {
      const supervisor = await travelRepository.findUserById(
        request.employee.reportingTo,
      );
      if (supervisor?.email) recipients.add(supervisor.email);
    }
    for (const cc of (process.env.TRAVEL_APPROVED_CC ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      recipients.add(cc);
    }
    void sendEmail({ to: Array.from(recipients), ...email });

    // Travel-desk long-form summary (HR feedback May 2026). Recipients
    // are admin-managed via SystemSetting; we ship a separate template
    // so the desk doesn't have to chase fields across the approved /
    // submitted templates.
    try {
      const deskRecipients = await loadTravelNotificationRecipients();
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
      // Don't let a desk-notification failure roll back the approval.
      // The applicant's own approved email already went out.
    }

    try {
      const trackingActor = await actorFromId(approverId);
      if (trackingActor) {
        trackTravelRequestApproved(trackingActor);
      }
    } catch {
      // analytics is best-effort
    }

    return result;
  }

  async rejectRequest(
    id: string,
    approverId: string,
    reason: string,
    permissions: string[],
  ) {
    const request = await travelRepository.findRequestById(id);
    if (!request) throw new NotFoundException("Travel request not found");
    if (request.status !== "pending") {
      throw new BadRequestException(
        `Cannot reject a request with status "${request.status}"`,
      );
    }

    const decision = await this.getCurrentDecision(
      id,
      request.currentStepOrder,
    );
    if (decision) {
      if (decision.status !== "pending") {
        throw new BadRequestException(
          "Current step is already decided — refresh and try again",
        );
      }
      await this.assertCanActOnStep(decision, request, approverId, permissions);
      await travelRepository.updateDecision(decision.id, {
        status: "rejected",
        decidedBy: { connect: { id: approverId } },
        decidedAt: new Date(),
        notes: reason,
      });
    }

    const result = await travelRepository.updateRequestStatus(id, {
      status: "rejected",
      approvedBy: approverId,
      approvedAt: new Date(),
      rejectReason: reason,
    });

    const approver = await travelRepository.findUserById(approverId);
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

  async getDecisions(id: string, userId: string, permissions: string[]) {
    const request = await travelRepository.findRequestById(id);
    if (!request) throw new NotFoundException("Travel request not found");
    const isHr = permissions.includes(PERMISSIONS.TRAVEL_HR_READ);
    if (!isHr && request.employeeId !== userId) {
      throw new ForbiddenException(
        "You can only view approvals for your own travel requests",
      );
    }
    return travelRepository.findDecisions(id);
  }

  // ── Approval chain admin ────────────────────────────────

  async listApprovalSteps() {
    return travelRepository.findApprovalSteps();
  }

  async createApprovalStep(input: CreateApprovalStepInput) {
    const order = await travelRepository.nextStepOrder();
    return travelRepository.createApprovalStep({
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
      ...(input.approverType === "user" && input.approverUserId
        ? { approverUser: { connect: { id: input.approverUserId } } }
        : {}),
    });
  }

  async updateApprovalStep(id: string, input: UpdateApprovalStepInput) {
    const existing = await travelRepository.findApprovalStepById(id);
    if (!existing) throw new NotFoundException("Approval step not found");

    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description;
    if (input.isActive !== undefined) data.isActive = input.isActive;
    if (input.skipWhenSubmitterIds !== undefined) {
      data.skipWhenSubmitterIds = input.skipWhenSubmitterIds;
    }
    if (input.onlyWhenSubmitterIds !== undefined) {
      data.onlyWhenSubmitterIds = input.onlyWhenSubmitterIds;
    }
    if (input.categoryFilter !== undefined) {
      data.categoryFilter = input.categoryFilter;
    }
    if (input.amountMinBaht !== undefined) {
      data.amountMinBaht = input.amountMinBaht;
    }
    if (input.amountMaxBaht !== undefined) {
      data.amountMaxBaht = input.amountMaxBaht;
    }

    const nextType = input.approverType ?? existing.approverType;
    if (input.approverType !== undefined) data.approverType = nextType;

    let nextApproverId: string | null = null;
    if (nextType === "user") {
      const userId = input.approverUserId ?? existing.approverUserId;
      if (!userId) {
        throw new BadRequestException(
          "approverUserId is required when approverType is 'user'",
        );
      }
      data.approverUser = { connect: { id: userId } };
      nextApproverId = userId;
    } else if (nextType === "manager") {
      data.approverUser = { disconnect: true };
      nextApproverId = null;
    }

    const updated = await travelRepository.updateApprovalStep(id, data);

    // Cascade approver change to still-pending decisions snapshotted
    // before this edit. Match on the *previous* step name so
    // already-snapshotted decisions (which carry the old name) are
    // reached even when the admin renames the step in the same edit.
    // Resolved rows (approved / rejected / skipped) stay frozen so the
    // audit trail is preserved. Always run — an admin "re-save with no
    // changes" is the documented way to retro-fix in-flight reports
    // whose decisions were snapshotted with the previous approver.
    await travelRepository.reassignPendingDecisionsByStepName(
      existing.name,
      nextApproverId,
    );

    return updated;
  }

  async deleteApprovalStep(id: string) {
    const existing = await travelRepository.findApprovalStepById(id);
    if (!existing) throw new NotFoundException("Approval step not found");
    return travelRepository.deleteApprovalStep(id);
  }

  async reorderApprovalSteps(input: ReorderApprovalStepsInput) {
    const all = await travelRepository.findApprovalSteps();
    if (all.length !== input.orderedIds.length) {
      throw new BadRequestException(
        "orderedIds must include every existing step exactly once",
      );
    }
    const knownIds = new Set(all.map((s) => s.id));
    for (const id of input.orderedIds) {
      if (!knownIds.has(id)) {
        throw new BadRequestException(`Unknown step id: ${id}`);
      }
    }
    return travelRepository.reorderApprovalSteps(input.orderedIds);
  }

  async getNotificationRecipients() {
    return { emails: await loadTravelNotificationRecipients() };
  }

  async setNotificationRecipients(rawEmails: string[]) {
    // Normalise + dedupe + validate. The schema layer (controller) only
    // shape-checks; semantic validation lives here so the same logic
    // applies if a future webhook or CSV upload mirrors this call.
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
      where: { key: TRAVEL_NOTIFICATION_KEY },
      update: { value: cleaned },
      create: { key: TRAVEL_NOTIFICATION_KEY, value: cleaned },
    });
    return { emails: cleaned };
  }

  async cancelRequest(id: string, userId: string) {
    const request = await travelRepository.findRequestById(id);
    if (!request) throw new NotFoundException("Travel request not found");
    if (request.employeeId !== userId) {
      throw new ForbiddenException("You can only cancel your own requests");
    }
    if (request.status !== "pending" && request.status !== "draft") {
      throw new BadRequestException(
        `Cannot cancel a request with status "${request.status}"`,
      );
    }

    const result = await travelRepository.updateRequestStatus(id, {
      status: "cancelled",
    });

    const employee = await travelRepository.findUserById(userId);
    if (employee?.reportingTo) {
      const manager = await travelRepository.findUserById(employee.reportingTo);
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

  /**
   * Hard-delete a travel request and its approval decisions (FK cascade).
   *
   * Allowed for:
   *   - the submitter, when the request is in a non-final state
   *     (`draft` / `pending` / `cancelled` / `rejected`)
   *   - any TRAVEL_HR_READ holder, for the same set
   *
   * Approved / completed / archived requests are deliberately blocked —
   * they have downstream effects (linked expenses, finance posting) and
   * should be reversed via the audit trail instead of erased.
   */
  async deleteRequest(id: string, userId: string, permissions: string[]) {
    const request = await travelRepository.findRequestById(id);
    if (!request) throw new NotFoundException("Travel request not found");

    const isHr = permissions.includes(PERMISSIONS.TRAVEL_HR_READ);
    if (!isHr && request.employeeId !== userId) {
      throw new ForbiddenException(
        "You can only delete your own travel requests",
      );
    }

    // Non-HR submitters can only delete pre-approval states. HR (with
    // `travel:hr-read`) can soft-delete any status — the soft delete
    // preserves the audit trail while hiding the request.
    if (!isHr) {
      const DELETABLE = new Set(["draft", "pending", "cancelled", "rejected"]);
      if (!DELETABLE.has(request.status)) {
        throw new BadRequestException(
          `Cannot delete a request with status "${request.status}". Approved or completed requests are retained for audit.`,
        );
      }
    }

    return travelRepository.softDeleteRequest(id);
  }

  async restoreRequest(id: string, userId: string, permissions: string[]) {
    // findRequestById hides soft-deleted rows; a hit means it's still active.
    const active = await travelRepository.findRequestById(id);
    if (active) throw new ConflictException("Request is not deleted");

    const request = await travelRepository.findRequestByIdIncludingDeleted(id);
    if (!request) throw new NotFoundException("Travel request not found");

    const isHr = permissions.includes(PERMISSIONS.TRAVEL_HR_READ);
    if (!isHr && request.employeeId !== userId) {
      throw new ForbiddenException(
        "You can only restore your own travel requests",
      );
    }
    return travelRepository.restoreRequest(id);
  }

  async permanentDeleteRequest(id: string, permissions: string[]) {
    // Soft-deleted rows are the normal purge target; the live finder would 404 them.
    const request =
      await travelRepository.findRequestByIdIncludingDeleted(id);
    if (!request) {
      throw new NotFoundException("Travel request not found");
    }
    if (!permissions.includes(PERMISSIONS.TRAVEL_HR_READ)) {
      throw new ForbiddenException(
        "Only HR can permanently delete travel requests",
      );
    }
    return travelRepository.permanentDeleteRequest(id);
  }

  async completeRequest(id: string, actorId: string) {
    const request = await travelRepository.findRequestById(id);
    if (!request) throw new NotFoundException("Travel request not found");
    if (request.status !== "approved") {
      throw new BadRequestException(
        `Cannot complete a request with status "${request.status}"`,
      );
    }

    return travelRepository.updateRequestStatus(id, {
      status: "completed",
      approvedBy: actorId,
      approvedAt: new Date(),
    });
  }

  async archiveRequest(id: string, actorId: string) {
    const request = await travelRepository.findRequestById(id);
    if (!request) throw new NotFoundException("Travel request not found");
    if (request.status !== "completed") {
      throw new BadRequestException(
        `Cannot archive a request with status "${request.status}"`,
      );
    }

    return travelRepository.updateRequestStatus(id, {
      status: "archived",
      approvedBy: actorId,
      approvedAt: new Date(),
    });
  }

  async getLinkedExpenses(
    travelId: string,
    userId: string,
    userPermissions: string[],
  ) {
    const request = await travelRepository.findRequestById(travelId);
    if (!request) throw new NotFoundException("Travel request not found");

    const hasHrRead = userPermissions.includes(PERMISSIONS.TRAVEL_HR_READ);
    if (!hasHrRead && request.employeeId !== userId) {
      throw new ForbiddenException(
        "You can only view expenses for your own travel requests",
      );
    }

    return travelRepository.findExpensesForTravel(travelId);
  }

  async forwardRequest(
    requestId: string,
    actorId: string,
    userPermissions: string[],
    input: ForwardTravelRequestInput,
  ) {
    const request = await travelRepository.findRequestById(requestId);
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

    const delegate = await travelRepository.findUserById(input.delegateUserId);
    if (!delegate) {
      throw new BadRequestException("Delegate user not found");
    }
    if (delegate.id === request.employeeId) {
      throw new BadRequestException("Cannot delegate to the employee");
    }

    return travelRepository.updateRequest(requestId, {
      delegatedToId: input.delegateUserId,
    });
  }

  async addAttachments(
    requestId: string,
    userId: string,
    userPermissions: string[],
    input: AddAttachmentsInput,
  ) {
    const request = await travelRepository.findRequestById(requestId);
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

    return travelRepository.updateRequest(requestId, {
      attachments: merged,
    });
  }

  async exportTravelXlsx(query: Omit<TravelRequestQuery, "page" | "limit">) {
    const requests = await travelRepository.findAllRequests(query);

    const rows = requests.map((r) => ({
      "Request Code": r.requestCode,
      Employee: r.employee.name,
      Origin: r.origin ?? "",
      Destination: r.destination,
      Purpose: r.purpose,
      Departure: fmtDate(r.departureDate),
      Return: fmtDate(r.returnDate),
      Budget: r.estimatedBudget?.toString() ?? "",
      "Cash Advance": r.cashAdvance?.toString() ?? "",
      Currency: r.currency,
      "Flight Type": r.flightType ?? "",
      "Seating Preference":
        r.seatingPreference === "other"
          ? (r.seatingPreferenceOther ?? "other")
          : (r.seatingPreference ?? ""),
      "Departure Time": r.departureTimePreference ?? "",
      "Return Time": r.returnTimePreference ?? "",
      Meal: r.mealPreference ?? "",
      "Dummy Ticket": r.dummyTicketRequired ? "Yes" : "No",
      "Visa Required": r.visaRequired ? "Yes" : "No",
      "Hotel Required": r.hotelRequired ? "Yes" : "No",
      "Hotel Location": r.hotelLocationPreference ?? "",
      "Preferred Hotel": r.preferredHotel ?? "",
      Status: r.status,
      "Submitted At": r.submittedAt ? fmtDate(r.submittedAt) : "",
    }));

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Travel Requests");

    return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  }
}

export const travelService = new TravelService();
