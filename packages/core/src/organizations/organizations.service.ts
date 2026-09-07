import { and, count, eq, isNull } from "drizzle-orm";
import {
  canAssignOrgRole,
  isOrgRole,
  isPlatformAdmin,
  isOrgAdminRole,
  type OrgRole,
} from "@nexora/auth/org-rbac";
import type {
  CreateOrganizationInput,
  UpdateOrganizationInput,
  UpdateOrgMembershipInput,
  UpsertOrgMembershipInput,
} from "@nexora/contracts/modules/organizations/organizations.validation";
import type { Db } from "@nexora/db";
import { schema } from "@nexora/db";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "../http-exception";

function slugifyFallback(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

async function loadActorOrgContext(db: Db, actorId: string, organizationId: string | null) {
  const [actor] = await db
    .select({
      id: schema.users.id,
      platformRole: schema.users.platformRole,
      activeOrganizationId: schema.users.activeOrganizationId,
    })
    .from(schema.users)
    .where(and(eq(schema.users.id, actorId), isNull(schema.users.deletedAt)))
    .limit(1);
  if (!actor) throw new ForbiddenException("Actor not found");

  let orgRole: OrgRole | null = null;
  const targetOrgId = organizationId ?? actor.activeOrganizationId;
  if (targetOrgId) {
    const [m] = await db
      .select({ orgRole: schema.organizationMemberships.orgRole })
      .from(schema.organizationMemberships)
      .where(
        and(
          eq(schema.organizationMemberships.userId, actorId),
          eq(schema.organizationMemberships.organizationId, targetOrgId),
          eq(schema.organizationMemberships.isActive, true),
        ),
      )
      .limit(1);
    if (m && isOrgRole(m.orgRole)) orgRole = m.orgRole;
  }

  return {
    platformRole: actor.platformRole,
    activeOrganizationId: actor.activeOrganizationId,
    orgRole,
    isPlatformAdmin: isPlatformAdmin(actor.platformRole),
  };
}

function assertPlatformAdmin(ctx: { isPlatformAdmin: boolean }) {
  if (!ctx.isPlatformAdmin) {
    throw new ForbiddenException("Platform admin required");
  }
}

function assertOrgAdmin(ctx: { isPlatformAdmin: boolean; orgRole: OrgRole | null }) {
  if (ctx.isPlatformAdmin) return;
  if (!isOrgAdminRole(ctx.orgRole)) {
    throw new ForbiddenException("Organization admin required");
  }
}

export async function listOrganizations(db: Db, actorId: string) {
  const ctx = await loadActorOrgContext(db, actorId, null);
  assertPlatformAdmin(ctx);

  const rows = await db
    .select({
      id: schema.organizations.id,
      name: schema.organizations.name,
      slug: schema.organizations.slug,
      status: schema.organizations.status,
      createdAt: schema.organizations.createdAt,
      updatedAt: schema.organizations.updatedAt,
    })
    .from(schema.organizations)
    .where(isNull(schema.organizations.deletedAt));

  return { data: rows };
}

export async function getOrganization(db: Db, actorId: string, organizationId: string) {
  const ctx = await loadActorOrgContext(db, actorId, organizationId);
  if (!ctx.isPlatformAdmin && ctx.orgRole == null) {
    throw new ForbiddenException("Not a member of this organization");
  }

  const [org] = await db
    .select()
    .from(schema.organizations)
    .where(and(eq(schema.organizations.id, organizationId), isNull(schema.organizations.deletedAt)))
    .limit(1);
  if (!org) throw new NotFoundException("Organization not found");

  const [memberCount] = await db
    .select({ n: count() })
    .from(schema.organizationMemberships)
    .where(
      and(
        eq(schema.organizationMemberships.organizationId, organizationId),
        eq(schema.organizationMemberships.isActive, true),
      ),
    );

  return {
    data: {
      ...org,
      memberCount: Number(memberCount?.n ?? 0),
    },
  };
}

export async function createOrganization(db: Db, actorId: string, input: CreateOrganizationInput) {
  const ctx = await loadActorOrgContext(db, actorId, null);
  assertPlatformAdmin(ctx);

  const slug = input.slug || slugifyFallback(input.name);
  const [existing] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, slug))
    .limit(1);
  if (existing) throw new ConflictException("Organization slug already exists");

  const [superAdmin] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(eq(schema.users.id, input.superAdminUserId), isNull(schema.users.deletedAt)))
    .limit(1);
  if (!superAdmin) throw new BadRequestException("Super admin user not found");

  const id = `org_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const now = new Date().toISOString();

  await db.insert(schema.organizations).values({
    id,
    name: input.name,
    slug,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(schema.organizationMemberships).values({
    id: crypto.randomUUID(),
    organizationId: id,
    userId: input.superAdminUserId,
    orgRole: "super_admin",
    isActive: true,
    invitedById: actorId,
    createdAt: now,
    updatedAt: now,
  });

  return getOrganization(db, actorId, id);
}

export async function updateOrganization(
  db: Db,
  actorId: string,
  organizationId: string,
  input: UpdateOrganizationInput,
) {
  const ctx = await loadActorOrgContext(db, actorId, organizationId);
  assertPlatformAdmin(ctx);

  const [org] = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations)
    .where(and(eq(schema.organizations.id, organizationId), isNull(schema.organizations.deletedAt)))
    .limit(1);
  if (!org) throw new NotFoundException("Organization not found");

  await db
    .update(schema.organizations)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.organizations.id, organizationId));

  return getOrganization(db, actorId, organizationId);
}

export async function listMembers(db: Db, actorId: string, organizationId: string) {
  const ctx = await loadActorOrgContext(db, actorId, organizationId);
  assertOrgAdmin(ctx);
  if (!ctx.isPlatformAdmin && ctx.orgRole == null) {
    throw new ForbiddenException("Not a member of this organization");
  }

  const rows = await db
    .select({
      id: schema.organizationMemberships.id,
      organizationId: schema.organizationMemberships.organizationId,
      userId: schema.organizationMemberships.userId,
      orgRole: schema.organizationMemberships.orgRole,
      isActive: schema.organizationMemberships.isActive,
      createdAt: schema.organizationMemberships.createdAt,
      email: schema.users.email,
      name: schema.users.name,
    })
    .from(schema.organizationMemberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.organizationMemberships.userId))
    .where(eq(schema.organizationMemberships.organizationId, organizationId));

  return {
    data: rows.map((r) => ({
      id: r.id,
      organizationId: r.organizationId,
      userId: r.userId,
      orgRole: r.orgRole,
      isActive: r.isActive,
      createdAt: r.createdAt,
      user: { id: r.userId, email: r.email, name: r.name },
    })),
  };
}

export async function upsertMember(
  db: Db,
  actorId: string,
  organizationId: string,
  input: UpsertOrgMembershipInput,
) {
  const ctx = await loadActorOrgContext(db, actorId, organizationId);
  assertOrgAdmin(ctx);

  if (!canAssignOrgRole({ platformRole: ctx.platformRole, orgRole: ctx.orgRole }, input.orgRole)) {
    throw new ForbiddenException("Cannot assign this organization role");
  }

  const [org] = await db
    .select({ id: schema.organizations.id, status: schema.organizations.status })
    .from(schema.organizations)
    .where(and(eq(schema.organizations.id, organizationId), isNull(schema.organizations.deletedAt)))
    .limit(1);
  if (!org) throw new NotFoundException("Organization not found");
  if (org.status === "suspended" && !ctx.isPlatformAdmin) {
    throw new ForbiddenException("Organization is suspended");
  }

  const [target] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(eq(schema.users.id, input.userId), isNull(schema.users.deletedAt)))
    .limit(1);
  if (!target) throw new BadRequestException("User not found");

  const now = new Date().toISOString();
  const [existing] = await db
    .select({ id: schema.organizationMemberships.id })
    .from(schema.organizationMemberships)
    .where(
      and(
        eq(schema.organizationMemberships.organizationId, organizationId),
        eq(schema.organizationMemberships.userId, input.userId),
      ),
    )
    .limit(1);

  if (existing) {
    await db
      .update(schema.organizationMemberships)
      .set({
        orgRole: input.orgRole,
        isActive: true,
        updatedAt: now,
      })
      .where(eq(schema.organizationMemberships.id, existing.id));
  } else {
    await db.insert(schema.organizationMemberships).values({
      id: crypto.randomUUID(),
      organizationId,
      userId: input.userId,
      orgRole: input.orgRole,
      isActive: true,
      invitedById: actorId,
      createdAt: now,
      updatedAt: now,
    });
  }

  return listMembers(db, actorId, organizationId);
}

export async function updateMember(
  db: Db,
  actorId: string,
  organizationId: string,
  membershipId: string,
  input: UpdateOrgMembershipInput,
) {
  const ctx = await loadActorOrgContext(db, actorId, organizationId);
  assertOrgAdmin(ctx);

  const [existing] = await db
    .select()
    .from(schema.organizationMemberships)
    .where(
      and(
        eq(schema.organizationMemberships.id, membershipId),
        eq(schema.organizationMemberships.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!existing) throw new NotFoundException("Membership not found");

  if (input.orgRole !== undefined) {
    if (!canAssignOrgRole({ platformRole: ctx.platformRole, orgRole: ctx.orgRole }, input.orgRole)) {
      throw new ForbiddenException("Cannot assign this organization role");
    }
  }

  await db
    .update(schema.organizationMemberships)
    .set({
      ...(input.orgRole !== undefined ? { orgRole: input.orgRole } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.organizationMemberships.id, membershipId));

  return listMembers(db, actorId, organizationId);
}

export async function setActiveOrganization(db: Db, userId: string, organizationId: string) {
  const [membership] = await db
    .select({
      id: schema.organizationMemberships.id,
      orgRole: schema.organizationMemberships.orgRole,
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
        eq(schema.organizationMemberships.organizationId, organizationId),
        eq(schema.organizationMemberships.isActive, true),
        isNull(schema.organizations.deletedAt),
      ),
    )
    .limit(1);

  if (!membership) {
    throw new ForbiddenException("You do not have an active membership in this organization");
  }
  if (membership.status === "suspended") {
    const [actor] = await db
      .select({ platformRole: schema.users.platformRole })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    if (!isPlatformAdmin(actor?.platformRole)) {
      throw new ForbiddenException("Organization is suspended");
    }
  }

  await db
    .update(schema.users)
    .set({
      activeOrganizationId: organizationId,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.users.id, userId));

  return {
    activeOrganizationId: organizationId,
    orgRole: membership.orgRole,
    organization: {
      id: organizationId,
      name: membership.name,
      slug: membership.slug,
      status: membership.status,
    },
  };
}

/**
 * Resolve user ids that belong to an organization (active membership).
 * Used to scope list queries for non-platform actors.
 */
export async function listActiveMemberUserIds(db: Db, organizationId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: schema.organizationMemberships.userId })
    .from(schema.organizationMemberships)
    .where(
      and(
        eq(schema.organizationMemberships.organizationId, organizationId),
        eq(schema.organizationMemberships.isActive, true),
      ),
    );
  return rows.map((r) => r.userId);
}

export async function resolveActorOrgScope(
  db: Db,
  actorId: string,
): Promise<{
  isPlatformAdmin: boolean;
  activeOrganizationId: string | null;
  orgRole: OrgRole | null;
}> {
  const ctx = await loadActorOrgContext(db, actorId, null);
  return {
    isPlatformAdmin: ctx.isPlatformAdmin,
    activeOrganizationId: ctx.activeOrganizationId,
    orgRole: ctx.orgRole,
  };
}
