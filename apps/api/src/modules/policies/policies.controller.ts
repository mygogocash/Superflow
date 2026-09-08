import { Router } from "express";

import { PERMISSIONS } from "@/common/constants/permissions";
import { getRequiredParam } from "@/common/utils/params";
import {
  authenticate,
  requireActive,
  requirePermission,
} from "@/core/guards/auth.guard";
import { asyncHandler } from "@/core/middleware/async-handler";
import { policiesService } from "@/modules/policies/policies.service";
import {
  createPolicySchema,
  listPolicyQuerySchema,
  updatePolicySchema,
} from "@/modules/policies/policies.validation";

const router = Router();

router.use(authenticate, requireActive);

router.get(
  "/",
  requirePermission(PERMISSIONS.POLICY_READ, PERMISSIONS.POLICY_MANAGE),
  asyncHandler(async (req, res) => {
    const query = listPolicyQuerySchema.parse(req.query);
    const data = await policiesService.listForUser(
      req.user!.id,
      req.user!.permissions,
      query,
    );
    res.json({ data });
  }),
);

// Mint a short-lived signed URL for the file. Literal segment must
// come before the `/:id` GET so Express doesn't capture "download".
router.get(
  "/:id/download",
  requirePermission(PERMISSIONS.POLICY_READ, PERMISSIONS.POLICY_MANAGE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await policiesService.getDownloadUrl(
      id,
      req.user!.id,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

router.get(
  "/:id",
  requirePermission(PERMISSIONS.POLICY_READ, PERMISSIONS.POLICY_MANAGE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await policiesService.getById(
      id,
      req.user!.id,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

router.post(
  "/",
  requirePermission(PERMISSIONS.POLICY_MANAGE),
  asyncHandler(async (req, res) => {
    const input = createPolicySchema.parse(req.body);
    const data = await policiesService.create(input, req.user!.id);
    res.status(201).json({ data });
  }),
);

router.put(
  "/:id",
  requirePermission(PERMISSIONS.POLICY_MANAGE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = updatePolicySchema.parse(req.body);
    const data = await policiesService.update(id, input);
    res.json({ data });
  }),
);

router.delete(
  "/:id",
  requirePermission(PERMISSIONS.POLICY_MANAGE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await policiesService.delete(id);
    res.json({ data });
  }),
);

export default router;
