import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { PERMISSIONS } from "@nexora/contracts";
import {
  accountMappingQuerySchema,
  accountQuerySchema,
  accountingSearchQuerySchema,
  activateCompanySchema,
  bankAccountQuerySchema,
  closePeriodSchema,
  companyProfileQuerySchema,
  createAccountSchema,
  createInvoiceSchema,
  createJournalSchema,
  createQuoteSchema,
  upsertTaxCodeSchema,
  creditNoteQuerySchema,
  fiscalPeriodQuerySchema,
  fixedAssetCategoryQuerySchema,
  fixedAssetQuerySchema,
  invoiceCompanySchema,
  invoiceQuerySchema,
  journalQuerySchema,
  makerCheckerConfigSchema,
  openingBalancesQuerySchema,
  postingReadinessQuerySchema,
  purchaseOrderQuerySchema,
  quoteQuerySchema,
  rejectJournalSchema,
  reopenPeriodSchema,
  reportAsOfQuerySchema,
  reportPeriodQuerySchema,
  secondApprovalConfigSchema,
  taxCodesQuerySchema,
  taxReportQuerySchema,
  updateAccountSchema,
  updateCompanyProfileSchema,
  updateInvoiceSchema,
  updateInvoiceStatusSchema,
  updateJournalSchema,
  updateQuoteSchema,
  updateTaxCodeSchema,
  upsertAccountMappingSchema,
} from "@nexora/contracts/modules/accounting/accounting.validation";
import { accountingService, isFixedAssetsEnabled } from "@nexora/core";
import type { AppEnv } from "../lib/context";
import { NotFoundException } from "../lib/errors";
import { requirePermission } from "../middleware/rbac";

const accountingRead = [PERMISSIONS.ACCOUNTING_READ, PERMISSIONS.ACCOUNTING_READ_ALL] as const;

function notImplemented(message: string) {
  return (c: { json: (body: unknown, status?: number) => Response }) =>
    c.json({ error: { code: "NOT_IMPLEMENTED", message } }, 501);
}

function requireFixedAssets() {
  return async (
    c: { env: AppEnv["Bindings"]; json: (b: unknown, s?: number) => Response },
    next: () => Promise<void>,
  ) => {
    if (!isFixedAssetsEnabled(c.env)) {
      throw new NotFoundException("Fixed assets module is not enabled");
    }
    await next();
  };
}

export const accounting = new Hono<AppEnv>()
  // ── Stubs (literal paths before param routes) ─────────────────────────────
  .get("/overview", requirePermission(...accountingRead), notImplemented("Corporate overview is not available on edge yet"))
  .post("/journals/import/preview", requirePermission(PERMISSIONS.ACCOUNTING_CREATE), notImplemented("Journal import is not available on edge yet"))
  .post("/journals/import/commit", requirePermission(PERMISSIONS.ACCOUNTING_CREATE), notImplemented("Journal import is not available on edge yet"))
  .post("/journals/bulk-delete", requirePermission(PERMISSIONS.ACCOUNTING_CREATE), notImplemented("Bulk journal delete is not available on edge yet"))
  .post("/journals/bulk-approve", requirePermission(PERMISSIONS.ACCOUNTING_APPROVE), notImplemented("Bulk journal approve is not available on edge yet"))
  .post("/journals/bulk-reject", requirePermission(PERMISSIONS.ACCOUNTING_APPROVE), notImplemented("Bulk journal reject is not available on edge yet"))
  .post("/accounts/import/preview", requirePermission(PERMISSIONS.ACCOUNTING_ADMIN), notImplemented("COA import is not available on edge yet"))
  .post("/accounts/import/commit", requirePermission(PERMISSIONS.ACCOUNTING_ADMIN), notImplemented("COA import is not available on edge yet"))
  .post("/accounts/reuse-check", requirePermission(PERMISSIONS.ACCOUNTING_CREATE), notImplemented("COA reuse check is not available on edge yet"))
  .get("/accounts/reused-codes", requirePermission(PERMISSIONS.ACCOUNTING_READ), notImplemented("COA reused codes is not available on edge yet"))
  .post("/fiscal-periods/revalue", requirePermission(PERMISSIONS.ACCOUNTING_ADMIN), notImplemented("Period revaluation is not available on edge yet"))
  .post("/opening-balances", requirePermission(PERMISSIONS.ACCOUNTING_ADMIN), notImplemented("Opening balance import is not available on edge yet"))
  .get("/reports/tax-registers", requirePermission(...accountingRead), notImplemented("Tax registers report is not available on edge yet"))
  .get("/reports/statutory", requirePermission(...accountingRead), notImplemented("Statutory reports are not available on edge yet"))

  // ── Account mappings + posting readiness ──────────────────────────────────
  .get(
    "/account-mappings",
    requirePermission(PERMISSIONS.ACCOUNTING_READ),
    zValidator("query", accountMappingQuerySchema),
    async (c) =>
      c.json({ data: await accountingService.getAccountMappings(c.var.db, c.req.valid("query")) }),
  )
  .put(
    "/account-mappings",
    requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
    zValidator("json", upsertAccountMappingSchema),
    async (c) =>
      c.json({ data: await accountingService.setAccountMapping(c.var.db, c.req.valid("json")) }),
  )
  .get(
    "/posting-readiness",
    requirePermission(PERMISSIONS.ACCOUNTING_READ),
    zValidator("query", postingReadinessQuerySchema),
    async (c) =>
      c.json({ data: await accountingService.getPostingReadiness(c.var.db, c.req.valid("query"), c.env) }),
  )

  // ── Company setup ─────────────────────────────────────────────────────────
  .get(
    "/company-setup",
    requirePermission(PERMISSIONS.ACCOUNTING_READ),
    zValidator("query", companyProfileQuerySchema),
    async (c) =>
      c.json({
        data: await accountingService.getCompanyProfile(c.var.db, c.req.valid("query").entityId),
      }),
  )
  .put(
    "/company-setup",
    requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
    zValidator("json", updateCompanyProfileSchema),
    async (c) =>
      c.json({ data: await accountingService.updateCompanyProfile(c.var.db, c.req.valid("json")) }),
  )
  .post(
    "/company-setup/activate",
    requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
    zValidator("json", activateCompanySchema),
    async (c) =>
      c.json({ data: await accountingService.activateCompany(c.var.db, c.req.valid("json")) }),
  )
  .get(
    "/opening-balances",
    requirePermission(PERMISSIONS.ACCOUNTING_READ),
    zValidator("query", openingBalancesQuerySchema),
    async (c) =>
      c.json({ data: await accountingService.getOpeningBalanceStatus(c.var.db, c.req.valid("query")) }),
  )

  // ── Tax codes ─────────────────────────────────────────────────────────────
  .get(
    "/tax-codes",
    requirePermission(PERMISSIONS.ACCOUNTING_READ),
    zValidator("query", taxCodesQuerySchema),
    async (c) => c.json(await accountingService.listTaxCodes(c.var.db, c.req.valid("query"))),
  )
  .post(
    "/tax-codes",
    requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
    zValidator("json", upsertTaxCodeSchema),
    async (c) =>
      c.json({ data: await accountingService.createTaxCode(c.var.db, c.req.valid("json")) }, 201),
  )

  // ── Second approval config ────────────────────────────────────────────────
  .get("/second-approval/config", requirePermission(PERMISSIONS.ACCOUNTING_READ), async (c) =>
    c.json({ data: await accountingService.getSecondApprovalConfig(c.var.db) }),
  )
  .put(
    "/second-approval/config",
    requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
    zValidator("json", secondApprovalConfigSchema),
    async (c) =>
      c.json({ data: await accountingService.setSecondApprovalConfig(c.var.db, c.req.valid("json")) }),
  )

  // ── Invoice company block ─────────────────────────────────────────────────
  .get("/invoices/company", requirePermission(...accountingRead), async (c) =>
    c.json({ data: await accountingService.getInvoiceCompany(c.var.db) }),
  )
  .put(
    "/invoices/company",
    requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
    zValidator("json", invoiceCompanySchema),
    async (c) =>
      c.json({ data: await accountingService.setInvoiceCompany(c.var.db, c.req.valid("json")) }),
  )

  // ── Search + reports ──────────────────────────────────────────────────────
  .get(
    "/search",
    requirePermission(...accountingRead),
    zValidator("query", accountingSearchQuerySchema),
    async (c) =>
      c.json({
        data: await accountingService.searchAccounting(
          c.var.db,
          c.var.user!.id,
          c.var.user!.permissions,
          c.req.valid("query"),
        ),
      }),
  )
  .get(
    "/reports/trial-balance",
    requirePermission(...accountingRead),
    zValidator("query", reportAsOfQuerySchema),
    async (c) => c.json({ data: await accountingService.getTrialBalance(c.var.db, c.req.valid("query")) }),
  )
  .get(
    "/reports/profit-and-loss",
    requirePermission(...accountingRead),
    zValidator("query", reportPeriodQuerySchema),
    async (c) => c.json({ data: await accountingService.getProfitAndLoss(c.var.db, c.req.valid("query")) }),
  )
  .get(
    "/reports/balance-sheet",
    requirePermission(...accountingRead),
    zValidator("query", reportAsOfQuerySchema),
    async (c) => c.json({ data: await accountingService.getBalanceSheet(c.var.db, c.req.valid("query")) }),
  )
  .get(
    "/reports/cash-flow",
    requirePermission(...accountingRead),
    zValidator("query", reportPeriodQuerySchema),
    async (c) => c.json({ data: await accountingService.getCashFlow(c.var.db, c.req.valid("query")) }),
  )
  .get(
    "/reports/tax-summary",
    requirePermission(...accountingRead),
    zValidator("query", taxReportQuerySchema),
    async (c) => c.json({ data: await accountingService.getTaxReport(c.var.db, c.req.valid("query")) }),
  )

  // ── Maker-checker ─────────────────────────────────────────────────────────
  .get("/maker-checker", requirePermission(PERMISSIONS.ACCOUNTING_READ), async (c) =>
    c.json({ data: await accountingService.getMakerCheckerConfig(c.var.db) }),
  )
  .put(
    "/maker-checker",
    requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
    zValidator("json", makerCheckerConfigSchema),
    async (c) =>
      c.json({ data: await accountingService.setMakerCheckerConfig(c.var.db, c.req.valid("json")) }),
  )

  // ── Chart of accounts ─────────────────────────────────────────────────────
  .get("/accounts", requirePermission(...accountingRead), zValidator("query", accountQuerySchema), async (c) =>
    c.json(await accountingService.listAccounts(c.var.db, c.req.valid("query"))),
  )
  .post(
    "/accounts",
    requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
    zValidator("json", createAccountSchema),
    async (c) =>
      c.json({ data: await accountingService.createAccount(c.var.db, c.req.valid("json")) }, 201),
  )
  .get("/accounts/:id", requirePermission(...accountingRead), async (c) =>
    c.json({ data: await accountingService.getAccountById(c.var.db, c.req.param("id")) }),
  )
  .put(
    "/accounts/:id",
    requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
    zValidator("json", updateAccountSchema),
    async (c) =>
      c.json({ data: await accountingService.updateAccount(c.var.db, c.req.param("id"), c.req.valid("json")) }),
  )
  .delete("/accounts/:id", requirePermission(PERMISSIONS.ACCOUNTING_ADMIN), async (c) => {
    await accountingService.deleteAccount(c.var.db, c.req.param("id"));
    return c.json({ data: { success: true } });
  })

  // ── Journals ──────────────────────────────────────────────────────────────
  .get(
    "/journals/reversals",
    requirePermission(...accountingRead),
    zValidator("query", reportPeriodQuerySchema),
    async (c) =>
      c.json({ data: await accountingService.listJournalReversals(c.var.db, c.req.valid("query")) }),
  )
  .get("/journals", requirePermission(...accountingRead), zValidator("query", journalQuerySchema), async (c) =>
    c.json(
      await accountingService.listJournals(
        c.var.db,
        c.var.user!.id,
        c.var.user!.permissions,
        c.req.valid("query"),
      ),
    ),
  )
  .post(
    "/journals",
    requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
    zValidator("json", createJournalSchema),
    async (c) =>
      c.json(
        { data: await accountingService.createJournal(c.var.db, c.var.user!.id, c.req.valid("json")) },
        201,
      ),
  )
  .get("/journals/:id", requirePermission(...accountingRead), async (c) =>
    c.json({
      data: await accountingService.getJournalById(
        c.var.db,
        c.req.param("id"),
        c.var.user!.id,
        c.var.user!.permissions,
      ),
    }),
  )
  .put(
    "/journals/:id",
    requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
    zValidator("json", updateJournalSchema),
    async (c) =>
      c.json({
        data: await accountingService.updateJournal(
          c.var.db,
          c.req.param("id"),
          c.var.user!.id,
          c.var.user!.permissions,
          c.req.valid("json"),
        ),
      }),
  )
  .delete("/journals/:id", requirePermission(PERMISSIONS.ACCOUNTING_CREATE), async (c) => {
    await accountingService.deleteJournal(
      c.var.db,
      c.req.param("id"),
      c.var.user!.id,
      c.var.user!.permissions,
    );
    return c.json({ data: { success: true } });
  })
  .post("/journals/:id/restore", requirePermission(PERMISSIONS.ACCOUNTING_CREATE), async (c) =>
    c.json({
      data: await accountingService.restoreJournal(
        c.var.db,
        c.req.param("id"),
        c.var.user!.id,
        c.var.user!.permissions,
      ),
    }),
  )
  .put("/journals/:id/approve", requirePermission(PERMISSIONS.ACCOUNTING_APPROVE), async (c) =>
    c.json({ data: await accountingService.approveJournal(c.var.db, c.req.param("id"), c.var.user!.id) }),
  )
  .put(
    "/journals/:id/reject",
    requirePermission(PERMISSIONS.ACCOUNTING_APPROVE),
    zValidator("json", rejectJournalSchema),
    async (c) =>
      c.json({
        data: await accountingService.rejectJournal(
          c.var.db,
          c.req.param("id"),
          c.var.user!.id,
          c.req.valid("json"),
        ),
      }),
  )
  .put("/journals/:id/post", requirePermission(PERMISSIONS.ACCOUNTING_POST), notImplemented("Separate journal post is not available on edge — use approve"))
  .put("/journals/:id/cancel", requirePermission(PERMISSIONS.ACCOUNTING_POST), notImplemented("Journal cancel is not available on edge yet"))

  // ── Invoices (AR) ─────────────────────────────────────────────────────────
  .get("/invoices", requirePermission(...accountingRead), zValidator("query", invoiceQuerySchema), async (c) =>
    c.json(
      await accountingService.listInvoices(
        c.var.db,
        c.var.user!.id,
        c.var.user!.permissions,
        c.req.valid("query"),
      ),
    ),
  )
  .post(
    "/invoices",
    requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
    zValidator("json", createInvoiceSchema),
    async (c) =>
      c.json(
        {
          data: await accountingService.createInvoice(
            c.var.db,
            c.var.user!.id,
            c.var.user!.permissions,
            c.req.valid("json"),
          ),
        },
        201,
      ),
  )
  .get("/invoices/:id", requirePermission(...accountingRead), async (c) =>
    c.json({
      data: await accountingService.getInvoiceById(
        c.var.db,
        c.req.param("id"),
        c.var.user!.id,
        c.var.user!.permissions,
      ),
    }),
  )
  .put(
    "/invoices/:id",
    requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
    zValidator("json", updateInvoiceSchema),
    async (c) =>
      c.json({
        data: await accountingService.updateInvoice(
          c.var.db,
          c.req.param("id"),
          c.var.user!.id,
          c.var.user!.permissions,
          c.req.valid("json"),
        ),
      }),
  )
  .delete("/invoices/:id", requirePermission(PERMISSIONS.ACCOUNTING_CREATE), async (c) => {
    await accountingService.deleteInvoice(
      c.var.db,
      c.req.param("id"),
      c.var.user!.id,
      c.var.user!.permissions,
    );
    return c.json({ data: { success: true } });
  })
  .post("/invoices/:id/restore", requirePermission(PERMISSIONS.ACCOUNTING_CREATE), async (c) =>
    c.json({
      data: await accountingService.restoreInvoice(
        c.var.db,
        c.req.param("id"),
        c.var.user!.id,
        c.var.user!.permissions,
      ),
    }),
  )
  .patch(
    "/invoices/:id/status",
    requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
    zValidator("json", updateInvoiceStatusSchema),
    async (c) =>
      c.json({
        data: await accountingService.updateInvoiceStatus(
          c.var.db,
          c.req.param("id"),
          c.var.user!.id,
          c.var.user!.permissions,
          c.req.valid("json"),
        ),
      }),
  )
  .post(
    "/invoices/:id/second-approval/:decision",
    requirePermission(PERMISSIONS.ACCOUNTING_APPROVE),
    notImplemented("Second approval decisions are not available on edge yet"),
  )
  .get("/invoices/:id/pdf", requirePermission(...accountingRead), notImplemented("Invoice PDF export is not available on edge yet"))
  .get("/invoices/:id/docx", requirePermission(...accountingRead), notImplemented("Invoice DOCX export is not available on edge yet"))
  .get("/invoices/:id/xlsx", requirePermission(...accountingRead), notImplemented("Invoice XLSX export is not available on edge yet"))
  .get("/invoices/:id/payments", requirePermission(...accountingRead), notImplemented("Invoice payments are not available on edge yet"))
  .post("/invoices/:id/payments", requirePermission(PERMISSIONS.ACCOUNTING_CREATE), notImplemented("Invoice payments are not available on edge yet"))

  // ── Bills (AP alias) ──────────────────────────────────────────────────────
  .get("/bills", requirePermission(...accountingRead), zValidator("query", invoiceQuerySchema), async (c) => {
    const query = { ...c.req.valid("query"), type: "payable" as const };
    return c.json(
      await accountingService.listInvoices(c.var.db, c.var.user!.id, c.var.user!.permissions, query),
    );
  })
  .post(
    "/bills",
    requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
    zValidator("json", createInvoiceSchema),
    async (c) => {
      const body = { ...c.req.valid("json"), type: "payable" as const };
      return c.json(
        {
          data: await accountingService.createInvoice(
            c.var.db,
            c.var.user!.id,
            c.var.user!.permissions,
            body,
          ),
        },
        201,
      );
    },
  )
  .get("/bills/:id", requirePermission(...accountingRead), async (c) =>
    c.json({
      data: await accountingService.getInvoiceById(
        c.var.db,
        c.req.param("id"),
        c.var.user!.id,
        c.var.user!.permissions,
      ),
    }),
  )
  .put(
    "/bills/:id",
    requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
    zValidator("json", updateInvoiceSchema),
    async (c) =>
      c.json({
        data: await accountingService.updateInvoice(
          c.var.db,
          c.req.param("id"),
          c.var.user!.id,
          c.var.user!.permissions,
          c.req.valid("json"),
        ),
      }),
  )
  .delete("/bills/:id", requirePermission(PERMISSIONS.ACCOUNTING_CREATE), async (c) => {
    await accountingService.deleteInvoice(
      c.var.db,
      c.req.param("id"),
      c.var.user!.id,
      c.var.user!.permissions,
    );
    return c.json({ data: { success: true } });
  })
  .post("/bills/:id/restore", requirePermission(PERMISSIONS.ACCOUNTING_CREATE), async (c) =>
    c.json({
      data: await accountingService.restoreInvoice(
        c.var.db,
        c.req.param("id"),
        c.var.user!.id,
        c.var.user!.permissions,
      ),
    }),
  )
  .patch(
    "/bills/:id/status",
    requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
    zValidator("json", updateInvoiceStatusSchema),
    async (c) =>
      c.json({
        data: await accountingService.updateInvoiceStatus(
          c.var.db,
          c.req.param("id"),
          c.var.user!.id,
          c.var.user!.permissions,
          c.req.valid("json"),
        ),
      }),
  )

  // ── Quotes ────────────────────────────────────────────────────────────────
  .get("/quotes", requirePermission(...accountingRead), zValidator("query", quoteQuerySchema), async (c) =>
    c.json(
      await accountingService.listQuotes(
        c.var.db,
        c.var.user!.id,
        c.var.user!.permissions,
        c.req.valid("query"),
      ),
    ),
  )
  .post(
    "/quotes",
    requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
    zValidator("json", createQuoteSchema),
    async (c) =>
      c.json({ data: await accountingService.createQuote(c.var.db, c.var.user!.id, c.req.valid("json")) }, 201),
  )
  .get("/quotes/:id", requirePermission(...accountingRead), async (c) =>
    c.json({
      data: await accountingService.getQuoteById(
        c.var.db,
        c.req.param("id"),
        c.var.user!.id,
        c.var.user!.permissions,
      ),
    }),
  )
  .put(
    "/quotes/:id",
    requirePermission(PERMISSIONS.ACCOUNTING_CREATE),
    zValidator("json", updateQuoteSchema),
    async (c) =>
      c.json({
        data: await accountingService.updateQuote(
          c.var.db,
          c.req.param("id"),
          c.var.user!.id,
          c.var.user!.permissions,
          c.req.valid("json"),
        ),
      }),
  )
  .delete("/quotes/:id", requirePermission(PERMISSIONS.ACCOUNTING_CREATE), async (c) => {
    await accountingService.deleteQuote(
      c.var.db,
      c.req.param("id"),
      c.var.user!.id,
      c.var.user!.permissions,
    );
    return c.json({ data: { success: true } });
  })
  .post("/quotes/:id/send", requirePermission(PERMISSIONS.ACCOUNTING_CREATE), async (c) =>
    c.json({
      data: await accountingService.sendQuote(
        c.var.db,
        c.req.param("id"),
        c.var.user!.id,
        c.var.user!.permissions,
      ),
    }),
  )
  .post("/quotes/:id/convert", requirePermission(PERMISSIONS.ACCOUNTING_CREATE), async (c) =>
    c.json({
      data: await accountingService.convertQuote(
        c.var.db,
        c.req.param("id"),
        c.var.user!.id,
        c.var.user!.permissions,
      ),
    }),
  )

  // ── Bank accounts (read) ──────────────────────────────────────────────────
  .get(
    "/bank-accounts",
    requirePermission(...accountingRead),
    zValidator("query", bankAccountQuerySchema),
    async (c) => c.json(await accountingService.listBankAccounts(c.var.db, c.req.valid("query"))),
  )
  .get("/bank-accounts/:id", requirePermission(...accountingRead), async (c) =>
    c.json({ data: await accountingService.getBankAccountById(c.var.db, c.req.param("id")) }),
  )

  // ── Credit notes (read) ───────────────────────────────────────────────────
  .get(
    "/credit-notes",
    requirePermission(...accountingRead),
    zValidator("query", creditNoteQuerySchema),
    async (c) => c.json(await accountingService.listCreditNotes(c.var.db, c.req.valid("query"))),
  )
  .get("/credit-notes/:id", requirePermission(...accountingRead), async (c) =>
    c.json({ data: await accountingService.getCreditNoteById(c.var.db, c.req.param("id")) }),
  )

  // ── Purchase orders (read) ────────────────────────────────────────────────
  .get(
    "/purchase-orders",
    requirePermission(...accountingRead),
    zValidator("query", purchaseOrderQuerySchema),
    async (c) => c.json(await accountingService.listPurchaseOrders(c.var.db, c.req.valid("query"))),
  )
  .get("/purchase-orders/:id", requirePermission(...accountingRead), async (c) =>
    c.json({ data: await accountingService.getPurchaseOrderById(c.var.db, c.req.param("id")) }),
  )

  // ── Tax codes by id ───────────────────────────────────────────────────────
  .get("/tax-codes/:id", requirePermission(PERMISSIONS.ACCOUNTING_READ), async (c) =>
    c.json({ data: await accountingService.getTaxCodeById(c.var.db, c.req.param("id")) }),
  )
  .put(
    "/tax-codes/:id",
    requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
    zValidator("json", updateTaxCodeSchema),
    async (c) =>
      c.json({ data: await accountingService.updateTaxCode(c.var.db, c.req.param("id"), c.req.valid("json")) }),
  )
  .delete("/tax-codes/:id", requirePermission(PERMISSIONS.ACCOUNTING_ADMIN), async (c) => {
    await accountingService.deleteTaxCode(c.var.db, c.req.param("id"));
    return c.json({ data: { success: true } });
  })

  // ── Fiscal periods ────────────────────────────────────────────────────────
  .get("/fiscal-periods", requirePermission(...accountingRead), zValidator("query", fiscalPeriodQuerySchema), async (c) =>
    c.json(await accountingService.listFiscalPeriods(c.var.db, c.req.valid("query"))),
  )
  .post(
    "/fiscal-periods/close",
    requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
    zValidator("json", closePeriodSchema),
    async (c) =>
      c.json({ data: await accountingService.closePeriod(c.var.db, c.var.user!.id, c.req.valid("json")) }),
  )
  .post(
    "/fiscal-periods/reopen",
    requirePermission(PERMISSIONS.ACCOUNTING_ADMIN),
    zValidator("json", reopenPeriodSchema),
    async (c) =>
      c.json({ data: await accountingService.reopenPeriod(c.var.db, c.var.user!.id, c.req.valid("json")) }),
  )

  // ── Fixed assets (read-only, fail-closed flag) ────────────────────────────
  .get(
    "/fixed-asset-categories",
    requirePermission(...accountingRead),
    requireFixedAssets(),
    zValidator("query", fixedAssetCategoryQuerySchema),
    async (c) =>
      c.json(await accountingService.listFixedAssetCategories(c.var.db, c.req.valid("query"), c.env)),
  )
  .get(
    "/fixed-assets",
    requirePermission(...accountingRead),
    requireFixedAssets(),
    zValidator("query", fixedAssetQuerySchema),
    async (c) => c.json(await accountingService.listFixedAssets(c.var.db, c.req.valid("query"), c.env)),
  )
  .get("/fixed-assets/depreciation-run", requirePermission(...accountingRead), requireFixedAssets(), notImplemented("Depreciation run is not available on edge yet"))
  .post("/fixed-assets/depreciation-run", requirePermission(PERMISSIONS.ACCOUNTING_POST), requireFixedAssets(), notImplemented("Depreciation run is not available on edge yet"))
  .get("/fixed-asset-categories/:id", requirePermission(...accountingRead), requireFixedAssets(), async (c) =>
    c.json({
      data: await accountingService.getFixedAssetCategoryById(c.var.db, c.req.param("id"), c.env),
    }),
  )
  .get(
    "/fixed-assets/:id",
    requirePermission(...accountingRead),
    requireFixedAssets(),
    async (c) => {
      const asOf = c.req.query("asOf");
      return c.json({
        data: await accountingService.getFixedAssetById(c.var.db, c.req.param("id"), asOf, c.env),
      });
    },
  )
  .get(
    "/reports/fixed-assets/register",
    requirePermission(...accountingRead),
    requireFixedAssets(),
    notImplemented("Fixed asset register report is not available on edge yet"),
  )
  .get(
    "/reports/fixed-assets/depreciation-schedule",
    requirePermission(...accountingRead),
    requireFixedAssets(),
    notImplemented("Fixed asset depreciation schedule report is not available on edge yet"),
  )
  .get(
    "/reports/fixed-assets/disposals",
    requirePermission(...accountingRead),
    requireFixedAssets(),
    notImplemented("Fixed asset disposals report is not available on edge yet"),
  )
  .get(
    "/reports/fixed-assets/movement",
    requirePermission(...accountingRead),
    requireFixedAssets(),
    notImplemented("Fixed asset movement report is not available on edge yet"),
  )
  .get(
    "/reports/fixed-assets/deferred-tax",
    requirePermission(...accountingRead),
    requireFixedAssets(),
    notImplemented("Fixed asset deferred tax report is not available on edge yet"),
  )

  // Catch-all for remaining Express accounting surface
  .all("*", notImplemented("This accounting endpoint is not available on edge yet"));
