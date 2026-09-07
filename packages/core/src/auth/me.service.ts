import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@nexora/db";
import { schema } from "@nexora/db";
import { countActiveDirectReports, resolvePermissions, type RoleRow } from "@nexora/auth/rbac";
import {
  isOrgRole,
  mergeOrgAwarePermissions,
  type OrgRole,
} from "@nexora/auth/org-rbac";
import { applyManagerImplicitPerms } from "@nexora/auth/manager-implicit-perms";
import { isValidPermissionCode } from "@nexora/contracts/common/constants/permissions";

export type MeMembership = {
  entityId: string;
  roleId: string | null;
  entity: { id: string; name: string; code: string };
};

export type MeOrgMembership = {
  organizationId: string;
  orgRole: OrgRole;
  isActive: boolean;
  organization: { id: string; name: string; slug: string; status: string };
};

export type MePayload = {
  user: {
    id: string;
    email: string;
    name: string;
    avatarUrl: string | null;
    department: string | null;
    jobTitle: string | null;
    entity: { id: string; name: string; code: string } | null;
    mustChangePassword: boolean;
    platformRole: string | null;
  };
  roles: Array<{ id: string; name: string; defaultRoute: string | null; isSystem: boolean }>;
  permissions: string[];
  memberships: MeMembership[];
  activeEntityId: string | null;
  organizationMemberships: MeOrgMembership[];
  activeOrganizationId: string | null;
  orgRole: OrgRole | null;
};

/** Port of apps/api auth.service.getMe — same wire shape for the Expo client. */
export async function getMe(db: Db, userId: string): Promise<MePayload> {
  const [user] = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
      avatarUrl: schema.users.avatarUrl,
      department: schema.users.department,
      jobTitle: schema.users.jobTitle,
      entityId: schema.users.entityId,
      activeEntityId: schema.users.activeEntityId,
      activeOrganizationId: schema.users.activeOrganizationId,
      platformRole: schema.users.platformRole,
      mustChangePassword: schema.users.mustChangePassword,
    })
    .from(schema.users)
    .where(and(eq(schema.users.id, userId), isNull(schema.users.deletedAt)))
    .limit(1);

  if (!user) throw new Error("USER_NOT_FOUND");

  let entity: { id: string; name: string; code: string } | null = null;
  if (user.entityId) {
    const [e] = await db
      .select({ id: schema.entities.id, name: schema.entities.name, code: schema.entities.code })
      .from(schema.entities)
      .where(eq(schema.entities.id, user.entityId))
      .limit(1);
    entity = e ?? null;
  }

  const roleRows = await db
    .select({
      id: schema.roles.id,
      name: schema.roles.name,
      isSystem: schema.roles.isSystem,
      defaultRoute: schema.roles.defaultRoute,
      permissionCode: schema.rolePermissions.permissionCode,
    })
    .from(schema.userRoles)
    .innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId))
    .leftJoin(schema.rolePermissions, eq(schema.rolePermissions.roleId, schema.roles.id))
    .where(eq(schema.userRoles.userId, userId));

  const byRole = new Map<string, RoleRow & { id: string; defaultRoute: string | null }>();
  for (const r of roleRows) {
    const existing = byRole.get(r.id) ?? {
      id: r.id,
      name: r.name,
      isSystem: r.isSystem,
      defaultRoute: r.defaultRoute,
      permissionCodes: [] as string[],
    };
    if (r.permissionCode) existing.permissionCodes.push(r.permissionCode);
    byRole.set(r.id, existing);
  }
  const roles = [...byRole.values()];
  const legacyPermissionSet = new Set(resolvePermissions(roles));
  const directReports = await countActiveDirectReports(db, userId);
  applyManagerImplicitPerms(legacyPermissionSet, directReports > 0);

  const membershipRows = await db
    .select({
      entityId: schema.userEntityMemberships.entityId,
      roleId: schema.userEntityMemberships.roleId,
      id: schema.entities.id,
      name: schema.entities.name,
      code: schema.entities.code,
    })
    .from(schema.userEntityMemberships)
    .innerJoin(schema.entities, eq(schema.entities.id, schema.userEntityMemberships.entityId))
    .where(and(eq(schema.userEntityMemberships.userId, userId), eq(schema.userEntityMemberships.isActive, true)));

  const orgMembershipRows = await db
    .select({
      organizationId: schema.organizationMemberships.organizationId,
      orgRole: schema.organizationMemberships.orgRole,
      isActive: schema.organizationMemberships.isActive,
      id: schema.organizations.id,
      name: schema.organizations.name,
      slug: schema.organizations.slug,
      status: schema.organizations.status,
    })
    .from(schema.organizationMemberships)
    .innerJoin(
      schema.organizations,
      eq(schema.organizations.id, schema.organizationMemberships.organizationId),
    )
    .where(
      and(
        eq(schema.organizationMemberships.userId, userId),
        eq(schema.organizationMemberships.isActive, true),
        isNull(schema.organizations.deletedAt),
      ),
    );

  const organizationMemberships: MeOrgMembership[] = orgMembershipRows
    .filter((m) => isOrgRole(m.orgRole))
    .map((m) => ({
      organizationId: m.organizationId,
      orgRole: m.orgRole as OrgRole,
      isActive: m.isActive,
      organization: { id: m.id, name: m.name, slug: m.slug, status: m.status },
    }));

  const activeOrganizationId =
    user.activeOrganizationId &&
    organizationMemberships.some((m) => m.organizationId === user.activeOrganizationId)
      ? user.activeOrganizationId
      : (organizationMemberships[0]?.organizationId ?? null);

  const orgRole =
    organizationMemberships.find((m) => m.organizationId === activeOrganizationId)?.orgRole ?? null;

  const permissions = mergeOrgAwarePermissions({
    legacyPermissionCodes: [...legacyPermissionSet],
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
      entity,
      mustChangePassword: user.mustChangePassword,
      platformRole: user.platformRole ?? null,
    },
    roles: roles.map((r) => ({
      id: r.id,
      name: r.name,
      defaultRoute: r.defaultRoute,
      isSystem: r.isSystem,
    })),
    permissions: permissions.filter(isValidPermissionCode),
    memberships: membershipRows.map((m) => ({
      entityId: m.entityId,
      roleId: m.roleId,
      entity: { id: m.id, name: m.name, code: m.code },
    })),
    activeEntityId: user.activeEntityId ?? null,
    organizationMemberships,
    activeOrganizationId,
    orgRole,
  };
}
