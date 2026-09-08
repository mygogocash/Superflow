import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@/common/exceptions/http-exception";
import { prisma } from "@/infrastructure/database/prisma";
import type {
  CreateWikiPageInput,
  ListWikiPagesQuery,
  MoveWikiPageInput,
  UpdateWikiPageInput,
  WikiPagePermissionInput,
} from "@/modules/docs/docs.validation";

const userSelect = { id: true, name: true, email: true } as const;

const listSelect = {
  id: true,
  title: true,
  parentId: true,
  position: true,
  folder: true,
  slug: true,
  isPublished: true,
  isRestricted: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
  createdBy: { select: userSelect },
  updatedBy: { select: userSelect },
} as const;

type AccessLevel = "read" | "edit";

export class DocsService {
  /**
   * Determine whether a given user can access a given page at the
   * requested level. Module-level perms are checked at the route guard;
   * this method enforces page-level overrides when isRestricted is on.
   *
   * Pass an explicit `isAdmin` flag for callers that already resolved
   * the user's roles — the System role bypasses page-level gates the
   * same way it bypasses module ones.
   */
  private async canAccess(
    pageId: string,
    userId: string,
    level: AccessLevel,
    isAdmin: boolean,
  ): Promise<boolean> {
    if (isAdmin) return true;
    const page = await prisma.wikiPage.findUnique({
      where: { id: pageId },
      select: { isRestricted: true, createdById: true },
    });
    if (!page) return false;
    if (!page.isRestricted) return true;
    // Creators always retain edit access on their own pages even if
    // they aren't on the explicit ACL — otherwise turning on
    // restriction can lock a user out of their own document.
    if (page.createdById === userId) return true;
    const perm = await prisma.wikiPagePermission.findUnique({
      where: { pageId_userId: { pageId, userId } },
      select: { level: true },
    });
    if (!perm) return false;
    if (level === "read") return true;
    return perm.level === "edit";
  }

  async list(
    query: ListWikiPagesQuery,
    viewer: { id: string; isAdmin: boolean; canSeeUnpublished?: boolean },
  ) {
    const { page, limit, includeUnpublished, folder, search } = query;
    const allowUnpublished = Boolean(
      includeUnpublished && (viewer.isAdmin || viewer.canSeeUnpublished),
    );
    const where = {
      ...(allowUnpublished ? {} : { isPublished: true }),
      ...(folder ? { folder } : {}),
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: "insensitive" as const } },
              { body: { contains: search, mode: "insensitive" as const } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.wikiPage.findMany({
        where,
        select: listSelect,
        orderBy: [{ folder: "asc" }, { position: "asc" }, { title: "asc" }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.wikiPage.count({ where }),
    ]);

    const data = await this.filterReadable(rows, viewer);

    return {
      data,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Returns every readable page as a flat list, but with the parent /
   * position columns the client uses to rebuild the tree. Callers that
   * need the full tree get a single network round-trip.
   */
  async tree(
    viewer: { id: string; isAdmin: boolean; canSeeUnpublished?: boolean },
    includeUnpublished: boolean,
  ) {
    const allowUnpublished = Boolean(
      includeUnpublished && (viewer.isAdmin || viewer.canSeeUnpublished),
    );
    const rows = await prisma.wikiPage.findMany({
      where: allowUnpublished ? undefined : { isPublished: true },
      select: listSelect,
      orderBy: [{ position: "asc" }, { title: "asc" }],
    });
    return this.filterReadable(rows, viewer);
  }

  private async filterReadable<
    T extends { id: string; isRestricted: boolean; createdById: string },
  >(rows: T[], viewer: { id: string; isAdmin: boolean }): Promise<T[]> {
    if (viewer.isAdmin) return rows;
    const restrictedIds = rows
      .filter((r) => r.isRestricted && r.createdById !== viewer.id)
      .map((r) => r.id);
    if (restrictedIds.length === 0) return rows;
    const allowed = await prisma.wikiPagePermission.findMany({
      where: { pageId: { in: restrictedIds }, userId: viewer.id },
      select: { pageId: true },
    });
    const allowedSet = new Set(allowed.map((a) => a.pageId));
    return rows.filter(
      (r) =>
        !r.isRestricted || r.createdById === viewer.id || allowedSet.has(r.id),
    );
  }

  async getByIdOrSlug(
    idOrSlug: string,
    viewer: { id: string; isAdmin: boolean; canSeeUnpublished?: boolean },
  ) {
    const row = await prisma.wikiPage.findFirst({
      where: { OR: [{ id: idOrSlug }, { slug: idOrSlug }] },
      include: {
        createdBy: { select: userSelect },
        updatedBy: { select: userSelect },
      },
    });
    if (!row) throw new NotFoundException("Page not found");
    if (
      !row.isPublished &&
      row.createdById !== viewer.id &&
      !(viewer.isAdmin || viewer.canSeeUnpublished)
    ) {
      throw new NotFoundException("Page not found");
    }
    const ok = await this.canAccess(row.id, viewer.id, "read", viewer.isAdmin);
    if (!ok) throw new ForbiddenException("You don't have access to this page");
    return row;
  }

  async create(input: CreateWikiPageInput, userId: string) {
    if (input.slug) {
      const dup = await prisma.wikiPage.findUnique({
        where: { slug: input.slug },
      });
      if (dup) {
        throw new ConflictException(
          `A page with slug "${input.slug}" already exists.`,
        );
      }
    }
    if (input.parentId) {
      const parent = await prisma.wikiPage.findUnique({
        where: { id: input.parentId },
        select: { id: true },
      });
      if (!parent) throw new BadRequestException("Parent page does not exist");
    }
    const position =
      input.position ?? (await this.nextPosition(input.parentId ?? null));
    return prisma.wikiPage.create({
      data: {
        title: input.title,
        body: input.body,
        parentId: input.parentId ?? null,
        position,
        folder: input.folder || null,
        slug: input.slug || null,
        isPublished: input.isPublished,
        isRestricted: input.isRestricted,
        attachments: (input.attachments ?? []) as never,
        createdById: userId,
        updatedById: userId,
      },
      include: {
        createdBy: { select: userSelect },
        updatedBy: { select: userSelect },
      },
    });
  }

  private async nextPosition(parentId: string | null): Promise<number> {
    const last = await prisma.wikiPage.findFirst({
      where: { parentId },
      orderBy: { position: "desc" },
      select: { position: true },
    });
    return (last?.position ?? -1) + 1;
  }

  async update(
    id: string,
    input: UpdateWikiPageInput,
    viewer: { id: string; isAdmin: boolean },
  ) {
    const existing = await prisma.wikiPage.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException("Page not found");

    const ok = await this.canAccess(id, viewer.id, "edit", viewer.isAdmin);
    if (!ok) {
      throw new ForbiddenException("You don't have edit access to this page");
    }

    if (input.slug && input.slug !== existing.slug) {
      const dup = await prisma.wikiPage.findUnique({
        where: { slug: input.slug },
      });
      if (dup) {
        throw new ConflictException(
          `A page with slug "${input.slug}" already exists.`,
        );
      }
    }

    if (input.parentId !== undefined && input.parentId !== existing.parentId) {
      if (input.parentId) {
        if (input.parentId === id) {
          throw new BadRequestException("A page can't be its own parent");
        }
        const parent = await prisma.wikiPage.findUnique({
          where: { id: input.parentId },
          select: { id: true },
        });
        if (!parent) {
          throw new BadRequestException("Parent page does not exist");
        }
        await this.assertNotDescendant(input.parentId, id);
      }
    }

    // Snapshot the previous body before mutating so version history
    // captures every change. Skip the snapshot when only metadata
    // (folder, slug, parent, position, restriction) is changing — body
    // history is what users actually want to see.
    const bodyChanged =
      input.body !== undefined && input.body !== existing.body;
    const titleChanged =
      input.title !== undefined && input.title !== existing.title;
    if (bodyChanged || titleChanged) {
      await this.snapshotVersion(existing, viewer.id);
    }

    return prisma.wikiPage.update({
      where: { id },
      data: {
        ...(input.title !== undefined && { title: input.title }),
        ...(input.body !== undefined && { body: input.body }),
        ...(input.parentId !== undefined && {
          parentId: input.parentId ?? null,
        }),
        ...(input.position !== undefined && { position: input.position }),
        ...(input.folder !== undefined && {
          folder: input.folder ? input.folder : null,
        }),
        ...(input.slug !== undefined && {
          slug: input.slug ? input.slug : null,
        }),
        ...(input.isPublished !== undefined && {
          isPublished: input.isPublished,
        }),
        ...(input.isRestricted !== undefined && {
          isRestricted: input.isRestricted,
        }),
        ...(input.attachments !== undefined && {
          attachments: input.attachments as never,
        }),
        updatedById: viewer.id,
      },
      include: {
        createdBy: { select: userSelect },
        updatedBy: { select: userSelect },
      },
    });
  }

  /**
   * Walk up the tree from `candidateParentId` looking for `pageId`.
   * Used to prevent making a page a descendant of itself when moving.
   */
  private async assertNotDescendant(candidateParentId: string, pageId: string) {
    let cursor: string | null = candidateParentId;
    let hops = 0;
    while (cursor && hops < 100) {
      if (cursor === pageId) {
        throw new BadRequestException("Can't move a page underneath itself");
      }
      const next: { parentId: string | null } | null =
        await prisma.wikiPage.findUnique({
          where: { id: cursor },
          select: { parentId: true },
        });
      cursor = next?.parentId ?? null;
      hops += 1;
    }
  }

  async move(
    id: string,
    input: MoveWikiPageInput,
    viewer: { id: string; isAdmin: boolean },
  ) {
    const existing = await prisma.wikiPage.findUnique({
      where: { id },
      select: { id: true, parentId: true },
    });
    if (!existing) throw new NotFoundException("Page not found");

    const ok = await this.canAccess(id, viewer.id, "edit", viewer.isAdmin);
    if (!ok) {
      throw new ForbiddenException("You don't have edit access to this page");
    }

    if (input.parentId) {
      if (input.parentId === id) {
        throw new BadRequestException("A page can't be its own parent");
      }
      const parent = await prisma.wikiPage.findUnique({
        where: { id: input.parentId },
        select: { id: true },
      });
      if (!parent) throw new BadRequestException("Parent page does not exist");
      await this.assertNotDescendant(input.parentId, id);
    }

    return prisma.wikiPage.update({
      where: { id },
      data: {
        parentId: input.parentId ?? null,
        position: input.position,
        updatedById: viewer.id,
      },
      include: {
        createdBy: { select: userSelect },
        updatedBy: { select: userSelect },
      },
    });
  }

  async delete(id: string, viewer: { id: string; isAdmin: boolean }) {
    const existing = await prisma.wikiPage.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException("Page not found");
    const ok = await this.canAccess(id, viewer.id, "edit", viewer.isAdmin);
    if (!ok) {
      throw new ForbiddenException("You don't have edit access to this page");
    }
    await prisma.wikiPage.delete({ where: { id } });
  }

  // ── Versions ─────────────────────────────────────────────────

  private async snapshotVersion(
    existing: { id: string; title: string; body: string },
    userId: string,
  ) {
    const last = await prisma.wikiPageVersion.findFirst({
      where: { pageId: existing.id },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    const nextVersion = (last?.version ?? 0) + 1;
    await prisma.wikiPageVersion.create({
      data: {
        pageId: existing.id,
        version: nextVersion,
        title: existing.title,
        body: existing.body,
        createdById: userId,
      },
    });
  }

  async listVersions(pageId: string, viewer: { id: string; isAdmin: boolean }) {
    const ok = await this.canAccess(pageId, viewer.id, "read", viewer.isAdmin);
    if (!ok) throw new ForbiddenException("You don't have access to this page");
    return prisma.wikiPageVersion.findMany({
      where: { pageId },
      orderBy: { version: "desc" },
      select: {
        id: true,
        version: true,
        title: true,
        createdAt: true,
        createdBy: { select: userSelect },
      },
    });
  }

  async getVersion(
    pageId: string,
    versionId: string,
    viewer: { id: string; isAdmin: boolean },
  ) {
    const ok = await this.canAccess(pageId, viewer.id, "read", viewer.isAdmin);
    if (!ok) throw new ForbiddenException("You don't have access to this page");
    const row = await prisma.wikiPageVersion.findFirst({
      where: { id: versionId, pageId },
      include: { createdBy: { select: userSelect } },
    });
    if (!row) throw new NotFoundException("Version not found");
    return row;
  }

  async restoreVersion(
    pageId: string,
    versionId: string,
    viewer: { id: string; isAdmin: boolean },
  ) {
    const ok = await this.canAccess(pageId, viewer.id, "edit", viewer.isAdmin);
    if (!ok) {
      throw new ForbiddenException("You don't have edit access to this page");
    }
    const target = await prisma.wikiPageVersion.findFirst({
      where: { id: versionId, pageId },
    });
    if (!target) throw new NotFoundException("Version not found");
    const existing = await prisma.wikiPage.findUnique({
      where: { id: pageId },
    });
    if (!existing) throw new NotFoundException("Page not found");

    // Snapshot current state before overwrite so restore is itself
    // an undoable action.
    await this.snapshotVersion(existing, viewer.id);
    return prisma.wikiPage.update({
      where: { id: pageId },
      data: {
        title: target.title,
        body: target.body,
        updatedById: viewer.id,
      },
      include: {
        createdBy: { select: userSelect },
        updatedBy: { select: userSelect },
      },
    });
  }

  // ── Permissions ──────────────────────────────────────────────

  async listPermissions(
    pageId: string,
    viewer: { id: string; isAdmin: boolean },
  ) {
    const ok = await this.canAccess(pageId, viewer.id, "edit", viewer.isAdmin);
    if (!ok) throw new ForbiddenException("Only editors can view permissions");
    return prisma.wikiPagePermission.findMany({
      where: { pageId },
      orderBy: { createdAt: "asc" },
      include: { user: { select: userSelect } },
    });
  }

  async grantPermission(
    pageId: string,
    input: WikiPagePermissionInput,
    viewer: { id: string; isAdmin: boolean },
  ) {
    const ok = await this.canAccess(pageId, viewer.id, "edit", viewer.isAdmin);
    if (!ok) throw new ForbiddenException("Only editors can grant permissions");
    const page = await prisma.wikiPage.findUnique({
      where: { id: pageId },
      select: { id: true },
    });
    if (!page) throw new NotFoundException("Page not found");
    const user = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true },
    });
    if (!user) throw new BadRequestException("User does not exist");
    return prisma.wikiPagePermission.upsert({
      where: { pageId_userId: { pageId, userId: input.userId } },
      create: {
        pageId,
        userId: input.userId,
        level: input.level,
      },
      update: { level: input.level },
      include: { user: { select: userSelect } },
    });
  }

  async revokePermission(
    pageId: string,
    permissionId: string,
    viewer: { id: string; isAdmin: boolean },
  ) {
    const ok = await this.canAccess(pageId, viewer.id, "edit", viewer.isAdmin);
    if (!ok) {
      throw new ForbiddenException("Only editors can revoke permissions");
    }
    const existing = await prisma.wikiPagePermission.findFirst({
      where: { id: permissionId, pageId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException("Permission not found");
    await prisma.wikiPagePermission.delete({ where: { id: permissionId } });
  }
}

export const docsService = new DocsService();
