import {
  ALL_PERMISSION_CODES,
  isValidPermissionCode,
  normalizePermissionCode,
} from "@/common/constants/permissions";
import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from "@/common/exceptions/http-exception";
import { logger } from "@/common/utils/logger";
import { prisma } from "@/infrastructure/database/prisma";
import { sendWelcomeTemplateEmail } from "@/infrastructure/email/email.service";
import { supabaseAdmin } from "@/infrastructure/supabase/admin";
import { PORTAL_URL } from "@/lib/portal-url";
import type {
  AuthEmailRequestInput,
  CreateUserInput,
  ExchangeSessionInput,
  LoginInput,
  RecoverPasswordInput,
} from "@/modules/auth/auth.validation";
import {
  isSupabaseNotConfiguredError,
  loginWithLocalCredentials,
} from "@/modules/auth/local-dev-auth";
import {
  applyManagerImplicitPerms,
  countActiveDirectReports,
} from "@/modules/auth/manager-implicit-perms";
import {
  isOrgRole,
  mergeOrgAwarePermissions,
  type OrgRole,
} from "@/modules/auth/org-rbac";

const RECOVERY_REQUEST_ACTIONS = ["forgot-password", "magic-link"] as const;
const RECOVERY_EMAIL_LIMIT_PER_HOUR = 3;
const RECOVERY_IP_LIMIT_PER_HOUR = 10;
const UNKNOWN_AUTH_EMAIL = "unknown";

// Roles permitted to use the email-link sign-in (`/magic-link`). Anyone
// else hitting the endpoint gets the same no-enumeration 200 response,
// with `feature-not-enabled` logged to auth_logs. The system "Admin"
// role always bypasses (matches role gating elsewhere — see
// auth.service.resolvePermissions). Forgot-password stays open for
// everyone — it's the emergency lock-out recovery path and must not
// depend on already-assigned roles.
//
// Default is empty (= disabled for everyone except Admin) so the
// feature is hidden until ops opts in. To enable for the IT team
// later: `--set-env-vars MAGIC_LINK_ALLOWED_ROLES=IT` on Cloud Run.
const MAGIC_LINK_ALLOWED_ROLES = (process.env.MAGIC_LINK_ALLOWED_ROLES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

type RecoveryRequestAction = (typeof RECOVERY_REQUEST_ACTIONS)[number];
type AuthLogAction =
  | RecoveryRequestAction
  | "recover-password"
  | "exchange-session";

interface AuthRequestContext {
  ip?: string | null;
}

interface AuthSessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  expiresAt?: number | null;
}

interface AuthLogInput {
  email: string;
  ip?: string | null;
  action: AuthLogAction;
  success: boolean;
  errorMessage?: string | null;
  userId?: string | null;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function authRedirectUrl(path: string): string {
  return new URL(path, PORTAL_URL).toString();
}

// System "Admin" role implicitly grants every registered permission. Without
// this, newly-added permission codes (e.g. crm:* in Sales CRM v2) silently
// lock super-admins out of new modules until someone re-runs db:seed-prod.
// Mirrors the same logic in auth.guard.loadUserPermissions so login and the
// /me endpoint see the same effective set as runtime guards.
function resolvePermissions(
  userRoles: {
    role: {
      isSystem: boolean;
      name: string;
      rolePermissions: { permissionCode: string }[];
    };
  }[],
): Set<string> {
  const permissions = new Set<string>();
  const isSuperAdmin = userRoles.some(
    (ur) => ur.role.isSystem && ur.role.name === "Admin",
  );
  if (isSuperAdmin) {
    for (const code of ALL_PERMISSION_CODES) {
      permissions.add(normalizePermissionCode(code));
    }
    return permissions;
  }
  for (const ur of userRoles) {
    for (const rp of ur.role.rolePermissions) {
      permissions.add(normalizePermissionCode(rp.permissionCode));
    }
  }
  return permissions;
}

// ── Multi-company foundation (PRD Rule 7) ──────────────────────────────
// Shape returned to the client for the company switcher. `roleId` is the
// stored per-company role; it is NOT applied to permission resolution here
// (enforcement is a later chunk).
interface EntityMembershipDto {
  entityId: string;
  entityName: string;
  entityCode: string;
  roleId: string | null;
  isActive: boolean;
}

type MembershipWithEntity = {
  entityId: string;
  roleId: string | null;
  isActive: boolean;
  entity: { id: string; name: string; code: string } | null;
};

function mapMemberships(rows: MembershipWithEntity[]): EntityMembershipDto[] {
  return rows.map((m) => ({
    entityId: m.entityId,
    entityName: m.entity?.name ?? "",
    entityCode: m.entity?.code ?? "",
    roleId: m.roleId ?? null,
    isActive: m.isActive,
  }));
}

export class AuthService {
  async login(input: LoginInput) {
    logger.debug("AuthService.login called", { email: input.email });
    try {
      const { data, error } = await supabaseAdmin.auth.signInWithPassword({
        email: input.email,
        password: input.password,
      });

      if (error) {
        logger.warn("Supabase auth error", {
          message: error.message,
          status: error.status,
        });
        throw new UnauthorizedException("Invalid credentials");
      }

      if (!data.session) {
        throw new UnauthorizedException("Invalid credentials");
      }

      return this.buildAuthenticatedResponse(data.user.id, {
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        expiresIn: data.session.expires_in,
        expiresAt: data.session.expires_at,
      });
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      if (isSupabaseNotConfiguredError(err)) {
        // zod's inferred LoginInput widens these to optional under the current
        // zod/TS combo, but the controller schema guarantees both are present.
        if (!input.email || !input.password) {
          throw new UnauthorizedException("Invalid credentials");
        }
        const local = await loginWithLocalCredentials({
          email: input.email,
          password: input.password,
        });
        return this.buildAuthenticatedResponse(local.userId, local.session);
      }
      throw err;
    }
  }

  async requestPasswordReset(
    input: AuthEmailRequestInput,
    context: AuthRequestContext = {},
  ) {
    await this.requestEmailAuthLink("forgot-password", input.email, context);
  }

  async requestMagicLink(
    input: AuthEmailRequestInput,
    context: AuthRequestContext = {},
  ) {
    await this.requestEmailAuthLink("magic-link", input.email, context);
  }

  async recoverPassword(
    input: RecoverPasswordInput,
    context: AuthRequestContext = {},
  ) {
    const exchanged = await this.exchangeSupabaseSession(input, context, {
      action: "recover-password",
    });

    try {
      const { error } = await supabaseAdmin.auth.admin.updateUserById(
        exchanged.userId,
        {
          password: input.newPassword,
        },
      );

      if (error) {
        await this.logAuthAttempt({
          email: exchanged.email,
          ip: context.ip,
          action: "recover-password",
          success: false,
          errorMessage: "supabase-error",
          userId: exchanged.userId,
        });
        throw new BadRequestException(
          `Failed to reset password: ${error.message}`,
        );
      }

      await prisma.user.update({
        where: { id: exchanged.userId },
        data: { mustChangePassword: false },
      });

      await this.logAuthAttempt({
        email: exchanged.email,
        ip: context.ip,
        action: "recover-password",
        success: true,
        userId: exchanged.userId,
      });

      return this.buildAuthenticatedResponse(
        exchanged.userId,
        exchanged.session,
      );
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      await this.logAuthAttempt({
        email: exchanged.email,
        ip: context.ip,
        action: "recover-password",
        success: false,
        errorMessage: err instanceof Error ? err.message : "unknown-error",
        userId: exchanged.userId,
      });
      throw err;
    }
  }

  async exchangeSession(
    input: ExchangeSessionInput,
    context: AuthRequestContext = {},
  ) {
    const exchanged = await this.exchangeSupabaseSession(input, context, {
      action: "exchange-session",
    });

    await this.logAuthAttempt({
      email: exchanged.email,
      ip: context.ip,
      action: "exchange-session",
      success: true,
      userId: exchanged.userId,
    });

    return this.buildAuthenticatedResponse(exchanged.userId, exchanged.session);
  }

  private async buildAuthenticatedResponse(
    userId: string,
    session: AuthSessionTokens,
  ) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        entity: true,
        // Multi-company (PRD Rule 7) — carried on login so the switcher
        // is populated before the first /me refresh. Additive; `?? []`
        // keeps older test fixtures working.
        entityMemberships: {
          where: { isActive: true },
          orderBy: { createdAt: "asc" },
          include: {
            entity: { select: { id: true, name: true, code: true } },
          },
        },
        userRoles: {
          include: {
            role: {
              include: { rolePermissions: true },
            },
          },
        },
      },
    });

    if (!user) {
      throw new UnauthorizedException("User not found in system");
    }

    if (!user.isActive) {
      throw new ForbiddenException("Account deactivated");
    }

    const permissions = resolvePermissions(user.userRoles);
    // Implicit manager grants — anyone listed as `reportingTo` for at
    // least one active employee receives the approval-flow perms even
    // if Admin hasn't assigned them the Manager role.
    const directReportCount = await countActiveDirectReports(user.id);
    applyManagerImplicitPerms(permissions, directReportCount > 0);

    const roles = user.userRoles.map((ur) => ({
      id: ur.role.id,
      name: ur.role.name,
      defaultRoute: ur.role.defaultRoute,
      // Lets the client tell the SYSTEM Admin role from a custom role that
      // happens to be called Admin. Without it a UI cannot honestly hide a
      // system-admin-only control, and would show a button that 403s.
      isSystem: ur.role.isSystem,
    }));

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        department: user.department,
        jobTitle: user.jobTitle,
        entity: user.entity,
        mustChangePassword: user.mustChangePassword,
        locale: user.locale ?? null,
      },
      roles,
      permissions: Array.from(permissions).filter(isValidPermissionCode),
      // ── Additive multi-company fields (PRD Rule 7) ────────────────
      memberships: mapMemberships(user.entityMemberships ?? []),
      activeEntityId: user.activeEntityId ?? null,
      session,
    };
  }

  private async requestEmailAuthLink(
    action: RecoveryRequestAction,
    rawEmail: string,
    context: AuthRequestContext,
  ): Promise<void> {
    const email = normalizeEmail(rawEmail);
    const user = await prisma.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { id: true, email: true, isActive: true },
    });

    const limit = await this.checkRecoveryRequestLimit(email, context.ip);
    if (limit.limited) {
      await this.logAuthAttempt({
        email,
        ip: context.ip,
        action,
        success: false,
        errorMessage: limit.reason,
        userId: user?.id,
      });
      return;
    }

    if (!user) {
      await this.logAuthAttempt({
        email,
        ip: context.ip,
        action,
        success: false,
        errorMessage: "user-not-found",
      });
      return;
    }

    if (!user.isActive) {
      await this.logAuthAttempt({
        email,
        ip: context.ip,
        action,
        success: false,
        errorMessage: "inactive-user",
        userId: user.id,
      });
      return;
    }

    // Magic-link rollout is currently restricted to the IT role (see
    // MAGIC_LINK_ALLOWED_ROLES at top of file). Other staff use the
    // password sign-in path. Admin always bypasses. Forgot-password is
    // not gated — every active user must be able to recover access.
    if (action === "magic-link") {
      const userRoles = await prisma.userRole.findMany({
        where: { userId: user.id },
        select: { role: { select: { name: true, isSystem: true } } },
      });
      const isAdmin = userRoles.some(
        (ur) => ur.role.isSystem && ur.role.name === "Admin",
      );
      const hasAllowedRole = userRoles.some((ur) =>
        MAGIC_LINK_ALLOWED_ROLES.includes(ur.role.name),
      );
      if (!isAdmin && !hasAllowedRole) {
        await this.logAuthAttempt({
          email,
          ip: context.ip,
          action,
          success: false,
          errorMessage: "feature-not-enabled",
          userId: user.id,
        });
        return;
      }
    }

    if (action === "forgot-password") {
      const { error } = await supabaseAdmin.auth.resetPasswordForEmail(email, {
        redirectTo: authRedirectUrl("/reset-password"),
      });

      if (error) {
        logger.warn("Password reset email request failed", {
          email,
          status: error.status,
          message: error.message,
        });
        await this.logAuthAttempt({
          email,
          ip: context.ip,
          action,
          success: false,
          errorMessage: "supabase-error",
          userId: user.id,
        });
        return;
      }
    } else {
      const { error } = await supabaseAdmin.auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: false,
          emailRedirectTo: authRedirectUrl("/auth/callback"),
        },
      });

      if (error) {
        logger.warn("Magic link request failed", {
          email,
          status: error.status,
          message: error.message,
        });
        await this.logAuthAttempt({
          email,
          ip: context.ip,
          action,
          success: false,
          errorMessage: "supabase-error",
          userId: user.id,
        });
        return;
      }
    }

    await this.logAuthAttempt({
      email,
      ip: context.ip,
      action,
      success: true,
      userId: user.id,
    });
  }

  private async checkRecoveryRequestLimit(
    email: string,
    ip?: string | null,
  ): Promise<{ limited: boolean; reason?: string }> {
    const since = new Date(Date.now() - 60 * 60 * 1000);

    const [emailCount, ipCount] = await Promise.all([
      prisma.authLog.count({
        where: {
          email,
          action: { in: [...RECOVERY_REQUEST_ACTIONS] },
          createdAt: { gte: since },
        },
      }),
      ip
        ? prisma.authLog.count({
            where: {
              ip,
              action: { in: [...RECOVERY_REQUEST_ACTIONS] },
              createdAt: { gte: since },
            },
          })
        : Promise.resolve(0),
    ]);

    if (emailCount >= RECOVERY_EMAIL_LIMIT_PER_HOUR) {
      return { limited: true, reason: "email-rate-limited" };
    }
    if (ipCount >= RECOVERY_IP_LIMIT_PER_HOUR) {
      return { limited: true, reason: "ip-rate-limited" };
    }
    return { limited: false };
  }

  private async exchangeSupabaseSession(
    input: ExchangeSessionInput,
    context: AuthRequestContext,
    options: { action: "recover-password" | "exchange-session" },
  ): Promise<{ userId: string; email: string; session: AuthSessionTokens }> {
    const { data: accessData, error: accessError } =
      await supabaseAdmin.auth.getUser(input.accessToken);

    if (accessError || !accessData.user) {
      await this.logAuthAttempt({
        email: UNKNOWN_AUTH_EMAIL,
        ip: context.ip,
        action: options.action,
        success: false,
        errorMessage: "invalid-access-token",
      });
      throw new UnauthorizedException("Invalid or expired sign-in link");
    }

    const accessUserId = accessData.user.id;
    const accessEmail = normalizeEmail(
      accessData.user.email ?? UNKNOWN_AUTH_EMAIL,
    );
    const { data: refreshData, error: refreshError } =
      await supabaseAdmin.auth.refreshSession({
        refresh_token: input.refreshToken,
      });

    if (refreshError || !refreshData.session) {
      await this.logAuthAttempt({
        email: accessEmail,
        ip: context.ip,
        action: options.action,
        success: false,
        errorMessage: "invalid-refresh-token",
        userId: accessUserId,
      });
      throw new UnauthorizedException("Invalid or expired sign-in link");
    }

    const { data: refreshedUserData, error: refreshedUserError } =
      await supabaseAdmin.auth.getUser(refreshData.session.access_token);

    if (
      refreshedUserError ||
      !refreshedUserData.user ||
      refreshedUserData.user.id !== accessUserId
    ) {
      await this.logAuthAttempt({
        email: accessEmail,
        ip: context.ip,
        action: options.action,
        success: false,
        errorMessage: "session-user-mismatch",
        userId: accessUserId,
      });
      throw new UnauthorizedException("Invalid or expired sign-in link");
    }

    const user = await prisma.user.findUnique({
      where: { id: accessUserId },
      select: { id: true, email: true, isActive: true },
    });

    if (!user) {
      await this.logAuthAttempt({
        email: accessEmail,
        ip: context.ip,
        action: options.action,
        success: false,
        errorMessage: "user-not-found",
        userId: accessUserId,
      });
      throw new UnauthorizedException("User not found in system");
    }

    if (!user.isActive) {
      await this.logAuthAttempt({
        email: normalizeEmail(user.email),
        ip: context.ip,
        action: options.action,
        success: false,
        errorMessage: "inactive-user",
        userId: user.id,
      });
      throw new ForbiddenException("Account deactivated");
    }

    const userEmail = normalizeEmail(user.email);
    if (accessEmail !== UNKNOWN_AUTH_EMAIL && accessEmail !== userEmail) {
      await this.logAuthAttempt({
        email: userEmail,
        ip: context.ip,
        action: options.action,
        success: false,
        errorMessage: "email-mismatch",
        userId: user.id,
      });
      throw new UnauthorizedException("Invalid or expired sign-in link");
    }

    return {
      userId: user.id,
      email: userEmail,
      session: {
        accessToken: refreshData.session.access_token,
        refreshToken: refreshData.session.refresh_token,
        expiresIn: refreshData.session.expires_in,
        expiresAt: refreshData.session.expires_at,
      },
    };
  }

  private async logAuthAttempt(input: AuthLogInput): Promise<void> {
    try {
      await prisma.authLog.create({
        data: {
          email: input.email,
          ip: input.ip ?? null,
          action: input.action,
          success: input.success,
          errorMessage: input.errorMessage ?? null,
          userId: input.userId ?? null,
        },
      });
    } catch (err) {
      logger.warn("Failed to write auth audit log", {
        action: input.action,
        email: input.email,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async getMe(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        entity: true,
        // Multi-company (PRD Rule 7). Embedded ADDITIVELY — the switcher
        // reads these. `?? []` below keeps callers that don't hydrate the
        // relation (and older test fixtures) working unchanged.
        entityMemberships: {
          where: { isActive: true },
          orderBy: { createdAt: "asc" },
          include: {
            entity: { select: { id: true, name: true, code: true } },
          },
        },
        organizationMemberships: {
          where: { isActive: true },
          orderBy: { createdAt: "asc" },
          include: {
            organization: {
              select: { id: true, name: true, slug: true, status: true, deletedAt: true },
            },
          },
        },
        userRoles: {
          include: {
            role: {
              include: { rolePermissions: true },
            },
          },
        },
      },
    });

    if (!user) throw new UnauthorizedException("User not found");

    const legacyPermissions = resolvePermissions(user.userRoles);
    const directReportCount = await countActiveDirectReports(user.id);
    applyManagerImplicitPerms(legacyPermissions, directReportCount > 0);

    const roles = user.userRoles.map((ur) => ({
      id: ur.role.id,
      name: ur.role.name,
      defaultRoute: ur.role.defaultRoute,
      // Lets the client tell the SYSTEM Admin role from a custom role that
      // happens to be called Admin. Without it a UI cannot honestly hide a
      // system-admin-only control, and would show a button that 403s.
      isSystem: ur.role.isSystem,
    }));

    const organizationMemberships = (user.organizationMemberships ?? [])
      .filter((m) => !m.organization.deletedAt && isOrgRole(m.orgRole))
      .map((m) => ({
        organizationId: m.organizationId,
        orgRole: m.orgRole as OrgRole,
        isActive: m.isActive,
        organization: {
          id: m.organization.id,
          name: m.organization.name,
          slug: m.organization.slug,
          status: m.organization.status,
        },
      }));

    const activeOrganizationId =
      user.activeOrganizationId &&
      organizationMemberships.some((m) => m.organizationId === user.activeOrganizationId)
        ? user.activeOrganizationId
        : (organizationMemberships[0]?.organizationId ?? null);

    const orgRole =
      organizationMemberships.find((m) => m.organizationId === activeOrganizationId)?.orgRole ??
      null;

    const permissions = mergeOrgAwarePermissions({
      legacyPermissionCodes: [...legacyPermissions],
      orgRole,
      platformRole: user.platformRole,
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        department: user.department,
        jobTitle: user.jobTitle,
        entity: user.entity,
        mustChangePassword: user.mustChangePassword,
        platformRole: user.platformRole ?? null,
        locale: user.locale ?? null,
      },
      roles,
      permissions: permissions.filter(isValidPermissionCode),
      // ── Additive multi-company fields (PRD Rule 7) ──────────────────
      memberships: mapMemberships(user.entityMemberships ?? []),
      activeEntityId: user.activeEntityId ?? null,
      // ── Additive multi-org fields ─────────────────────────────────────
      organizationMemberships,
      activeOrganizationId,
      orgRole,
    };
  }

  /**
   * The entities the user belongs to (active memberships only), with the
   * entity name/code and the stored per-company `roleId`. Feeds the web
   * company switcher. Does NOT influence permission resolution.
   */
  async listMemberships(userId: string): Promise<EntityMembershipDto[]> {
    const rows = await prisma.userEntityMembership.findMany({
      where: { userId, isActive: true },
      orderBy: { createdAt: "asc" },
      include: { entity: { select: { id: true, name: true, code: true } } },
    });
    return mapMemberships(rows);
  }

  /**
   * Switch the caller's selected company. Fails CLOSED: the user must hold
   * an ACTIVE membership in the target entity, else ForbiddenException. Only
   * writes `User.activeEntityId` — it does not grant or change any
   * permission (per-entity enforcement is a later chunk).
   */
  async setActiveEntity(userId: string, entityId: string) {
    const membership = await prisma.userEntityMembership.findUnique({
      where: { userId_entityId: { userId, entityId } },
      include: { entity: { select: { id: true, name: true, code: true } } },
    });

    if (!membership || !membership.isActive) {
      throw new ForbiddenException(
        "You do not have an active membership in this company",
      );
    }

    await prisma.user.update({
      where: { id: userId },
      data: { activeEntityId: entityId },
    });

    return {
      activeEntityId: entityId,
      entity: membership.entity,
    };
  }

  async setActiveOrganization(userId: string, organizationId: string) {
    const membership = await prisma.organizationMembership.findUnique({
      where: {
        organizationId_userId: { organizationId, userId },
      },
      include: {
        organization: {
          select: { id: true, name: true, slug: true, status: true, deletedAt: true },
        },
      },
    });

    if (!membership || !membership.isActive || membership.organization.deletedAt) {
      throw new ForbiddenException(
        "You do not have an active membership in this organization",
      );
    }

    await prisma.user.update({
      where: { id: userId },
      data: { activeOrganizationId: organizationId },
    });

    return {
      activeOrganizationId: organizationId,
      orgRole: membership.orgRole,
      organization: {
        id: membership.organization.id,
        name: membership.organization.name,
        slug: membership.organization.slug,
        status: membership.organization.status,
      },
    };
  }

  async createUser(input: CreateUserInput) {
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
      const user = await prisma.$transaction(async (tx) => {
        const newUser = await tx.user.create({
          data: {
            id: authUser.user.id,
            email: input.email,
            name: input.name,
            entityId: input.entityId,
            department: input.department,
            jobTitle: input.jobTitle,
            mustChangePassword: true,
            isActive: true,
          },
        });

        const employeeRole = await tx.role.findFirst({
          where: { name: "Employee", isSystem: true },
        });

        const roleIds = [...(input.roleIds || [])];
        if (employeeRole && !roleIds.includes(employeeRole.id)) {
          roleIds.push(employeeRole.id);
        }

        if (roleIds.length > 0) {
          await tx.userRole.createMany({
            data: roleIds.map((roleId) => ({
              userId: newUser.id,
              roleId,
            })),
          });
        }

        return newUser;
      });

      this.sendWelcomeEmail(input.name, input.email, input.password);

      return user;
    } catch (err) {
      await supabaseAdmin.auth.admin.deleteUser(authUser.user.id);
      throw err;
    }
  }

  private sendWelcomeEmail(name: string, email: string, password: string) {
    void sendWelcomeTemplateEmail({
      to: email,
      name,
      email,
      temporaryPassword: password,
      portalUrl: PORTAL_URL,
    });
  }

  async changePassword(
    userId: string,
    input: { currentPassword: string; newPassword: string },
  ) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException("User not found");

    const { error: signInErr } = await supabaseAdmin.auth.signInWithPassword({
      email: user.email,
      password: input.currentPassword,
    });
    if (signInErr) {
      throw new BadRequestException("Current password is incorrect");
    }

    const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
      password: input.newPassword,
    });
    if (error) {
      throw new BadRequestException(
        `Failed to change password: ${error.message}`,
      );
    }

    await prisma.user.update({
      where: { id: userId },
      data: { mustChangePassword: false },
    });
  }

  async getMyProfile(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        entity: true,
        userRoles: { include: { role: { select: { id: true, name: true } } } },
      },
    });

    if (!user) throw new UnauthorizedException("User not found");

    return {
      profile: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        isActive: user.isActive,
        mustChangePassword: user.mustChangePassword,
        phone: user.phone,
        phonePublic: user.phonePublic,
        department: user.department,
        jobTitle: user.jobTitle,
        employeeId: user.employeeId,
        employmentType: user.employmentType,
        startDate: user.startDate,
        endDate: user.endDate,
        location: user.location,
        country: user.country,
        timezone: user.timezone,
        locale: user.locale,
        entity: user.entity,
        roles: user.userRoles.map((ur) => ur.role),
      },
    };
  }

  async updateMyProfile(
    userId: string,
    input: {
      phone?: string;
      phonePublic?: boolean;
      location?: string;
      country?: string;
      timezone?: string;
      locale?: string;
      avatarUrl?: string;
    },
  ) {
    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        ...(input.phone !== undefined && { phone: input.phone || null }),
        ...(input.phonePublic !== undefined && {
          phonePublic: input.phonePublic,
        }),
        ...(input.location !== undefined && {
          location: input.location || null,
        }),
        ...(input.country !== undefined && { country: input.country || null }),
        ...(input.timezone !== undefined && {
          timezone: input.timezone || null,
        }),
        ...(input.locale !== undefined && { locale: input.locale || null }),
        ...(input.avatarUrl !== undefined && {
          avatarUrl: input.avatarUrl || null,
        }),
      },
      include: { entity: true },
    });

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      phone: user.phone,
      phonePublic: user.phonePublic,
      location: user.location,
      country: user.country,
      timezone: user.timezone,
      locale: user.locale,
    };
  }

  async resetPassword(userId: string, newPassword: string) {
    const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
      password: newPassword,
    });

    if (error) {
      throw new BadRequestException(
        `Failed to reset password: ${error.message}`,
      );
    }

    await prisma.user.update({
      where: { id: userId },
      data: { mustChangePassword: true },
    });
  }
}

export const authService = new AuthService();
