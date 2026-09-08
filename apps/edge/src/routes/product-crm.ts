import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { PERMISSIONS } from "@nexora/contracts";
import {
  createProductProjectColumnSchema,
  createProductProjectSchema,
  createProductProjectTaskCommentSchema,
  createProductProjectTaskSchema,
  importProductProjectsSchema,
  productProjectQuerySchema,
  manageProductProjectMembersSchema,
  manageProductProjectTaskAssigneesSchema,
  reorderProductProjectsSchema,
  updateProductProjectColumnSchema,
  updateProductProjectSchema,
  updateProductProjectTaskSchema,
} from "@nexora/contracts/modules/product-crm/product-crm.validation";
import { productCrmService, productCrmWorkspaceService } from "@nexora/core";
import type { AppEnv } from "../lib/context";
import { requirePermission } from "../middleware/rbac";

const CRM_READ = [PERMISSIONS.PRODUCT_CRM_READ, PERMISSIONS.PRODUCT_CRM_READ_ALL, PERMISSIONS.PROJECTS_READ, PERMISSIONS.PROJECTS_READ_ALL] as const;

// Org-wide surfaces only — bare *:crm:read / projects:read are membership-scoped.
const CRM_ORG_READ = [
  PERMISSIONS.PRODUCT_CRM_READ_ALL,
  PERMISSIONS.PRODUCT_CRM_MANAGE,
  PERMISSIONS.PROJECTS_READ_ALL,
  PERMISSIONS.PROJECTS_MANAGE,
] as const;

const CRM_WRITE = [PERMISSIONS.PRODUCT_CRM_UPDATE, PERMISSIONS.PRODUCT_CRM_MANAGE, PERMISSIONS.PROJECTS_UPDATE, PERMISSIONS.PROJECTS_MANAGE] as const;

export const productCrm = new Hono<AppEnv>()
  .get("/", requirePermission(...CRM_READ), zValidator("query", productProjectQuerySchema), async (c) =>
    c.json(await productCrmService.list(c.var.db, c.var.user!.id, c.var.user!.permissions, c.req.valid("query"))),
  )
  .post(
    "/",
    requirePermission(PERMISSIONS.PRODUCT_CRM_CREATE, PERMISSIONS.PRODUCT_CRM_MANAGE, PERMISSIONS.PROJECTS_CREATE),
    zValidator("json", createProductProjectSchema),
    async (c) => {
      const data = await productCrmService.create(c.var.db, c.var.user!.id, c.req.valid("json"));
      return c.json({ data }, 201);
    },
  )
  .post(
    "/import",
    requirePermission(PERMISSIONS.PRODUCT_CRM_CREATE, PERMISSIONS.PRODUCT_CRM_MANAGE, PERMISSIONS.PROJECTS_CREATE),
    zValidator("json", importProductProjectsSchema),
    async (c) => {
      const data = await productCrmService.importRows(c.var.db, c.var.user!.id, c.req.valid("json").rows);
      return c.json({ data }, 201);
    },
  )
  .put(
    "/reorder",
    requirePermission(...CRM_WRITE),
    zValidator("json", reorderProductProjectsSchema),
    async (c) => c.json({ data: await productCrmService.reorder(c.var.db, c.req.valid("json")) }),
  )
  .get("/dashboard", requirePermission(...CRM_ORG_READ), async (c) =>
    c.json({ data: await productCrmService.dashboard(c.var.db) }),
  )
  .get("/reminder-settings", requirePermission(...CRM_ORG_READ), async (c) =>
    c.json({ data: await productCrmService.getReminderRecipients(c.var.db) }),
  )
  .put(
    "/reminder-settings",
    requirePermission(PERMISSIONS.PRODUCT_CRM_MANAGE, PERMISSIONS.PROJECTS_MANAGE),
    zValidator("json", z.object({ recipients: z.array(z.string().email()) })),
    async (c) => c.json({ data: await productCrmService.setReminderRecipients(c.var.db, c.req.valid("json")) }),
  )
  .get("/:id", requirePermission(...CRM_READ), async (c) =>
    c.json({
      data: await productCrmService.getById(c.var.db, c.req.param("id"), c.var.user!.id, c.var.user!.permissions),
    }),
  )
  .put(
    "/:id",
    requirePermission(...CRM_READ, ...CRM_WRITE),
    zValidator("json", updateProductProjectSchema),
    async (c) =>
      c.json({
        data: await productCrmService.update(
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
    requirePermission(...CRM_READ, PERMISSIONS.PRODUCT_CRM_DELETE, PERMISSIONS.PRODUCT_CRM_MANAGE, PERMISSIONS.PROJECTS_DELETE, PERMISSIONS.PROJECTS_MANAGE),
    async (c) => {
      await productCrmService.remove(c.var.db, c.req.param("id"), c.var.user!.id, c.var.user!.permissions);
      return c.json({ data: { success: true } });
    },
  )
  .post("/:id/archive", requirePermission(...CRM_READ, ...CRM_WRITE), async (c) =>
    c.json({
      data: await productCrmService.archive(c.var.db, c.req.param("id"), c.var.user!.id, c.var.user!.permissions),
    }),
  )
  .post("/:id/unarchive", requirePermission(...CRM_READ, ...CRM_WRITE), async (c) =>
    c.json({
      data: await productCrmService.unarchive(c.var.db, c.req.param("id"), c.var.user!.id, c.var.user!.permissions),
    }),
  )
  .get("/:id/board", requirePermission(...CRM_READ), async (c) =>
    c.json({
      data: await productCrmWorkspaceService.getBoard(
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
    zValidator("json", createProductProjectTaskSchema),
    async (c) => {
      const data = await productCrmWorkspaceService.createTask(
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
    zValidator("json", updateProductProjectTaskSchema),
    async (c) =>
      c.json({
        data: await productCrmWorkspaceService.updateTask(
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
    await productCrmWorkspaceService.deleteTask(
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
    zValidator("json", createProductProjectColumnSchema),
    async (c) => {
      const data = await productCrmWorkspaceService.createColumn(
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
    zValidator("json", updateProductProjectColumnSchema),
    async (c) =>
      c.json({
        data: await productCrmWorkspaceService.updateColumn(
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
    await productCrmWorkspaceService.deleteColumn(
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
      data: await productCrmWorkspaceService.listMembers(
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
    zValidator("json", manageProductProjectMembersSchema),
    async (c) =>
      c.json({
        data: await productCrmWorkspaceService.setMembers(
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
    zValidator("json", createProductProjectTaskCommentSchema),
    async (c) => {
      const data = await productCrmWorkspaceService.createTaskComment(
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
    zValidator("json", manageProductProjectTaskAssigneesSchema),
    async (c) =>
      c.json({
        data: await productCrmWorkspaceService.setTaskAssignees(
          c.var.db,
          c.req.param("id"),
          c.req.param("taskId"),
          c.var.user!.id,
          c.var.user!.permissions,
          c.req.valid("json"),
        ),
      }),
  );
