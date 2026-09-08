import type {
  CreateWikiPageInput,
  ListWikiPagesQuery,
  MoveWikiPageInput,
  UpdateWikiPageInput,
  WikiPagePermissionInput,
} from "@nexora/contracts/modules/docs/docs.validation";
import type { Db } from "@nexora/db";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "../http-exception";
import * as repo from "./docs.repository";

/**
 * `canSeeUnpublished` is true for docs:create / docs:update holders
 * (editors). Bare docs:read must not list or open drafts — including
 * via `?includeUnpublished=true` or direct id/slug fetch.
 */
export type DocsViewer = {
  id: string;
  isAdmin: boolean;
  canSeeUnpublished?: boolean;
};

function maySeeUnpublished(viewer: DocsViewer): boolean {
  return viewer.isAdmin || viewer.canSeeUnpublished === true;
}

type AccessLevel = "read" | "edit";

async function canAccess(
  db: Db,
  pageId: string,
  userId: string,
  level: AccessLevel,
  isAdmin: boolean,
): Promise<boolean> {
  if (isAdmin) return true;
  const page = await repo.findPageAccessMeta(db, pageId);
  if (!page) return false;
  if (!page.isRestricted) return true;
  if (page.createdById === userId) return true;
  const perm = await repo.findPagePermission(db, pageId, userId);
  if (!perm) return false;
  if (level === "read") return true;
  return perm.level === "edit";
}

async function filterReadable<T extends { id: string; isRestricted: boolean; createdById: string }>(
  db: Db,
  rows: T[],
  viewer: DocsViewer,
): Promise<T[]> {
  if (viewer.isAdmin) return rows;
  const restrictedIds = rows
    .filter((r) => r.isRestricted && r.createdById !== viewer.id)
    .map((r) => r.id);
  if (restrictedIds.length === 0) return rows;
  const allowedSet = await repo.findAllowedPageIds(db, restrictedIds, viewer.id);
  return rows.filter(
    (r) => !r.isRestricted || r.createdById === viewer.id || allowedSet.has(r.id),
  );
}

async function nextPosition(db: Db, parentId: string | null): Promise<number> {
  const last = await repo.findLastPosition(db, parentId);
  return last + 1;
}

async function assertNotDescendant(db: Db, candidateParentId: string, pageId: string) {
  let cursor: string | null = candidateParentId;
  let hops = 0;
  while (cursor && hops < 100) {
    if (cursor === pageId) {
      throw new BadRequestException("Can't move a page underneath itself");
    }
    cursor = await repo.findParentChainStep(db, cursor);
    hops += 1;
  }
}

async function snapshotVersion(
  db: Db,
  existing: { id: string; title: string; body: string },
  userId: string,
) {
  const lastVersion = await repo.findLastVersionNumber(db, existing.id);
  await repo.createVersion(db, {
    pageId: existing.id,
    version: lastVersion + 1,
    title: existing.title,
    body: existing.body,
    createdById: userId,
  });
}

export async function list(db: Db, query: ListWikiPagesQuery, viewer: DocsViewer) {
  const { page, limit, includeUnpublished, folder, search } = query;
  const allowUnpublished = Boolean(includeUnpublished && maySeeUnpublished(viewer));
  const { data: rows, total } = await repo.findManyForList(
    db,
    { includeUnpublished: allowUnpublished, folder, search },
    page,
    limit,
  );
  const data = await filterReadable(db, rows, viewer);
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

export async function tree(db: Db, viewer: DocsViewer, includeUnpublished: boolean) {
  const allowUnpublished = Boolean(includeUnpublished && maySeeUnpublished(viewer));
  const rows = await repo.findAllForTree(db, allowUnpublished);
  return filterReadable(db, rows, viewer);
}

export async function getByIdOrSlug(db: Db, idOrSlug: string, viewer: DocsViewer) {
  const row = await repo.findPageByIdOrSlug(db, idOrSlug);
  if (!row) throw new NotFoundException("Page not found");
  if (
    !row.isPublished &&
    row.createdById !== viewer.id &&
    !maySeeUnpublished(viewer)
  ) {
    throw new NotFoundException("Page not found");
  }
  const ok = await canAccess(db, row.id, viewer.id, "read", viewer.isAdmin);
  if (!ok) throw new ForbiddenException("You don't have access to this page");
  return row;
}

export async function create(db: Db, input: CreateWikiPageInput, userId: string) {
  if (input.slug) {
    const dup = await repo.findPageBySlug(db, input.slug);
    if (dup) throw new ConflictException(`A page with slug "${input.slug}" already exists.`);
  }
  if (input.parentId) {
    const parent = await repo.findParentId(db, input.parentId);
    if (!parent) throw new BadRequestException("Parent page does not exist");
  }
  const position = input.position ?? (await nextPosition(db, input.parentId ?? null));
  const page = await repo.createPage(db, {
    title: input.title,
    body: input.body,
    parentId: input.parentId ?? null,
    position,
    folder: input.folder ? input.folder : null,
    slug: input.slug ? input.slug : null,
    isPublished: input.isPublished,
    isRestricted: input.isRestricted,
    attachments: input.attachments ?? [],
    createdById: userId,
    updatedById: userId,
  });
  if (!page) throw new NotFoundException("Page not found");
  return page;
}

export async function update(db: Db, id: string, input: UpdateWikiPageInput, viewer: DocsViewer) {
  const existing = await repo.findPageById(db, id);
  if (!existing) throw new NotFoundException("Page not found");

  const ok = await canAccess(db, id, viewer.id, "edit", viewer.isAdmin);
  if (!ok) throw new ForbiddenException("You don't have edit access to this page");

  if (input.slug && input.slug !== existing.slug) {
    const dup = await repo.findPageBySlug(db, input.slug);
    if (dup) throw new ConflictException(`A page with slug "${input.slug}" already exists.`);
  }

  if (input.parentId !== undefined && input.parentId !== existing.parentId) {
    if (input.parentId) {
      if (input.parentId === id) throw new BadRequestException("A page can't be its own parent");
      const parent = await repo.findParentId(db, input.parentId);
      if (!parent) throw new BadRequestException("Parent page does not exist");
      await assertNotDescendant(db, input.parentId, id);
    }
  }

  const bodyChanged = input.body !== undefined && input.body !== existing.body;
  const titleChanged = input.title !== undefined && input.title !== existing.title;
  if (bodyChanged || titleChanged) {
    await snapshotVersion(db, existing, viewer.id);
  }

  const page = await repo.updatePage(db, id, {
    ...(input.title !== undefined && { title: input.title }),
    ...(input.body !== undefined && { body: input.body }),
    ...(input.parentId !== undefined && { parentId: input.parentId ?? null }),
    ...(input.position !== undefined && { position: input.position }),
    ...(input.folder !== undefined && { folder: input.folder ? input.folder : null }),
    ...(input.slug !== undefined && { slug: input.slug ? input.slug : null }),
    ...(input.isPublished !== undefined && { isPublished: input.isPublished }),
    ...(input.isRestricted !== undefined && { isRestricted: input.isRestricted }),
    ...(input.attachments !== undefined && { attachments: input.attachments }),
    updatedById: viewer.id,
  });
  if (!page) throw new NotFoundException("Page not found");
  return page;
}

export async function move(db: Db, id: string, input: MoveWikiPageInput, viewer: DocsViewer) {
  const existing = await repo.findPageById(db, id);
  if (!existing) throw new NotFoundException("Page not found");

  const ok = await canAccess(db, id, viewer.id, "edit", viewer.isAdmin);
  if (!ok) throw new ForbiddenException("You don't have edit access to this page");

  if (input.parentId) {
    if (input.parentId === id) throw new BadRequestException("A page can't be its own parent");
    const parent = await repo.findParentId(db, input.parentId);
    if (!parent) throw new BadRequestException("Parent page does not exist");
    await assertNotDescendant(db, input.parentId, id);
  }

  const page = await repo.updatePage(db, id, {
    parentId: input.parentId ?? null,
    position: input.position,
    updatedById: viewer.id,
  });
  if (!page) throw new NotFoundException("Page not found");
  return page;
}

export async function remove(db: Db, id: string, viewer: DocsViewer) {
  const existing = await repo.findPageById(db, id);
  if (!existing) throw new NotFoundException("Page not found");
  const ok = await canAccess(db, id, viewer.id, "edit", viewer.isAdmin);
  if (!ok) throw new ForbiddenException("You don't have edit access to this page");
  await repo.deletePage(db, id);
}

export async function listVersions(db: Db, pageId: string, viewer: DocsViewer) {
  const ok = await canAccess(db, pageId, viewer.id, "read", viewer.isAdmin);
  if (!ok) throw new ForbiddenException("You don't have access to this page");
  return repo.findVersions(db, pageId);
}

export async function getVersion(db: Db, pageId: string, versionId: string, viewer: DocsViewer) {
  const ok = await canAccess(db, pageId, viewer.id, "read", viewer.isAdmin);
  if (!ok) throw new ForbiddenException("You don't have access to this page");
  const row = await repo.findVersionById(db, pageId, versionId);
  if (!row) throw new NotFoundException("Version not found");
  return row;
}

export async function restoreVersion(
  db: Db,
  pageId: string,
  versionId: string,
  viewer: DocsViewer,
) {
  const ok = await canAccess(db, pageId, viewer.id, "edit", viewer.isAdmin);
  if (!ok) throw new ForbiddenException("You don't have edit access to this page");
  const target = await repo.findVersionById(db, pageId, versionId);
  if (!target) throw new NotFoundException("Version not found");
  const existing = await repo.findPageById(db, pageId);
  if (!existing) throw new NotFoundException("Page not found");

  await snapshotVersion(db, existing, viewer.id);
  const page = await repo.updatePage(db, pageId, {
    title: target.title,
    body: target.body,
    updatedById: viewer.id,
  });
  if (!page) throw new NotFoundException("Page not found");
  return page;
}

export async function listPermissions(db: Db, pageId: string, viewer: DocsViewer) {
  const ok = await canAccess(db, pageId, viewer.id, "edit", viewer.isAdmin);
  if (!ok) throw new ForbiddenException("Only editors can view permissions");
  return repo.findPermissions(db, pageId);
}

export async function grantPermission(
  db: Db,
  pageId: string,
  input: WikiPagePermissionInput,
  viewer: DocsViewer,
) {
  const ok = await canAccess(db, pageId, viewer.id, "edit", viewer.isAdmin);
  if (!ok) throw new ForbiddenException("Only editors can grant permissions");
  const page = await repo.findPageById(db, pageId);
  if (!page) throw new NotFoundException("Page not found");
  const user = await repo.findUserById(db, input.userId);
  if (!user) throw new BadRequestException("User does not exist");
  const perm = await repo.upsertPagePermission(db, pageId, input.userId, input.level);
  if (!perm) throw new NotFoundException("Permission not found");
  return perm;
}

export async function revokePermission(
  db: Db,
  pageId: string,
  permissionId: string,
  viewer: DocsViewer,
) {
  const ok = await canAccess(db, pageId, viewer.id, "edit", viewer.isAdmin);
  if (!ok) throw new ForbiddenException("Only editors can revoke permissions");
  const existing = await repo.findPermissionById(db, pageId, permissionId);
  if (!existing) throw new NotFoundException("Permission not found");
  await repo.deletePermission(db, permissionId);
}
