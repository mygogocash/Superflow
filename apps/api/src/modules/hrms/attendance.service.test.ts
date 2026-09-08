import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BadRequestException } from "@/common/exceptions/http-exception";
import { attendanceRepository } from "@/modules/hrms/attendance.repository";
import { attendanceService } from "@/modules/hrms/attendance.service";
import { attendanceCalendarService } from "@/modules/hrms/attendance-calendar.service";

vi.mock("@/modules/hrms/attendance.repository", () => ({
  attendanceRepository: {
    findRecordByEmployeeAndDate: vi.fn(),
    findPolicyForEntity: vi.fn(),
    hasApprovedLeaveOnDate: vi.fn(),
    createRecord: vi.fn(),
    updateRecord: vi.fn(),
    createAuditLog: vi.fn(),
    findRecordsInRange: vi.fn(),
  },
}));

vi.mock("@/modules/hrms/attendance-calendar.service", () => ({
  attendanceCalendarService: {
    countWorkingDaysInRange: vi.fn(),
    classifyNonWorkingDay: vi.fn(),
  },
}));

vi.mock("@/infrastructure/database/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn().mockResolvedValue({ entityId: null, timezone: null }),
    },
  },
}));

const EMPLOYEE = {
  id: "user-1",
  name: "Jane",
  email: "jane@example.com",
  department: "HR",
  employeeId: "MNT-001",
  timezone: "Asia/Bangkok",
};

function recordStub(over: Record<string, unknown> = {}) {
  return {
    id: "rec",
    employeeId: "user-1",
    attendanceDate: new Date("2026-06-12T00:00:00.000Z"),
    checkIn: null,
    checkOut: null,
    checkInUtc: null,
    checkOutUtc: null,
    employeeTimezone: "Asia/Bangkok",
    localCheckInTime: null,
    localCheckOutTime: null,
    workMode: "office",
    status: "present",
    totalHours: null,
    lateMinutes: 0,
    remarks: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    employee: EMPLOYEE,
    ...over,
  } as never;
}

describe("AttendanceService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Pin the clock to 08:00 Bangkok (before the 09:00 shift) so the default
    // check-in is deterministically on-time.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T01:00:00.000Z"));
    vi.mocked(attendanceRepository.findPolicyForEntity).mockResolvedValue({
      id: "policy-1",
      entityId: null,
      shiftStartTime: "09:00",
      shiftEndTime: "18:00",
      graceMinutes: 15,
      halfDayThresholdHours: 4,
      minimumWorkingHours: 8,
      allowedWorkModes: ["office", "remote", "hybrid"],
      weekendDays: [0, 6],
      attendanceThresholdPct: 80,
      defaultTimezone: "Asia/Bangkok",
      missedCheckInAfterMinutes: 120,
      missedCheckOutAfterMinutes: 60,
      consecutiveAbsenceAlertDays: 3,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    vi.mocked(attendanceRepository.hasApprovedLeaveOnDate).mockResolvedValue(
      false,
    );
    vi.mocked(attendanceRepository.createAuditLog).mockResolvedValue(
      {} as never,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("checkIn", () => {
    it("rejects duplicate check-in", async () => {
      vi.mocked(
        attendanceRepository.findRecordByEmployeeAndDate,
      ).mockResolvedValue(recordStub({ checkIn: new Date() }));

      await expect(
        attendanceService.checkIn("user-1", { workMode: "office" }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("creates an on-time remote check-in", async () => {
      vi.mocked(
        attendanceRepository.findRecordByEmployeeAndDate,
      ).mockResolvedValue(null);
      vi.mocked(attendanceRepository.createRecord).mockImplementation(
        async (data) => recordStub(data as Record<string, unknown>),
      );

      const result = await attendanceService.checkIn("user-1", {
        workMode: "remote",
      });

      expect(result.status).toBe("remote");
      expect(attendanceRepository.createRecord).toHaveBeenCalledOnce();
    });

    it("marks a check-in past the grace window as late", async () => {
      // 10:00 Bangkok = 03:00 UTC, well past 09:15 grace boundary.
      vi.setSystemTime(new Date("2026-06-12T03:00:00.000Z"));
      vi.mocked(
        attendanceRepository.findRecordByEmployeeAndDate,
      ).mockResolvedValue(null);
      vi.mocked(attendanceRepository.createRecord).mockImplementation(
        async (data) => recordStub(data as Record<string, unknown>),
      );

      const result = await attendanceService.checkIn("user-1", {
        workMode: "office",
      });

      expect(result.status).toBe("late");
      expect(result.lateMinutes).toBeGreaterThan(0);
    });

    it("records on_leave status when the employee has approved leave", async () => {
      vi.mocked(attendanceRepository.hasApprovedLeaveOnDate).mockResolvedValue(
        true,
      );
      vi.mocked(
        attendanceRepository.findRecordByEmployeeAndDate,
      ).mockResolvedValue(null);
      vi.mocked(attendanceRepository.createRecord).mockImplementation(
        async (data) => recordStub(data as Record<string, unknown>),
      );

      const result = await attendanceService.checkIn("user-1", {
        workMode: "office",
      });

      expect(result.status).toBe("on_leave");
      expect(result.lateMinutes).toBe(0);
    });
  });

  describe("checkOut", () => {
    it("rejects when there is no check-in", async () => {
      vi.mocked(
        attendanceRepository.findRecordByEmployeeAndDate,
      ).mockResolvedValue(null);
      await expect(
        attendanceService.checkOut("user-1", {}),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects a double check-out", async () => {
      vi.mocked(
        attendanceRepository.findRecordByEmployeeAndDate,
      ).mockResolvedValue(
        recordStub({ checkIn: new Date(), checkOut: new Date() }),
      );
      await expect(
        attendanceService.checkOut("user-1", {}),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("computes totalHours on a valid check-out", async () => {
      const checkIn = new Date("2026-06-11T17:00:00.000Z"); // 8h before now
      vi.mocked(
        attendanceRepository.findRecordByEmployeeAndDate,
      ).mockResolvedValue(recordStub({ id: "rec-x", checkIn, checkOut: null }));
      vi.mocked(attendanceRepository.updateRecord).mockImplementation(
        async (_id, data) =>
          recordStub({ checkIn, ...(data as Record<string, unknown>) }),
      );

      await attendanceService.checkOut("user-1", {});

      const call = vi.mocked(attendanceRepository.updateRecord).mock.calls[0];
      expect(call?.[1]).toMatchObject({ totalHours: 8 });
    });
  });

  describe("getMonthlyReport", () => {
    it("aggregates present/late/absent against working days", async () => {
      vi.mocked(attendanceRepository.findRecordsInRange).mockResolvedValue([
        recordStub({ status: "present", workMode: "office" }),
        recordStub({ status: "late", workMode: "office" }),
        recordStub({ status: "remote", workMode: "remote" }),
      ] as never);
      vi.mocked(
        attendanceCalendarService.countWorkingDaysInRange,
      ).mockResolvedValue(20);

      const report = await attendanceService.getMonthlyReport(
        "user-1",
        ["hrms:attendance-read"],
        { month: "2026-06" } as never,
      );

      expect(report.totalWorkingDays).toBe(20);
      expect(report.daysPresent).toBe(3); // present + late + remote
      expect(report.lateArrivals).toBe(1);
      // 3 / 20 = 15%
      expect(report.attendancePercentage).toBe(15);
    });
  });
});
