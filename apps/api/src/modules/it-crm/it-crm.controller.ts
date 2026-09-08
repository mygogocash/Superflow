import { Router } from "express";

import { PERMISSIONS } from "@/common/constants/permissions";
import { getRequiredParam } from "@/common/utils/params";
import {
  authenticate,
  requireActive,
  requirePermission,
} from "@/core/guards/auth.guard";
import { asyncHandler } from "@/core/middleware/async-handler";
import { itCrmService } from "@/modules/it-crm/it-crm.service";
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
} from "@/modules/it-crm/it-crm.validation";

const router = Router();

router.use(authenticate, requireActive);

// Permission bundles — accept the existing it-crm:* set, plus broad
// projects:* fallback so admins / read-all holders work without an
// extra role grant.
const IT_READ_PERMS = [
  PERMISSIONS.IT_CRM_READ,
  PERMISSIONS.IT_CRM_READ_ALL,
  PERMISSIONS.PROJECTS_READ,
  PERMISSIONS.PROJECTS_READ_ALL,
];

// Org-wide dashboard / reminder settings — projects:read alone must not unlock these.
const IT_ORG_READ_PERMS = [
  PERMISSIONS.IT_CRM_READ_ALL,
  PERMISSIONS.IT_CRM_MANAGE,
  PERMISSIONS.PROJECTS_READ_ALL,
  PERMISSIONS.PROJECTS_MANAGE,
];

const IT_WRITE_PERMS = [
  PERMISSIONS.IT_CRM_UPDATE,
  PERMISSIONS.IT_CRM_MANAGE,
  PERMISSIONS.PROJECTS_UPDATE,
  PERMISSIONS.PROJECTS_MANAGE,
];

// ─── Project CRUD ────────────────────────────────────────────

router.get(
  "/",
  requirePermission(...IT_READ_PERMS),
  asyncHandler(async (req, res) => {
    const query = itProjectQuerySchema.parse(req.query);
    const result = await itCrmService.list(
      req.user!.id,
      req.user!.permissions,
      query,
    );
    res.json(result);
  }),
);

router.post(
  "/",
  requirePermission(
    PERMISSIONS.IT_CRM_CREATE,
    PERMISSIONS.IT_CRM_MANAGE,
    PERMISSIONS.PROJECTS_CREATE,
  ),
  asyncHandler(async (req, res) => {
    const input = createItProjectSchema.parse(req.body);
    const data = await itCrmService.create(req.user!.id, input);
    res.status(201).json({ data });
  }),
);

// Literal paths before `:id` — Express matches in order.
router.post(
  "/import",
  requirePermission(
    PERMISSIONS.IT_CRM_CREATE,
    PERMISSIONS.IT_CRM_MANAGE,
    PERMISSIONS.PROJECTS_CREATE,
  ),
  asyncHandler(async (req, res) => {
    const input = importItProjectsSchema.parse(req.body);
    const data = await itCrmService.importRows(req.user!.id, input.rows);
    res.status(201).json({ data });
  }),
);

router.put(
  "/reorder",
  requirePermission(...IT_WRITE_PERMS),
  asyncHandler(async (req, res) => {
    const input = reorderItProjectsSchema.parse(req.body);
    const data = await itCrmService.reorder(input);
    res.json({ data });
  }),
);

// IT CRM intelligence dashboard — literal route MUST come before
// `/:id`, otherwise Express matches "dashboard" as a project id
// (CLAUDE.md "Express route order" pitfall).
router.get(
  "/dashboard",
  requirePermission(...IT_ORG_READ_PERMS),
  asyncHandler(async (_req, res) => {
    const data = await itCrmService.dashboard();
    res.json({ data });
  }),
);

// Deadline-reminder recipient list (org-wide SystemSetting). Read for any IT
// reader; write is manager/admin only. Literal routes before "/:id".
router.get(
  "/reminder-settings",
  requirePermission(...IT_ORG_READ_PERMS),
  asyncHandler(async (_req, res) => {
    const data = await itCrmService.getReminderRecipients();
    res.json({ data });
  }),
);

router.put(
  "/reminder-settings",
  // Manage-only: this is an org-wide setting. read-all is a read-scope widener,
  // not a write grant — keep it out of the write gate.
  requirePermission(PERMISSIONS.IT_CRM_MANAGE, PERMISSIONS.PROJECTS_MANAGE),
  asyncHandler(async (req, res) => {
    const input = reminderSettingsSchema.parse(req.body);
    const data = await itCrmService.setReminderRecipients(input);
    res.json({ data });
  }),
);

router.get(
  "/:id",
  requirePermission(...IT_READ_PERMS),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await itCrmService.getById(
      id,
      req.user!.id,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

router.put(
  "/:id",
  requirePermission(...IT_READ_PERMS, ...IT_WRITE_PERMS),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = updateItProjectSchema.parse(req.body);
    const data = await itCrmService.update(
      id,
      req.user!.id,
      req.user!.permissions,
      input,
    );
    res.json({ data });
  }),
);

router.delete(
  "/:id",
  requirePermission(
    ...IT_READ_PERMS,
    PERMISSIONS.IT_CRM_DELETE,
    PERMISSIONS.IT_CRM_MANAGE,
    PERMISSIONS.PROJECTS_DELETE,
    PERMISSIONS.PROJECTS_MANAGE,
  ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    await itCrmService.delete(id, req.user!.id, req.user!.permissions);
    res.json({ data: { success: true } });
  }),
);

// Reversible archive/unarchive. Gated like update (write perms); the service
// enforces owner-or-manage so a plain write-perm holder can't archive another
// team's project.
router.post(
  "/:id/archive",
  requirePermission(...IT_READ_PERMS, ...IT_WRITE_PERMS),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await itCrmService.archive(
      id,
      req.user!.id,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

router.post(
  "/:id/unarchive",
  requirePermission(...IT_READ_PERMS, ...IT_WRITE_PERMS),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await itCrmService.unarchive(
      id,
      req.user!.id,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

// ─── Board ──────────────────────────────────────────────────

router.get(
  "/:id/board",
  requirePermission(...IT_READ_PERMS),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await itCrmService.getBoard(
      id,
      req.user!.id,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

// ─── Tasks ──────────────────────────────────────────────────

router.post(
  "/:id/tasks",
  requirePermission(...IT_WRITE_PERMS),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = createItProjectTaskSchema.parse(req.body);
    const data = await itCrmService.createTask(
      id,
      req.user!.id,
      req.user!.permissions,
      input,
    );
    res.status(201).json({ data });
  }),
);

router.put(
  "/:id/tasks/:taskId",
  requirePermission(...IT_WRITE_PERMS),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const taskId = getRequiredParam(req.params, "taskId");
    const input = updateItProjectTaskSchema.parse(req.body);
    const data = await itCrmService.updateTask(
      id,
      taskId,
      req.user!.id,
      req.user!.permissions,
      input,
    );
    res.json({ data });
  }),
);

router.delete(
  "/:id/tasks/:taskId",
  requirePermission(...IT_WRITE_PERMS),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const taskId = getRequiredParam(req.params, "taskId");
    await itCrmService.deleteTask(
      id,
      taskId,
      req.user!.id,
      req.user!.permissions,
    );
    res.json({ data: { success: true } });
  }),
);

// ─── Columns ────────────────────────────────────────────────

router.post(
  "/:id/columns",
  requirePermission(...IT_WRITE_PERMS),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = createItProjectColumnSchema.parse(req.body);
    const data = await itCrmService.createColumn(
      id,
      req.user!.id,
      req.user!.permissions,
      input,
    );
    res.status(201).json({ data });
  }),
);

router.put(
  "/:id/columns/:columnId",
  requirePermission(...IT_WRITE_PERMS),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const columnId = getRequiredParam(req.params, "columnId");
    const input = updateItProjectColumnSchema.parse(req.body);
    const data = await itCrmService.updateColumn(
      id,
      columnId,
      req.user!.id,
      req.user!.permissions,
      input,
    );
    res.json({ data });
  }),
);

router.delete(
  "/:id/columns/:columnId",
  requirePermission(...IT_WRITE_PERMS),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const columnId = getRequiredParam(req.params, "columnId");
    await itCrmService.deleteColumn(
      id,
      columnId,
      req.user!.id,
      req.user!.permissions,
    );
    res.json({ data: { success: true } });
  }),
);

// ─── Members ────────────────────────────────────────────────

router.get(
  "/:id/members",
  requirePermission(...IT_READ_PERMS),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await itCrmService.listMembers(
      id,
      req.user!.id,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

router.put(
  "/:id/members",
  requirePermission(...IT_WRITE_PERMS),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = manageItProjectMembersSchema.parse(req.body);
    const data = await itCrmService.setMembers(
      id,
      req.user!.id,
      req.user!.permissions,
      input,
    );
    res.json({ data });
  }),
);

// ─── Comments + Assignees ───────────────────────────────────

router.post(
  "/:id/tasks/:taskId/comments",
  requirePermission(...IT_WRITE_PERMS),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const taskId = getRequiredParam(req.params, "taskId");
    const input = createItProjectTaskCommentSchema.parse(req.body);
    const data = await itCrmService.createTaskComment(
      id,
      taskId,
      req.user!.id,
      req.user!.permissions,
      input,
    );
    res.status(201).json({ data });
  }),
);

router.put(
  "/:id/tasks/:taskId/assignees",
  requirePermission(...IT_WRITE_PERMS),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const taskId = getRequiredParam(req.params, "taskId");
    const input = manageItProjectTaskAssigneesSchema.parse(req.body);
    const data = await itCrmService.setTaskAssignees(
      id,
      taskId,
      req.user!.id,
      req.user!.permissions,
      input,
    );
    res.json({ data });
  }),
);

export default router;
