import { randomUUID } from "node:crypto";

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@/common/exceptions/http-exception";
import { prisma } from "@/infrastructure/database/prisma";
import {
  canAssignOrgRole,
  isOrgAdminRole,
  isOrgRole,
  isPlatformAdmin,
  type OrgRole,
} from "@/modules/auth/org-rbac";
import type {
  CreateOrganizationInput,
  UpdateOrganizationInput,
  UpdateOrgMembershipInput,
  UpsertOrgMembershipInput,
} from "@/modules/organizations/organizations.validation";

async function loadActorOrgContext(
  actorId: string,
  organizationId: string | null,
) {
  const actor = await prisma.user.findFirst({
    where: { id: actorId, deletedAt: null },
    select: { id: true, platformRole: true, activeOrganizationId: true },
  });
  if (!actor) throw new ForbiddenException("Actor not found");

  let orgRole: OrgRole | null = null;
  const targetOrgId = organizationId ?? actor.activeOrganizationId;
  if (targetOrgId) {
    const m = await prisma.organizationMembership.findFirst({
      where: {
        userId: actorId,
        organizationId: targetOrgId,
        isActive: true,
      },
      select: { orgRole: true },
    });
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

function assertOrgAdmin(ctx: {
  isPlatformAdmin: boolean;
  orgRole: OrgRole | null;
}) {
  if (ctx.isPlatformAdmin) return;
  if (!isOrgAdminRole(ctx.orgRole)) {
    throw new ForbiddenException("Organization admin required");
  }
}

function slugifyFallback(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

export class OrganizationsService {
  async listOrganizations(actorId: string) {
    const ctx = await loadActorOrgContext(actorId, null);
    assertPlatformAdmin(ctx);
    const rows = await prisma.organization.findMany({
      where: { deletedAt: null },
      orderBy: { name: "asc" },
    });
    return { data: rows };
  }

  async getOrganization(actorId: string, organizationId: string) {
    const ctx = await loadActorOrgContext(actorId, organizationId);
    if (!ctx.isPlatformAdmin && ctx.orgRole == null) {
      throw new ForbiddenException("Not a member of this organization");
    }
    const org = await prisma.organization.findFirst({
      where: { id: organizationId, deletedAt: null },
    });
    if (!org) throw new NotFoundException("Organization not found");
    const memberCount = await prisma.organizationMembership.count({
      where: { organizationId, isActive: true },
    });
    return { data: { ...org, memberCount } };
  }

  async createOrganization(actorId: string, input: CreateOrganizationInput) {
    const ctx = await loadActorOrgContext(actorId, null);
    assertPlatformAdmin(ctx);

    const slug = input.slug || slugifyFallback(input.name);
    const existing = await prisma.organization.findUnique({ where: { slug } });
    if (existing) {
      throw new ConflictException("Organization slug already exists");
    }

    const superAdmin = await prisma.user.findFirst({
      where: { id: input.superAdminUserId, deletedAt: null },
      select: { id: true },
    });
    if (!superAdmin) {
      throw new BadRequestException("Super admin user not found");
    }

    const id = `org_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    await prisma.organization.create({
      data: {
        id,
        name: input.name,
        slug,
        status: "active",
        memberships: {
          create: {
            userId: input.superAdminUserId,
            orgRole: "super_admin",
            isActive: true,
            invitedById: actorId,
          },
        },
      },
    });
    return this.getOrganization(actorId, id);
  }

  async updateOrganization(
    actorId: string,
    organizationId: string,
    input: UpdateOrganizationInput,
  ) {
    const ctx = await loadActorOrgContext(actorId, organizationId);
    assertPlatformAdmin(ctx);
    const org = await prisma.organization.findFirst({
      where: { id: organizationId, deletedAt: null },
    });
    if (!org) throw new NotFoundException("Organization not found");
    await prisma.organization.update({
      where: { id: organizationId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
      },
    });
    return this.getOrganization(actorId, organizationId);
  }

  async listMembers(actorId: string, organizationId: string) {
    const ctx = await loadActorOrgContext(actorId, organizationId);
    assertOrgAdmin(ctx);
    const rows = await prisma.organizationMembership.findMany({
      where: { organizationId },
      include: {
        user: { select: { id: true, email: true, name: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    return {
      data: rows.map((r) => ({
        id: r.id,
        organizationId: r.organizationId,
        userId: r.userId,
        orgRole: r.orgRole,
        isActive: r.isActive,
        createdAt: r.createdAt,
        user: r.user,
      })),
    };
  }

  async upsertMember(
    actorId: string,
    organizationId: string,
    input: UpsertOrgMembershipInput,
  ) {
    const ctx = await loadActorOrgContext(actorId, organizationId);
    assertOrgAdmin(ctx);
    if (
      !canAssignOrgRole(
        { platformRole: ctx.platformRole, orgRole: ctx.orgRole },
        input.orgRole,
      )
    ) {
      throw new ForbiddenException("Cannot assign this organization role");
    }

    const org = await prisma.organization.findFirst({
      where: { id: organizationId, deletedAt: null },
    });
    if (!org) throw new NotFoundException("Organization not found");
    if (org.status === "suspended" && !ctx.isPlatformAdmin) {
      throw new ForbiddenException("Organization is suspended");
    }

    const target = await prisma.user.findFirst({
      where: { id: input.userId, deletedAt: null },
      select: { id: true },
    });
    if (!target) throw new BadRequestException("User not found");

    await prisma.organizationMembership.upsert({
      where: {
        organizationId_userId: {
          organizationId,
          userId: input.userId,
        },
      },
      update: {
        orgRole: input.orgRole,
        isActive: true,
      },
      create: {
        organizationId,
        userId: input.userId,
        orgRole: input.orgRole,
        isActive: true,
        invitedById: actorId,
      },
    });
    return this.listMembers(actorId, organizationId);
  }

  async updateMember(
    actorId: string,
    organizationId: string,
    membershipId: string,
    input: UpdateOrgMembershipInput,
  ) {
    const ctx = await loadActorOrgContext(actorId, organizationId);
    assertOrgAdmin(ctx);

    const existing = await prisma.organizationMembership.findFirst({
      where: { id: membershipId, organizationId },
    });
    if (!existing) throw new NotFoundException("Membership not found");

    if (input.orgRole !== undefined) {
      if (
        !canAssignOrgRole(
          { platformRole: ctx.platformRole, orgRole: ctx.orgRole },
          input.orgRole,
        )
      ) {
        throw new ForbiddenException("Cannot assign this organization role");
      }
    }

    await prisma.organizationMembership.update({
      where: { id: membershipId },
      data: {
        ...(input.orgRole !== undefined ? { orgRole: input.orgRole } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
    return this.listMembers(actorId, organizationId);
  }
}

export const organizationsService = new OrganizationsService();
