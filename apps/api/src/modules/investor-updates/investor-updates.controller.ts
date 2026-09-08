import { Router } from "express";

import { PERMISSIONS } from "@/common/constants/permissions";
import {
  authenticate,
  requireActive,
  requirePermission,
} from "@/core/guards/auth.guard";
import { asyncHandler } from "@/core/middleware/async-handler";
import { investorUpdateService } from "@/modules/investor-updates/investor-updates.service";
import {
  createUpdateSchema,
  listUpdatesSchema,
  updateUpdateSchema,
} from "@/modules/investor-updates/investor-updates.validation";

const router = Router();

router.use(authenticate, requireActive);

router.get(
  "/",
  requirePermission(PERMISSIONS.INVESTOR_UPDATES_READ),
  asyncHandler(async (req, res) => {
    const query = listUpdatesSchema.parse(req.query);
    const result = await investorUpdateService.list(
      query,
      req.user!.permissions,
    );
    res.json(result);
  }),
);

router.post(
  "/",
  requirePermission(PERMISSIONS.INVESTOR_UPDATES_CREATE),
  asyncHandler(async (req, res) => {
    const input = createUpdateSchema.parse(req.body);
    const data = await investorUpdateService.create(input);
    res.status(201).json({ data });
  }),
);

router.get(
  "/:id",
  requirePermission(PERMISSIONS.INVESTOR_UPDATES_READ),
  asyncHandler(async (req, res) => {
    const data = await investorUpdateService.getById(
      req.params.id as string,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

router.put(
  "/:id",
  requirePermission(PERMISSIONS.INVESTOR_UPDATES_CREATE),
  asyncHandler(async (req, res) => {
    const input = updateUpdateSchema.parse(req.body);
    const data = await investorUpdateService.update(
      req.params.id as string,
      input,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

router.delete(
  "/:id",
  requirePermission(PERMISSIONS.INVESTOR_UPDATES_CREATE),
  asyncHandler(async (req, res) => {
    await investorUpdateService.delete(
      req.params.id as string,
      req.user!.permissions,
    );
    res.json({ data: { success: true } });
  }),
);

router.post(
  "/:id/send",
  requirePermission(PERMISSIONS.INVESTOR_UPDATES_SEND),
  asyncHandler(async (req, res) => {
    const data = await investorUpdateService.send(
      req.params.id as string,
      req.user!.id,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

export default router;
