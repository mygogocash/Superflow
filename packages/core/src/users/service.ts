import { PERMISSIONS } from "@nexora/contracts";
import type {
  AssignRolesInput,
  ListUsersQuery,
  UpdateUserInput,
} from "@nexora/contracts/modules/users/users.validation";
import type { Db } from "@nexora/db";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "../http-exception";
import {
  listActiveMemberUserIds,
  resolveActorOrgScope,
  type OrgTenancyOptions,
} from "../organizations/organizations.service";
import * as repo from "./repository";

function optionalDate(v: Date | null | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return v.toISOString();
}

async function assertActorMayManageAdminUser(db: Db, actorId: string | undefined, targetUserId: string) {
  if (!actorId) return;
  const targetIsAdmin = await repo.userHasPermission(db, targetUserId, PERMISSIONS.ADMIN_MANAGE);
  if (!targetIsAdmin) return;
  const actorIsAdmin = await repo.userHasPermission(db, actorId, PERMISSIONS.ADMIN_MANAGE);
  if (!actorIsAdmin) {
    throw new ForbiddenException("Only an administrator may modify this account");
  }
}

function detailDTO(user: NonNullable<Awaited<ReturnType<typeof repo.findById>>>) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    phone: user.phone,
    department: user.department,
    jobTitle: user.jobTitle,
    employeeId: user.employeeId,
    reportingTo: user.reportingTo,
    employmentType: user.employmentType,
    startDate: user.startDate,
    endDate: user.endDate,
    dateOfBirth: user.dateOfBirth,
    salary: user.salary,
    currency: user.currency,
    location: user.location,
    country: user.country,
    timezone: user.timezone,
    passportNumber: user.passportNumber,
    thaiId: user.thaiId,
    taxId: user.taxId,
    aadhaarNumber: user.aadhaarNumber,
    panCardNumber: user.panCardNumber,
    workPermitType: user.workPermitType,
    visaType: user.visaType,
    permitNumber: user.permitNumber,
    isActive: user.isActive,
    entity: user.entity,
    manager: user.manager,
    roles: user.roles,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

/**
 * List users. When `actorId` is provided, non–platform-admins are scoped to
 * active members of their active organization (template for org tenancy).
 * Platform admins may optionally filter with `organizationId`.
 */
export async function list(
  db: Db,
  query: ListUsersQuery,
  actorId?: string,
  options: OrgTenancyOptions = {},
) {
  const scoped: ListUsersQuery = { ...query };

  if (actorId) {
    const scope = await resolveActorOrgScope(db, actorId);
    if (!scope.isPlatformAdmin) {
      const orgId = scope.activeOrganizationId;
      if (!orgId) {
        if (options.tenancyEnforced) {
          throw new ForbiddenException("Active organization required");
        }
        return {
          data: [],
          meta: {
            page: query.page,
            limit: query.limit,
            total: 0,
            totalPages: 0,
          },
        };
      }
      scoped.userIds = await listActiveMemberUserIds(db, orgId);
      delete scoped.organizationId;
    } else if (query.organizationId) {
      scoped.userIds = await listActiveMemberUserIds(db, query.organizationId);
    }
  }

  const { users, total } = await repo.findMany(db, scoped);
  return {
    data: users,
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit) || 1,
    },
  };
}

async function assertActorCanAccessUser(
  db: Db,
  actorId: string,
  targetUserId: string,
  options: OrgTenancyOptions = {},
) {
  const scope = await resolveActorOrgScope(db, actorId);
  if (scope.isPlatformAdmin) return;
  const orgId = scope.activeOrganizationId;
  if (!orgId) {
    throw new ForbiddenException(
      options.tenancyEnforced
        ? "Active organization required"
        : "Cannot access user outside your organization",
    );
  }
  const memberIds = await listActiveMemberUserIds(db, orgId);
  if (!memberIds.includes(targetUserId)) {
    throw new ForbiddenException("Cannot access user outside your organization");
  }
}

export async function getById(
  db: Db,
  id: string,
  actorId?: string,
  options: OrgTenancyOptions = {},
) {
  const user = await repo.findById(db, id);
  if (!user) throw new NotFoundException("User not found");
  if (actorId) {
    await assertActorCanAccessUser(db, actorId, id, options);
  }
  return { data: detailDTO(user) };
}

export async function update(db: Db, id: string, input: UpdateUserInput, actorId?: string) {
  const user = await repo.findById(db, id);
  if (!user) throw new NotFoundException("User not found");

  if (actorId) {
    await assertActorCanAccessUser(db, actorId, id);
  }

  if (input.isActive === false && user.isActive) {
    await assertActorMayManageAdminUser(db, actorId, id);
  }

  if (
    input.employeeId !== undefined &&
    input.employeeId !== null &&
    input.employeeId !== user.employeeId
  ) {
    const existing = await repo.findByEmployeeId(db, input.employeeId);
    if (existing && existing.id !== id) {
      throw new ConflictException("Employee ID already in use");
    }
  }

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.phone !== undefined) patch.phone = input.phone;
  if (input.avatarUrl !== undefined) patch.avatarUrl = input.avatarUrl;
  if (input.entityId !== undefined) patch.entityId = input.entityId;
  if (input.department !== undefined) patch.department = input.department;
  if (input.jobTitle !== undefined) patch.jobTitle = input.jobTitle;
  if (input.employeeId !== undefined) patch.employeeId = input.employeeId;
  if (input.reportingTo !== undefined) patch.reportingTo = input.reportingTo;
  if (input.employmentType !== undefined) patch.employmentType = input.employmentType;
  if (input.startDate !== undefined) patch.startDate = optionalDate(input.startDate);
  if (input.endDate !== undefined) patch.endDate = optionalDate(input.endDate);
  if (input.dateOfBirth !== undefined) patch.dateOfBirth = input.dateOfBirth;
  if (input.salary !== undefined) patch.salary = input.salary == null ? null : String(input.salary);
  if (input.currency !== undefined) patch.currency = input.currency;
  if (input.location !== undefined) patch.location = input.location;
  if (input.country !== undefined) patch.country = input.country;
  if (input.timezone !== undefined) patch.timezone = input.timezone;
  if (input.passportNumber !== undefined) patch.passportNumber = input.passportNumber;
  if (input.thaiId !== undefined) patch.thaiId = input.thaiId;
  if (input.taxId !== undefined) patch.taxId = input.taxId;
  if (input.aadhaarNumber !== undefined) patch.aadhaarNumber = input.aadhaarNumber;
  if (input.panCardNumber !== undefined) patch.panCardNumber = input.panCardNumber;
  if (input.workPermitType !== undefined) patch.workPermitType = input.workPermitType;
  if (input.visaType !== undefined) patch.visaType = input.visaType;
  if (input.permitNumber !== undefined) patch.permitNumber = input.permitNumber;
  if (input.isActive !== undefined) patch.isActive = input.isActive;

  const updated = await repo.update(db, id, patch);
  if (!updated) throw new NotFoundException("User not found");
  return { data: detailDTO(updated) };
}

export async function remove(db: Db, id: string, actingUserId: string) {
  const user = await repo.findById(db, id);
  if (!user) throw new NotFoundException("User not found");
  if (id === actingUserId) {
    throw new BadRequestException("You cannot delete your own account");
  }
  await assertActorMayManageAdminUser(db, actingUserId, id);
  await repo.softDelete(db, id);
  return { data: { id } };
}

export async function restore(db: Db, id: string, actingUserId: string) {
  const user = await repo.findById(db, id);
  if (!user) throw new NotFoundException("User not found");
  if (!user.deletedAt) {
    throw new BadRequestException("User is not deleted");
  }
  await assertActorMayManageAdminUser(db, actingUserId, id);
  const restored = await repo.restore(db, id);
  if (!restored) throw new NotFoundException("User not found");
  return { data: detailDTO(restored) };
}

export async function stats(db: Db) {
  return { data: await repo.stats(db) };
}

export async function getFormLookups(db: Db) {
  const { entities, roles } = await repo.formLookups(db);
  return { data: { entities, roles } };
}

export async function assignRoles(db: Db, userId: string, input: AssignRolesInput, assignedBy?: string) {
  const user = await repo.findById(db, userId);
  if (!user) throw new NotFoundException("User not found");

  await assertActorMayManageAdminUser(db, assignedBy, userId);

  if (input.roleIds.length > 0) {
    const adminRoles = await repo.rolesWithAdminManage(db, input.roleIds);
    if (adminRoles.length > 0) {
      if (!assignedBy || !(await repo.userHasPermission(db, assignedBy, PERMISSIONS.ADMIN_MANAGE))) {
        throw new ForbiddenException(
          "Only a user with admin:manage may assign a role that grants admin:manage",
        );
      }
    }
  }

  const roles = await repo.replaceRoles(db, userId, input.roleIds, assignedBy);
  return { data: { roles } };
}
