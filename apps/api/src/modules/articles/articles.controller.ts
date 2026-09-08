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
import { articlesService } from "@/modules/articles/articles.service";
import {
  createArticleSchema,
  updateArticleSchema,
} from "@/modules/articles/articles.validation";

const router = Router();

router.use(authenticate, requireActive);

router.get(
  "/",
  requirePermission(PERMISSIONS.PR_READ),
  asyncHandler(async (req, res) => {
    const search = (req.query.search as string) || undefined;
    const page = Number(req.query.page ?? "1");
    const limit = Number(req.query.limit ?? "20");
    const result = await articlesService.list({ search, page, limit });
    res.json(result);
  }),
);

router.post(
  "/",
  requirePermission(PERMISSIONS.PR_CREATE),
  asyncHandler(async (req, res) => {
    const input = createArticleSchema.parse(req.body);
    const result = await articlesService.create(input, req.user!.id);
    logger.info(scrubLog(`Article created: "${input.title}" by ${req.user!.email}`));
    res.status(201).json(result);
  }),
);

router.get(
  "/export",
  requirePermission(PERMISSIONS.PR_READ),
  asyncHandler(async (req, res) => {
    const search = (req.query.search as string) || undefined;
    const csv = await articlesService.exportCsv({ search });
    const day = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="pr-articles-${day}.csv"`,
    );
    res.send(csv);
  }),
);

router.get(
  "/:id",
  requirePermission(PERMISSIONS.PR_READ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const result = await articlesService.getById(id);
    res.json(result);
  }),
);

router.put(
  "/:id",
  requirePermission(PERMISSIONS.PR_UPDATE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = updateArticleSchema.parse(req.body);
    const result = await articlesService.update(id, input);
    logger.info(scrubLog(`Article updated: ${id} by ${req.user!.email}`));
    res.json(result);
  }),
);

router.delete(
  "/:id",
  requirePermission(PERMISSIONS.PR_DELETE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const result = await articlesService.remove(id);
    logger.info(scrubLog(`Article deleted: ${id} by ${req.user!.email}`));
    res.json(result);
  }),
);

export default router;
