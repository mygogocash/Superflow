import type { Db } from "@nexora/db";
import { PERMISSIONS } from "@nexora/contracts";
import { ForbiddenException } from "../../http-exception.js";
import * as attendanceRepo from "./attendance.repository.js";
import type { ExecutiveAttendanceAnalytics } from "@nexora/contracts/modules/hrms/attendance.types";
import * as calendarService from "./attendance-calendar.service.js";
import type { ExecutiveAnalyticsQuery } from "@nexora/contracts/modules/hrms/attendance-phase3.validation";
import { serializeAttendanceRecord } from "./attendance-record.serializer.js";
import * as shiftService from "./attendance-shift.service.js";
import { COMPANY_DEFAULT_TIMEZONE } from "@nexora/contracts/modules/hrms/attendance-timezone.util";

function parseMonth(month?: string): { from: Date; to: Date; label: string } {
  const now = new Date();
  const label =
    month ?? `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const [yearStr, monStr] = label.split("-");
  const year = Number(yearStr);
  const mon = Number(monStr);
  const from = new Date(Date.UTC(year, mon - 1, 1));
  const to = new Date(Date.UTC(year, mon, 0));
  return { from, to, label };
}

export async function getExecutiveAnalytics(
  db: Db,
  actorPermissions: string[],
    query: ExecutiveAnalyticsQuery,
  ): Promise<ExecutiveAttendanceAnalytics> {
    // Org-wide executive dump is manage-only; attendance:read is not dump-all.
    if (!actorPermissions.includes(PERMISSIONS.HRMS_ATTENDANCE_MANAGE)) {
      throw new ForbiddenException(
        "Executive attendance analytics requires HR manage access",
      );
    }

    const { from, to } = parseMonth(query.month);
    const employees = await attendanceRepo.findActiveEmployees(db, query.department);
    const records = await attendanceRepo.findRecordsInRange(db, from, to, {
      department: query.department,
    });

    const entityId = employees[0]?.entityId ?? null;
    const workingDays = await calendarService.countWorkingDaysInRange(db, from, to, entityId);

    let totalHours = 0;
    let hoursCount = 0;
    const byEmployee = new Map<
      string,
      { present: number; late: number; remote: number; office: number }
    >();

    for (const emp of employees) {
      byEmployee.set(emp.id, { present: 0, late: 0, remote: 0, office: 0 });
    }

    for (const r of records) {
      const bucket = byEmployee.get(r.employeeId);
      if (!bucket) continue;
      if (["present", "late", "remote", "hybrid"].includes(r.status)) {
        bucket.present++;
      }
      if (r.status === "late") bucket.late++;
      if (r.workMode === "remote" || r.status === "remote") bucket.remote++;
      if (r.workMode === "office" || r.status === "present") bucket.office++;
      if (r.totalHours !== null) {
        totalHours += Number(r.totalHours);
        hoursCount++;
      }
    }

    const employeeStats = employees.map((emp) => {
      const b = byEmployee.get(emp.id) ?? {
        present: 0,
        late: 0,
        remote: 0,
        office: 0,
      };
      const possible = workingDays;
      const attendancePercentage =
        possible > 0 ? Math.round((b.present / possible) * 1000) / 10 : 0;
      const latePercentage =
        b.present > 0 ? Math.round((b.late / b.present) * 1000) / 10 : 0;
      return {
        employeeId: emp.id,
        name: emp.name,
        department: emp.department,
        attendancePercentage,
        latePercentage,
        present: b.present,
        late: b.late,
      };
    });

    const mostPunctualEmployees = [...employeeStats]
      .filter((e) => e.present > 0)
      .sort((a, b) => a.latePercentage - b.latePercentage)
      .slice(0, 5)
      .map(({ present: _p, late: _l, ...rest }) => rest);

    const highestAttendanceEmployees = [...employeeStats]
      .sort((a, b) => b.attendancePercentage - a.attendancePercentage)
      .slice(0, 5)
      .map(({ latePercentage: _l, ...rest }) => rest);

    const deptMap = new Map<
      string,
      { headcount: number; absent: number; present: number }
    >();
    for (const emp of employees) {
      const dept = emp.department ?? "Unassigned";
      const cur = deptMap.get(dept) ?? { headcount: 0, absent: 0, present: 0 };
      cur.headcount++;
      const b = byEmployee.get(emp.id);
      if (b) {
        cur.present += b.present;
        cur.absent += Math.max(0, workingDays - b.present);
      }
      deptMap.set(dept, cur);
    }

    const highestAbsenteeDepartments = [...deptMap.entries()]
      .map(([department, v]) => ({
        department,
        headcount: v.headcount,
        absentPercentage:
          v.headcount * workingDays > 0
            ? Math.round((v.absent / (v.headcount * workingDays)) * 1000) / 10
            : 0,
      }))
      .sort((a, b) => b.absentPercentage - a.absentPercentage)
      .slice(0, 5);

    const attendanceTrend: ExecutiveAttendanceAnalytics["attendanceTrend"] = [];
    const remoteVsOfficeTrend: ExecutiveAttendanceAnalytics["remoteVsOfficeTrend"] =
      [];

    for (let i = 5; i >= 0; i--) {
      const d = new Date(from);
      d.setUTCMonth(d.getUTCMonth() - i);
      const mFrom = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
      const mTo = new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
      );
      const mLabel = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      const mRecords = await attendanceRepo.findRecordsInRange(db, mFrom, mTo,
        { department: query.department },
      );
      const mPresent = mRecords.filter((r) =>
        ["present", "late", "remote", "hybrid"].includes(r.status),
      ).length;
      const mRemote = mRecords.filter(
        (r) => r.workMode === "remote" || r.status === "remote",
      ).length;
      const mOffice = mRecords.filter(
        (r) => r.workMode === "office" && r.status !== "remote",
      ).length;
      const mPossible = employees.length * workingDays;
      const pct =
        mPossible > 0 ? Math.round((mPresent / mPossible) * 1000) / 10 : 0;
      attendanceTrend.push({ month: mLabel, attendancePercentage: pct });
      remoteVsOfficeTrend.push({
        month: mLabel,
        remotePercentage:
          mPresent > 0 ? Math.round((mRemote / mPresent) * 1000) / 10 : 0,
        officePercentage:
          mPresent > 0 ? Math.round((mOffice / mPresent) * 1000) / 10 : 0,
      });
    }

    return {
      averageWorkingHours:
        hoursCount > 0 ? Math.round((totalHours / hoursCount) * 100) / 100 : 0,
      mostPunctualEmployees,
      highestAttendanceEmployees,
      highestAbsenteeDepartments,
      attendanceTrend,
      remoteVsOfficeTrend,
      monthlyAttendanceTrend: attendanceTrend,
    };
}

export async function getEmployeeProfileSummary(db: Db, employeeId: string, month?: string) {
    const user = await import("./attendance-meta.repository.js").then((m) =>
      m.findUserById(db, employeeId),
    );
    if (!user) return null;

    const { from, to, label } = parseMonth(month);
    const records = await attendanceRepo.findRecordsInRange(db, from, to, {
      employeeId,
    });
    const workingDays = await calendarService.countWorkingDaysInRange(db, from, to, user.entityId);

    let present = 0;
    let late = 0;
    for (const r of records) {
      if (["present", "late", "remote", "hybrid"].includes(r.status)) {
        present++;
      }
      if (r.status === "late") late++;
    }

    const lastRecord = await attendanceRepo.findLastRecordWithCheckIn(db, employeeId);

    const policy = await attendanceRepo.findPolicyForEntity(db, user.entityId);
    const companyTz = policy?.defaultTimezone ?? COMPANY_DEFAULT_TIMEZONE;
    const shiftAssignment = await shiftService.getEmployeeShift(db, employeeId, new Date());

    const serialized = lastRecord
      ? serializeAttendanceRecord(lastRecord, companyTz)
      : null;

    return {
      employeeId: user.id,
      name: user.name,
      department: user.department,
      attendancePercentage:
        workingDays > 0 ? Math.round((present / workingDays) * 1000) / 10 : 0,
      latePercentage:
        present > 0 ? Math.round((late / present) * 1000) / 10 : 0,
      currentShift: shiftAssignment?.shift
        ? {
            id: shiftAssignment.shift.id,
            entityId: shiftAssignment.shift.entityId,
            shiftName: shiftAssignment.shift.shiftName,
            startTime: shiftAssignment.shift.startTime,
            endTime: shiftAssignment.shift.endTime,
            graceMinutes: shiftAssignment.shift.graceMinutes,
            active: shiftAssignment.shift.active,
          }
        : null,
      lastCheckIn: serialized?.checkInUtc ?? null,
      lastCheckOut: serialized?.checkOutUtc ?? null,
      lastCheckInDisplay: serialized?.checkInDisplay ?? null,
      lastCheckOutDisplay: serialized?.checkOutDisplay ?? null,
      monthlySummary: {
        month: label,
        employeeId,
        attendancePercentage:
          workingDays > 0 ? Math.round((present / workingDays) * 1000) / 10 : 0,
        lateArrivals: late,
        absenteeCount: Math.max(0, workingDays - present),
        remoteDays: records.filter((r) => r.workMode === "remote").length,
        officeDays: records.filter((r) => r.workMode === "office").length,
        hybridDays: records.filter((r) => r.workMode === "hybrid").length,
        totalWorkingDays: workingDays,
        daysPresent: present,
        remoteVsOfficeRatio:
          present > 0
            ? Math.round(
                (records.filter((r) => r.workMode === "remote").length /
                  present) *
                  1000,
              ) / 10
            : 0,
      },
    };
}
