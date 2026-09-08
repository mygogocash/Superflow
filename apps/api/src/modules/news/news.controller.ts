import { Router } from "express";

import { PERMISSIONS } from "@/common/constants/permissions";
import { getRequiredParam } from "@/common/utils/params";
import { authenticate, requirePermission } from "@/core/guards/auth.guard";
import { asyncHandler } from "@/core/middleware/async-handler";
import { newsService } from "@/modules/news/news.service";
import {
  createNewsSchema,
  updateNewsSchema,
} from "@/modules/news/news.validation";

const router = Router();

router.get(
  "/",
  authenticate,
  requirePermission(PERMISSIONS.HOME_READ, PERMISSIONS.NEWS_CREATE),
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const result = await newsService.listNews(page, limit);
    res.json(result);
  }),
);

router.post(
  "/",
  authenticate,
  requirePermission(PERMISSIONS.NEWS_CREATE),
  asyncHandler(async (req, res) => {
    const input = createNewsSchema.parse(req.body);
    const news = await newsService.createNews(req.user!.id, input);
    res.status(201).json({ data: news });
  }),
);

router.get(
  "/:id",
  authenticate,
  requirePermission(PERMISSIONS.HOME_READ, PERMISSIONS.NEWS_CREATE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await newsService.getNewsById(id);
    res.json({ data });
  }),
);

router.put(
  "/:id",
  authenticate,
  requirePermission(PERMISSIONS.NEWS_CREATE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = updateNewsSchema.parse(req.body);
    const data = await newsService.updateNews(
      id,
      { userId: req.user!.id, permissions: req.user!.permissions },
      input,
    );
    res.json({ data });
  }),
);

router.delete(
  "/:id",
  authenticate,
  requirePermission(PERMISSIONS.NEWS_DELETE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    await newsService.deleteNews(id);
    res.json({ data: { success: true } });
  }),
);

export default router;
