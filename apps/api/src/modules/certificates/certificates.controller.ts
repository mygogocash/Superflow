import { Router } from "express";

import { PERMISSIONS } from "@/common/constants/permissions";
import { getRequiredParam } from "@/common/utils/params";
import {
  authenticate,
  ensurePermissionsLoaded,
  requireActive,
  requirePermission,
} from "@/core/guards/auth.guard";
import { asyncHandler } from "@/core/middleware/async-handler";
import { certificatesService } from "@/modules/certificates/certificates.service";
import {
  createCertificateSchema,
  listCertificatesSchema,
} from "@/modules/certificates/certificates.validation";

const router = Router();
router.use(authenticate, requireActive);

router.get(
  "/",
  requirePermission(PERMISSIONS.CERTIFICATE_READ),
  asyncHandler(async (req, res) => {
    const query = listCertificatesSchema.parse(req.query);
    const result = await certificatesService.list(
      query,
      req.user!.id,
      req.user!.permissions,
    );
    res.json(result);
  }),
);

router.post(
  "/",
  requirePermission(PERMISSIONS.CERTIFICATE_MANAGE),
  asyncHandler(async (req, res) => {
    const input = createCertificateSchema.parse(req.body);
    const cert = await certificatesService.createAndIssue(req.user!.id, input);
    res.status(201).json({ data: cert });
  }),
);

// No requirePermission gate — the recipient may download their own, and the
// service authorizes (owner OR certificate:read/manage). ensurePermissionsLoaded
// is required so the actor's permissions are populated for that check.
router.get(
  "/:id/download",
  asyncHandler(async (req, res) => {
    await ensurePermissionsLoaded(req);
    const id = getRequiredParam(req.params, "id");
    const result = await certificatesService.getDownloadUrl(
      id,
      req.user!.id,
      req.user!.permissions,
    );
    res.json({ data: result });
  }),
);

// Restore a reverted certificate. Literal-suffix route — must be registered
// before the bare "/:id" delete below.
router.post(
  "/:id/restore",
  requirePermission(PERMISSIONS.CERTIFICATE_MANAGE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const result = await certificatesService.restore(id);
    res.json({ data: result });
  }),
);

// Permanently delete a certificate (record + stored PDF). Not recoverable.
router.delete(
  "/:id/permanent",
  requirePermission(PERMISSIONS.CERTIFICATE_MANAGE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const result = await certificatesService.remove(id);
    res.json({ data: result });
  }),
);

// Revert (soft delete): hide from the active list, keep restorable.
router.delete(
  "/:id",
  requirePermission(PERMISSIONS.CERTIFICATE_MANAGE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const result = await certificatesService.revert(id);
    res.json({ data: result });
  }),
);

export default router;
