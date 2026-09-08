import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import {
  createOrganizationSchema,
  updateOrganizationSchema,
  updateOrgMembershipSchema,
  upsertOrgMembershipSchema,
} from "@nexora/contracts/modules/organizations/organizations.validation";
import { isOrgTenancyEnforced } from "@nexora/auth/org-rbac";
import { organizationsService } from "@nexora/core";
import type { AppEnv } from "../lib/context";
import { requireAuth } from "../middleware/auth";

/**
 * Organization tenancy APIs.
 * Platform routes require platform_admin (enforced in service).
 * Member routes require org admin+ (enforced in service).
 */

function tenancyOptions(env: { ORG_TENANCY_ENFORCED?: string }) {
  return { tenancyEnforced: isOrgTenancyEnforced(env.ORG_TENANCY_ENFORCED) };
}

export const organizations = new Hono<AppEnv>()
  .use("*", requireAuth)
  .get("/", async (c) => c.json(await organizationsService.listOrganizations(c.var.db, c.var.user!.id)))
  .post("/", zValidator("json", createOrganizationSchema), async (c) =>
    c.json(await organizationsService.createOrganization(c.var.db, c.var.user!.id, c.req.valid("json")), 201),
  )
  .get("/:id", async (c) =>
    c.json(await organizationsService.getOrganization(c.var.db, c.var.user!.id, c.req.param("id"), tenancyOptions(c.env))),
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
    c.json(await organizationsService.listMembers(c.var.db, c.var.user!.id, c.req.param("id"), tenancyOptions(c.env))),
  )
  .post("/:id/members", zValidator("json", upsertOrgMembershipSchema), async (c) =>
    c.json(
      await organizationsService.upsertMember(
        c.var.db,
        c.var.user!.id,
        c.req.param("id"),
        c.req.valid("json"),
        tenancyOptions(c.env),
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
        tenancyOptions(c.env),
      ),
    ),
  );
