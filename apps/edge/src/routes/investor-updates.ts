import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { PERMISSIONS } from "@nexora/contracts";
import {
  createUpdateSchema,
  listUpdatesSchema,
  updateUpdateSchema,
} from "@nexora/contracts/modules/investor-updates/investor-updates.validation";
import { investorUpdatesService } from "@nexora/core";
import type { AppEnv } from "../lib/context";
import { requirePermission } from "../middleware/rbac";

export const investorUpdates = new Hono<AppEnv>()
  .get("/", requirePermission(PERMISSIONS.INVESTOR_UPDATES_READ), zValidator("query", listUpdatesSchema), async (c) =>
    c.json(await investorUpdatesService.list(c.var.db, c.req.valid("query"), c.var.user!.permissions)),
  )
  .post("/", requirePermission(PERMISSIONS.INVESTOR_UPDATES_CREATE), zValidator("json", createUpdateSchema), async (c) => {
    const data = await investorUpdatesService.create(c.var.db, c.req.valid("json"));
    return c.json({ data }, 201);
  })
  .get("/:id", requirePermission(PERMISSIONS.INVESTOR_UPDATES_READ), async (c) =>
    c.json({ data: await investorUpdatesService.getById(c.var.db, c.req.param("id"), c.var.user!.permissions) }),
  )
  .put(
    "/:id",
    requirePermission(PERMISSIONS.INVESTOR_UPDATES_CREATE),
    zValidator("json", updateUpdateSchema),
    async (c) =>
      c.json({
        data: await investorUpdatesService.update(
          c.var.db,
          c.req.param("id"),
          c.req.valid("json"),
          c.var.user!.permissions,
        ),
      }),
  )
  .delete("/:id", requirePermission(PERMISSIONS.INVESTOR_UPDATES_CREATE), async (c) => {
    await investorUpdatesService.remove(c.var.db, c.req.param("id"), c.var.user!.permissions);
    return c.json({ data: { success: true } });
  })
  .post("/:id/send", requirePermission(PERMISSIONS.INVESTOR_UPDATES_SEND), async (c) =>
    c.json({
      data: await investorUpdatesService.send(
        c.var.db,
        c.req.param("id"),
        c.var.user!.id,
        c.var.user!.permissions,
      ),
    }),
  );
