import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import {
  createOrganizationSchema,
  updateOrganizationSchema,
  updateOrgMembershipSchema,
  upsertOrgMembershipSchema,
} from "@nexora/contracts/modules/organizations/organizations.validation";
import { organizationsService } from "@nexora/core";
import type { AppEnv } from "../lib/context";
import { requireAuth } from "../middleware/auth";

/**
 * Organization tenancy APIs.
 * Platform routes require platform_admin (enforced in service).
 * Member routes require org admin+ (enforced in service).
 */
export const organizations = new Hono<AppEnv>()
  .use("*", requireAuth)
  .get("/", async (c) => c.json(await organizationsService.listOrganizations(c.var.db, c.var.user!.id)))
  .post("/", zValidator("json", createOrganizationSchema), async (c) =>
    c.json(await organizationsService.createOrganization(c.var.db, c.var.user!.id, c.req.valid("json")), 201),
  )
  .get("/:id", async (c) =>
    c.json(await organizationsService.getOrganization(c.var.db, c.var.user!.id, c.req.param("id"))),
  )
  .patch("/:id", zValidator("json", updateOrganizationSchema), async (c) =>
    c.json(
      await organizationsService.updateOrganization(
        c.var.db,
        c.var.user!.id,
        c.req.param("id"),
        c.req.valid("json"),
      ),
    ),
  )
  .get("/:id/members", async (c) =>
    c.json(await organizationsService.listMembers(c.var.db, c.var.user!.id, c.req.param("id"))),
  )
  .post("/:id/members", zValidator("json", upsertOrgMembershipSchema), async (c) =>
    c.json(
      await organizationsService.upsertMember(
        c.var.db,
        c.var.user!.id,
        c.req.param("id"),
        c.req.valid("json"),
      ),
      201,
    ),
  )
  .patch("/:id/members/:membershipId", zValidator("json", updateOrgMembershipSchema), async (c) =>
    c.json(
      await organizationsService.updateMember(
        c.var.db,
        c.var.user!.id,
        c.req.param("id"),
        c.req.param("membershipId"),
        c.req.valid("json"),
      ),
    ),
  );
