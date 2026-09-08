import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { PERMISSIONS } from "@nexora/contracts";
import {
  createDepartmentSchema,
  createUserGroupSchema,
  manageGroupMembersSchema,
  updateDepartmentSchema,
  updateModuleAccessSchema,
  updateSettingsSchema,
  updateUserGroupSchema,
} from "@nexora/contracts/modules/admin/admin.validation";
import { adminService } from "@nexora/core";
import type { AppEnv } from "../lib/context";
import { requirePermission } from "../middleware/rbac";

export const admin = new Hono<AppEnv>()
  .get("/audit-log", requirePermission(PERMISSIONS.ADMIN_AUDIT_LOG), async (c) => {
    const page = Math.max(1, Number(c.req.query("page")) || 1);
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 50));
    const resource = c.req.query("resource") || undefined;
    const userId = c.req.query("userId") || undefined;
    const action = c.req.query("action") || undefined;
    return c.json(await adminService.listAuditLogs(c.var.db, page, limit, { resource, userId, action }));
  })
  .get("/settings", requirePermission(PERMISSIONS.ADMIN_MANAGE), async (c) =>
    c.json({ data: await adminService.getSettings(c.var.db) }),
  )
  .put(
    "/settings",
    requirePermission(PERMISSIONS.ADMIN_MANAGE),
    zValidator("json", updateSettingsSchema),
    async (c) =>
      c.json({
        data: await adminService.updateSettings(c.var.db, c.req.valid("json"), {
          isSystemAdmin: c.var.user!.isSystemAdmin,
        }),
      }),
  )
  .get("/entities", requirePermission(PERMISSIONS.ADMIN_READ, PERMISSIONS.USER_READ), async (c) =>
    c.json(await adminService.listEntities(c.var.db)),
  )
  .get("/module-access/:userId", requirePermission(PERMISSIONS.ADMIN_MANAGE), async (c) =>
    c.json(await adminService.getModuleAccess(c.var.db, c.req.param("userId"), c.var.user!.id)),
  )
  .put(
    "/module-access",
    requirePermission(PERMISSIONS.ADMIN_MANAGE),
    zValidator("json", updateModuleAccessSchema),
    async (c) =>
      c.json(await adminService.updateModuleAccess(c.var.db, c.req.valid("json"), c.var.user!.id)),
  )
  .get("/user-groups", requirePermission(PERMISSIONS.ADMIN_READ), async (c) =>
    c.json(await adminService.listUserGroups(c.var.db)),
  )
  .post(
    "/user-groups",
    requirePermission(PERMISSIONS.ADMIN_MANAGE),
    zValidator("json", createUserGroupSchema),
    async (c) =>
      c.json(
        { data: await adminService.createUserGroup(c.var.db, c.req.valid("json"), c.var.user!.id) },
        201,
      ),
  )
  .get("/user-groups/:id", requirePermission(PERMISSIONS.ADMIN_READ), async (c) =>
    c.json({ data: await adminService.getUserGroup(c.var.db, c.req.param("id")) }),
  )
  .put(
    "/user-groups/:id",
    requirePermission(PERMISSIONS.ADMIN_MANAGE),
    zValidator("json", updateUserGroupSchema),
    async (c) =>
      c.json({ data: await adminService.updateUserGroup(c.var.db, c.req.param("id"), c.req.valid("json")) }),
  )
  .delete("/user-groups/:id", requirePermission(PERMISSIONS.ADMIN_MANAGE), async (c) => {
    await adminService.deleteUserGroup(c.var.db, c.req.param("id"));
    return c.json({ data: { success: true } });
  })
  .post(
    "/user-groups/:id/members",
    requirePermission(PERMISSIONS.ADMIN_MANAGE),
    zValidator("json", manageGroupMembersSchema),
    async (c) =>
      c.json({
        data: await adminService.addGroupMembers(
          c.var.db,
          c.req.param("id"),
          c.req.valid("json"),
          c.var.user!.id,
        ),
      }),
  )
  .delete(
    "/user-groups/:id/members",
    requirePermission(PERMISSIONS.ADMIN_MANAGE),
    zValidator("json", manageGroupMembersSchema),
    async (c) =>
      c.json({
        data: await adminService.removeGroupMembers(c.var.db, c.req.param("id"), c.req.valid("json")),
      }),
  )
  .get("/departments", requirePermission(PERMISSIONS.ADMIN_READ, PERMISSIONS.ADMIN_MANAGE), async (c) =>
    c.json(await adminService.listDepartments(c.var.db)),
  )
  .post(
    "/departments",
    requirePermission(PERMISSIONS.ADMIN_MANAGE),
    zValidator("json", createDepartmentSchema),
    async (c) => c.json(await adminService.createDepartment(c.var.db, c.req.valid("json")), 201),
  )
  .put(
    "/departments/:id",
    requirePermission(PERMISSIONS.ADMIN_MANAGE),
    zValidator("json", updateDepartmentSchema),
    async (c) =>
      c.json(await adminService.updateDepartment(c.var.db, c.req.param("id"), c.req.valid("json"))),
  )
  .delete("/departments/:id", requirePermission(PERMISSIONS.ADMIN_MANAGE), async (c) => {
    await adminService.deleteDepartment(c.var.db, c.req.param("id"));
    return c.json({ data: { success: true } });
  });
