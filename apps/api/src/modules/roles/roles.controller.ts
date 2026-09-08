import { Router } from "express";

import {
  PERMISSION_DEFINITIONS,
  PERMISSIONS,
  PERMISSIONS_BY_MODULE,
} from "@/common/constants/permissions";
import { logger, scrubLog } from "@/common/utils/logger";
import { getRequiredParam } from "@/common/utils/params";
import {
  authenticate,
  requireActive,
  requirePermission,
} from "@/core/guards/auth.guard";
import { asyncHandler } from "@/core/middleware/async-handler";
import { logAudit } from "@/infrastructure/audit/audit.service";
import { rolesService } from "@/modules/roles/roles.service";
import {
  cloneRoleSchema,
  createRoleSchema,
  updateRoleSchema,
} from "@/modules/roles/roles.validation";

const router = Router();

router.use(authenticate, requireActive);

router.get(
  "/permissions",
  requirePermission(PERMISSIONS.ROLE_READ),
  (_req, res) => {
    res.json({
      data: PERMISSION_DEFINITIONS,
      byModule: PERMISSIONS_BY_MODULE,
    });
  },
);

router.get(
  "/",
  requirePermission(PERMISSIONS.ROLE_READ, PERMISSIONS.USER_READ),
  asyncHandler(async (_req, res) => {
    const result = await rolesService.list();
    res.json(result);
  }),
);

router.post(
  "/",
  requirePermission(PERMISSIONS.ROLE_CREATE),
  asyncHandler(async (req, res) => {
    const input = createRoleSchema.parse(req.body);
    const result = await rolesService.create(input);
    logger.info(scrubLog(`Role created: ${input.name} by ${req.user!.email}`));
    void logAudit({
      action: "create",
      resource: "role",
      resourceId: result.data.id,
      details: { name: input.name },
      req,
    });
    res.status(201).json(result);
  }),
);

// Literal /:id/users must come before /:id (Express matches in order).
router.get(
  "/:id/users",
  requirePermission(PERMISSIONS.ROLE_READ, PERMISSIONS.USER_READ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const result = await rolesService.listMembers(id);
    res.json(result);
  }),
);

router.get(
  "/:id",
  requirePermission(PERMISSIONS.ROLE_READ, PERMISSIONS.USER_READ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const result = await rolesService.getById(id);
    res.json(result);
  }),
);

router.put(
  "/:id",
  requirePermission(PERMISSIONS.ROLE_UPDATE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = updateRoleSchema.parse(req.body);
    const result = await rolesService.update(id, input);
    logger.info(scrubLog(`Role updated: ${id} by ${req.user!.email}`));
    void logAudit({
      action: "update",
      resource: "role",
      resourceId: id,
      details: { name: input.name },
      req,
    });
    res.json(result);
  }),
);

router.post(
  "/:id/clone",
  requirePermission(PERMISSIONS.ROLE_CREATE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = cloneRoleSchema.parse(req.body);
    const result = await rolesService.clone(id, input);
    logger.info(scrubLog(`Role cloned from ${id}: ${input.name} by ${req.user!.email}`));
    void logAudit({
      action: "clone",
      resource: "role",
      resourceId: result.data.id,
      details: { sourceId: id, name: input.name },
      req,
    });
    res.status(201).json(result);
  }),
);

router.delete(
  "/:id",
  requirePermission(PERMISSIONS.ROLE_DELETE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const result = await rolesService.remove(id);
    logger.info(scrubLog(`Role deleted: ${id} by ${req.user!.email}`));
    void logAudit({
      action: "delete",
      resource: "role",
      resourceId: id,
      req,
    });
    res.json(result);
  }),
);

export default router;
