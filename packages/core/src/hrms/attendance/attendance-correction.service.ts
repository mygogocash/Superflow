import type { Db } from "@nexora/db";
import { PERMISSIONS } from "@nexora/contracts";
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "../../http-exception.js";
import * as attendanceRepo from "./attendance.repository.js";
import * as correctionRepo from "./attendance-correction.repository.js";
import type {
  AttendanceCorrectionDto,
  AttendanceCorrectionStatus,
  AttendanceWorkMode,
} from "@nexora/contracts/modules/hrms/attendance.types";
import type {
  CorrectionsQuery,
  CreateCorrectionInput,
} from "@nexora/contracts/modules/hrms/attendance-phase2.validation";
import { findDirectReportIds } from "../../leave/leave.repository.js";
import * as notification from "./attendance-notification.service.js";

function serializeCorrection(row: {
  id: string;
  employeeId: string;
  attendanceRecordId: string | null;
  attendanceDate: string;
  correctionType: string;
  reason: string;
  comments: string | null;
  status: string;
  proposedCheckIn: string | null;
  proposedCheckOut: string | null;
  proposedWorkMode: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectRemarks: string | null;
  createdAt: string;
  updatedAt: string;
  employee?: {
    id: string;
    name: string;
    email: string;
    department: string | null;
    employeeId: string | null;
  } | null;
}): AttendanceCorrectionDto {
  return {
    id: row.id,
    employeeId: row.employeeId,
    attendanceRecordId: row.attendanceRecordId,
    attendanceDate: String(row.attendanceDate).slice(0, 10),
    correctionType: row.correctionType as AttendanceCorrectionDto["correctionType"],
    reason: row.reason,
    comments: row.comments,
    status: row.status as AttendanceCorrectionStatus,
    proposedCheckIn: row.proposedCheckIn,
    proposedCheckOut: row.proposedCheckOut,
    proposedWorkMode: row.proposedWorkMode as AttendanceWorkMode | null,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt,
    rejectRemarks: row.rejectRemarks,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    employee: row.employee ?? undefined,
  };
}

function canApprove(actorPermissions: string[]): boolean {
  return (
    actorPermissions.includes(PERMISSIONS.HRMS_ATTENDANCE_CORRECTION_APPROVE) ||
    actorPermissions.includes(PERMISSIONS.HRMS_ATTENDANCE_MANAGE)
  );
}

function canViewAll(actorPermissions: string[]): boolean {
  // Org-wide correction inbox is manage-only; attendance:read is not a dump-all.
  return actorPermissions.includes(PERMISSIONS.HRMS_ATTENDANCE_MANAGE);
}

export async function create(db: Db, actorId: string, input: CreateCorrectionInput) {
  const dateStr = input.attendanceDate;
  const pending = await correctionRepo.findMany(
    db,
    { employeeId: actorId, attendanceDate: dateStr, status: "pending" },
    1,
    1,
  );
  if (pending.total > 0) {
    throw new BadRequestException("A pending correction already exists for this date");
  }

  const row = await correctionRepo.create(db, {
    employeeId: actorId,
    attendanceRecordId: input.attendanceRecordId ?? null,
    attendanceDate: dateStr,
    correctionType: input.correctionType,
    reason: input.reason,
    comments: input.comments ?? null,
    proposedCheckIn: input.proposedCheckIn ?? null,
    proposedCheckOut: input.proposedCheckOut ?? null,
    proposedWorkMode: input.proposedWorkMode ?? null,
    status: "pending",
  });
  if (!row) throw new BadRequestException("Failed to create correction");

  await attendanceRepo.createAuditLog(db, {
    employeeId: actorId,
    actorId,
    action: "correction_requested",
    details: { correctionId: row.id, correctionType: input.correctionType },
  });

  void notification.notifyPendingCorrection(row);
  return serializeCorrection(row);
}

export async function list(
  db: Db,
  actorId: string,
  actorPermissions: string[],
  query: CorrectionsQuery,
) {
  const where: Parameters<typeof correctionRepo.findMany>[1] = {};
  if (query.status) where.status = query.status;

  if (query.scope === "all" && canViewAll(actorPermissions)) {
    if (query.employeeId) where.employeeId = query.employeeId;
  } else if (
    query.scope === "team" &&
    (canApprove(actorPermissions) || (await findDirectReportIds(db, actorId)).length > 0)
  ) {
    const reportIds = await findDirectReportIds(db, actorId);
    where.employeeId = query.employeeId
      ? reportIds.includes(query.employeeId)
        ? query.employeeId
        : actorId
      : { in: reportIds.length ? reportIds : [actorId] };
  } else {
    where.employeeId = actorId;
  }

  const { data, total } = await correctionRepo.findMany(db, where, query.page, query.limit);
  return {
    data: data.map(serializeCorrection),
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit) || 1,
    },
  };
}

async function assertCanActOnCorrection(
  db: Db,
  actorId: string,
  actorPermissions: string[],
  correction: { employeeId: string },
) {
  if (correction.employeeId === actorId) {
    throw new ForbiddenException("You cannot approve or reject your own correction");
  }
  if (canApprove(actorPermissions)) return;
  const reportIds = await findDirectReportIds(db, actorId);
  if (reportIds.includes(correction.employeeId)) return;
  throw new ForbiddenException("You do not have permission to act on this correction");
}

export async function approve(db: Db, actorId: string, actorPermissions: string[], id: string) {
  const correction = await correctionRepo.findById(db, id);
  if (!correction) throw new NotFoundException("Correction not found");
  if (correction.status !== "pending") {
    throw new BadRequestException("Correction is not pending");
  }

  await assertCanActOnCorrection(db, actorId, actorPermissions, correction);

  let record = correction.attendanceRecordId
    ? await attendanceRepo.findRecordById(db, correction.attendanceRecordId)
    : await attendanceRepo.findRecordByEmployeeAndDate(
        db,
        correction.employeeId,
        new Date(`${String(correction.attendanceDate).slice(0, 10)}T00:00:00.000Z`),
      );

  const updateData: Parameters<typeof attendanceRepo.updateRecord>[2] = {};
  if (correction.proposedCheckIn) updateData.checkIn = correction.proposedCheckIn;
  if (correction.proposedCheckOut) updateData.checkOut = correction.proposedCheckOut;
  if (correction.proposedWorkMode) updateData.workMode = correction.proposedWorkMode;
  if (correction.proposedCheckIn || correction.proposedWorkMode) updateData.status = "present";

  if (record) {
    record = await attendanceRepo.updateRecord(db, record.id, updateData);
  } else if (Object.keys(updateData).length > 0) {
    record = await attendanceRepo.createRecord(db, {
      employeeId: correction.employeeId,
      attendanceDate: String(correction.attendanceDate).slice(0, 10),
      checkIn: correction.proposedCheckIn ?? null,
      checkOut: correction.proposedCheckOut ?? null,
      workMode: (correction.proposedWorkMode as AttendanceWorkMode) ?? "office",
      status: "present",
      lateMinutes: 0,
    });
  }

  const updated = await correctionRepo.update(db, id, {
    status: "approved",
    approvedBy: actorId,
    approvedAt: new Date().toISOString(),
    attendanceRecordId: record?.id ?? correction.attendanceRecordId,
  });
  if (!updated) throw new NotFoundException("Correction not found");

  await attendanceRepo.createAuditLog(db, {
    recordId: record?.id ?? null,
    employeeId: correction.employeeId,
    actorId,
    action: "correction_approved",
    details: { correctionId: id },
  });

  void notification.notifyCorrectionApproved(updated);
  return serializeCorrection(updated);
}

export async function reject(
  db: Db,
  actorId: string,
  actorPermissions: string[],
  id: string,
  remarks: string,
) {
  const correction = await correctionRepo.findById(db, id);
  if (!correction) throw new NotFoundException("Correction not found");
  if (correction.status !== "pending") {
    throw new BadRequestException("Correction is not pending");
  }

  await assertCanActOnCorrection(db, actorId, actorPermissions, correction);

  const updated = await correctionRepo.update(db, id, {
    status: "rejected",
    approvedBy: actorId,
    approvedAt: new Date().toISOString(),
    rejectRemarks: remarks,
  });
  if (!updated) throw new NotFoundException("Correction not found");

  await attendanceRepo.createAuditLog(db, {
    employeeId: correction.employeeId,
    actorId,
    action: "correction_rejected",
    details: { correctionId: id, remarks },
  });

  void notification.notifyCorrectionRejected(updated);
  return serializeCorrection(updated);
}
