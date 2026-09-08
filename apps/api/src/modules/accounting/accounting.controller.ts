import { Router } from "express";

import { PERMISSIONS } from "@/common/constants/permissions";
import { BadRequestException } from "@/common/exceptions/http-exception";
import { logger } from "@/common/utils/logger";
import { getRequiredParam } from "@/common/utils/params";
import {
  authenticate,
  requireActive,
  requirePermission,
} from "@/core/guards/auth.guard";
import { asyncHandler } from "@/core/middleware/async-handler";
import { logAudit } from "@/infrastructure/audit/audit.service";
import { isFixedAssetsEnabled } from "@/modules/accounting/accounting.flags";
import { accountingService } from "@/modules/accounting/accounting.service";
import {
  accountingSearchQuerySchema,
  accountMappingQuerySchema,
  accountQuerySchema,
  accountReuseCheckSchema,
  activateCompanySchema,
  agingSummaryQuerySchema,
  applyAdvanceSchema,
  auditLogQuerySchema,
  bankAccountQuerySchema,
  bankMatchQuerySchema,
  bankTransactionQuerySchema,
  bulkDeleteJournalsSchema,
  bulkRejectJournalsSchema,
  bulkReviewJournalsSchema,
  cancelJournalSchema,
  closePeriodSchema,
  companyProfileQuerySchema,
  corporateOverviewQuerySchema,
  createAccountSchema,
  createBankAccountSchema,
  createCreditNoteSchema,
  createEntityTaxRateSchema,
  createFixedAssetCategorySchema,
  createFixedAssetCountSessionSchema,
  createFixedAssetSchema,
  createInvoiceSchema,
  createJournalSchema,
  createPurchaseOrderSchema,
  createQuoteSchema,
  creditNoteQuerySchema,
  customerAdvanceQuerySchema,
  entityTaxRateQuerySchema,
  expenseSummaryQuerySchema,
  fileTaxSchema,
  fiscalPeriodQuerySchema,
  fixedAssetCategoryQuerySchema,
  fixedAssetCountSessionQuerySchema,
  fixedAssetDepreciationRunSchema,
  fixedAssetDisposalQuerySchema,
  fixedAssetPeriodReportQuerySchema,
  fixedAssetQuerySchema,
  fixedAssetRemeasurementQuerySchema,
  fixedAssetReportQuerySchema,
  fixedAssetScheduleQuerySchema,
  fixedAssetTransferQuerySchema,
  importAccountsSchema,
  importBankStatementSchema,
  importFixedAssetsSchema,
  importJournalsSchema,
  importOpeningBalancesSchema,
  invoiceCompanySchema,
  invoiceQuerySchema,
  journalQuerySchema,
  makerCheckerConfigSchema,
  mergeVendorsSchema,
  openingBalancesQuerySchema,
  paymentListQuerySchema,
  paymentRunSchema,
  postingReadinessQuerySchema,
  prepaymentTaxInvoiceSchema,
  purchaseOrderQuerySchema,
  quoteQuerySchema,
  receivePurchaseOrderSchema,
  reconcileTransactionSchema,
  reconciliationSummaryQuerySchema,
  recordAllocatedPaymentSchema,
  recordPaymentSchema,
  refundAdvanceSchema,
  rejectFixedAssetDisposalSchema,
  rejectFixedAssetRemeasurementSchema,
  rejectFixedAssetTransferSchema,
  rejectJournalSchema,
  reopenPeriodSchema,
  reopenTaxSchema,
  reportAsOfQuerySchema,
  reportPeriodQuerySchema,
  revaluePeriodSchema,
  secondApprovalConfigSchema,
  secondApprovalDecisionSchema,
  settleBankTransactionSchema,
  statementQuerySchema,
  submitFixedAssetCountLineSchema,
  submitFixedAssetDisposalSchema,
  submitFixedAssetRemeasurementSchema,
  submitFixedAssetTransferSchema,
  supplierSummaryQuerySchema,
  taxCodesQuerySchema,
  taxFilingQuerySchema,
  taxReportQuerySchema,
  updateAccountSchema,
  updateBankAccountSchema,
  updateCompanyProfileSchema,
  updateEntityTaxRateSchema,
  updateFixedAssetCategorySchema,
  updateFixedAssetSchema,
  updateInvoiceSchema,
  updateInvoiceStatusSchema,
  updateJournalSchema,
  updateQuoteSchema,
  updateTaxCodeSchema,
  upsertAccountMappingSchema,
  upsertTaxCodeSchema,
  vendorMergePreviewQuerySchema,
} from "@/modules/accounting/accounting.validation";
import { buildInvoiceDocxBuffer } from "@/modules/accounting/invoice-docx-generator";
import { buildInvoicePdfBuffer } from "@/modules/accounting/invoice-generator";
import {
  computeInvoiceTotals,
  toInvoiceDoc,
} from "@/modules/accounting/invoice-shared";
import { buildInvoiceXlsxBuffer } from "@/modules/accounting/invoice-xlsx-generator";

// Shared helper: fetch an invoice + the company block and normalize into the
// generator document shape + totals. Used by the PDF + DOCX routes. Owner-
// scoped via getInvoiceByIdForActor so a document download can't bypass the
// same visibility rule as GET /invoices/:id.
async function loadInvoiceDocument(
  id: string,
  actorId: string,
  permissions: string[],
) {
  const [invoice, company] = await Promise.all([
    accountingService.getInvoiceByIdForActor(id, actorId, permissions),
    accountingService.getInvoiceCompany(),
  ]);
  const document = toInvoiceDoc(invoice);
  const totals = computeInvoiceTotals(
    document.lineItems.map((li) => ({
      quantity: li.quantity,
      unitPrice: li.unitPrice,
    })),
    document.vatRate,
    document.whtRate,
    document.taxRate,
  );
  return { document, company, totals, invoiceNo: document.invoiceNo };
}

const router = Router();

router.use(authenticate, requireActive);

router.get(
  "/overview",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const query = corporateOverviewQuerySchema.parse(req.query);
    const data = await accountingService.getCorporateOverview(query);
    res.json({ data });
  }),
);

// ── GL posting readiness + account-role mapping (foundation) ───────────────
// The account_mappings table routes each posting role (ar_control, revenue,
// vat_output, …) to a concrete GL account per entity. This is config only:
// automatic GL posting is wired in a later milestone and stays gated on the
// ACCOUNTING_GL_POSTING flag AND a complete mapping (see /posting-readiness),
// so an incomplete mapping surfaces as "not ready" rather than mis-posting.
router.get(
  "/account-mappings",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const { entityId } = accountMappingQuerySchema.parse(req.query);
    const data = await accountingService.getAccountMappings(entityId);
    res.json({ data });
  }),
);

// Mapping config is an admin-only change to how the ledger will post.
router.put(
  "/account-mappings",
  requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
  asyncHandler(async (req, res) => {
    const input = upsertAccountMappingSchema.parse(req.body);
    const data = await accountingService.setAccountMapping(input);
    void logAudit({
      action: "upsert",
      resource: "account_mapping",
      details: {
        entityId: input.entityId,
        role: input.role,
        chartOfAccountId: input.chartOfAccountId ?? null,
      },
      req,
    });
    res.json({ data });
  }),
);

router.get(
  "/posting-readiness",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const { entityId } = postingReadinessQuerySchema.parse(req.query);
    const data = await accountingService.getPostingReadiness(entityId);
    res.json({ data });
  }),
);

// ── Company setup, fiscal year & activation gate (Chunk 2) ──────────────────
// Entity-scoped company profile (details + fiscal-year config + activation
// gate). Reads on ACCOUNTING_READ, writes on ACCOUNTING_ADMIN. Literal paths
// registered before any `:param` route.
router.get(
  "/company-setup",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const { entityId } = companyProfileQuerySchema.parse(req.query);
    const data = await accountingService.getCompanyProfile(entityId);
    res.json({ data });
  }),
);

router.put(
  "/company-setup",
  requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
  asyncHandler(async (req, res) => {
    const input = updateCompanyProfileSchema.parse(req.body);
    const data = await accountingService.updateCompanyProfile(input);
    void logAudit({
      action: "update",
      resource: "company_setup",
      details: { entityId: input.entityId },
      req,
    });
    res.json({ data });
  }),
);

// Flip the entity "setup" → "active" once prerequisites hold. Idempotent when
// already active.
router.post(
  "/company-setup/activate",
  requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
  asyncHandler(async (req, res) => {
    const input = activateCompanySchema.parse(req.body);
    const data = await accountingService.activateCompany(input);
    void logAudit({
      action: "activate",
      resource: "company_setup",
      details: { entityId: input.entityId, activated: data.activated },
      req,
    });
    res.json({ data });
  }),
);

// ── Opening-balance import (Chunk 6 · M0.1.9) ──────────────────────────────
// Post ONE dated opening journal entry that ties a newly set-up entity's books
// to its prior-year closing figures. Entity-scoped, admin-only. Reads report
// whether an opening entry already exists (so the setup UI can show status).
// Literal /opening-balances routes registered here, before any `:id` route.
router.get(
  "/opening-balances",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const query = openingBalancesQuerySchema.parse(req.query);
    const data = await accountingService.getOpeningBalanceStatus(query);
    res.json({ data });
  }),
);

router.post(
  "/opening-balances",
  requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
  asyncHandler(async (req, res) => {
    const input = importOpeningBalancesSchema.parse(req.body);
    const data = await accountingService.importOpeningBalances(
      req.user!.id,
      input,
    );
    void logAudit({
      action: "import",
      resource: "accounting_opening_balances",
      resourceId: data.entryId,
      details: {
        entityId: input.entityId,
        entryNo: data.entryNo,
        asOfDate: data.asOfDate,
      },
      req,
    });
    res.status(201).json({ data });
  }),
);

// ── Maker-checker config (block self-approval of journals) ─────────────────
// Default OFF — reading returns { blockSelfApproval: false } until an admin
// enables it. Literal routes, registered before any `:id` route.
router.get(
  "/maker-checker",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (_req, res) => {
    const data = await accountingService.getMakerCheckerConfig();
    res.json({ data });
  }),
);

router.put(
  "/maker-checker",
  requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
  asyncHandler(async (req, res) => {
    const input = makerCheckerConfigSchema.parse(req.body);
    const data = await accountingService.setMakerCheckerConfig(input);
    void logAudit({
      action: "update",
      resource: "accounting_maker_checker",
      details: { blockSelfApproval: input.blockSelfApproval },
      req,
    });
    res.json({ data });
  }),
);

// ── Tax codes (Thai VAT + WHT config) ──────────────────────────────────────
// Entity-scoped config. Reads gated like other accounting reads; writes on the
// admin permission. Literal /tax-codes routes before /tax-codes/:id.
router.get(
  "/tax-codes",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const query = taxCodesQuerySchema.parse(req.query);
    const data = await accountingService.listTaxCodes(query);
    res.json({ data });
  }),
);

router.post(
  "/tax-codes",
  requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
  asyncHandler(async (req, res) => {
    const input = upsertTaxCodeSchema.parse(req.body);
    const data = await accountingService.createTaxCode(input);
    void logAudit({
      action: "create",
      resource: "tax_code",
      resourceId: data.id,
      details: { entityId: input.entityId, code: input.code, kind: input.kind },
      req,
    });
    res.status(201).json({ data });
  }),
);

router.get(
  "/tax-codes/:id",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await accountingService.getTaxCodeById(id);
    res.json({ data });
  }),
);

router.put(
  "/tax-codes/:id",
  requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = updateTaxCodeSchema.parse(req.body);
    const data = await accountingService.updateTaxCode(id, input);
    void logAudit({
      action: "update",
      resource: "tax_code",
      resourceId: id,
      req,
    });
    res.json({ data });
  }),
);

router.delete(
  "/tax-codes/:id",
  requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await accountingService.deleteTaxCode(id);
    void logAudit({
      action: "delete",
      resource: "tax_code",
      resourceId: id,
      req,
    });
    res.json({ data });
  }),
);

router.get(
  "/accounts",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const query = accountQuerySchema.parse(req.query);
    const data = await accountingService.listAccounts(query);
    res.json({ data });
  }),
);

router.post(
  "/accounts",
  requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
  asyncHandler(async (req, res) => {
    const input = createAccountSchema.parse(req.body);
    const data = await accountingService.createAccount(input, req.user!.id);
    res.status(201).json({ data });
  }),
);

// Bulk import for Chart of Accounts — preview + commit. Frontend parses
// the accounting-export xlsx locally and POSTs canonical rows. Literal
// paths must come before `/accounts/:id` or Express will route
// "/accounts/import" through the :id handler and 404.
router.post(
  "/accounts/import/preview",
  requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
  asyncHandler(async (req, res) => {
    const input = importAccountsSchema.parse(req.body);
    const data = await accountingService.previewAccountImport(input);
    res.json({ data });
  }),
);

router.post(
  "/accounts/import/commit",
  requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
  asyncHandler(async (req, res) => {
    const input = importAccountsSchema.parse(req.body);
    const data = await accountingService.commitAccountImport(input);
    res.status(201).json({ data });
  }),
);

// Preflight for the account form: does this code / English name land on a
// DEACTIVATED account, and would that warn or block? Read-only — the save path
// re-runs the same rules. Literal path, so it must stay above "/accounts/:id".
router.post(
  "/accounts/reuse-check",
  requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
  asyncHandler(async (req, res) => {
    const input = accountReuseCheckSchema.parse(req.body);
    const data = await accountingService.checkInactiveReuse(input);
    res.json({ data });
  }),
);

// Auditor report: every account created on a deactivated account's code or
// English name, with the predecessor and who accepted the reuse.
router.get(
  "/accounts/reused-codes",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const entityId =
      typeof req.query.entityId === "string" ? req.query.entityId : undefined;
    const data = await accountingService.listReusedAccountCodes(entityId);
    res.json({ data });
  }),
);

router.get(
  "/accounts/:id",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await accountingService.getAccountById(id);
    res.json({ data });
  }),
);

router.put(
  "/accounts/:id",
  requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = updateAccountSchema.parse(req.body);
    const data = await accountingService.updateAccount(id, input, req.user!.id);
    res.json({ data });
  }),
);

router.delete(
  "/accounts/:id",
  requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    await accountingService.deleteAccount(id);
    res.json({ data: { success: true } });
  }),
);

// Monthly reversal report. Literal path, so it must stay above "/journals/:id".
router.get(
  "/journals/reversals",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const query = reportPeriodQuerySchema.parse(req.query);
    const data = await accountingService.listJournalReversals(query);
    res.json({ data });
  }),
);

router.get(
  "/journals",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const query = journalQuerySchema.parse(req.query);
    const result = await accountingService.listJournals(
      query,
      req.user!.id,
      req.user!.permissions,
    );
    res.json(result);
  }),
);

router.post(
  "/journals",
  requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
  asyncHandler(async (req, res) => {
    const input = createJournalSchema.parse(req.body);
    const data = await accountingService.createJournal(req.user!.id, input);
    res.status(201).json({ data });
  }),
);

// Journal-entry bulk import — preview + commit. Literal paths must come
// before `/journals/:id` or Express routes them through the :id handler.
router.post(
  "/journals/import/preview",
  requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
  asyncHandler(async (req, res) => {
    const input = importJournalsSchema.parse(req.body);
    const data = await accountingService.previewJournalImport(input);
    res.json({ data });
  }),
);

router.post(
  "/journals/import/commit",
  requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
  asyncHandler(async (req, res) => {
    const input = importJournalsSchema.parse(req.body);
    const data = await accountingService.commitJournalImport(
      req.user!.id,
      input,
    );
    res.status(201).json({ data });
  }),
);

// Bulk delete must be a POST (request body) and must come BEFORE
// `/journals/:id` so Express doesn't route the literal segment into the
// param handler.
router.post(
  "/journals/bulk-delete",
  requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
  asyncHandler(async (req, res) => {
    const input = bulkDeleteJournalsSchema.parse(req.body);
    const data = await accountingService.bulkDeleteJournals(input);
    void logAudit({
      action: "soft_delete",
      resource: "journal_entry",
      details: {
        mode: data.mode,
        deletedCount: data.deletedCount,
        requestedIds: input.ids?.length ?? 0,
        deleteAll: input.all === true,
      },
      req,
    });
    logger.info(
      `Accounting journals bulk-delete: mode=${data.mode}, deleted=${data.deletedCount} by ${req.user!.email}`,
    );
    res.json({ data });
  }),
);

router.post(
  "/journals/bulk-approve",
  requirePermission(PERMISSIONS.ACCOUNTING_APPROVE),
  asyncHandler(async (req, res) => {
    const input = bulkReviewJournalsSchema.parse(req.body);
    const data = await accountingService.bulkApproveJournals(
      input.ids,
      req.user!.id,
    );
    res.json({ data });
  }),
);

router.post(
  "/journals/bulk-reject",
  requirePermission(PERMISSIONS.ACCOUNTING_APPROVE),
  asyncHandler(async (req, res) => {
    const input = bulkRejectJournalsSchema.parse(req.body);
    const data = await accountingService.bulkRejectJournals(
      input.ids,
      req.user!.id,
      input.reason,
    );
    res.json({ data });
  }),
);

router.get(
  "/journals/:id",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await accountingService.getJournalByIdForActor(
      id,
      req.user!.id,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

router.put(
  "/journals/:id",
  requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = updateJournalSchema.parse(req.body);
    const data = await accountingService.updateJournal(
      id,
      input,
      req.user!.id,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

// Restore a soft-deleted journal. Same gate as delete; registered before the
// `:id` DELETE so route order stays predictable.
router.post(
  "/journals/:id/restore",
  requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await accountingService.restoreJournal(
      id,
      req.user!.id,
      req.user!.permissions,
    );
    void logAudit({
      action: "restore",
      resource: "journal_entry",
      resourceId: id,
      req,
    });
    res.json({ data });
  }),
);

router.delete(
  "/journals/:id",
  requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    await accountingService.deleteJournal(
      id,
      req.user!.id,
      req.user!.permissions,
    );
    void logAudit({
      action: "soft_delete",
      resource: "journal_entry",
      resourceId: id,
      req,
    });
    res.json({ data: { success: true } });
  }),
);

router.put(
  "/journals/:id/approve",
  requirePermission(PERMISSIONS.ACCOUNTING_APPROVE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await accountingService.approveJournal(id, req.user!.id);
    res.json({ data });
  }),
);

router.put(
  "/journals/:id/reject",
  requirePermission(PERMISSIONS.ACCOUNTING_APPROVE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = rejectJournalSchema.parse(req.body);
    const data = await accountingService.rejectJournal(
      id,
      req.user!.id,
      input.reason,
    );
    res.json({ data });
  }),
);

router.put(
  "/journals/:id/post",
  requirePermission(PERMISSIONS.ACCOUNTING_POST),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await accountingService.postJournal(id);
    res.json({ data });
  }),
);

router.put(
  "/journals/:id/cancel",
  requirePermission(PERMISSIONS.ACCOUNTING_POST),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = cancelJournalSchema.parse(req.body);
    const data = await accountingService.cancelJournal(id, req.user!.id, input);
    void logAudit({
      action: "update",
      resource: "journal_entry",
      resourceId: id,
      details: { status: data.status, reason: input.reason },
      req,
    });
    res.json({ data });
  }),
);

router.get(
  "/vendors/duplicate-suggestions",
  requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
  asyncHandler(async (req, res) => {
    const entityId =
      typeof req.query.entityId === "string" ? req.query.entityId : undefined;
    const data =
      await accountingService.listVendorDuplicateSuggestions(entityId);
    res.json({ data });
  }),
);

router.get(
  "/vendors/merge-preview",
  requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
  asyncHandler(async (req, res) => {
    const query = vendorMergePreviewQuerySchema.parse(req.query);
    const data = await accountingService.previewVendorMerge({
      survivingVendorId: query.survivingVendorId ?? "",
      sourceVendorId: query.sourceVendorId ?? "",
    });
    res.json({ data });
  }),
);

router.post(
  "/vendors/merge",
  requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
  asyncHandler(async (req, res) => {
    const body = mergeVendorsSchema.parse(req.body);
    const data = await accountingService.mergeVendors(req.user!.id, {
      survivingVendorId: body.survivingVendorId ?? "",
      sourceVendorId: body.sourceVendorId ?? "",
      missingTaxIdReason: body.missingTaxIdReason,
      keepFields: body.keepFields as
        Record<string, "surviving" | "source"> | undefined,
    });
    void logAudit({
      action: "merge",
      resource: "vendor",
      resourceId: body.survivingVendorId,
      details: {
        merged: body.sourceVendorId,
        missingTaxIdReason: body.missingTaxIdReason ?? null,
        keepFields: body.keepFields ?? null,
        warning: data.warning ?? null,
        duplicatePayments: data.duplicatePayments.length,
      },
      req,
    });
    res.json({ data });
  }),
);

router.get(
  "/invoices",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const query = invoiceQuerySchema.parse(req.query);
    const result = await accountingService.listInvoices(
      query,
      req.user!.id,
      req.user!.permissions,
    );
    res.json(result);
  }),
);

router.post(
  "/invoices",
  requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
  asyncHandler(async (req, res) => {
    const input = createInvoiceSchema.parse(req.body);
    const data = await accountingService.createInvoice(input, req.user!.id);
    res.status(201).json({ data });
  }),
);

// Literal /invoices/company must precede /invoices/:id so the id param
// doesn't swallow "company".
router.get(
  "/invoices/company",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (_req, res) => {
    const data = await accountingService.getInvoiceCompany();
    res.json({ data });
  }),
);

router.put(
  "/invoices/company",
  requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
  asyncHandler(async (req, res) => {
    const input = invoiceCompanySchema.parse(req.body);
    const data = await accountingService.setInvoiceCompany(input);
    res.json({ data });
  }),
);

router.get(
  "/invoices/:id",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await accountingService.getInvoiceByIdForActor(
      id,
      req.user!.id,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

router.put(
  "/invoices/:id",
  requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = updateInvoiceSchema.parse(req.body);
    const data = await accountingService.updateInvoice(
      id,
      input,
      req.user!.id,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

// Restore a soft-deleted invoice. Same gate as delete; registered before the
// `:id` DELETE so route order stays predictable.
router.post(
  "/invoices/:id/restore",
  requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await accountingService.restoreInvoice(
      id,
      req.user!.id,
      req.user!.permissions,
    );
    void logAudit({
      action: "restore",
      resource: "invoice",
      resourceId: id,
      req,
    });
    res.json({ data });
  }),
);

router.delete(
  "/invoices/:id",
  requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    await accountingService.deleteInvoice(
      id,
      req.user!.id,
      req.user!.permissions,
    );
    void logAudit({
      action: "soft_delete",
      resource: "invoice",
      resourceId: id,
      req,
    });
    res.json({ data: { success: true } });
  }),
);

// Downloadable invoice document (PDF). Print view is a web page that reads
// GET /invoices/:id + GET /invoices/company, so it needs no dedicated route.
router.get(
  "/invoices/:id/pdf",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const { document, company, totals, invoiceNo } = await loadInvoiceDocument(
      id,
      req.user!.id,
      req.user!.permissions,
    );
    const buffer = await buildInvoicePdfBuffer(document, company, totals);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${invoiceNo}.pdf"`);
    res.send(buffer);
  }),
);

// Downloadable invoice document (Word .docx).
router.get(
  "/invoices/:id/docx",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const { document, company, totals, invoiceNo } = await loadInvoiceDocument(
      id,
      req.user!.id,
      req.user!.permissions,
    );
    const buffer = await buildInvoiceDocxBuffer(document, company, totals);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${invoiceNo}.docx"`,
    );
    res.send(buffer);
  }),
);

// Downloadable invoice document (Excel .xlsx).
router.get(
  "/invoices/:id/xlsx",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const { document, company, totals, invoiceNo } = await loadInvoiceDocument(
      id,
      req.user!.id,
      req.user!.permissions,
    );
    const buffer = buildInvoiceXlsxBuffer(document, company, totals);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${invoiceNo}.xlsx"`,
    );
    res.send(buffer);
  }),
);

// Lifecycle status change (draft → sent → paid, etc.). When GL posting is
// enabled + the entity mapping is complete, draft→sent posts the AR/AP journal
// entry and cancel posts its reversal (see accounting.service).
router.patch(
  "/invoices/:id/status",
  requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const { status } = updateInvoiceStatusSchema.parse(req.body);
    const data = await accountingService.updateInvoiceStatus(
      id,
      status,
      req.user!.id,
      req.user!.permissions,
    );
    void logAudit({
      action: "invoice_status",
      resource: "invoice",
      resourceId: id,
      details: { status },
      req,
    });
    res.json({ data });
  }),
);

// ── Payments (record / list / void) ────────────────────────────────────────
router.get(
  "/invoices/:id/payments",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await accountingService.listPaymentsForInvoice(
      id,
      req.user!.id,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

router.post(
  "/invoices/:id/payments",
  requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = recordPaymentSchema.parse(req.body);
    const data = await accountingService.recordPayment(
      req.user!.id,
      id,
      input,
      req.user!.permissions,
    );
    void logAudit({
      action: "record_payment",
      resource: "payment",
      details: {
        invoiceId: id,
        amount: input.amount,
        bankAccountId: input.bankAccountId,
        posted: data.posted,
      },
      req,
    });
    res.status(201).json({ data });
  }),
);

router.get(
  "/payments",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const query = paymentListQuerySchema.parse(req.query);
    const result = await accountingService.listPayments(
      query,
      req.user!.id,
      req.user!.permissions,
    );
    res.json(result);
  }),
);

// Multi-invoice settlement (M3/M6, behind ACCOUNTING_SETTLEMENT_V2). Literal
// path registered before /payments/:id/* so it isn't shadowed.
router.post(
  "/payments/allocated",
  requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
  asyncHandler(async (req, res) => {
    const input = recordAllocatedPaymentSchema.parse(req.body);
    const data = await accountingService.recordAllocatedPayment(
      req.user!.id,
      input,
      req.user!.permissions,
    );
    void logAudit({
      action: "record_allocated_payment",
      resource: "payment",
      details: {
        paymentId: data.paymentId,
        invoicesSettled: data.invoicesSettled,
        totalCash: data.totalCash,
        posted: data.posted,
      },
      req,
    });
    res.status(201).json({ data });
  }),
);

// Payment run — pay many supplier bills at once (M6, behind
// ACCOUNTING_SETTLEMENT_V2). One bank payment per supplier group.
router.post(
  "/payment-runs",
  requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
  asyncHandler(async (req, res) => {
    const input = paymentRunSchema.parse(req.body);
    const data = await accountingService.runPaymentBatch(
      req.user!.id,
      input,
      req.user!.permissions,
    );
    void logAudit({
      action: "payment_run",
      resource: "payment",
      details: {
        paymentsCreated: data.paymentsCreated,
        totalCash: data.totalCash,
      },
      req,
    });
    res.status(201).json({ data });
  }),
);

router.post(
  "/payments/:id/void",
  requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await accountingService.voidPayment(req.user!.id, id);
    void logAudit({
      action: "void_payment",
      resource: "payment",
      details: { paymentId: id },
      req,
    });
    res.json({ data });
  }),
);

// Withholding-tax certificate (Form 50 Bis) PDF for a supplier payment (M6).
router.get(
  "/payments/:id/wht-certificate",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const buffer = await accountingService.getWhtCertificate(
      id,
      req.user!.id,
      req.user!.permissions,
    );
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="wht-certificate-${id}.pdf"`,
    );
    res.send(buffer);
  }),
);

router.get(
  "/payments/:id/tax-invoice",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const buffer = await accountingService.getTaxInvoicePdf(
      id,
      req.user!.id,
      req.user!.permissions,
    );
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="tax-invoice-${id}.pdf"`,
    );
    res.send(buffer);
  }),
);

router.post(
  "/payments/:id/wht-certificate-received",
  requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await accountingService.markWhtCertificateReceived(
      id,
      req.user!.id,
    );
    res.json({ data });
  }),
);

// ── Bank accounts (master) ──────────────────────────────────────────────────
router.get(
  "/bank-accounts",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const query = bankAccountQuerySchema.parse(req.query);
    const data = await accountingService.listBankAccounts(query);
    res.json({ data });
  }),
);

router.post(
  "/bank-accounts",
  requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
  asyncHandler(async (req, res) => {
    const input = createBankAccountSchema.parse(req.body);
    const data = await accountingService.createBankAccount(input);
    void logAudit({
      action: "create",
      resource: "bank_account",
      resourceId: data.id,
      details: { entityId: input.entityId, name: input.name, kind: input.kind },
      req,
    });
    res.status(201).json({ data });
  }),
);

router.get(
  "/bank-accounts/:id",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await accountingService.getBankAccountById(id);
    res.json({ data });
  }),
);

router.put(
  "/bank-accounts/:id",
  requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = updateBankAccountSchema.parse(req.body);
    const data = await accountingService.updateBankAccount(id, input);
    res.json({ data });
  }),
);

router.delete(
  "/bank-accounts/:id",
  requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    await accountingService.deleteBankAccount(id);
    void logAudit({
      action: "delete",
      resource: "bank_account",
      resourceId: id,
      req,
    });
    res.json({ data: { success: true } });
  }),
);

router.get(
  "/bank",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const query = bankTransactionQuerySchema.parse(req.query);
    const result = await accountingService.listBankTransactions(query);
    res.json(result);
  }),
);

router.post(
  "/bank/import",
  requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
  asyncHandler(async (req, res) => {
    const input = importBankStatementSchema.parse(req.body);
    const data = await accountingService.importBankStatement(input);
    res.status(201).json({ data });
  }),
);

// Bank reconciliation (M7). Literal path first so it isn't eaten by /bank/:id.
router.get(
  "/bank/reconciliation-summary",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const query = reconciliationSummaryQuerySchema.parse(req.query);
    const data = await accountingService.getReconciliationSummary(query);
    res.json({ data });
  }),
);

// Read-only auto-match suggestions for unmatched imported bank lines. Literal
// path — must precede /bank/:id/* so ":id" doesn't swallow it.
router.get(
  "/bank/match-suggestions",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const { entityId } = bankMatchQuerySchema.parse(req.query);
    const data = await accountingService.getBankMatchSuggestions(entityId);
    res.json({ data });
  }),
);

// Expense workspace header: total + by-category AP spend for a period.
router.get(
  "/expense-summary",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const query = expenseSummaryQuerySchema.parse(req.query);
    const data = await accountingService.getExpenseSummary(query);
    res.json({ data });
  }),
);

// Global accounting search (header omnibox). One term across invoices/bills,
// journals, chart of accounts, bank lines and payments. Owner-scoped for
// invoices/payments in the service (mirrors listInvoices). Literal path.
router.get(
  "/search",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const query = accountingSearchQuerySchema.parse(req.query);
    const data = await accountingService.searchAccounting(
      query,
      req.user!.id,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

router.post(
  "/bank/:id/reconcile",
  requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = reconcileTransactionSchema.parse(req.body);
    const data = await accountingService.reconcileBankTransaction(id, input);
    res.json({ data });
  }),
);

router.post(
  "/bank/:id/unreconcile",
  requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await accountingService.unreconcileBankTransaction(id);
    res.json({ data });
  }),
);

// Confirm a bank-match: settle an imported line against an open invoice. Both
// records the payment (cash + GL) and adopts the imported row — so it's gated
// on the admin reconcile surface, and the underlying recordPayment still
// enforces per-invoice owner access.
router.post(
  "/bank/:id/settle",
  requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = settleBankTransactionSchema.parse(req.body);
    const data = await accountingService.settleBankTransaction(
      req.user!.id,
      id,
      input,
      req.user!.permissions,
    );
    void logAudit({
      action: "settle_bank_transaction",
      resource: "bank_transaction",
      details: {
        bankTransactionId: id,
        invoiceId: input.invoiceId,
        bankAccountId: input.bankAccountId,
      },
      req,
    });
    res.json({ data });
  }),
);

// ── Financial reports (built from posted GL activity) ───────────────────────
router.get(
  "/reports/trial-balance",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const query = reportAsOfQuerySchema.parse(req.query);
    const data = await accountingService.getTrialBalance(query);
    res.json({ data });
  }),
);

router.get(
  "/reports/profit-and-loss",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const query = reportPeriodQuerySchema.parse(req.query);
    const data = await accountingService.getProfitAndLoss(query);
    res.json({ data });
  }),
);

router.get(
  "/reports/balance-sheet",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const query = reportAsOfQuerySchema.parse(req.query);
    const data = await accountingService.getBalanceSheet(query);
    res.json({ data });
  }),
);

router.get(
  "/reports/cash-flow",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const query = reportPeriodQuerySchema.parse(req.query);
    const data = await accountingService.getCashFlow(query);
    res.json({ data });
  }),
);

router.get(
  "/reports/tax-summary",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const query = taxReportQuerySchema.parse(req.query);
    const data = await accountingService.getTaxReport(query);
    res.json({ data });
  }),
);

// Revenue-Department tax-filing registers (M9): output/input VAT registers,
// PP.30 summary, PND.3/PND.53 WHT returns — built from documents, not the
// ledger, so they populate whether or not GL posting is enabled.
router.get(
  "/reports/tax-registers",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const query = taxReportQuerySchema.parse(req.query);
    const data = await accountingService.getTaxRegisters(query);
    res.json({ data });
  }),
);

router.get(
  "/reports/statutory",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const query = taxReportQuerySchema.parse(req.query);
    const data = await accountingService.getStatutoryReports(query);
    res.json({ data });
  }),
);

// AR/AP aging + liquidity roll-up (M11 dashboard). Owner-scoped for callers
// without read-all; totals are a server-side scan of every open row.
router.get(
  "/aging-summary",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const query = agingSummaryQuerySchema.parse(req.query);
    const data = await accountingService.getAgingSummary(
      query,
      req.user!.id,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

// Tax filings + tax-month lock (M9). Reads are open to any accounting reader;
// filing / reopening a month is an admin (config-level) action, like closing a
// fiscal period.
router.get(
  "/tax-filings",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const query = taxFilingQuerySchema.parse(req.query);
    const data = await accountingService.listTaxFilings(query);
    res.json({ data });
  }),
);

router.post(
  "/tax-filings/file",
  requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
  asyncHandler(async (req, res) => {
    const input = fileTaxSchema.parse(req.body);
    const data = await accountingService.fileTaxPeriod(req.user!.id, input);
    res.status(201).json({ data });
  }),
);

router.post(
  "/tax-filings/reopen",
  requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
  asyncHandler(async (req, res) => {
    const input = reopenTaxSchema.parse(req.body);
    const data = await accountingService.reopenTaxPeriod(req.user!.id, input);
    res.json({ data });
  }),
);

// Statement-of-account PDF (M1). Per-counterparty; owner-scoped in the service.
router.get(
  "/statements/download",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const query = statementQuerySchema.parse(req.query);
    const buffer = await accountingService.getStatementPdf(
      query,
      req.user!.id,
      req.user!.permissions,
    );
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="statement.pdf"`);
    res.send(buffer);
  }),
);

// Customer advances (M3): list + apply an open advance to an AR invoice.
router.get(
  "/customer-advances",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const query = customerAdvanceQuerySchema.parse(req.query);
    const data = await accountingService.listCustomerAdvances(
      query,
      req.user!.id,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

router.post(
  "/customer-advances/:id/apply",
  requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = applyAdvanceSchema.parse(req.body);
    const data = await accountingService.applyAdvance(
      req.user!.id,
      id,
      input,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

router.post(
  "/customer-advances/:id/refund",
  requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = refundAdvanceSchema.parse(req.body);
    const data = await accountingService.refundAdvance(
      req.user!.id,
      id,
      input,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

router.post(
  "/customer-advances/:id/tax-invoice",
  requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = prepaymentTaxInvoiceSchema.parse(req.body);
    const data = await accountingService.recordPrepaymentTaxInvoice(
      req.user!.id,
      id,
      input,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

// ── Second-level approval (PRD 9.6) ────────────────────────────────────────
router.get(
  "/second-approval/config",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (_req, res) => {
    const data = await accountingService.getSecondApprovalConfig();
    res.json({ data });
  }),
);

router.put(
  "/second-approval/config",
  requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
  asyncHandler(async (req, res) => {
    const input = secondApprovalConfigSchema.parse(req.body);
    const data = await accountingService.setSecondApprovalConfig(input);
    void logAudit({
      action: "update",
      resource: "accounting_second_approval_config",
      details: { enabled: data.enabled, thresholds: data.thresholds },
      req,
    });
    res.json({ data });
  }),
);

// Approve or send back a document waiting on a second signature. The route
// carries the read/approve gate; WHICH person may decide is identity and is
// enforced in the service — requirePermission cannot express "not the person
// who gave the first approval".
router.post(
  "/invoices/:id/second-approval/:decision",
  requirePermission(PERMISSIONS.ACCOUNTING_APPROVE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const decision = getRequiredParam(req.params, "decision");
    if (decision !== "approve" && decision !== "send-back") {
      throw new BadRequestException(
        "Decision must be 'approve' or 'send-back'.",
      );
    }
    const input = secondApprovalDecisionSchema.parse(req.body);
    const data = await accountingService.decideSecondApproval(
      id,
      req.user!.id,
      decision,
      input,
      req.user!.permissions,
    );
    void logAudit({
      action: decision === "approve" ? "approve" : "reject",
      resource: "accounting_invoice",
      resourceId: id,
      details: { stage: "second-approval", reason: input.reason ?? null },
      req,
    });
    res.json({ data });
  }),
);

// Accounting audit-log viewer (M12). Admin-only — audit trails are sensitive.
router.get(
  "/audit-log",
  requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
  asyncHandler(async (req, res) => {
    const query = auditLogQuerySchema.parse(req.query);
    const data = await accountingService.listAccountingAuditLogs(query);
    res.json({ data });
  }),
);

// ── Suppliers: open-balance summary (server-side rollup) ────────────────────
router.get(
  "/suppliers/summary",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const query = supplierSummaryQuerySchema.parse(req.query);
    const data = await accountingService.getSupplierSummary(query);
    res.json({ data });
  }),
);

// ── Quotes (AR — create, send, convert to invoice) ──────────────────────────
router.get(
  "/quotes",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const query = quoteQuerySchema.parse(req.query);
    const data = await accountingService.listQuotes(
      query,
      req.user!.id,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

router.post(
  "/quotes",
  requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
  asyncHandler(async (req, res) => {
    const input = createQuoteSchema.parse(req.body);
    const data = await accountingService.createQuote(req.user!.id, input);
    res.status(201).json({ data });
  }),
);

router.get(
  "/quotes/:id",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await accountingService.getQuoteByIdForActor(
      id,
      req.user!.id,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

router.put(
  "/quotes/:id",
  requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = updateQuoteSchema.parse(req.body);
    const data = await accountingService.updateQuote(
      id,
      input,
      req.user!.id,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

router.post(
  "/quotes/:id/send",
  requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await accountingService.sendQuote(
      id,
      req.user!.id,
      req.user!.permissions,
    );
    res.json({ data });
  }),
);

router.post(
  "/quotes/:id/convert",
  requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await accountingService.convertQuote(
      id,
      req.user!.id,
      req.user!.permissions,
    );
    void logAudit({
      action: "convert",
      resource: "quote",
      resourceId: id,
      details: { invoiceId: data.invoiceId },
      req,
    });
    res.json({ data });
  }),
);

router.delete(
  "/quotes/:id",
  requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    await accountingService.deleteQuote(
      id,
      req.user!.id,
      req.user!.permissions,
    );
    res.json({ data: { success: true } });
  }),
);

// ── Credit notes (AR credit note / AP debit note) ───────────────────────────
router.get(
  "/credit-notes",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const query = creditNoteQuerySchema.parse(req.query);
    const data = await accountingService.listCreditNotes(query);
    res.json({ data });
  }),
);

router.post(
  "/credit-notes",
  requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
  asyncHandler(async (req, res) => {
    const input = createCreditNoteSchema.parse(req.body);
    const data = await accountingService.createCreditNote(req.user!.id, input);
    void logAudit({
      action: "create",
      resource: "credit_note",
      resourceId: data.id,
      details: { entityId: input.entityId, type: input.type },
      req,
    });
    res.status(201).json({ data });
  }),
);

router.get(
  "/credit-notes/:id",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await accountingService.getCreditNoteById(id);
    res.json({ data });
  }),
);

// Issuing posts the reversal journal entry — gate on the posting permission.
router.post(
  "/credit-notes/:id/issue",
  requirePermission(PERMISSIONS.ACCOUNTING_POST),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await accountingService.issueCreditNote(req.user!.id, id);
    void logAudit({
      action: "issue",
      resource: "credit_note",
      resourceId: id,
      req,
    });
    res.json({ data });
  }),
);

router.post(
  "/credit-notes/:id/void",
  requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await accountingService.voidCreditNote(req.user!.id, id);
    void logAudit({
      action: "void",
      resource: "credit_note",
      resourceId: id,
      req,
    });
    res.json({ data });
  }),
);

// ── Purchase orders (create, receive, convert to bill) ──────────────────────
router.get(
  "/purchase-orders",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const query = purchaseOrderQuerySchema.parse(req.query);
    const data = await accountingService.listPurchaseOrders(query);
    res.json({ data });
  }),
);

router.post(
  "/purchase-orders",
  requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
  asyncHandler(async (req, res) => {
    const input = createPurchaseOrderSchema.parse(req.body);
    const data = await accountingService.createPurchaseOrder(
      req.user!.id,
      input,
    );
    res.status(201).json({ data });
  }),
);

router.get(
  "/purchase-orders/:id",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await accountingService.getPurchaseOrderById(id);
    res.json({ data });
  }),
);

router.post(
  "/purchase-orders/:id/receive",
  requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = receivePurchaseOrderSchema.parse(req.body);
    const data = await accountingService.receivePurchaseOrder(id, input);
    res.json({ data });
  }),
);

router.post(
  "/purchase-orders/:id/convert-to-bill",
  requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const data = await accountingService.convertPoToBill(id);
    void logAudit({
      action: "convert_to_bill",
      resource: "purchase_order",
      resourceId: id,
      details: { invoiceId: data.invoiceId },
      req,
    });
    res.json({ data });
  }),
);

router.delete(
  "/purchase-orders/:id",
  requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    await accountingService.deletePurchaseOrder(id);
    res.json({ data: { success: true } });
  }),
);

// ── Fiscal periods (close / reopen a month) ─────────────────────────────────
router.get(
  "/fiscal-periods",
  requirePermission(PERMISSIONS.ACCOUNTING_READ),
  asyncHandler(async (req, res) => {
    const query = fiscalPeriodQuerySchema.parse(req.query);
    const data = await accountingService.listFiscalPeriods(query);
    res.json({ data });
  }),
);

router.post(
  "/fiscal-periods/close",
  requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
  asyncHandler(async (req, res) => {
    const input = closePeriodSchema.parse(req.body);
    const data = await accountingService.closePeriod(req.user!.id, input);
    void logAudit({
      action: "close_period",
      resource: "fiscal_period",
      details: {
        entityId: input.entityId,
        year: input.year,
        month: input.month,
      },
      req,
    });
    res.json({ data });
  }),
);

router.post(
  "/fiscal-periods/reopen",
  requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
  asyncHandler(async (req, res) => {
    const input = reopenPeriodSchema.parse(req.body);
    const data = await accountingService.reopenPeriod(req.user!.id, input);
    void logAudit({
      action: "reopen_period",
      resource: "fiscal_period",
      details: {
        entityId: input.entityId,
        year: input.year,
        month: input.month,
      },
      req,
    });
    res.json({ data });
  }),
);

// Period-end FX revaluation (M8): retranslate open foreign AR/AP at the
// closing rate and post the unrealised gain/loss (reversed next period). Posts
// journal entries, so gate on the post permission.
router.post(
  "/fiscal-periods/revalue",
  requirePermission(PERMISSIONS.ACCOUNTING_POST),
  asyncHandler(async (req, res) => {
    const input = revaluePeriodSchema.parse(req.body);
    const data = await accountingService.runFxRevaluation(req.user!.id, input);
    void logAudit({
      action: "fx_revaluation",
      resource: "fiscal_period",
      resourceId: data.entryId ?? undefined,
      details: {
        entityId: input.entityId,
        year: input.year,
        month: input.month,
        itemsRevalued: data.itemsRevalued,
        netFx: data.netFx,
      },
      req,
    });
    res.json({ data });
  }),
);

// ── Fixed Asset Register (ship-dark behind ACCOUNTING_FIXED_ASSETS) ─────────
// Fail-closed: with the flag off, none of these routes mount, so the register
// stays invisible in prod even though the migration + code are deployed.
// Literal paths are registered before the ":id" routes (Express match order).
if (isFixedAssetsEnabled()) {
  router.get(
    "/fixed-assets",
    requirePermission(PERMISSIONS.ACCOUNTING_READ),
    asyncHandler(async (req, res) => {
      const query = fixedAssetQuerySchema.parse(req.query);
      const result = await accountingService.listFixedAssets(
        query,
        req.user!.id,
        req.user!.permissions,
      );
      res.json(result);
    }),
  );

  router.post(
    "/fixed-assets",
    requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
    asyncHandler(async (req, res) => {
      const input = createFixedAssetSchema.parse(req.body);
      const data = await accountingService.createFixedAsset(
        input,
        req.user!.id,
      );
      void logAudit({
        action: "create",
        resource: "fixed_asset",
        resourceId: data.id,
        details: { entityId: input.entityId, assetNo: data.assetNo },
        req,
      });
      res.status(201).json({ data });
    }),
  );

  // Depreciation run — literal paths before :id. GET is always a preview; POST
  // posts only when the body says so, and is gated on ACCOUNTING_POST rather
  // than ACCOUNTING_CREATE because it moves ChartOfAccount.balance.
  router.get(
    "/fixed-assets/depreciation-run",
    requirePermission(PERMISSIONS.ACCOUNTING_READ),
    asyncHandler(async (req, res) => {
      const parsed = fixedAssetDepreciationRunSchema.parse({
        ...req.query,
        post: false,
      });
      const data = await accountingService.fixedAssetDepreciationRun(
        {
          entityId: String(parsed.entityId),
          year: Number(parsed.year),
          month: Number(parsed.month),
          post: false,
        },
        req.user!.id,
      );
      res.json({ data });
    }),
  );

  router.post(
    "/fixed-assets/depreciation-run",
    requirePermission(PERMISSIONS.ACCOUNTING_POST),
    asyncHandler(async (req, res) => {
      const parsed = fixedAssetDepreciationRunSchema.parse(req.body);
      const input = {
        entityId: String(parsed.entityId),
        year: Number(parsed.year),
        month: Number(parsed.month),
        post: Boolean(parsed.post),
      };
      const data = await accountingService.fixedAssetDepreciationRun(
        input,
        req.user!.id,
      );
      if (data.posted) {
        void logAudit({
          action: "post",
          resource: "fixed_asset_depreciation",
          details: {
            entityId: input.entityId,
            period: data.period,
            total: data.total,
            entryId: data.entryId,
            entryNo: data.entryNo,
          },
          req,
        });
      }
      res.json({ data });
    }),
  );

  // Physical count sessions (WS4) — literal "count-sessions" segment, so these
  // must stay above "/fixed-assets/:id" or GET /fixed-assets/count-sessions is
  // eaten by it and read as an asset id.
  //
  // Nothing here posts: a count reports a variance and recommends a write-off,
  // which the accountant raises through the existing disposal flow. So none of
  // these is gated on ACCOUNTING_POST, and close is ACCOUNTING_APPROVE because
  // it freezes the record the accountant then acts on.
  router.get(
    "/fixed-assets/count-sessions",
    requirePermission(PERMISSIONS.ACCOUNTING_READ),
    asyncHandler(async (req, res) => {
      const parsed = fixedAssetCountSessionQuerySchema.parse(req.query);
      const data = await accountingService.listFixedAssetCountSessions(
        {
          entityId: parsed.entityId ? String(parsed.entityId) : undefined,
          status: parsed.status,
        },
        req.user!.id,
        req.user!.permissions,
      );
      res.json(data);
    }),
  );

  router.post(
    "/fixed-assets/count-sessions",
    requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
    asyncHandler(async (req, res) => {
      const parsed = createFixedAssetCountSessionSchema.parse(req.body);
      const input = {
        entityId: String(parsed.entityId),
        asOfDate: String(parsed.asOfDate),
        name: parsed.name ?? null,
        locationFilter: parsed.locationFilter ?? null,
      };
      const data = await accountingService.createFixedAssetCountSession(
        input,
        req.user!.id,
      );
      void logAudit({
        action: "create",
        resource: "fixed_asset_count_session",
        resourceId: data.id,
        details: {
          entityId: input.entityId,
          sessionNo: data.sessionNo,
          asOfDate: input.asOfDate,
        },
        req,
      });
      res.status(201).json({ data });
    }),
  );

  router.get(
    "/fixed-assets/count-sessions/:id/variance",
    requirePermission(PERMISSIONS.ACCOUNTING_READ),
    asyncHandler(async (req, res) => {
      const id = getRequiredParam(req.params, "id");
      const data = await accountingService.getFixedAssetCountVariance(
        id,
        req.user!.id,
        req.user!.permissions,
      );
      res.json({ data });
    }),
  );

  router.post(
    "/fixed-assets/count-sessions/:id/lines",
    requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
    asyncHandler(async (req, res) => {
      const id = getRequiredParam(req.params, "id");
      const parsed = submitFixedAssetCountLineSchema.parse(req.body);
      const input = {
        assetId: parsed.assetId ?? null,
        scannedTag: parsed.scannedTag ?? null,
        countedQuantity: Number(parsed.countedQuantity),
        note: parsed.note ?? null,
      };
      const data = await accountingService.submitFixedAssetCountLine(
        id,
        input,
        req.user!.id,
        req.user!.permissions,
      );
      void logAudit({
        action: "count",
        resource: "fixed_asset_count_line",
        resourceId: data.id,
        details: {
          sessionId: id,
          assetId: data.assetId,
          scannedTag: data.scannedTag,
          countedQuantity: data.countedQuantity,
          resolution: data.resolution,
        },
        req,
      });
      res.status(201).json({ data });
    }),
  );

  router.post(
    "/fixed-assets/count-sessions/:id/close",
    requirePermission(PERMISSIONS.ACCOUNTING_APPROVE),
    asyncHandler(async (req, res) => {
      const id = getRequiredParam(req.params, "id");
      const data = await accountingService.closeFixedAssetCountSession(
        id,
        req.user!.id,
      );
      void logAudit({
        action: "close",
        resource: "fixed_asset_count_session",
        resourceId: id,
        details: { sessionNo: data.sessionNo, entityId: data.entityId },
        req,
      });
      res.json({ data });
    }),
  );

  // Import (19-column layout, parsed client-side) — literal paths before :id.
  router.post(
    "/fixed-assets/import/preview",
    requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
    asyncHandler(async (req, res) => {
      const input = importFixedAssetsSchema.parse(req.body);
      const data = await accountingService.previewFixedAssetImport(input);
      res.json({ data });
    }),
  );

  router.post(
    "/fixed-assets/import/commit",
    requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
    asyncHandler(async (req, res) => {
      const input = importFixedAssetsSchema.parse(req.body);
      const data = await accountingService.commitFixedAssetImport(
        input,
        req.user!.id,
        req.user!.permissions,
      );
      if (data.ok) {
        void logAudit({
          action: "import",
          resource: "fixed_asset",
          details: { entityId: input.entityId, loaded: data.loaded },
          req,
        });
      }
      res.json({ data });
    }),
  );

  router.get(
    "/fixed-assets/export.xlsx",
    requirePermission(PERMISSIONS.ACCOUNTING_READ),
    asyncHandler(async (req, res) => {
      const query = fixedAssetReportQuerySchema.parse(req.query);
      const buffer = await accountingService.fixedAssetRegisterXlsx(
        query,
        req.user!.id,
        req.user!.permissions,
      );
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="fixed-assets.xlsx"',
      );
      res.send(buffer);
    }),
  );

  router.get(
    "/fixed-asset-categories",
    requirePermission(PERMISSIONS.ACCOUNTING_READ),
    asyncHandler(async (req, res) => {
      const query = fixedAssetCategoryQuerySchema.parse(req.query);
      const data = await accountingService.listFixedAssetCategories(query);
      res.json({ data });
    }),
  );

  router.post(
    "/fixed-asset-categories",
    requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
    asyncHandler(async (req, res) => {
      const input = createFixedAssetCategorySchema.parse(req.body);
      const data = await accountingService.createFixedAssetCategory(input);
      void logAudit({
        action: "create",
        resource: "fixed_asset_category",
        resourceId: data.id,
        details: { entityId: input.entityId, code: input.code },
        req,
      });
      res.status(201).json({ data });
    }),
  );

  router.put(
    "/fixed-asset-categories/:id",
    requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
    asyncHandler(async (req, res) => {
      const id = getRequiredParam(req.params, "id");
      const input = updateFixedAssetCategorySchema.parse(req.body);
      const data = await accountingService.updateFixedAssetCategory(id, input);
      void logAudit({
        action: "update",
        resource: "fixed_asset_category",
        resourceId: id,
        req,
      });
      res.json({ data });
    }),
  );

  router.delete(
    "/fixed-asset-categories/:id",
    requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
    asyncHandler(async (req, res) => {
      const id = getRequiredParam(req.params, "id");
      const data = await accountingService.deleteFixedAssetCategory(id);
      void logAudit({
        action: "delete",
        resource: "fixed_asset_category",
        resourceId: id,
        req,
      });
      res.json({ data });
    }),
  );

  // Entity corporate income tax rates (WS5) — admin-editable, effective-dated,
  // and the input the deferred tax schedule refuses to guess. All four are
  // ACCOUNTING_ADMIN: an unnoticed rate edit silently restates deferred tax for
  // every asset. No conflict with "/fixed-assets/:id" (different prefix), but
  // they live inside the flag block with the rest of the register.
  router.get(
    "/entity-tax-rates",
    requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
    asyncHandler(async (req, res) => {
      const parsed = entityTaxRateQuerySchema.parse(req.query);
      const data = await accountingService.listEntityTaxRates({
        entityId: String(parsed.entityId),
      });
      res.json({ data });
    }),
  );

  router.post(
    "/entity-tax-rates",
    requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
    asyncHandler(async (req, res) => {
      const parsed = createEntityTaxRateSchema.parse(req.body);
      const input = {
        entityId: String(parsed.entityId),
        effectiveFrom: String(parsed.effectiveFrom),
        effectiveTo: parsed.effectiveTo ? String(parsed.effectiveTo) : null,
        ratePercent: Number(parsed.ratePercent),
        label: parsed.label ? String(parsed.label) : null,
      };
      const data = await accountingService.createEntityTaxRate(input);
      void logAudit({
        action: "create",
        resource: "entity_tax_rate",
        resourceId: data.id,
        details: {
          entityId: input.entityId,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo,
          ratePercent: input.ratePercent,
        },
        req,
      });
      res.status(201).json({ data });
    }),
  );

  router.put(
    "/entity-tax-rates/:id",
    requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
    asyncHandler(async (req, res) => {
      const id = getRequiredParam(req.params, "id");
      const parsed = updateEntityTaxRateSchema.parse(req.body);
      // Key-presence is meaningful: an absent effectiveTo keeps the stored end
      // date, an explicit null makes the period open-ended.
      const input = {
        ...(parsed.effectiveFrom !== undefined
          ? { effectiveFrom: String(parsed.effectiveFrom) }
          : {}),
        ...(parsed.effectiveTo !== undefined
          ? {
              effectiveTo:
                parsed.effectiveTo === null ? null : String(parsed.effectiveTo),
            }
          : {}),
        ...(parsed.ratePercent !== undefined
          ? { ratePercent: Number(parsed.ratePercent) }
          : {}),
        ...(parsed.label !== undefined
          ? { label: parsed.label === null ? null : String(parsed.label) }
          : {}),
      };
      const data = await accountingService.updateEntityTaxRate(id, input);
      void logAudit({
        action: "update",
        resource: "entity_tax_rate",
        resourceId: id,
        details: input,
        req,
      });
      res.json({ data });
    }),
  );

  router.delete(
    "/entity-tax-rates/:id",
    requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
    asyncHandler(async (req, res) => {
      const id = getRequiredParam(req.params, "id");
      const data = await accountingService.deleteEntityTaxRate(id);
      void logAudit({
        action: "delete",
        resource: "entity_tax_rate",
        resourceId: id,
        req,
      });
      res.json({ data });
    }),
  );

  router.post(
    "/fixed-assets/:id/restore",
    requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
    asyncHandler(async (req, res) => {
      const id = getRequiredParam(req.params, "id");
      const data = await accountingService.restoreFixedAsset(
        id,
        req.user!.id,
        req.user!.permissions,
      );
      void logAudit({
        action: "restore",
        resource: "fixed_asset",
        resourceId: id,
        req,
      });
      res.json({ data });
    }),
  );

  router.delete(
    "/fixed-assets/:id/permanent",
    requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
    asyncHandler(async (req, res) => {
      const id = getRequiredParam(req.params, "id");
      const data = await accountingService.permanentDeleteFixedAsset(
        id,
        req.user!.id,
        req.user!.permissions,
      );
      void logAudit({
        action: "permanent-delete",
        resource: "fixed_asset",
        resourceId: id,
        req,
      });
      res.json({ data });
    }),
  );

  router.get(
    "/fixed-assets/:id",
    requirePermission(PERMISSIONS.ACCOUNTING_READ),
    asyncHandler(async (req, res) => {
      const id = getRequiredParam(req.params, "id");
      const asOf =
        typeof req.query.asOf === "string" ? req.query.asOf : undefined;
      const data = await accountingService.getFixedAsset(
        id,
        req.user!.id,
        req.user!.permissions,
        asOf,
      );
      res.json({ data });
    }),
  );

  router.put(
    "/fixed-assets/:id",
    requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
    asyncHandler(async (req, res) => {
      const id = getRequiredParam(req.params, "id");
      const input = updateFixedAssetSchema.parse(req.body);
      const data = await accountingService.updateFixedAsset(
        id,
        input,
        req.user!.id,
        req.user!.permissions,
      );
      void logAudit({
        action: "update",
        resource: "fixed_asset",
        resourceId: id,
        req,
      });
      res.json({ data });
    }),
  );

  router.delete(
    "/fixed-assets/:id",
    requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
    asyncHandler(async (req, res) => {
      const id = getRequiredParam(req.params, "id");
      const data = await accountingService.deleteFixedAsset(
        id,
        req.user!.id,
        req.user!.permissions,
      );
      void logAudit({
        action: "delete",
        resource: "fixed_asset",
        resourceId: id,
        req,
      });
      res.json({ data });
    }),
  );

  // Disposal / write-off approval queue. Submit needs accounting:create (owner-
  // scoped in the service); approve/reject need accounting:approve. The
  // disposal DATE governs the accounting period, not the approval date.
  router.get(
    "/fixed-asset-disposals",
    requirePermission(PERMISSIONS.ACCOUNTING_READ),
    asyncHandler(async (req, res) => {
      const query = fixedAssetDisposalQuerySchema.parse(req.query);
      const data = await accountingService.listFixedAssetDisposals(
        query,
        req.user!.id,
        req.user!.permissions,
      );
      res.json(data);
    }),
  );

  router.get(
    "/fixed-asset-disposals/:id",
    requirePermission(PERMISSIONS.ACCOUNTING_READ),
    asyncHandler(async (req, res) => {
      const id = getRequiredParam(req.params, "id");
      const data = await accountingService.getFixedAssetDisposal(
        id,
        req.user!.id,
        req.user!.permissions,
      );
      res.json({ data });
    }),
  );

  router.post(
    "/fixed-assets/:id/disposals",
    requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
    asyncHandler(async (req, res) => {
      const id = getRequiredParam(req.params, "id");
      const input = submitFixedAssetDisposalSchema.parse(req.body);
      const data = await accountingService.submitFixedAssetDisposal(
        id,
        input,
        req.user!.id,
        req.user!.permissions,
      );
      void logAudit({
        action: "submit",
        resource: "fixed_asset_disposal",
        resourceId: data.id,
        details: {
          assetId: id,
          disposalType: input.disposalType,
          disposalDate: input.disposalDate,
          unitsDisposed: input.unitsDisposed,
        },
        req,
      });
      res.status(201).json({ data });
    }),
  );

  router.put(
    "/fixed-asset-disposals/:id/approve",
    requirePermission(PERMISSIONS.ACCOUNTING_APPROVE),
    asyncHandler(async (req, res) => {
      const id = getRequiredParam(req.params, "id");
      const data = await accountingService.approveFixedAssetDisposal(
        id,
        req.user!.id,
      );
      void logAudit({
        action: "approve",
        resource: "fixed_asset_disposal",
        resourceId: id,
        req,
      });
      res.json({ data });
    }),
  );

  router.put(
    "/fixed-asset-disposals/:id/reject",
    requirePermission(PERMISSIONS.ACCOUNTING_APPROVE),
    asyncHandler(async (req, res) => {
      const id = getRequiredParam(req.params, "id");
      const input = rejectFixedAssetDisposalSchema.parse(req.body);
      const data = await accountingService.rejectFixedAssetDisposal(
        id,
        req.user!.id,
        input.reason,
      );
      void logAudit({
        action: "reject",
        resource: "fixed_asset_disposal",
        resourceId: id,
        req,
      });
      res.json({ data });
    }),
  );

  // Transfer approval queue + per-asset movement trail (WS3). Same shape as the
  // disposal queue: submit needs accounting:create (owner-scoped in the
  // service), approve/reject need accounting:approve. The TRANSFER DATE governs
  // the period on a cross-entity move, never the approval date.
  router.get(
    "/fixed-asset-transfers",
    requirePermission(PERMISSIONS.ACCOUNTING_READ),
    asyncHandler(async (req, res) => {
      const parsed = fixedAssetTransferQuerySchema.parse(req.query);
      const data = await accountingService.listFixedAssetTransfers(
        {
          entityId: parsed.entityId ? String(parsed.entityId) : undefined,
          status: parsed.status,
          assetId: parsed.assetId ? String(parsed.assetId) : undefined,
          kind: parsed.kind,
        },
        req.user!.id,
        req.user!.permissions,
      );
      res.json(data);
    }),
  );

  router.get(
    "/fixed-asset-transfers/:id",
    requirePermission(PERMISSIONS.ACCOUNTING_READ),
    asyncHandler(async (req, res) => {
      const id = getRequiredParam(req.params, "id");
      const data = await accountingService.getFixedAssetTransfer(
        id,
        req.user!.id,
        req.user!.permissions,
      );
      res.json({ data });
    }),
  );

  router.get(
    "/fixed-assets/:id/transfers",
    requirePermission(PERMISSIONS.ACCOUNTING_READ),
    asyncHandler(async (req, res) => {
      const id = getRequiredParam(req.params, "id");
      const data = await accountingService.listFixedAssetTransfersForAsset(
        id,
        req.user!.id,
        req.user!.permissions,
      );
      res.json(data);
    }),
  );

  router.post(
    "/fixed-assets/:id/transfers",
    requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
    asyncHandler(async (req, res) => {
      const id = getRequiredParam(req.params, "id");
      const parsed = submitFixedAssetTransferSchema.parse(req.body);
      const input = {
        kind: parsed.kind,
        transferDate: String(parsed.transferDate),
        toLocation: parsed.toLocation ?? null,
        toCustodian: parsed.toCustodian ?? null,
        toEntityId: parsed.toEntityId ?? null,
        reason: parsed.reason ?? null,
      };
      const data = await accountingService.submitFixedAssetTransfer(
        id,
        input,
        req.user!.id,
        req.user!.permissions,
      );
      void logAudit({
        action: "submit",
        resource: "fixed_asset_transfer",
        resourceId: data.id,
        details: {
          assetId: id,
          kind: input.kind,
          transferDate: input.transferDate,
          toEntityId: input.toEntityId,
        },
        req,
      });
      res.status(201).json({ data });
    }),
  );

  router.put(
    "/fixed-asset-transfers/:id/approve",
    requirePermission(PERMISSIONS.ACCOUNTING_APPROVE),
    asyncHandler(async (req, res) => {
      const id = getRequiredParam(req.params, "id");
      const data = await accountingService.approveFixedAssetTransfer(
        id,
        req.user!.id,
      );
      void logAudit({
        action: "approve",
        resource: "fixed_asset_transfer",
        resourceId: id,
        details: { kind: data.kind, transferDate: data.transferDate },
        req,
      });
      res.json({ data });
    }),
  );

  router.put(
    "/fixed-asset-transfers/:id/reject",
    requirePermission(PERMISSIONS.ACCOUNTING_APPROVE),
    asyncHandler(async (req, res) => {
      const id = getRequiredParam(req.params, "id");
      const input = rejectFixedAssetTransferSchema.parse(req.body);
      const data = await accountingService.rejectFixedAssetTransfer(
        id,
        req.user!.id,
        String(input.reason),
      );
      void logAudit({
        action: "reject",
        resource: "fixed_asset_transfer",
        resourceId: id,
        req,
      });
      res.json({ data });
    }),
  );

  // Revaluation / impairment queue + per-asset history (WS2). Same shape as the
  // disposal queue: submit needs accounting:create (owner-scoped in the
  // service), approve/reject need accounting:approve. The EFFECTIVE date
  // governs the accounting period, never the approval date.
  //
  // Approve is ACCOUNTING_APPROVE, not ACCOUNTING_POST: it recognises the
  // P&L / OCI split on the asset but posts no journal entry yet (see the
  // TODO(WS2-posting) in approveFixedAssetRemeasurement). When the GL half
  // lands the gate moves with it.
  router.get(
    "/fixed-asset-remeasurements",
    requirePermission(PERMISSIONS.ACCOUNTING_READ),
    asyncHandler(async (req, res) => {
      const parsed = fixedAssetRemeasurementQuerySchema.parse(req.query);
      const data = await accountingService.listFixedAssetRemeasurements(
        {
          entityId: parsed.entityId ? String(parsed.entityId) : undefined,
          status: parsed.status,
          assetId: parsed.assetId ? String(parsed.assetId) : undefined,
          kind: parsed.kind,
        },
        req.user!.id,
        req.user!.permissions,
      );
      res.json(data);
    }),
  );

  router.get(
    "/fixed-asset-remeasurements/:id",
    requirePermission(PERMISSIONS.ACCOUNTING_READ),
    asyncHandler(async (req, res) => {
      const id = getRequiredParam(req.params, "id");
      const data = await accountingService.getFixedAssetRemeasurement(
        id,
        req.user!.id,
        req.user!.permissions,
      );
      res.json({ data });
    }),
  );

  router.get(
    "/fixed-assets/:id/remeasurements",
    requirePermission(PERMISSIONS.ACCOUNTING_READ),
    asyncHandler(async (req, res) => {
      const id = getRequiredParam(req.params, "id");
      const data = await accountingService.listFixedAssetRemeasurementsForAsset(
        id,
        req.user!.id,
        req.user!.permissions,
      );
      res.json(data);
    }),
  );

  router.post(
    "/fixed-assets/:id/remeasurements",
    requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
    asyncHandler(async (req, res) => {
      const id = getRequiredParam(req.params, "id");
      const parsed = submitFixedAssetRemeasurementSchema.parse(req.body);
      const input = {
        kind: parsed.kind,
        effectiveDate: String(parsed.effectiveDate),
        carryingAfter: Number(parsed.carryingAfter),
        reason: parsed.reason ?? null,
        evidenceUrl: parsed.evidenceUrl ?? null,
      };
      const data = await accountingService.submitFixedAssetRemeasurement(
        id,
        input,
        req.user!.id,
        req.user!.permissions,
      );
      void logAudit({
        action: "submit",
        resource: "fixed_asset_remeasurement",
        resourceId: data.id,
        details: {
          assetId: id,
          kind: input.kind,
          effectiveDate: input.effectiveDate,
          carryingAfter: input.carryingAfter,
        },
        req,
      });
      res.status(201).json({ data });
    }),
  );

  router.put(
    "/fixed-asset-remeasurements/:id/approve",
    requirePermission(PERMISSIONS.ACCOUNTING_APPROVE),
    asyncHandler(async (req, res) => {
      const id = getRequiredParam(req.params, "id");
      const data = await accountingService.approveFixedAssetRemeasurement(
        id,
        req.user!.id,
      );
      void logAudit({
        action: "approve",
        resource: "fixed_asset_remeasurement",
        resourceId: id,
        details: {
          kind: data.kind,
          effectiveDate: data.effectiveDate,
          movement: data.movement.toFixed(2),
          profitOrLoss: data.profitOrLoss.toFixed(2),
          oci: data.oci.toFixed(2),
        },
        req,
      });
      res.json({ data });
    }),
  );

  router.put(
    "/fixed-asset-remeasurements/:id/reject",
    requirePermission(PERMISSIONS.ACCOUNTING_APPROVE),
    asyncHandler(async (req, res) => {
      const id = getRequiredParam(req.params, "id");
      const input = rejectFixedAssetRemeasurementSchema.parse(req.body);
      const data = await accountingService.rejectFixedAssetRemeasurement(
        id,
        req.user!.id,
        String(input.reason),
      );
      void logAudit({
        action: "reject",
        resource: "fixed_asset_remeasurement",
        resourceId: id,
        req,
      });
      res.json({ data });
    }),
  );

  // Reports (read-only, org-scoped by accounting:read; owner-scope N/A — these
  // are entity-wide roll-ups). All computed server-side over the full set.
  router.get(
    "/reports/fixed-assets/register",
    requirePermission(PERMISSIONS.ACCOUNTING_READ),
    asyncHandler(async (req, res) => {
      const query = fixedAssetReportQuerySchema.parse(req.query);
      const data = await accountingService.fixedAssetRegisterReport(query);
      res.json({ data });
    }),
  );

  router.get(
    "/reports/fixed-assets/depreciation-schedule",
    requirePermission(PERMISSIONS.ACCOUNTING_READ),
    asyncHandler(async (req, res) => {
      const query = fixedAssetScheduleQuerySchema.parse(req.query);
      const data =
        await accountingService.fixedAssetDepreciationSchedule(query);
      res.json({ data });
    }),
  );

  router.get(
    "/reports/fixed-assets/disposals",
    requirePermission(PERMISSIONS.ACCOUNTING_READ),
    asyncHandler(async (req, res) => {
      const query = fixedAssetPeriodReportQuerySchema.parse(req.query);
      const data = await accountingService.fixedAssetDisposalReport(query);
      res.json({ data });
    }),
  );

  router.get(
    "/reports/fixed-assets/movement",
    requirePermission(PERMISSIONS.ACCOUNTING_READ),
    asyncHandler(async (req, res) => {
      const query = fixedAssetPeriodReportQuerySchema.parse(req.query);
      const data = await accountingService.fixedAssetMovementReport(query);
      res.json({ data });
    }),
  );

  // Deferred tax on the book-vs-tax life difference (WS5). Read-only; the
  // payload carries `exclusions` + `coverage` so a schedule covering 40 of 300
  // assets says so on its face rather than reading as complete.
  router.get(
    "/reports/fixed-assets/deferred-tax",
    requirePermission(PERMISSIONS.ACCOUNTING_READ),
    asyncHandler(async (req, res) => {
      const parsed = fixedAssetReportQuerySchema.parse(req.query);
      const data = await accountingService.fixedAssetDeferredTaxReport({
        entityId: String(parsed.entityId),
        asOf: parsed.asOf ? String(parsed.asOf) : undefined,
      });
      res.json({ data });
    }),
  );
}

export default router;
