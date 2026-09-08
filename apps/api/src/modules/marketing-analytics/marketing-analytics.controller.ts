import { Router } from "express";

import { PERMISSIONS } from "@/common/constants/permissions";
import {
  authenticate,
  requireActive,
  requirePermission,
} from "@/core/guards/auth.guard";
import { asyncHandler } from "@/core/middleware/async-handler";
import {
  getDriftRecipients,
  setDriftRecipients,
} from "@/modules/marketing-analytics/drift/drift-recipients";
import { marketingAnalyticsService } from "@/modules/marketing-analytics/marketing-analytics.service";
import {
  dauMauQuerySchema,
  driftRecipientsBodySchema,
  hostBaselineBodySchema,
  metricsQueryBodySchema,
  metricsQuerySchema,
  overviewContentSchema,
  partnerMetricsQuerySchema,
  rawFieldsQuerySchema,
} from "@/modules/marketing-analytics/marketing-analytics.validation";

const router = Router();
router.use(authenticate, requireActive);

const DASHBOARD = [
  PERMISSIONS.MARKETING_DASHBOARD_VIEW,
  PERMISSIONS.MARKETING_RAW_VIEW,
];
const RAW = [PERMISSIONS.MARKETING_RAW_VIEW];

// ── Dashboard ──
router.get(
  "/dashboard",
  requirePermission(...DASHBOARD),
  asyncHandler(async (_req, res) => {
    res.json(await marketingAnalyticsService.dashboard());
  }),
);

router.get(
  "/catalog",
  requirePermission(...DASHBOARD),
  asyncHandler(async (_req, res) => {
    res.json(await marketingAnalyticsService.getCatalog());
  }),
);

router.post(
  "/refresh",
  requirePermission(...DASHBOARD),
  asyncHandler(async (_req, res) => {
    res.json(await marketingAnalyticsService.refresh());
  }),
);

// ── DAU→MAU analytics (OneWave workbook exhibits, computed server-side) ──
router.get(
  "/dau-mau",
  requirePermission(...DASHBOARD),
  asyncHandler(async (req, res) => {
    const query = dauMauQuerySchema.parse(req.query);
    res.json(await marketingAnalyticsService.dauMauDashboard(query));
  }),
);

// ── Metric values / time-series (per telco) ──
router.get(
  "/partners",
  requirePermission(...DASHBOARD),
  asyncHandler(async (_req, res) => {
    res.json(await marketingAnalyticsService.listPartners());
  }),
);

// Host MAU/DAU are hand-maintained benchmark denominators, not measured data,
// so writing them is an admin act gated on ADMIN_MANAGE rather than the
// dashboard-view permission the read uses.
router.put(
  "/partners/:slug/host-baseline",
  requirePermission(PERMISSIONS.ADMIN_MANAGE),
  asyncHandler(async (req, res) => {
    const body = hostBaselineBodySchema.parse(req.body);
    res.json(
      await marketingAnalyticsService.setPartnerHostBaseline(
        String(req.params.slug),
        {
          // Normalise absent -> null explicitly: "not sent" and "cleared" mean
          // the same thing on this endpoint, and the store distinguishes a
          // stored null (unknown) from a missing slug (use the constant).
          hostDau: body.hostDau ?? null,
          hostMau: body.hostMau ?? null,
          hostSessionSec: body.hostSessionSec ?? null,
        },
      ),
    );
  }),
);

router.delete(
  "/partners/:slug/host-baseline",
  requirePermission(PERMISSIONS.ADMIN_MANAGE),
  asyncHandler(async (req, res) => {
    res.json(
      await marketingAnalyticsService.clearPartnerHostBaseline(
        String(req.params.slug),
      ),
    );
  }),
);

// ── Drift-alert recipients ──
// Who gets emailed when the daily DAU/MAU drift check finds something. This
// was the only recipient list on the platform with no way to edit it — every
// CRM has a Manage dialog over the same shape — so arming the alert meant a
// hand-written row in each environment's database.
//
// Recipient emails are org-wide config (and PII). Both read and write require
// ADMIN_MANAGE — dashboard viewers do not need the alert mailing list.
router.get(
  "/drift-settings",
  requirePermission(PERMISSIONS.ADMIN_MANAGE),
  asyncHandler(async (_req, res) => {
    res.json({ data: { recipients: await getDriftRecipients() } });
  }),
);

router.put(
  "/drift-settings",
  requirePermission(PERMISSIONS.ADMIN_MANAGE),
  asyncHandler(async (req, res) => {
    const body = driftRecipientsBodySchema.parse(req.body);
    const recipients = await setDriftRecipients(body.recipients);
    res.json({ data: { recipients } });
  }),
);

router.post(
  "/metrics/query",
  requirePermission(...DASHBOARD),
  asyncHandler(async (req, res) => {
    const input = metricsQueryBodySchema.parse(req.body);
    res.json(await marketingAnalyticsService.queryMetrics(input));
  }),
);

// ── Holistic Overview narrative (admin-editable) ──
router.get(
  "/overview/content",
  requirePermission(...DASHBOARD),
  asyncHandler(async (_req, res) => {
    res.json({ data: await marketingAnalyticsService.getOverviewContent() });
  }),
);

router.put(
  "/overview/content",
  requirePermission(PERMISSIONS.ADMIN_MANAGE),
  asyncHandler(async (req, res) => {
    const input = overviewContentSchema.parse(req.body);
    res.json({
      data: await marketingAnalyticsService.setOverviewContent(input),
    });
  }),
);

// ── Raw Data Explorer ──
router.get(
  "/metrics",
  requirePermission(...RAW),
  asyncHandler(async (req, res) => {
    const query = metricsQuerySchema.parse(req.query);
    res.json(await marketingAnalyticsService.listMetrics(query));
  }),
);

// Per-partner field breakdown (field id / label / source / window value /
// status) — the partner section of the Raw Data explorer.
router.get(
  "/raw-fields",
  requirePermission(...RAW),
  asyncHandler(async (req, res) => {
    const query = rawFieldsQuerySchema.parse(req.query);
    res.json(await marketingAnalyticsService.rawFields(query));
  }),
);

// Canonical metrics catalog evaluated against one partner's daily series.
router.get(
  "/partner-metrics",
  requirePermission(...RAW),
  asyncHandler(async (req, res) => {
    const query = partnerMetricsQuerySchema.parse(req.query);
    res.json(await marketingAnalyticsService.partnerMetrics(query));
  }),
);

export default router;
