/**
 * Accounting module — edge/core port (phase 2: mappings, setup, reports, search, reads).
 */

import { eq } from "drizzle-orm";
import type { Db } from "@nexora/db";
import { schema } from "@nexora/db";
import { PERMISSIONS } from "@nexora/contracts";
import type {
  AccountMappingQuery,
  AccountingSearchQuery,
  ActivateCompanyInput,
  BankAccountQuery,
  CreditNoteQuery,
  InvoiceCompanyInput,
  OpeningBalancesQuery,
  PostingReadinessQuery,
  PurchaseOrderQuery,
  ReportAsOfQuery,
  ReportPeriodQuery,
  SecondApprovalConfigInput,
  TaxCodesQuery,
  TaxReportQuery,
  UpdateCompanyProfileInput,
  UpsertAccountMappingInput,
  UpsertTaxCodeInput,
  UpdateTaxCodeInput,
  FixedAssetCategoryQuery,
} from "@nexora/contracts/modules/accounting/accounting.validation";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "../http-exception";
import { isGlPostingEnabled } from "./accounting.flags";
import { buildRoleView, computeReadiness } from "./mapping-readiness";
import {
  buildBalanceSheet,
  buildCashFlow,
  buildProfitAndLoss,
  buildTaxSummary,
  buildTrialBalance,
  fiscalYearStartOnOrBefore,
  netIncome,
} from "./reports";
import {
  buildDefaultInvoiceCompany,
  INVOICE_COMPANY_KEY,
  type InvoiceCompany,
} from "./invoice-company.defaults";
import { APP_NAME_SETTING_KEY, orgNameFromSetting } from "../lib/org";
import {
  DEFAULT_SECOND_APPROVAL,
  type SecondApprovalConfig,
} from "./second-approval.defaults";
import { allocateDocumentNumber } from "./numbering.service";
import { getSetting, upsertSetting } from "../survey/system-settings.repository";
import * as repo from "./accounting.repository";
import { createCuid } from "../lib/id";
import { getQuoteById } from "./accounting.service";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

function asOfDateStr(asOf?: string): string {
  if (asOf) return asOf.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

function dayBeforeIso(startDate: string): string {
  const d = new Date(`${startDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function parseInvoiceCompany(
  value: unknown,
  fallback: InvoiceCompany,
): InvoiceCompany {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    const str = (k: keyof InvoiceCompany, d: string) =>
      typeof v[k] === "string" ? (v[k] as string) : d;
    return {
      name: str("name", fallback.name),
      addressLines: Array.isArray(v.addressLines)
        ? (v.addressLines as unknown[]).filter((x): x is string => typeof x === "string")
        : fallback.addressLines,
      taxId: str("taxId", fallback.taxId),
      email: str("email", fallback.email),
      tel: str("tel", fallback.tel),
      bankName: str("bankName", fallback.bankName),
      bankAccountType: str("bankAccountType", fallback.bankAccountType),
      bankBranch: str("bankBranch", fallback.bankBranch),
      bankAccountName: str("bankAccountName", fallback.bankAccountName),
      bankAccountNo: str("bankAccountNo", fallback.bankAccountNo),
      bankSwift: str("bankSwift", fallback.bankSwift),
      footerNote: str("footerNote", fallback.footerNote),
    };
  }
  return fallback;
}

function parseSecondApproval(value: unknown): SecondApprovalConfig {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    const thresholdsRaw = (v.thresholds ?? {}) as Record<string, unknown>;
    const numOrNull = (k: string) => {
      const x = thresholdsRaw[k];
      if (x === null || x === undefined) return null;
      const n = typeof x === "number" ? x : Number(x);
      return Number.isFinite(n) ? n : null;
    };
    return {
      enabled: v.enabled === true,
      thresholds: {
        invoice: numOrNull("invoice"),
        bill: numOrNull("bill"),
        journal: numOrNull("journal"),
      },
      staleDays:
        typeof v.staleDays === "number" && v.staleDays > 0
          ? v.staleDays
          : DEFAULT_SECOND_APPROVAL.staleDays,
    };
  }
  return DEFAULT_SECOND_APPROVAL;
}

// ── Account mappings + posting readiness ────────────────────────────────────

export async function getAccountMappings(db: Db, query: AccountMappingQuery) {
  const mapped = await repo.findAccountMappings(db, query.entityId);
  return { entityId: query.entityId, roles: buildRoleView(mapped) };
}

export async function setAccountMapping(db: Db, input: UpsertAccountMappingInput) {
  const { entityId, role, chartOfAccountId } = input;

  if (!chartOfAccountId) {
    await repo.deleteAccountMapping(db, entityId, role);
    return { entityId, role, chartOfAccountId: null, account: null };
  }

  const account = await repo.findAccountForMapping(db, entityId, chartOfAccountId);
  if (!account) {
    throw new BadRequestException(
      "Selected account does not exist for this entity, or is inactive.",
    );
  }

  await repo.upsertAccountMapping(db, entityId, role, chartOfAccountId);
  return { entityId, role, chartOfAccountId, account };
}

export async function getPostingReadiness(
  db: Db,
  query: PostingReadinessQuery,
  env?: { ACCOUNTING_GL_POSTING?: string },
) {
  const flagEnabled = isGlPostingEnabled(env);
  const entityId = query.entityId;
  const entityIds = entityId
    ? [entityId]
    : await repo.listEntityIdsWithAccounts(db);

  const readiness = await Promise.all(
    entityIds.map(async (eid) => {
      const mapped = await repo.findAccountMappings(db, eid);
      return computeReadiness(
        eid,
        mapped.map((m) => m.role),
        flagEnabled,
      );
    }),
  );

  return entityId ? readiness[0] : readiness;
}

// ── Company setup ───────────────────────────────────────────────────────────

export async function getCompanyProfile(db: Db, entityId: string) {
  const entity = await repo.findEntitySetup(db, entityId);
  if (!entity) throw new NotFoundException("Entity not found");
  return entity;
}

export async function updateCompanyProfile(db: Db, input: UpdateCompanyProfileInput) {
  const { entityId, ...fields } = input;
  const existing = await repo.findEntitySetup(db, entityId);
  if (!existing) throw new NotFoundException("Entity not found");

  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) data[key] = value;
  }

  return repo.updateEntitySetup(db, entityId, data);
}

export async function activateCompany(db: Db, input: ActivateCompanyInput) {
  const { entityId } = input;
  const entity = await repo.findEntitySetup(db, entityId);
  if (!entity) throw new NotFoundException("Entity not found");

  if (entity.setupState === "active") {
    return { ...entity, activated: false };
  }

  const monthOk =
    typeof entity.fiscalYearStartMonth === "number" &&
    entity.fiscalYearStartMonth >= 1 &&
    entity.fiscalYearStartMonth <= 12;
  if (!monthOk) {
    throw new ConflictException(
      "Set a fiscal-year start month (1–12) before activating the company.",
    );
  }

  const activeAccounts = await repo.countActiveAccounts(db, entityId);
  if (activeAccounts < 1) {
    throw new ConflictException(
      "Add at least one active account to the chart of accounts before activating the company.",
    );
  }

  const openingEntryExists = await repo.hasOpeningEntry(db, entityId);
  if (!openingEntryExists) {
    throw new ConflictException(
      "Import the opening balances before activating the company so the books tie to the prior year.",
    );
  }

  const updated = await repo.updateEntitySetup(db, entityId, { setupState: "active" });
  return { ...updated, activated: true };
}

export async function getOpeningBalanceStatus(db: Db, query: OpeningBalancesQuery) {
  const entity = await repo.findEntitySetup(db, query.entityId);
  if (!entity) throw new NotFoundException("Entity not found");
  const entry = await repo.findOpeningEntry(db, query.entityId);
  return { entityId: query.entityId, exists: entry !== null, entry };
}

// ── Tax codes ───────────────────────────────────────────────────────────────

export async function listTaxCodes(db: Db, query: TaxCodesQuery) {
  const data = await repo.findTaxCodes(db, query.entityId, query.includeInactive ?? false);
  return { data };
}

export async function createTaxCode(db: Db, input: UpsertTaxCodeInput) {
  const existing = await repo.findTaxCodeByEntityAndCode(db, input.entityId, input.code);
  if (existing) {
    throw new ConflictException(`Tax code "${input.code}" already exists for this entity.`);
  }
  if (input.glAccountId) {
    const account = await repo.findAccountForMapping(db, input.entityId, input.glAccountId);
    if (!account) {
      throw new BadRequestException("GL account not found for this entity.");
    }
  }
  const row = await repo.createTaxCode(db, {
    entityId: input.entityId,
    code: input.code,
    name: input.name,
    kind: input.kind,
    rate: input.rate,
    glAccountId: input.glAccountId ?? null,
    isActive: input.isActive ?? true,
  });
  return row;
}

export async function getTaxCodeById(db: Db, id: string) {
  const row = await repo.findTaxCodeById(db, id);
  if (!row) throw new NotFoundException("Tax code not found");
  return row;
}

export async function updateTaxCode(db: Db, id: string, input: UpdateTaxCodeInput) {
  const existing = await repo.findTaxCodeById(db, id);
  if (!existing) throw new NotFoundException("Tax code not found");

  if (input.glAccountId) {
    const account = await repo.findAccountForMapping(db, existing.entityId, input.glAccountId);
    if (!account) {
      throw new BadRequestException("GL account not found for this entity.");
    }
  }

  const patch: Record<string, unknown> = {};
  if (input.code !== undefined) patch.code = input.code;
  if (input.name !== undefined) patch.name = input.name;
  if (input.kind !== undefined) patch.kind = input.kind;
  if (input.rate !== undefined) patch.rate = String(input.rate);
  if (input.glAccountId !== undefined) patch.glAccountId = input.glAccountId;
  if (input.isActive !== undefined) patch.isActive = input.isActive;

  const updated = await repo.updateTaxCode(db, id, patch);
  if (!updated) throw new NotFoundException("Tax code not found");
  return updated;
}

export async function deleteTaxCode(db: Db, id: string) {
  const existing = await repo.findTaxCodeById(db, id);
  if (!existing) throw new NotFoundException("Tax code not found");
  return repo.deleteTaxCode(db, id);
}

// ── Second approval config ──────────────────────────────────────────────────

export async function getSecondApprovalConfig(db: Db) {
  const raw = await repo.getSecondApprovalSetting(db);
  const config = parseSecondApproval(raw);
  const approverCount = await repo.countApprovers(db, PERMISSIONS.ACCOUNTING_APPROVE);
  return { ...config, approverCount };
}

export async function setSecondApprovalConfig(db: Db, input: SecondApprovalConfigInput) {
  const value: SecondApprovalConfig = {
    enabled: input.enabled,
    thresholds: {
      invoice: input.thresholds.invoice ?? null,
      bill: input.thresholds.bill ?? null,
      journal: input.thresholds.journal ?? null,
    },
    staleDays: input.staleDays ?? DEFAULT_SECOND_APPROVAL.staleDays,
  };
  await repo.upsertSecondApprovalSetting(db, value);
  return getSecondApprovalConfig(db);
}

// ── Invoice company block ───────────────────────────────────────────────────

export async function getInvoiceCompany(db: Db): Promise<InvoiceCompany> {
  const [raw, appName] = await Promise.all([
    getSetting(db, INVOICE_COMPANY_KEY),
    getSetting(db, APP_NAME_SETTING_KEY),
  ]);
  const fallback = buildDefaultInvoiceCompany(orgNameFromSetting(appName));
  return parseInvoiceCompany(raw, fallback);
}

export async function setInvoiceCompany(db: Db, input: InvoiceCompanyInput): Promise<InvoiceCompany> {
  const value: InvoiceCompany = {
    name: (input.name ?? "").trim(),
    addressLines: (input.addressLines ?? []).map((l) => l.trim()).filter(Boolean),
    taxId: (input.taxId ?? "").trim(),
    email: (input.email ?? "").trim(),
    tel: (input.tel ?? "").trim(),
    bankName: (input.bankName ?? "").trim(),
    bankAccountType: (input.bankAccountType ?? "").trim(),
    bankBranch: (input.bankBranch ?? "").trim(),
    bankAccountName: (input.bankAccountName ?? "").trim(),
    bankAccountNo: (input.bankAccountNo ?? "").trim(),
    bankSwift: (input.bankSwift ?? "").trim(),
    footerNote: (input.footerNote ?? "").trim(),
  };
  await upsertSetting(db, INVOICE_COMPANY_KEY, value);
  return value;
}

// ── Reports ─────────────────────────────────────────────────────────────────

export async function getTrialBalance(db: Db, query: ReportAsOfQuery) {
  const asOf = asOfDateStr(query.asOf);
  const rows = await repo.getAccountActivity(db, { entityId: query.entityId, to: asOf });
  return { asOf, ...buildTrialBalance(rows) };
}

export async function getProfitAndLoss(db: Db, query: ReportPeriodQuery) {
  const rows = await repo.getAccountActivity(db, {
    entityId: query.entityId,
    from: query.startDate,
    to: query.endDate,
    types: ["revenue", "expense"],
  });
  return {
    startDate: query.startDate,
    endDate: query.endDate,
    ...buildProfitAndLoss(rows),
  };
}

export async function getBalanceSheet(db: Db, query: ReportAsOfQuery) {
  const asOf = asOfDateStr(query.asOf);
  const asOfDate = new Date(`${asOf}T23:59:59.999Z`);
  const asOfRows = await repo.getAccountActivity(db, { entityId: query.entityId, to: asOf });
  const fyStart = fiscalYearStartOnOrBefore(asOfDate, 1, 1);
  const cyRows = await repo.getAccountActivity(db, {
    entityId: query.entityId,
    from: fyStart.toISOString().slice(0, 10),
    to: asOf,
    types: ["revenue", "expense"],
  });
  const currentYearEarnings = netIncome(cyRows);
  return {
    asOf,
    fiscalYearStart: fyStart.toISOString().slice(0, 10),
    ...buildBalanceSheet(asOfRows, currentYearEarnings),
  };
}

export async function getCashFlow(db: Db, query: ReportPeriodQuery) {
  const { startDate, endDate, entityId } = query;
  const dayBefore = dayBeforeIso(startDate);
  const [periodRows, cashIds, openingRows, closingRows] = await Promise.all([
    repo.getAccountActivity(db, { entityId, from: startDate, to: endDate }),
    repo.getCashAccountIds(db, entityId),
    repo.getAccountActivity(db, { entityId, to: dayBefore }),
    repo.getAccountActivity(db, { entityId, to: endDate }),
  ]);
  const cashSet = new Set(cashIds);
  const cashBalance = (rows: Array<{ accountId: string; debit: number; credit: number }>) =>
    round2(
      rows
        .filter((r) => cashSet.has(r.accountId))
        .reduce((s, r) => s + (r.debit - r.credit), 0),
    );
  return {
    startDate,
    endDate,
    ...buildCashFlow(
      periodRows,
      cashSet,
      cashBalance(openingRows),
      cashBalance(closingRows),
    ),
  };
}

export async function getTaxReport(db: Db, query: TaxReportQuery) {
  const [mappings, rows] = await Promise.all([
    repo.findAccountMappings(db, query.entityId),
    repo.getAccountActivity(db, {
      entityId: query.entityId,
      from: query.startDate,
      to: query.endDate,
    }),
  ]);
  const roleMap = new Map(mappings.map((m) => [m.role, m.chartOfAccountId]));
  const summary = buildTaxSummary(rows, {
    vatOutput: roleMap.get("vat_output"),
    vatInput: roleMap.get("vat_input"),
    whtPayable: roleMap.get("wht_payable"),
    whtReceivable: roleMap.get("wht_receivable"),
  });
  return {
    entityId: query.entityId,
    startDate: query.startDate,
    endDate: query.endDate,
    ...summary,
    note: "Computed from posted movements on the mapped VAT/WHT control accounts (accrual basis).",
  };
}

// ── Journal reversals ───────────────────────────────────────────────────────

export async function listJournalReversals(db: Db, query: ReportPeriodQuery) {
  const data = await repo.findJournalReversals(db, {
    startDate: query.startDate,
    endDate: query.endDate,
    entityId: query.entityId,
  });
  return data;
}

// ── Search ──────────────────────────────────────────────────────────────────

export async function searchAccounting(
  db: Db,
  actorId: string,
  permissions: string[],
  query: AccountingSearchQuery,
) {
  const term = query.q.trim();
  const entityId = query.entityId || undefined;
  const limit = query.limit;
  const readAll =
    permissions.includes(PERMISSIONS.ACCOUNTING_READ_ALL) ||
    permissions.includes(PERMISSIONS.ACCOUNTING_ADMIN);
  const createdBy = readAll ? undefined : actorId;
  const empty = {
    q: term,
    results: {
      invoices: [] as Array<Record<string, unknown>>,
      journals: [] as Array<Record<string, unknown>>,
      accounts: [] as Array<Record<string, unknown>>,
      bank: [] as Array<Record<string, unknown>>,
      payments: [] as Array<Record<string, unknown>>,
    },
    total: 0,
  };
  if (term.length < 2) return empty;

  const cleaned = term.replace(/[,\s]/g, "");
  const amount =
    /^\d+(\.\d+)?$/.test(cleaned) && !/^0\d/.test(cleaned)
      ? Number(cleaned)
      : undefined;

  const [invoices, journals, accounts, bank, payments] = await Promise.all([
    repo.searchInvoices(db, term, { entityId, createdBy, amount }, limit),
    repo.searchJournals(db, term, { entityId }, limit),
    repo.searchAccounts(db, term, { entityId }, limit),
    repo.searchBankTransactions(db, term, { entityId, amount }, limit),
    repo.searchPayments(db, term, { entityId, createdBy, amount }, limit),
  ]);

  const results = {
    invoices: invoices.map((i) => ({
      id: i.id,
      invoiceNo: i.invoiceNo,
      type: i.type,
      counterparty: i.counterparty,
      amount: Number(i.amount),
      currency: i.currency,
      status: i.status,
      date: String(i.issueDate).slice(0, 10),
    })),
    journals: journals.map((j) => ({
      id: j.id,
      reference: j.reference,
      description: j.description,
      date: String(j.date).slice(0, 10),
      status: j.status,
    })),
    accounts: accounts.map((a) => ({
      id: a.id,
      code: a.code,
      name: a.name,
      type: a.type,
    })),
    bank: bank.map((b) => ({
      id: b.id,
      description: b.description,
      amount: Number(b.amount),
      date: String(b.date).slice(0, 10),
      status: b.status,
      entityName: b.entityName ?? null,
    })),
    payments: payments.map((p) => ({
      id: p.id,
      invoiceId: p.invoiceId,
      invoiceNo: p.invoiceNo,
      counterparty: p.counterparty,
      amount: Number(p.amount),
      method: p.method,
      date: String(p.date).slice(0, 10),
    })),
  };
  const total =
    results.invoices.length +
    results.journals.length +
    results.accounts.length +
    results.bank.length +
    results.payments.length;
  return { q: term, results, total };
}

// ── Quote conversion ──────────────────────────────────────────────────────────

export async function convertQuote(
  db: Db,
  id: string,
  actorId: string,
  permissions: string[],
) {
  // Ownership check (own-doc vs read-all) lives in getQuoteById.
  const quote = await getQuoteById(db, id, actorId, permissions);
  if (!["sent", "accepted"].includes(quote.status)) {
    throw new BadRequestException("Only a sent or accepted quote can be converted.");
  }
  if (quote.convertedInvoiceId) {
    throw new BadRequestException("Quote has already been converted.");
  }

  const vendor = await repo.findQuoteVendor(db, quote.vendorId);
  if (!vendor) {
    throw new BadRequestException("Attach a customer to the quote before converting it.");
  }

  const subtotal = quote.subtotal;
  const grandTotal = quote.grandTotal;
  const blendedVat = subtotal > 0 ? round2((quote.taxTotal / subtotal) * 100) : 0;
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();

  const invoiceId = await db.transaction(async (tx) => {
    const invoiceNo = await allocateDocumentNumber(tx, quote.entityId, "invoice", today);
    const invId = createCuid();
    await tx.insert(schema.invoices).values({
      id: invId,
      entityId: quote.entityId,
      invoiceNo,
      type: "receivable",
      counterparty: vendor.name,
      vendorId: quote.vendorId,
      amount: String(grandTotal),
      currency: quote.currency,
      vatRate: String(blendedVat),
      taxRate: "0",
      whtRate: "0",
      issueDate: today,
      dueDate: today,
      status: "draft",
      notes: quote.notes,
      createdBy: quote.createdBy,
      createdAt: now,
    });

    if (quote.lines.length > 0) {
      await tx.insert(schema.invoiceLineItems).values(
        quote.lines.map((l, i) => ({
          id: createCuid(),
          invoiceId: invId,
          description: l.description,
          quantity: String(l.quantity),
          unitPrice: String(l.unitPrice),
          sortOrder: i,
          createdAt: now,
        })),
      );
    }

    await tx
      .update(schema.quotes)
      .set({ status: "converted", convertedInvoiceId: invId, updatedAt: now })
      .where(eq(schema.quotes.id, id));

    return invId;
  });

  return { quote: await getQuoteById(db, id, actorId, permissions), invoiceId };
}

// ── Bank accounts (read) ────────────────────────────────────────────────────

export async function listBankAccounts(db: Db, query: BankAccountQuery) {
  const data = await repo.findBankAccounts(db, {
    entityId: query.entityId,
    includeInactive: query.includeInactive,
  });
  return { data };
}

export async function getBankAccountById(db: Db, id: string) {
  const row = await repo.findBankAccountById(db, id);
  if (!row) throw new NotFoundException("Bank account not found");
  return row;
}

// ── Credit notes (read) ─────────────────────────────────────────────────────

export async function listCreditNotes(db: Db, query: CreditNoteQuery) {
  const data = await repo.findCreditNotes(db, {
    entityId: query.entityId,
    type: query.type,
    noteKind: query.noteKind,
    status: query.status,
  });
  return { data };
}

export async function getCreditNoteById(db: Db, id: string) {
  const row = await repo.findCreditNoteById(db, id);
  if (!row) throw new NotFoundException("Credit note not found");
  return row;
}

// ── Purchase orders (read) ──────────────────────────────────────────────────

export async function listPurchaseOrders(db: Db, query: PurchaseOrderQuery) {
  const data = await repo.findPurchaseOrders(db, {
    entityId: query.entityId,
    status: query.status,
  });
  return { data };
}

export async function getPurchaseOrderById(db: Db, id: string) {
  const row = await repo.findPurchaseOrderById(db, id);
  if (!row) throw new NotFoundException("Purchase order not found");
  return row;
}

// ── Fixed asset categories (read) ───────────────────────────────────────────

export async function listFixedAssetCategories(
  db: Db,
  query: FixedAssetCategoryQuery,
  env?: { ACCOUNTING_FIXED_ASSETS?: string },
) {
  const { isFixedAssetsEnabled } = await import("./accounting.flags");
  if (!isFixedAssetsEnabled(env)) {
    throw new NotFoundException("Fixed assets module is not enabled");
  }
  if (!query.entityId) {
    throw new BadRequestException("entityId is required");
  }
  const data = await repo.findFixedAssetCategories(
    db,
    query.entityId,
    query.includeInactive ?? false,
  );
  return { data };
}

export async function getFixedAssetCategoryById(
  db: Db,
  id: string,
  env?: { ACCOUNTING_FIXED_ASSETS?: string },
) {
  const { isFixedAssetsEnabled } = await import("./accounting.flags");
  if (!isFixedAssetsEnabled(env)) {
    throw new NotFoundException("Fixed assets module is not enabled");
  }
  const row = await repo.findFixedAssetCategoryById(db, id);
  if (!row) throw new NotFoundException("Fixed asset category not found");
  return row;
}
