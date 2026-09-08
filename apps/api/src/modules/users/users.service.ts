import { randomInt } from "node:crypto";

import {
  normalizePermissionCode,
  PERMISSIONS,
} from "@/common/constants/permissions";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from "@/common/exceptions/http-exception";
import { logger } from "@/common/utils/logger";
import { prisma } from "@/infrastructure/database/prisma";
import { sendWelcomeTemplateEmail } from "@/infrastructure/email/email.service";
import { supabaseAdmin } from "@/infrastructure/supabase/admin";
import { isSupabaseAuthUserMissingError } from "@/infrastructure/supabase/auth-errors";
import {
  actorFromId,
  trackProfileUpdatedServer,
  trackRoleAssigned,
  trackRoleRevoked,
  trackUserCreated,
  trackUserDeactivated,
} from "@/lib/events";
import { PORTAL_URL } from "@/lib/portal-url";
import { isPlatformAdmin } from "@/modules/auth/org-rbac";
import { usersRepository } from "@/modules/users/users.repository";
import type {
  AssignRolesInput,
  CreateUserInput,
  ListUsersQuery,
  ResetPasswordInput,
  UpdateUserInput,
} from "@/modules/users/users.validation";

// 12-char alphanumeric one-time password. Paired with
// mustChangePassword=true so the user is forced to rotate it on first
// login — entropy is intentionally modest because the lifetime is
// "until first successful login".
function generateTempPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 12; i += 1) {
    // crypto.randomInt is CSPRNG-backed and unbiased — Math.random() is not
    // acceptable for credentials (predictable + modulo-biased).
    out += alphabet[randomInt(alphabet.length)];
  }
  return out;
}

async function userHasPermission(
  userId: string,
  permissionCode: string,
): Promise<boolean> {
  const canonical = normalizePermissionCode(permissionCode);
  const row = await prisma.userRole.findFirst({
    where: {
      userId,
      role: {
        rolePermissions: {
          some: {
            permissionCode: canonical,
          },
        },
      },
    },
    select: { userId: true },
  });
  return Boolean(row);
}

async function userHasAdminManage(userId: string): Promise<boolean> {
  return userHasPermission(userId, PERMISSIONS.ADMIN_MANAGE);
}

/** Accounts with admin:manage may only be changed by another user who has admin:manage (except self-service rules enforced per method). */
async function assertActorMayManageAdminUser(
  actorId: string | undefined,
  targetUserId: string,
): Promise<void> {
  if (!actorId) return;
  if (!(await userHasAdminManage(targetUserId))) return;
  if (!(await userHasAdminManage(actorId))) {
    throw new ForbiddenException(
      "Only an administrator may modify this account",
    );
  }
}

export class UsersService {
  async getFormLookups() {
    const [entities, roles] = await Promise.all([
      prisma.entity.findMany({
        where: { isActive: true },
        select: {
          id: true,
          name: true,
          code: true,
          country: true,
          currency: true,
        },
        orderBy: { name: "asc" },
      }),
      prisma.role.findMany({
        select: {
          id: true,
          name: true,
          description: true,
          isSystem: true,
          createdAt: true,
          rolePermissions: { select: { permissionCode: true } },
          _count: { select: { userRoles: true } },
        },
        orderBy: { name: "asc" },
      }),
    ]);

    return {
      data: {
        entities,
        roles: roles.map((r) => ({
          id: r.id,
          name: r.name,
          description: r.description,
          isSystem: r.isSystem,
          permissionCount: r.rolePermissions.length,
          permissions: r.rolePermissions.map((rp) => rp.permissionCode),
          userCount: r._count.userRoles,
          createdAt: r.createdAt.toISOString(),
        })),
      },
    };
  }

  async list(query: ListUsersQuery, actorId?: string) {
    const scoped: ListUsersQuery = { ...query };

    if (actorId) {
      const actor = await prisma.user.findUnique({
        where: { id: actorId },
        select: { platformRole: true, activeOrganizationId: true },
      });
      if (!isPlatformAdmin(actor?.platformRole)) {
        const orgId = actor?.activeOrganizationId ?? null;
        if (!orgId) {
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
        const members = await prisma.organizationMembership.findMany({
          where: { organizationId: orgId, isActive: true },
          select: { userId: true },
        });
        scoped.userIds = members.map((m) => m.userId);
        delete scoped.organizationId;
      } else if (query.organizationId) {
        const members = await prisma.organizationMembership.findMany({
          where: { organizationId: query.organizationId, isActive: true },
          select: { userId: true },
        });
        scoped.userIds = members.map((m) => m.userId);
      }
    }

    const { users, total } = await usersRepository.findMany(scoped);

    return {
      data: users.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        avatarUrl: u.avatarUrl,
        phone: u.phone,
        department: u.department,
        jobTitle: u.jobTitle,
        employeeId: u.employeeId,
        employmentType: u.employmentType,
        startDate: u.startDate,
        location: u.location,
        country: u.country,
        isActive: u.isActive,
        entity: u.entity,
        manager: u.manager,
        roles: u.userRoles.map((ur) => ur.role),
        createdAt: u.createdAt,
      })),
      meta: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  async getById(id: string) {
    const user = await usersRepository.findById(id);
    if (!user) throw new NotFoundException("User not found");

    return {
      data: {
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
        roles: user.userRoles.map((ur) => ur.role),
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
    };
  }

  async create(input: CreateUserInput, createdBy?: string) {
    const existing = await usersRepository.findByEmail(input.email);
    if (existing) throw new ConflictException("Email already in use");

    let employeeId: string;
    if (input.employeeId) {
      const existingEmp = await usersRepository.findByEmployeeId(
        input.employeeId,
      );
      if (existingEmp) {
        throw new ConflictException("Employee ID already in use");
      }
      employeeId = input.employeeId;
    } else {
      employeeId = await usersRepository.allocateNextEmployeeId();
    }

    const { data: authUser, error } = await supabaseAdmin.auth.admin.createUser(
      {
        email: input.email,
        password: input.password,
        email_confirm: true,
      },
    );

    if (error) {
      throw new BadRequestException(
        `Failed to create auth user: ${error.message}`,
      );
    }

    try {
      const user = await usersRepository.create(
        {
          id: authUser.user.id,
          email: input.email,
          name: input.name,
          avatarUrl: input.avatarUrl,
          phone: input.phone,
          entity: input.entityId
            ? { connect: { id: input.entityId } }
            : undefined,
          department: input.department,
          jobTitle: input.jobTitle,
          employeeId,
          manager: input.reportingTo
            ? { connect: { id: input.reportingTo } }
            : undefined,
          employmentType: input.employmentType,
          startDate: input.startDate,
          dateOfBirth: input.dateOfBirth,
          salary: input.salary,
          currency: input.currency,
          location: input.location,
          country: input.country,
          timezone: input.timezone,
          passportNumber: input.passportNumber,
          thaiId: input.thaiId,
          taxId: input.taxId,
          aadhaarNumber: input.aadhaarNumber,
          panCardNumber: input.panCardNumber,
          workPermitType: input.workPermitType,
          visaType: input.visaType,
          permitNumber: input.permitNumber,
          mustChangePassword: true,
          // Payroll quick-create asks for `isActive=false` so dormant
          // employees mint without showing up in the directory; every
          // other caller defaults to active.
          isActive: input.isActive ?? true,
          roleIds: input.roleIds,
        },
        createdBy,
      );

      // Multi-company (PRD Rule 7). Going forward, a user created with a
      // home entity also gets a membership for it + that entity selected.
      // Best-effort (mirrors the tracking block): a failure here must
      // never break user creation — the backfill migration is the safety
      // net for existing users, and an admin can add memberships by hand.
      if (input.entityId && user) {
        try {
          await prisma.userEntityMembership.upsert({
            where: {
              userId_entityId: { userId: user.id, entityId: input.entityId },
            },
            create: {
              userId: user.id,
              entityId: input.entityId,
              isActive: true,
            },
            update: { isActive: true },
          });
          await prisma.user.update({
            where: { id: user.id },
            data: { activeEntityId: input.entityId },
          });
        } catch (err) {
          logger.warn("Failed to seed entity membership for new user", {
            userId: user.id,
            entityId: input.entityId,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Fire-and-forget welcome email with the temp password the admin
      // supplied. Mirrors auth.service.signUp; failures are logged inside
      // sendWelcomeTemplateEmail and never block the create. Payroll
      // quick-create opts out via `skipWelcomeEmail` — the email would
      // land on a placeholder inbox HR doesn't want to spam.
      if (!input.skipWelcomeEmail) {
        void sendWelcomeTemplateEmail({
          to: input.email,
          name: input.name,
          email: input.email,
          temporaryPassword: input.password,
          portalUrl: PORTAL_URL,
        });
      }

      // Tracking is fire-and-forget — never let analytics failures block a
      // user-creation flow. Tests mock a partial Prisma client that doesn't
      // implement entity/role finders.
      try {
        const entity = input.entityId
          ? await prisma.entity.findUnique({
              where: { id: input.entityId },
              select: { code: true },
            })
          : null;
        const actor = await actorFromId(createdBy);
        if (actor) {
          const roleNames =
            (input.roleIds?.length ?? 0) > 0
              ? (
                  await prisma.role.findMany({
                    where: { id: { in: input.roleIds ?? [] } },
                    select: { name: true },
                  })
                ).map((r) => r.name)
              : [];
          const onlyEmployee =
            roleNames.length > 0 &&
            roleNames.every((name) => name === "Employee");
          trackUserCreated(actor, {
            target_user_id: user.id,
            target_entity_code:
              (entity?.code as "TH" | "IN" | "VN" | "ID") ?? "TH",
            is_employee_only: onlyEmployee,
          });
        }
      } catch {
        // swallow — analytics is best-effort
      }

      return {
        data: {
          ...user,
          roles: user?.userRoles?.map((ur) => ur.role) ?? [],
          manager: null,
        },
      };
    } catch (err) {
      await supabaseAdmin.auth.admin.deleteUser(authUser.user.id);
      throw err;
    }
  }

  async update(id: string, input: UpdateUserInput, actorId?: string) {
    const user = await usersRepository.findById(id);
    if (!user) throw new NotFoundException("User not found");

    // Profile-only edits (phone, jobTitle, IDs, dates, visa, etc.)
    // stay open to anyone with `user:update` — HR has to be able to
    // maintain CXO records too. Only the two high-stakes paths still
    // require admin:manage on admin targets:
    //   - Deactivating an admin (would lock the privileged account)
    //   - Reassigning admin roles (handled in `assignRoles`)
    // resetPassword / remove keep their own checks below.
    if (input.isActive === false && user.isActive) {
      await assertActorMayManageAdminUser(actorId, id);
    }

    // Reject duplicate employeeId up-front so the form gets a clean
    // "already in use" error instead of a Prisma P2002 leak.
    if (
      input.employeeId !== undefined &&
      input.employeeId !== null &&
      input.employeeId !== user.employeeId
    ) {
      const existing = await usersRepository.findByEmployeeId(input.employeeId);
      if (existing && existing.id !== id) {
        throw new ConflictException("Employee ID already in use");
      }
    }

    const updated = await usersRepository.update(id, {
      name: input.name,
      phone: input.phone,
      avatarUrl: input.avatarUrl,
      entityId: input.entityId,
      department: input.department,
      jobTitle: input.jobTitle,
      employeeId: input.employeeId,
      reportingTo: input.reportingTo,
      employmentType: input.employmentType,
      startDate: input.startDate,
      endDate: input.endDate,
      dateOfBirth: input.dateOfBirth,
      salary: input.salary,
      currency: input.currency,
      location: input.location,
      country: input.country,
      timezone: input.timezone,
      passportNumber: input.passportNumber,
      thaiId: input.thaiId,
      taxId: input.taxId,
      aadhaarNumber: input.aadhaarNumber,
      panCardNumber: input.panCardNumber,
      workPermitType: input.workPermitType,
      visaType: input.visaType,
      permitNumber: input.permitNumber,
      isActive: input.isActive,
    });

    if (input.isActive === false && user.isActive) {
      try {
        const actor = await actorFromId(actorId);
        if (actor) {
          trackUserDeactivated(actor, { target_user_id: id });
        }
      } catch {
        // analytics is best-effort
      }
    }

    // profile.updated — self-edit only. Admin edits of other users are
    // captured by the existing UpdatedAt audit trail; this event is for
    // "did the user actually use the profile editor on themselves" signal.
    if (actorId && actorId === id) {
      try {
        const profileFields = [
          "name",
          "phone",
          "avatarUrl",
          "department",
          "jobTitle",
          "location",
          "timezone",
        ] as const;
        const changedFields = profileFields.filter(
          (field) => input[field] !== undefined,
        );
        if (changedFields.length > 0) {
          const actor = await actorFromId(actorId);
          if (actor) {
            trackProfileUpdatedServer(actor, {
              fields_changed: changedFields.join(","),
            });
          }
        }
      } catch {
        // analytics is best-effort
      }
    }

    return {
      data: {
        ...updated,
        roles: updated.userRoles.map((ur) => ur.role),
      },
    };
  }

  async remove(id: string, actingUserId: string) {
    const user = await usersRepository.findById(id);
    if (!user) throw new NotFoundException("User not found");

    if (id === actingUserId) {
      throw new BadRequestException("You cannot delete your own account");
    }

    await assertActorMayManageAdminUser(actingUserId, id);

    // Soft delete: mark user as deleted instead of removing from database
    await usersRepository.softDelete(id);
    return { data: { id } };
  }

  async restore(id: string, actingUserId: string) {
    const user = await prisma.user.findUnique({
      where: { id },
    });
    if (!user) throw new NotFoundException("User not found");
    if (!user.deletedAt) {
      throw new BadRequestException("User is not deleted");
    }

    await assertActorMayManageAdminUser(actingUserId, id);

    const restored = await usersRepository.restore(id);
    return { data: restored };
  }

  async permanentDelete(id: string, actingUserId: string) {
    const user = await prisma.user.findUnique({
      where: { id },
    });
    if (!user) throw new NotFoundException("User not found");

    if (id === actingUserId) {
      throw new BadRequestException("You cannot delete your own account");
    }

    await assertActorMayManageAdminUser(actingUserId, id);

    const { error } = await supabaseAdmin.auth.admin.deleteUser(id);
    if (error && !isSupabaseAuthUserMissingError(error)) {
      throw new BadRequestException(
        `Failed to delete auth user: ${error.message}`,
      );
    }

    // Hard delete: permanently remove from database
    await usersRepository.permanentDelete(id);
    return { data: { id } };
  }

  async resetPassword(id: string, input: ResetPasswordInput, actorId?: string) {
    const user = await usersRepository.findById(id);
    if (!user) throw new NotFoundException("User not found");

    await assertActorMayManageAdminUser(actorId, id);

    const { error } = await supabaseAdmin.auth.admin.updateUserById(id, {
      password: input.newPassword,
    });

    // Seeded or directly-inserted Prisma users can lack a Supabase auth
    // row. Reconcile by provisioning an auth user with the same UUID so
    // future logins work — without this, admins are stuck.
    if (error && isSupabaseAuthUserMissingError(error)) {
      const { error: createError } = await supabaseAdmin.auth.admin.createUser({
        id,
        email: user.email,
        password: input.newPassword,
        email_confirm: true,
      });
      if (createError) {
        throw new BadRequestException(
          `Failed to reset password: ${createError.message}`,
        );
      }
    } else if (error) {
      throw new BadRequestException(
        `Failed to reset password: ${error.message}`,
      );
    }

    await usersRepository.update(id, { mustChangePassword: true });
    return { data: { id } };
  }

  async stats() {
    const data = await usersRepository.stats();
    return { data };
  }

  // Pull every active Prisma user, cross-reference with Supabase auth's
  // `last_sign_in_at`, and surface anyone who's never signed in (or has
  // no Supabase auth row at all). Admin uses this to identify the
  // "never activated" cohort before triggering bulk invite emails.
  async listUnactivated() {
    const dbUsers = await prisma.user.findMany({
      where: { isActive: true },
      select: {
        id: true,
        email: true,
        name: true,
        employeeId: true,
        department: true,
        jobTitle: true,
        avatarUrl: true,
        createdAt: true,
      },
      orderBy: { name: "asc" },
    });

    // Supabase paginates 1000 per page max; loop until empty.
    const lastSignInById = new Map<string, string | null>();
    const PAGE_SIZE = 1000;
    let page = 1;
    while (true) {
      const { data, error } = await supabaseAdmin.auth.admin.listUsers({
        page,
        perPage: PAGE_SIZE,
      });
      if (error) {
        throw new BadRequestException(
          `Failed to list auth users: ${error.message}`,
        );
      }
      for (const u of data.users) {
        lastSignInById.set(u.id, u.last_sign_in_at ?? null);
      }
      if (data.users.length < PAGE_SIZE) break;
      page += 1;
    }

    const unactivated = dbUsers
      .filter((u) => {
        const lastSignIn = lastSignInById.get(u.id);
        // never had a Supabase auth row, or has one but never signed in
        return lastSignIn === undefined || lastSignIn === null;
      })
      .map((u) => ({
        ...u,
        createdAt: u.createdAt.toISOString(),
        hasAuthAccount: lastSignInById.has(u.id),
      }));

    return { data: unactivated, meta: { total: unactivated.length } };
  }

  // Bulk-resend a welcome / invite email to a list of users by minting
  // a fresh temp password, syncing it to Supabase auth (creating the
  // auth row if missing), flipping mustChangePassword, and emailing the
  // user. Used by the "Send activation emails" admin flow.
  async resendInvites(userIds: string[], actorId?: string) {
    if (userIds.length === 0) {
      return {
        data: { sent: 0, failed: [] as Array<{ id: string; reason: string }> },
      };
    }

    const users = await prisma.user.findMany({
      where: { id: { in: userIds }, isActive: true },
      select: { id: true, email: true, name: true },
    });

    const failed: Array<{ id: string; reason: string }> = [];
    let sent = 0;
    for (const user of users) {
      try {
        // 12-char alphanumeric — enough entropy for a one-time temp,
        // user is forced to rotate on first login via mustChangePassword.
        const tempPassword = generateTempPassword();

        const { error } = await supabaseAdmin.auth.admin.updateUserById(
          user.id,
          { password: tempPassword },
        );
        if (error && isSupabaseAuthUserMissingError(error)) {
          const { error: createError } =
            await supabaseAdmin.auth.admin.createUser({
              id: user.id,
              email: user.email,
              password: tempPassword,
              email_confirm: true,
            });
          if (createError) {
            throw new InternalServerErrorException(createError.message);
          }
        } else if (error) {
          throw new InternalServerErrorException(error.message);
        }

        await usersRepository.update(user.id, { mustChangePassword: true });

        await sendWelcomeTemplateEmail({
          to: user.email,
          name: user.name,
          email: user.email,
          temporaryPassword: tempPassword,
          portalUrl: PORTAL_URL,
        });
        sent += 1;
      } catch (err) {
        failed.push({
          id: user.id,
          reason: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }

    // best-effort audit trail of who triggered the bulk send
    if (actorId) {
      try {
        await actorFromId(actorId);
      } catch {
        // analytics is non-critical
      }
    }

    return { data: { sent, failed } };
  }

  async assignRoles(
    userId: string,
    input: AssignRolesInput,
    assignedBy?: string,
  ) {
    const user = await usersRepository.findById(userId);
    if (!user) throw new NotFoundException("User not found");

    await assertActorMayManageAdminUser(assignedBy, userId);

    const rolesWithAdminManage = await prisma.role.findMany({
      where: {
        id: { in: input.roleIds },
        rolePermissions: {
          some: { permissionCode: PERMISSIONS.ADMIN_MANAGE },
        },
      },
      select: { id: true },
    });
    if (rolesWithAdminManage.length > 0) {
      if (!assignedBy || !(await userHasAdminManage(assignedBy))) {
        throw new ForbiddenException(
          "Only a user with admin:manage may assign a role that grants admin:manage",
        );
      }
    }

    const previousRoleIds = new Set(
      (user.userRoles ?? []).map((ur) => ur.role.id),
    );
    const newRoleIds = new Set(input.roleIds);
    const addedRoleIds = input.roleIds.filter((r) => !previousRoleIds.has(r));
    const removedRoleIds = [...previousRoleIds].filter(
      (r) => !newRoleIds.has(r),
    );

    const roles = await usersRepository.replaceRoles(
      userId,
      input.roleIds,
      assignedBy,
    );

    if (addedRoleIds.length || removedRoleIds.length) {
      try {
        const actor = await actorFromId(assignedBy);
        if (actor) {
          const allTouchedRoles = await prisma.role.findMany({
            where: { id: { in: [...addedRoleIds, ...removedRoleIds] } },
            select: { id: true, name: true },
          });
          const nameById = new Map(allTouchedRoles.map((r) => [r.id, r.name]));
          for (const id of addedRoleIds) {
            trackRoleAssigned(actor, {
              target_user_id: userId,
              role_name: nameById.get(id) ?? id,
            });
          }
          for (const id of removedRoleIds) {
            trackRoleRevoked(actor, {
              target_user_id: userId,
              role_name: nameById.get(id) ?? id,
            });
          }
        }
      } catch {
        // analytics is best-effort
      }
    }

    return {
      data: {
        userId,
        roles: roles.map((ur) => ur.role),
      },
    };
  }

  // Bulk-import path used by the CSV / XLSX upload flow on the
  // Employees page. Each row is processed independently — a single
  // bad row does not abort the rest of the file; the controller
  // returns per-row results so the admin sees what landed.
  async bulkImport(
    rows: BulkImportRow[],
    createdBy?: string,
  ): Promise<BulkImportResult> {
    const results: BulkImportRowResult[] = [];
    let successCount = 0;
    let failureCount = 0;

    // Resolve entity codes (e.g. "TH") to ids once per import so each
    // row doesn't pay the lookup cost. Empty / missing codes are ok —
    // entityId stays undefined.
    const codes = Array.from(
      new Set(rows.map((r) => r.entityCode).filter(Boolean) as string[]),
    );
    const entityRows =
      codes.length > 0
        ? await prisma.entity.findMany({
            where: { code: { in: codes } },
            select: { id: true, code: true },
          })
        : [];
    const entityIdByCode = new Map(entityRows.map((e) => [e.code, e.id]));

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      const rowNumber = i + 2; // header is row 1
      try {
        const password = generateTemporaryPassword();
        const entityId = row.entityCode
          ? entityIdByCode.get(row.entityCode.toUpperCase())
          : undefined;
        if (row.entityCode && !entityId) {
          throw new BadRequestException(
            `Unknown entity code "${row.entityCode}". Run db:seed:prod to refresh the entity table or use one of TH, AE, SG, PT, ID, VN, IN, BD.`,
          );
        }
        await this.create(
          {
            email: row.email,
            name: row.name,
            password,
            phone: row.phone || undefined,
            entityId,
            department: row.department || undefined,
            jobTitle: row.jobTitle || undefined,
            employeeId: row.employeeId || undefined,
            employmentType: row.employmentType || "full_time",
            startDate: row.startDate ? new Date(row.startDate) : undefined,
            dateOfBirth: row.dateOfBirth
              ? new Date(row.dateOfBirth)
              : undefined,
            location: row.location || undefined,
            country: row.country || undefined,
          },
          createdBy,
        );
        results.push({
          rowNumber,
          email: row.email,
          status: "created",
        });
        successCount += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown failure";
        results.push({
          rowNumber,
          email: row.email,
          status: "failed",
          error: message,
        });
        failureCount += 1;
      }
    }

    return { successCount, failureCount, results };
  }

  // ── Multi-company memberships (PRD Rule 7, admin surface) ────────────
  // Manage which entities a user belongs to. Stored now, ENFORCED in a
  // later chunk — these writes never touch role/permission resolution.

  /** List a user's entity memberships (admin view). */
  async listMemberships(userId: string) {
    const user = await usersRepository.findById(userId);
    if (!user) throw new NotFoundException("User not found");

    const rows = await prisma.userEntityMembership.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      include: {
        entity: { select: { id: true, name: true, code: true } },
        role: { select: { id: true, name: true } },
      },
    });

    return {
      data: rows.map((m) => ({
        id: m.id,
        entityId: m.entityId,
        entity: m.entity,
        roleId: m.roleId,
        role: m.role,
        isActive: m.isActive,
      })),
    };
  }

  /**
   * Add (or re-activate) a membership for a user in an entity, with an
   * optional per-company role. Idempotent via the (userId, entityId)
   * unique key. Does not change the user's active company.
   */
  async addMembership(
    userId: string,
    entityId: string,
    roleId?: string | null,
  ) {
    const user = await usersRepository.findById(userId);
    if (!user) throw new NotFoundException("User not found");

    const entity = await prisma.entity.findUnique({ where: { id: entityId } });
    if (!entity) throw new NotFoundException("Entity not found");

    if (roleId) {
      const role = await prisma.role.findUnique({ where: { id: roleId } });
      if (!role) throw new BadRequestException("Role not found");
    }

    const membership = await prisma.userEntityMembership.upsert({
      where: { userId_entityId: { userId, entityId } },
      create: { userId, entityId, roleId: roleId ?? null, isActive: true },
      update: { roleId: roleId ?? null, isActive: true },
      include: {
        entity: { select: { id: true, name: true, code: true } },
        role: { select: { id: true, name: true } },
      },
    });

    return { data: membership };
  }

  /**
   * Remove a user's membership in an entity. If it was their active
   * company, clear `activeEntityId` so a stale selection can't linger.
   */
  async removeMembership(userId: string, entityId: string) {
    const membership = await prisma.userEntityMembership.findUnique({
      where: { userId_entityId: { userId, entityId } },
    });
    if (!membership) throw new NotFoundException("Membership not found");

    await prisma.$transaction(async (tx) => {
      await tx.userEntityMembership.delete({
        where: { userId_entityId: { userId, entityId } },
      });
      await tx.user.updateMany({
        where: { id: userId, activeEntityId: entityId },
        data: { activeEntityId: null },
      });
    });

    return { data: { success: true } };
  }
}

export interface BulkImportRow {
  email: string;
  name: string;
  phone?: string;
  entityCode?: string;
  department?: string;
  jobTitle?: string;
  employeeId?: string;
  employmentType?: string;
  startDate?: string;
  dateOfBirth?: string;
  location?: string;
  country?: string;
}

export interface BulkImportRowResult {
  rowNumber: number;
  email: string;
  status: "created" | "failed";
  error?: string;
}

export interface BulkImportResult {
  successCount: number;
  failureCount: number;
  results: BulkImportRowResult[];
}

// 16-char alpha-numeric temp password. Mixed case + digits keeps the
// Supabase auth strength check happy without needing punctuation that
// confuses email copy-paste.
function generateTemporaryPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 16; i += 1) {
    // CSPRNG-backed, unbiased index selection (was Math.random()).
    out += chars[randomInt(chars.length)];
  }
  return out;
}

export const usersService = new UsersService();
