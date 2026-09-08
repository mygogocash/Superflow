import { Router } from "express";

import { PERMISSIONS } from "@/common/constants/permissions";
import { logger, scrubLog } from "@/common/utils/logger";
import { getRequiredParam } from "@/common/utils/params";
import {
  authenticate,
  requireActive,
  requirePermission,
} from "@/core/guards/auth.guard";
import { asyncHandler } from "@/core/middleware/async-handler";
import { blogsService } from "@/modules/blogs/blogs.service";
import {
  createBlogSchema,
  updateBlogSchema,
} from "@/modules/blogs/blogs.validation";

const router = Router();

router.use(authenticate, requireActive);

router.get(
  "/",
  requirePermission(PERMISSIONS.BLOG_READ),
  asyncHandler(async (req, res) => {
    const search = (req.query.search as string) || undefined;
    const page = Number(req.query.page ?? "1");
    const limit = Number(req.query.limit ?? "20");
    const result = await blogsService.list({ search, page, limit });
    res.json(result);
  }),
);

router.post(
  "/",
  requirePermission(PERMISSIONS.BLOG_CREATE),
  asyncHandler(async (req, res) => {
    const input = createBlogSchema.parse(req.body);
    const result = await blogsService.create(input, req.user!.id);
    logger.info(scrubLog(`Blog created: "${input.title}" by ${req.user!.email}`));
    res.status(201).json(result);
  }),
);

router.get(
  "/export",
  requirePermission(PERMISSIONS.BLOG_READ),
  asyncHandler(async (req, res) => {
    const search = (req.query.search as string) || undefined;
    const csv = await blogsService.exportCsv({ search });
    const day = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="blogs-${day}.csv"`,
    );
    res.send(csv);
  }),
);

router.get(
  "/:id",
  requirePermission(PERMISSIONS.BLOG_READ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const result = await blogsService.getById(id);
    res.json(result);
  }),
);

router.put(
  "/:id",
  requirePermission(PERMISSIONS.BLOG_UPDATE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = updateBlogSchema.parse(req.body);
    const result = await blogsService.update(id, input);
    logger.info(scrubLog(`Blog updated: ${id} by ${req.user!.email}`));
    res.json(result);
  }),
);

router.delete(
  "/:id",
  requirePermission(PERMISSIONS.BLOG_DELETE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const result = await blogsService.remove(id);
    logger.info(scrubLog(`Blog deleted: ${id} by ${req.user!.email}`));
    res.json(result);
  }),
);

export default router;
