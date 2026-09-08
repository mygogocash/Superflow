/**
 * Accounting module — edge/core port (phase 1: COA, journals, invoices/bills, quotes, fiscal periods, FA read).
 */

import { eq } from "drizzle-orm";
import type { Db } from "@nexora/db";
import { schema } from "@nexora/db";
import { PERMISSIONS } from "@nexora/contracts";
import type {
  AccountQuery,
  ClosePeriodInput,
  CreateAccountInput,
  CreateInvoiceInput,
  CreateJournalInput,
  CreateQuoteInput,
  FiscalPeriodQuery,
  FixedAssetQuery,
  InvoiceQuery,
  JournalQuery,
  MakerCheckerConfigInput,
  QuoteQuery,
  ReopenPeriodInput,
  RejectJournalInput,
  UpdateAccountInput,
  UpdateInvoiceInput,
  UpdateInvoiceStatusInput,
  UpdateJournalInput,
  UpdateQuoteInput,
} from "@nexora/contracts/modules/accounting/accounting.validation";
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "../http-exception";
import { assertPostingPeriodOpen } from "./accounting.locks";
import { decorateJournalTotals } from "./accounting-shared";
import { isFixedAssetsEnabled } from "./accounting.flags";
import {
  collectCoaFieldErrors,
  duplicateCodeError,
  duplicateEnglishNameError,
  normalizeEnglishName,
  sanitizeCoaText,
} from "./coa-validation";
import { computeDocLines } from "./doc-lines";
import { computeDepreciation } from "./fixed-asset-depreciation";
import { Decimal } from "./money-decimal";
import { toDepreciationInput } from "./fixed-asset-state";
import { computeInvoiceCalc } from "./invoice-calc";
import { allocateDocumentNumber, allocateDraftNumber } from "./numbering.service";
import * as repo from "./accounting.repository";
import { createCuid } from "../lib/id";

function canReadAllAccounting(permissions: string[]): boolean {
  return (
    permissions.includes(PERMISSIONS.ACCOUNTING_READ_ALL) ||
    permissions.includes(PERMISSIONS.ACCOUNTING_ADMIN)
  );
}

function assertDocumentAccess(
  document: { createdBy: string | null },
  actorId: string,
  permissions: string[],
  label: string,
) {
  if (canReadAllAccounting(permissions)) return;
  if (document.createdBy !== actorId) {
    throw new ForbiddenException(`You can only access your own ${label}`);
  }
}

function assertInvoiceAccess(
  invoice: { createdBy: string | null },
  actorId: string,
  permissions: string[],
) {
  assertDocumentAccess(invoice, actorId, permissions, "invoices/bills");
}

function assertJournalAccess(
  journal: { createdBy: string | null },
  actorId: string,
  permissions: string[],
) {
  assertDocumentAccess(journal, actorId, permissions, "journal entries");
}

function lineItemsToCalcInput(
  lineItems: CreateInvoiceInput["lineItems"],
  vatRate: number,
) {
  return lineItems.map((li) => ({
    quantity: li.quantity,
    unitPrice: li.unitPrice,
    lineDiscount: li.lineDiscount,
    vatRate: li.vatRate ?? vatRate,
    vatReason: li.vatReason,
    capitalised: li.capitalised,
  }));
}

function buildInvoiceLineRows(
  invoiceId: string,
  calc: ReturnType<typeof computeInvoiceCalc>,
  input: CreateInvoiceInput | UpdateInvoiceInput,
) {
  const vatRate = "vatRate" in input && input.vatRate != null ? input.vatRate : 0;
  const rawItems =
    "lineItems" in input && input.lineItems ? input.lineItems : [];
  return rawItems.map((li, i) => {
    const computed = calc.doc.lines[i];
    return {
      id: createCuid(),
      description: li.description,
      quantity: String(li.quantity),
      unitPrice: String(li.unitPrice),
      lineDiscount: String(li.lineDiscount ?? 0),
      lineVatRate: String(li.vatRate ?? vatRate),
      vatReason: li.vatReason ?? null,
      taxBase: computed ? String(computed.taxBase) : null,
      vatAmount: computed ? String(computed.vatAmount) : null,
      capitalised: li.capitalised === true,
      glAccountId: li.glAccountId ?? null,
      sortOrder: i,
    };
  });
}

// ── Maker-checker ─────────────────────────────────────────────────────────

export async function getMakerCheckerConfig(db: Db) {
  return repo.getMakerCheckerConfig(db);
}

export async function setMakerCheckerConfig(db: Db, input: MakerCheckerConfigInput) {
  return repo.setMakerCheckerConfig(db, input);
}

// ── Chart of accounts ───────────────────────────────────────────────────────

export async function listAccounts(db: Db, query: AccountQuery) {
  const data = await repo.findAccounts(db, query);
  return { data };
}

export async function getAccountById(db: Db, id: string) {
  const account = await repo.findAccountById(db, id);
  if (!account) throw new NotFoundException("Account not found");
  return account;
}

export async function createAccount(db: Db, input: CreateAccountInput) {
  const errors = collectCoaFieldErrors(input, { requireAll: true, validateEnglish: true });
  if (errors.length) throw new BadRequestException("Validation failed", errors);

  const code = sanitizeCoaText(input.code);
  const name = sanitizeCoaText(input.name);
  const nameNormalized = normalizeEnglishName(name);

  const dupCode = await repo.findActiveAccountByEntityAndCode(db, input.entityId, code);
  if (dupCode) throw new BadRequestException("Validation failed", [duplicateCodeError(code, dupCode.name)]);

  const dupName = await repo.findActiveAccountByEntityAndNameNormalized(
    db,
    input.entityId,
    nameNormalized,
  );
  if (dupName) {
    throw new BadRequestException("Validation failed", [
      duplicateEnglishNameError(dupName.code, dupName.name),
    ]);
  }

  const id = createCuid();
  return repo.createAccount(db, {
    id,
    entityId: input.entityId,
    code,
    name,
    nameTh: sanitizeCoaText(input.nameTh),
    description: sanitizeCoaText(input.description),
    descriptionTh: sanitizeCoaText(input.descriptionTh),
    type: input.type,
    parentId: input.parentId ?? null,
    nameNormalized,
  });
}

export async function updateAccount(db: Db, id: string, input: UpdateAccountInput) {
  const existing = await repo.findAccountById(db, id);
  if (!existing) throw new NotFoundException("Account not found");

  const errors = collectCoaFieldErrors(input, { requireAll: false, validateEnglish: true });
  if (errors.length) throw new BadRequestException("Validation failed", errors);

  const patch: Record<string, unknown> = {};
  if (input.code != null) patch.code = sanitizeCoaText(input.code);
  if (input.name != null) {
    patch.name = sanitizeCoaText(input.name);
    patch.nameNormalized = normalizeEnglishName(patch.name as string);
  }
  if (input.nameTh != null) patch.nameTh = sanitizeCoaText(input.nameTh);
  if (input.description != null) patch.description = sanitizeCoaText(input.description);
  if (input.descriptionTh != null) patch.descriptionTh = sanitizeCoaText(input.descriptionTh);
  if (input.type != null) patch.type = input.type;
  if (input.parentId !== undefined) patch.parentId = input.parentId ?? null;
  if (input.isActive != null) {
    patch.isActive = input.isActive;
    patch.deactivatedAt = input.isActive ? null : new Date().toISOString();
  }

  if (patch.code && patch.code !== existing.code) {
    const dup = await repo.findActiveAccountByEntityAndCode(db, existing.entityId, patch.code as string);
    if (dup && dup.id !== id) {
      throw new BadRequestException("Validation failed", [
        duplicateCodeError(patch.code as string, dup.name),
      ]);
    }
  }
  if (patch.nameNormalized && patch.nameNormalized !== existing.nameNormalized) {
    const dup = await repo.findActiveAccountByEntityAndNameNormalized(
      db,
      existing.entityId,
      patch.nameNormalized as string,
    );
    if (dup && dup.id !== id) {
      throw new BadRequestException("Validation failed", [
        duplicateEnglishNameError(dup.code, dup.name),
      ]);
    }
  }

  return repo.updateAccount(db, id, patch);
}

export async function deleteAccount(db: Db, id: string) {
  const existing = await repo.findAccountById(db, id);
  if (!existing) throw new NotFoundException("Account not found");
  await repo.softDeleteAccount(db, id);
  return { success: true };
}

// ── Journals ────────────────────────────────────────────────────────────────

export async function listJournals(db: Db, query: JournalQuery) {
  const { page, limit, ...filters } = query;
  const { data, total } = await repo.findJournals(db, filters, page, limit);
  return {
    data: data.map((j) => decorateJournalTotals(j)),
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getJournalById(db: Db, id: string) {
  const journal = await repo.findJournalById(db, id);
  if (!journal) throw new NotFoundException("Journal entry not found");
  return decorateJournalTotals(journal);
}

export async function createJournal(db: Db, actorId: string, input: CreateJournalInput) {
  const id = createCuid();
  const now = new Date().toISOString();

  return db.transaction(async (tx) => {
    await assertPostingPeriodOpen(tx, input.entityId, input.date);
    const draftNo = await allocateDraftNumber(tx, input.entityId, "je");
    const lines = input.lines.map((l) => ({
      accountId: l.accountId,
      debit: String(l.debit),
      credit: String(l.credit),
      memo: l.memo ?? null,
    }));

    await tx.insert(schema.journalEntries).values({
      id,
      entityId: input.entityId,
      entryNo: draftNo,
      draftNo,
      date: input.date,
      description: input.description ?? null,
      reference: input.reference ?? null,
      status: "draft",
      createdBy: actorId,
      createdAt: now,
      updatedAt: now,
    });
    await repo.insertJournalLines(tx, id, lines);
    const created = await repo.findJournalById(tx, id);
    return decorateJournalTotals(created!);
  });
}

export async function updateJournal(db: Db, id: string, input: UpdateJournalInput) {
  const existing = await repo.findJournalById(db, id);
  if (!existing) throw new NotFoundException("Journal entry not found");
  if (existing.status !== "draft" && existing.status !== "rejected") {
    throw new BadRequestException(`Cannot edit journal with status "${existing.status}"`);
  }

  const now = new Date().toISOString();
  return db.transaction(async (tx) => {
    const date = input.date ?? existing.date;
    await assertPostingPeriodOpen(tx, existing.entityId, date);

    const patch: Record<string, unknown> = { updatedAt: now };
    if (input.date) patch.date = input.date;
    if (input.description !== undefined) patch.description = input.description;
    if (input.reference !== undefined) patch.reference = input.reference;
    if (existing.status === "rejected") {
      patch.status = "draft";
      patch.rejectedBy = null;
      patch.rejectedAt = null;
      patch.rejectReason = null;
    }

    await tx.update(schema.journalEntries).set(patch).where(eq(schema.journalEntries.id, id));

    if (input.lines) {
      const lines = input.lines.map((l) => ({
        accountId: l.accountId,
        debit: String(l.debit),
        credit: String(l.credit),
        memo: l.memo ?? null,
      }));
      await repo.replaceJournalLines(tx, id, lines);
    }

    const updated = await repo.findJournalById(tx, id);
    return decorateJournalTotals(updated!);
  });
}

export async function deleteJournal(db: Db, id: string, actorId: string) {
  const existing = await repo.findJournalById(db, id);
  if (!existing) throw new NotFoundException("Journal entry not found");
  if (existing.status !== "draft" && existing.status !== "rejected") {
    throw new BadRequestException(`Cannot delete journal with status "${existing.status}"`);
  }
  await db.transaction(async (tx) => {
    await repo.softDeleteJournal(tx, id, actorId);
  });
  return { success: true };
}

export async function restoreJournal(
  db: Db,
  id: string,
  actorId: string,
  permissions: string[],
) {
  const existing = await repo.findJournalById(db, id, { includeDeleted: true });
  if (!existing) throw new NotFoundException("Journal entry not found");
  assertJournalAccess(existing, actorId, permissions);
  const restored = await db.transaction(async (tx) => repo.restoreJournal(tx, id));
  if (!restored) throw new NotFoundException("Journal entry not found");
  return decorateJournalTotals(restored);
}

export async function approveJournal(db: Db, journalId: string, approverId: string) {
  const journal = await repo.findJournalById(db, journalId);
  if (!journal) throw new NotFoundException("Journal entry not found");
  if (journal.status !== "draft") {
    throw new BadRequestException(`Cannot approve a journal with status "${journal.status}"`);
  }

  const { blockSelfApproval } = await repo.getMakerCheckerConfig(db);
  if (blockSelfApproval && journal.createdBy === approverId) {
    throw new ForbiddenException(
      "Maker-checker is enabled: you cannot approve a journal you created. " +
        "Another approver must review it.",
    );
  }

  const approved = await db.transaction(async (tx) =>
    repo.approveJournalInTx(tx, journalId, approverId),
  );
  return decorateJournalTotals(approved!);
}

export async function rejectJournal(
  db: Db,
  journalId: string,
  reviewerId: string,
  input: RejectJournalInput,
) {
  const journal = await repo.findJournalById(db, journalId);
  if (!journal) throw new NotFoundException("Journal entry not found");
  if (journal.status !== "draft") {
    throw new BadRequestException(`Cannot reject a journal with status "${journal.status}"`);
  }

  const rejected = await db.transaction(async (tx) =>
    repo.rejectJournalInTx(tx, journalId, reviewerId, input.reason),
  );
  return decorateJournalTotals(rejected!);
}

// ── Invoices / bills ────────────────────────────────────────────────────────

export async function listInvoices(
  db: Db,
  actorId: string,
  permissions: string[],
  query: InvoiceQuery,
) {
  const { page, limit, type, ...rest } = query;
  const filters: Parameters<typeof repo.findInvoices>[1] = { ...rest, type };
  if (!canReadAllAccounting(permissions)) {
    filters.createdBy = actorId;
  }
  const { data, total } = await repo.findInvoices(db, filters, page, limit);
  return {
    data,
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getInvoiceById(
  db: Db,
  id: string,
  actorId: string,
  permissions: string[],
) {
  const invoice = await repo.findInvoiceById(db, id);
  if (!invoice) throw new NotFoundException("Invoice not found");
  assertInvoiceAccess(invoice, actorId, permissions);
  return invoice;
}

export async function createInvoice(
  db: Db,
  actorId: string,
  permissions: string[],
  input: CreateInvoiceInput,
) {
  const calc = computeInvoiceCalc({
    lineItems: lineItemsToCalcInput(input.lineItems, input.vatRate),
    vatRate: input.vatRate,
    taxRate: input.taxRate,
    whtRate: input.whtRate,
    headerDiscount: input.headerDiscount,
    userTotal: input.userTotal,
  });

  const id = createCuid();
  const now = new Date().toISOString();

  return db.transaction(async (tx) => {
    const invoiceNo =
      input.invoiceNo?.trim() ||
      (await allocateDraftNumber(tx, input.entityId, "invoice"));

    await tx.insert(schema.invoices).values({
      id,
      entityId: input.entityId,
      invoiceNo,
      draftNo: input.invoiceNo ? null : invoiceNo,
      type: input.type,
      counterparty: input.counterparty,
      vendorId: input.vendorId ?? null,
      amount: String(calc.total),
      currency: input.currency,
      exchangeRate: input.exchangeRate != null ? String(input.exchangeRate) : "1",
      billToAddress: input.billToAddress ?? null,
      reference: input.reference ?? null,
      paymentTerms: input.paymentTerms ?? null,
      vatRate: String(input.vatRate),
      taxLabel: input.taxLabel ?? null,
      taxRate: String(input.taxRate),
      whtRate: String(input.whtRate),
      issueDate: input.issueDate,
      dueDate: input.dueDate,
      status: "draft",
      headerDiscount: String(input.headerDiscount ?? 0),
      roundingAmount: String(calc.doc.rounding),
      vendorTaxInvoiceNo: input.vendorTaxInvoiceNo ?? null,
      taxInvoiceReceived: input.taxInvoiceReceived ?? false,
      linkedJeId: input.linkedJeId ?? null,
      notes: input.notes ?? null,
      createdBy: actorId,
      createdAt: now,
    });

    const lineRows = buildInvoiceLineRows(id, calc, input);
    await repo.insertInvoiceLineItems(tx, id, lineRows);

    const created = await repo.findInvoiceById(tx, id);
    return created!;
  });
}

export async function updateInvoice(
  db: Db,
  id: string,
  actorId: string,
  permissions: string[],
  input: UpdateInvoiceInput,
) {
  const existing = await repo.findInvoiceById(db, id);
  if (!existing) throw new NotFoundException("Invoice not found");
  assertInvoiceAccess(existing, actorId, permissions);
  if (existing.status !== "draft") {
    throw new BadRequestException(`Cannot edit invoice with status "${existing.status}"`);
  }

  const vatRate = input.vatRate ?? existing.vatRate;
  const taxRate = input.taxRate ?? existing.taxRate;
  const whtRate = input.whtRate ?? existing.whtRate;
  const lineItems =
    input.lineItems ??
    existing.lineItems.map((li) => ({
      description: li.description,
      quantity: li.quantity,
      unitPrice: li.unitPrice,
      lineDiscount: li.lineDiscount,
      vatRate: li.lineVatRate ?? vatRate,
      vatReason: li.vatReason ?? undefined,
      capitalised: li.capitalised,
      glAccountId: li.glAccountId ?? undefined,
    }));

  const calc = computeInvoiceCalc({
    lineItems: lineItemsToCalcInput(lineItems as CreateInvoiceInput["lineItems"], vatRate),
    vatRate,
    taxRate,
    whtRate,
    headerDiscount: input.headerDiscount ?? existing.headerDiscount,
    userTotal: input.userTotal,
  });

  return db.transaction(async (tx) => {
    const patch: Record<string, unknown> = {};
    if (input.counterparty) patch.counterparty = input.counterparty;
    if (input.currency) patch.currency = input.currency;
    if (input.issueDate) patch.issueDate = input.issueDate;
    if (input.dueDate) patch.dueDate = input.dueDate;
    if (input.notes !== undefined) patch.notes = input.notes;
    patch.amount = String(calc.total);
    patch.roundingAmount = String(calc.doc.rounding);
    if (input.vatRate != null) patch.vatRate = String(input.vatRate);
    if (input.taxRate != null) patch.taxRate = String(input.taxRate);
    if (input.whtRate != null) patch.whtRate = String(input.whtRate);

    await tx.update(schema.invoices).set(patch).where(eq(schema.invoices.id, id));

    if (input.lineItems) {
      const lineRows = buildInvoiceLineRows(id, calc, { ...input, lineItems, vatRate, taxRate, whtRate });
      await repo.replaceInvoiceLineItems(tx, id, lineRows);
    }

    const updated = await repo.findInvoiceById(tx, id);
    return updated!;
  });
}

export async function deleteInvoice(
  db: Db,
  id: string,
  actorId: string,
  permissions: string[],
) {
  const existing = await repo.findInvoiceById(db, id);
  if (!existing) throw new NotFoundException("Invoice not found");
  assertInvoiceAccess(existing, actorId, permissions);
  await db.transaction(async (tx) => repo.softDeleteInvoice(tx, id, actorId));
  return { success: true };
}

export async function restoreInvoice(
  db: Db,
  id: string,
  actorId: string,
  permissions: string[],
) {
  const existing = await repo.findInvoiceById(db, id, { includeDeleted: true });
  if (!existing) throw new NotFoundException("Invoice not found");
  assertInvoiceAccess(existing, actorId, permissions);
  return db.transaction(async (tx) => repo.restoreInvoice(tx, id));
}

export async function updateInvoiceStatus(
  db: Db,
  id: string,
  actorId: string,
  permissions: string[],
  input: UpdateInvoiceStatusInput,
) {
  const invoice = await repo.findInvoiceById(db, id);
  if (!invoice) throw new NotFoundException("Invoice not found");
  assertInvoiceAccess(invoice, actorId, permissions);

  const { status } = input;
  if (status === "pending_second_approval") {
    throw new BadRequestException("Second approval is not available on edge yet");
  }

  return db.transaction(async (tx) => {
    await tx
      .update(schema.invoices)
      .set({ status })
      .where(eq(schema.invoices.id, id));
    const updated = await repo.findInvoiceById(tx, id);
    return updated!;
  });
}

// ── Quotes ──────────────────────────────────────────────────────────────────

export async function listQuotes(db: Db, query: QuoteQuery) {
  const data = await repo.findQuotes(db, query);
  return { data };
}

export async function getQuoteById(db: Db, id: string) {
  const quote = await repo.findQuoteById(db, id);
  if (!quote) throw new NotFoundException("Quote not found");
  return quote;
}

export async function createQuote(db: Db, actorId: string, input: CreateQuoteInput) {
  const { lines, subtotal, taxTotal, grandTotal } = computeDocLines(input.lines);
  const id = createCuid();
  const now = new Date().toISOString();

  return db.transaction(async (tx) => {
    const quoteNo = await allocateDocumentNumber(tx, input.entityId, "quote", input.issueDate);
    await tx.insert(schema.quotes).values({
      id,
      entityId: input.entityId,
      quoteNo,
      vendorId: input.vendorId ?? null,
      issueDate: input.issueDate,
      expiryDate: input.expiryDate ?? null,
      status: "draft",
      currency: input.currency,
      subtotal: String(subtotal),
      taxTotal: String(taxTotal),
      grandTotal: String(grandTotal),
      notes: input.notes ?? null,
      createdBy: actorId,
      createdAt: now,
      updatedAt: now,
    });
    await repo.insertQuoteLines(
      tx,
      id,
      lines.map((l) => ({
        id: createCuid(),
        description: l.description,
        quantity: String(l.quantity),
        unitPrice: String(l.unitPrice),
        lineTotal: String(l.lineTotal),
        taxRate: String(l.taxRate),
        taxAmount: String(l.taxAmount),
        glAccountId: l.glAccountId,
        sortOrder: l.sortOrder,
      })),
    );
    return (await repo.findQuoteById(tx, id))!;
  });
}

export async function updateQuote(db: Db, id: string, input: UpdateQuoteInput) {
  const existing = await repo.findQuoteById(db, id);
  if (!existing) throw new NotFoundException("Quote not found");
  if (existing.status !== "draft") {
    throw new BadRequestException(`Cannot edit quote with status "${existing.status}"`);
  }

  const computed = input.lines ? computeDocLines(input.lines) : null;
  const now = new Date().toISOString();

  return db.transaction(async (tx) => {
    const patch: Record<string, unknown> = { updatedAt: now };
    if (input.vendorId !== undefined) patch.vendorId = input.vendorId;
    if (input.issueDate) patch.issueDate = input.issueDate;
    if (input.expiryDate !== undefined) patch.expiryDate = input.expiryDate;
    if (input.currency) patch.currency = input.currency;
    if (input.notes !== undefined) patch.notes = input.notes;
    if (computed) {
      patch.subtotal = String(computed.subtotal);
      patch.taxTotal = String(computed.taxTotal);
      patch.grandTotal = String(computed.grandTotal);
    }
    await tx.update(schema.quotes).set(patch).where(eq(schema.quotes.id, id));

    if (input.lines && computed) {
      await repo.replaceQuoteLines(
        tx,
        id,
        computed.lines.map((l) => ({
          id: createCuid(),
          description: l.description,
          quantity: String(l.quantity),
          unitPrice: String(l.unitPrice),
          lineTotal: String(l.lineTotal),
          taxRate: String(l.taxRate),
          taxAmount: String(l.taxAmount),
          glAccountId: l.glAccountId,
          sortOrder: l.sortOrder,
        })),
      );
    }

    return (await repo.findQuoteById(tx, id))!;
  });
}

export async function deleteQuote(db: Db, id: string) {
  const existing = await repo.findQuoteById(db, id);
  if (!existing) throw new NotFoundException("Quote not found");
  if (existing.status !== "draft") {
    throw new BadRequestException(`Cannot delete quote with status "${existing.status}"`);
  }
  await db.transaction(async (tx) => repo.softDeleteQuote(tx, id));
  return { success: true };
}

export async function sendQuote(db: Db, id: string) {
  const existing = await repo.findQuoteById(db, id);
  if (!existing) throw new NotFoundException("Quote not found");
  if (existing.status !== "draft") {
    throw new BadRequestException(`Cannot send quote with status "${existing.status}"`);
  }
  const now = new Date().toISOString();
  await db
    .update(schema.quotes)
    .set({ status: "sent", updatedAt: now })
    .where(eq(schema.quotes.id, id));
  return getQuoteById(db, id);
}

// ── Fiscal periods ──────────────────────────────────────────────────────────

export async function listFiscalPeriods(db: Db, query: FiscalPeriodQuery) {
  const data = await repo.findFiscalPeriods(db, query.entityId);
  return { data };
}

export async function closePeriod(db: Db, userId: string, input: ClosePeriodInput) {
  const row = await repo.upsertFiscalPeriod(db, {
    entityId: input.entityId,
    year: input.year,
    month: input.month,
    status: "closed",
    closedBy: userId,
    note: input.note ?? null,
  });
  return row;
}

export async function reopenPeriod(db: Db, userId: string, input: ReopenPeriodInput) {
  const row = await repo.upsertFiscalPeriod(db, {
    entityId: input.entityId,
    year: input.year,
    month: input.month,
    status: "open",
    closedBy: userId,
  });
  return row;
}

// ── Fixed assets (read-only, flag-gated) ────────────────────────────────────

function enrichFixedAsset(asset: typeof schema.fixedAssets.$inferSelect, asOf?: string) {
  const asOfDate = asOf ? new Date(`${asOf}T00:00:00.000Z`) : new Date();
  const dep = computeDepreciation(
    toDepreciationInput({
      purchasePrice: new Decimal(asset.purchasePrice),
      quantity: asset.quantity,
      startDate: new Date(asset.startDate),
      usefulLifeMonths: asset.usefulLifeMonths,
      openingBookValue:
        asset.openingBookValue == null ? null : new Decimal(asset.openingBookValue),
      openingAsOfDate: asset.openingAsOfDate ? new Date(asset.openingAsOfDate) : null,
    }),
    asOfDate,
  );
  return {
    ...asset,
    purchasePrice: Number(asset.purchasePrice),
    openingBookValue:
      asset.openingBookValue == null ? null : Number(asset.openingBookValue),
    netBookValue: dep.netBookValue.toFixed(2),
    accumulatedDepreciation: dep.accumulatedDepreciation.toFixed(2),
    dailyRate: dep.dailyRate.toFixed(4),
    totalDays: dep.totalDays,
  };
}

type FixedAssetsEnv = { ACCOUNTING_FIXED_ASSETS?: string };

export async function listFixedAssets(
  db: Db,
  query: FixedAssetQuery,
  env?: FixedAssetsEnv,
) {
  if (!isFixedAssetsEnabled(env)) {
    throw new NotFoundException("Fixed assets module is not enabled");
  }
  const { page, limit, asOf, ...filters } = query;
  const { data, total } = await repo.findFixedAssets(db, filters, page, limit);
  return {
    data: data.map((a) => enrichFixedAsset(a, asOf)),
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

export async function getFixedAssetById(
  db: Db,
  id: string,
  asOf?: string,
  env?: FixedAssetsEnv,
) {
  if (!isFixedAssetsEnabled(env)) {
    throw new NotFoundException("Fixed assets module is not enabled");
  }
  const asset = await repo.findFixedAssetById(db, id);
  if (!asset) throw new NotFoundException("Fixed asset not found");
  return enrichFixedAsset(asset, asOf);
}
export * from "./accounting.service.ext";
