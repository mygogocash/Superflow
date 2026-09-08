import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { PERMISSIONS } from "@nexora/contracts";
import {
  createQaProjectColumnSchema,
  createQaProjectSchema,
  createQaProjectTaskCommentSchema,
  createQaProjectTaskSchema,
  qaProjectQuerySchema,
  manageQaProjectMembersSchema,
  manageQaProjectTaskAssigneesSchema,
  reorderQaProjectsSchema,
  updateQaProjectColumnSchema,
  updateQaProjectSchema,
  updateQaProjectTaskSchema,
} from "@nexora/contracts/modules/qa-crm/qa-crm.validation";
import { qaCrmService, qaCrmWorkspaceService } from "@nexora/core";
import type { AppEnv } from "../lib/context";
import { requirePermission } from "../middleware/rbac";

const CRM_READ = [PERMISSIONS.QA_CRM_READ, PERMISSIONS.QA_CRM_READ_ALL, PERMISSIONS.PROJECTS_READ, PERMISSIONS.PROJECTS_READ_ALL] as const;

// Org-wide surfaces only — bare *:crm:read / projects:read are membership-scoped.
const CRM_ORG_READ = [
  PERMISSIONS.QA_CRM_READ_ALL,
  PERMISSIONS.QA_CRM_MANAGE,
  PERMISSIONS.PROJECTS_READ_ALL,
  PERMISSIONS.PROJECTS_MANAGE,
] as const;

const CRM_WRITE = [PERMISSIONS.QA_CRM_UPDATE, PERMISSIONS.QA_CRM_MANAGE, PERMISSIONS.PROJECTS_UPDATE, PERMISSIONS.PROJECTS_MANAGE] as const;

export const qaCrm = new Hono<AppEnv>()
  .get("/", requirePermission(...CRM_READ), zValidator("query", qaProjectQuerySchema), async (c) =>
    c.json(await qaCrmService.list(c.var.db, c.var.user!.id, c.var.user!.permissions, c.req.valid("query"))),
  )
  .post(
    "/",
    requirePermission(PERMISSIONS.QA_CRM_CREATE, PERMISSIONS.QA_CRM_MANAGE, PERMISSIONS.PROJECTS_CREATE),
    zValidator("json", createQaProjectSchema),
    async (c) => {
      const data = await qaCrmService.create(c.var.db, c.var.user!.id, c.req.valid("json"));
      return c.json({ data }, 201);
    },
  )
  .put(
    "/reorder",
    requirePermission(...CRM_WRITE),
    zValidator("json", reorderQaProjectsSchema),
    async (c) => c.json({ data: await qaCrmService.reorder(c.var.db, c.req.valid("json")) }),
  )
  .get("/dashboard", requirePermission(...CRM_ORG_READ), async (c) =>
    c.json({ data: await qaCrmService.dashboard(c.var.db) }),
  )
  .get("/reminder-settings", requirePermission(...CRM_ORG_READ), async (c) =>
    c.json({ data: await qaCrmService.getReminderRecipients(c.var.db) }),
  )
  .put(
    "/reminder-settings",
    requirePermission(PERMISSIONS.QA_CRM_MANAGE, PERMISSIONS.PROJECTS_MANAGE),
    zValidator("json", z.object({ recipients: z.array(z.string().email()) })),
    async (c) => c.json({ data: await qaCrmService.setReminderRecipients(c.var.db, c.req.valid("json")) }),
  )
  .get("/:id", requirePermission(...CRM_READ), async (c) =>
    c.json({
      data: await qaCrmService.getById(c.var.db, c.req.param("id"), c.var.user!.id, c.var.user!.permissions),
    }),
  )
  .put(
    "/:id",
    requirePermission(...CRM_READ, ...CRM_WRITE),
    zValidator("json", updateQaProjectSchema),
    async (c) =>
      c.json({
        data: await qaCrmService.update(
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
    requirePermission(...CRM_READ, PERMISSIONS.QA_CRM_DELETE, PERMISSIONS.QA_CRM_MANAGE, PERMISSIONS.PROJECTS_DELETE, PERMISSIONS.PROJECTS_MANAGE),
    async (c) => {
      await qaCrmService.remove(c.var.db, c.req.param("id"), c.var.user!.id, c.var.user!.permissions);
      return c.json({ data: { success: true } });
    },
  )
  .post("/:id/archive", requirePermission(...CRM_READ, ...CRM_WRITE), async (c) =>
    c.json({
      data: await qaCrmService.archive(c.var.db, c.req.param("id"), c.var.user!.id, c.var.user!.permissions),
    }),
  )
  .post("/:id/unarchive", requirePermission(...CRM_READ, ...CRM_WRITE), async (c) =>
    c.json({
      data: await qaCrmService.unarchive(c.var.db, c.req.param("id"), c.var.user!.id, c.var.user!.permissions),
    }),
  )
  .get("/:id/board", requirePermission(...CRM_READ), async (c) =>
    c.json({
      data: await qaCrmWorkspaceService.getBoard(
        c.var.db,
        c.req.param("id"),
        c.var.user!.id,
        c.var.user!.permissions,
      ),
    }),
  )
  .post(
    "/:id/tasks",
    requirePermission(...CRM_WRITE),
    zValidator("json", createQaProjectTaskSchema),
    async (c) => {
      const data = await qaCrmWorkspaceService.createTask(
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
    requirePermission(...CRM_WRITE),
    zValidator("json", updateQaProjectTaskSchema),
    async (c) =>
      c.json({
        data: await qaCrmWorkspaceService.updateTask(
          c.var.db,
          c.req.param("id"),
          c.req.param("taskId"),
          c.var.user!.id,
          c.var.user!.permissions,
          c.req.valid("json"),
        ),
      }),
  )
  .delete("/:id/tasks/:taskId", requirePermission(...CRM_WRITE), async (c) => {
    await qaCrmWorkspaceService.deleteTask(
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
    requirePermission(...CRM_WRITE),
    zValidator("json", createQaProjectColumnSchema),
    async (c) => {
      const data = await qaCrmWorkspaceService.createColumn(
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
    requirePermission(...CRM_WRITE),
    zValidator("json", updateQaProjectColumnSchema),
    async (c) =>
      c.json({
        data: await qaCrmWorkspaceService.updateColumn(
          c.var.db,
          c.req.param("id"),
          c.req.param("columnId"),
          c.var.user!.id,
          c.var.user!.permissions,
          c.req.valid("json"),
        ),
      }),
  )
  .delete("/:id/columns/:columnId", requirePermission(...CRM_WRITE), async (c) => {
    await qaCrmWorkspaceService.deleteColumn(
      c.var.db,
      c.req.param("id"),
      c.req.param("columnId"),
      c.var.user!.id,
      c.var.user!.permissions,
    );
    return c.json({ data: { success: true } });
  })
  .get("/:id/members", requirePermission(...CRM_READ), async (c) =>
    c.json({
      data: await qaCrmWorkspaceService.listMembers(
        c.var.db,
        c.req.param("id"),
        c.var.user!.id,
        c.var.user!.permissions,
      ),
    }),
  )
  .put(
    "/:id/members",
    requirePermission(...CRM_WRITE),
    zValidator("json", manageQaProjectMembersSchema),
    async (c) =>
      c.json({
        data: await qaCrmWorkspaceService.setMembers(
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
    requirePermission(...CRM_WRITE),
    zValidator("json", createQaProjectTaskCommentSchema),
    async (c) => {
      const data = await qaCrmWorkspaceService.createTaskComment(
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
    requirePermission(...CRM_WRITE),
    zValidator("json", manageQaProjectTaskAssigneesSchema),
    async (c) =>
      c.json({
        data: await qaCrmWorkspaceService.setTaskAssignees(
          c.var.db,
          c.req.param("id"),
          c.req.param("taskId"),
          c.var.user!.id,
          c.var.user!.permissions,
          c.req.valid("json"),
        ),
      }),
  );
