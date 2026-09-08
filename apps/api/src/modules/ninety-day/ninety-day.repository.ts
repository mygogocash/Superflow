import type { Prisma } from "@nexora/database";

import { prisma } from "@/infrastructure/database/prisma";

const includes = {
  employee: { select: { id: true, name: true, email: true, department: true } },
  entity: { select: { id: true, name: true, code: true } },
} satisfies Prisma.NinetyDayNotificationInclude;

export class NinetyDayRepository {
  async findMany(
    filters: {
      employeeId?: string;
      status?: string;
      search?: string;
      entityId?: string;
    },
    page: number,
    limit: number,
  ) {
    const where: Prisma.NinetyDayNotificationWhereInput = {};
    if (filters.employeeId) where.employeeId = filters.employeeId;
    if (filters.status) where.status = filters.status;
    if (filters.entityId) where.entityId = filters.entityId;
    if (filters.search && filters.search.trim().length > 0) {
      where.employee = {
        is: { name: { contains: filters.search, mode: "insensitive" } },
      };
    }

    const [data, total] = await Promise.all([
      prisma.ninetyDayNotification.findMany({
        where,
        include: includes,
        orderBy: { dueDate: "asc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.ninetyDayNotification.count({ where }),
    ]);

    return { data, total };
  }

  async findById(id: string) {
    return prisma.ninetyDayNotification.findUnique({
      where: { id },
      include: includes,
    });
  }

  async create(data: Prisma.NinetyDayNotificationUncheckedCreateInput) {
    return prisma.ninetyDayNotification.create({ data, include: includes });
  }

  async update(
    id: string,
    data: Prisma.NinetyDayNotificationUncheckedUpdateInput,
  ) {
    return prisma.ninetyDayNotification.update({
      where: { id },
      data,
      include: includes,
    });
  }

  async delete(id: string) {
    return prisma.ninetyDayNotification.delete({ where: { id } });
  }

  // Bulk-import lookup helpers — mirror visa.repository's surface so HR
  // can paste a sheet keyed by UUID, staff code (e.g. "MNT-001"), email,
  // or full name and the importer resolves it to a real User row.
  findUsersByIds(ids: string[]) {
    if (ids.length === 0) {
      return Promise.resolve(
        [] as Array<{
          id: string;
          name: string;
          email: string;
          employeeId: string | null;
        }>,
      );
    }
    return prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, email: true, employeeId: true },
    });
  }

  findUsersByEmails(emails: string[]) {
    if (emails.length === 0) {
      return Promise.resolve(
        [] as Array<{
          id: string;
          name: string;
          email: string;
          employeeId: string | null;
        }>,
      );
    }
    return prisma.user.findMany({
      where: { email: { in: emails, mode: "insensitive" } },
      select: { id: true, name: true, email: true, employeeId: true },
    });
  }

  findUsersByEmployeeCodes(codes: string[]) {
    if (codes.length === 0) {
      return Promise.resolve(
        [] as Array<{
          id: string;
          name: string;
          email: string;
          employeeId: string | null;
        }>,
      );
    }
    return prisma.user.findMany({
      where: { employeeId: { in: codes } },
      select: { id: true, name: true, email: true, employeeId: true },
    });
  }

  findActiveUsersForBulkMatch() {
    return prisma.user.findMany({
      where: { isActive: true },
      select: { id: true, name: true, email: true, employeeId: true },
    });
  }
}

export const ninetyDayRepository = new NinetyDayRepository();
