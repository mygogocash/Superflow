import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { PERMISSIONS } from "@nexora/contracts";
import {
  createPolicySchema,
  listPolicyQuerySchema,
  updatePolicySchema,
} from "@nexora/contracts/modules/policies/policies.validation";
import { policiesService } from "@nexora/core";
import type { AppEnv } from "../lib/context";
import { requirePermission } from "../middleware/rbac";

export const policies = new Hono<AppEnv>()
  .get("/", requirePermission(PERMISSIONS.POLICY_READ, PERMISSIONS.POLICY_MANAGE), zValidator("query", listPolicyQuerySchema), async (c) => {
    const data = await policiesService.listForUser(
      c.var.db,
      c.var.user!.id,
      c.var.user!.permissions,
      c.req.valid("query"),
    );
    return c.json({ data });
  })
  .get("/:id/download", requirePermission(PERMISSIONS.POLICY_READ, PERMISSIONS.POLICY_MANAGE), async (c) => {
    const data = await policiesService.getDownloadUrl(
      c.var.db,
      c.req.param("id"),
      c.var.user!.id,
      c.var.user!.permissions,
    );
    return c.json({ data });
  })
  .get("/:id", requirePermission(PERMISSIONS.POLICY_READ, PERMISSIONS.POLICY_MANAGE), async (c) => {
    const data = await policiesService.getById(
      c.var.db,
      c.req.param("id"),
      c.var.user!.id,
      c.var.user!.permissions,
    );
    return c.json({ data });
  })
  .post("/", requirePermission(PERMISSIONS.POLICY_MANAGE), zValidator("json", createPolicySchema), async (c) => {
    const data = await policiesService.create(c.var.db, c.req.valid("json"), c.var.user!.id);
    return c.json({ data }, 201);
  })
  .put("/:id", requirePermission(PERMISSIONS.POLICY_MANAGE), zValidator("json", updatePolicySchema), async (c) => {
    const data = await policiesService.update(c.var.db, c.req.param("id"), c.req.valid("json"));
    return c.json({ data });
  })
  .delete("/:id", requirePermission(PERMISSIONS.POLICY_MANAGE), async (c) => {
    const data = await policiesService.remove(c.var.db, c.req.param("id"));
    return c.json({ data });
  });
