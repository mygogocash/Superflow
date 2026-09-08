import { Router } from "express";
import multer from "multer";

import { PERMISSIONS } from "@/common/constants/permissions";
import { BadRequestException } from "@/common/exceptions/http-exception";
import { getRequiredParam } from "@/common/utils/params";
import {
  authenticate,
  requireActive,
  requirePermission,
} from "@/core/guards/auth.guard";
import { asyncHandler } from "@/core/middleware/async-handler";
import { MULTIPART_UPLOAD_MAX_BYTES } from "@/infrastructure/storage/supabase-storage";
import { payrollService } from "@/modules/payroll/payroll.service";
import {
  bulkDeletePayslipsSchema,
  consultantInvoiceQuerySchema,
  createConsultantInvoiceSchema,
  createPayrollRunSchema,
  createPayslipSchema,
  hrPayslipQuerySchema,
  payrollRunQuerySchema,
  payslipCompanySchema,
  prepareImportRunSchema,
  updatePayslipSchema,
} from "@/modules/payroll/payroll.validation";
import { payrollApprovalService } from "@/modules/payroll/payroll-approval.service";
import {
  createPayrollApprovalStepSchema,
  reorderPayrollApprovalStepsSchema,
  updatePayrollApprovalStepSchema,
} from "@/modules/payroll/payroll-approval.validation";

const router = Router();

router.use(authenticate, requireActive);

const payslipDocUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MULTIPART_UPLOAD_MAX_BYTES },
});

// Company-wide payslip list/export/download is HR-manager only. Every
// employee seed role holds `payroll:read` for `/my-payslips*`, so gating
// the flat HR surfaces on READ alone was a salary-PII IDOR (Wave 8).
const payrollManage = [
  PERMISSIONS.PAYROLL_CREATE,
  PERMISSIONS.PAYROLL_APPROVE,
  PERMISSIONS.PAYROLL_HR_ADMIN,
] as const;

// ── Employee-facing /my-portal payslip endpoints ──
//
// Mounted ahead of `/runs/...` so the literal `/my-payslips` prefix
// matches before Express considers the run-scoped param routes.

router.get(
  "/my-payslips",
  asyncHandler(async (req, res) => {
    const data = await payrollService.listMyPayslips(req.user!.id);
    res.json({ data });
  }),
);

// HR-only diagnostic for the "empty My Payslip tab" report (Sarah,
// 2026-05-25). `?email=` is required; output shows whether the
// target's Payslip rows exist + which similarly-named users hold
// rows that may have been misbound by an older xlsx import. Use to
// pick the wrong-user.id and rebind via a one-line SQL UPDATE.
router.get(
  "/diagnose-employee",
  requirePermission(PERMISSIONS.PAYROLL_HR_ADMIN),
  asyncHandler(async (req, res) => {
    const email = req.query.email;
    if (typeof email !== "string" || !email.trim()) {
      throw new BadRequestException("Query param `email` is required");
    }
    const data = await payrollService.diagnoseEmployeePayslips(email);
    res.json({ data });
  }),
);

// ── HR-facing flat payslip list (HRMS → Payslip Management) ──
//
// Manager-gated (create/approve/hr-admin). Plain `payroll:read` is only
// enough for `/my-payslips*`. Pagination intentionally omitted in v1:
// the underlying table is small enough to ship the whole filtered set,
// and the HRMS tab applies its own client-side search on top.
router.get(
  "/payslips",
  requirePermission(...payrollManage),
  asyncHandler(async (req, res) => {
    const query = hrPayslipQuerySchema.parse(req.query);
    const data = await payrollService.listPayslipsForHr(query);
    res.json({ data });
  }),
);

// Bulk delete must register BEFORE `/payslips/:id/...` so Express
// matches the literal `bulk-delete` segment instead of routing it
// into the `:id` param handler. Same guard as PDF upload / remove —
// payroll:create scopes who can mutate payslip rows.
router.post(
  "/payslips/bulk-delete",
  requirePermission(PERMISSIONS.PAYROLL_CREATE),
  asyncHandler(async (req, res) => {
    const input = bulkDeletePayslipsSchema.parse(req.body);
    const data = await payrollService.bulkDeletePayslips(input.ids);
    res.json({ data });
  }),
);

// Global company legal block printed in the payslip footer. Literal
// path registered BEFORE `/payslips/:id/...` so Express doesn't route
// "company" into the :id handler. GET is read-wide; PUT is HR-admin.
router.get(
  "/payslips/company",
  requirePermission(PERMISSIONS.PAYROLL_READ),
  asyncHandler(async (_req, res) => {
    const data = await payrollService.getPayslipCompany();
    res.json({ data });
  }),
);
router.put(
  "/payslips/company",
  requirePermission(PERMISSIONS.PAYROLL_HR_ADMIN),
  asyncHandler(async (req, res) => {
    const input = payslipCompanySchema.parse(req.body);
    const data = await payrollService.setPayslipCompany(input);
    res.json({ data });
  }),
);

// HRMS "Export data" — flat payslip list as Excel / CSV, one row per payslip
// with the full breakdown. Same manager gate + filter schema as the list it
// exports. Literal `export` registered BEFORE `/payslips/:id/...` so Express
// doesn't route it into the `:id` param handler.
router.get(
  "/payslips/export",
  requirePermission(...payrollManage),
  asyncHandler(async (req, res) => {
    const query = hrPayslipQuerySchema.parse(req.query);
    const format = req.query.format === "csv" ? "csv" : "xlsx";
    const { buffer, filename, contentType } =
      await payrollService.exportPayslips(query, format);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  }),
);

router.get(
  "/payslips/:id/download",
  requirePermission(...payrollManage),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await payrollService.getPayslipDownloadUrlForHr(id);
    res.json({ data });
  }),
);

// Generate a fresh payslip document on demand (no DB write — purely a
// render of the persisted payroll numbers). Format is picked via the
// query string so a single FE button can switch between Excel / PDF.
router.get(
  "/payslips/:id/export",
  requirePermission(...payrollManage),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const format = req.query.format === "pdf" ? "pdf" : "xlsx";
    const { buffer, filename } = await payrollService.exportPayslipDocument(
      id,
      format,
    );
    res.setHeader(
      "Content-Type",
      format === "pdf"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  }),
);

// Bulk render — zips every payslip in a run as `{period}-{name}.{ext}`
// files. HR clicks "Generate all" to ship a full month at once.
router.get(
  "/runs/:runId/payslips/export",
  requirePermission(...payrollManage),
  asyncHandler(async (req, res) => {
    const runId = getRequiredParam(req.params, "runId");
    const format = req.query.format === "pdf" ? "pdf" : "xlsx";
    const { buffer, filename } = await payrollService.exportRunPayslipsZip(
      runId,
      format,
    );
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  }),
);

router.get(
  "/my-payslips/:id/download",
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await payrollService.getMyPayslipDownloadUrl(req.user!.id, id);
    res.json({ data });
  }),
);

// Employee-facing on-demand export. Streams the generated xlsx / pdf
// when the caller owns the payslip AND the payroll run is in an
// approved / paid status. Draft runs stay hidden because the numbers
// aren't HR-blessed yet.
router.get(
  "/my-payslips/:id/export",
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const format = req.query.format === "xlsx" ? "xlsx" : "pdf";
    const {
      buffer,
      filename,
      protected: isProtected,
    } = await payrollService.exportMyPayslipDocument(req.user!.id, id, format);
    res.setHeader(
      "Content-Type",
      format === "pdf"
        ? "application/pdf"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    // Lets the client confirm whether the file is DOB-protected (false
    // when the employee has no date of birth on file).
    res.setHeader("X-Payslip-Protected", String(isProtected));
    res.send(buffer);
  }),
);

// ── Approval chain (admin-managed) ──
// Mounted ahead of `/runs/...` so the literal prefix matches before
// Express considers any param-based route.

router.get(
  "/approval-chain/steps",
  requirePermission(PERMISSIONS.PAYROLL_HR_ADMIN, PERMISSIONS.PAYROLL_APPROVE),
  asyncHandler(async (_req, res) => {
    const result = await payrollApprovalService.list();
    res.json(result);
  }),
);

router.post(
  "/approval-chain/steps",
  requirePermission(PERMISSIONS.PAYROLL_HR_ADMIN),
  asyncHandler(async (req, res) => {
    const input = createPayrollApprovalStepSchema.parse(req.body);
    const result = await payrollApprovalService.create(input);
    res.status(201).json(result);
  }),
);

router.patch(
  "/approval-chain/steps/:id",
  requirePermission(PERMISSIONS.PAYROLL_HR_ADMIN),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = updatePayrollApprovalStepSchema.parse(req.body);
    const result = await payrollApprovalService.update(id, input);
    res.json(result);
  }),
);

router.delete(
  "/approval-chain/steps/:id",
  requirePermission(PERMISSIONS.PAYROLL_HR_ADMIN),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const result = await payrollApprovalService.delete(id);
    res.json(result);
  }),
);

router.post(
  "/approval-chain/reorder",
  requirePermission(PERMISSIONS.PAYROLL_HR_ADMIN),
  asyncHandler(async (req, res) => {
    const input = reorderPayrollApprovalStepsSchema.parse(req.body);
    const result = await payrollApprovalService.reorder(input);
    res.json(result);
  }),
);

router.get(
  "/runs",
  requirePermission(PERMISSIONS.PAYROLL_READ),
  asyncHandler(async (req, res) => {
    const query = payrollRunQuerySchema.parse(req.query);
    const result = await payrollService.listRuns(
      query,
      req.user!.id,
      req.user!.permissions,
    );
    res.json(result);
  }),
);

router.post(
  "/runs",
  requirePermission(PERMISSIONS.PAYROLL_CREATE),
  asyncHandler(async (req, res) => {
    const input = createPayrollRunSchema.parse(req.body);
    const data = await payrollService.createRun(req.user!.id, input);
    res.status(201).json({ data });
  }),
);

// Literal path must come before `/runs/:id`. The bulk-import wizard hits
// this with parsed spreadsheet rows so the server can infer the entity,
// reuse or create an empty draft run, and hand a runId back.
router.post(
  "/runs/import-prepare",
  requirePermission(PERMISSIONS.PAYROLL_CREATE),
  asyncHandler(async (req, res) => {
    const input = prepareImportRunSchema.parse(req.body);
    const data = await payrollService.prepareRunFromImport(input, req.user!.id);
    res.status(201).json({ data });
  }),
);

router.get(
  "/runs/:id",
  requirePermission(PERMISSIONS.PAYROLL_READ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await payrollService.getRunById(
      id,
      req.user!.id,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

router.put(
  "/runs/:id/approve",
  requirePermission(PERMISSIONS.PAYROLL_APPROVE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await payrollService.approveRun(id, req.user!.id);
    res.json({ data });
  }),
);

// Re-aggregate the headline Total Gross / Tax / Net by FX-converting
// every payslip into the entity currency. Used to backfill runs
// created before the multi-currency fix landed.
router.post(
  "/runs/:id/recalculate-totals",
  requirePermission(PERMISSIONS.PAYROLL_CREATE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await payrollService.recalculateRunTotals(id);
    res.json({ data });
  }),
);

router.delete(
  "/runs/:id",
  requirePermission(PERMISSIONS.PAYROLL_HR_ADMIN),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await payrollService.deleteRun(id);
    res.json({ data });
  }),
);

router.put(
  "/runs/:runId/payslips/:payslipId",
  requirePermission(PERMISSIONS.PAYROLL_CREATE),
  asyncHandler(async (req, res) => {
    const runId = getRequiredParam(req.params, "runId");
    const payslipId = getRequiredParam(req.params, "payslipId");
    const input = updatePayslipSchema.parse(req.body);
    const data = await payrollService.updatePayslip(runId, payslipId, input);
    res.json({ data });
  }),
);

router.post(
  "/runs/:runId/payslips",
  requirePermission(PERMISSIONS.PAYROLL_CREATE),
  asyncHandler(async (req, res) => {
    const runId = getRequiredParam(req.params, "runId");
    const input = createPayslipSchema.parse(req.body);
    const data = await payrollService.createPayslip(runId, input);
    res.status(201).json({ data });
  }),
);

router.post(
  "/runs/:runId/payslips/:payslipId/document",
  requirePermission(PERMISSIONS.PAYROLL_CREATE),
  payslipDocUpload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      res.status(400).json({
        error: {
          code: "INVALID_INPUT",
          message:
            'No file uploaded. Send multipart/form-data with field "file".',
        },
      });
      return;
    }
    const runId = getRequiredParam(req.params, "runId");
    const payslipId = getRequiredParam(req.params, "payslipId");
    const data = await payrollService.attachPayslipDocument(
      runId,
      payslipId,
      req.user!.id,
      {
        buffer: req.file.buffer,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size,
      },
    );
    res.json({ data });
  }),
);

router.delete(
  "/runs/:runId/payslips/:payslipId/document",
  requirePermission(PERMISSIONS.PAYROLL_CREATE),
  asyncHandler(async (req, res) => {
    const runId = getRequiredParam(req.params, "runId");
    const payslipId = getRequiredParam(req.params, "payslipId");
    const data = await payrollService.removePayslipDocument(runId, payslipId);
    res.json({ data });
  }),
);

router.post(
  "/runs/:runId/payslips/import/preview",
  requirePermission(PERMISSIONS.PAYROLL_CREATE),
  asyncHandler(async (req, res) => {
    const runId = getRequiredParam(req.params, "runId");
    const { rows } = req.body as { rows: Array<Record<string, unknown>> };
    if (!Array.isArray(rows) || rows.length === 0) {
      res.status(400).json({
        error: { code: "INVALID_INPUT", message: "rows array is required" },
      });
      return;
    }
    const result = await payrollService.previewPayslipImport(runId, rows);
    res.json({ data: result });
  }),
);

router.post(
  "/runs/:runId/payslips/import/commit",
  requirePermission(PERMISSIONS.PAYROLL_CREATE),
  asyncHandler(async (req, res) => {
    const runId = getRequiredParam(req.params, "runId");
    const { rows } = req.body as { rows: Array<Record<string, unknown>> };
    if (!Array.isArray(rows) || rows.length === 0) {
      res.status(400).json({
        error: { code: "INVALID_INPUT", message: "rows array is required" },
      });
      return;
    }
    const result = await payrollService.commitPayslipImport(runId, rows);
    res.json({ data: result });
  }),
);

router.get(
  "/consultants",
  requirePermission(PERMISSIONS.PAYROLL_READ),
  asyncHandler(async (req, res) => {
    const query = consultantInvoiceQuerySchema.parse(req.query);
    const result = await payrollService.listConsultantInvoices(
      query,
      req.user!.id,
      req.user!.permissions,
    );
    res.json(result);
  }),
);

router.post(
  "/consultants",
  requirePermission(PERMISSIONS.PAYROLL_CREATE),
  asyncHandler(async (req, res) => {
    const input = createConsultantInvoiceSchema.parse(req.body);
    const data = await payrollService.createConsultantInvoice(input);
    res.status(201).json({ data });
  }),
);

router.post(
  "/import/preview",
  requirePermission(PERMISSIONS.PAYROLL_HR_ADMIN),
  asyncHandler(async (req, res) => {
    const { rows } = req.body as { rows: Array<Record<string, unknown>> };
    if (!Array.isArray(rows) || rows.length === 0) {
      res.status(400).json({
        error: { code: "INVALID_INPUT", message: "rows array is required" },
      });
      return;
    }
    const result = await payrollService.previewImport(rows);
    res.json({ data: result });
  }),
);

router.post(
  "/import/commit",
  requirePermission(PERMISSIONS.PAYROLL_HR_ADMIN),
  asyncHandler(async (req, res) => {
    const { rows } = req.body as { rows: Array<Record<string, unknown>> };
    if (!Array.isArray(rows) || rows.length === 0) {
      res.status(400).json({
        error: { code: "INVALID_INPUT", message: "rows array is required" },
      });
      return;
    }
    const result = await payrollService.commitImport(rows, req.user!.id);
    res.json({ data: result });
  }),
);

export default router;
