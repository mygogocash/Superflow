import type { Db } from "@nexora/db";
import { PERMISSIONS } from "@nexora/contracts";
import { ForbiddenException } from "../../http-exception.js";
import * as attendanceRepo from "./attendance.repository.js";
import type { AttendanceAnalyticsSummary } from "@nexora/contracts/modules/hrms/attendance.types";
import * as calendarService from "./attendance-calendar.service.js";
import type { AnalyticsQuery } from "@nexora/contracts/modules/hrms/attendance-phase2.validation";

function parseMonth(month?: string): { from: Date; to: Date; label: string } {
  const now = new Date();
  const parts = (
    month ?? `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`
  ).split("-");
  const year = Number(parts[0]);
  const mon = Number(parts[1]);
  const from = new Date(Date.UTC(year, mon - 1, 1));
  const to = new Date(Date.UTC(year, mon, 0));
  return { from, to, label: `${year}-${String(mon).padStart(2, "0")}` };
}

export async function getSummary(
  db: Db,
  actorPermissions: string[],
  query: AnalyticsQuery,
): Promise<AttendanceAnalyticsSummary> {
  // Org-wide analytics dump is manage-only; attendance:read is not a dump-all.
  if (!actorPermissions.includes(PERMISSIONS.HRMS_ATTENDANCE_MANAGE)) {
    throw new ForbiddenException("You do not have permission to view attendance analytics");
  }

  const { from, to } = parseMonth(query.month);
  const records = await attendanceRepo.findRecordsInRange(db, from, to, {
    department: query.department,
  });
  const employees = await attendanceRepo.findActiveEmployees(db, query.department);

  let presentCount = 0;
  let lateCount = 0;
  let remoteCount = 0;
  let hybridCount = 0;
  let totalHours = 0;
  let hoursCount = 0;

  for (const r of records) {
    if (["present", "late", "remote", "hybrid"].includes(r.status)) presentCount++;
    if (r.status === "late") lateCount++;
    if (r.workMode === "remote") remoteCount++;
    if (r.workMode === "hybrid") hybridCount++;
    if (r.totalHours !== null && r.totalHours !== undefined) {
      totalHours += Number(r.totalHours);
      hoursCount++;
    }
  }

  const entityId = employees[0]?.entityId ?? null;
  const workingDays = await calendarService.countWorkingDaysInRange(db, from, to, entityId);
  const possible = employees.length * workingDays;
  const attendancePercentage =
    possible > 0 ? Math.round((presentCount / possible) * 1000) / 10 : 0;
  const latePercentage =
    presentCount > 0 ? Math.round((lateCount / presentCount) * 1000) / 10 : 0;
  const remotePercentage =
    presentCount > 0 ? Math.round((remoteCount / presentCount) * 1000) / 10 : 0;
  const hybridPercentage =
    presentCount > 0 ? Math.round((hybridCount / presentCount) * 1000) / 10 : 0;
  const averageWorkingHours =
    hoursCount > 0 ? Math.round((totalHours / hoursCount) * 100) / 100 : 0;

  const monthlyTrend: AttendanceAnalyticsSummary["monthlyTrend"] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(from);
    d.setUTCMonth(d.getUTCMonth() - i);
    const mFrom = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    const mTo = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    const mLabel = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const mRecords = await attendanceRepo.findRecordsInRange(db, mFrom, mTo, {
      department: query.department,
    });
    const mPresent = mRecords.filter((r) =>
      ["present", "late", "remote", "hybrid"].includes(r.status),
    ).length;
    const mWorking = await calendarService.countWorkingDaysInRange(db, mFrom, mTo, entityId);
    const mPossible = employees.length * mWorking;
    monthlyTrend.push({
      month: mLabel,
      attendancePercentage:
        mPossible > 0 ? Math.round((mPresent / mPossible) * 1000) / 10 : 0,
    });
  }

  const deptMap = new Map<string, { present: number; late: number; possible: number }>();
  for (const emp of employees) {
    const dept = emp.department?.trim() || "Unassigned";
    if (!deptMap.has(dept)) deptMap.set(dept, { present: 0, late: 0, possible: 0 });
    deptMap.get(dept)!.possible += workingDays;
  }

  for (const r of records) {
    const dept = r.employee?.department?.trim() || "Unassigned";
    const entry = deptMap.get(dept);
    if (!entry) continue;
    if (["present", "remote", "hybrid"].includes(r.status)) entry.present++;
    if (r.status === "late") {
      entry.late++;
      entry.present++;
    }
  }

  const departmentBreakdown = [...deptMap.entries()].map(([department, d]) => {
    const absent = Math.max(0, d.possible - d.present);
    return {
      department,
      attendancePercentage:
        d.possible > 0 ? Math.round((d.present / d.possible) * 1000) / 10 : 0,
      latePercentage: d.present > 0 ? Math.round((d.late / d.present) * 1000) / 10 : 0,
      absentPercentage:
        d.possible > 0 ? Math.round((absent / d.possible) * 1000) / 10 : 0,
    };
  });

  return {
    attendancePercentage,
    latePercentage,
    averageWorkingHours,
    remotePercentage,
    hybridPercentage,
    monthlyTrend,
    departmentBreakdown,
  };
}
