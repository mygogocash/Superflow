import type { Prisma } from "@nexora/database";

import { prisma } from "@/infrastructure/database/prisma";

const recordIncludes = {
  employee: {
    select: {
      id: true,
      name: true,
      email: true,
      department: true,
      employeeId: true,
      timezone: true,
    },
  },
} satisfies Prisma.AttendanceRecordInclude;

export class AttendanceRepository {
  async findPolicyForEntity(entityId: string | null | undefined) {
    if (entityId) {
      const entityPolicy = await prisma.attendancePolicy.findFirst({
        where: { entityId, isActive: true },
      });
      if (entityPolicy) return entityPolicy;
    }
    return prisma.attendancePolicy.findFirst({
      where: { entityId: null, isActive: true },
    });
  }

  async findRecordByEmployeeAndDate(employeeId: string, attendanceDate: Date) {
    return prisma.attendanceRecord.findUnique({
      where: {
        employeeId_attendanceDate: { employeeId, attendanceDate },
      },
      include: recordIncludes,
    });
  }

  async createRecord(data: Prisma.AttendanceRecordUncheckedCreateInput) {
    return prisma.attendanceRecord.create({
      data,
      include: recordIncludes,
    });
  }

  async updateRecord(
    id: string,
    data: Prisma.AttendanceRecordUncheckedUpdateInput,
  ) {
    return prisma.attendanceRecord.update({
      where: { id },
      data,
      include: recordIncludes,
    });
  }

  async findRecordsForDate(attendanceDate: Date, employeeIds?: string[]) {
    const where: Prisma.AttendanceRecordWhereInput = { attendanceDate };
    if (employeeIds?.length) {
      where.employeeId = { in: employeeIds };
    }
    return prisma.attendanceRecord.findMany({
      where,
      include: recordIncludes,
      orderBy: [{ employee: { name: "asc" } }],
    });
  }

  async findRecords(
    filters: {
      employeeId?: string;
      from?: Date;
      to?: Date;
      status?: string;
      department?: string;
    },
    page: number,
    limit: number,
  ) {
    const where: Prisma.AttendanceRecordWhereInput = {};
    if (filters.employeeId) where.employeeId = filters.employeeId;
    if (filters.status) where.status = filters.status;
    if (filters.from || filters.to) {
      where.attendanceDate = {};
      if (filters.from) where.attendanceDate.gte = filters.from;
      if (filters.to) where.attendanceDate.lte = filters.to;
    }
    if (filters.department) {
      where.employee = { department: filters.department };
    }

    const [data, total] = await Promise.all([
      prisma.attendanceRecord.findMany({
        where,
        include: recordIncludes,
        orderBy: [{ attendanceDate: "desc" }, { employee: { name: "asc" } }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.attendanceRecord.count({ where }),
    ]);

    return { data, total };
  }

  async countActiveEmployees(department?: string) {
    return prisma.user.count({
      where: {
        isActive: true,
        ...(department ? { department } : {}),
      },
    });
  }

  async findActiveEmployees(department?: string) {
    return prisma.user.findMany({
      where: {
        isActive: true,
        ...(department ? { department } : {}),
      },
      select: {
        id: true,
        name: true,
        email: true,
        department: true,
        employeeId: true,
        entityId: true,
      },
      orderBy: { name: "asc" },
    });
  }

  async hasApprovedLeaveOnDate(employeeId: string, date: Date) {
    // Raw SQL avoids Prisma selecting schema columns (e.g. duration_type)
    // that may not exist until pending leave migrations are applied.
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM leave_requests
      WHERE employee_id = ${employeeId}::uuid
        AND status = 'approved'
        AND deleted_at IS NULL
        AND start_date <= ${date}::date
        AND end_date >= ${date}::date
      LIMIT 1
    `;
    return rows.length > 0;
  }

  async findApprovedLeavesInRange(
    employeeIds: string[],
    from: Date,
    to: Date,
  ): Promise<Array<{ employeeId: string; startDate: Date; endDate: Date }>> {
    if (!employeeIds.length) return [];

    return prisma.$queryRaw<
      Array<{ employeeId: string; startDate: Date; endDate: Date }>
    >`
      SELECT
        employee_id AS "employeeId",
        start_date AS "startDate",
        end_date AS "endDate"
      FROM leave_requests
      WHERE employee_id = ANY(${employeeIds}::uuid[])
        AND status = 'approved'
        AND deleted_at IS NULL
        AND start_date <= ${to}::date
        AND end_date >= ${from}::date
    `;
  }

  async createAuditLog(data: Prisma.AttendanceAuditLogUncheckedCreateInput) {
    return prisma.attendanceAuditLog.create({ data });
  }

  async aggregateMonthlyStats(
    from: Date,
    to: Date,
    filters?: { employeeId?: string; department?: string },
  ) {
    const where: Prisma.AttendanceRecordWhereInput = {
      attendanceDate: { gte: from, lte: to },
    };
    if (filters?.employeeId) where.employeeId = filters.employeeId;
    if (filters?.department) {
      where.employee = { department: filters.department };
    }

    return prisma.attendanceRecord.groupBy({
      by: ["status", "workMode"],
      where,
      _count: { _all: true },
    });
  }

  async findRecordsInRange(
    from: Date,
    to: Date,
    filters?: {
      employeeId?: string;
      employeeIds?: string[];
      department?: string;
    },
  ) {
    const where: Prisma.AttendanceRecordWhereInput = {
      attendanceDate: { gte: from, lte: to },
    };
    if (filters?.employeeId) where.employeeId = filters.employeeId;
    if (filters?.employeeIds?.length) {
      where.employeeId = { in: filters.employeeIds };
    }
    if (filters?.department) {
      where.employee = { department: filters.department };
    }

    return prisma.attendanceRecord.findMany({
      where,
      include: recordIncludes,
      orderBy: [{ attendanceDate: "asc" }],
    });
  }

  async countLateInRange(
    from: Date,
    to: Date,
    filters?: { employeeId?: string; department?: string },
  ) {
    const where: Prisma.AttendanceRecordWhereInput = {
      attendanceDate: { gte: from, lte: to },
      status: "late",
    };
    if (filters?.employeeId) where.employeeId = filters.employeeId;
    if (filters?.department) {
      where.employee = { department: filters.department };
    }
    return prisma.attendanceRecord.count({ where });
  }

  async countAbsentInRange(
    from: Date,
    to: Date,
    filters?: { employeeId?: string; department?: string },
  ) {
    const where: Prisma.AttendanceRecordWhereInput = {
      attendanceDate: { gte: from, lte: to },
      status: "absent",
    };
    if (filters?.employeeId) where.employeeId = filters.employeeId;
    if (filters?.department) {
      where.employee = { department: filters.department };
    }
    return prisma.attendanceRecord.count({ where });
  }

  async groupByDepartmentForDate(attendanceDate: Date) {
    const records = await prisma.attendanceRecord.findMany({
      where: { attendanceDate },
      include: {
        employee: { select: { department: true } },
      },
    });

    const employees = await prisma.user.findMany({
      where: { isActive: true },
      select: { id: true, department: true },
    });

    return { records, employees };
  }
}

export const attendanceRepository = new AttendanceRepository();
