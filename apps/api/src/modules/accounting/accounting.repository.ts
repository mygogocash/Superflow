import type { Prisma } from "@nexora/database";

import {
  BadRequestException,
  NotFoundException,
} from "@/common/exceptions/http-exception";
import { prisma } from "@/infrastructure/database/prisma";
import {
  excludeDeleted,
  restoreUpdate,
  softDeleteUpdate,
} from "@/infrastructure/soft-delete";
import {
  assertPostingPeriodOpen,
  firstOpenPeriodStart,
  isPostingPeriodClosed,
  utcYearMonth,
} from "@/modules/accounting/accounting.locks";
import type {
  CreateAccountInput,
  CreateBankAccountInput,
  CreateJournalInput,
  ImportAccountRow,
  ImportBankStatementInput,
  ImportJournalEntry,
  UpdateAccountInput,
  UpdateBankAccountInput,
  UpdateJournalInput,
} from "@/modules/accounting/accounting.validation";
import {
  ACCOUNTING_JOURNAL_LINKED_TO,
  assertAttachmentFileAllowed,
  assertHasAttachment,
} from "@/modules/accounting/attachments-rules";
import { normalizeEnglishName } from "@/modules/accounting/coa-validation";
import {
  assertBalanced,
  normalizeLines,
  postBalancedEntry,
} from "@/modules/accounting/gl-posting.service";
import {
  RETAINED_EARNINGS_ROLE,
  type ReversalWarning,
  reversalWarnings,
  VAT_MAPPING_ROLES,
} from "@/modules/accounting/journal-reversal";
import {
  allocateDocumentNumber,
  allocateDraftNumber,
} from "@/modules/accounting/numbering.service";

// Closed-period originals stay in P&L/TB under `reversed` so the closed
// month is immutable; the reversing JE is `posted` in an open period.
const GL_LIVE_STATUSES = ["posted", "reversed"] as const;

function isDraftEntryNo(entryNo: string): boolean {
  return entryNo.startsWith("DRAFT-");
}

function isManualSource(
  sourceType: string | null,
  draftNo: string | null,
): boolean {
  if (sourceType === "manual") return true;
  // New manual drafts set draftNo and leave sourceType null. Imports and
  // legacy posted rows have no draftNo — cancel would unwind COA that
  // those paths never moved.
  return sourceType == null && draftNo != null;
}

async function lockJournalRow(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM journal_entries WHERE id = ${id} FOR UPDATE`;
}

const journalIncludes = {
  entity: { select: { id: true, name: true, code: true, currency: true } },
  creator: { select: { id: true, name: true, email: true } },
  approver: { select: { id: true, name: true, email: true } },
  rejector: { select: { id: true, name: true, email: true } },
  canceller: { select: { id: true, name: true, email: true } },
  lines: {
    include: {
      account: { select: { id: true, code: true, name: true, type: true } },
    },
    orderBy: { debit: "desc" as const },
  },
} satisfies Prisma.JournalEntryInclude;

const invoiceIncludes = {
  entity: { select: { id: true, name: true } },
  lineItems: { orderBy: { sortOrder: "asc" } },
} satisfies Prisma.InvoiceInclude;

// The company-setup projection of an Entity: identity fields for context plus
// every Chunk-2 company-profile / fiscal-year / activation column.
const entitySetupSelect = {
  id: true,
  name: true,
  code: true,
  country: true,
  currency: true,
  taxId: true,
  address: true,
  nameTh: true,
  branchCode: true,
  logoUrl: true,
  vatRegistrationStatus: true,
  boiType: true,
  boiPeriod: true,
  fiscalYearStartMonth: true,
  firstFiscalYearStart: true,
  firstFiscalYearEnd: true,
  defaultRateSource: true,
  enabledCurrencies: true,
  setupState: true,
} satisfies Prisma.EntitySelect;

// SystemSetting key holding the maker-checker config JSON
// ({ blockSelfApproval: boolean }). One global row; default OFF when absent.
const MAKER_CHECKER_KEY = "accounting.maker_checker";
const SECOND_APPROVAL_KEY = "accounting.second_approval";

export class AccountingRepository {
  async findAccounts(filters: {
    entityId?: string;
    type?: string;
    isActive?: boolean;
    parentId?: string;
    sortBy?: "code" | "name" | "type" | "balance";
    sortOrder?: "asc" | "desc";
  }) {
    const where: Prisma.ChartOfAccountWhereInput = { deletedAt: null };
    if (filters.entityId) where.entityId = filters.entityId;
    if (filters.type) where.type = filters.type;
    if (filters.isActive !== undefined) where.isActive = filters.isActive;
    if (filters.parentId) where.parentId = filters.parentId;

    const dir = filters.sortOrder ?? "asc";
    const orderBy: Prisma.ChartOfAccountOrderByWithRelationInput =
      filters.sortBy === "name"
        ? { name: dir }
        : filters.sortBy === "type"
          ? { type: dir }
          : filters.sortBy === "balance"
            ? { balance: dir }
            : { code: filters.sortBy === "code" ? dir : "asc" };

    return prisma.chartOfAccount.findMany({
      where,
      include: {
        entity: { select: { id: true, name: true } },
        parent: { select: { id: true, code: true, name: true } },
      },
      orderBy,
    });
  }

  async findAccountByEntityAndCode(entityId: string, code: string) {
    return prisma.chartOfAccount.findFirst({
      where: { entityId, code, deletedAt: null },
      orderBy: { isActive: "desc" },
    });
  }

  async findActiveAccountByEntityAndCode(entityId: string, code: string) {
    return prisma.chartOfAccount.findFirst({
      where: { entityId, code, isActive: true, deletedAt: null },
    });
  }

  async findInactiveAccountByEntityAndCode(
    entityId: string,
    code: string,
    excludeId?: string,
  ) {
    return prisma.chartOfAccount.findFirst({
      where: {
        entityId,
        code,
        isActive: false,
        deletedAt: null,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
  }

  async findActiveAccountByNormalizedName(
    entityId: string,
    nameNormalized: string,
    excludeId?: string,
  ) {
    return prisma.chartOfAccount.findFirst({
      where: {
        entityId,
        nameNormalized,
        isActive: true,
        deletedAt: null,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
  }

  async findInactiveAccountByNormalizedName(
    entityId: string,
    nameNormalized: string,
    excludeId?: string,
  ) {
    return prisma.chartOfAccount.findFirst({
      where: {
        entityId,
        nameNormalized,
        isActive: false,
        deletedAt: null,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
  }

  // Journal-entry statuses whose lines are IN the ledger.
  //
  // `posted` is the live state (approveJournal writes "posted", not "approved").
  // `reversed` must be counted too: a closed-period cancellation leaves the
  // original posted and adds a separate posted reversing entry, so the pair nets
  // to zero only if both are summed — count the reversal alone and the account
  // reads as a mirror-image balance it never had.
  //
  // `cancelled` is excluded: that path DECREMENTS the balances in place and
  // writes no reversing entry, so its lines are stale rows describing an effect
  // that has already been undone.
  // `draft` / `approved` / `rejected` / `deleted` never reached the ledger.
  private static readonly LEDGER_STATUSES = ["posted", "reversed"];

  /**
   * An account's balance and last movement, derived from the journal lines
   * rather than read off the stored `balance` counter.
   *
   * The counter is fine for a list column; it is not fine for a rule that
   * BLOCKS a save. A drifted counter would either refuse a legitimate code
   * reuse or wave through the collision the block exists to prevent, and in
   * both cases the user has no way to tell.
   *
   * Sign convention matches the stored column: debit-positive.
   */
  async accountLedgerFacts(
    accountId: string,
  ): Promise<{ balance: number; lastMovementYear: number | null }> {
    const [totals, latest] = await Promise.all([
      prisma.journalEntryLine.aggregate({
        where: {
          accountId,
          entry: {
            status: { in: AccountingRepository.LEDGER_STATUSES },
            deletedAt: null,
          },
        },
        _sum: { debit: true, credit: true },
      }),
      prisma.journalEntryLine.findFirst({
        where: {
          accountId,
          entry: {
            status: { in: AccountingRepository.LEDGER_STATUSES },
            deletedAt: null,
          },
        },
        orderBy: { entry: { date: "desc" } },
        select: { entry: { select: { date: true } } },
      }),
    ]);
    const debit = Number(totals._sum.debit ?? 0);
    const credit = Number(totals._sum.credit ?? 0);
    return {
      balance: Math.round((debit - credit + Number.EPSILON) * 100) / 100,
      lastMovementYear: latest?.entry.date.getUTCFullYear() ?? null,
    };
  }

  /** Approval bookkeeping only — never touches amounts or line items. */
  async updateInvoiceApproval(
    id: string,
    data: {
      status?: string;
      approvedById?: string | null;
      approvedAt?: Date | null;
      secondApprovedById?: string | null;
      secondApprovedAt?: Date | null;
      thresholdApplied?: number | null;
      splitFlagged?: boolean;
      cancelReason?: string | null;
    },
  ) {
    return prisma.invoice.update({ where: { id }, data });
  }

  async getSecondApprovalSetting() {
    return prisma.systemSetting.findUnique({
      where: { key: SECOND_APPROVAL_KEY },
    });
  }

  async upsertSecondApprovalSetting(value: Prisma.InputJsonValue) {
    return prisma.systemSetting.upsert({
      where: { key: SECOND_APPROVAL_KEY },
      create: { key: SECOND_APPROVAL_KEY, value },
      update: { value },
    });
  }

  /**
   * How many distinct people can approve.
   *
   * A system Admin role is granted every permission code implicitly, so it
   * counts even without an explicit `accounting:approve` row — otherwise a
   * company whose only approvers are admins could never switch the control on.
   */
  async countApprovers(permissionCode: string): Promise<number> {
    const rows = await prisma.userRole.findMany({
      where: {
        role: {
          deletedAt: null,
          OR: [
            { rolePermissions: { some: { permissionCode } } },
            { isSystem: true, name: "Admin" },
          ],
        },
        user: { deletedAt: null, isActive: true },
      },
      select: { userId: true },
      distinct: ["userId"],
    });
    return rows.length;
  }

  /**
   * Approved documents sharing a counterparty, type and date with this one.
   *
   * The split-detection window is a single day per the PRD. Cancelled documents
   * are excluded: raising and voiding a document repeatedly in one day is not
   * evidence of splitting, and counting the voids would manufacture findings.
   */
  async findSameDayDocuments(opts: {
    entityId: string;
    type: string;
    issueDate: Date;
    counterparty: string;
    excludeId?: string;
  }) {
    return prisma.invoice.findMany({
      where: {
        entityId: opts.entityId,
        type: opts.type,
        issueDate: opts.issueDate,
        counterparty: opts.counterparty,
        status: { notIn: ["cancelled", "draft"] },
        deletedAt: null,
        ...(opts.excludeId ? { id: { not: opts.excludeId } } : {}),
      },
      select: { id: true, amount: true, exchangeRate: true },
    });
  }

  /** Ids of every asset-type account for an entity. Capex classification asks
   *  "did this line post to an asset account", so the answer is a set lookup
   *  rather than a per-line query. */
  async findAssetAccountIds(entityId?: string): Promise<Set<string>> {
    const rows = await prisma.chartOfAccount.findMany({
      where: {
        type: "asset",
        deletedAt: null,
        ...(entityId ? { entityId } : {}),
      },
      select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  }

  /** True while a financial-statement mapping role still points at this
   *  account — the statement would pull both accounts into one line. */
  async isAccountMapped(accountId: string): Promise<boolean> {
    const hit = await prisma.accountMapping.findFirst({
      where: { chartOfAccountId: accountId },
      select: { id: true },
    });
    return hit !== null;
  }

  /** Every account created on a deactivated account's code or English name,
   *  with the predecessor it points back at. Feeds the auditor report. */
  async findReusedCodeAccounts(entityId?: string) {
    return prisma.chartOfAccount.findMany({
      where: {
        deletedAt: null,
        reusedFromAccountId: { not: null },
        ...(entityId ? { entityId } : {}),
      },
      select: {
        id: true,
        entityId: true,
        code: true,
        name: true,
        nameTh: true,
        isActive: true,
        balance: true,
        reuseAcknowledgedBy: true,
        reuseAcknowledgedAt: true,
        reusedFrom: {
          select: {
            id: true,
            code: true,
            name: true,
            nameTh: true,
            deactivatedAt: true,
            balance: true,
          },
        },
      },
      orderBy: [{ code: "asc" }],
    });
  }

  async findAccountById(id: string) {
    return prisma.chartOfAccount.findUnique({
      where: { id, deletedAt: null },
      include: {
        entity: { select: { id: true, name: true } },
        parent: { select: { id: true, code: true, name: true } },
      },
    });
  }

  // ── Account-role mappings (GL posting routing table) ─────────────────────

  async findAccountMappings(entityId: string) {
    return prisma.accountMapping.findMany({
      where: { entityId },
      include: {
        account: {
          select: { id: true, code: true, name: true, type: true },
        },
      },
      orderBy: { role: "asc" },
    });
  }

  // A single active, non-deleted account scoped to the entity — used to
  // validate a mapping target before writing it (an account from another
  // entity, or an inactive one, must never become a posting target).
  async findAccountForMapping(entityId: string, id: string) {
    return prisma.chartOfAccount.findFirst({
      where: { id, entityId, deletedAt: null, isActive: true },
      select: { id: true, code: true, name: true, type: true },
    });
  }

  async upsertAccountMapping(
    entityId: string,
    role: string,
    chartOfAccountId: string,
  ) {
    return prisma.accountMapping.upsert({
      where: { entityId_role: { entityId, role } },
      create: { entityId, role, chartOfAccountId },
      update: { chartOfAccountId },
    });
  }

  // deleteMany (not delete) so clearing an already-unmapped role is a no-op
  // rather than a P2025 throw.
  async deleteAccountMapping(entityId: string, role: string) {
    await prisma.accountMapping.deleteMany({ where: { entityId, role } });
  }

  // ── Company setup, fiscal year & activation gate (Chunk 2) ───────────────

  // The full company-setup projection of one (non-deleted) entity, or null.
  async findEntitySetup(entityId: string) {
    return prisma.entity.findFirst({
      where: { id: entityId, deletedAt: null },
      select: entitySetupSelect,
    });
  }

  // Apply a partial company-profile / fiscal-year update to the entity row.
  async updateEntitySetup(entityId: string, data: Prisma.EntityUpdateInput) {
    return prisma.entity.update({
      where: { id: entityId },
      data,
      select: entitySetupSelect,
    });
  }

  // Just the activation gate's inputs: the current setup state and how many
  // active (non-deleted) accounts back the entity's chart. `setupState` is
  // read straight off the row (deleted or not) so the guard can speak to any
  // entity id it's handed.
  async getEntitySetupState(entityId: string): Promise<string | null> {
    const row = await prisma.entity.findUnique({
      where: { id: entityId },
      select: { setupState: true },
    });
    return row?.setupState ?? null;
  }

  async countActiveAccounts(entityId: string): Promise<number> {
    return prisma.chartOfAccount.count({
      where: { entityId, isActive: true, deletedAt: null },
    });
  }

  // ── Opening-balance import (Chunk 6) ─────────────────────────────────────

  // True once the entity has a (non-deleted) opening-balance journal entry.
  // Opening balances are entered once — this gates both the import (Conflict on
  // a second run) and activation (which requires the books to be opened first).
  async hasOpeningEntry(entityId: string): Promise<boolean> {
    const count = await prisma.journalEntry.count({
      where: { entityId, sourceType: "opening", deletedAt: null },
    });
    return count > 0;
  }

  // Light summary of the entity's opening entry (or null) for the setup UI's
  // status badge.
  async findOpeningEntry(entityId: string) {
    return prisma.journalEntry.findFirst({
      where: { entityId, sourceType: "opening", deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        entryNo: true,
        date: true,
        description: true,
        status: true,
        postedAt: true,
        createdAt: true,
      },
    });
  }

  // Ids of the entity's active (non-deleted) accounts — used to validate that
  // opening lines only post to accounts that belong to this entity.
  async findActiveAccountIds(entityId: string): Promise<string[]> {
    const rows = await prisma.chartOfAccount.findMany({
      where: { entityId, isActive: true, deletedAt: null },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  // Entities that have any chart of accounts — the set for which posting
  // readiness is meaningful.
  async listEntityIdsWithAccounts(): Promise<string[]> {
    const rows = await prisma.chartOfAccount.findMany({
      where: { deletedAt: null },
      distinct: ["entityId"],
      select: { entityId: true },
      orderBy: { entityId: "asc" },
    });
    return rows.map((r) => r.entityId);
  }

  // ── Tax codes (Thai VAT + WHT config) ────────────────────────────────────

  async findTaxCodes(entityId: string, includeInactive: boolean) {
    return prisma.taxCode.findMany({
      where: { entityId, ...(includeInactive ? {} : { isActive: true }) },
      include: {
        glAccount: { select: { id: true, code: true, name: true, type: true } },
      },
      orderBy: [{ kind: "asc" }, { code: "asc" }],
    });
  }

  async findTaxCodeById(id: string) {
    return prisma.taxCode.findUnique({
      where: { id },
      include: {
        glAccount: { select: { id: true, code: true, name: true, type: true } },
      },
    });
  }

  async findTaxCodeByEntityAndCode(entityId: string, code: string) {
    return prisma.taxCode.findUnique({
      where: { entityId_code: { entityId, code } },
    });
  }

  async createTaxCode(data: {
    entityId: string;
    code: string;
    name: string;
    kind: string;
    rate: number;
    glAccountId: string | null;
    isActive: boolean;
  }) {
    return prisma.taxCode.create({
      data,
      include: {
        glAccount: { select: { id: true, code: true, name: true, type: true } },
      },
    });
  }

  async updateTaxCode(id: string, data: Prisma.TaxCodeUpdateInput) {
    return prisma.taxCode.update({
      where: { id },
      data,
      include: {
        glAccount: { select: { id: true, code: true, name: true, type: true } },
      },
    });
  }

  async deleteTaxCode(id: string) {
    return prisma.taxCode.delete({ where: { id } });
  }

  // How many document lines reference this tax code — a non-zero count blocks a
  // hard delete (deactivate instead). Covers every table with a taxCodeId FK.
  async countTaxCodeUsage(id: string): Promise<number> {
    const [quoteLines, poLines, creditNoteLines] = await prisma.$transaction([
      prisma.quoteLine.count({ where: { taxCodeId: id } }),
      prisma.poLine.count({ where: { taxCodeId: id } }),
      prisma.creditNoteLine.count({ where: { taxCodeId: id } }),
    ]);
    return quoteLines + poLines + creditNoteLines;
  }

  // ── Maker-checker config (SystemSetting-backed) ──────────────────────────

  async getMakerCheckerSetting() {
    return prisma.systemSetting.findUnique({
      where: { key: MAKER_CHECKER_KEY },
    });
  }

  async upsertMakerCheckerSetting(value: { blockSelfApproval: boolean }) {
    return prisma.systemSetting.upsert({
      where: { key: MAKER_CHECKER_KEY },
      create: { key: MAKER_CHECKER_KEY, value: { ...value } },
      update: { value: { ...value } },
    });
  }

  // The subset of `ids` that the given user created — used to enforce the
  // maker-checker self-approval block on bulk approve without a per-row query.
  async findJournalsCreatedBy(ids: string[], createdBy: string) {
    return prisma.journalEntry.findMany({
      where: { id: { in: ids }, createdBy, deletedAt: null },
      select: { id: true },
    });
  }

  async createAccount(
    data: CreateAccountInput & {
      nameNormalized: string;
      reusedFromAccountId?: string;
      reuseAcknowledgedBy?: string;
      reuseAcknowledgedAt?: Date;
    },
  ) {
    return prisma.chartOfAccount.create({
      data: {
        entityId: data.entityId,
        code: data.code,
        name: data.name,
        nameTh: data.nameTh ?? null,
        description: data.description ?? null,
        descriptionTh: data.descriptionTh ?? null,
        nameNormalized: data.nameNormalized,
        type: data.type,
        parentId: data.parentId,
        // Only set when this account took a deactivated account's code or name.
        reusedFromAccountId: data.reusedFromAccountId ?? null,
        reuseAcknowledgedBy: data.reuseAcknowledgedBy ?? null,
        reuseAcknowledgedAt: data.reuseAcknowledgedAt ?? null,
      },
      include: {
        entity: { select: { id: true, name: true } },
        parent: { select: { id: true, code: true, name: true } },
      },
    });
  }

  async updateAccount(
    id: string,
    data: UpdateAccountInput & {
      nameNormalized?: string;
      deactivatedAt?: Date | null;
      reusedFromAccountId?: string;
      reuseAcknowledgedBy?: string;
      reuseAcknowledgedAt?: Date;
    },
  ) {
    return prisma.chartOfAccount.update({
      where: { id },
      data,
      include: {
        entity: { select: { id: true, name: true } },
        parent: { select: { id: true, code: true, name: true } },
      },
    });
  }

  async softDeleteAccount(id: string) {
    return prisma.chartOfAccount.update({
      where: { id },
      data: softDeleteUpdate(),
      include: {
        entity: { select: { id: true, name: true } },
        parent: { select: { id: true, code: true, name: true } },
      },
    });
  }

  async restoreAccount(id: string) {
    return prisma.chartOfAccount.update({
      where: { id },
      data: { deletedAt: null },
      include: {
        entity: { select: { id: true, name: true } },
        parent: { select: { id: true, code: true, name: true } },
      },
    });
  }

  async permanentDeleteAccount(id: string) {
    return prisma.chartOfAccount.delete({ where: { id } });
  }

  async findAccountCodes(entityId: string, codes: string[]) {
    if (codes.length === 0) return [];
    return prisma.chartOfAccount.findMany({
      where: { entityId, code: { in: codes } },
      select: { code: true, nameTh: true, isActive: true, name: true },
    });
  }

  async createAccountsBulk(entityId: string, rows: ImportAccountRow[]) {
    if (rows.length === 0) return { count: 0 };
    return prisma.chartOfAccount.createMany({
      data: rows.map((r) => ({
        entityId,
        code: r.code,
        name: r.name,
        nameTh: r.nameTh ?? null,
        description: r.description ?? null,
        descriptionTh: r.descriptionTh ?? null,
        nameNormalized: normalizeEnglishName(r.name),
        type: r.type,
      })),
      skipDuplicates: true,
    });
  }

  // Back-fills the Thai-language name on accounts that already exist
  // but were imported before nameTh was a column. Only touches rows
  // currently NULL on `name_th` so a manually-set Thai label is never
  // clobbered. Returns the number of rows actually updated.
  async backfillAccountNameTh(
    entityId: string,
    rows: Array<{ code: string; nameTh: string }>,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const results = await prisma.$transaction(
      rows.map((r) =>
        prisma.chartOfAccount.updateMany({
          where: { entityId, code: r.code, nameTh: null },
          data: { nameTh: r.nameTh },
        }),
      ),
    );
    return results.reduce((sum, res) => sum + res.count, 0);
  }

  async findJournals(
    filters: {
      entityId?: string;
      status?: string;
      startDate?: string;
      endDate?: string;
      descriptionLang?: "en" | "th";
      createdBy?: string;
      sortBy?:
        | "entryNo"
        | "reference"
        | "date"
        | "entity"
        | "description"
        | "totalDebit"
        | "totalCredit"
        | "status";
      sortOrder?: "asc" | "desc";
    },
    page: number,
    limit: number,
  ) {
    const where: Prisma.JournalEntryWhereInput = {};
    if (filters.status === "deleted") {
      where.deletedAt = { not: null };
    } else if (filters.status) {
      where.deletedAt = null;
      where.status = filters.status;
    }
    // Default list keeps deleted drafts visible with a Deleted badge.
    if (filters.entityId) where.entityId = filters.entityId;
    if (filters.createdBy) where.createdBy = filters.createdBy;
    if (filters.startDate || filters.endDate) {
      where.date = {};
      if (filters.startDate) where.date.gte = new Date(filters.startDate);
      if (filters.endDate) where.date.lte = new Date(filters.endDate);
    }
    // Language filter mirrors the import column the row was loaded into.
    // We treat blank strings as "missing" so legacy rows that stored
    // `""` instead of NULL don't leak through the wrong tab.
    if (filters.descriptionLang === "en") {
      where.description = { not: null, notIn: [""] };
    } else if (filters.descriptionLang === "th") {
      where.descriptionTh = { not: null, notIn: [""] };
    }

    // totalDebit / totalCredit are derived at response time from the
    // child lines, so we can't ORDER BY them in Prisma. Fall back to
    // `date` for those keys and let the service sort by total client-side.
    const dir = filters.sortOrder ?? "desc";
    const orderBy: Prisma.JournalEntryOrderByWithRelationInput =
      filters.sortBy === "entryNo"
        ? { entryNo: dir }
        : filters.sortBy === "reference"
          ? { reference: dir }
          : filters.sortBy === "date"
            ? { date: dir }
            : filters.sortBy === "entity"
              ? { entity: { name: dir } }
              : filters.sortBy === "description"
                ? { description: dir }
                : filters.sortBy === "status"
                  ? { status: dir }
                  : { createdAt: "desc" };

    const [data, total] = await Promise.all([
      prisma.journalEntry.findMany({
        where,
        include: journalIncludes,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.journalEntry.count({ where }),
    ]);

    return { data, total };
  }

  async findJournalById(id: string) {
    return prisma.journalEntry.findUnique({
      where: { id, deletedAt: null },
      include: journalIncludes,
    });
  }

  // Fetches a journal regardless of soft-delete state. ONLY for the restore
  // path — every other read must go through `findJournalById`, which excludes
  // deleted rows.
  async findJournalByIdIncludingDeleted(id: string) {
    return prisma.journalEntry.findUnique({
      where: { id },
      include: journalIncludes,
    });
  }

  async countJournalsForEntity(entityId: string): Promise<number> {
    return prisma.journalEntry.count({ where: { entityId } });
  }

  // Manual journal creation. Drafts take DRAFT-000123 from a never-reset
  // series and do not consume the monthly JE{YYYY}{MM} sequence. The real
  // number is issued on approve (which also posts).
  async createJournal(data: CreateJournalInput & { createdBy: string }) {
    const date = new Date(data.date);
    return prisma.$transaction(async (tx) => {
      await assertPostingPeriodOpen(tx, data.entityId, date);
      const draftNo = await allocateDraftNumber(tx, data.entityId, "je");
      return tx.journalEntry.create({
        data: {
          entityId: data.entityId,
          entryNo: draftNo,
          draftNo,
          date,
          description: data.description,
          reference: data.reference,
          createdBy: data.createdBy,
          lines: {
            createMany: {
              data: data.lines.map((l) => ({
                accountId: l.accountId,
                debit: l.debit,
                credit: l.credit,
                memo: l.memo,
              })),
            },
          },
        },
        include: journalIncludes,
      });
    });
  }

  // Approve = post (PRD). Issues the statutory number from the document
  // date, stamps postedAt, and moves ChartOfAccount.balance. In-flight
  // approved-but-not-posted rows still go through `postJournal`.
  async approveJournal(id: string, approvedBy: string) {
    return prisma.$transaction(async (tx) => {
      await lockJournalRow(tx, id);
      const entry = await tx.journalEntry.findUnique({
        where: { id },
        include: { lines: true },
      });
      if (!entry) {
        throw new NotFoundException("Journal entry not found");
      }
      if (entry.status !== "draft") {
        throw new BadRequestException(
          `Cannot approve a journal with status "${entry.status}"`,
        );
      }
      await assertPostingPeriodOpen(tx, entry.entityId, entry.date);
      const attachments = await tx.fileUpload.findMany({
        where: {
          linkedTo: ACCOUNTING_JOURNAL_LINKED_TO,
          linkedId: id,
          deletedAt: null,
        },
        select: { mimeType: true, size: true },
      });
      assertHasAttachment(attachments.length);
      for (const file of attachments) {
        assertAttachmentFileAllowed({
          mimeType: file.mimeType,
          size: file.size,
        });
      }
      const lines = normalizeLines(
        entry.lines.map((l) => ({
          accountId: l.accountId,
          debit: l.debit,
          credit: l.credit,
          memo: l.memo,
        })),
      );
      assertBalanced(lines);
      const entryNo = await allocateDocumentNumber(
        tx,
        entry.entityId,
        "je",
        entry.date,
      );
      for (const line of lines) {
        await tx.chartOfAccount.update({
          where: { id: line.accountId },
          data: { balance: { increment: line.debit.minus(line.credit) } },
        });
      }
      return tx.journalEntry.update({
        where: { id },
        data: {
          entryNo,
          status: "posted",
          approvedBy,
          approvedAt: new Date(),
          postedAt: new Date(),
          rejectedBy: null,
          rejectedAt: null,
          rejectReason: null,
        },
        include: journalIncludes,
      });
    });
  }

  async rejectJournal(id: string, rejectedBy: string, rejectReason: string) {
    return prisma.$transaction(async (tx) => {
      await lockJournalRow(tx, id);
      const entry = await tx.journalEntry.findUnique({
        where: { id },
        select: { status: true },
      });
      if (!entry) throw new NotFoundException("Journal entry not found");
      if (entry.status !== "draft") {
        throw new BadRequestException(
          `Cannot reject a journal with status "${entry.status}"`,
        );
      }
      return tx.journalEntry.update({
        where: { id },
        data: {
          status: "rejected",
          rejectedBy,
          rejectedAt: new Date(),
          rejectReason,
          approvedBy: null,
          approvedAt: null,
        },
        include: journalIncludes,
      });
    });
  }

  async bulkApproveJournals(
    _ids: string[],
    _approvedBy: string,
  ): Promise<never> {
    throw new BadRequestException(
      "Bulk approve must post each draft through approveJournal (number + attachments + GL).",
    );
  }

  async bulkRejectJournals(
    ids: string[],
    rejectedBy: string,
    rejectReason: string,
  ) {
    return prisma.journalEntry.updateMany({
      where: { id: { in: ids }, status: "draft", deletedAt: null },
      data: {
        status: "rejected",
        rejectedBy,
        rejectedAt: new Date(),
        rejectReason,
        approvedBy: null,
        approvedAt: null,
      },
    });
  }

  async postJournal(
    id: string,
    lines: Array<{ accountId: string; debit: number; credit: number }>,
  ) {
    return prisma.$transaction(async (tx) => {
      // This is the call that moves ChartOfAccount.balance, so it is the manual
      // path's real posting moment and must respect a closed month — every
      // engine path already does. The entry's own date governs the period, not
      // today: an entry dated December posted in March belongs to December.
      await lockJournalRow(tx, id);
      const entry = await tx.journalEntry.findUnique({
        where: { id },
        select: { entityId: true, date: true, entryNo: true, status: true },
      });
      if (!entry) {
        throw new NotFoundException("Journal entry not found");
      }
      if (entry.status !== "approved") {
        throw new BadRequestException(
          `Cannot post a journal with status "${entry.status}"`,
        );
      }
      await assertPostingPeriodOpen(tx, entry.entityId, entry.date);

      for (const line of lines) {
        const delta = line.debit - line.credit;
        await tx.chartOfAccount.update({
          where: { id: line.accountId },
          data: { balance: { increment: delta } },
        });
      }

      const entryNo = isDraftEntryNo(entry.entryNo)
        ? await allocateDocumentNumber(tx, entry.entityId, "je", entry.date)
        : entry.entryNo;

      return tx.journalEntry.update({
        where: { id },
        data: { entryNo, status: "posted", postedAt: new Date() },
        include: journalIncludes,
      });
    });
  }

  async cancelJournal(opts: {
    id: string;
    actorId: string;
    reason: string;
    reverseDate?: Date;
  }) {
    return prisma.$transaction(async (tx) => {
      await lockJournalRow(tx, opts.id);
      const entry = await tx.journalEntry.findUnique({
        where: { id: opts.id },
        include: { lines: true },
      });
      if (!entry) {
        throw new NotFoundException("Journal entry not found");
      }
      if (entry.status !== "posted" && entry.status !== "approved") {
        throw new BadRequestException(
          `Cannot cancel a journal with status "${entry.status}"`,
        );
      }
      if (!isManualSource(entry.sourceType, entry.draftNo)) {
        throw new BadRequestException(
          entry.sourceType
            ? `Cancel this ${entry.sourceType} from its source document, not from the journal`
            : "Imported and legacy journals cannot be cancelled from this action",
        );
      }
      if (entry.reversesEntryId) {
        throw new BadRequestException(
          "A reversing journal cannot itself be cancelled",
        );
      }

      const stamp = {
        cancelledAt: new Date(),
        cancelledBy: opts.actorId,
        cancelReason: opts.reason,
      };

      // Approved but never posted: no balances to unwind, and no reversing
      // entry, so there is nothing to warn about.
      if (entry.status === "approved") {
        const journal = await tx.journalEntry.update({
          where: { id: entry.id },
          data: { status: "cancelled", ...stamp },
          include: journalIncludes,
        });
        return { journal, warnings: [] as ReversalWarning[] };
      }

      const closed = await isPostingPeriodClosed(
        tx,
        entry.entityId,
        entry.date,
      );
      if (!closed) {
        for (const line of entry.lines) {
          const delta = Number(line.credit) - Number(line.debit);
          await tx.chartOfAccount.update({
            where: { id: line.accountId },
            data: { balance: { increment: delta } },
          });
        }
        const journal = await tx.journalEntry.update({
          where: { id: entry.id },
          data: { status: "cancelled", ...stamp },
          include: journalIncludes,
        });
        return { journal, warnings: [] as ReversalWarning[] };
      }

      // Default to the first open month, so the reversal lands as close to the
      // month it undoes as the closed periods allow. The user may move it to any
      // OTHER open month — the rule is that it must be somewhere still editable,
      // not that it must be that particular month.
      const openStart = await firstOpenPeriodStart(tx, entry.entityId);
      const reverseDate = opts.reverseDate ?? openStart;
      if (reverseDate < entry.date) {
        throw new BadRequestException(
          "Reversing journal date cannot be before the original entry date",
        );
      }
      // Re-checked here rather than trusted from the default: a period can be
      // closed between opening the dialog and confirming it.
      await assertPostingPeriodOpen(tx, entry.entityId, reverseDate);

      // Two consequences of moving the effect into a later month that are not
      // visible in the resulting journal. Resolved from the entity's mapping,
      // so an entity that has not mapped VAT simply raises no VAT warning.
      const flaggedAccounts = await tx.accountMapping.findMany({
        where: {
          entityId: entry.entityId,
          role: { in: [...VAT_MAPPING_ROLES, RETAINED_EARNINGS_ROLE] },
        },
        select: { role: true, chartOfAccountId: true },
      });
      const vatAccountIds = new Set(
        flaggedAccounts
          .filter((m) =>
            (VAT_MAPPING_ROLES as readonly string[]).includes(m.role),
          )
          .map((m) => m.chartOfAccountId),
      );
      const retainedAccountIds = new Set(
        flaggedAccounts
          .filter((m) => m.role === RETAINED_EARNINGS_ROLE)
          .map((m) => m.chartOfAccountId),
      );
      const warnings = reversalWarnings({
        touchesVat: entry.lines.some((l) => vatAccountIds.has(l.accountId)),
        touchesRetainedEarnings: entry.lines.some((l) =>
          retainedAccountIds.has(l.accountId),
        ),
        originalDate: entry.date,
        reverseDate,
      });
      const reversing = await postBalancedEntry(tx, {
        entityId: entry.entityId,
        date: reverseDate,
        description: `Reversal of ${entry.entryNo}: ${opts.reason}`,
        reference: entry.entryNo,
        sourceType: "je-reversal",
        sourceRef: entry.id,
        createdBy: opts.actorId,
        lines: entry.lines.map((l) => ({
          accountId: l.accountId,
          debit: Number(l.credit),
          credit: Number(l.debit),
          memo: l.memo,
        })),
      });
      await tx.journalEntry.update({
        where: { id: reversing.id },
        data: { reversesEntryId: entry.id },
      });
      const journal = await tx.journalEntry.update({
        where: { id: entry.id },
        data: {
          status: "reversed",
          reversedByEntryId: reversing.id,
          ...stamp,
        },
        include: journalIncludes,
      });
      return { journal, warnings };
    });
  }

  /**
   * Reversing entries in a date window, with the entry each one undoes.
   *
   * Reads from the REVERSAL side (`reversesEntryId` is set) rather than looking
   * for status "reversed", so the report is keyed on the month the effect landed
   * in — which is the month whose figures a reviewer is trying to explain.
   */
  async findJournalReversals(filters: {
    startDate: Date;
    endDate: Date;
    entityId?: string;
  }) {
    return prisma.journalEntry.findMany({
      where: {
        deletedAt: null,
        reversesEntryId: { not: null },
        date: { gte: filters.startDate, lte: filters.endDate },
        ...(filters.entityId ? { entityId: filters.entityId } : {}),
      },
      select: {
        id: true,
        entryNo: true,
        date: true,
        description: true,
        createdBy: true,
        createdAt: true,
        reversesEntry: {
          select: {
            id: true,
            entryNo: true,
            date: true,
            cancelReason: true,
            cancelledBy: true,
            cancelledAt: true,
          },
        },
      },
      orderBy: [{ date: "asc" }, { entryNo: "asc" }],
    });
  }

  async updateJournal(
    id: string,
    data: UpdateJournalInput,
    resetReview = false,
  ) {
    return prisma.$transaction(async (tx) => {
      await lockJournalRow(tx, id);
      const entry = await tx.journalEntry.findUnique({
        where: { id },
        select: { status: true },
      });
      if (!entry) throw new NotFoundException("Journal entry not found");
      if (!["draft", "rejected"].includes(entry.status)) {
        throw new BadRequestException(
          `Cannot update a journal with status "${entry.status}"`,
        );
      }
      if (data.lines) {
        await tx.journalEntryLine.deleteMany({ where: { entryId: id } });
        await tx.journalEntryLine.createMany({
          data: data.lines.map((l) => ({
            entryId: id,
            accountId: l.accountId,
            debit: l.debit,
            credit: l.credit,
            memo: l.memo,
          })),
        });
      }

      return tx.journalEntry.update({
        where: { id },
        data: {
          ...(data.date !== undefined && { date: new Date(data.date) }),
          ...(data.description !== undefined && {
            description: data.description,
          }),
          ...(data.reference !== undefined && { reference: data.reference }),
          ...(resetReview && {
            status: "draft",
            rejectedBy: null,
            rejectedAt: null,
            rejectReason: null,
          }),
        },
        include: journalIncludes,
      });
    });
  }

  async softDeleteJournal(id: string, deletedBy?: string) {
    return prisma.$transaction(async (tx) => {
      await lockJournalRow(tx, id);
      const entry = await tx.journalEntry.findUnique({
        where: { id },
        select: { status: true },
      });
      if (!entry) throw new NotFoundException("Journal entry not found");
      if (!["draft", "rejected"].includes(entry.status)) {
        throw new BadRequestException(
          `Cannot delete a journal with status "${entry.status}"`,
        );
      }
      return tx.journalEntry.update({
        where: { id },
        data: { ...softDeleteUpdate(), deletedBy: deletedBy ?? null },
        include: journalIncludes,
      });
    });
  }

  async restoreJournal(id: string) {
    return prisma.journalEntry.update({
      where: { id },
      data: restoreUpdate(),
      include: journalIncludes,
    });
  }

  async permanentDeleteJournal(id: string) {
    return prisma.journalEntry.delete({ where: { id } });
  }

  // Bulk soft-delete a known id set. Already-deleted rows are excluded so the
  // returned count reflects rows actually transitioned (never re-stamps a row
  // that was already removed).
  async bulkSoftDeleteJournals(ids: string[]) {
    if (ids.length === 0) return { count: 0 };
    return prisma.journalEntry.updateMany({
      where: {
        id: { in: ids },
        status: { in: ["draft", "rejected"] },
        ...excludeDeleted(),
      },
      data: softDeleteUpdate(),
    });
  }

  // Admin bulk wipe of drafts/rejected only. Issued numbers stay reserved.
  async softDeleteAllJournals() {
    return prisma.journalEntry.updateMany({
      where: { status: { in: ["draft", "rejected"] }, ...excludeDeleted() },
      data: softDeleteUpdate(),
    });
  }

  // Look up account ids by entity + code for a batch of codes. Used by
  // the journal-import preview to resolve `accountCode` strings to
  // ChartOfAccount.id before insertion.
  async findAccountIdsByCodes(entityId: string, codes: string[]) {
    if (codes.length === 0) return [];
    return prisma.chartOfAccount.findMany({
      where: { entityId, code: { in: codes }, deletedAt: null },
      select: { id: true, code: true, name: true, nameTh: true },
    });
  }

  // Find existing journal entries by (entity, reference). The accounting-
  // system Document No (e.g. PV2026010023) maps to `reference`, so this
  // is the natural duplicate-check key for re-imports.
  async findJournalReferences(entityId: string, references: string[]) {
    if (references.length === 0) return [];
    return prisma.journalEntry.findMany({
      where: { entityId, reference: { in: references }, deletedAt: null },
      select: {
        id: true,
        reference: true,
        description: true,
        descriptionTh: true,
      },
    });
  }

  // Bulk-imports historical journal entries from the accounting-system
  // GL export. Each entry is either inserted (fresh reference) or
  // updated (reference already present — language column is overwritten,
  // lines are left untouched). Unlike `postJournal`, account balances
  // are NOT mutated — this importer is for historical records; the
  // canonical opening balance comes from the Chart-of-Accounts import.
  async importJournals(
    entityId: string,
    createdBy: string,
    status: "draft" | "approved" | "posted",
    language: "en" | "th",
    entries: Array<
      ImportJournalEntry & {
        entryNo: string;
        accountIdByCode: Map<string, string>;
        existingId: string | null;
      }
    >,
  ) {
    if (entries.length === 0) return { inserted: 0, updated: 0 };
    const now = new Date();
    const approvedAt = status === "draft" ? null : now;
    const postedAt = status === "posted" ? now : null;
    const approvedBy = status === "draft" ? null : createdBy;

    let inserted = 0;
    let updated = 0;
    const chunkSize = 50;
    for (let i = 0; i < entries.length; i += chunkSize) {
      const chunk = entries.slice(i, i + chunkSize);
      const ops = chunk.map((entry) => {
        const text = entry.description ?? null;
        const descriptionPatch =
          language === "th" ? { descriptionTh: text } : { description: text };
        if (entry.existingId) {
          // Reference already imported in the other language — patch
          // only the chosen language column. Don't touch lines /
          // status / created* so re-running an import stays idempotent.
          return prisma.journalEntry.update({
            where: { id: entry.existingId },
            data: descriptionPatch,
          });
        }
        return prisma.journalEntry.create({
          data: {
            entityId,
            entryNo: entry.entryNo,
            date: new Date(entry.date),
            description: language === "en" ? text : null,
            descriptionTh: language === "th" ? text : null,
            reference: entry.reference,
            status,
            sourceType: "import",
            createdBy,
            approvedBy,
            approvedAt,
            postedAt,
            lines: {
              createMany: {
                data: entry.lines.map((l) => ({
                  accountId: entry.accountIdByCode.get(l.accountCode)!,
                  debit: l.debit,
                  credit: l.credit,
                  memo: l.memo ?? null,
                })),
              },
            },
          },
        });
      });
      await prisma.$transaction(ops);
      inserted += chunk.filter((e) => !e.existingId).length;
      updated += chunk.filter((e) => e.existingId).length;
    }
    return { inserted, updated };
  }

  async findExhibitInvoices(filters: {
    startDate: Date;
    endDate: Date;
    entityId?: string;
  }) {
    return prisma.invoice.findMany({
      where: {
        deletedAt: null,
        issueDate: { gte: filters.startDate, lte: filters.endDate },
        ...(filters.entityId ? { entityId: filters.entityId } : {}),
      },
      select: {
        type: true,
        status: true,
        amount: true,
        vatRate: true,
        issueDate: true,
        lineItems: {
          select: {
            capitalised: true,
            glAccountId: true,
            taxBase: true,
            unitPrice: true,
            quantity: true,
            lineDiscount: true,
          },
        },
      },
    });
  }

  async getPnlRows(filters: {
    startDate: Date;
    endDate: Date;
    entityId?: string;
  }) {
    const grouped = await prisma.journalEntryLine.groupBy({
      by: ["accountId"],
      where: {
        entry: {
          status: { in: [...GL_LIVE_STATUSES] },
          deletedAt: null,
          date: { gte: filters.startDate, lte: filters.endDate },
          ...(filters.entityId ? { entityId: filters.entityId } : {}),
        },
        account: {
          type: { in: ["revenue", "expense"] },
          deletedAt: null,
        },
      },
      _sum: { debit: true, credit: true },
    });

    const accounts = await prisma.chartOfAccount.findMany({
      where: { id: { in: grouped.map((row) => row.accountId) } },
      select: {
        id: true,
        code: true,
        name: true,
        type: true,
        entity: {
          select: {
            id: true,
            name: true,
            code: true,
            currency: true,
          },
        },
      },
    });
    const accountById = new Map(
      accounts.map((account) => [account.id, account]),
    );

    return grouped.flatMap((row) => {
      const account = accountById.get(row.accountId);
      if (!account) return [];
      return [
        {
          accountId: account.id,
          accountCode: account.code,
          accountName: account.name,
          accountType: account.type,
          entityId: account.entity.id,
          entityName: account.entity.name,
          entityCode: account.entity.code,
          currency: account.entity.currency,
          debit: Number(row._sum.debit ?? 0),
          credit: Number(row._sum.credit ?? 0),
        },
      ];
    });
  }

  async getReviewSummary(entityId?: string) {
    const where: Prisma.JournalEntryWhereInput = {
      deletedAt: null,
      status: { in: ["draft", "rejected", "approved"] },
      ...(entityId ? { entityId } : {}),
    };
    const staleBefore = new Date();
    staleBefore.setDate(staleBefore.getDate() - 7);

    const [grouped, staleDrafts] = await Promise.all([
      prisma.journalEntry.groupBy({
        by: ["status"],
        where,
        _count: { _all: true },
      }),
      prisma.journalEntry.count({
        where: {
          ...where,
          status: "draft",
          createdAt: { lt: staleBefore },
        },
      }),
    ]);
    const counts = new Map(grouped.map((row) => [row.status, row._count._all]));
    return {
      draft: counts.get("draft") ?? 0,
      rejected: counts.get("rejected") ?? 0,
      approved: counts.get("approved") ?? 0,
      staleDrafts,
    };
  }

  async getReviewQueue(entityId?: string) {
    return prisma.journalEntry.findMany({
      where: {
        deletedAt: null,
        status: { in: ["draft", "rejected", "approved"] },
        ...(entityId ? { entityId } : {}),
      },
      include: journalIncludes,
      orderBy: { createdAt: "asc" },
      take: 12,
    });
  }

  async getOverdueInvoiceSummary(entityId?: string) {
    const where: Prisma.InvoiceWhereInput = {
      deletedAt: null,
      dueDate: { lt: new Date() },
      status: { notIn: ["paid", "cancelled"] },
      ...(entityId ? { entityId } : {}),
    };
    const [count, items] = await Promise.all([
      prisma.invoice.count({ where }),
      prisma.invoice.findMany({
        where,
        include: invoiceIncludes,
        orderBy: { dueDate: "asc" },
        take: 6,
      }),
    ]);
    return { count, items };
  }

  async getUnmatchedBankSummary(entityId?: string) {
    const where: Prisma.BankTransactionWhereInput = {
      status: "unmatched",
      ...(entityId ? { entityId } : {}),
    };
    const [count, items] = await Promise.all([
      prisma.bankTransaction.count({ where }),
      prisma.bankTransaction.findMany({
        where,
        include: {
          entity: {
            select: { id: true, name: true, code: true, currency: true },
          },
        },
        orderBy: { date: "asc" },
        take: 6,
      }),
    ]);
    return { count, items };
  }

  async findInvoices(
    filters: {
      entityId?: string;
      type?: string;
      status?: string;
      // Own-document scoping (Chunk 5): when set, restrict to this author.
      createdBy?: string;
      sortBy?:
        | "invoiceNo"
        | "type"
        | "counterparty"
        | "amount"
        | "issueDate"
        | "dueDate"
        | "status";
      sortOrder?: "asc" | "desc";
    },
    page: number,
    limit: number,
  ) {
    const where: Prisma.InvoiceWhereInput = {};
    if (filters.status === "deleted") {
      where.deletedAt = { not: null };
    } else if (filters.status) {
      where.deletedAt = null;
      where.status = filters.status;
    }
    if (filters.entityId) where.entityId = filters.entityId;
    if (filters.type) where.type = filters.type;
    if (filters.createdBy) where.createdBy = filters.createdBy;

    const dir = filters.sortOrder ?? "desc";
    const orderBy: Prisma.InvoiceOrderByWithRelationInput =
      filters.sortBy === "invoiceNo"
        ? { invoiceNo: dir }
        : filters.sortBy === "type"
          ? { type: dir }
          : filters.sortBy === "counterparty"
            ? { counterparty: dir }
            : filters.sortBy === "amount"
              ? { amount: dir }
              : filters.sortBy === "issueDate"
                ? { issueDate: dir }
                : filters.sortBy === "dueDate"
                  ? { dueDate: dir }
                  : filters.sortBy === "status"
                    ? { status: dir }
                    : { createdAt: "desc" };

    const [data, total] = await Promise.all([
      prisma.invoice.findMany({
        where,
        include: invoiceIncludes,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.invoice.count({ where }),
    ]);

    return { data, total };
  }

  // Open AR/AP documents for aging (M11 dashboard): only the still-collectible
  // statuses, one entity + side. Slim select — just what the bucket roll-up
  // needs (due date + outstanding + the send-time FX rate for base conversion).
  async findOpenInvoicesForAging(filters: {
    entityId: string;
    type: "receivable" | "payable";
    createdBy?: string;
  }) {
    return prisma.invoice.findMany({
      where: {
        entityId: filters.entityId,
        type: filters.type,
        deletedAt: null,
        status: { in: ["sent", "partial", "overdue"] },
        ...(filters.createdBy ? { createdBy: filters.createdBy } : {}),
      },
      select: {
        dueDate: true,
        amount: true,
        amountPaid: true,
        currency: true,
        exchangeRate: true,
      },
    });
  }

  // Open (settleable) AR + AP documents for one entity, with the identity
  // fields the bank matcher needs. Both sides in one query — the matcher picks
  // the side per bank-line direction.
  async findOpenInvoicesForMatching(entityId: string) {
    return prisma.invoice.findMany({
      where: {
        entityId,
        deletedAt: null,
        status: { in: ["sent", "partial", "overdue"] },
      },
      select: {
        id: true,
        invoiceNo: true,
        type: true,
        counterparty: true,
        amount: true,
        amountPaid: true,
        dueDate: true,
        currency: true,
      },
      orderBy: { dueDate: "asc" },
    });
  }

  // Recorded (non-draft/cancelled) payable bills in a period, with the line
  // fields needed to derive net spend + category account. Feeds the Expense
  // workspace summary.
  async findPayableBillsForSummary(entityId: string, from: Date, to: Date) {
    return prisma.invoice.findMany({
      where: {
        entityId,
        type: "payable",
        deletedAt: null,
        status: { in: ["sent", "partial", "paid", "overdue"] },
        issueDate: { gte: from, lte: to },
      },
      select: {
        id: true,
        lineItems: {
          select: { quantity: true, unitPrice: true, glAccountId: true },
        },
      },
    });
  }

  async findAccountsByIds(ids: string[]) {
    return prisma.chartOfAccount.findMany({
      where: { id: { in: ids } },
      select: { id: true, code: true, name: true },
    });
  }

  // ── Global accounting search (header omnibox) ────────────────────────────
  // Each finder mirrors its entity's existing list scoping: invoices + payments
  // are owner-scoped via createdBy (unless the caller holds read-all), while
  // journals / accounts / bank lines are not (matching their list routes).
  // Soft-delete is filtered where the model has it (BankTransaction has none).
  // Text via case-insensitive `contains`; a numeric term also matches `amount`.

  async searchInvoices(
    term: string,
    opts: { entityId?: string; createdBy?: string; amount?: number },
    limit: number,
  ) {
    const or: Prisma.InvoiceWhereInput[] = [
      { invoiceNo: { contains: term, mode: "insensitive" } },
      { counterparty: { contains: term, mode: "insensitive" } },
      { reference: { contains: term, mode: "insensitive" } },
      { notes: { contains: term, mode: "insensitive" } },
    ];
    if (opts.amount != null) or.push({ amount: { equals: opts.amount } });
    return prisma.invoice.findMany({
      where: {
        deletedAt: null,
        ...(opts.entityId ? { entityId: opts.entityId } : {}),
        ...(opts.createdBy ? { createdBy: opts.createdBy } : {}),
        OR: or,
      },
      select: {
        id: true,
        invoiceNo: true,
        type: true,
        counterparty: true,
        amount: true,
        currency: true,
        status: true,
        issueDate: true,
      },
      orderBy: { issueDate: "desc" },
      take: limit,
    });
  }

  async searchJournals(
    term: string,
    opts: { entityId?: string },
    limit: number,
  ) {
    return prisma.journalEntry.findMany({
      where: {
        deletedAt: null,
        ...(opts.entityId ? { entityId: opts.entityId } : {}),
        // Header + Thai memo only. The per-line memo (lines.some.memo) is
        // deliberately excluded: as an OR branch it forces a correlated EXISTS
        // over journal_entry_lines (the largest accounting table) on every
        // scanned row — too costly for an omnibox. Reference/description cover
        // the common lookup.
        OR: [
          { reference: { contains: term, mode: "insensitive" } },
          { description: { contains: term, mode: "insensitive" } },
          { descriptionTh: { contains: term, mode: "insensitive" } },
        ],
      },
      select: {
        id: true,
        reference: true,
        description: true,
        date: true,
        status: true,
      },
      orderBy: { date: "desc" },
      take: limit,
    });
  }

  async searchAccounts(
    term: string,
    opts: { entityId?: string },
    limit: number,
  ) {
    return prisma.chartOfAccount.findMany({
      where: {
        deletedAt: null,
        ...(opts.entityId ? { entityId: opts.entityId } : {}),
        OR: [
          { code: { contains: term, mode: "insensitive" } },
          { name: { contains: term, mode: "insensitive" } },
          { nameTh: { contains: term, mode: "insensitive" } },
        ],
      },
      select: { id: true, code: true, name: true, type: true },
      orderBy: { code: "asc" },
      take: limit,
    });
  }

  async searchBankTransactions(
    term: string,
    opts: { entityId?: string; amount?: number },
    limit: number,
  ) {
    const or: Prisma.BankTransactionWhereInput[] = [
      { description: { contains: term, mode: "insensitive" } },
      { reference: { contains: term, mode: "insensitive" } },
    ];
    if (opts.amount != null) or.push({ amount: { equals: opts.amount } });
    return prisma.bankTransaction.findMany({
      where: {
        ...(opts.entityId ? { entityId: opts.entityId } : {}),
        OR: or,
      },
      select: {
        id: true,
        description: true,
        amount: true,
        date: true,
        status: true,
        entity: { select: { name: true } },
      },
      orderBy: { date: "desc" },
      take: limit,
    });
  }

  async searchPayments(
    term: string,
    opts: { entityId?: string; createdBy?: string; amount?: number },
    limit: number,
  ) {
    const or: Prisma.PaymentWhereInput[] = [
      { reference: { contains: term, mode: "insensitive" } },
      { method: { contains: term, mode: "insensitive" } },
    ];
    if (opts.amount != null) or.push({ amount: { equals: opts.amount } });
    return prisma.payment.findMany({
      where: {
        deletedAt: null,
        ...(opts.entityId ? { entityId: opts.entityId } : {}),
        // Payments inherit their invoice's RBAC — scope through the parent so a
        // non-read-all caller only sees payments on their own documents, and
        // never a payment whose invoice was soft-deleted.
        invoice: {
          deletedAt: null,
          ...(opts.createdBy ? { createdBy: opts.createdBy } : {}),
        },
        OR: or,
      },
      select: {
        id: true,
        amount: true,
        method: true,
        reference: true,
        date: true,
        invoice: {
          select: { id: true, invoiceNo: true, counterparty: true, type: true },
        },
      },
      orderBy: { date: "desc" },
      take: limit,
    });
  }

  // Imported bank lines not yet matched/reconciled — the matcher's input set.
  async findUnmatchedBankTransactions(entityId: string) {
    return prisma.bankTransaction.findMany({
      where: { entityId, status: "unmatched", reconciled: false },
      select: {
        id: true,
        date: true,
        amount: true,
        direction: true,
        description: true,
        bankAccountId: true,
      },
      orderBy: { date: "asc" },
    });
  }

  // Non-draft AR/AP documents for one counterparty — the statement-of-account
  // source (M1). Owner-scoped via createdBy for non-read-all callers.
  async findInvoicesForStatement(filters: {
    entityId: string;
    counterparty: string;
    type: "receivable" | "payable";
    createdBy?: string;
  }) {
    return prisma.invoice.findMany({
      where: {
        entityId: filters.entityId,
        counterparty: filters.counterparty,
        type: filters.type,
        deletedAt: null,
        status: { notIn: ["draft", "cancelled"] },
        ...(filters.createdBy ? { createdBy: filters.createdBy } : {}),
      },
      select: {
        invoiceNo: true,
        issueDate: true,
        dueDate: true,
        amount: true,
        amountPaid: true,
        currency: true,
      },
      orderBy: { issueDate: "asc" },
    });
  }

  async findInvoiceByEntityAndNo(entityId: string, invoiceNo: string) {
    return prisma.invoice.findUnique({
      where: { entityId_invoiceNo: { entityId, invoiceNo }, deletedAt: null },
    });
  }

  async createInvoice(data: {
    entityId: string;
    invoiceNo: string;
    type: string;
    counterparty: string;
    billToAddress?: string | null;
    reference?: string | null;
    paymentTerms?: string | null;
    amount: number;
    currency: string;
    exchangeRate?: number;
    baseAmount?: number;
    carryingRate?: number;
    vatRate: number;
    taxLabel?: string | null;
    taxRate: number;
    whtRate: number;
    headerDiscount?: number;
    roundingAmount?: number;
    draftNo?: string | null;
    vendorId?: string | null;
    vendorTaxInvoiceNo?: string | null;
    taxInvoiceReceived?: boolean;
    fxSide?: string | null;
    fxRateDate?: Date | null;
    issueDate: Date;
    dueDate: Date;
    linkedJeId?: string | null;
    notes?: string | null;
    createdBy?: string | null;
    lineItems: {
      description: string;
      quantity: number;
      unitPrice: number;
      sortOrder: number;
      glAccountId?: string | null;
      lineDiscount?: number;
      vatRate?: number | null;
      vatReason?: string | null;
      taxBase?: number | null;
      vatAmount?: number | null;
      capitalised?: boolean;
    }[];
  }) {
    return prisma.invoice.create({
      data: {
        entityId: data.entityId,
        invoiceNo: data.invoiceNo,
        type: data.type,
        counterparty: data.counterparty,
        billToAddress: data.billToAddress ?? null,
        reference: data.reference ?? null,
        paymentTerms: data.paymentTerms ?? null,
        amount: data.amount,
        currency: data.currency,
        exchangeRate: data.exchangeRate ?? 1,
        baseAmount: data.baseAmount ?? data.amount,
        carryingRate: data.carryingRate ?? data.exchangeRate ?? 1,
        vatRate: data.vatRate,
        taxLabel: data.taxLabel ?? null,
        taxRate: data.taxRate,
        whtRate: data.whtRate,
        headerDiscount: data.headerDiscount ?? 0,
        roundingAmount: data.roundingAmount ?? 0,
        draftNo: data.draftNo ?? null,
        vendorId: data.vendorId ?? null,
        vendorTaxInvoiceNo: data.vendorTaxInvoiceNo ?? null,
        taxInvoiceReceived: data.taxInvoiceReceived ?? false,
        fxSide: data.fxSide ?? null,
        fxRateDate: data.fxRateDate ?? null,
        issueDate: data.issueDate,
        dueDate: data.dueDate,
        linkedJeId: data.linkedJeId ?? null,
        notes: data.notes ?? null,
        createdBy: data.createdBy ?? null,
        lineItems: {
          create: data.lineItems.map((li) => ({
            description: li.description,
            quantity: li.quantity,
            unitPrice: li.unitPrice,
            sortOrder: li.sortOrder,
            glAccountId: li.glAccountId ?? null,
            lineDiscount: li.lineDiscount ?? 0,
            vatRate: li.vatRate ?? null,
            vatReason: li.vatReason ?? null,
            taxBase: li.taxBase ?? null,
            vatAmount: li.vatAmount ?? null,
            capitalised: li.capitalised === true,
          })),
        },
      },
      include: invoiceIncludes,
    });
  }

  async findInvoiceById(id: string) {
    return prisma.invoice.findUnique({
      where: { id, deletedAt: null },
      include: invoiceIncludes,
    });
  }

  // Fetches an invoice regardless of soft-delete state. ONLY for the restore
  // path — every other read must go through `findInvoiceById`, which excludes
  // deleted rows.
  async findInvoiceByIdIncludingDeleted(id: string) {
    return prisma.invoice.findUnique({
      where: { id },
      include: invoiceIncludes,
    });
  }

  async updateInvoice(
    id: string,
    data: Prisma.InvoiceUncheckedUpdateInput,
    lineItems?: {
      description: string;
      quantity: number;
      unitPrice: number;
      sortOrder: number;
      glAccountId?: string | null;
      lineDiscount?: number;
      vatRate?: number | null;
      vatReason?: string | null;
      taxBase?: number | null;
      vatAmount?: number | null;
      capitalised?: boolean;
    }[],
  ) {
    // When line items are supplied, replace the whole set atomically alongside
    // the header update so the persisted total can't drift from the lines.
    if (lineItems) {
      return prisma.$transaction(async (tx) => {
        await tx.invoiceLineItem.deleteMany({ where: { invoiceId: id } });
        if (lineItems.length > 0) {
          await tx.invoiceLineItem.createMany({
            data: lineItems.map((li) => ({ ...li, invoiceId: id })),
          });
        }
        return tx.invoice.update({
          where: { id },
          data,
          include: invoiceIncludes,
        });
      });
    }
    return prisma.invoice.update({
      where: { id },
      data,
      include: invoiceIncludes,
    });
  }

  async softDeleteInvoice(id: string, deletedBy?: string) {
    return prisma.invoice.update({
      where: { id },
      data: { ...softDeleteUpdate(), deletedBy: deletedBy ?? null },
      include: invoiceIncludes,
    });
  }

  async findActiveLinkedUploads(linkedTo: string, linkedId: string) {
    return prisma.fileUpload.findMany({
      where: { linkedTo, linkedId, deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        originalName: true,
        mimeType: true,
        size: true,
        createdAt: true,
      },
    });
  }

  async restoreInvoice(id: string) {
    return prisma.invoice.update({
      where: { id },
      data: restoreUpdate(),
      include: invoiceIncludes,
    });
  }

  async permanentDeleteInvoice(id: string) {
    return prisma.invoice.delete({ where: { id } });
  }

  async findBankTransactions(
    filters: {
      entityId?: string;
      status?: string;
      startDate?: string;
      endDate?: string;
      sortBy?: "date" | "description" | "entity" | "amount" | "status";
      sortOrder?: "asc" | "desc";
    },
    page: number,
    limit: number,
  ) {
    const where: Prisma.BankTransactionWhereInput = {};
    if (filters.entityId) where.entityId = filters.entityId;
    if (filters.status) where.status = filters.status;
    if (filters.startDate || filters.endDate) {
      where.date = {};
      if (filters.startDate) where.date.gte = new Date(filters.startDate);
      if (filters.endDate) where.date.lte = new Date(filters.endDate);
    }

    const dir = filters.sortOrder ?? "desc";
    const orderBy: Prisma.BankTransactionOrderByWithRelationInput =
      filters.sortBy === "description"
        ? { description: dir }
        : filters.sortBy === "entity"
          ? { entity: { name: dir } }
          : filters.sortBy === "amount"
            ? { amount: dir }
            : filters.sortBy === "status"
              ? { status: dir }
              : { date: dir };

    const [data, total] = await Promise.all([
      prisma.bankTransaction.findMany({
        where,
        include: {
          entity: { select: { id: true, name: true } },
          suggested: { select: { id: true, code: true, name: true } },
          mapped: { select: { id: true, code: true, name: true } },
        },
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.bankTransaction.count({ where }),
    ]);

    return { data, total };
  }

  async importBankTransactions(
    entityId: string,
    rows: ImportBankStatementInput["transactions"],
  ) {
    return prisma.bankTransaction.createMany({
      data: rows.map((row) => ({
        entityId,
        date: new Date(row.date),
        description: row.description,
        amount: row.amount,
        balance: row.balance,
        reference: row.reference,
        bankAccount: row.bankAccount,
      })),
    });
  }

  // ── Bank reconciliation (M7) ─────────────────────────────────────────────

  async findBankTransactionById(id: string) {
    return prisma.bankTransaction.findUnique({
      where: { id },
      include: {
        entity: { select: { id: true, name: true } },
        suggested: { select: { id: true, code: true, name: true } },
        mapped: { select: { id: true, code: true, name: true } },
      },
    });
  }

  async setBankTransactionReconciled(
    id: string,
    data: {
      reconciled: boolean;
      status: string;
      reconciledAt: Date | null;
      mappedAccountId?: string;
    },
  ) {
    return prisma.bankTransaction.update({
      where: { id },
      data: {
        reconciled: data.reconciled,
        status: data.status,
        reconciledAt: data.reconciledAt,
        ...(data.mappedAccountId
          ? { mappedAccount: data.mappedAccountId }
          : {}),
      },
      include: {
        entity: { select: { id: true, name: true } },
        suggested: { select: { id: true, code: true, name: true } },
        mapped: { select: { id: true, code: true, name: true } },
      },
    });
  }

  // Signed movement rows for the reconciliation summary / closing-figure check.
  async findBankTransactionsForReconciliation(filters: {
    entityId: string;
    asOf?: Date;
  }) {
    return prisma.bankTransaction.findMany({
      where: {
        entityId: filters.entityId,
        ...(filters.asOf ? { date: { lte: filters.asOf } } : {}),
      },
      select: { amount: true, direction: true, reconciled: true },
    });
  }

  // ── Bank accounts (master) ───────────────────────────────────────────────

  async findBankAccounts(filters: {
    entityId?: string;
    includeInactive?: boolean;
  }) {
    return prisma.bankAccount.findMany({
      where: {
        deletedAt: null,
        ...(filters.entityId ? { entityId: filters.entityId } : {}),
        ...(filters.includeInactive ? {} : { isActive: true }),
      },
      include: {
        entity: { select: { id: true, name: true } },
        glAccount: { select: { id: true, code: true, name: true } },
      },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    });
  }

  async findBankAccountById(id: string) {
    return prisma.bankAccount.findFirst({
      where: { id, deletedAt: null },
      include: {
        entity: { select: { id: true, name: true } },
        glAccount: { select: { id: true, code: true, name: true } },
      },
    });
  }

  async createBankAccount(data: CreateBankAccountInput) {
    // Opening balance seeds the running balance; from here on only the cash
    // primitive (postMoneyEvent) moves currentBalance.
    return prisma.bankAccount.create({
      data: {
        entityId: data.entityId,
        name: data.name,
        kind: data.kind,
        accountNumber: data.accountNumber ?? null,
        currency: data.currency,
        openingBalance: data.openingBalance,
        currentBalance: data.openingBalance,
        glAccountId: data.glAccountId ?? null,
        sortOrder: data.sortOrder ?? 0,
      },
      include: { glAccount: { select: { id: true, code: true, name: true } } },
    });
  }

  // openingBalance is intentionally NOT updatable — changing it would desync
  // currentBalance from the ledger. Set it once at creation.
  async updateBankAccount(id: string, data: UpdateBankAccountInput) {
    return prisma.bankAccount.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.kind !== undefined && { kind: data.kind }),
        ...(data.accountNumber !== undefined && {
          accountNumber: data.accountNumber || null,
        }),
        ...(data.currency !== undefined && { currency: data.currency }),
        ...(data.glAccountId !== undefined && {
          glAccountId: data.glAccountId || null,
        }),
        ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
      },
      include: { glAccount: { select: { id: true, code: true, name: true } } },
    });
  }

  // Count rows that would be orphaned by a hard delete, so the service can
  // block it and offer deactivate instead.
  async countBankAccountUsage(id: string): Promise<number> {
    const [txns, payments] = await Promise.all([
      prisma.bankTransaction.count({ where: { bankAccountId: id } }),
      prisma.payment.count({ where: { bankAccountId: id, deletedAt: null } }),
    ]);
    return txns + payments;
  }

  async softDeleteBankAccount(id: string) {
    return prisma.bankAccount.update({
      where: { id },
      data: softDeleteUpdate(),
    });
  }

  // ── Payments ─────────────────────────────────────────────────────────────

  async findPaymentById(id: string) {
    return prisma.payment.findFirst({
      where: { id, deletedAt: null },
      include: {
        invoice: { include: invoiceIncludes },
        bankAccount: {
          select: { id: true, name: true, glAccountId: true },
        },
      },
    });
  }

  // Payment + its invoice + the supplier vendor block — for the WHT certificate
  // (Form 50 Bis). findPaymentById's include omits the vendor.
  async findPaymentForWhtCertificate(id: string) {
    return prisma.payment.findFirst({
      where: { id, deletedAt: null },
      include: {
        invoice: {
          include: {
            vendor: {
              select: {
                name: true,
                taxId: true,
                addressEn: true,
                branch: true,
              },
            },
          },
        },
      },
    });
  }

  async findPaymentsForInvoice(invoiceId: string) {
    return prisma.payment.findMany({
      where: { invoiceId, deletedAt: null },
      orderBy: { date: "asc" },
      include: {
        bankAccount: { select: { id: true, name: true } },
      },
    });
  }

  async findPayments(
    filters: { entityId?: string; type?: string; createdBy?: string },
    page: number,
    limit: number,
  ) {
    const where: Prisma.PaymentWhereInput = {
      deletedAt: null,
      ...(filters.entityId ? { entityId: filters.entityId } : {}),
      invoice: {
        deletedAt: null,
        ...(filters.type ? { type: filters.type } : {}),
        ...(filters.createdBy ? { createdBy: filters.createdBy } : {}),
      },
    };
    const [data, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        orderBy: [{ date: "desc" }, { createdAt: "desc" }],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          invoice: {
            select: {
              id: true,
              invoiceNo: true,
              counterparty: true,
              currency: true,
              type: true,
              vendorTaxInvoiceNo: true,
              createdBy: true,
            },
          },
          bankAccount: { select: { id: true, name: true } },
        },
      }),
      prisma.payment.count({ where }),
    ]);
    return { data, total };
  }

  // ── Reporting: posted-line activity ──────────────────────────────────────

  // Per-account Σdebit / Σcredit over POSTED journal lines in a window. `to`
  // with no `from` = as-of (cumulative). Every statement is built from this.
  async getAccountActivity(filters: {
    entityId?: string;
    from?: Date;
    to?: Date;
    types?: string[];
  }) {
    const dateFilter =
      filters.from || filters.to
        ? {
            date: {
              ...(filters.from ? { gte: filters.from } : {}),
              ...(filters.to ? { lte: filters.to } : {}),
            },
          }
        : {};
    const grouped = await prisma.journalEntryLine.groupBy({
      by: ["accountId"],
      where: {
        entry: {
          status: { in: [...GL_LIVE_STATUSES] },
          deletedAt: null,
          ...dateFilter,
          ...(filters.entityId ? { entityId: filters.entityId } : {}),
        },
        account: {
          deletedAt: null,
          ...(filters.types ? { type: { in: filters.types } } : {}),
        },
      },
      _sum: { debit: true, credit: true },
    });

    const accounts = await prisma.chartOfAccount.findMany({
      where: { id: { in: grouped.map((r) => r.accountId) } },
      select: {
        id: true,
        code: true,
        name: true,
        type: true,
        subType: true,
        entityId: true,
      },
    });
    const byId = new Map(accounts.map((a) => [a.id, a]));

    return grouped.flatMap((row) => {
      const account = byId.get(row.accountId);
      if (!account) return [];
      return [
        {
          accountId: account.id,
          code: account.code,
          name: account.name,
          type: account.type,
          subType: account.subType,
          entityId: account.entityId,
          debit: Number(row._sum.debit ?? 0),
          credit: Number(row._sum.credit ?? 0),
        },
      ];
    });
  }

  // GL account ids that back the entity's bank accounts — the "cash" set for
  // the cash-flow statement.
  async getCashAccountIds(entityId?: string): Promise<string[]> {
    const rows = await prisma.bankAccount.findMany({
      where: {
        deletedAt: null,
        glAccountId: { not: null },
        ...(entityId ? { entityId } : {}),
      },
      select: { glAccountId: true },
    });
    return [
      ...new Set(
        rows
          .map((r) => r.glAccountId)
          .filter((id): id is string => id !== null),
      ),
    ];
  }

  // ── Fiscal periods ────────────────────────────────────────────────────────

  async findFiscalPeriods(entityId?: string) {
    return prisma.fiscalPeriod.findMany({
      where: entityId ? { entityId } : {},
      orderBy: [{ year: "desc" }, { month: "desc" }],
    });
  }

  // Open AR/AP as of a date — the monetary items a period-end FX revaluation
  // retranslates. The foreign-currency filter (currency vs the entity base,
  // case-insensitive) is applied by the caller.
  async findOpenInvoicesForRevaluation(entityId: string, asOf: Date) {
    return prisma.invoice.findMany({
      where: {
        entityId,
        deletedAt: null,
        status: { in: ["sent", "partial", "overdue"] },
        issueDate: { lte: asOf },
      },
      select: {
        id: true,
        invoiceNo: true,
        type: true,
        currency: true,
        amount: true,
        amountPaid: true,
        exchangeRate: true,
        carryingRate: true,
        issueDate: true,
      },
    });
  }

  // Bank accounts with their GL carrying balance — for period-end revaluation
  // of foreign-currency cash. The foreign filter (currency vs base) is applied
  // by the caller.
  async findBankAccountsForRevaluation(entityId: string) {
    return prisma.bankAccount.findMany({
      where: {
        entityId,
        deletedAt: null,
        isActive: true,
        glAccountId: { not: null },
      },
      select: {
        id: true,
        name: true,
        currency: true,
        currentBalance: true,
        glAccountId: true,
        glAccount: { select: { id: true, balance: true } },
      },
    });
  }

  // AR/AP tax documents issued in a window — the source rows for the output/
  // input VAT registers (M9). Draft documents are excluded (no tax invoice
  // issued yet); line items drive the exact net value, the vendor supplies the
  // tax-id / branch / business-type for the RD forms.
  async findTaxDocuments(
    entityId: string,
    type: "receivable" | "payable",
    from: Date,
    to: Date,
  ) {
    return prisma.invoice.findMany({
      where: {
        entityId,
        type,
        deletedAt: null,
        // Only issued tax invoices count: drafts aren't issued yet, cancelled
        // ones carry no VAT.
        status: { notIn: ["draft", "cancelled"] },
        issueDate: { gte: from, lte: to },
      },
      select: {
        id: true,
        invoiceNo: true,
        counterparty: true,
        currency: true,
        exchangeRate: true,
        amount: true,
        vatRate: true,
        taxRate: true,
        whtRate: true,
        issueDate: true,
        lineItems: { select: { quantity: true, unitPrice: true } },
        vendor: {
          select: {
            taxId: true,
            branch: true,
            branchCode: true,
            businessType: true,
            contactType: true,
          },
        },
      },
      orderBy: [{ issueDate: "asc" }, { invoiceNo: "asc" }],
    });
  }

  // Supplier payments that withheld tax in a window — the source rows for the
  // PND.3 / PND.53 returns (M9). Only payments against payable invoices carry a
  // withholding obligation we file; the invoice's whtRate backs out the income
  // base and the vendor's business type routes the payee to PND.3 vs PND.53.
  async findWhtPayments(entityId: string, from: Date, to: Date) {
    return prisma.payment.findMany({
      where: {
        entityId,
        deletedAt: null,
        whtAmount: { gt: 0 },
        date: { gte: from, lte: to },
        invoice: { type: "payable" },
      },
      select: {
        id: true,
        date: true,
        whtAmount: true,
        currency: true,
        exchangeRate: true,
        invoice: {
          select: {
            counterparty: true,
            whtRate: true,
            vendor: {
              select: {
                id: true,
                taxId: true,
                businessType: true,
                contactType: true,
              },
            },
          },
        },
      },
      orderBy: { date: "asc" },
    });
  }

  // The posted FX-revaluation entry for a period, if any (idempotency guard).
  /**
   * The posted journal entry for a fixed-asset run in a period, if any. Same
   * (sourceType, sourceRef) idempotency shape as FX revaluation — the index on
   * [sourceType, sourceRef] makes this cheap.
   */
  async findFixedAssetPostingEntry(
    entityId: string,
    sourceType: string,
    periodKey: string,
  ) {
    return prisma.journalEntry.findFirst({
      where: { entityId, sourceType, sourceRef: periodKey, deletedAt: null },
      select: { id: true, entryNo: true, postedAt: true },
    });
  }

  /** Every non-deleted asset for an entity, with the fields the engine needs. */
  async findFixedAssetsForPosting(entityId: string) {
    return prisma.fixedAsset.findMany({
      where: { entityId, deletedAt: null },
      select: {
        id: true,
        assetNo: true,
        name: true,
        categoryCode: true,
        quantity: true,
        purchasePrice: true,
        purchaseDate: true,
        startDate: true,
        usefulLifeMonths: true,
        openingBookValue: true,
        openingAsOfDate: true,
        status: true,
        disposalDate: true,
      },
      orderBy: { assetNo: "asc" },
    });
  }

  async findRevaluationEntry(entityId: string, periodKey: string) {
    return prisma.journalEntry.findFirst({
      where: {
        entityId,
        sourceType: "fx-revaluation",
        sourceRef: periodKey,
        deletedAt: null,
      },
      select: { id: true, entryNo: true },
    });
  }

  async upsertFiscalPeriod(data: {
    entityId: string;
    year: number;
    month: number;
    status: string;
    closedBy?: string | null;
    note?: string | null;
  }) {
    return prisma.fiscalPeriod.upsert({
      where: {
        entityId_year_month: {
          entityId: data.entityId,
          year: data.year,
          month: data.month,
        },
      },
      create: {
        entityId: data.entityId,
        year: data.year,
        month: data.month,
        status: data.status,
        closedBy: data.closedBy ?? null,
        note: data.note ?? null,
      },
      update: {
        status: data.status,
        closedBy: data.closedBy ?? null,
        note: data.note ?? null,
      },
    });
  }

  // ── Tax filings + tax-month lock (M9) ─────────────────────────────────────

  // The filing row for a tax month, if any — drives the lock check.
  async findTaxFiling(
    entityId: string,
    filingType: string,
    year: number,
    month: number,
  ) {
    return prisma.taxFiling.findUnique({
      where: {
        entityId_filingType_year_month: { entityId, filingType, year, month },
      },
    });
  }

  async findTaxFilings(filters: {
    entityId: string;
    filingType?: string;
    year?: number;
  }) {
    return prisma.taxFiling.findMany({
      where: {
        entityId: filters.entityId,
        ...(filters.filingType ? { filingType: filters.filingType } : {}),
        ...(filters.year !== undefined ? { year: filters.year } : {}),
      },
      orderBy: [{ year: "desc" }, { month: "desc" }],
    });
  }

  // `filedBy` is required (a real user uuid): a file passes the actor; a reopen
  // passes the EXISTING row's filer to preserve it. So the NOT-NULL `filed_by`
  // column never sees a placeholder. `filedAt` is written only when the caller
  // supplies it (a file/re-file), so a reopen leaves the original stamp intact.
  async upsertTaxFiling(data: {
    entityId: string;
    filingType: string;
    year: number;
    month: number;
    status: string;
    filedBy: string;
    snapshot?: Prisma.InputJsonValue;
    notes?: string | null;
    filedAt?: Date;
    reopenedBy?: string | null;
    reopenedAt?: Date | null;
  }) {
    return prisma.taxFiling.upsert({
      where: {
        entityId_filingType_year_month: {
          entityId: data.entityId,
          filingType: data.filingType,
          year: data.year,
          month: data.month,
        },
      },
      create: {
        entityId: data.entityId,
        filingType: data.filingType,
        year: data.year,
        month: data.month,
        status: data.status,
        filedBy: data.filedBy,
        ...(data.snapshot !== undefined ? { snapshot: data.snapshot } : {}),
        ...(data.filedAt !== undefined ? { filedAt: data.filedAt } : {}),
        notes: data.notes ?? null,
        ...(data.reopenedBy != null ? { reopenedBy: data.reopenedBy } : {}),
        ...(data.reopenedAt != null ? { reopenedAt: data.reopenedAt } : {}),
      },
      update: {
        status: data.status,
        filedBy: data.filedBy,
        ...(data.snapshot !== undefined ? { snapshot: data.snapshot } : {}),
        ...(data.filedAt !== undefined ? { filedAt: data.filedAt } : {}),
        ...(data.notes !== undefined ? { notes: data.notes } : {}),
        ...(data.reopenedBy !== undefined
          ? { reopenedBy: data.reopenedBy }
          : {}),
        ...(data.reopenedAt !== undefined
          ? { reopenedAt: data.reopenedAt }
          : {}),
      },
    });
  }

  // ── Accounting audit log (M12) ────────────────────────────────────────────

  // The audit-log resources the accounting module writes (see the logAudit
  // calls in accounting.controller.ts). The viewer is restricted to these so it
  // can never surface another module's audit rows.
  static readonly ACCOUNTING_AUDIT_RESOURCES = [
    "account_mapping",
    "company_setup",
    "accounting_opening_balances",
    "accounting_maker_checker",
    "tax_code",
    "journal_entry",
    "invoice",
    "payment",
    "bank_account",
    "quote",
    "credit_note",
    "purchase_order",
    "fiscal_period",
    "fixed_asset",
    "fixed_asset_category",
    "fixed_asset_disposal",
  ];

  async findAccountingAuditLogs(filters: {
    resource?: string;
    action?: string;
    startDate?: Date;
    endDate?: Date;
    limit: number;
  }) {
    const allowed = AccountingRepository.ACCOUNTING_AUDIT_RESOURCES;
    // A caller-supplied resource is honoured only if it's an accounting one;
    // anything else falls back to the full accounting allow-list.
    const resourceWhere =
      filters.resource && allowed.includes(filters.resource)
        ? filters.resource
        : { in: allowed };
    return prisma.auditLog.findMany({
      where: {
        resource: resourceWhere,
        ...(filters.action ? { action: filters.action } : {}),
        ...(filters.startDate || filters.endDate
          ? {
              timestamp: {
                ...(filters.startDate ? { gte: filters.startDate } : {}),
                ...(filters.endDate ? { lte: filters.endDate } : {}),
              },
            }
          : {}),
      },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { timestamp: "desc" },
      take: filters.limit,
    });
  }

  // ── Customer advances (M3) ────────────────────────────────────────────────

  async findCustomerAdvances(filters: {
    entityId: string;
    counterparty?: string;
    status?: string;
    createdBy?: string;
  }) {
    return prisma.customerAdvance.findMany({
      where: {
        entityId: filters.entityId,
        ...(filters.counterparty ? { counterparty: filters.counterparty } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.createdBy ? { createdBy: filters.createdBy } : {}),
        // AP overpay reuses this table with notes="vendor-advance". Keep the
        // AR list/apply path customer-only so vendor advances cannot settle AR.
        NOT: { notes: "vendor-advance" },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async findCustomerAdvanceById(id: string) {
    return prisma.customerAdvance.findUnique({ where: { id } });
  }

  // The advance a capture receipt produced, if any — lets voidPayment detect an
  // overpayment-capture receipt and refuse to void it (which would leave the
  // advance dangling and the GL half-reversed).
  async findCustomerAdvanceBySourcePayment(paymentId: string) {
    return prisma.customerAdvance.findFirst({
      where: { sourcePaymentId: paymentId },
    });
  }

  // ── Credit notes ──────────────────────────────────────────────────────────

  async findCreditNotes(filters: {
    entityId?: string;
    type?: string;
    noteKind?: string;
    status?: string;
  }) {
    return prisma.creditNote.findMany({
      where: {
        deletedAt: null,
        ...(filters.entityId ? { entityId: filters.entityId } : {}),
        ...(filters.type ? { type: filters.type } : {}),
        ...(filters.noteKind ? { noteKind: filters.noteKind } : {}),
        ...(filters.status ? { status: filters.status } : {}),
      },
      include: {
        entity: { select: { id: true, name: true } },
        lines: { orderBy: { sortOrder: "asc" } },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async findCreditNoteById(id: string) {
    return prisma.creditNote.findFirst({
      where: { id, deletedAt: null },
      include: {
        entity: { select: { id: true, name: true } },
        lines: { orderBy: { sortOrder: "asc" } },
        linkedInvoice: { select: { id: true, invoiceNo: true } },
      },
    });
  }

  // ── Suppliers (open-balance summary) ──────────────────────────────────────

  // Open payable balance per supplier — Σ(amount − amountPaid) over their
  // outstanding payable invoices. Server-side aggregate over the FULL set (never
  // a client page-reduce — see the paginated-aggregates pitfall).
  async getSupplierOpenBalances(entityId?: string) {
    const grouped = await prisma.invoice.groupBy({
      by: ["vendorId"],
      where: {
        type: "payable",
        deletedAt: null,
        status: { in: ["sent", "partial", "overdue"] },
        vendorId: { not: null },
        ...(entityId ? { entityId } : {}),
      },
      _sum: { amount: true, amountPaid: true },
    });
    const vendorIds = grouped
      .map((g) => g.vendorId)
      .filter((id): id is string => id !== null);
    const vendors = await prisma.vendor.findMany({
      where: { id: { in: vendorIds }, deletedAt: null },
      select: { id: true, name: true, creditDays: true, email: true },
    });
    const byId = new Map(vendors.map((v) => [v.id, v]));
    return grouped.flatMap((g) => {
      const vendor = g.vendorId ? byId.get(g.vendorId) : undefined;
      if (!vendor) return [];
      return [
        {
          id: vendor.id,
          name: vendor.name,
          creditDays: vendor.creditDays,
          email: vendor.email,
          openBalance:
            Number(g._sum.amount ?? 0) - Number(g._sum.amountPaid ?? 0),
        },
      ];
    });
  }

  async countSuppliers(entityId?: string): Promise<number> {
    return prisma.vendor.count({
      where: {
        isActive: true,
        deletedAt: null,
        ...(entityId ? { entityId } : {}),
      },
    });
  }

  // ── Quotes ────────────────────────────────────────────────────────────────

  async findQuotes(filters: { entityId?: string; status?: string; createdBy?: string }) {
    return prisma.quote.findMany({
      where: {
        deletedAt: null,
        ...(filters.entityId ? { entityId: filters.entityId } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.createdBy ? { createdBy: filters.createdBy } : {}),
      },
      include: {
        entity: { select: { id: true, name: true } },
        vendor: { select: { id: true, name: true } },
        lines: { orderBy: { sortOrder: "asc" } },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async findQuoteById(id: string) {
    return prisma.quote.findFirst({
      where: { id, deletedAt: null },
      include: {
        entity: { select: { id: true, name: true } },
        vendor: { select: { id: true, name: true, email: true } },
        lines: { orderBy: { sortOrder: "asc" } },
      },
    });
  }

  async softDeleteQuote(id: string) {
    return prisma.quote.update({ where: { id }, data: softDeleteUpdate() });
  }

  // ── Purchase orders ─────────────────────────────────────────────────────

  async findPurchaseOrders(filters: { entityId?: string; status?: string }) {
    return prisma.purchaseOrder.findMany({
      where: {
        deletedAt: null,
        ...(filters.entityId ? { entityId: filters.entityId } : {}),
        ...(filters.status ? { status: filters.status } : {}),
      },
      include: {
        entity: { select: { id: true, name: true } },
        vendor: { select: { id: true, name: true } },
        lines: { orderBy: { sortOrder: "asc" } },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async findPurchaseOrderById(id: string) {
    return prisma.purchaseOrder.findFirst({
      where: { id, deletedAt: null },
      include: {
        entity: { select: { id: true, name: true } },
        vendor: { select: { id: true, name: true, email: true } },
        lines: { orderBy: { sortOrder: "asc" } },
      },
    });
  }

  async softDeletePurchaseOrder(id: string) {
    return prisma.purchaseOrder.update({
      where: { id },
      data: softDeleteUpdate(),
    });
  }

  // ── Fixed assets ─────────────────────────────────────────────────────────

  async findFixedAssets(
    filters: {
      entityId?: string;
      status?: string;
      categoryCode?: string;
      assetClass?: string;
      search?: string;
      createdBy?: string;
      sortBy?:
        | "assetNo"
        | "name"
        | "categoryCode"
        | "purchaseDate"
        | "purchasePrice"
        | "status";
      sortOrder?: "asc" | "desc";
    },
    page: number,
    limit: number,
  ) {
    const where: Prisma.FixedAssetWhereInput = { ...excludeDeleted() };
    if (filters.entityId) where.entityId = filters.entityId;
    if (filters.status) where.status = filters.status;
    if (filters.categoryCode) where.categoryCode = filters.categoryCode;
    if (filters.assetClass) where.assetClass = filters.assetClass;
    if (filters.createdBy) where.createdBy = filters.createdBy;
    if (filters.search) {
      const q = filters.search;
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { assetNo: { contains: q, mode: "insensitive" } },
        { serialNo: { contains: q, mode: "insensitive" } },
        { supplier: { contains: q, mode: "insensitive" } },
      ];
    }

    const dir = filters.sortOrder ?? "asc";
    const orderBy: Prisma.FixedAssetOrderByWithRelationInput = filters.sortBy
      ? { [filters.sortBy]: dir }
      : { assetNo: "asc" };

    const [data, total] = await Promise.all([
      prisma.fixedAsset.findMany({
        where,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.fixedAsset.count({ where }),
    ]);
    return { data, total };
  }

  async findFixedAssetById(id: string) {
    return prisma.fixedAsset.findFirst({
      where: { id, ...excludeDeleted() },
    });
  }

  // Restore / permanent-delete must see soft-deleted rows — the default
  // findFixedAssetById excludes them, so those paths would 404 without this.
  async findFixedAssetByIdIncludingDeleted(id: string) {
    return prisma.fixedAsset.findUnique({ where: { id } });
  }

  async findFixedAssetByEntityAndNo(entityId: string, assetNo: string) {
    return prisma.fixedAsset.findFirst({ where: { entityId, assetNo } });
  }

  // `createdBy` is selected so the import commit can enforce the same
  // owner-or-read-all guard as every other mutator before overwriting a row.
  async findFixedAssetsByEntityAndNos(entityId: string, assetNos: string[]) {
    if (assetNos.length === 0) return [];
    return prisma.fixedAsset.findMany({
      where: { entityId, assetNo: { in: assetNos }, ...excludeDeleted() },
      select: { id: true, assetNo: true, createdBy: true },
    });
  }

  // Soft-deleted rows still hold the [entityId, assetNo] unique index, so an
  // import naming one would silently write into the graveyard (or collide).
  // Surfaced as an explicit row error instead.
  async findDeletedFixedAssetNos(entityId: string, assetNos: string[]) {
    if (assetNos.length === 0) return [];
    return prisma.fixedAsset.findMany({
      where: { entityId, assetNo: { in: assetNos }, NOT: { deletedAt: null } },
      select: { id: true, assetNo: true },
    });
  }

  async updateFixedAsset(id: string, data: Prisma.FixedAssetUpdateInput) {
    return prisma.fixedAsset.update({ where: { id }, data });
  }

  async softDeleteFixedAsset(id: string) {
    return prisma.fixedAsset.update({
      where: { id },
      data: softDeleteUpdate(),
    });
  }

  async restoreFixedAsset(id: string) {
    return prisma.fixedAsset.update({
      where: { id },
      data: restoreUpdate(),
    });
  }

  async permanentDeleteFixedAsset(id: string) {
    return prisma.fixedAsset.delete({ where: { id } });
  }

  // ── Fixed asset categories ───────────────────────────────────────────────

  async findFixedAssetCategories(entityId: string, includeInactive: boolean) {
    return prisma.fixedAssetCategory.findMany({
      where: { entityId, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: [{ assetClass: "asc" }, { code: "asc" }],
    });
  }

  async findFixedAssetCategoryById(id: string) {
    return prisma.fixedAssetCategory.findUnique({ where: { id } });
  }

  async findFixedAssetCategoryByCode(entityId: string, code: string) {
    return prisma.fixedAssetCategory.findUnique({
      where: { entityId_code: { entityId, code } },
    });
  }

  async createFixedAssetCategory(data: {
    entityId: string;
    code: string;
    name: string;
    nameTh: string | null;
    assetClass: string;
    usefulLifeMonths: number;
    taxUsefulLifeMonths: number | null;
    assetGlAccountId: string | null;
    depreciationGlAccountId: string | null;
    accumulatedDepreciationGlAccountId: string | null;
    disposalGainGlAccountId: string | null;
    disposalLossGlAccountId: string | null;
    isActive: boolean;
  }) {
    return prisma.fixedAssetCategory.create({ data });
  }

  async updateFixedAssetCategory(
    id: string,
    data: Prisma.FixedAssetCategoryUpdateInput,
  ) {
    return prisma.fixedAssetCategory.update({ where: { id }, data });
  }

  async deleteFixedAssetCategory(id: string) {
    return prisma.fixedAssetCategory.delete({ where: { id } });
  }

  // Live (non-deleted) assets referencing a category code — a non-zero count
  // blocks a hard delete (deactivate instead) so historical assets keep it.
  async countFixedAssetCategoryUsage(
    entityId: string,
    code: string,
  ): Promise<number> {
    return prisma.fixedAsset.count({
      where: { entityId, categoryCode: code, ...excludeDeleted() },
    });
  }

  // ── Fixed asset disposals ────────────────────────────────────────────────

  private static readonly FA_DISPOSAL_ASSET_SELECT = {
    id: true,
    assetNo: true,
    name: true,
    entityId: true,
    categoryCode: true,
    quantity: true,
    purchasePrice: true,
    status: true,
    createdBy: true,
    startDate: true,
    usefulLifeMonths: true,
    openingBookValue: true,
    openingAsOfDate: true,
  } as const;

  async findFixedAssetDisposals(filters: {
    entityId?: string;
    status?: string;
    assetId?: string;
    createdBy?: string;
  }) {
    const where: Prisma.FixedAssetDisposalWhereInput = {};
    if (filters.entityId) where.entityId = filters.entityId;
    if (filters.status) where.status = filters.status;
    if (filters.assetId) where.assetId = filters.assetId;
    if (filters.createdBy) where.asset = { createdBy: filters.createdBy };
    return prisma.fixedAssetDisposal.findMany({
      where,
      orderBy: { requestedAt: "desc" },
      include: {
        asset: { select: AccountingRepository.FA_DISPOSAL_ASSET_SELECT },
      },
    });
  }

  async findFixedAssetDisposalById(id: string) {
    return prisma.fixedAssetDisposal.findUnique({
      where: { id },
      include: {
        asset: { select: AccountingRepository.FA_DISPOSAL_ASSET_SELECT },
      },
    });
  }

  async countPendingDisposalsForAsset(assetId: string): Promise<number> {
    return prisma.fixedAssetDisposal.count({
      where: { assetId, status: "pending" },
    });
  }

  async createFixedAssetDisposal(data: Prisma.FixedAssetDisposalCreateInput) {
    return prisma.fixedAssetDisposal.create({
      data,
      include: {
        asset: { select: AccountingRepository.FA_DISPOSAL_ASSET_SELECT },
      },
    });
  }

  // ── Fixed asset revaluation / impairment (WS2) ────────────────────────────

  // Wider than the disposal select: the approve path re-values the asset at the
  // effective date AND needs the two cumulative recognition balances, which are
  // not derivable from the carrying amount (see fixed-asset-revaluation.ts).
  private static readonly FA_REMEASUREMENT_ASSET_SELECT = {
    id: true,
    assetNo: true,
    name: true,
    entityId: true,
    categoryCode: true,
    quantity: true,
    purchasePrice: true,
    status: true,
    createdBy: true,
    startDate: true,
    usefulLifeMonths: true,
    openingBookValue: true,
    openingAsOfDate: true,
    disposalDate: true,
    revaluationSurplus: true,
    impairmentPlLoss: true,
  } as const;

  async findFixedAssetRemeasurements(filters: {
    entityId?: string;
    status?: string;
    assetId?: string;
    kind?: string;
    createdBy?: string;
  }) {
    const where: Prisma.FixedAssetRemeasurementWhereInput = {};
    if (filters.entityId) where.entityId = filters.entityId;
    if (filters.status) where.status = filters.status;
    if (filters.assetId) where.assetId = filters.assetId;
    if (filters.kind) where.kind = filters.kind;
    if (filters.createdBy) where.asset = { createdBy: filters.createdBy };
    return prisma.fixedAssetRemeasurement.findMany({
      where,
      orderBy: { requestedAt: "desc" },
      include: {
        asset: { select: AccountingRepository.FA_REMEASUREMENT_ASSET_SELECT },
      },
    });
  }

  async findFixedAssetRemeasurementById(id: string) {
    return prisma.fixedAssetRemeasurement.findUnique({
      where: { id },
      include: {
        asset: { select: AccountingRepository.FA_REMEASUREMENT_ASSET_SELECT },
      },
    });
  }

  // The per-asset remeasurement history. Ordered by the EFFECTIVE date, not the
  // request date: the carrying-amount chain is only readable in the order the
  // events actually happened.
  async findFixedAssetRemeasurementsForAsset(assetId: string) {
    return prisma.fixedAssetRemeasurement.findMany({
      where: { assetId },
      orderBy: [{ effectiveDate: "asc" }, { requestedAt: "asc" }],
    });
  }

  async countPendingRemeasurementsForAsset(assetId: string): Promise<number> {
    return prisma.fixedAssetRemeasurement.count({
      where: { assetId, status: "pending" },
    });
  }

  async createFixedAssetRemeasurement(
    data: Prisma.FixedAssetRemeasurementCreateInput,
  ) {
    return prisma.fixedAssetRemeasurement.create({
      data,
      include: {
        asset: { select: AccountingRepository.FA_REMEASUREMENT_ASSET_SELECT },
      },
    });
  }

  async rejectFixedAssetRemeasurement(
    id: string,
    reviewerId: string,
    reason: string,
  ) {
    return prisma.fixedAssetRemeasurement.update({
      where: { id },
      data: {
        status: "rejected",
        rejectedBy: reviewerId,
        rejectedAt: new Date(),
        rejectReason: reason,
        approvedBy: null,
        approvedAt: null,
      },
      include: {
        asset: { select: AccountingRepository.FA_REMEASUREMENT_ASSET_SELECT },
      },
    });
  }

  // Feeds the point-in-time event chain (assetEventHistory). Approved rows only
  // — a pending remeasurement has changed nothing.
  async findApprovedRemeasurements(entityId: string) {
    return prisma.fixedAssetRemeasurement.findMany({
      where: { entityId, status: "approved" },
      orderBy: { effectiveDate: "asc" },
    });
  }

  // ── Fixed asset transfers (WS3) ───────────────────────────────────────────

  // Wider than the disposal select: `planTransfer` reads location, custodian
  // and categoryCode on top of the depreciable state, and the approve path
  // re-plans from this row rather than trusting the stored request.
  private static readonly FA_TRANSFER_ASSET_SELECT = {
    id: true,
    entityId: true,
    assetNo: true,
    categoryCode: true,
    location: true,
    assignedUser: true,
    quantity: true,
    purchasePrice: true,
    status: true,
    createdBy: true,
    startDate: true,
    usefulLifeMonths: true,
    openingBookValue: true,
    openingAsOfDate: true,
  } as const;

  async findFixedAssetTransfers(filters: {
    entityId?: string;
    status?: string;
    assetId?: string;
    kind?: string;
    createdBy?: string;
  }) {
    const where: Prisma.FixedAssetTransferWhereInput = {};
    if (filters.entityId) where.entityId = filters.entityId;
    if (filters.status) where.status = filters.status;
    if (filters.assetId) where.assetId = filters.assetId;
    if (filters.kind) where.kind = filters.kind;
    if (filters.createdBy) where.asset = { createdBy: filters.createdBy };
    return prisma.fixedAssetTransfer.findMany({
      where,
      orderBy: { requestedAt: "desc" },
      include: {
        asset: { select: AccountingRepository.FA_TRANSFER_ASSET_SELECT },
      },
    });
  }

  async findFixedAssetTransferById(id: string) {
    return prisma.fixedAssetTransfer.findUnique({
      where: { id },
      include: {
        asset: { select: AccountingRepository.FA_TRANSFER_ASSET_SELECT },
      },
    });
  }

  // The per-asset movement trail. Ordered by the TRANSFER DATE, not the request
  // date: a back-dated move belongs where it happened, and a trail sorted by
  // when someone got round to filing it is not a movement history.
  async findFixedAssetTransfersForAsset(assetId: string) {
    return prisma.fixedAssetTransfer.findMany({
      where: { assetId },
      orderBy: [{ transferDate: "asc" }, { requestedAt: "asc" }],
    });
  }

  async countPendingTransfersForAsset(assetId: string): Promise<number> {
    return prisma.fixedAssetTransfer.count({
      where: { assetId, status: "pending" },
    });
  }

  async createFixedAssetTransfer(data: Prisma.FixedAssetTransferCreateInput) {
    return prisma.fixedAssetTransfer.create({
      data,
      include: {
        asset: { select: AccountingRepository.FA_TRANSFER_ASSET_SELECT },
      },
    });
  }

  async rejectFixedAssetTransfer(
    id: string,
    reviewerId: string,
    reason: string,
  ) {
    return prisma.fixedAssetTransfer.update({
      where: { id },
      data: {
        status: "rejected",
        rejectedBy: reviewerId,
        rejectedAt: new Date(),
        rejectReason: reason,
        approvedBy: null,
        approvedAt: null,
      },
      include: {
        asset: { select: AccountingRepository.FA_TRANSFER_ASSET_SELECT },
      },
    });
  }

  // ── Fixed asset physical count (WS4) ──────────────────────────────────────

  async findFixedAssetCountSessions(filters: {
    entityId?: string;
    status?: string;
    createdBy?: string;
  }) {
    const where: Prisma.FixedAssetCountSessionWhereInput = {};
    if (filters.entityId) where.entityId = filters.entityId;
    if (filters.status) where.status = filters.status;
    if (filters.createdBy) where.createdBy = filters.createdBy;
    return prisma.fixedAssetCountSession.findMany({
      where,
      orderBy: [{ asOfDate: "desc" }, { createdAt: "desc" }],
      include: { _count: { select: { lines: true } } },
    });
  }

  async findFixedAssetCountSessionById(id: string) {
    return prisma.fixedAssetCountSession.findUnique({ where: { id } });
  }

  // Ordered by scan time so the trail reads as the count was walked. The
  // variance engine sums per asset regardless of order, so this is purely for
  // the audit view.
  async findFixedAssetCountLines(sessionId: string) {
    return prisma.fixedAssetCountLine.findMany({
      where: { sessionId },
      orderBy: { countedAt: "asc" },
    });
  }

  async createFixedAssetCountLine(
    data: Prisma.FixedAssetCountLineUncheckedCreateInput,
  ) {
    return prisma.fixedAssetCountLine.create({ data });
  }

  // Guarded on status so two concurrent closes cannot both stamp the row —
  // the loser updates nothing and the service turns that into a 409.
  async closeFixedAssetCountSession(id: string, closedBy: string) {
    const { count } = await prisma.fixedAssetCountSession.updateMany({
      where: { id, status: "open" },
      data: { status: "closed", closedBy, closedAt: new Date() },
    });
    return count;
  }

  // ── Fixed asset reports (full set, never paginated — CLAUDE.md rule) ───────

  // `createdBy` scopes the read for callers without accounting:read-all, so a
  // report/export can never surface rows the register list hides.
  async findFixedAssetsForReport(entityId: string, createdBy?: string) {
    return prisma.fixedAsset.findMany({
      where: {
        entityId,
        ...(createdBy ? { createdBy } : {}),
        ...excludeDeleted(),
      },
      orderBy: { assetNo: "asc" },
    });
  }

  // ── Entity corporate income tax rates (WS5) ──────────────────────────────
  //
  // Ordered oldest-first so the admin list reads as a timeline; the deferred
  // tax engine resolves the rate in force itself and does not rely on order.

  /** The VAT rate in force for an entity on a date, or null when the entity
   *  has no rate covering it. Effective-dated: `effectiveTo` null means open. */
  async findEntityTaxRateOn(entityId: string, onDate: Date) {
    return prisma.entityTaxRate.findFirst({
      where: {
        entityId,
        effectiveFrom: { lte: onDate },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: onDate } }],
      },
      orderBy: { effectiveFrom: "desc" },
      select: { ratePercent: true },
    });
  }

  async findEntityTaxRates(entityId: string) {
    return prisma.entityTaxRate.findMany({
      where: { entityId },
      orderBy: [{ effectiveFrom: "asc" }],
    });
  }

  async findEntityTaxRateById(id: string) {
    return prisma.entityTaxRate.findUnique({ where: { id } });
  }

  async createEntityTaxRate(data: {
    entityId: string;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    ratePercent: Prisma.Decimal;
    label: string | null;
  }) {
    return prisma.entityTaxRate.create({ data });
  }

  async updateEntityTaxRate(id: string, data: Prisma.EntityTaxRateUpdateInput) {
    return prisma.entityTaxRate.update({ where: { id }, data });
  }

  async deleteEntityTaxRate(id: string) {
    return prisma.entityTaxRate.delete({ where: { id } });
  }

  async findApprovedDisposals(entityId: string, from?: Date, to?: Date) {
    const where: Prisma.FixedAssetDisposalWhereInput = {
      entityId,
      status: "approved",
    };
    if (from || to) {
      where.disposalDate = {
        ...(from ? { gte: from } : {}),
        ...(to ? { lte: to } : {}),
      };
    }
    return prisma.fixedAssetDisposal.findMany({
      where,
      orderBy: { disposalDate: "asc" },
      include: {
        asset: { select: AccountingRepository.FA_DISPOSAL_ASSET_SELECT },
      },
    });
  }
}

export const accountingRepository = new AccountingRepository();
