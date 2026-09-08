import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { PERMISSIONS } from "@nexora/contracts";
import {
  createItProjectColumnSchema,
  createItProjectSchema,
  createItProjectTaskCommentSchema,
  createItProjectTaskSchema,
  importItProjectsSchema,
  itProjectQuerySchema,
  manageItProjectMembersSchema,
  manageItProjectTaskAssigneesSchema,
  reminderSettingsSchema,
  reorderItProjectsSchema,
  updateItProjectColumnSchema,
  updateItProjectSchema,
  updateItProjectTaskSchema,
} from "@nexora/contracts/modules/it-crm/it-crm.validation";
import { itCrmService, itCrmWorkspaceService } from "@nexora/core";
import type { AppEnv } from "../lib/context";
import { requirePermission } from "../middleware/rbac";

const IT_READ = [
  PERMISSIONS.IT_CRM_READ,
  PERMISSIONS.IT_CRM_READ_ALL,
  PERMISSIONS.PROJECTS_READ,
  PERMISSIONS.PROJECTS_READ_ALL,
] as const;

// Org-wide surfaces only — bare *:crm:read / projects:read are membership-scoped.
const IT_ORG_READ = [
  PERMISSIONS.IT_CRM_READ_ALL,
  PERMISSIONS.IT_CRM_MANAGE,
  PERMISSIONS.PROJECTS_READ_ALL,
  PERMISSIONS.PROJECTS_MANAGE,
] as const;

const IT_WRITE = [
  PERMISSIONS.IT_CRM_UPDATE,
  PERMISSIONS.IT_CRM_MANAGE,
  PERMISSIONS.PROJECTS_UPDATE,
  PERMISSIONS.PROJECTS_MANAGE,
] as const;

export const itCrm = new Hono<AppEnv>()
  .get("/", requirePermission(...IT_READ), zValidator("query", itProjectQuerySchema), async (c) =>
    c.json(await itCrmService.list(c.var.db, c.var.user!.id, c.var.user!.permissions, c.req.valid("query"))),
  )
  .post(
    "/",
    requirePermission(PERMISSIONS.IT_CRM_CREATE, PERMISSIONS.IT_CRM_MANAGE, PERMISSIONS.PROJECTS_CREATE),
    zValidator("json", createItProjectSchema),
    async (c) => {
      const data = await itCrmService.create(c.var.db, c.var.user!.id, c.req.valid("json"));
      return c.json({ data }, 201);
    },
  )
  .post(
    "/import",
    requirePermission(PERMISSIONS.IT_CRM_CREATE, PERMISSIONS.IT_CRM_MANAGE, PERMISSIONS.PROJECTS_CREATE),
    zValidator("json", importItProjectsSchema),
    async (c) => {
      const data = await itCrmService.importRows(c.var.db, c.var.user!.id, c.req.valid("json").rows);
      return c.json({ data }, 201);
    },
  )
  .put(
    "/reorder",
    requirePermission(...IT_WRITE),
    zValidator("json", reorderItProjectsSchema),
    async (c) => c.json({ data: await itCrmService.reorder(c.var.db, c.req.valid("json")) }),
  )
  .get("/dashboard", requirePermission(...IT_ORG_READ), async (c) =>
    c.json({ data: await itCrmService.dashboard(c.var.db) }),
  )
  .get("/reminder-settings", requirePermission(...IT_ORG_READ), async (c) =>
    c.json({ data: await itCrmService.getReminderRecipients(c.var.db) }),
  )
  .put(
    "/reminder-settings",
    requirePermission(PERMISSIONS.IT_CRM_MANAGE, PERMISSIONS.PROJECTS_MANAGE),
    zValidator("json", reminderSettingsSchema),
    async (c) => c.json({ data: await itCrmService.setReminderRecipients(c.var.db, c.req.valid("json")) }),
  )
  .get("/:id", requirePermission(...IT_READ), async (c) =>
    c.json({
      data: await itCrmService.getById(c.var.db, c.req.param("id"), c.var.user!.id, c.var.user!.permissions),
    }),
  )
  .put(
    "/:id",
    requirePermission(...IT_READ, ...IT_WRITE),
    zValidator("json", updateItProjectSchema),
    async (c) =>
      c.json({
        data: await itCrmService.update(
          c.var.db,
          c.req.param("id"),
          c.var.user!.id,
          c.var.user!.permissions,
          c.req.valid("json"),
        ),
      }),
  )
  .delete(
    "/:id",
    requirePermission(
      ...IT_READ,
      PERMISSIONS.IT_CRM_DELETE,
      PERMISSIONS.IT_CRM_MANAGE,
      PERMISSIONS.PROJECTS_DELETE,
      PERMISSIONS.PROJECTS_MANAGE,
    ),
    async (c) => {
      await itCrmService.remove(c.var.db, c.req.param("id"), c.var.user!.id, c.var.user!.permissions);
      return c.json({ data: { success: true } });
    },
  )
  .post("/:id/archive", requirePermission(...IT_READ, ...IT_WRITE), async (c) =>
    c.json({
      data: await itCrmService.archive(c.var.db, c.req.param("id"), c.var.user!.id, c.var.user!.permissions),
    }),
  )
  .post("/:id/unarchive", requirePermission(...IT_READ, ...IT_WRITE), async (c) =>
    c.json({
      data: await itCrmService.unarchive(c.var.db, c.req.param("id"), c.var.user!.id, c.var.user!.permissions),
    }),
  )
  .get("/:id/board", requirePermission(...IT_READ), async (c) =>
    c.json({
      data: await itCrmWorkspaceService.getBoard(
        c.var.db,
        c.req.param("id"),
        c.var.user!.id,
        c.var.user!.permissions,
      ),
    }),
  )
  .post(
    "/:id/tasks",
    requirePermission(...IT_WRITE),
    zValidator("json", createItProjectTaskSchema),
    async (c) => {
      const data = await itCrmWorkspaceService.createTask(
        c.var.db,
        c.req.param("id"),
        c.var.user!.id,
        c.var.user!.permissions,
        c.req.valid("json"),
      );
      return c.json({ data }, 201);
    },
  )
  .put(
    "/:id/tasks/:taskId",
    requirePermission(...IT_WRITE),
    zValidator("json", updateItProjectTaskSchema),
    async (c) =>
      c.json({
        data: await itCrmWorkspaceService.updateTask(
          c.var.db,
          c.req.param("id"),
          c.req.param("taskId"),
          c.var.user!.id,
          c.var.user!.permissions,
          c.req.valid("json"),
        ),
      }),
  )
  .delete("/:id/tasks/:taskId", requirePermission(...IT_WRITE), async (c) => {
    await itCrmWorkspaceService.deleteTask(
      c.var.db,
      c.req.param("id"),
      c.req.param("taskId"),
      c.var.user!.id,
      c.var.user!.permissions,
    );
    return c.json({ data: { success: true } });
  })
  .post(
    "/:id/columns",
    requirePermission(...IT_WRITE),
    zValidator("json", createItProjectColumnSchema),
    async (c) => {
      const data = await itCrmWorkspaceService.createColumn(
        c.var.db,
        c.req.param("id"),
        c.var.user!.id,
        c.var.user!.permissions,
        c.req.valid("json"),
      );
      return c.json({ data }, 201);
    },
  )
  .put(
    "/:id/columns/:columnId",
    requirePermission(...IT_WRITE),
    zValidator("json", updateItProjectColumnSchema),
    async (c) =>
      c.json({
        data: await itCrmWorkspaceService.updateColumn(
          c.var.db,
          c.req.param("id"),
          c.req.param("columnId"),
          c.var.user!.id,
          c.var.user!.permissions,
          c.req.valid("json"),
        ),
      }),
  )
  .delete("/:id/columns/:columnId", requirePermission(...IT_WRITE), async (c) => {
    await itCrmWorkspaceService.deleteColumn(
      c.var.db,
      c.req.param("id"),
      c.req.param("columnId"),
      c.var.user!.id,
      c.var.user!.permissions,
    );
    return c.json({ data: { success: true } });
  })
  .get("/:id/members", requirePermission(...IT_READ), async (c) =>
    c.json({
      data: await itCrmWorkspaceService.listMembers(
        c.var.db,
        c.req.param("id"),
        c.var.user!.id,
        c.var.user!.permissions,
      ),
    }),
  )
  .put(
    "/:id/members",
    requirePermission(...IT_WRITE),
    zValidator("json", manageItProjectMembersSchema),
    async (c) =>
      c.json({
        data: await itCrmWorkspaceService.setMembers(
          c.var.db,
          c.req.param("id"),
          c.var.user!.id,
          c.var.user!.permissions,
          c.req.valid("json"),
        ),
      }),
  )
  .post(
    "/:id/tasks/:taskId/comments",
    requirePermission(...IT_WRITE),
    zValidator("json", createItProjectTaskCommentSchema),
    async (c) => {
      const data = await itCrmWorkspaceService.createTaskComment(
        c.var.db,
        c.req.param("id"),
        c.req.param("taskId"),
        c.var.user!.id,
        c.var.user!.permissions,
        c.req.valid("json"),
      );
      return c.json({ data }, 201);
    },
  )
  .put(
    "/:id/tasks/:taskId/assignees",
    requirePermission(...IT_WRITE),
    zValidator("json", manageItProjectTaskAssigneesSchema),
    async (c) =>
      c.json({
        data: await itCrmWorkspaceService.setTaskAssignees(
          c.var.db,
          c.req.param("id"),
          c.req.param("taskId"),
          c.var.user!.id,
          c.var.user!.permissions,
          c.req.valid("json"),
        ),
      }),
  );
