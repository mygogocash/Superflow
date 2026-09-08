import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { PERMISSIONS } from "@nexora/contracts";
import { createNewsSchema, updateNewsSchema } from "@nexora/contracts/modules/news/news.validation";
import { newsService } from "@nexora/core";
import type { AppEnv } from "../lib/context";
import { requirePermission } from "../middleware/rbac";

export const news = new Hono<AppEnv>()
  .get("/", requirePermission(PERMISSIONS.HOME_READ, PERMISSIONS.NEWS_CREATE), async (c) => {
    const page = Math.max(1, Number(c.req.query("page") || 1));
    const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") || 20)));
    return c.json(await newsService.listNews(c.var.db, page, limit));
  })
  .post("/", requirePermission(PERMISSIONS.NEWS_CREATE), zValidator("json", createNewsSchema), async (c) => {
    const item = await newsService.createNews(c.var.db, c.var.user!.id, c.req.valid("json"));
    return c.json({ data: item }, 201);
  })
  .get("/:id", requirePermission(PERMISSIONS.HOME_READ, PERMISSIONS.NEWS_CREATE), async (c) => {
    const data = await newsService.getNewsById(c.var.db, c.req.param("id"));
    return c.json({ data });
  })
  .put("/:id", requirePermission(PERMISSIONS.NEWS_CREATE), zValidator("json", updateNewsSchema), async (c) => {
    const data = await newsService.updateNews(
      c.var.db,
      c.req.param("id"),
      { userId: c.var.user!.id, permissions: c.var.user!.permissions },
      c.req.valid("json"),
    );
    return c.json({ data });
  })
  .delete("/:id", requirePermission(PERMISSIONS.NEWS_DELETE), async (c) => {
    await newsService.deleteNews(c.var.db, c.req.param("id"));
    return c.json({ data: { success: true } });
  });
