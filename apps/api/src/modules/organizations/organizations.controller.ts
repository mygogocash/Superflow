import { Router } from "express";

import { authenticate, requireActive } from "@/core/guards/auth.guard";
import { asyncHandler } from "@/core/middleware/async-handler";
import { organizationsService } from "@/modules/organizations/organizations.service";
import {
  createOrganizationSchema,
  updateOrganizationSchema,
  updateOrgMembershipSchema,
  upsertOrgMembershipSchema,
} from "@/modules/organizations/organizations.validation";

/**
 * Express `/api/organizations`. Authz is enforced in the service
 * (platform admin vs org admin) — route only requires an active session.
 */
const router = Router();

router.use(authenticate, requireActive);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await organizationsService.listOrganizations(req.user!.id));
  }),
);

router.post(
  "/",
  asyncHandler(async (req, res) => {
    const input = createOrganizationSchema.parse(req.body);
    res
      .status(201)
      .json(await organizationsService.createOrganization(req.user!.id, input));
  }),
);

router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(
      await organizationsService.getOrganization(
        req.user!.id,
        req.params.id as string,
      ),
    );
  }),
);

router.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const input = updateOrganizationSchema.parse(req.body);
    res.json(
      await organizationsService.updateOrganization(
        req.user!.id,
        req.params.id as string,
        input,
      ),
    );
  }),
);

router.get(
  "/:id/members",
  asyncHandler(async (req, res) => {
    res.json(
      await organizationsService.listMembers(
        req.user!.id,
        req.params.id as string,
      ),
    );
  }),
);

router.post(
  "/:id/members",
  asyncHandler(async (req, res) => {
    const input = upsertOrgMembershipSchema.parse(req.body);
    res
      .status(201)
      .json(
        await organizationsService.upsertMember(
          req.user!.id,
          req.params.id as string,
          input,
        ),
      );
  }),
);

router.patch(
  "/:id/members/:membershipId",
  asyncHandler(async (req, res) => {
    const input = updateOrgMembershipSchema.parse(req.body);
    res.json(
      await organizationsService.updateMember(
        req.user!.id,
        req.params.id as string,
        req.params.membershipId as string,
        input,
      ),
    );
  }),
);

export { router as organizationsRoutes };
