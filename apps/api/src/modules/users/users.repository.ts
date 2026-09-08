import { Prisma } from "@nexora/database";

import { prisma } from "@/infrastructure/database/prisma";
import { excludeDeleted, softDeleteUpdate } from "@/infrastructure/soft-delete";
import type { ListUsersQuery } from "@/modules/users/users.validation";

export class UsersRepository {
  async findMany(query: ListUsersQuery) {
    const {
      page,
      limit,
      search,
      entityId,
      roleId,
      isActive,
      department,
      employmentType,
      includePlaceholders,
      sortBy,
      sortOrder,
      userIds,
    } = query;

    const where: Prisma.UserWhereInput = {
      ...excludeDeleted("deletedAt"),
    };

    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
        { employeeId: { contains: search, mode: "insensitive" } },
      ];
    }

    if (entityId) where.entityId = entityId;
    if (department) where.department = department;
    if (employmentType) where.employmentType = employmentType;
    if (isActive !== undefined) where.isActive = isActive;
    if (userIds) {
      where.id = { in: userIds };
    }
    // Payroll bulk-import mints dormant placeholders with emails of the
    // form `payroll-<uuid>@placeholder.local`. Hide them from the
    // Employees directory by default — they belong on payslips, not on
    // the org chart. HR can flip `includePlaceholders=true` to audit.
    if (!includePlaceholders) {
      where.NOT = {
        ...(where.NOT as Prisma.UserWhereInput | undefined),
        email: { endsWith: "@placeholder.local" },
      };
    }
    if (roleId) {
      where.userRoles = { some: { roleId } };
    }

    const include = {
      entity: { select: { id: true, name: true } },
      userRoles: {
        include: { role: { select: { id: true, name: true } } },
      },
      manager: { select: { id: true, name: true, email: true } },
    } as const;

    if (sortBy === "employeeId") {
      // Natural-numeric order: extract trailing digits so e.g. MNT-0088 sorts
      // as 88 (after MNT-009/MNT-045) instead of lexicographically between
      // MNT-008 and MNT-009. Falls back to raw employee_id for ties.
      const dir = sortOrder === "desc" ? Prisma.raw("DESC") : Prisma.raw("ASC");
      const searchPattern = search ? `%${search.toLowerCase()}%` : null;
      const userIdFilter =
        userIds === undefined
          ? Prisma.empty
          : userIds.length === 0
            ? Prisma.sql`AND false`
            : Prisma.sql`AND u.id IN (${Prisma.join(userIds)})`;

      const idRows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT u.id
        FROM users u
        WHERE u.deleted_at IS NULL
          AND (${entityId ?? null}::text IS NULL OR u.entity_id = ${entityId ?? null})
          AND (${department ?? null}::text IS NULL OR u.department = ${department ?? null})
          AND (${employmentType ?? null}::text IS NULL OR u.employment_type = ${employmentType ?? null})
          AND (${isActive ?? null}::boolean IS NULL OR u.is_active = ${isActive ?? null}::boolean)
          -- Mirror the Prisma-side default: hide payroll-placeholder
          -- users unless includePlaceholders=true was passed.
          AND (${includePlaceholders ?? false}::boolean = true OR u.email NOT LIKE '%@placeholder.local')
          AND (${roleId ?? null}::uuid IS NULL OR EXISTS (
            SELECT 1 FROM user_roles ur
            WHERE ur.user_id = u.id AND ur.role_id = ${roleId ?? null}::uuid
          ))
          ${userIdFilter}
          AND (
            ${searchPattern}::text IS NULL
            OR LOWER(u.name) LIKE ${searchPattern}
            OR LOWER(u.email) LIKE ${searchPattern}
            OR LOWER(u.employee_id) LIKE ${searchPattern}
          )
        ORDER BY
          NULLIF(regexp_replace(COALESCE(u.employee_id, ''), '[^0-9]', '', 'g'), '')::bigint ${dir} NULLS LAST,
          u.employee_id ${dir} NULLS LAST
        LIMIT ${limit} OFFSET ${(page - 1) * limit}
      `);

      const orderedIds = idRows.map((r) => r.id);
      const [users, total] = await Promise.all([
        prisma.user.findMany({
          where: { id: { in: orderedIds } },
          include,
        }),
        prisma.user.count({ where }),
      ]);

      const orderMap = new Map(orderedIds.map((id, idx) => [id, idx]));
      users.sort(
        (a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0),
      );

      return { users, total };
    }

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        include,
        orderBy: { [sortBy]: sortOrder },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.user.count({ where }),
    ]);

    return { users, total };
  }

  async findById(id: string) {
    return prisma.user.findUnique({
      where: { id },
      include: {
        entity: { select: { id: true, name: true } },
        userRoles: {
          include: {
            role: {
              select: { id: true, name: true, description: true },
            },
          },
        },
        manager: { select: { id: true, name: true, email: true } },
      },
    });
  }

  async findByEmail(email: string) {
    return prisma.user.findUnique({ where: { email } });
  }

  async findByEmployeeId(employeeId: string) {
    return prisma.user.findFirst({ where: { employeeId } });
  }

  /**
   * Next MNT-### code from existing MNT-{digits} employee_id values (seed convention).
   */
  async allocateNextEmployeeId(): Promise<string> {
    const rows = await prisma.$queryRaw<Array<{ max: number | null }>>`
      SELECT MAX(
        ((regexp_match(employee_id, '^MNT-([0-9]+)$', 'i'))[1])::integer
      ) AS max
      FROM users
      WHERE employee_id IS NOT NULL
    `;
    const max = rows[0]?.max ?? 0;
    const next = max + 1;
    return `MNT-${String(next).padStart(3, "0")}`;
  }

  async create(
    data: Prisma.UserCreateInput & { roleIds?: string[] },
    assignedBy?: string,
  ) {
    const { roleIds, ...userData } = data;

    return prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: userData });

      if (roleIds && roleIds.length > 0) {
        await tx.userRole.createMany({
          data: roleIds.map((roleId) => ({
            userId: user.id,
            roleId,
            assignedBy,
          })),
        });
      }

      return tx.user.findUnique({
        where: { id: user.id },
        include: {
          entity: { select: { id: true, name: true } },
          userRoles: {
            include: { role: { select: { id: true, name: true } } },
          },
        },
      });
    });
  }

  async update(id: string, data: Prisma.UserUncheckedUpdateInput) {
    return prisma.user.update({
      where: { id },
      data,
      include: {
        entity: { select: { id: true, name: true } },
        userRoles: {
          include: { role: { select: { id: true, name: true } } },
        },
        manager: { select: { id: true, name: true, email: true } },
      },
    });
  }

  async delete(id: string) {
    return prisma.user.delete({ where: { id } });
  }

  /**
   * Removes FK rows that would block `users` delete (seed users have no Supabase Auth;
   * DB-only users still reference deals, leave requests, etc.).
   * `reassignedToUserId` must be an active admin (typically the caller) for required owner/creator FKs.
   */
  async deleteWithCleanup(id: string, reassignedToUserId: string) {
    await prisma.$transaction(async (tx) => {
      await tx.user.updateMany({
        where: { reportingTo: id },
        data: { reportingTo: null },
      });

      await tx.leaveRequest.deleteMany({ where: { employeeId: id } });
      await tx.leaveRequest.updateMany({
        where: { approvedBy: id },
        data: { approvedBy: null },
      });

      await tx.expense.deleteMany({ where: { employeeId: id } });
      await tx.expense.updateMany({
        where: { approvedBy: id },
        data: { approvedBy: null, approvedAt: null },
      });

      await tx.payslip.deleteMany({ where: { employeeId: id } });
      await tx.consultantInvoice.deleteMany({ where: { consultantId: id } });
      await tx.esopGrant.deleteMany({ where: { employeeId: id } });
      await tx.onboardingRun.updateMany({
        where: { employeeId: id },
        data: { employeeId: null },
      });
      await tx.benefitEnrollment.deleteMany({ where: { employeeId: id } });

      await tx.payrollRun.updateMany({
        where: { runBy: id },
        data: { runBy: reassignedToUserId },
      });
      await tx.payrollRun.updateMany({
        where: { approvedBy: id },
        data: { approvedBy: null, approvedAt: null },
      });

      await tx.deal.updateMany({
        where: { ownerId: id },
        data: { ownerId: reassignedToUserId },
      });
      await tx.project.updateMany({
        where: { ownerId: id },
        data: { ownerId: reassignedToUserId },
      });
      await tx.projectMember.deleteMany({ where: { userId: id } });
      await tx.projectTask.updateMany({
        where: { ownerId: id },
        data: { ownerId: null },
      });

      await tx.deskBooking.deleteMany({ where: { employeeId: id } });
      await tx.roomBooking.deleteMany({ where: { employeeId: id } });
      await tx.asset.updateMany({
        where: { assignedTo: id },
        data: { assignedTo: null },
      });

      await tx.message.deleteMany({ where: { authorId: id } });
      await tx.conversation.deleteMany({ where: { createdBy: id } });

      await tx.wallComment.deleteMany({ where: { authorId: id } });
      await tx.wallPost.deleteMany({ where: { authorId: id } });
      await tx.companyNews.deleteMany({ where: { authorId: id } });
      await tx.companyDate.deleteMany({ where: { addedBy: id } });
      await tx.ariaConversation.deleteMany({ where: { userId: id } });

      await tx.blog.deleteMany({ where: { authorId: id } });
      await tx.article.deleteMany({ where: { authorId: id } });

      await tx.investor.updateMany({
        where: { addedBy: id },
        data: { addedBy: reassignedToUserId },
      });
      await tx.dataRoomDocument.deleteMany({ where: { uploadedBy: id } });
      await tx.investorUpdate.updateMany({
        where: { sentBy: id },
        data: { sentBy: null },
      });

      await tx.journalEntry.updateMany({
        where: { createdBy: id },
        data: { createdBy: reassignedToUserId },
      });
      await tx.journalEntry.updateMany({
        where: { approvedBy: id },
        data: { approvedBy: null, approvedAt: null },
      });

      await tx.auditLog.updateMany({
        where: { userId: id },
        data: { userId: null },
      });

      // Preserve the attendance audit trail when the actor is deleted (the
      // FK is ON DELETE SET NULL, this makes the intent explicit + in-tx).
      await tx.attendanceAuditLog.updateMany({
        where: { actorId: id },
        data: { actorId: null },
      });

      await tx.moduleAccess.updateMany({
        where: { grantedBy: id },
        data: { grantedBy: null },
      });
      await tx.moduleOwner.updateMany({
        where: { ownerId: id },
        data: { ownerId: null },
      });

      await tx.userSetting.deleteMany({ where: { userId: id } });
      await tx.fileUpload.deleteMany({ where: { uploadedBy: id } });

      await tx.user.delete({ where: { id } });
    });
  }

  async stats() {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    // Payroll bulk-import mints dormant placeholders with emails of the
    // form `payroll-<uuid>@placeholder.local`. Those rows exist purely
    // to FK payslips and don't belong in the headcount KPIs — mirror
    // the directory-list filter so the Employees page stat cards line
    // up with the table beneath them.
    const excludePlaceholders: Prisma.UserWhereInput = {
      AND: [
        { NOT: { email: { endsWith: "@placeholder.local" } } },
        { deletedAt: null },
      ],
    };

    const [total, active, inactive, newThisMonth, byEmploymentType] =
      await Promise.all([
        prisma.user.count({ where: excludePlaceholders }),
        prisma.user.count({
          where: { AND: [excludePlaceholders, { isActive: true }] },
        }),
        prisma.user.count({
          where: { AND: [excludePlaceholders, { isActive: false }] },
        }),
        prisma.user.count({
          where: {
            AND: [excludePlaceholders, { createdAt: { gte: startOfMonth } }],
          },
        }),
        prisma.user.groupBy({
          by: ["employmentType"],
          where: excludePlaceholders,
          _count: { _all: true },
        }),
      ]);

    return {
      total,
      active,
      inactive,
      newThisMonth,
      byEmploymentType: byEmploymentType.reduce<Record<string, number>>(
        (acc, row) => {
          acc[row.employmentType] = row._count._all;
          return acc;
        },
        {},
      ),
    };
  }

  async replaceRoles(userId: string, roleIds: string[], assignedBy?: string) {
    return prisma.$transaction(async (tx) => {
      await tx.userRole.deleteMany({ where: { userId } });

      if (roleIds.length > 0) {
        await tx.userRole.createMany({
          data: roleIds.map((roleId) => ({
            userId,
            roleId,
            assignedBy,
          })),
        });
      }

      return tx.userRole.findMany({
        where: { userId },
        include: { role: { select: { id: true, name: true } } },
      });
    });
  }

  async softDelete(id: string) {
    return prisma.user.update({
      where: { id },
      data: softDeleteUpdate(),
    });
  }

  async softDeleteMany(ids: string[]) {
    return prisma.user.updateMany({
      where: { id: { in: ids } },
      data: softDeleteUpdate(),
    });
  }

  async restore(id: string) {
    return prisma.user.update({
      where: { id },
      data: { deletedAt: null },
      include: {
        entity: { select: { id: true, name: true } },
        userRoles: {
          include: { role: { select: { id: true, name: true } } },
        },
        manager: { select: { id: true, name: true, email: true } },
      },
    });
  }

  async restoreMany(ids: string[]) {
    return prisma.user.updateMany({
      where: { id: { in: ids } },
      data: { deletedAt: null },
    });
  }

  async permanentDelete(id: string) {
    return prisma.user.delete({ where: { id } });
  }
}

export const usersRepository = new UsersRepository();
