import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { PERMISSIONS } from "@nexora/contracts";
import {
  createWikiPageSchema,
  extractWikiAttachmentSchema,
  listWikiPagesSchema,
  moveWikiPageSchema,
  updateWikiPageSchema,
  wikiPagePermissionSchema,
} from "@nexora/contracts/modules/docs/docs.validation";
import { docsService, HttpException } from "@nexora/core";
import type { AppEnv } from "../lib/context";
import { requirePermission } from "../middleware/rbac";

function viewerOf(c: { var: AppEnv["Variables"] }) {
  const user = c.var.user!;
  const permissions = user.permissions ?? [];
  return {
    id: user.id,
    isAdmin: user.isSystemAdmin,
    canSeeUnpublished:
      permissions.includes(PERMISSIONS.DOCS_CREATE) ||
      permissions.includes(PERMISSIONS.DOCS_UPDATE),
  };
}

export const docs = new Hono<AppEnv>()
  .post(
    "/extract",
    requirePermission(PERMISSIONS.DOCS_CREATE, PERMISSIONS.DOCS_UPDATE),
    zValidator("json", extractWikiAttachmentSchema),
    () => {
      throw new HttpException(501, "NOT_IMPLEMENTED", "extract not available on edge yet");
    },
  )
  .get("/tree", requirePermission(PERMISSIONS.DOCS_READ), async (c) => {
    const includeUnpublished = c.req.query("includeUnpublished") === "true";
    const data = await docsService.tree(c.var.db, viewerOf(c), includeUnpublished);
    return c.json({ data });
  })
  .get("/", requirePermission(PERMISSIONS.DOCS_READ), zValidator("query", listWikiPagesSchema), async (c) => {
    const result = await docsService.list(c.var.db, c.req.valid("query"), viewerOf(c));
    return c.json(result);
  })
  .post("/", requirePermission(PERMISSIONS.DOCS_CREATE), zValidator("json", createWikiPageSchema), async (c) => {
    const data = await docsService.create(c.var.db, c.req.valid("json"), c.var.user!.id);
    return c.json({ data }, 201);
  })
  .get("/:id/versions", requirePermission(PERMISSIONS.DOCS_READ), async (c) => {
    const data = await docsService.listVersions(c.var.db, c.req.param("id"), viewerOf(c));
    return c.json({ data });
  })
  .get("/:id/versions/:versionId", requirePermission(PERMISSIONS.DOCS_READ), async (c) => {
    const data = await docsService.getVersion(
      c.var.db,
      c.req.param("id"),
      c.req.param("versionId"),
      viewerOf(c),
    );
    return c.json({ data });
  })
  .post(
    "/:id/versions/:versionId/restore",
    requirePermission(PERMISSIONS.DOCS_UPDATE),
    async (c) => {
      const data = await docsService.restoreVersion(
        c.var.db,
        c.req.param("id"),
        c.req.param("versionId"),
        viewerOf(c),
      );
      return c.json({ data });
    },
  )
  .post(
    "/:id/move",
    requirePermission(PERMISSIONS.DOCS_UPDATE),
    zValidator("json", moveWikiPageSchema),
    async (c) => {
      const data = await docsService.move(c.var.db, c.req.param("id"), c.req.valid("json"), viewerOf(c));
      return c.json({ data });
    },
  )
  .get("/:id/permissions", requirePermission(PERMISSIONS.DOCS_UPDATE), async (c) => {
    const data = await docsService.listPermissions(c.var.db, c.req.param("id"), viewerOf(c));
    return c.json({ data });
  })
  .post(
    "/:id/permissions",
    requirePermission(PERMISSIONS.DOCS_UPDATE),
    zValidator("json", wikiPagePermissionSchema),
    async (c) => {
      const data = await docsService.grantPermission(
        c.var.db,
        c.req.param("id"),
        c.req.valid("json"),
        viewerOf(c),
      );
      return c.json({ data }, 201);
    },
  )
  .delete("/:id/permissions/:permissionId", requirePermission(PERMISSIONS.DOCS_UPDATE), async (c) => {
    await docsService.revokePermission(
      c.var.db,
      c.req.param("id"),
      c.req.param("permissionId"),
      viewerOf(c),
    );
    return c.json({ data: { success: true } });
  })
  .get("/:idOrSlug", requirePermission(PERMISSIONS.DOCS_READ), async (c) => {
    const data = await docsService.getByIdOrSlug(c.var.db, c.req.param("idOrSlug"), viewerOf(c));
    return c.json({ data });
  })
  .put("/:id", requirePermission(PERMISSIONS.DOCS_UPDATE), zValidator("json", updateWikiPageSchema), async (c) => {
    const data = await docsService.update(c.var.db, c.req.param("id"), c.req.valid("json"), viewerOf(c));
    return c.json({ data });
  })
  .delete("/:id", requirePermission(PERMISSIONS.DOCS_DELETE), async (c) => {
    await docsService.remove(c.var.db, c.req.param("id"), viewerOf(c));
    return c.json({ data: { success: true } });
  });
