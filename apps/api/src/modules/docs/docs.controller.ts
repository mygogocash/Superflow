import { Router } from "express";

import { PERMISSIONS } from "@/common/constants/permissions";
import { getRequiredParam } from "@/common/utils/params";
import {
  authenticate,
  requireActive,
  requirePermission,
} from "@/core/guards/auth.guard";
import { asyncHandler } from "@/core/middleware/async-handler";
import { prisma } from "@/infrastructure/database/prisma";
import { docsService } from "@/modules/docs/docs.service";
import {
  createWikiPageSchema,
  extractWikiAttachmentSchema,
  listWikiPagesSchema,
  moveWikiPageSchema,
  updateWikiPageSchema,
  wikiPagePermissionSchema,
} from "@/modules/docs/docs.validation";
import { extractWikiFromAttachment } from "@/modules/docs/docs-extract.service";

const router = Router();

router.use(authenticate, requireActive);

/**
 * System admins (seeded "Admin" role) bypass page-level perms — same
 * pattern as auth.service.ts. Custom roles holding `docs:read` etc.
 * are *not* admins for this purpose; they go through the per-page ACL
 * when isRestricted.
 *
 * AuthUser doesn't carry the role list, so we resolve it on demand.
 * One small query per docs request — acceptable given how rarely the
 * docs routes are hit.
 */
async function viewerOf(req: Express.Request): Promise<{
  id: string;
  isAdmin: boolean;
  canSeeUnpublished: boolean;
}> {
  const id = req.user!.id;
  const permissions = req.user!.permissions ?? [];
  const userRoles = await prisma.userRole.findMany({
    where: { userId: id },
    include: { role: { select: { isSystem: true, name: true } } },
  });
  const isAdmin = userRoles.some(
    (ur) => ur.role.isSystem && ur.role.name === "Admin",
  );
  const canSeeUnpublished =
    isAdmin ||
    permissions.includes(PERMISSIONS.DOCS_CREATE) ||
    permissions.includes(PERMISSIONS.DOCS_UPDATE);
  return { id, isAdmin, canSeeUnpublished };
}

// ── AI auto-fill from an uploaded attachment ────────────────────

router.post(
  "/extract",
  requirePermission(PERMISSIONS.DOCS_CREATE, PERMISSIONS.DOCS_UPDATE),
  asyncHandler(async (req, res) => {
    const input = extractWikiAttachmentSchema.parse(req.body);
    const data = await extractWikiFromAttachment(input.url, input.mimeType);
    res.json({ data });
  }),
);

// ── Tree route — must come before "/:id" ───────────────────────

router.get(
  "/tree",
  requirePermission(PERMISSIONS.DOCS_READ),
  asyncHandler(async (req, res) => {
    const includeUnpublished = req.query.includeUnpublished === "true";
    const data = await docsService.tree(
      await viewerOf(req),
      includeUnpublished,
    );
    res.json({ data });
  }),
);

// ── Standard CRUD ──────────────────────────────────────────────

router.get(
  "/",
  requirePermission(PERMISSIONS.DOCS_READ),
  asyncHandler(async (req, res) => {
    const query = listWikiPagesSchema.parse(req.query);
    const result = await docsService.list(query, await viewerOf(req));
    res.json(result);
  }),
);

router.post(
  "/",
  requirePermission(PERMISSIONS.DOCS_CREATE),
  asyncHandler(async (req, res) => {
    const input = createWikiPageSchema.parse(req.body);
    const data = await docsService.create(input, req.user!.id);
    res.status(201).json({ data });
  }),
);

// ── Per-page nested routes — literal paths first ───────────────

router.get(
  "/:id/versions",
  requirePermission(PERMISSIONS.DOCS_READ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await docsService.listVersions(id, await viewerOf(req));
    res.json({ data });
  }),
);

router.get(
  "/:id/versions/:versionId",
  requirePermission(PERMISSIONS.DOCS_READ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const versionId = getRequiredParam(req.params, "versionId");
    const data = await docsService.getVersion(
      id,
      versionId,
      await viewerOf(req),
    );
    res.json({ data });
  }),
);

router.post(
  "/:id/versions/:versionId/restore",
  requirePermission(PERMISSIONS.DOCS_UPDATE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const versionId = getRequiredParam(req.params, "versionId");
    const data = await docsService.restoreVersion(
      id,
      versionId,
      await viewerOf(req),
    );
    res.json({ data });
  }),
);

router.post(
  "/:id/move",
  requirePermission(PERMISSIONS.DOCS_UPDATE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = moveWikiPageSchema.parse(req.body);
    const data = await docsService.move(id, input, await viewerOf(req));
    res.json({ data });
  }),
);

router.get(
  "/:id/permissions",
  requirePermission(PERMISSIONS.DOCS_UPDATE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await docsService.listPermissions(id, await viewerOf(req));
    res.json({ data });
  }),
);

router.post(
  "/:id/permissions",
  requirePermission(PERMISSIONS.DOCS_UPDATE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = wikiPagePermissionSchema.parse(req.body);
    const data = await docsService.grantPermission(
      id,
      input,
      await viewerOf(req),
    );
    res.status(201).json({ data });
  }),
);

router.delete(
  "/:id/permissions/:permissionId",
  requirePermission(PERMISSIONS.DOCS_UPDATE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const permissionId = getRequiredParam(req.params, "permissionId");
    await docsService.revokePermission(id, permissionId, await viewerOf(req));
    res.json({ data: { success: true } });
  }),
);

// ── Generic /:idOrSlug routes — must come last ────────────────

router.get(
  "/:idOrSlug",
  requirePermission(PERMISSIONS.DOCS_READ),
  asyncHandler(async (req, res) => {
    const idOrSlug = getRequiredParam(req.params, "idOrSlug");
    const data = await docsService.getByIdOrSlug(idOrSlug, await viewerOf(req));
    res.json({ data });
  }),
);

router.put(
  "/:id",
  requirePermission(PERMISSIONS.DOCS_UPDATE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = updateWikiPageSchema.parse(req.body);
    const data = await docsService.update(id, input, await viewerOf(req));
    res.json({ data });
  }),
);

router.delete(
  "/:id",
  requirePermission(PERMISSIONS.DOCS_DELETE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    await docsService.delete(id, await viewerOf(req));
    res.json({ data: { success: true } });
  }),
);

export default router;
