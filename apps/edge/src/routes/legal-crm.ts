import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { PERMISSIONS } from "@nexora/contracts";
import {
  createLegalProjectColumnSchema,
  createLegalProjectSchema,
  createLegalProjectTaskCommentSchema,
  createLegalProjectTaskSchema,
  importLegalProjectsSchema,
  legalProjectQuerySchema,
  manageLegalProjectMembersSchema,
  manageLegalProjectTaskAssigneesSchema,
  reorderLegalProjectsSchema,
  updateLegalProjectColumnSchema,
  updateLegalProjectSchema,
  updateLegalProjectTaskSchema,
} from "@nexora/contracts/modules/legal-crm/legal-crm.validation";
import { legalCrmService, legalCrmWorkspaceService } from "@nexora/core";
import type { AppEnv } from "../lib/context";
import { requirePermission } from "../middleware/rbac";

const CRM_READ = [PERMISSIONS.LEGAL_CRM_READ, PERMISSIONS.LEGAL_CRM_READ_ALL, PERMISSIONS.PROJECTS_READ, PERMISSIONS.PROJECTS_READ_ALL] as const;

// Org-wide surfaces only — bare *:crm:read / projects:read are membership-scoped.
const CRM_ORG_READ = [
  PERMISSIONS.LEGAL_CRM_READ_ALL,
  PERMISSIONS.LEGAL_CRM_MANAGE,
  PERMISSIONS.PROJECTS_READ_ALL,
  PERMISSIONS.PROJECTS_MANAGE,
] as const;

const CRM_WRITE = [PERMISSIONS.LEGAL_CRM_UPDATE, PERMISSIONS.LEGAL_CRM_MANAGE, PERMISSIONS.PROJECTS_UPDATE, PERMISSIONS.PROJECTS_MANAGE] as const;

export const legalCrm = new Hono<AppEnv>()
  .get("/", requirePermission(...CRM_READ), zValidator("query", legalProjectQuerySchema), async (c) =>
    c.json(await legalCrmService.list(c.var.db, c.var.user!.id, c.var.user!.permissions, c.req.valid("query"))),
  )
  .post(
    "/",
    requirePermission(PERMISSIONS.LEGAL_CRM_CREATE, PERMISSIONS.LEGAL_CRM_MANAGE, PERMISSIONS.PROJECTS_CREATE),
    zValidator("json", createLegalProjectSchema),
    async (c) => {
      const data = await legalCrmService.create(c.var.db, c.var.user!.id, c.req.valid("json"));
      return c.json({ data }, 201);
    },
  )
  .post(
    "/import",
    requirePermission(PERMISSIONS.LEGAL_CRM_CREATE, PERMISSIONS.LEGAL_CRM_MANAGE, PERMISSIONS.PROJECTS_CREATE),
    zValidator("json", importLegalProjectsSchema),
    async (c) => {
      const data = await legalCrmService.importRows(c.var.db, c.var.user!.id, c.req.valid("json").rows);
      return c.json({ data }, 201);
    },
  )
  .put(
    "/reorder",
    requirePermission(...CRM_WRITE),
    zValidator("json", reorderLegalProjectsSchema),
    async (c) => c.json({ data: await legalCrmService.reorder(c.var.db, c.req.valid("json")) }),
  )
  .get("/dashboard", requirePermission(...CRM_ORG_READ), async (c) =>
    c.json({ data: await legalCrmService.dashboard(c.var.db) }),
  )
  .get("/reminder-settings", requirePermission(...CRM_ORG_READ), async (c) =>
    c.json({ data: await legalCrmService.getReminderRecipients(c.var.db) }),
  )
  .put(
    "/reminder-settings",
    requirePermission(PERMISSIONS.LEGAL_CRM_MANAGE, PERMISSIONS.PROJECTS_MANAGE),
    zValidator("json", z.object({ recipients: z.array(z.string().email()) })),
    async (c) => c.json({ data: await legalCrmService.setReminderRecipients(c.var.db, c.req.valid("json")) }),
  )
  .get("/:id", requirePermission(...CRM_READ), async (c) =>
    c.json({
      data: await legalCrmService.getById(c.var.db, c.req.param("id"), c.var.user!.id, c.var.user!.permissions),
    }),
  )
  .put(
    "/:id",
    requirePermission(...CRM_READ, ...CRM_WRITE),
    zValidator("json", updateLegalProjectSchema),
    async (c) =>
      c.json({
        data: await legalCrmService.update(
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
    requirePermission(...CRM_READ, PERMISSIONS.LEGAL_CRM_DELETE, PERMISSIONS.LEGAL_CRM_MANAGE, PERMISSIONS.PROJECTS_DELETE, PERMISSIONS.PROJECTS_MANAGE),
    async (c) => {
      await legalCrmService.remove(c.var.db, c.req.param("id"), c.var.user!.id, c.var.user!.permissions);
      return c.json({ data: { success: true } });
    },
  )
  .post("/:id/archive", requirePermission(...CRM_READ, ...CRM_WRITE), async (c) =>
    c.json({
      data: await legalCrmService.archive(c.var.db, c.req.param("id"), c.var.user!.id, c.var.user!.permissions),
    }),
  )
  .post("/:id/unarchive", requirePermission(...CRM_READ, ...CRM_WRITE), async (c) =>
    c.json({
      data: await legalCrmService.unarchive(c.var.db, c.req.param("id"), c.var.user!.id, c.var.user!.permissions),
    }),
  )
  .get("/:id/board", requirePermission(...CRM_READ), async (c) =>
    c.json({
      data: await legalCrmWorkspaceService.getBoard(
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
    zValidator("json", createLegalProjectTaskSchema),
    async (c) => {
      const data = await legalCrmWorkspaceService.createTask(
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
    zValidator("json", updateLegalProjectTaskSchema),
    async (c) =>
      c.json({
        data: await legalCrmWorkspaceService.updateTask(
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
    await legalCrmWorkspaceService.deleteTask(
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
    zValidator("json", createLegalProjectColumnSchema),
    async (c) => {
      const data = await legalCrmWorkspaceService.createColumn(
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
    zValidator("json", updateLegalProjectColumnSchema),
    async (c) =>
      c.json({
        data: await legalCrmWorkspaceService.updateColumn(
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
    await legalCrmWorkspaceService.deleteColumn(
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
      data: await legalCrmWorkspaceService.listMembers(
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
    zValidator("json", manageLegalProjectMembersSchema),
    async (c) =>
      c.json({
        data: await legalCrmWorkspaceService.setMembers(
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
    zValidator("json", createLegalProjectTaskCommentSchema),
    async (c) => {
      const data = await legalCrmWorkspaceService.createTaskComment(
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
    zValidator("json", manageLegalProjectTaskAssigneesSchema),
    async (c) =>
      c.json({
        data: await legalCrmWorkspaceService.setTaskAssignees(
          c.var.db,
          c.req.param("id"),
          c.req.param("taskId"),
          c.var.user!.id,
          c.var.user!.permissions,
          c.req.valid("json"),
        ),
      }),
  );
