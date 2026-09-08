import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import {
  parseSubscribeInput,
  parseUnsubscribeInput,
  testNotificationSchema,
} from "@nexora/contracts/modules/push/push.validation";
import { pushService } from "@nexora/core";
import type { AppEnv } from "../lib/context";
import { requireAuth } from "../middleware/auth";

export const push = new Hono<AppEnv>()
  .get("/config", requireAuth, async (c) =>
    c.json({ data: await pushService.getConfig(c.var.db, c.var.user!.id, c.env) }),
  )
  .post("/subscribe", requireAuth, async (c) => {
    const input = parseSubscribeInput(await c.req.json());
    const data = await pushService.subscribe(c.var.db, c.var.user!.id, {
      endpoint: input.endpoint,
      keys: input.keys,
      userAgent: c.req.header("user-agent") ?? input.userAgent ?? null,
    });
    return c.json({ data }, 201);
  })
  .post("/unsubscribe", requireAuth, async (c) => {
    const input = parseUnsubscribeInput(await c.req.json());
    const data = await pushService.unsubscribe(c.var.db, c.var.user!.id, input.endpoint);
    return c.json({ data });
  })
  .post("/unsubscribe-all", requireAuth, async (c) => {
    const data = await pushService.unsubscribeAll(c.var.db, c.var.user!.id);
    return c.json({ data });
  })
  .post("/test", requireAuth, zValidator("json", testNotificationSchema), async (c) => {
    // Parity with Express: self-test push is not registered in production.
    if (process.env.NODE_ENV === "production") {
      return c.json({ error: { message: "Not Found", statusCode: 404 } }, 404);
    }
    const input = c.req.valid("json");
    const data = await pushService.sendToUsers(c.var.db, [c.var.user!.id], {
      title: input.title ?? "Test notification",
      body: input.body ?? "Push is working on this device.",
      url: "/dashboard",
      tag: "push-test",
    }, c.env);
    return c.json({ data });
  });
