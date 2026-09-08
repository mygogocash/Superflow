import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { PERMISSIONS } from "@nexora/contracts";
import {
  createAccountingProjectColumnSchema,
  createAccountingProjectSchema,
  createAccountingProjectTaskCommentSchema,
  createAccountingProjectTaskSchema,
  importAccountingProjectsSchema,
  accountingProjectQuerySchema,
  manageAccountingProjectMembersSchema,
  manageAccountingProjectTaskAssigneesSchema,
  reorderAccountingProjectsSchema,
  updateAccountingProjectColumnSchema,
  updateAccountingProjectSchema,
  updateAccountingProjectTaskSchema,
} from "@nexora/contracts/modules/accounting-crm/accounting-crm.validation";
import { accountingCrmService, accountingCrmWorkspaceService } from "@nexora/core";
import type { AppEnv } from "../lib/context";
import { requirePermission } from "../middleware/rbac";

const CRM_READ = [PERMISSIONS.ACCOUNTING_CRM_READ, PERMISSIONS.ACCOUNTING_CRM_READ_ALL, PERMISSIONS.PROJECTS_READ, PERMISSIONS.PROJECTS_READ_ALL] as const;

// Org-wide surfaces only — bare *:crm:read / projects:read are membership-scoped.
const CRM_ORG_READ = [
  PERMISSIONS.ACCOUNTING_CRM_READ_ALL,
  PERMISSIONS.ACCOUNTING_CRM_MANAGE,
  PERMISSIONS.PROJECTS_READ_ALL,
  PERMISSIONS.PROJECTS_MANAGE,
] as const;

const CRM_WRITE = [PERMISSIONS.ACCOUNTING_CRM_UPDATE, PERMISSIONS.ACCOUNTING_CRM_MANAGE, PERMISSIONS.PROJECTS_UPDATE, PERMISSIONS.PROJECTS_MANAGE] as const;

export const accountingCrm = new Hono<AppEnv>()
  .get("/", requirePermission(...CRM_READ), zValidator("query", accountingProjectQuerySchema), async (c) =>
    c.json(await accountingCrmService.list(c.var.db, c.var.user!.id, c.var.user!.permissions, c.req.valid("query"))),
  )
  .post(
    "/",
    requirePermission(PERMISSIONS.ACCOUNTING_CRM_CREATE, PERMISSIONS.ACCOUNTING_CRM_MANAGE, PERMISSIONS.PROJECTS_CREATE),
    zValidator("json", createAccountingProjectSchema),
    async (c) => {
      const data = await accountingCrmService.create(c.var.db, c.var.user!.id, c.req.valid("json"));
      return c.json({ data }, 201);
    },
  )
  .post(
    "/import",
    requirePermission(PERMISSIONS.ACCOUNTING_CRM_CREATE, PERMISSIONS.ACCOUNTING_CRM_MANAGE, PERMISSIONS.PROJECTS_CREATE),
    zValidator("json", importAccountingProjectsSchema),
    async (c) => {
      const data = await accountingCrmService.importRows(c.var.db, c.var.user!.id, c.req.valid("json").rows);
      return c.json({ data }, 201);
    },
  )
  .put(
    "/reorder",
    requirePermission(...CRM_WRITE),
    zValidator("json", reorderAccountingProjectsSchema),
    async (c) => c.json({ data: await accountingCrmService.reorder(c.var.db, c.req.valid("json")) }),
  )
  .get("/dashboard", requirePermission(...CRM_ORG_READ), async (c) =>
    c.json({ data: await accountingCrmService.dashboard(c.var.db) }),
  )
  .get("/reminder-settings", requirePermission(...CRM_ORG_READ), async (c) =>
    c.json({ data: await accountingCrmService.getReminderRecipients(c.var.db) }),
  )
  .put(
    "/reminder-settings",
    requirePermission(PERMISSIONS.ACCOUNTING_CRM_MANAGE, PERMISSIONS.PROJECTS_MANAGE),
    zValidator("json", z.object({ recipients: z.array(z.string().email()) })),
    async (c) => c.json({ data: await accountingCrmService.setReminderRecipients(c.var.db, c.req.valid("json")) }),
  )
  .get("/:id", requirePermission(...CRM_READ), async (c) =>
    c.json({
      data: await accountingCrmService.getById(c.var.db, c.req.param("id"), c.var.user!.id, c.var.user!.permissions),
    }),
  )
  .put(
    "/:id",
    requirePermission(...CRM_READ, ...CRM_WRITE),
    zValidator("json", updateAccountingProjectSchema),
    async (c) =>
      c.json({
        data: await accountingCrmService.update(
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
    requirePermission(...CRM_READ, PERMISSIONS.ACCOUNTING_CRM_DELETE, PERMISSIONS.ACCOUNTING_CRM_MANAGE, PERMISSIONS.PROJECTS_DELETE, PERMISSIONS.PROJECTS_MANAGE),
    async (c) => {
      await accountingCrmService.remove(c.var.db, c.req.param("id"), c.var.user!.id, c.var.user!.permissions);
      return c.json({ data: { success: true } });
    },
  )
  .post("/:id/archive", requirePermission(...CRM_READ, ...CRM_WRITE), async (c) =>
    c.json({
      data: await accountingCrmService.archive(c.var.db, c.req.param("id"), c.var.user!.id, c.var.user!.permissions),
    }),
  )
  .post("/:id/unarchive", requirePermission(...CRM_READ, ...CRM_WRITE), async (c) =>
    c.json({
      data: await accountingCrmService.unarchive(c.var.db, c.req.param("id"), c.var.user!.id, c.var.user!.permissions),
    }),
  )
  .get("/:id/board", requirePermission(...CRM_READ), async (c) =>
    c.json({
      data: await accountingCrmWorkspaceService.getBoard(
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
    zValidator("json", createAccountingProjectTaskSchema),
    async (c) => {
      const data = await accountingCrmWorkspaceService.createTask(
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
    zValidator("json", updateAccountingProjectTaskSchema),
    async (c) =>
      c.json({
        data: await accountingCrmWorkspaceService.updateTask(
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
    await accountingCrmWorkspaceService.deleteTask(
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
    zValidator("json", createAccountingProjectColumnSchema),
    async (c) => {
      const data = await accountingCrmWorkspaceService.createColumn(
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
    zValidator("json", updateAccountingProjectColumnSchema),
    async (c) =>
      c.json({
        data: await accountingCrmWorkspaceService.updateColumn(
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
    await accountingCrmWorkspaceService.deleteColumn(
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
      data: await accountingCrmWorkspaceService.listMembers(
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
    zValidator("json", manageAccountingProjectMembersSchema),
    async (c) =>
      c.json({
        data: await accountingCrmWorkspaceService.setMembers(
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
    zValidator("json", createAccountingProjectTaskCommentSchema),
    async (c) => {
      const data = await accountingCrmWorkspaceService.createTaskComment(
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
    zValidator("json", manageAccountingProjectTaskAssigneesSchema),
    async (c) =>
      c.json({
        data: await accountingCrmWorkspaceService.setTaskAssignees(
          c.var.db,
          c.req.param("id"),
          c.req.param("taskId"),
          c.var.user!.id,
          c.var.user!.permissions,
          c.req.valid("json"),
        ),
      }),
  );
