import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { PERMISSIONS } from "@nexora/contracts";
import {
  assignRolesSchema,
  listUsersQuerySchema,
  updateUserSchema,
} from "@nexora/contracts/modules/users/users.validation";
import { usersService } from "@nexora/core";
import type { AppEnv } from "../lib/context";
import { invalidateUserPermissions } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";

function notImplemented(message: string) {
  return (c: { json: (body: unknown, status?: number) => Response }) =>
    c.json({ error: { code: "NOT_IMPLEMENTED", message } }, 501);
}

export const users = new Hono<AppEnv>()
  .get("/", requirePermission(PERMISSIONS.USER_READ), zValidator("query", listUsersQuerySchema), async (c) =>
    c.json(await usersService.list(c.var.db, c.req.valid("query"), c.var.user!.id)),
  )
  .get("/stats", requirePermission(PERMISSIONS.USER_READ), async (c) =>
    c.json(await usersService.stats(c.var.db)),
  )
  .get("/form-lookups", requirePermission(PERMISSIONS.USER_READ), async (c) =>
    c.json(await usersService.getFormLookups(c.var.db)),
  )
  .get("/unactivated", requirePermission(PERMISSIONS.USER_UPDATE), notImplemented("Unactivated user list requires Supabase Auth on edge"))
  .post("/resend-invites", requirePermission(PERMISSIONS.USER_UPDATE), notImplemented("Resend invites requires Supabase Auth on edge"))
  .post("/", requirePermission(PERMISSIONS.USER_CREATE), notImplemented("User creation requires Supabase Auth on edge"))
  .get("/import-template", requirePermission(PERMISSIONS.USER_CREATE), notImplemented("Import template download is not available on edge yet"))
  .post("/bulk-import", requirePermission(PERMISSIONS.USER_CREATE), notImplemented("Bulk import is not available on edge yet"))
  .get("/:id", requirePermission(PERMISSIONS.USER_READ), async (c) =>
    c.json(await usersService.getById(c.var.db, c.req.param("id"))),
  )
  .put(
    "/:id",
    requirePermission(PERMISSIONS.USER_UPDATE),
    zValidator("json", updateUserSchema),
    async (c) =>
      c.json(await usersService.update(c.var.db, c.req.param("id"), c.req.valid("json"), c.var.user!.id)),
  )
  .delete("/:id", requirePermission(PERMISSIONS.USER_DELETE), async (c) =>
    c.json(await usersService.remove(c.var.db, c.req.param("id"), c.var.user!.id)),
  )
  .post("/:id/reset-password", requirePermission(PERMISSIONS.USER_UPDATE), notImplemented("Password reset requires Supabase Auth on edge"))
  .put(
    "/:id/roles",
    requirePermission(PERMISSIONS.USER_ASSIGN_ROLE),
    zValidator("json", assignRolesSchema),
    async (c) => {
      const userId = c.req.param("id");
      const result = await usersService.assignRoles(
        c.var.db,
        userId,
        c.req.valid("json"),
        c.var.user!.id,
      );
      // Drop the 60s RBAC KV entry so the next request sees the new roles.
      c.executionCtx.waitUntil(invalidateUserPermissions(c.env.KV_CACHE, userId));
      return c.json(result);
    },
  )
  .post("/:id/restore", requirePermission(PERMISSIONS.USER_DELETE), async (c) =>
    c.json(await usersService.restore(c.var.db, c.req.param("id"), c.var.user!.id)),
  )
  .delete("/:id/permanent", requirePermission(PERMISSIONS.USER_DELETE), notImplemented("Permanent delete requires Supabase cleanup on edge"));
