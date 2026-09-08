import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Db, DbTransaction } from "@nexora/db";
import { schema } from "@nexora/db";
import { alias } from "drizzle-orm/pg-core";
import { createCuid } from "../lib/id";
import {
  ACCOUNTING_JOURNAL_LINKED_TO,
} from "./attachments-rules";
import {
  assertBalanced,
  normalizeLines,
  type PostingLine,
} from "./accounting-shared";
import {
  assertAttachmentFileAllowed,
  assertHasAttachment,
} from "./attachments-rules";
import { allocateDocumentNumber } from "./numbering.service";
import { assertPostingPeriodOpen } from "./accounting.locks";
import { getSetting, upsertSetting } from "../survey/system-settings.repository";
import { NotFoundException } from "../http-exception";

export const MAKER_CHECKER_KEY = "accounting.maker_checker";

type DbLike = Db | DbTransaction;

const journalCreator = alias(schema.users, "journal_creator");
const journalApprover = alias(schema.users, "journal_approver");
const invoiceCreator = alias(schema.users, "invoice_creator");

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
  return v == null ? "0" : String(v);
}

export async function getMakerCheckerConfig(db: Db) {
  const value = await getSetting(db, MAKER_CHECKER_KEY);
  const blockSelfApproval =
    value != null &&
    typeof value === "object" &&
    (value as Record<string, unknown>).blockSelfApproval === true;
  return { blockSelfApproval };
}

export async function setMakerCheckerConfig(
  db: Db,
  input: { blockSelfApproval: boolean },
) {
  await upsertSetting(db, MAKER_CHECKER_KEY, input);
  return input;
}

// ── Chart of accounts ───────────────────────────────────────────────────────

export async function findAccounts(
  db: Db,
  filters: {
    entityId?: string;
    type?: string;
    isActive?: boolean;
    parentId?: string;
    sortBy?: string;
    sortOrder?: "asc" | "desc";
  },
) {
  const conditions: SQL[] = [isNull(schema.chartOfAccounts.deletedAt)];
  if (filters.entityId) conditions.push(eq(schema.chartOfAccounts.entityId, filters.entityId));
  if (filters.type) conditions.push(eq(schema.chartOfAccounts.type, filters.type));
  if (filters.isActive !== undefined) {
    conditions.push(eq(schema.chartOfAccounts.isActive, filters.isActive));
  }
  if (filters.parentId) conditions.push(eq(schema.chartOfAccounts.parentId, filters.parentId));

  const sortCol =
    filters.sortBy === "name"
      ? schema.chartOfAccounts.name
      : filters.sortBy === "type"
        ? schema.chartOfAccounts.type
        : filters.sortBy === "balance"
          ? schema.chartOfAccounts.balance
          : schema.chartOfAccounts.code;
  const order = filters.sortOrder === "desc" ? desc(sortCol) : asc(sortCol);

  const rows = await db
    .select()
    .from(schema.chartOfAccounts)
    .where(and(...conditions))
    .orderBy(order);

  return rows.map((r) => ({ ...r, balance: num(r.balance) }));
}

export async function findAccountById(db: Db, id: string) {
  const [row] = await db
    .select()
    .from(schema.chartOfAccounts)
    .where(and(eq(schema.chartOfAccounts.id, id), isNull(schema.chartOfAccounts.deletedAt)))
    .limit(1);
  if (!row) return null;
  return { ...row, balance: num(row.balance) };
}

export async function findActiveAccountByEntityAndCode(
  db: Db,
  entityId: string,
  code: string,
) {
  const [row] = await db
    .select()
    .from(schema.chartOfAccounts)
    .where(
      and(
        eq(schema.chartOfAccounts.entityId, entityId),
        eq(schema.chartOfAccounts.code, code),
        eq(schema.chartOfAccounts.isActive, true),
        isNull(schema.chartOfAccounts.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function findActiveAccountByEntityAndNameNormalized(
  db: Db,
  entityId: string,
  nameNormalized: string,
) {
  const [row] = await db
    .select()
    .from(schema.chartOfAccounts)
    .where(
      and(
        eq(schema.chartOfAccounts.entityId, entityId),
        eq(schema.chartOfAccounts.nameNormalized, nameNormalized),
        eq(schema.chartOfAccounts.isActive, true),
        isNull(schema.chartOfAccounts.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function createAccount(
  db: Db,
  data: {
    id: string;
    entityId: string;
    code: string;
    name: string;
    nameTh: string;
    description: string;
    descriptionTh: string;
    type: string;
    parentId?: string | null;
    nameNormalized: string;
  },
) {
  await db.insert(schema.chartOfAccounts).values({
    id: data.id,
    entityId: data.entityId,
    code: data.code,
    name: data.name,
    nameTh: data.nameTh,
    description: data.description,
    descriptionTh: data.descriptionTh,
    type: data.type,
    parentId: data.parentId ?? null,
    nameNormalized: data.nameNormalized,
    balance: "0",
    isActive: true,
  });
  return findAccountById(db, data.id);
}

export async function updateAccount(
  db: Db,
  id: string,
  patch: Record<string, unknown>,
) {
  await db
    .update(schema.chartOfAccounts)
    .set(patch as typeof schema.chartOfAccounts.$inferInsert)
    .where(eq(schema.chartOfAccounts.id, id));
  return findAccountById(db, id);
}

export async function softDeleteAccount(db: Db, id: string) {
  const now = new Date().toISOString();
  await db
    .update(schema.chartOfAccounts)
    .set({ deletedAt: now, isActive: false, deactivatedAt: now })
    .where(eq(schema.chartOfAccounts.id, id));
}

// ── Journal helpers ─────────────────────────────────────────────────────────

async function loadJournalLines(db: DbLike, entryId: string) {
  const lines = await db
    .select({
      line: schema.journalEntryLines,
      accountCode: schema.chartOfAccounts.code,
      accountName: schema.chartOfAccounts.name,
    })
    .from(schema.journalEntryLines)
    .innerJoin(
      schema.chartOfAccounts,
      eq(schema.journalEntryLines.accountId, schema.chartOfAccounts.id),
    )
    .where(eq(schema.journalEntryLines.entryId, entryId));

  return lines.map(({ line, accountCode, accountName }) => ({
    id: line.id,
    accountId: line.accountId,
    debit: str(line.debit),
    credit: str(line.credit),
    memo: line.memo,
    account: { id: line.accountId, code: accountCode, name: accountName },
  }));
}

async function mapJournalRow(
  db: DbLike,
  row: {
    entry: typeof schema.journalEntries.$inferSelect;
    creatorId: string;
    creatorName: string;
    creatorEmail: string;
    approverId: string | null;
    approverName: string | null;
    approverEmail: string | null;
  },
) {
  const lines = await loadJournalLines(db, row.entry.id);
  return {
    ...row.entry,
    lines,
    createdByUser: {
      id: row.creatorId,
      name: row.creatorName,
      email: row.creatorEmail,
    },
    approvedByUser: row.approverId
      ? {
          id: row.approverId,
          name: row.approverName ?? "",
          email: row.approverEmail ?? "",
        }
      : null,
  };
}

export async function findJournals(
  db: Db,
  filters: {
    entityId?: string;
    status?: string;
    startDate?: string;
    endDate?: string;
    descriptionLang?: "en" | "th";
    createdBy?: string;
  },
  page: number,
  limit: number,
) {
  const conditions: SQL[] = [];
  if (filters.status === "deleted") {
    conditions.push(isNotNull(schema.journalEntries.deletedAt));
  } else {
    conditions.push(isNull(schema.journalEntries.deletedAt));
    if (filters.status) {
      conditions.push(eq(schema.journalEntries.status, filters.status));
    }
  }
  if (filters.entityId) conditions.push(eq(schema.journalEntries.entityId, filters.entityId));
  if (filters.createdBy) conditions.push(eq(schema.journalEntries.createdBy, filters.createdBy));
  if (filters.startDate) conditions.push(gte(schema.journalEntries.date, filters.startDate));
  if (filters.endDate) conditions.push(lte(schema.journalEntries.date, filters.endDate));
  if (filters.descriptionLang === "en") {
    conditions.push(isNotNull(schema.journalEntries.description));
  } else if (filters.descriptionLang === "th") {
    conditions.push(isNotNull(schema.journalEntries.descriptionTh));
  }

  const where = conditions.length ? and(...conditions) : undefined;
  const offset = (page - 1) * limit;

  const [totalRow] = await db
    .select({ total: count() })
    .from(schema.journalEntries)
    .where(where);

  const rows = await db
    .select({
      entry: schema.journalEntries,
      creatorId: journalCreator.id,
      creatorName: journalCreator.name,
      creatorEmail: journalCreator.email,
      approverId: journalApprover.id,
      approverName: journalApprover.name,
      approverEmail: journalApprover.email,
    })
    .from(schema.journalEntries)
    .innerJoin(journalCreator, eq(schema.journalEntries.createdBy, journalCreator.id))
    .leftJoin(journalApprover, eq(schema.journalEntries.approvedBy, journalApprover.id))
    .where(where)
    .orderBy(desc(schema.journalEntries.date), desc(schema.journalEntries.createdAt))
    .limit(limit)
    .offset(offset);

  const data = await Promise.all(rows.map((r) => mapJournalRow(db, r)));
  const total = Number(totalRow?.total ?? 0);
  return { data, total };
}

export async function findJournalById(db: DbLike, id: string, opts?: { includeDeleted?: boolean }) {
  const conditions: SQL[] = [eq(schema.journalEntries.id, id)];
  if (!opts?.includeDeleted) conditions.push(isNull(schema.journalEntries.deletedAt));

  const [row] = await db
    .select({
      entry: schema.journalEntries,
      creatorId: journalCreator.id,
      creatorName: journalCreator.name,
      creatorEmail: journalCreator.email,
      approverId: journalApprover.id,
      approverName: journalApprover.name,
      approverEmail: journalApprover.email,
    })
    .from(schema.journalEntries)
    .innerJoin(journalCreator, eq(schema.journalEntries.createdBy, journalCreator.id))
    .leftJoin(journalApprover, eq(schema.journalEntries.approvedBy, journalApprover.id))
    .where(and(...conditions))
    .limit(1);

  if (!row) return null;
  return mapJournalRow(db, row);
}

export async function lockJournalRow(tx: DbTransaction, id: string) {
  await tx.execute(sql`SELECT id FROM journal_entries WHERE id = ${id} FOR UPDATE`);
}

export async function countJournalAttachments(db: DbLike, journalId: string) {
  const [row] = await db
    .select({ total: count() })
    .from(schema.fileUploads)
    .where(
      and(
        eq(schema.fileUploads.linkedTo, ACCOUNTING_JOURNAL_LINKED_TO),
        eq(schema.fileUploads.linkedId, journalId),
        isNull(schema.fileUploads.deletedAt),
      ),
    );
  return Number(row?.total ?? 0);
}

export async function insertJournalLines(
  tx: DbTransaction,
  entryId: string,
  lines: Array<{ accountId: string; debit: string; credit: string; memo?: string | null }>,
) {
  if (lines.length === 0) return;
  await tx.insert(schema.journalEntryLines).values(
    lines.map((l) => ({
      id: crypto.randomUUID(),
      entryId,
      accountId: l.accountId,
      debit: l.debit,
      credit: l.credit,
      memo: l.memo ?? null,
    })),
  );
}

export async function replaceJournalLines(
  tx: DbTransaction,
  entryId: string,
  lines: Array<{ accountId: string; debit: string; credit: string; memo?: string | null }>,
) {
  await tx.delete(schema.journalEntryLines).where(eq(schema.journalEntryLines.entryId, entryId));
  await insertJournalLines(tx, entryId, lines);
}

export async function incrementAccountBalances(
  tx: DbTransaction,
  lines: Array<{ accountId: string; debit: string; credit: string }>,
) {
  for (const line of lines) {
    const delta = num(line.debit) - num(line.credit);
    if (Math.abs(delta) < 0.0001) continue;
    await tx
      .update(schema.chartOfAccounts)
      .set({ balance: sql`${schema.chartOfAccounts.balance} + ${delta}` })
      .where(eq(schema.chartOfAccounts.id, line.accountId));
  }
}

export async function approveJournalInTx(
  tx: DbTransaction,
  id: string,
  approvedBy: string,
) {
  await lockJournalRow(tx, id);
  const journal = await findJournalById(tx, id);
  if (!journal) throw new NotFoundException("Journal entry not found");
  if (journal.status !== "draft") {
    throw new NotFoundException(`Cannot approve journal with status "${journal.status}"`);
  }
  await assertPostingPeriodOpen(tx, journal.entityId, journal.date);

  const attachments = await tx
    .select({ mimeType: schema.fileUploads.mimeType, size: schema.fileUploads.size })
    .from(schema.fileUploads)
    .where(
      and(
        eq(schema.fileUploads.linkedTo, ACCOUNTING_JOURNAL_LINKED_TO),
        eq(schema.fileUploads.linkedId, id),
        isNull(schema.fileUploads.deletedAt),
      ),
    );
  assertHasAttachment(attachments.length);
  for (const file of attachments) {
    assertAttachmentFileAllowed({ mimeType: file.mimeType, size: file.size });
  }

  const normalized = assertBalanced(
    normalizeLines(
      journal.lines.map((l) => ({
        accountId: l.accountId,
        debit: l.debit,
        credit: l.credit,
        memo: l.memo,
      })),
    ),
  );

  const entryNo = await allocateDocumentNumber(tx, journal.entityId, "je", journal.date);
  const now = new Date().toISOString();
  const dbLines = journal.lines.map((l) => ({
    accountId: l.accountId,
    debit: str(l.debit),
    credit: str(l.credit),
  }));
  await incrementAccountBalances(tx, dbLines);

  await tx
    .update(schema.journalEntries)
    .set({
      entryNo,
      status: "posted",
      approvedBy,
      approvedAt: now,
      postedAt: now,
      rejectedBy: null,
      rejectedAt: null,
      rejectReason: null,
      updatedAt: now,
    })
    .where(eq(schema.journalEntries.id, id));

  return findJournalById(tx, id);
}

export async function rejectJournalInTx(
  tx: DbTransaction,
  id: string,
  rejectedBy: string,
  rejectReason: string,
) {
  await lockJournalRow(tx, id);
  const [entry] = await tx
    .select({ status: schema.journalEntries.status })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.id, id))
    .limit(1);
  if (!entry) throw new NotFoundException("Journal entry not found");
  if (entry.status !== "draft") {
    throw new NotFoundException(`Cannot reject journal with status "${entry.status}"`);
  }
  const now = new Date().toISOString();
  await tx
    .update(schema.journalEntries)
    .set({
      status: "rejected",
      rejectedBy,
      rejectedAt: now,
      rejectReason,
      updatedAt: now,
    })
    .where(eq(schema.journalEntries.id, id));
  return findJournalById(tx, id);
}

export async function softDeleteJournal(
  tx: DbTransaction,
  id: string,
  deletedBy: string,
) {
  const now = new Date().toISOString();
  await tx
    .update(schema.journalEntries)
    .set({ deletedAt: now, deletedBy, updatedAt: now })
    .where(eq(schema.journalEntries.id, id));
}

export async function restoreJournal(tx: DbTransaction, id: string) {
  const now = new Date().toISOString();
  await tx
    .update(schema.journalEntries)
    .set({ deletedAt: null, deletedBy: null, updatedAt: now })
    .where(eq(schema.journalEntries.id, id));
  return findJournalById(tx, id, { includeDeleted: true });
}

// ── Invoices ────────────────────────────────────────────────────────────────

async function loadInvoiceLineItems(db: DbLike, invoiceId: string) {
  return db
    .select()
    .from(schema.invoiceLineItems)
    .where(eq(schema.invoiceLineItems.invoiceId, invoiceId))
    .orderBy(asc(schema.invoiceLineItems.sortOrder));
}

async function mapInvoiceRow(
  db: DbLike,
  row: {
    invoice: typeof schema.invoices.$inferSelect;
    creatorId: string | null;
    creatorName: string | null;
    creatorEmail: string | null;
  },
) {
  const lineItems = await loadInvoiceLineItems(db, row.invoice.id);
  return {
    ...row.invoice,
    amount: num(row.invoice.amount),
    amountPaid: num(row.invoice.amountPaid),
    vatRate: num(row.invoice.vatRate),
    taxRate: num(row.invoice.taxRate),
    whtRate: num(row.invoice.whtRate),
    headerDiscount: num(row.invoice.headerDiscount),
    roundingAmount: num(row.invoice.roundingAmount),
    lineItems: lineItems.map((li) => ({
      ...li,
      quantity: num(li.quantity),
      unitPrice: num(li.unitPrice),
      lineDiscount: num(li.lineDiscount),
      lineVatRate: li.lineVatRate == null ? null : num(li.lineVatRate),
      taxBase: li.taxBase == null ? null : num(li.taxBase),
      vatAmount: li.vatAmount == null ? null : num(li.vatAmount),
    })),
    createdByUser: row.creatorId
      ? { id: row.creatorId, name: row.creatorName ?? "", email: row.creatorEmail ?? "" }
      : null,
  };
}

export async function findInvoices(
  db: Db,
  filters: {
    entityId?: string;
    type?: string;
    status?: string;
    createdBy?: string;
  },
  page: number,
  limit: number,
) {
  const conditions: SQL[] = [isNull(schema.invoices.deletedAt)];
  if (filters.entityId) conditions.push(eq(schema.invoices.entityId, filters.entityId));
  if (filters.type) conditions.push(eq(schema.invoices.type, filters.type));
  if (filters.status === "deleted") {
    conditions.push(isNotNull(schema.invoices.deletedAt));
  } else if (filters.status) {
    conditions.push(eq(schema.invoices.status, filters.status));
  }
  if (filters.createdBy) conditions.push(eq(schema.invoices.createdBy, filters.createdBy));

  const where = and(...conditions);
  const offset = (page - 1) * limit;
  const [totalRow] = await db.select({ total: count() }).from(schema.invoices).where(where);

  const rows = await db
    .select({
      invoice: schema.invoices,
      creatorId: invoiceCreator.id,
      creatorName: invoiceCreator.name,
      creatorEmail: invoiceCreator.email,
    })
    .from(schema.invoices)
    .leftJoin(invoiceCreator, eq(schema.invoices.createdBy, invoiceCreator.id))
    .where(where)
    .orderBy(desc(schema.invoices.issueDate), desc(schema.invoices.createdAt))
    .limit(limit)
    .offset(offset);

  const data = await Promise.all(rows.map((r) => mapInvoiceRow(db, r)));
  return { data, total: Number(totalRow?.total ?? 0) };
}

export async function findInvoiceById(db: DbLike, id: string, opts?: { includeDeleted?: boolean }) {
  const conditions: SQL[] = [eq(schema.invoices.id, id)];
  if (!opts?.includeDeleted) conditions.push(isNull(schema.invoices.deletedAt));

  const [row] = await db
    .select({
      invoice: schema.invoices,
      creatorId: invoiceCreator.id,
      creatorName: invoiceCreator.name,
      creatorEmail: invoiceCreator.email,
    })
    .from(schema.invoices)
    .leftJoin(invoiceCreator, eq(schema.invoices.createdBy, invoiceCreator.id))
    .where(and(...conditions))
    .limit(1);

  if (!row) return null;
  return mapInvoiceRow(db, row);
}

export async function insertInvoiceLineItems(
  tx: DbTransaction,
  invoiceId: string,
  items: Array<{
    id: string;
    description: string;
    quantity: string;
    unitPrice: string;
    lineDiscount: string;
    lineVatRate: string | null;
    vatReason: string | null;
    taxBase: string | null;
    vatAmount: string | null;
    capitalised: boolean;
    glAccountId: string | null;
    sortOrder: number;
  }>,
) {
  if (items.length === 0) return;
  const now = new Date().toISOString();
  await tx.insert(schema.invoiceLineItems).values(
    items.map((item) => ({ ...item, invoiceId, createdAt: now })),
  );
}

export async function replaceInvoiceLineItems(
  tx: DbTransaction,
  invoiceId: string,
  items: Parameters<typeof insertInvoiceLineItems>[2],
) {
  await tx.delete(schema.invoiceLineItems).where(eq(schema.invoiceLineItems.invoiceId, invoiceId));
  await insertInvoiceLineItems(tx, invoiceId, items);
}

export async function softDeleteInvoice(tx: DbTransaction, id: string, deletedBy: string) {
  const now = new Date().toISOString();
  await tx
    .update(schema.invoices)
    .set({ deletedAt: now, deletedBy })
    .where(eq(schema.invoices.id, id));
}

export async function restoreInvoice(tx: DbTransaction, id: string) {
  await tx
    .update(schema.invoices)
    .set({ deletedAt: null, deletedBy: null })
    .where(eq(schema.invoices.id, id));
  return findInvoiceById(tx, id, { includeDeleted: true });
}

// ── Quotes ──────────────────────────────────────────────────────────────────

async function loadQuoteLines(db: DbLike, quoteId: string) {
  return db
    .select()
    .from(schema.quoteLines)
    .where(eq(schema.quoteLines.quoteId, quoteId))
    .orderBy(asc(schema.quoteLines.sortOrder));
}

async function mapQuoteRow(db: DbLike, quote: typeof schema.quotes.$inferSelect) {
  const lines = await loadQuoteLines(db, quote.id);
  return {
    ...quote,
    subtotal: num(quote.subtotal),
    taxTotal: num(quote.taxTotal),
    grandTotal: num(quote.grandTotal),
    lines: lines.map((l) => ({
      ...l,
      quantity: num(l.quantity),
      unitPrice: num(l.unitPrice),
      lineTotal: num(l.lineTotal),
      taxRate: num(l.taxRate),
      taxAmount: num(l.taxAmount),
    })),
  };
}

export async function findQuotes(
  db: Db,
  filters: { entityId?: string; status?: string; createdBy?: string },
) {
  const conditions: SQL[] = [isNull(schema.quotes.deletedAt)];
  if (filters.entityId) conditions.push(eq(schema.quotes.entityId, filters.entityId));
  if (filters.status) conditions.push(eq(schema.quotes.status, filters.status));
  if (filters.createdBy) conditions.push(eq(schema.quotes.createdBy, filters.createdBy));

  const rows = await db
    .select()
    .from(schema.quotes)
    .where(and(...conditions))
    .orderBy(desc(schema.quotes.issueDate));

  return Promise.all(rows.map((q) => mapQuoteRow(db, q)));
}

export async function findQuoteById(db: DbLike, id: string) {
  const [row] = await db
    .select()
    .from(schema.quotes)
    .where(and(eq(schema.quotes.id, id), isNull(schema.quotes.deletedAt)))
    .limit(1);
  if (!row) return null;
  return mapQuoteRow(db, row);
}

export async function insertQuoteLines(
  tx: DbTransaction,
  quoteId: string,
  lines: Array<{
    id: string;
    description: string;
    quantity: string;
    unitPrice: string;
    lineTotal: string;
    taxRate: string;
    taxAmount: string;
    glAccountId: string | null;
    sortOrder: number;
  }>,
) {
  if (lines.length === 0) return;
  await tx.insert(schema.quoteLines).values(lines.map((l) => ({ ...l, quoteId })));
}

export async function replaceQuoteLines(
  tx: DbTransaction,
  quoteId: string,
  lines: Parameters<typeof insertQuoteLines>[2],
) {
  await tx.delete(schema.quoteLines).where(eq(schema.quoteLines.quoteId, quoteId));
  await insertQuoteLines(tx, quoteId, lines);
}

export async function softDeleteQuote(tx: DbTransaction, id: string) {
  const now = new Date().toISOString();
  await tx
    .update(schema.quotes)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(schema.quotes.id, id));
}

// ── Fiscal periods ──────────────────────────────────────────────────────────

export async function findFiscalPeriods(db: Db, entityId?: string) {
  const conditions: SQL[] = [];
  if (entityId) conditions.push(eq(schema.fiscalPeriods.entityId, entityId));
  return db
    .select()
    .from(schema.fiscalPeriods)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(schema.fiscalPeriods.year), desc(schema.fiscalPeriods.month));
}

export async function upsertFiscalPeriod(
  db: Db,
  data: {
    entityId: string;
    year: number;
    month: number;
    status: string;
    closedBy?: string | null;
    note?: string | null;
  },
) {
  const now = new Date().toISOString();
  const id = createCuid();
  const [row] = await db
    .insert(schema.fiscalPeriods)
    .values({
      id,
      entityId: data.entityId,
      year: data.year,
      month: data.month,
      status: data.status,
      closedBy: data.closedBy ?? null,
      note: data.note ?? null,
      closedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        schema.fiscalPeriods.entityId,
        schema.fiscalPeriods.year,
        schema.fiscalPeriods.month,
      ],
      set: {
        status: data.status,
        closedBy: data.closedBy ?? null,
        note: data.note ?? null,
        updatedAt: now,
        ...(data.status === "closed" ? { closedAt: now } : {}),
      },
    })
    .returning();
  return row;
}

// ── Fixed assets (read) ─────────────────────────────────────────────────────

export async function findFixedAssets(
  db: Db,
  filters: {
    entityId?: string;
    status?: string;
    categoryCode?: string;
    assetClass?: string;
    search?: string;
  },
  page: number,
  limit: number,
) {
  const conditions: SQL[] = [isNull(schema.fixedAssets.deletedAt)];
  if (filters.entityId) conditions.push(eq(schema.fixedAssets.entityId, filters.entityId));
  if (filters.status) conditions.push(eq(schema.fixedAssets.status, filters.status));
  if (filters.categoryCode) {
    conditions.push(eq(schema.fixedAssets.categoryCode, filters.categoryCode));
  }
  if (filters.assetClass) conditions.push(eq(schema.fixedAssets.assetClass, filters.assetClass));
  if (filters.search?.trim()) {
    const term = `%${filters.search.trim()}%`;
    conditions.push(
      or(
        ilike(schema.fixedAssets.name, term),
        ilike(schema.fixedAssets.assetNo, term),
        ilike(schema.fixedAssets.serialNo, term),
      )!,
    );
  }

  const where = and(...conditions);
  const offset = (page - 1) * limit;
  const [totalRow] = await db.select({ total: count() }).from(schema.fixedAssets).where(where);

  const rows = await db
    .select()
    .from(schema.fixedAssets)
    .where(where)
    .orderBy(desc(schema.fixedAssets.purchaseDate))
    .limit(limit)
    .offset(offset);

  return { data: rows, total: Number(totalRow?.total ?? 0) };
}

export async function findFixedAssetById(db: Db, id: string) {
  const [row] = await db
    .select()
    .from(schema.fixedAssets)
    .where(and(eq(schema.fixedAssets.id, id), isNull(schema.fixedAssets.deletedAt)))
    .limit(1);
  return row ?? null;
}

export { createCuid };
export * from "./accounting.repository.ext";
