import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { PERMISSIONS } from "@nexora/contracts";
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
} from "@nexora/contracts/modules/payroll/payroll.validation";
import {
  createPayrollApprovalStepSchema,
  reorderPayrollApprovalStepsSchema,
  updatePayrollApprovalStepSchema,
} from "@nexora/contracts/modules/payroll/payroll-approval.validation";
import { payrollApprovalService, payrollService } from "@nexora/core";
import type { AppEnv } from "../lib/context";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import { BadRequestException, NotFoundException } from "../lib/errors";

const MULTIPART_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;

function r2Storage(c: { env: AppEnv["Bindings"] }) {
  return {
    async put(key: string, bytes: Uint8Array, contentType: string) {
      await c.env.R2_PRIVATE.put(key, bytes, { httpMetadata: { contentType } });
    },
    async delete(key: string) {
      await c.env.R2_PRIVATE.delete(key);
    },
  };
}

const importRowsSchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())).min(1),
});

const diagnoseQuerySchema = z.object({
  email: z.string().min(1),
});

// Company-wide payslip list/export/download is HR-manager only. Every employee
// seed role holds `payroll:read` for `/my-payslips*`, so gating the flat HR
// surfaces on READ alone was a salary-PII IDOR (Wave 8).
const payrollManage = [
  PERMISSIONS.PAYROLL_CREATE,
  PERMISSIONS.PAYROLL_APPROVE,
  PERMISSIONS.PAYROLL_HR_ADMIN,
] as const;

export const payroll = new Hono<AppEnv>()
  .get("/my-payslips", requireAuth, async (c) => {
    const data = await payrollService.listMyPayslips(c.var.db, c.var.user!.id);
    return c.json({ data });
  })
  .get(
    "/diagnose-employee",
    requirePermission(PERMISSIONS.PAYROLL_HR_ADMIN),
    zValidator("query", diagnoseQuerySchema),
    async (c) => {
      const data = await payrollService.diagnoseEmployeePayslips(
        c.var.db,
        c.req.valid("query").email,
      );
      return c.json({ data });
    },
  )
  .get(
    "/payslips",
    requirePermission(...payrollManage),
    zValidator("query", hrPayslipQuerySchema),
    async (c) => {
      const data = await payrollService.listPayslipsForHr(c.var.db, c.req.valid("query"));
      return c.json({ data });
    },
  )
  .post(
    "/payslips/bulk-delete",
    requirePermission(PERMISSIONS.PAYROLL_CREATE),
    zValidator("json", bulkDeletePayslipsSchema),
    async (c) => {
      const data = await payrollService.bulkDeletePayslips(
        c.var.db,
        c.req.valid("json").ids,
        r2Storage(c),
      );
      return c.json({ data });
    },
  )
  .get(
    "/payslips/company",
    requirePermission(PERMISSIONS.PAYROLL_READ),
    async (c) => {
      const data = await payrollService.getPayslipCompany(c.var.db);
      return c.json({ data });
    },
  )
  .put(
    "/payslips/company",
    requirePermission(PERMISSIONS.PAYROLL_HR_ADMIN),
    zValidator("json", payslipCompanySchema),
    async (c) => {
      const data = await payrollService.setPayslipCompany(c.var.db, c.req.valid("json"));
      return c.json({ data });
    },
  )
  .get(
    "/payslips/export",
    requirePermission(...payrollManage),
    zValidator("query", hrPayslipQuerySchema),
    async (c) => {
      const query = c.req.valid("query");
      const format = c.req.query("format") === "csv" ? "csv" : "xlsx";
      const { buffer, filename, contentType } = await payrollService.exportPayslips(
        c.var.db,
        query,
        format,
      );
      return new Response(buffer, {
        headers: {
          "Content-Type": contentType,
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      });
    },
  )
  .get(
    "/payslips/:id/download",
    requirePermission(...payrollManage),
    async (c) => {
      const data = await payrollService.getPayslipDownloadUrlForHr(c.var.db, c.req.param("id"));
      return c.json({ data });
    },
  )
  .get(
    "/payslips/:id/export",
    requirePermission(...payrollManage),
    async (c) => {
      const id = c.req.param("id");
      const format = c.req.query("format") === "pdf" ? "pdf" : "xlsx";
      const { buffer, filename } = await payrollService.exportPayslipDocument(
        c.var.db,
        id,
        format,
      );
      return new Response(buffer, {
        headers: {
          "Content-Type":
            format === "pdf"
              ? "application/pdf"
              : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      });
    },
  )
  .get(
    "/payslips/:id/file",
    requirePermission(...payrollManage),
    async (c) => {
      const { key, filename } = await payrollService.resolvePayslipDocumentStream(
        c.var.db,
        c.req.param("id"),
      );
      const obj = await c.env.R2_PRIVATE.get(key);
      if (!obj) throw new NotFoundException("Payslip file is not available");
      return new Response(obj.body, {
        headers: {
          "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream",
          "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
        },
      });
    },
  )
  .get(
    "/runs/:runId/payslips/export",
    requirePermission(...payrollManage),
    async (c) => {
      const runId = c.req.param("runId");
      const format = c.req.query("format") === "pdf" ? "pdf" : "xlsx";
      const { buffer, filename } = await payrollService.exportRunPayslipsZip(
        c.var.db,
        runId,
        format,
      );
      return new Response(buffer, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      });
    },
  )
  .get("/my-payslips/:id/download", requireAuth, async (c) => {
    const data = await payrollService.getMyPayslipDownloadUrl(
      c.var.db,
      c.var.user!.id,
      c.req.param("id"),
    );
    return c.json({ data });
  })
  .get("/my-payslips/:id/export", requireAuth, async (c) => {
    const id = c.req.param("id");
    const format = c.req.query("format") === "xlsx" ? "xlsx" : "pdf";
    const { buffer, filename, protected: isProtected } =
      await payrollService.exportMyPayslipDocument(c.var.db, c.var.user!.id, id, format);
    return new Response(buffer, {
      headers: {
        "Content-Type":
          format === "pdf"
            ? "application/pdf"
            : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "X-Payslip-Protected": String(isProtected),
      },
    });
  })
  .get("/my-payslips/:id/file", requireAuth, async (c) => {
    const payslipId = c.req.param("id");
    const { key, filename } = await payrollService.resolvePayslipDocumentStream(
      c.var.db,
      payslipId,
      { employeeId: c.var.user!.id },
    );
    const obj = await c.env.R2_PRIVATE.get(key);
    if (!obj) throw new NotFoundException("Payslip file is not available");
    return new Response(obj.body, {
      headers: {
        "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream",
        "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
      },
    });
  })
  .get(
    "/approval-chain/steps",
    requirePermission(PERMISSIONS.PAYROLL_HR_ADMIN, PERMISSIONS.PAYROLL_APPROVE),
    async (c) => c.json(await payrollApprovalService.list(c.var.db)),
  )
  .post(
    "/approval-chain/steps",
    requirePermission(PERMISSIONS.PAYROLL_HR_ADMIN),
    zValidator("json", createPayrollApprovalStepSchema),
    async (c) => {
      const result = await payrollApprovalService.create(c.var.db, c.req.valid("json"));
      return c.json(result, 201);
    },
  )
  .patch(
    "/approval-chain/steps/:id",
    requirePermission(PERMISSIONS.PAYROLL_HR_ADMIN),
    zValidator("json", updatePayrollApprovalStepSchema),
    async (c) => {
      const result = await payrollApprovalService.update(
        c.var.db,
        c.req.param("id"),
        c.req.valid("json"),
      );
      return c.json(result);
    },
  )
  .delete(
    "/approval-chain/steps/:id",
    requirePermission(PERMISSIONS.PAYROLL_HR_ADMIN),
    async (c) => c.json(await payrollApprovalService.deleteStep(c.var.db, c.req.param("id"))),
  )
  .post(
    "/approval-chain/reorder",
    requirePermission(PERMISSIONS.PAYROLL_HR_ADMIN),
    zValidator("json", reorderPayrollApprovalStepsSchema),
    async (c) => {
      const result = await payrollApprovalService.reorder(c.var.db, c.req.valid("json"));
      return c.json(result);
    },
  )
  .get(
    "/runs",
    requirePermission(PERMISSIONS.PAYROLL_READ),
    zValidator("query", payrollRunQuerySchema),
    async (c) => {
      const result = await payrollService.listRuns(
        c.var.db,
        c.req.valid("query"),
        c.var.user!.id,
        c.var.user!.permissions,
      );
      return c.json(result);
    },
  )
  .post(
    "/runs",
    requirePermission(PERMISSIONS.PAYROLL_CREATE),
    zValidator("json", createPayrollRunSchema),
    async (c) => {
      const data = await payrollService.createRun(c.var.db, c.var.user!.id, c.req.valid("json"));
      return c.json({ data }, 201);
    },
  )
  .post(
    "/runs/import-prepare",
    requirePermission(PERMISSIONS.PAYROLL_CREATE),
    zValidator("json", prepareImportRunSchema),
    async (c) => {
      const data = await payrollService.prepareRunFromImport(
        c.var.db,
        c.req.valid("json"),
        c.var.user!.id,
      );
      return c.json({ data }, 201);
    },
  )
  .get(
    "/runs/:id",
    requirePermission(PERMISSIONS.PAYROLL_READ),
    async (c) => {
      const data = await payrollService.getRunById(
        c.var.db,
        c.req.param("id"),
        c.var.user!.id,
        c.var.user!.permissions,
      );
      return c.json({ data });
    },
  )
  .put(
    "/runs/:id/approve",
    requirePermission(PERMISSIONS.PAYROLL_APPROVE),
    async (c) => {
      const data = await payrollService.approveRun(c.var.db, c.req.param("id"), c.var.user!.id);
      return c.json({ data });
    },
  )
  .post(
    "/runs/:id/recalculate-totals",
    requirePermission(PERMISSIONS.PAYROLL_CREATE),
    async (c) => {
      const data = await payrollService.recalculateRunTotals(c.var.db, c.req.param("id"));
      return c.json({ data });
    },
  )
  .delete(
    "/runs/:id",
    requirePermission(PERMISSIONS.PAYROLL_HR_ADMIN),
    async (c) => {
      const data = await payrollService.deleteRun(c.var.db, c.req.param("id"));
      return c.json({ data });
    },
  )
  .put(
    "/runs/:runId/payslips/:payslipId",
    requirePermission(PERMISSIONS.PAYROLL_CREATE),
    zValidator("json", updatePayslipSchema),
    async (c) => {
      const data = await payrollService.updatePayslip(
        c.var.db,
        c.req.param("runId"),
        c.req.param("payslipId"),
        c.req.valid("json"),
      );
      return c.json({ data });
    },
  )
  .post(
    "/runs/:runId/payslips",
    requirePermission(PERMISSIONS.PAYROLL_CREATE),
    zValidator("json", createPayslipSchema),
    async (c) => {
      const data = await payrollService.createPayslip(
        c.var.db,
        c.req.param("runId"),
        c.req.valid("json"),
      );
      return c.json({ data }, 201);
    },
  )
  .post("/runs/:runId/payslips/:payslipId/document", requirePermission(PERMISSIONS.PAYROLL_CREATE), async (c) => {
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new BadRequestException(
        'No file uploaded. Send multipart/form-data with field "file".',
      );
    }
    if (file.size > MULTIPART_UPLOAD_MAX_BYTES) {
      throw new BadRequestException("File exceeds maximum upload size");
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const data = await payrollService.attachPayslipDocument(
      c.var.db,
      c.req.param("runId"),
      c.req.param("payslipId"),
      c.var.user!.id,
      {
        bytes,
        originalName: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
      },
      r2Storage(c),
    );
    return c.json({ data });
  })
  .delete(
    "/runs/:runId/payslips/:payslipId/document",
    requirePermission(PERMISSIONS.PAYROLL_CREATE),
    async (c) => {
      const data = await payrollService.removePayslipDocument(
        c.var.db,
        c.req.param("runId"),
        c.req.param("payslipId"),
        r2Storage(c),
      );
      return c.json({ data });
    },
  )
  .post(
    "/runs/:runId/payslips/import/preview",
    requirePermission(PERMISSIONS.PAYROLL_CREATE),
    zValidator("json", importRowsSchema),
    async (c) => {
      const result = await payrollService.previewPayslipImport(
        c.var.db,
        c.req.param("runId"),
        c.req.valid("json").rows,
      );
      return c.json({ data: result });
    },
  )
  .post(
    "/runs/:runId/payslips/import/commit",
    requirePermission(PERMISSIONS.PAYROLL_CREATE),
    zValidator("json", importRowsSchema),
    async (c) => {
      const result = await payrollService.commitPayslipImport(
        c.var.db,
        c.req.param("runId"),
        c.req.valid("json").rows,
      );
      return c.json({ data: result });
    },
  )
  .get(
    "/consultants",
    requirePermission(PERMISSIONS.PAYROLL_READ),
    zValidator("query", consultantInvoiceQuerySchema),
    async (c) => {
      const result = await payrollService.listConsultantInvoices(
        c.var.db,
        c.req.valid("query"),
        c.var.user!.id,
        c.var.user!.permissions,
      );
      return c.json(result);
    },
  )
  .post(
    "/consultants",
    requirePermission(PERMISSIONS.PAYROLL_CREATE),
    zValidator("json", createConsultantInvoiceSchema),
    async (c) => {
      const data = await payrollService.createConsultantInvoice(c.var.db, c.req.valid("json"));
      return c.json({ data }, 201);
    },
  )
  .post(
    "/import/preview",
    requirePermission(PERMISSIONS.PAYROLL_HR_ADMIN),
    zValidator("json", importRowsSchema),
    async (c) => {
      const result = await payrollService.previewImport(c.var.db, c.req.valid("json").rows);
      return c.json({ data: result });
    },
  )
  .post(
    "/import/commit",
    requirePermission(PERMISSIONS.PAYROLL_HR_ADMIN),
    zValidator("json", importRowsSchema),
    async (c) => {
      const result = await payrollService.commitImport(
        c.var.db,
        c.req.valid("json").rows,
        c.var.user!.id,
      );
      return c.json({ data: result });
    },
  );
