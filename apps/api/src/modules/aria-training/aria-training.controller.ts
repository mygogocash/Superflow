import { Router } from "express";

import { getRequiredParam } from "@/common/utils/params";
import { authenticate, requireSystemAdmin } from "@/core/guards/auth.guard";
import { asyncHandler } from "@/core/middleware/async-handler";
import { ariaTrainingService } from "@/modules/aria-training/aria-training.service";
import {
  buildDatasetSchema,
  promoteModelVersionSchema,
  registerModelVersionSchema,
} from "@/modules/aria-training/aria-training.validation";
import type { MetricSpec } from "@/modules/aria-training/eval-gate";

// Training data is the most sensitive corpus in the app (verbatim, if not-yet-
// redacted, user turns across every module). Gate the entire surface on system
// admin identity — not a permission code, which a custom role could hold.
const router = Router();
router.use(authenticate, requireSystemAdmin());

// ── Datasets (Phase 2) ────────────────────────────────────────────
router.get(
  "/datasets",
  asyncHandler(async (req, res) => {
    const kind =
      typeof req.query.kind === "string" ? req.query.kind : undefined;
    res.json(await ariaTrainingService.listDatasets(kind));
  }),
);

router.post(
  "/datasets/build",
  asyncHandler(async (req, res) => {
    // zod's inferred type widens required fields to optional under this repo's
    // zod/TS combo; the schema still guarantees them at runtime, so narrow with
    // `!` (same pattern the auth controller uses).
    const input = buildDatasetSchema.parse(req.body);
    const result = await ariaTrainingService.buildDataset({
      kind: input.kind!,
      until: input.until,
      requirePermission: input.requirePermission,
      createdById: req.user!.id,
    });
    res.status(201).json({
      data: { dataset: result.dataset, rowCount: result.rowCount },
    });
  }),
);

// Literal-before-`:id`: this returns the JSONL body, so it is a POST that
// re-derives the frozen dataset rather than a resource read.
router.get(
  "/datasets/:id/export",
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const { dataset, drifted, jsonl } =
      await ariaTrainingService.exportDataset(id);
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="aria-${dataset.kind}-v${dataset.version}.jsonl"`,
    );
    res.setHeader("X-Dataset-Drifted", String(drifted));
    res.send(jsonl);
  }),
);

// ── Model versions + promotion gate (Phase 4) ─────────────────────
router.get(
  "/model-versions",
  asyncHandler(async (req, res) => {
    const status =
      typeof req.query.status === "string" ? req.query.status : undefined;
    res.json(await ariaTrainingService.listModelVersions(status));
  }),
);

router.post(
  "/model-versions",
  asyncHandler(async (req, res) => {
    const input = registerModelVersionSchema.parse(req.body);
    const result = await ariaTrainingService.registerModelVersion({
      name: input.name!,
      baseModel: input.baseModel!,
      method: input.method!,
      datasetId: input.datasetId,
      externalRef: input.externalRef,
      notes: input.notes,
      createdById: req.user!.id,
    });
    res.status(201).json(result);
  }),
);

router.post(
  "/model-versions/:id/promote",
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = promoteModelVersionSchema.parse(req.body);
    res.json(
      await ariaTrainingService.promoteModelVersion(id, {
        baseline: input.baseline!,
        candidate: input.candidate!,
        specs: input.specs as Record<string, MetricSpec> | undefined,
      }),
    );
  }),
);

// ── Monitoring read-model (Phase 5) ───────────────────────────────
router.get(
  "/metrics",
  asyncHandler(async (req, res) => {
    const days = Number(req.query.days);
    const sinceDays = Number.isFinite(days) && days > 0 ? days : 30;
    res.json(await ariaTrainingService.metrics(sinceDays));
  }),
);

export { router as ariaTrainingRoutes };
