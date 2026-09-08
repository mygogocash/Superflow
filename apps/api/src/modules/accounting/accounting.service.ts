import { Prisma } from "@nexora/database";

import {
  APP_NAME_SETTING_KEY,
  orgNameFromSetting,
} from "@/common/constants/org";
import { PERMISSIONS } from "@/common/constants/permissions";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ValidationException,
} from "@/common/exceptions/http-exception";
import { logger } from "@/common/utils/logger";
import { prisma } from "@/infrastructure/database/prisma";
import { softDeleteUpdate } from "@/infrastructure/soft-delete";
import {
  AGING_BUCKETS,
  buildAgingSummary,
} from "@/modules/accounting/accounting.aging";
import {
  isGlPostingEnabled,
  isSettlementV2Enabled,
} from "@/modules/accounting/accounting.flags";
import {
  assertPostingPeriodOpen,
  paymentReconciled,
} from "@/modules/accounting/accounting.locks";
import { accountingRepository } from "@/modules/accounting/accounting.repository";
import type {
  AccountingSearchQuery,
  AccountQuery,
  AccountReuseCheckInput,
  ActivateCompanyInput,
  AgingSummaryQuery,
  ApplyAdvanceInput,
  AuditLogQuery,
  BankAccountQuery,
  BankTransactionQuery,
  CancelJournalInput,
  ClosePeriodInput,
  CorporateOverviewQuery,
  CreateAccountInput,
  CreateBankAccountInput,
  CreateCreditNoteInput,
  CreateFixedAssetCategoryInput,
  CreateFixedAssetCountSessionInput,
  CreateFixedAssetInput,
  CreateInvoiceInput,
  CreateJournalInput,
  CreatePurchaseOrderInput,
  CreateQuoteInput,
  CreditNoteQuery,
  CustomerAdvanceQuery,
  ExpenseSummaryQuery,
  FileTaxInput,
  FiscalPeriodQuery,
  FixedAssetCategoryQuery,
  FixedAssetCountSessionQuery,
  FixedAssetDisposalQuery,
  FixedAssetPeriodReportQuery,
  FixedAssetQuery,
  FixedAssetRemeasurementQuery,
  FixedAssetReportQuery,
  FixedAssetScheduleQuery,
  FixedAssetTransferQuery,
  ImportAccountsInput,
  ImportBankStatementInput,
  ImportFixedAssetsInput,
  ImportJournalsInput,
  ImportOpeningBalancesInput,
  InvoiceCompanyInput,
  InvoiceQuery,
  JournalQuery,
  MakerCheckerConfigInput,
  OpeningBalancesQuery,
  PaymentListQuery,
  PaymentRunInput,
  PrepaymentTaxInvoiceInput,
  PurchaseOrderQuery,
  QuoteQuery,
  ReceivePurchaseOrderInput,
  ReconcileTransactionInput,
  ReconciliationSummaryQuery,
  RecordAllocatedPaymentInput,
  RecordPaymentInput,
  RefundAdvanceInput,
  ReopenPeriodInput,
  ReopenTaxInput,
  ReportAsOfQuery,
  ReportPeriodQuery,
  RevaluePeriodInput,
  SecondApprovalConfigInput,
  SecondApprovalDecisionInput,
  SettleBankTransactionInput,
  StatementQuery,
  SubmitFixedAssetCountLineInput,
  SubmitFixedAssetDisposalInput,
  SubmitFixedAssetRemeasurementInput,
  SubmitFixedAssetTransferInput,
  SupplierSummaryQuery,
  TaxCodesQuery,
  TaxFilingQuery,
  TaxReportQuery,
  UpdateAccountInput,
  UpdateBankAccountInput,
  UpdateCompanyProfileInput,
  UpdateFixedAssetCategoryInput,
  UpdateFixedAssetInput,
  UpdateInvoiceInput,
  UpdateJournalInput,
  UpdateQuoteInput,
  UpdateTaxCodeInput,
  UpsertAccountMappingInput,
  UpsertTaxCodeInput,
} from "@/modules/accounting/accounting.validation";
import {
  type AccountingFxSide,
  accountingFxSide,
  resolveAccountingFx,
  syncAccountingFxRates,
} from "@/modules/accounting/accounting-fx.service";
import {
  applyAdvance,
  computeSettlementExcess,
  splitAdvanceVat,
} from "@/modules/accounting/advance-tax";
import { rejectDuplicateVendorTaxInvoice } from "@/modules/accounting/ap-duplicate";
import {
  type ApprovalDocType,
  canGiveSecondApproval,
  DEFAULT_SECOND_APPROVAL,
  detectSplitDocuments,
  requiresSecondApproval,
  type SecondApprovalConfig,
} from "@/modules/accounting/approval-threshold";
import {
  ACCOUNTING_INVOICE_LINKED_TO,
  ACCOUNTING_JOURNAL_LINKED_TO,
  ACCOUNTING_PAYMENT_LINKED_TO,
  assertAttachmentFileAllowed,
  assertHasAttachment,
} from "@/modules/accounting/attachments-rules";
import {
  matchBankTransaction,
  type MatchDoc,
} from "@/modules/accounting/bank-matching";
import { summarizeReconciliation } from "@/modules/accounting/bank-reconciliation";
import { postMoneyEvent } from "@/modules/accounting/cash-posting.service";
import {
  classifyInactiveReuse,
  type CoaFieldError,
  collectCoaFieldErrors,
  duplicateCodeError,
  duplicateEnglishNameError,
  type InactiveAccountFacts,
  type InactiveReuseDecision,
  normalizeEnglishName,
  sanitizeCoaText,
} from "@/modules/accounting/coa-validation";
import { recognisedOutputVat } from "@/modules/accounting/collection-vat";
import {
  isBranchMismatch,
  isIncompatibleBusinessType,
  scoreContactIdentity,
} from "@/modules/accounting/contact-identity";
import { computeArDocument } from "@/modules/accounting/document-calc";
import {
  type BillForSummary,
  summarizeExpenses,
} from "@/modules/accounting/expense-summary";
import {
  assertFixedAssetAccountsConfigured,
  DEPRECIATION_ROLES,
} from "@/modules/accounting/fixed-asset-accounts";
import {
  buildCountVariance,
  type CountExpectation,
  type CountObservation,
  normalizeTag,
  resolveAssetByTag,
} from "@/modules/accounting/fixed-asset-count";
import {
  buildDeferredTaxSchedule,
  type DeferredTaxAssetInput,
  type TaxRatePeriod,
} from "@/modules/accounting/fixed-asset-deferred-tax";
import {
  computeDepreciation,
  computeDisposal,
  daysBetween,
  type DepreciationInput,
  periodDepreciationCharge,
} from "@/modules/accounting/fixed-asset-depreciation";
import {
  type ValidatedImportRow,
  validateFixedAssetImportRow,
} from "@/modules/accounting/fixed-asset-import";
import {
  buildDepreciationSchedule,
  buildDisposalReport,
  buildFixedAssetRegisterReport,
  buildMovementReport,
  type DisposalLine,
  type MovementContribution,
  type RegisterLine,
  type ScheduleLine,
} from "@/modules/accounting/fixed-asset-reports";
import {
  recogniseRemeasurement,
  remainingLifeMonths,
  remeasurementAnchor,
  type RemeasurementKind,
} from "@/modules/accounting/fixed-asset-revaluation";
import * as faState from "@/modules/accounting/fixed-asset-state";
import {
  findOverlappingTaxRate,
  type TaxBasisCategory,
  taxDepreciationInput,
} from "@/modules/accounting/fixed-asset-tax-basis";
import {
  planTransfer,
  type TransferAsset,
  type TransferKind,
  type TransferPlan,
  type TransferRequest,
  TransferValidationError,
} from "@/modules/accounting/fixed-asset-transfer";
import {
  buildFixedAssetRegisterXlsx,
  type FixedAssetExportRow,
} from "@/modules/accounting/fixed-asset-xlsx-generator";
import {
  computeEntryTotals,
  findMappedAccount,
  normalizeLines,
  postBalancedEntry,
  type PostingLine,
  resolveMappedAccount,
} from "@/modules/accounting/gl-posting.service";
import {
  buildDefaultInvoiceCompany,
  type InvoiceCompany,
} from "@/modules/accounting/invoice-shared";
import {
  buildRoleView,
  computeReadiness,
} from "@/modules/accounting/mapping-readiness";
import {
  allocateDocumentNumber,
  allocateDraftNumber,
} from "@/modules/accounting/numbering.service";
import { validateAllocations } from "@/modules/accounting/payment-allocation";
import {
  nextAmountPaid,
  settledStatusAfter,
  validatePaymentAmount,
} from "@/modules/accounting/payment-math";
import { groupLinesByPayee } from "@/modules/accounting/payment-run";
import {
  buildAdvanceApplicationLines,
  buildAdvanceRefundLines,
  buildApDebitNoteLines,
  buildApPaymentLines,
  buildArCreditNoteLines,
  buildArReceiptLines,
  buildBankFeeLines,
  buildBillRecordLines,
  buildFixedAssetDepreciationLines,
  buildInputVatRecognitionLines,
  buildInvoiceSendLines,
  buildOutputVatRecognitionLines,
  buildOverpaymentPaymentLines,
  buildOverpaymentReceiptLines,
  buildPrepaymentTaxInvoiceLines,
  buildVendorPrepaymentApplicationLines,
  singleLineAccount,
} from "@/modules/accounting/posting-builders";
import {
  capitalisedNet,
  computeAccrualRevenue,
  computeOperatingExpense,
} from "@/modules/accounting/prd-exhibits";
import {
  buildDeferredVatRecon,
  buildNumberControlReport,
} from "@/modules/accounting/prd-statutory-reports";
import {
  buildBalanceSheet,
  buildCashFlow,
  buildProfitAndLoss,
  buildTaxSummary,
  buildTrialBalance,
  fiscalYearStartOnOrBefore,
  netIncome,
} from "@/modules/accounting/reports";
import {
  buildStatement,
  buildStatementPdfBuffer,
} from "@/modules/accounting/statement";
import {
  monthDateRange,
  taxMonthLocked,
  taxMonthOf,
} from "@/modules/accounting/tax-filing";
import {
  buildTaxInvoiceData,
  buildTaxInvoicePdfBuffer,
} from "@/modules/accounting/tax-invoice";
import {
  buildPp30,
  buildVatRegister,
  buildWhtSummary,
  type PayeeKind,
  type VatDocInput,
  type WhtPaymentInput,
} from "@/modules/accounting/tax-reports";
import {
  applyVendorKeepFields,
  assertContactMergeAllowed,
  assertMergeOutstandingUnchanged,
  assertVendorTaxIdMergeAllowed,
  groupVendorDuplicateSuggestions,
  scanDuplicatePaymentsAfterMerge,
  vendorFieldDiffs,
  type VendorKeepMap,
} from "@/modules/accounting/vendor-merge";
import {
  buildWhtCertificateData,
  buildWhtCertificatePdfBuffer,
} from "@/modules/accounting/wht-certificate";
import { createExchangeRateService } from "@/modules/exchange-rates/exchange-rates.service";

/**
 * `JournalEntry` doesn't persist running totals — they're a sum of the
 * child `JournalEntryLine.debit` / `.credit` columns, which already
 * survive validation (debit-credit balance is enforced server-side at
 * create time). Compute on read so the list view doesn't have to wire
 * its own aggregate query and the frontend can stop rendering "NaN" in
 * the totals column. Stringified so the wire shape matches the rest of
 * the Decimal fields the API ships (e.g. ChartOfAccount.balance).
 */
function decorateJournalTotals<
  T extends { lines: Array<{ debit: Prisma.Decimal; credit: Prisma.Decimal }> },
>(j: T): T & { totalDebit: string; totalCredit: string } {
  const zero = new Prisma.Decimal(0);
  const totalDebit = j.lines.reduce((acc, l) => acc.plus(l.debit), zero);
  const totalCredit = j.lines.reduce((acc, l) => acc.plus(l.credit), zero);
  return {
    ...j,
    totalDebit: totalDebit.toFixed(2),
    totalCredit: totalCredit.toFixed(2),
  };
}

const REPORTING_CURRENCY = "USD";
const DAY_MS = 24 * 60 * 60 * 1000;

type PnlRow = Awaited<
  ReturnType<typeof accountingRepository.getPnlRows>
>[number];

function dateAtStart(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function dateAtEnd(value: string): Date {
  return new Date(`${value}T23:59:59.999Z`);
}

function resolveOverviewPeriod(query: CorporateOverviewQuery) {
  const now = new Date();
  const endDate = query.endDate ? dateAtEnd(query.endDate) : now;
  let startDate: Date;
  if (query.startDate) {
    startDate = dateAtStart(query.startDate);
  } else if (query.period === "mtd") {
    startDate = new Date(
      Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), 1),
    );
  } else if (query.period === "qtd") {
    const quarterStart = Math.floor(endDate.getUTCMonth() / 3) * 3;
    startDate = new Date(Date.UTC(endDate.getUTCFullYear(), quarterStart, 1));
  } else {
    startDate = new Date(Date.UTC(endDate.getUTCFullYear(), 0, 1));
  }

  const dayCount =
    Math.floor(
      (Date.UTC(
        endDate.getUTCFullYear(),
        endDate.getUTCMonth(),
        endDate.getUTCDate(),
      ) -
        Date.UTC(
          startDate.getUTCFullYear(),
          startDate.getUTCMonth(),
          startDate.getUTCDate(),
        )) /
        DAY_MS,
    ) + 1;
  const previousEndDate = new Date(startDate.getTime() - 1);
  const previousStartDate = new Date(
    Date.UTC(
      previousEndDate.getUTCFullYear(),
      previousEndDate.getUTCMonth(),
      previousEndDate.getUTCDate() - dayCount + 1,
    ),
  );

  return { startDate, endDate, previousStartDate, previousEndDate };
}

function percentageChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function nativePnl(rows: PnlRow[]) {
  const byEntity = new Map<
    string,
    {
      entityId: string;
      entityName: string;
      entityCode: string;
      currency: string;
      revenue: number;
      expenses: number;
      accounts: Array<{
        accountId: string;
        code: string;
        name: string;
        type: string;
        amount: number;
      }>;
    }
  >();

  for (const row of rows) {
    const entity = byEntity.get(row.entityId) ?? {
      entityId: row.entityId,
      entityName: row.entityName,
      entityCode: row.entityCode,
      currency: row.currency,
      revenue: 0,
      expenses: 0,
      accounts: [],
    };
    const amount =
      row.accountType === "revenue"
        ? row.credit - row.debit
        : row.debit - row.credit;
    if (row.accountType === "revenue") entity.revenue += amount;
    if (row.accountType === "expense") entity.expenses += amount;
    entity.accounts.push({
      accountId: row.accountId,
      code: row.accountCode,
      name: row.accountName,
      type: row.accountType,
      amount: roundMoney(amount),
    });
    byEntity.set(row.entityId, entity);
  }

  return byEntity;
}

// ── Own-document RBAC scoping (Chunk 5) ────────────────────────────────────
// A caller with `accounting:read-all` (or `accounting:admin`) sees and can act
// on every AR/AP document — this is the visibility every current reader keeps.
// Everyone else (the Sales / Purchasing roles) is scoped to documents they
// created (`Invoice.createdBy`). Mirrors the investors read-all-vs-own pattern
// (#202). The System Admin role needs no special case: resolvePermissions
// injects every code into its set, so read-all is already present.
function canReadAllAccounting(permissions: string[]): boolean {
  return (
    permissions.includes(PERMISSIONS.ACCOUNTING_READ_ALL) ||
    permissions.includes(PERMISSIONS.ACCOUNTING_ADMIN)
  );
}

// Owner-or-read-all guard for a single document. Throws 403 when a non
// read-all caller touches a document they did not create. A null `createdBy`
// (legacy row, pre-scoping) is only reachable by read-all/admin holders.
function assertInvoiceAccess(
  invoice: { createdBy: string | null },
  actorId: string,
  permissions: string[],
): void {
  if (!canReadAllAccounting(permissions) && invoice.createdBy !== actorId) {
    throw new ForbiddenException(
      "You can only access accounting documents you created",
    );
  }
}

const CREDIT_NOTE_REQUIRED =
  "Cannot void this invoice after collection or outside its tax month; issue a credit note instead.";
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

/**
 * The register-row fields a transfer needs (WS3). Deliberately the intersection
 * of the depreciable state and the transfer-specific columns rather than the
 * whole FixedAsset: both the live row and the narrower row the transfer include
 * selects satisfy it, so submit and approve share one code path.
 */
type TransferAssetRow = faState.AssetStateRow & {
  id: string;
  entityId: string;
  assetNo: string;
  categoryCode: string;
  location: string | null;
  assignedUser: string | null;
  status: string;
};

export class AccountingService {
  async listAccounts(query: AccountQuery) {
    return accountingRepository.findAccounts(query);
  }

  // ── Account-role mapping + GL posting readiness (foundation) ─────────────

  // Every canonical posting role for an entity, mapped or blank — the shape the
  // mapping settings UI renders.
  async getAccountMappings(entityId: string) {
    const mapped = await accountingRepository.findAccountMappings(entityId);
    return { entityId, roles: buildRoleView(mapped) };
  }

  // Set (or clear) the account for one posting role. Passing no
  // chartOfAccountId clears it. The target account is validated to belong to
  // the same entity and be active, so posting can never be routed to a foreign
  // or inactive account.
  async setAccountMapping(input: UpsertAccountMappingInput) {
    const { entityId, role, chartOfAccountId } = input;

    if (!chartOfAccountId) {
      await accountingRepository.deleteAccountMapping(entityId, role);
      return { entityId, role, chartOfAccountId: null, account: null };
    }

    const account = await accountingRepository.findAccountForMapping(
      entityId,
      chartOfAccountId,
    );
    if (!account) {
      throw new BadRequestException(
        "Selected account does not exist for this entity, or is inactive.",
      );
    }

    await accountingRepository.upsertAccountMapping(
      entityId,
      role,
      chartOfAccountId,
    );
    return { entityId, role, chartOfAccountId, account };
  }

  // Two-gate posting readiness (env flag + complete mapping) for one entity, or
  // for every entity with a chart of accounts when entityId is omitted.
  async getPostingReadiness(entityId?: string) {
    const flagEnabled = isGlPostingEnabled();
    const entityIds = entityId
      ? [entityId]
      : await accountingRepository.listEntityIdsWithAccounts();

    const readiness = await Promise.all(
      entityIds.map(async (eid) => {
        const mapped = await accountingRepository.findAccountMappings(eid);
        return computeReadiness(
          eid,
          mapped.map((m) => m.role),
          flagEnabled,
        );
      }),
    );

    return entityId ? readiness[0] : readiness;
  }

  // ── Company setup, fiscal year & activation gate (Chunk 2) ───────────────

  // Read the entity-scoped company profile (identity fields + the Chunk-2
  // company-profile / fiscal-year / activation columns). 404s on an unknown or
  // soft-deleted entity.
  async getCompanyProfile(entityId: string) {
    const entity = await accountingRepository.findEntitySetup(entityId);
    if (!entity) throw new NotFoundException("Entity not found");
    return entity;
  }

  // Apply a partial company-profile / fiscal-year update. Only the keys the
  // caller submitted are written — an omitted field leaves the stored value
  // untouched (never overwritten with a default). Enum / range / THB-in-
  // enabled-currencies validation happens in the Zod schema before we get here.
  async updateCompanyProfile(input: UpdateCompanyProfileInput) {
    const { entityId, ...fields } = input;
    const existing = await accountingRepository.findEntitySetup(entityId);
    if (!existing) throw new NotFoundException("Entity not found");

    // Copy only the keys the caller actually submitted; `fields` maps 1:1 to
    // Entity company-profile columns, so an omitted key never reaches the row.
    const data: Prisma.EntityUpdateInput = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) {
        (data as Record<string, unknown>)[key] = value;
      }
    }

    return accountingRepository.updateEntitySetup(entityId, data);
  }

  // Flip an entity from "setup" → "active". Prerequisites: a fiscal-year start
  // month is set (1–12) AND the entity has ≥1 active chart-of-accounts row.
  // Idempotent — an already-active entity is a no-op success. Fuller mapping-
  // completeness gating (REQUIRED_MAPPING_ROLES) is added when the account-
  // mapping sibling branch merges; do NOT couple to it here.
  async activateCompany(input: ActivateCompanyInput) {
    const { entityId } = input;
    const entity = await accountingRepository.findEntitySetup(entityId);
    if (!entity) throw new NotFoundException("Entity not found");

    if (entity.setupState === "active") {
      // Already activated — idempotent no-op.
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

    const activeAccounts =
      await accountingRepository.countActiveAccounts(entityId);
    if (activeAccounts < 1) {
      throw new ConflictException(
        "Add at least one active account to the chart of accounts before activating the company.",
      );
    }

    // Chunk 6: the opening balances must be posted before go-live so the new
    // entity's books tie to its prior-year closing figures. Only reached for a
    // setup→active transition — an already-active (grandfathered) entity
    // returns above and never hits this gate.
    const openingEntryExists = await this.hasOpeningEntry(entityId);
    if (!openingEntryExists) {
      throw new ConflictException(
        "Import the opening balances before activating the company so the books tie to the prior year.",
      );
    }

    const updated = await accountingRepository.updateEntitySetup(entityId, {
      setupState: "active",
    });
    return { ...updated, activated: true };
  }

  // Document-issuance guard. Throws when the entity is still in "setup" so a
  // brand-new, not-yet-activated company can't issue documents. Existing
  // entities are grandfathered "active" (see the migration), so this is a
  // no-op for them. An unknown entity id is left to the downstream FK / lookup
  // to reject — the guard only blocks the explicit "setup" state.
  async assertEntityActivated(entityId: string): Promise<void> {
    const state = await accountingRepository.getEntitySetupState(entityId);
    if (state === "setup") {
      throw new ConflictException(
        "This company is not activated yet. Activate the company before issuing documents.",
      );
    }
  }

  // ── Opening-balance import (Chunk 6 · M0.1.9) ────────────────────────────
  //
  // Posts ONE dated opening journal entry for a newly set-up entity so its
  // books tie to prior-year closing figures. This is the GL posting engine's
  // first real production caller: the trial-balance rows, open AR/AP per
  // counterparty, and bank opening balances become balanced debit/credit lines
  // routed through postBalancedEntry inside a single transaction — the entry
  // and its account-balance moves commit or roll back together. Entered ONCE
  // per entity; a redo would require voiding the first (out of scope here).

  // Does the entity already have a posted opening-balance entry?
  async hasOpeningEntry(entityId: string): Promise<boolean> {
    return accountingRepository.hasOpeningEntry(entityId);
  }

  // Status for the setup UI: whether an opening entry exists (+ a light
  // summary) so the screen can show "opening balances imported" and hide the
  // import form on re-visit.
  async getOpeningBalanceStatus(query: OpeningBalancesQuery) {
    const entity = await accountingRepository.findEntitySetup(query.entityId);
    if (!entity) throw new NotFoundException("Entity not found");
    const entry = await accountingRepository.findOpeningEntry(query.entityId);
    return { entityId: query.entityId, exists: entry !== null, entry };
  }

  async importOpeningBalances(
    userId: string,
    input: ImportOpeningBalancesInput,
  ) {
    const entity = await accountingRepository.findEntitySetup(input.entityId);
    if (!entity) throw new NotFoundException("Entity not found");

    // Idempotency: opening balances are entered once. Refuse a second import.
    if (await accountingRepository.hasOpeningEntry(input.entityId)) {
      throw new ConflictException(
        "This entity already has a posted opening-balance entry. Opening " +
          "balances are entered once; void the existing opening entry before " +
          "re-importing.",
      );
    }

    // Net the subledger figures — AR/AP post as one control-account line each
    // ("net per the totals"); bank balances post per GL account.
    const arTotal = this.round2(
      input.openReceivables.reduce((s, r) => s + r.amount, 0),
    );
    const apTotal = this.round2(
      input.openPayables.reduce((s, p) => s + p.amount, 0),
    );
    const bankRows = input.bankBalances
      .map((b) => ({
        accountId: b.chartOfAccountId,
        amount: this.round2(b.amount),
      }))
      .filter((b) => b.amount !== 0);
    // opening_balance_equity is only needed when a subledger/bank leg exists;
    // an all-trial-balance import (which self-balances) doesn't require it.
    const needsObe = arTotal !== 0 || apTotal !== 0 || bankRows.length > 0;

    // Every referenced GL account must belong to this entity and be active — an
    // opening line must never post to a foreign or inactive account.
    const referencedAccountIds = [
      ...input.accounts.map((a) => a.chartOfAccountId),
      ...bankRows.map((b) => b.accountId),
    ];
    if (referencedAccountIds.length > 0) {
      const validIds = new Set(
        await accountingRepository.findActiveAccountIds(input.entityId),
      );
      const unknown = referencedAccountIds.find((id) => !validIds.has(id));
      if (unknown) {
        throw new BadRequestException(
          `Account ${unknown} does not exist for this entity or is inactive.`,
        );
      }
    }

    const asOfDate = new Date(input.asOfDate);
    const asOfLabel = asOfDate.toISOString().slice(0, 10);

    const posted = await prisma.$transaction(async (tx) => {
      await assertPostingPeriodOpen(tx, input.entityId, asOfDate);

      const obe = needsObe
        ? await resolveMappedAccount(
            tx,
            input.entityId,
            "opening_balance_equity",
          )
        : null;

      const lines: PostingLine[] = [];

      // 1. Trial-balance rows, exactly as entered.
      for (const a of input.accounts) {
        lines.push({
          accountId: a.chartOfAccountId,
          debit: a.debit ?? 0,
          credit: a.credit ?? 0,
          memo: "Opening balance",
        });
      }

      // 2. Open AR (net): Dr AR control / Cr Opening balance equity.
      if (arTotal !== 0) {
        const arControl = await resolveMappedAccount(
          tx,
          input.entityId,
          "ar_control",
        );
        lines.push({
          accountId: arControl,
          debit: arTotal,
          memo: "Opening accounts receivable",
        });
        lines.push({
          accountId: obe as string,
          credit: arTotal,
          memo: "Opening balance equity (AR)",
        });
      }

      // 3. Open AP (net): Dr Opening balance equity / Cr AP control.
      if (apTotal !== 0) {
        const apControl = await resolveMappedAccount(
          tx,
          input.entityId,
          "ap_control",
        );
        lines.push({
          accountId: obe as string,
          debit: apTotal,
          memo: "Opening balance equity (AP)",
        });
        lines.push({
          accountId: apControl,
          credit: apTotal,
          memo: "Opening accounts payable",
        });
      }

      // 4. Bank/cash opening balances: Dr bank GL account / Cr Opening balance
      //    equity, one debit per bank account.
      for (const b of bankRows) {
        lines.push({
          accountId: b.accountId,
          debit: b.amount,
          memo: "Opening bank balance",
        });
        lines.push({
          accountId: obe as string,
          credit: b.amount,
          memo: "Opening balance equity (bank)",
        });
      }

      // Balance pre-check with a user-fixable message reporting the exact
      // debit/credit totals + difference. postBalancedEntry re-asserts this as
      // a backstop, but its generic message doesn't spell out the gap.
      const normalized = normalizeLines(lines);
      const { totalDebit, totalCredit } = computeEntryTotals(normalized);
      if (!totalDebit.equals(totalCredit)) {
        const difference = totalDebit.minus(totalCredit);
        throw new BadRequestException(
          `Opening balances do not tie out: total debit ` +
            `${totalDebit.toFixed(2)} vs total credit ${totalCredit.toFixed(2)} ` +
            `(difference ${difference.toFixed(2)}). Adjust the trial balance so ` +
            `debits equal credits.`,
        );
      }

      return postBalancedEntry(tx, {
        entityId: input.entityId,
        date: asOfDate,
        description: `Opening balances as of ${asOfLabel}`,
        reference: null,
        sourceType: "opening",
        sourceRef: input.entityId,
        createdBy: userId,
        lines,
      });
    });

    return {
      entryId: posted.id,
      entryNo: posted.entryNo,
      entityId: input.entityId,
      asOfDate: asOfLabel,
    };
  }

  // ── Tax codes (Thai VAT + WHT config) ────────────────────────────────────

  async listTaxCodes(query: TaxCodesQuery) {
    return accountingRepository.findTaxCodes(
      query.entityId,
      query.includeInactive ?? false,
    );
  }

  async getTaxCodeById(id: string) {
    const taxCode = await accountingRepository.findTaxCodeById(id);
    if (!taxCode) throw new NotFoundException("Tax code not found");
    return taxCode;
  }

  // Validate a tax GL account belongs to the entity and is active — a tax code
  // must never route posting to a foreign or inactive account.
  // Validates that a chosen chart_of_accounts id actually belongs to the entity
  // and is active. Used by tax codes and fixed-asset categories — both store a
  // BARE account id with no FK, so without this any string would persist and
  // only fail at posting time, months later.
  private async assertEntityGlAccount(entityId: string, glAccountId: string) {
    const account = await accountingRepository.findAccountForMapping(
      entityId,
      glAccountId,
    );
    if (!account) {
      throw new BadRequestException(
        "Selected GL account does not exist for this entity, or is inactive.",
      );
    }
  }

  async createTaxCode(input: UpsertTaxCodeInput) {
    const existing = await accountingRepository.findTaxCodeByEntityAndCode(
      input.entityId,
      input.code,
    );
    if (existing) {
      throw new ConflictException(
        `Tax code "${input.code}" already exists for this entity`,
      );
    }
    if (input.glAccountId) {
      await this.assertEntityGlAccount(input.entityId, input.glAccountId);
    }
    return accountingRepository.createTaxCode({
      entityId: input.entityId,
      code: input.code,
      name: input.name,
      kind: input.kind,
      rate: input.rate,
      glAccountId: input.glAccountId ?? null,
      isActive: input.isActive ?? true,
    });
  }

  async updateTaxCode(id: string, input: UpdateTaxCodeInput) {
    const existing = await this.getTaxCodeById(id);

    // A code rename must not collide with another code in the same entity.
    if (input.code && input.code !== existing.code) {
      const dup = await accountingRepository.findTaxCodeByEntityAndCode(
        existing.entityId,
        input.code,
      );
      if (dup) {
        throw new ConflictException(
          `Tax code "${input.code}" already exists for this entity`,
        );
      }
    }
    if (input.glAccountId) {
      await this.assertEntityGlAccount(existing.entityId, input.glAccountId);
    }

    return accountingRepository.updateTaxCode(id, {
      ...(input.code !== undefined ? { code: input.code } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.rate !== undefined ? { rate: input.rate } : {}),
      ...(input.glAccountId !== undefined
        ? { glAccountId: input.glAccountId ?? null }
        : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    });
  }

  // Hard delete, guarded: a tax code referenced by any document line cannot be
  // removed (deactivate via `isActive` instead) so historical documents keep
  // their tax linkage.
  async deleteTaxCode(id: string) {
    await this.getTaxCodeById(id);
    const usage = await accountingRepository.countTaxCodeUsage(id);
    if (usage > 0) {
      throw new ConflictException(
        `Cannot delete a tax code used by ${usage} document line(s). ` +
          `Deactivate it instead.`,
      );
    }
    await accountingRepository.deleteTaxCode(id);
    return { success: true };
  }

  async createAccount(input: CreateAccountInput, actorId: string) {
    const sanitized = {
      ...input,
      code: sanitizeCoaText(input.code),
      name: sanitizeCoaText(input.name),
      nameTh: sanitizeCoaText(input.nameTh),
      description: sanitizeCoaText(input.description),
      descriptionTh: sanitizeCoaText(input.descriptionTh),
    };
    const errors = collectCoaFieldErrors(sanitized, {
      requireAll: true,
      validateEnglish: true,
    });
    const nameNormalized = normalizeEnglishName(sanitized.name);

    const [activeByCode, inactiveByCode, activeByName, inactiveByName] =
      await Promise.all([
        accountingRepository.findActiveAccountByEntityAndCode(
          sanitized.entityId,
          sanitized.code,
        ),
        accountingRepository.findInactiveAccountByEntityAndCode(
          sanitized.entityId,
          sanitized.code,
        ),
        nameNormalized
          ? accountingRepository.findActiveAccountByNormalizedName(
              sanitized.entityId,
              nameNormalized,
            )
          : Promise.resolve(null),
        nameNormalized
          ? accountingRepository.findInactiveAccountByNormalizedName(
              sanitized.entityId,
              nameNormalized,
            )
          : Promise.resolve(null),
      ]);

    if (activeByCode) {
      errors.push(duplicateCodeError(activeByCode.code, activeByCode.name));
    }
    if (activeByName) {
      errors.push(
        duplicateEnglishNameError(activeByName.code, activeByName.name),
      );
    }

    // Live collisions first. Describing a dead account's balance is noise while
    // an ACTIVE account already owns the code — that has to be fixed regardless.
    if (errors.length > 0) throw new ValidationException(errors);

    const decision = classifyInactiveReuse(
      await this.inactiveReuseMatches({
        byCode: inactiveByCode,
        byName: inactiveByName,
      }),
      { acknowledged: input.acknowledgeInactiveReuse === true },
    );
    this.assertReuseAllowed(decision);

    const account = await accountingRepository.createAccount({
      ...sanitized,
      nameNormalized,
      ...(decision.reusedFromAccountId
        ? {
            reusedFromAccountId: decision.reusedFromAccountId,
            reuseAcknowledgedBy: actorId,
            reuseAcknowledgedAt: new Date(),
          }
        : {}),
    });
    return { ...account, warnings: decision.warnings };
  }

  /** Refuse a save the reuse rules do not permit. A block carries its own
   *  explanation; a missing acknowledgement does not, so the warning it refers
   *  to is sent with it. */
  private assertReuseAllowed(decision: InactiveReuseDecision): void {
    if (decision.outcome === "allow") return;
    if (decision.outcome === "block") {
      throw new ValidationException(decision.errors);
    }
    throw new ValidationException([
      ...decision.warnings.map((w) => ({
        field: w.code === "inactive_code_reuse" ? "code" : "name",
        message: w.message,
        messageTh: w.messageTh,
      })),
      ...decision.errors,
    ]);
  }

  /**
   * Preflight for the account form: what WOULD happen if this code / English
   * name were saved. Read-only.
   *
   * Exists so the warning and its tick-box appear while the user is still
   * filling the form, rather than as a rejection after they press save. The
   * save path re-runs the same classifier — this is a courtesy, never the
   * enforcement.
   */
  async checkInactiveReuse(input: AccountReuseCheckInput) {
    const code = sanitizeCoaText(input.code);
    const nameNormalized = normalizeEnglishName(input.name ?? "");
    const [byCode, byName] = await Promise.all([
      code
        ? accountingRepository.findInactiveAccountByEntityAndCode(
            input.entityId,
            code,
            input.excludeAccountId,
          )
        : Promise.resolve(null),
      nameNormalized
        ? accountingRepository.findInactiveAccountByNormalizedName(
            input.entityId,
            nameNormalized,
            input.excludeAccountId,
          )
        : Promise.resolve(null),
    ]);
    const decision = classifyInactiveReuse(
      await this.inactiveReuseMatches({ byCode, byName }),
      // Report what the unacknowledged state looks like; the form decides
      // whether to show a tick-box or a hard stop from `outcome`.
      { acknowledged: false },
    );
    return {
      outcome: decision.outcome,
      warnings: decision.warnings,
      blockers: decision.outcome === "block" ? decision.errors : [],
    };
  }

  /**
   * Turn the deactivated accounts a code / English name collides with into the
   * facts the classifier needs.
   *
   * One account matching BOTH the code and the name is reported once (as the
   * code match, the stronger claim). Two DIFFERENT dead accounts — one on the
   * code, one on the name — are both reported, because fixing only the one the
   * message mentioned would leave the other collision in place.
   */
  private async inactiveReuseMatches(candidates: {
    byCode: {
      id: string;
      code: string;
      name: string;
      nameTh: string | null;
      deactivatedAt: Date | null;
    } | null;
    byName: {
      id: string;
      code: string;
      name: string;
      nameTh: string | null;
      deactivatedAt: Date | null;
    } | null;
  }): Promise<InactiveAccountFacts[]> {
    const ordered = [
      ["code", candidates.byCode],
      ["name", candidates.byName],
    ] as const;
    const out: InactiveAccountFacts[] = [];
    const seen = new Set<string>();
    for (const [matchedOn, row] of ordered) {
      if (!row || seen.has(row.id)) continue;
      seen.add(row.id);
      const [ledger, mapped] = await Promise.all([
        accountingRepository.accountLedgerFacts(row.id),
        accountingRepository.isAccountMapped(row.id),
      ]);
      out.push({
        matchedOn,
        id: row.id,
        code: row.code,
        name: row.name,
        nameTh: row.nameTh ?? null,
        deactivatedAt: row.deactivatedAt ?? null,
        balance: ledger.balance,
        lastMovementYear: ledger.lastMovementYear,
        mappedInFinancialStatements: mapped,
      });
    }
    return out;
  }

  async getAccountById(id: string) {
    const account = await accountingRepository.findAccountById(id);
    if (!account) throw new NotFoundException("Account not found");
    return account;
  }

  async updateAccount(id: string, input: UpdateAccountInput, actorId: string) {
    const existing = await this.getAccountById(id);
    const nameTouched = input.name !== undefined;
    const descriptionTouched = input.description !== undefined;
    const sanitized: UpdateAccountInput = {
      ...input,
      ...(input.code !== undefined && { code: sanitizeCoaText(input.code) }),
      ...(nameTouched && { name: sanitizeCoaText(input.name) }),
      ...(input.nameTh !== undefined && {
        nameTh: sanitizeCoaText(input.nameTh),
      }),
      ...(descriptionTouched && {
        description: sanitizeCoaText(input.description),
      }),
      ...(input.descriptionTh !== undefined && {
        descriptionTh: sanitizeCoaText(input.descriptionTh),
      }),
    };

    const errors: CoaFieldError[] = collectCoaFieldErrors(sanitized, {
      requireAll: false,
      validateEnglish: nameTouched || descriptionTouched,
    });

    if (sanitized.code && sanitized.code !== existing.code) {
      const active =
        await accountingRepository.findActiveAccountByEntityAndCode(
          existing.entityId,
          sanitized.code,
        );
      if (active && active.id !== id) {
        errors.push(duplicateCodeError(active.code, active.name));
      }
    }

    let nameNormalized: string | undefined;
    if (nameTouched) {
      nameNormalized = normalizeEnglishName(sanitized.name ?? "");
      if (nameNormalized) {
        const clash =
          await accountingRepository.findActiveAccountByNormalizedName(
            existing.entityId,
            nameNormalized,
            id,
          );
        if (clash) {
          errors.push(duplicateEnglishNameError(clash.code, clash.name));
        }
      }
    }

    if (errors.length > 0) throw new ValidationException(errors);

    // Reactivation. While this account was switched off, its code or English
    // name may have been taken by a live account. Switching it back on would put
    // two active accounts under one code — the exact collision the create path
    // refuses — so refuse it here too, and say which account is in the way.
    const reactivating = input.isActive === true && !existing.isActive;
    if (reactivating) {
      const [codeHolder, nameHolder] = await Promise.all([
        accountingRepository.findActiveAccountByEntityAndCode(
          existing.entityId,
          sanitized.code ?? existing.code,
        ),
        existing.nameNormalized
          ? accountingRepository.findActiveAccountByNormalizedName(
              existing.entityId,
              nameNormalized ?? existing.nameNormalized,
              id,
            )
          : Promise.resolve(null),
      ]);
      const clashes: CoaFieldError[] = [];
      if (codeHolder && codeHolder.id !== id) {
        clashes.push(duplicateCodeError(codeHolder.code, codeHolder.name));
      }
      if (nameHolder) {
        clashes.push(
          duplicateEnglishNameError(nameHolder.code, nameHolder.name),
        );
      }
      if (clashes.length > 0) throw new ValidationException(clashes);
    }

    // Editing a code or English name onto a DEACTIVATED account's is governed by
    // the same rules as creating one there.
    const codeChanged =
      sanitized.code !== undefined && sanitized.code !== existing.code;
    const nameChanged =
      nameNormalized !== undefined &&
      nameNormalized !== "" &&
      nameNormalized !== existing.nameNormalized;
    let reusePatch: {
      reusedFromAccountId?: string;
      reuseAcknowledgedBy?: string;
      reuseAcknowledgedAt?: Date;
    } = {};
    if (codeChanged || nameChanged) {
      const [byCode, byName] = await Promise.all([
        codeChanged
          ? accountingRepository.findInactiveAccountByEntityAndCode(
              existing.entityId,
              sanitized.code!,
              id,
            )
          : Promise.resolve(null),
        nameChanged
          ? accountingRepository.findInactiveAccountByNormalizedName(
              existing.entityId,
              nameNormalized!,
              id,
            )
          : Promise.resolve(null),
      ]);
      const decision = classifyInactiveReuse(
        await this.inactiveReuseMatches({ byCode, byName }),
        { acknowledged: input.acknowledgeInactiveReuse === true },
      );
      this.assertReuseAllowed(decision);
      if (decision.reusedFromAccountId) {
        reusePatch = {
          reusedFromAccountId: decision.reusedFromAccountId,
          reuseAcknowledgedBy: actorId,
          reuseAcknowledgedAt: new Date(),
        };
      }
    }

    const deactivating = input.isActive === false && existing.isActive;
    return accountingRepository.updateAccount(id, {
      ...sanitized,
      ...(nameNormalized !== undefined && { nameNormalized }),
      ...reusePatch,
      // Stamped here rather than inferred later: the warning quotes this date to
      // a human, and "when did isActive last flip" is not recoverable after the
      // fact.
      ...(deactivating ? { deactivatedAt: new Date() } : {}),
      ...(reactivating ? { deactivatedAt: null } : {}),
    });
  }

  /**
   * Auditor report: every account standing on a deactivated account's code or
   * English name. Answers "which account did code 1030 mean, and when" without
   * anyone having to reconstruct it from journal history.
   */
  async listReusedAccountCodes(entityId?: string) {
    const rows = await accountingRepository.findReusedCodeAccounts(entityId);
    return rows.map((row) => ({
      account: {
        id: row.id,
        entityId: row.entityId,
        code: row.code,
        name: row.name,
        nameTh: row.nameTh,
        isActive: row.isActive,
        balance: Number(row.balance),
      },
      previous: row.reusedFrom
        ? {
            id: row.reusedFrom.id,
            code: row.reusedFrom.code,
            name: row.reusedFrom.name,
            nameTh: row.reusedFrom.nameTh,
            deactivatedAt: row.reusedFrom.deactivatedAt,
            balance: Number(row.reusedFrom.balance),
          }
        : null,
      acknowledgedBy: row.reuseAcknowledgedBy,
      acknowledgedAt: row.reuseAcknowledgedAt,
    }));
  }

  async deleteAccount(id: string) {
    await this.getAccountById(id);
    return accountingRepository.softDeleteAccount(id);
  }

  // Preview a Chart-of-Accounts import: dedupes the payload by code
  // and classifies each row as
  //   - "insert"    → code is new, account will be created
  //   - "update-th" → code exists but `nameTh` is empty and the xlsx
  //                   row has one, so the Thai label will be back-filled
  //   - "skip"      → code exists and either has a Thai name already or
  //                   the xlsx row doesn't supply one
  // The UI shows the row-by-row breakdown before the user commits.
  async previewAccountImport(input: ImportAccountsInput) {
    const seen = new Set<string>();
    const dedup: ImportAccountsInput["rows"] = [];
    let duplicateInPayload = 0;
    for (const r of input.rows) {
      if (seen.has(r.code)) {
        duplicateInPayload += 1;
        continue;
      }
      seen.add(r.code);
      dedup.push(r);
    }

    const existing = await accountingRepository.findAccountCodes(
      input.entityId,
      dedup.map((r) => r.code),
    );
    const existingByCode = new Map(existing.map((e) => [e.code, e]));

    const rows = dedup.map((r) => {
      const hit = existingByCode.get(r.code);
      let action: "insert" | "update-th" | "skip" | "invalid";
      let errors: CoaFieldError[] = [];
      if (!hit) {
        errors = collectCoaFieldErrors(
          {
            code: r.code,
            name: r.name,
            nameTh: r.nameTh,
            description: r.description,
            descriptionTh: r.descriptionTh,
          },
          { requireAll: true, validateEnglish: true },
        );
        action = errors.length > 0 ? "invalid" : "insert";
      } else if (!hit.nameTh && r.nameTh) {
        action = "update-th";
      } else {
        action = "skip";
      }
      return {
        code: r.code,
        name: r.name,
        nameTh: r.nameTh,
        description: r.description,
        descriptionTh: r.descriptionTh,
        type: r.type,
        action,
        errors,
      };
    });

    const inserts = rows.filter((r) => r.action === "insert").length;
    const updates = rows.filter((r) => r.action === "update-th").length;
    const skipped = rows.filter((r) => r.action === "skip").length;
    const invalid = rows.filter((r) => r.action === "invalid").length;

    return {
      rows,
      summary: {
        total: input.rows.length,
        unique: dedup.length,
        duplicateInPayload,
        inserts,
        updates,
        skipped,
        invalid,
      },
    };
  }

  async commitAccountImport(input: ImportAccountsInput) {
    const preview = await this.previewAccountImport(input);
    const toInsert = preview.rows.filter((r) => r.action === "insert");
    const toUpdate = preview.rows
      .filter((r) => r.action === "update-th" && r.nameTh)
      .map((r) => ({ code: r.code, nameTh: r.nameTh! }));

    const [insertResult, updatedCount] = await Promise.all([
      accountingRepository.createAccountsBulk(input.entityId, toInsert),
      accountingRepository.backfillAccountNameTh(input.entityId, toUpdate),
    ]);

    return {
      inserted: insertResult.count,
      updated: updatedCount,
      skipped: preview.summary.skipped + preview.summary.duplicateInPayload,
      invalid: preview.summary.invalid,
      total: preview.summary.total,
    };
  }

  // Preview a journal-entry import from the GL xlsx. Classifies every
  // entry as one of:
  //   - "insert"           → reference is new + balanced + all accounts exist
  //   - "skip-duplicate"   → reference already exists for this entity
  //   - "skip-unbalanced"  → sum of debits != sum of credits (within 0.01)
  //   - "skip-missing"     → at least one line references an unknown code
  // The UI shows the row-by-row breakdown before commit.
  async previewJournalImport(input: ImportJournalsInput) {
    // De-dupe by reference inside the payload (later occurrences ignored).
    const seenRef = new Set<string>();
    const deduped: ImportJournalsInput["entries"] = [];
    let duplicateInPayload = 0;
    for (const e of input.entries) {
      if (seenRef.has(e.reference)) {
        duplicateInPayload += 1;
        continue;
      }
      seenRef.add(e.reference);
      deduped.push(e);
    }

    const allCodes = new Set<string>();
    for (const e of deduped) {
      for (const l of e.lines) allCodes.add(l.accountCode);
    }

    const [accounts, existing] = await Promise.all([
      accountingRepository.findAccountIdsByCodes(input.entityId, [...allCodes]),
      accountingRepository.findJournalReferences(
        input.entityId,
        deduped.map((e) => e.reference),
      ),
    ]);

    const accountByCode = new Map(accounts.map((a) => [a.code, a]));
    const existingByRef = new Map(existing.map((r) => [r.reference!, r]));

    const rows = deduped.map((e) => {
      const totalDebit = e.lines.reduce((s, l) => s + l.debit, 0);
      const totalCredit = e.lines.reduce((s, l) => s + l.credit, 0);
      const balanced = Math.abs(totalDebit - totalCredit) < 0.01;
      const missingCodes = e.lines
        .map((l) => l.accountCode)
        .filter((c) => !accountByCode.has(c));
      const existingRow = existingByRef.get(e.reference);

      // Reference is bilingual: a row that already exists can still
      // be updated when the import language fills in the *other*
      // column. "skip-duplicate" only fires when the chosen language
      // column is already populated.
      let action:
        | "insert"
        | "update"
        | "skip-duplicate"
        | "skip-unbalanced"
        | "skip-missing";
      if (existingRow) {
        const alreadyHasTargetLang =
          input.language === "th"
            ? !!existingRow.descriptionTh
            : !!existingRow.description;
        action = alreadyHasTargetLang ? "skip-duplicate" : "update";
      } else if (missingCodes.length > 0) {
        action = "skip-missing";
      } else if (!balanced) {
        action = "skip-unbalanced";
      } else {
        action = "insert";
      }

      return {
        reference: e.reference,
        date: e.date,
        description: e.description,
        lineCount: e.lines.length,
        totalDebit,
        totalCredit,
        missingCodes,
        action,
      };
    });

    const summary = {
      total: input.entries.length,
      unique: deduped.length,
      duplicateInPayload,
      inserts: rows.filter((r) => r.action === "insert").length,
      updates: rows.filter((r) => r.action === "update").length,
      skipDuplicates: rows.filter((r) => r.action === "skip-duplicate").length,
      skipUnbalanced: rows.filter((r) => r.action === "skip-unbalanced").length,
      skipMissing: rows.filter((r) => r.action === "skip-missing").length,
    };

    return { rows, summary };
  }

  async commitJournalImport(userId: string, input: ImportJournalsInput) {
    // Re-run preview to filter to insertable rows. Single source of truth
    // for what counts as a clean insert.
    const seenRef = new Set<string>();
    const deduped: ImportJournalsInput["entries"] = [];
    for (const e of input.entries) {
      if (seenRef.has(e.reference)) continue;
      seenRef.add(e.reference);
      deduped.push(e);
    }

    const allCodes = new Set<string>();
    for (const e of deduped) {
      for (const l of e.lines) allCodes.add(l.accountCode);
    }

    const [accounts, existing] = await Promise.all([
      accountingRepository.findAccountIdsByCodes(input.entityId, [...allCodes]),
      accountingRepository.findJournalReferences(
        input.entityId,
        deduped.map((e) => e.reference),
      ),
    ]);

    const accountIdByCode = new Map(accounts.map((a) => [a.code, a.id]));
    const existingByRef = new Map(existing.map((r) => [r.reference!, r]));

    type Actionable = (typeof deduped)[number] & {
      existingId: string | null;
    };
    const actionable: Actionable[] = [];
    for (const e of deduped) {
      const existingRow = existingByRef.get(e.reference);
      if (existingRow) {
        const alreadyHasTargetLang =
          input.language === "th"
            ? !!existingRow.descriptionTh
            : !!existingRow.description;
        if (alreadyHasTargetLang) continue; // skip-duplicate
        actionable.push({ ...e, existingId: existingRow.id });
        continue;
      }
      if (e.lines.some((l) => !accountIdByCode.has(l.accountCode))) continue;
      const td = e.lines.reduce((s, l) => s + l.debit, 0);
      const tc = e.lines.reduce((s, l) => s + l.credit, 0);
      if (Math.abs(td - tc) >= 0.01) continue;
      actionable.push({ ...e, existingId: null });
    }

    if (actionable.length === 0) {
      return {
        inserted: 0,
        updated: 0,
        skipped: input.entries.length,
        total: input.entries.length,
      };
    }

    // Allocate entry numbers serially based on current count for the
    // entries that are genuinely new — existing rows reuse their stored
    // `entryNo` (the update path doesn't touch it). Pre-existing rows
    // for this entity are counted once; the importer rides on top.
    const startSeq = await accountingRepository.countJournalsForEntity(
      input.entityId,
    );
    let insertOffset = 0;
    const stamped = actionable.map((e) => {
      const entryNo = e.existingId
        ? ""
        : `JE-${String(startSeq + ++insertOffset).padStart(6, "0")}`;
      return { ...e, entryNo, accountIdByCode };
    });

    const { inserted, updated } = await accountingRepository.importJournals(
      input.entityId,
      userId,
      input.status,
      input.language,
      stamped,
    );

    return {
      inserted,
      updated,
      skipped: input.entries.length - inserted - updated,
      total: input.entries.length,
    };
  }

  async listJournals(query: JournalQuery) {
    const { page, limit, ...filters } = query;
    const { data, total } = await accountingRepository.findJournals(
      filters,
      page,
      limit,
    );

    let decorated = data.map((j) => {
      const row = decorateJournalTotals(j);
      return j.deletedAt ? { ...row, status: "deleted" } : row;
    });
    // totalDebit / totalCredit are summed from the child lines after
    // Prisma returns the page, so we can't ORDER BY them at the SQL
    // layer. Sort the in-memory page when the caller asks for them.
    if (filters.sortBy === "totalDebit" || filters.sortBy === "totalCredit") {
      const key = filters.sortBy;
      const dir = filters.sortOrder === "asc" ? 1 : -1;
      decorated = [...decorated].sort(
        (a, b) =>
          dir *
          (Number((a as Record<string, unknown>)[key] ?? 0) -
            Number((b as Record<string, unknown>)[key] ?? 0)),
      );
    }

    return {
      data: decorated,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async getJournalById(id: string) {
    const journal = await accountingRepository.findJournalById(id);
    if (!journal) throw new NotFoundException("Journal entry not found");
    return decorateJournalTotals(journal);
  }

  async createJournal(userId: string, input: CreateJournalInput) {
    const created = await accountingRepository.createJournal({
      entityId: input.entityId,
      date: input.date,
      description: input.description,
      reference: input.reference,
      createdBy: userId,
      lines: input.lines,
    });
    return decorateJournalTotals(created);
  }

  async updateJournal(journalId: string, input: UpdateJournalInput) {
    const journal = await accountingRepository.findJournalById(journalId);
    if (!journal) throw new NotFoundException("Journal entry not found");
    if (!["draft", "rejected"].includes(journal.status)) {
      throw new BadRequestException(
        `Cannot update a journal with status "${journal.status}"`,
      );
    }
    const updated = await accountingRepository.updateJournal(
      journalId,
      input,
      journal.status === "rejected",
    );
    return decorateJournalTotals(updated);
  }

  async deleteJournal(journalId: string, actorId?: string) {
    const journal = await accountingRepository.findJournalById(journalId);
    if (!journal) throw new NotFoundException("Journal entry not found");
    if (!["draft", "rejected"].includes(journal.status)) {
      throw new BadRequestException(
        `Cannot delete a journal with status "${journal.status}"`,
      );
    }
    return accountingRepository.softDeleteJournal(journalId, actorId);
  }

  async restoreJournal(journalId: string, actorId: string, permissions: string[]) {
    const journal =
      await accountingRepository.findJournalByIdIncludingDeleted(journalId);
    if (!journal) throw new NotFoundException("Journal entry not found");
    // Defense-in-depth: restore is admin-gated on API, but edge still uses
    // accounting:create — enforce owner-or-read-all in the service.
    assertInvoiceAccess(journal, actorId, permissions);
    const restored = await accountingRepository.restoreJournal(journalId);
    return decorateJournalTotals(restored);
  }

  /**
   * Admin bulk wipe of drafts/rejected only. Issued journals keep their
   * number and must be cancelled, not deleted.
   */
  async bulkDeleteJournals(opts: { ids?: string[]; all?: boolean }) {
    if (opts.all === true) {
      const result = await accountingRepository.softDeleteAllJournals();
      return { deletedCount: result.count, mode: "all" as const };
    }
    const ids = opts.ids ?? [];
    if (ids.length === 0) {
      throw new BadRequestException(
        "Provide `ids` to delete specific journals or set `all: true`",
      );
    }
    const result = await accountingRepository.bulkSoftDeleteJournals(ids);
    return { deletedCount: result.count, mode: "ids" as const };
  }

  // ── Maker-checker config (block self-approval of journals) ───────────────
  // Default OFF: absent/false setting means self-approval is allowed and the
  // approve flow behaves exactly as before.

  async getMakerCheckerConfig(): Promise<{ blockSelfApproval: boolean }> {
    const row = await accountingRepository.getMakerCheckerSetting();
    const value = row?.value;
    const blockSelfApproval =
      !!value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).blockSelfApproval === true;
    return { blockSelfApproval };
  }

  async setMakerCheckerConfig(
    input: MakerCheckerConfigInput,
  ): Promise<{ blockSelfApproval: boolean }> {
    await accountingRepository.upsertMakerCheckerSetting({
      blockSelfApproval: input.blockSelfApproval,
    });
    return { blockSelfApproval: input.blockSelfApproval };
  }

  async getSecondApprovalConfig(): Promise<SecondApprovalConfig> {
    const row = await accountingRepository.getSecondApprovalSetting();
    const value = row?.value;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return DEFAULT_SECOND_APPROVAL;
    }
    const raw = value as Record<string, unknown>;
    const thresholds =
      raw.thresholds && typeof raw.thresholds === "object"
        ? (raw.thresholds as Record<string, unknown>)
        : {};
    const num = (v: unknown) => (typeof v === "number" ? v : null);
    return {
      enabled: raw.enabled === true,
      thresholds: {
        invoice: num(thresholds.invoice),
        bill: num(thresholds.bill),
        journal: num(thresholds.journal),
      },
      staleDays:
        typeof raw.staleDays === "number"
          ? raw.staleDays
          : DEFAULT_SECOND_APPROVAL.staleDays,
    };
  }

  /**
   * Turn second-level approval on or off.
   *
   * Switching it ON is refused unless at least two people can actually approve.
   * A control that routes every large document to a second approver who does
   * not exist does not add oversight, it stops the company invoicing.
   */
  async setSecondApprovalConfig(
    input: SecondApprovalConfigInput,
  ): Promise<SecondApprovalConfig> {
    if (input.enabled) {
      const approvers = await accountingRepository.countApprovers(
        PERMISSIONS.ACCOUNTING_APPROVE,
      );
      if (approvers < 2) {
        throw new BadRequestException(
          `Second-level approval needs at least two people who can approve; ` +
            `there ${approvers === 1 ? "is" : "are"} ${approvers}. Grant ` +
            `accounting:approve to another user first.`,
        );
      }
    }
    const zeroThresholds = Object.values(input.thresholds).filter(
      (v) => v === 0,
    );
    if (zeroThresholds.length > 0) {
      logger.warn(
        "Second-level approval configured with a zero threshold: every document of that type will need two approvers",
        { thresholds: input.thresholds },
      );
    }
    await accountingRepository.upsertSecondApprovalSetting({
      enabled: input.enabled,
      thresholds: {
        invoice: input.thresholds.invoice ?? null,
        bill: input.thresholds.bill ?? null,
        journal: input.thresholds.journal ?? null,
      },
      staleDays: input.staleDays,
    });
    return this.getSecondApprovalConfig();
  }

  /**
   * Does this document need a second signature, and does it look like part of a
   * split? Answered together because both are asked at the same moment and both
   * read the same config.
   */
  private async assessSecondApproval(invoice: {
    id: string;
    entityId: string;
    type: string;
    amount: unknown;
    exchangeRate: unknown;
    issueDate: Date;
    counterparty: string;
  }): Promise<{
    required: boolean;
    threshold: number | null;
    split: ReturnType<typeof detectSplitDocuments>;
  }> {
    const config = await this.getSecondApprovalConfig();
    const docType: ApprovalDocType =
      invoice.type === "receivable" ? "invoice" : "bill";
    const rate = Number(invoice.exchangeRate ?? 1) || 1;
    const baseTotal = this.round2(Number(invoice.amount) * rate);
    const threshold = config.thresholds[docType] ?? null;

    const required = requiresSecondApproval({ config, docType, baseTotal });

    // Only worth looking for a split when a threshold exists to evade.
    const siblings = config.enabled
      ? await accountingRepository.findSameDayDocuments({
          entityId: invoice.entityId,
          type: invoice.type,
          issueDate: invoice.issueDate,
          counterparty: invoice.counterparty,
          excludeId: invoice.id,
        })
      : [];
    const split = detectSplitDocuments({
      documents: [
        { id: invoice.id, baseTotal },
        ...siblings.map((d) => ({
          id: d.id,
          baseTotal: this.round2(
            Number(d.amount) * (Number(d.exchangeRate ?? 1) || 1),
          ),
        })),
      ],
      threshold,
    });

    return { required, threshold, split };
  }

  /**
   * Give the second signature, or send the document back.
   *
   * Being a different person from the first approver is IDENTITY, not
   * permission — `accounting:approve` is what makes someone eligible, being
   * somebody else is what makes the signature mean anything — so it is checked
   * here rather than at the route.
   */
  async decideSecondApproval(
    invoiceId: string,
    actorId: string,
    decision: "approve" | "send-back",
    input: SecondApprovalDecisionInput,
    permissions: string[],
  ) {
    const invoice = await accountingRepository.findInvoiceById(invoiceId);
    if (!invoice) throw new NotFoundException("Document not found");
    assertInvoiceAccess(invoice, actorId, permissions);
    if (invoice.status !== "pending_second_approval") {
      throw new BadRequestException(
        `This document is ${invoice.status}, not awaiting a second approval.`,
      );
    }
    if (
      !canGiveSecondApproval({
        firstApproverId: invoice.approvedById,
        actorId,
      })
    ) {
      throw new ForbiddenException(
        "The second approval has to come from someone other than the person " +
          "who gave the first.",
      );
    }

    if (decision === "send-back") {
      if (!input.reason?.trim()) {
        throw new BadRequestException(
          "Say why you are sending this back so it can be corrected.",
        );
      }
      // Back to draft, and the first approval is cleared: whatever changes now
      // has not been seen by anybody, so the chain starts again.
      return accountingRepository.updateInvoiceApproval(invoiceId, {
        status: "draft",
        approvedById: null,
        approvedAt: null,
        cancelReason: input.reason.trim(),
      });
    }

    // Approving completes the send that was held: real number, GL entry.
    const sent = await this.updateInvoiceStatus(
      invoiceId,
      "sent",
      actorId,
      permissions,
      { skipSecondApprovalGate: true },
    );
    await accountingRepository.updateInvoiceApproval(invoiceId, {
      secondApprovedById: actorId,
      secondApprovedAt: new Date(),
    });
    return sent;
  }

  async approveJournal(journalId: string, approverId: string) {
    const journal = await accountingRepository.findJournalById(journalId);
    if (!journal) throw new NotFoundException("Journal entry not found");
    if (journal.status !== "draft") {
      throw new BadRequestException(
        `Cannot approve a journal with status "${journal.status}"`,
      );
    }

    // Maker-checker: when enabled, the creator cannot approve their own entry.
    const { blockSelfApproval } = await this.getMakerCheckerConfig();
    if (blockSelfApproval && journal.createdBy === approverId) {
      throw new ForbiddenException(
        "Maker-checker is enabled: you cannot approve a journal you created. " +
          "Another approver must review it.",
      );
    }

    const approved = await accountingRepository.approveJournal(
      journalId,
      approverId,
    );
    if (approved.sourceType === "fx-revaluation") {
      await this.applyFxCarryingFromRevaluation(
        approved.entityId,
        approved.date,
      );
    }
    return decorateJournalTotals(approved);
  }

  private async applyFxCarryingFromRevaluation(entityId: string, asOf: Date) {
    const base = await this.getBaseCurrency(entityId);
    const invoices = await accountingRepository.findOpenInvoicesForRevaluation(
      entityId,
      asOf,
    );
    for (const inv of invoices) {
      if (inv.currency.toUpperCase() === base) continue;
      const outstanding = this.round2(
        Number(inv.amount) - Number(inv.amountPaid),
      );
      if (outstanding <= 0.005) continue;
      const side = accountingFxSide(inv.type);
      const closing = await this.resolveRateToBase(
        inv.currency,
        base,
        asOf,
        undefined,
        `${inv.currency} carrying ${asOf.toISOString().slice(0, 10)}`,
        side,
      );
      await prisma.invoice.update({
        where: { id: inv.id },
        data: { carryingRate: closing },
      });
    }
  }

  async rejectJournal(journalId: string, reviewerId: string, reason: string) {
    const journal = await accountingRepository.findJournalById(journalId);
    if (!journal) throw new NotFoundException("Journal entry not found");
    if (journal.status !== "draft") {
      throw new BadRequestException(
        `Cannot reject a journal with status "${journal.status}"`,
      );
    }
    const rejected = await accountingRepository.rejectJournal(
      journalId,
      reviewerId,
      reason,
    );
    return decorateJournalTotals(rejected);
  }

  async bulkApproveJournals(journalIds: string[], approverId: string) {
    // Maker-checker: when enabled, reject the batch if any selected journal was
    // created by the approver (the self-approval read is skipped when OFF, so
    // default behavior is unchanged).
    const { blockSelfApproval } = await this.getMakerCheckerConfig();
    if (blockSelfApproval) {
      const own = await accountingRepository.findJournalsCreatedBy(
        journalIds,
        approverId,
      );
      if (own.length > 0) {
        throw new ForbiddenException(
          `Maker-checker is enabled: ${own.length} of the selected journals ` +
            "were created by you and cannot be self-approved.",
        );
      }
    }

    let updatedCount = 0;
    for (const id of journalIds) {
      const journal = await accountingRepository.findJournalById(id);
      if (!journal || journal.status !== "draft") continue;
      await this.approveJournal(id, approverId);
      updatedCount += 1;
    }
    return { updatedCount };
  }

  async bulkRejectJournals(
    journalIds: string[],
    reviewerId: string,
    reason: string,
  ) {
    const result = await accountingRepository.bulkRejectJournals(
      journalIds,
      reviewerId,
      reason,
    );
    return { updatedCount: result.count };
  }

  async postJournal(journalId: string) {
    const journal = await accountingRepository.findJournalById(journalId);
    if (!journal) throw new NotFoundException("Journal entry not found");
    if (journal.status !== "approved") {
      throw new BadRequestException(
        `Cannot post a journal with status "${journal.status}". It must be approved first.`,
      );
    }

    const lines = journal.lines.map((l) => ({
      accountId: l.accountId,
      debit: Number(l.debit),
      credit: Number(l.credit),
    }));

    const posted = await accountingRepository.postJournal(journalId, lines);
    return decorateJournalTotals(posted);
  }

  async cancelJournal(
    journalId: string,
    actorId: string,
    input: CancelJournalInput,
  ) {
    const reason = (input.reason ?? "").trim();
    if (!reason) {
      throw new BadRequestException("Cancellation reason is required");
    }
    const journal = await accountingRepository.findJournalById(journalId);
    if (!journal) throw new NotFoundException("Journal entry not found");
    if (journal.sourceType && journal.sourceType !== "manual") {
      throw new BadRequestException(
        `Cancel this ${journal.sourceType} from its source document, not from the journal`,
      );
    }
    if (!journal.sourceType && !journal.draftNo) {
      throw new BadRequestException(
        "Imported and legacy journals cannot be cancelled from this action",
      );
    }
    if (journal.reversesEntryId) {
      throw new BadRequestException(
        "A reversing journal cannot itself be cancelled",
      );
    }
    if (journal.status === "cancelled" || journal.status === "reversed") {
      throw new BadRequestException(`Journal is already ${journal.status}`);
    }
    if (journal.status !== "posted" && journal.status !== "approved") {
      throw new BadRequestException(
        `Cannot cancel a journal with status "${journal.status}"`,
      );
    }
    const { journal: cancelled, warnings } =
      await accountingRepository.cancelJournal({
        id: journalId,
        actorId,
        reason,
        reverseDate: input.reverseDate
          ? new Date(input.reverseDate)
          : undefined,
      });
    // Warnings describe what the reversal did to a filed tax month or to
    // retained earnings. They never block — the cancellation has already
    // happened by this point — so the UI surfaces them after the fact.
    return { ...decorateJournalTotals(cancelled), warnings };
  }

  /**
   * Monthly reversal report: which entries were undone, when the reversal
   * landed, who did it and why.
   *
   * Keyed on the reversing entry's date, so a month's figures can be explained
   * by what moved INTO it, which is the question a reviewer actually has.
   */
  async listJournalReversals(query: ReportPeriodQuery) {
    const rows = await accountingRepository.findJournalReversals({
      startDate: new Date(query.startDate),
      endDate: new Date(query.endDate),
      entityId: query.entityId,
    });
    return rows.map((row) => ({
      reversal: {
        id: row.id,
        entryNo: row.entryNo,
        date: row.date,
        description: row.description,
        createdBy: row.createdBy,
      },
      original: row.reversesEntry
        ? {
            id: row.reversesEntry.id,
            entryNo: row.reversesEntry.entryNo,
            date: row.reversesEntry.date,
            reason: row.reversesEntry.cancelReason,
            cancelledBy: row.reversesEntry.cancelledBy,
            cancelledAt: row.reversesEntry.cancelledAt,
          }
        : null,
    }));
  }

  async getCorporateOverview(query: CorporateOverviewQuery) {
    const { startDate, endDate, previousStartDate, previousEndDate } =
      resolveOverviewPeriod(query);
    const [
      currentRows,
      previousRows,
      reviewCounts,
      reviewQueue,
      overdueInvoices,
      unmatchedBank,
    ] = await Promise.all([
      accountingRepository.getPnlRows({
        startDate,
        endDate,
        entityId: query.entityId,
      }),
      accountingRepository.getPnlRows({
        startDate: previousStartDate,
        endDate: previousEndDate,
        entityId: query.entityId,
      }),
      accountingRepository.getReviewSummary(query.entityId),
      accountingRepository.getReviewQueue(query.entityId),
      accountingRepository.getOverdueInvoiceSummary(query.entityId),
      accountingRepository.getUnmatchedBankSummary(query.entityId),
    ]);

    const currentByEntity = nativePnl(currentRows);
    const previousByEntity = nativePnl(previousRows);
    for (const previous of previousByEntity.values()) {
      if (!currentByEntity.has(previous.entityId)) {
        currentByEntity.set(previous.entityId, {
          ...previous,
          revenue: 0,
          expenses: 0,
          accounts: [],
        });
      }
    }
    const fx = createExchangeRateService();
    const entities = await Promise.all(
      [...currentByEntity.values()].map(async (entity) => {
        const rate = await fx.resolveRate(
          entity.currency.toUpperCase(),
          REPORTING_CURRENCY,
          endDate,
        );
        if (rate.source === "missing") {
          logger.warn("Accounting overview: missing FX rate", {
            entityId: entity.entityId,
            currency: entity.currency,
            reportingCurrency: REPORTING_CURRENCY,
          });
        }
        const fxRate = rate.source === "missing" ? 0 : rate.rate;
        const previous = previousByEntity.get(entity.entityId);
        const netProfit = entity.revenue - entity.expenses;
        const previousNetProfit =
          (previous?.revenue ?? 0) - (previous?.expenses ?? 0);
        const revenueUsd = roundMoney(entity.revenue * fxRate);
        const expensesUsd = roundMoney(entity.expenses * fxRate);
        const netProfitUsd = roundMoney(netProfit * fxRate);
        // Use one period-end rate for both periods so movement reflects
        // operating performance rather than FX translation noise.
        const previousNetProfitUsd = roundMoney(previousNetProfit * fxRate);

        return {
          ...entity,
          revenue: roundMoney(entity.revenue),
          expenses: roundMoney(entity.expenses),
          netProfit: roundMoney(netProfit),
          margin:
            entity.revenue === 0 ? null : (netProfit / entity.revenue) * 100,
          revenueUsd,
          expensesUsd,
          netProfitUsd,
          previousNetProfitUsd,
          netProfitChangePct: percentageChange(
            netProfitUsd,
            previousNetProfitUsd,
          ),
          fxRate,
          fxSource: rate.source,
          accounts: entity.accounts.sort(
            (a, b) =>
              a.type.localeCompare(b.type) || a.code.localeCompare(b.code),
          ),
        };
      }),
    );
    entities.sort((a, b) => b.netProfitUsd - a.netProfitUsd);

    const revenue = roundMoney(
      entities.reduce((total, entity) => total + entity.revenueUsd, 0),
    );
    const expenses = roundMoney(
      entities.reduce((total, entity) => total + entity.expensesUsd, 0),
    );
    const netProfit = roundMoney(revenue - expenses);
    const previousNetProfit = roundMoney(
      entities.reduce(
        (total, entity) => total + entity.previousNetProfitUsd,
        0,
      ),
    );
    const missingFxEntities = entities.filter(
      (entity) => entity.fxSource === "missing",
    );

    return {
      reportingCurrency: REPORTING_CURRENCY,
      fxCompleteness: {
        isComplete: missingFxEntities.length === 0,
        excludedEntityCount: missingFxEntities.length,
        missingCurrencies: [
          ...new Set(missingFxEntities.map((entity) => entity.currency)),
        ].sort(),
      },
      period: {
        startDate: startDate.toISOString().slice(0, 10),
        endDate: endDate.toISOString().slice(0, 10),
        previousStartDate: previousStartDate.toISOString().slice(0, 10),
        previousEndDate: previousEndDate.toISOString().slice(0, 10),
      },
      totals: {
        revenue,
        expenses,
        netProfit,
        margin: revenue === 0 ? null : (netProfit / revenue) * 100,
        previousNetProfit,
        netProfitChangePct: percentageChange(netProfit, previousNetProfit),
      },
      prdExhibits: await this.buildPrdExhibits(
        startDate,
        endDate,
        query.entityId,
      ),
      entities,
      review: {
        counts: reviewCounts,
        journals: reviewQueue.map((journal) => decorateJournalTotals(journal)),
      },
      exceptions: {
        overdueInvoices: {
          count: overdueInvoices.count,
          items: overdueInvoices.items.map((invoice) => ({
            ...invoice,
            amount: Number(invoice.amount),
          })),
        },
        unmatchedBank: {
          count: unmatchedBank.count,
          items: unmatchedBank.items.map((transaction) => ({
            ...transaction,
            amount: Number(transaction.amount),
          })),
        },
      },
    };
  }

  private async buildPrdExhibits(
    startDate: Date,
    endDate: Date,
    entityId?: string,
  ) {
    const invoices = await accountingRepository.findExhibitInvoices({
      startDate,
      endDate,
      entityId,
    });
    // Capex is decided by the account a line posts to, so the asset-account set
    // is fetched once rather than per line.
    const assetAccountIds =
      await accountingRepository.findAssetAccountIds(entityId);
    const isAssetAccount = (id: string) => assetAccountIds.has(id);
    const rows = invoices.map((inv) => ({
      type: inv.type,
      status: inv.status,
      amount: Number(inv.amount),
      vatRate: Number(inv.vatRate),
      issueDate: inv.issueDate,
      capitalisedAmount: capitalisedNet(
        inv.lineItems.map((l) => ({
          capitalised: l.capitalised,
          glAccountId: l.glAccountId,
          taxBase: l.taxBase == null ? null : Number(l.taxBase),
          unitPrice: Number(l.unitPrice),
          quantity: Number(l.quantity),
          lineDiscount: Number(l.lineDiscount ?? 0),
        })),
        isAssetAccount,
      ),
    }));
    return {
      accrualRevenue: computeAccrualRevenue(rows, {
        start: startDate,
        end: endDate,
      }),
      ...computeOperatingExpense(rows, { start: startDate, end: endDate }),
    };
  }

  async previewVendorMerge(input: {
    survivingVendorId: string;
    sourceVendorId: string;
  }) {
    if (input.survivingVendorId === input.sourceVendorId) {
      throw new BadRequestException("Cannot merge a vendor into itself");
    }
    const [surviving, source] = await Promise.all([
      prisma.vendor.findUnique({ where: { id: input.survivingVendorId } }),
      prisma.vendor.findUnique({ where: { id: input.sourceVendorId } }),
    ]);
    if (!surviving || !source || surviving.deletedAt || source.deletedAt) {
      throw new NotFoundException("Vendor not found");
    }
    const counts = await this.vendorDocumentCounts(source.id);
    const [survivingOutstanding, sourceOutstanding] = await Promise.all([
      this.vendorOutstandingBySide(prisma, surviving.id),
      this.vendorOutstandingBySide(prisma, source.id),
    ]);
    return {
      surviving: {
        id: surviving.id,
        name: surviving.name,
        taxId: surviving.taxId,
        contactId: surviving.contactId,
      },
      source: {
        id: source.id,
        name: source.name,
        taxId: source.taxId,
        contactId: source.contactId,
      },
      fields: vendorFieldDiffs(
        surviving as unknown as Record<string, unknown>,
        source as unknown as Record<string, unknown>,
      ),
      documents: counts,
      outstanding: {
        surviving: survivingOutstanding,
        source: sourceOutstanding,
      },
      // What the merge screen needs to explain itself: how many identifiers
      // agree, which ones, and whether the merge is possible at all.
      identity: scoreContactIdentity(surviving, source),
      requiresTaxIdReason: !surviving.taxId?.trim() || !source.taxId?.trim(),
      blocked: this.describeMergeBlock(surviving, source),
    };
  }

  /** The reason a merge is impossible, or null. Mirrors assertContactMergeAllowed
   *  so the screen can grey the button out instead of failing on submit. */
  private describeMergeBlock(
    a: {
      taxId: string | null;
      branchCode: string | null;
      businessType: string | null;
    },
    b: {
      taxId: string | null;
      branchCode: string | null;
      businessType: string | null;
    },
  ): string | null {
    if (isIncompatibleBusinessType(a.businessType, b.businessType)) {
      return "One is an individual and the other a juristic person.";
    }
    const left = a.taxId?.trim() ?? "";
    const right = b.taxId?.trim() ?? "";
    if (left && right) {
      if (left !== right) return "These carry different tax IDs.";
      if (isBranchMismatch(a.branchCode, b.branchCode)) {
        return "Same tax ID, different branches. A tax invoice must name the branch.";
      }
      return null;
    }
    const identity = scoreContactIdentity(a, b);
    if (!identity.sufficient) {
      return `Only ${identity.score} of ${identity.required} identifiers agree.`;
    }
    return null;
  }

  /**
   * A contact's open balance, split by control account.
   *
   * AR and AP are returned SEPARATELY and never netted. A contact can be both a
   * customer and a supplier (`contactType` 'Client, Supplier'), the two sit in
   * different control accounts, and offsetting a receivable against a payable is
   * not something the trial balance permits. Reading only the payable side — as
   * this did before — meant merging two CUSTOMERS compared 0.00 against 0.00 and
   * the integrity check passed without checking anything.
   *
   * Takes the client so the merge can read inside its transaction.
   */
  private async vendorOutstandingBySide(
    client: Pick<Prisma.TransactionClient, "invoice">,
    vendorId: string,
  ): Promise<{ receivable: number; payable: number }> {
    const rows = await client.invoice.findMany({
      where: {
        vendorId,
        type: { in: ["receivable", "payable"] },
        status: { notIn: ["cancelled"] },
        deletedAt: null,
      },
      select: { type: true, amount: true, amountPaid: true },
    });
    let receivable = 0;
    let payable = 0;
    for (const row of rows) {
      const open = Number(row.amount) - Number(row.amountPaid);
      if (row.type === "receivable") receivable += open;
      else payable += open;
    }
    return {
      receivable: this.round2(receivable),
      payable: this.round2(payable),
    };
  }

  /**
   * Open advance / overpayment balance held for a contact.
   *
   * Matched by `vendorId` and, for rows created before that column existed, by
   * the free-text name. Both are needed during a merge: the check has to see
   * the same money before and after, and the legacy rows only carry the name.
   */
  private async contactAdvanceTotal(
    client: Pick<Prisma.TransactionClient, "customerAdvance">,
    vendorId: string,
    name?: string,
  ): Promise<number> {
    const rows = await client.customerAdvance.findMany({
      where: {
        status: "open",
        OR: [{ vendorId }, ...(name ? [{ counterparty: name }] : [])],
      },
      select: { balance: true },
    });
    return this.round2(rows.reduce((sum, r) => sum + Number(r.balance), 0));
  }

  private async vendorDocumentCounts(vendorId: string) {
    const [invoices, quotes, purchaseOrders, creditNotes, payments] =
      await Promise.all([
        prisma.invoice.count({ where: { vendorId, deletedAt: null } }),
        prisma.quote.count({ where: { vendorId, deletedAt: null } }),
        prisma.purchaseOrder.count({
          where: { vendorId, deletedAt: null },
        }),
        prisma.creditNote.count({ where: { vendorId, deletedAt: null } }),
        prisma.payment.count({
          where: { invoice: { vendorId }, deletedAt: null },
        }),
      ]);
    return { invoices, quotes, purchaseOrders, creditNotes, payments };
  }

  async mergeVendors(
    actorId: string,
    input: {
      survivingVendorId: string;
      sourceVendorId: string;
      missingTaxIdReason?: string;
      acknowledgedSameParty?: boolean;
      keepFields?: VendorKeepMap;
    },
  ) {
    if (input.survivingVendorId === input.sourceVendorId) {
      throw new BadRequestException("Cannot merge a vendor into itself");
    }
    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM vendors WHERE id = ${input.survivingVendorId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM vendors WHERE id = ${input.sourceVendorId} FOR UPDATE`;
      const [surviving, source] = await Promise.all([
        tx.vendor.findUnique({ where: { id: input.survivingVendorId } }),
        tx.vendor.findUnique({ where: { id: input.sourceVendorId } }),
      ]);
      if (!surviving || !source || surviving.deletedAt || source.deletedAt) {
        throw new NotFoundException("Vendor not found");
      }
      if (!surviving.isActive || surviving.mergedIntoId) {
        throw new BadRequestException("Survivor must be an active vendor");
      }
      if (source.mergedIntoId) {
        throw new BadRequestException("Source vendor is already merged");
      }
      if (surviving.entityId !== source.entityId) {
        throw new BadRequestException("Vendors must belong to the same entity");
      }
      const identity = scoreContactIdentity(surviving, source);
      const tax = assertContactMergeAllowed({
        survivingTaxId: surviving.taxId,
        sourceTaxId: source.taxId,
        survivingBranchCode: surviving.branchCode,
        sourceBranchCode: source.branchCode,
        survivingBusinessType: surviving.businessType,
        sourceBusinessType: source.businessType,
        identity,
        missingTaxIdReason: input.missingTaxIdReason,
        acknowledgedSameParty: input.acknowledgedSameParty,
      });
      const [survivingBefore, sourceBefore] = await Promise.all([
        this.vendorOutstandingBySide(tx, surviving.id),
        this.vendorOutstandingBySide(tx, source.id),
      ]);
      const before = {
        receivable: this.round2(
          survivingBefore.receivable + sourceBefore.receivable,
        ),
        payable: this.round2(survivingBefore.payable + sourceBefore.payable),
      };
      const advanceBefore = this.round2(
        (await this.contactAdvanceTotal(tx, surviving.id, surviving.name)) +
          (await this.contactAdvanceTotal(tx, source.id, source.name)),
      );
      await tx.invoice.updateMany({
        where: { vendorId: source.id },
        data: { vendorId: surviving.id },
      });
      await tx.quote.updateMany({
        where: { vendorId: source.id },
        data: { vendorId: surviving.id },
      });
      await tx.purchaseOrder.updateMany({
        where: { vendorId: source.id },
        data: { vendorId: surviving.id },
      });
      await tx.creditNote.updateMany({
        where: { vendorId: source.id },
        data: { vendorId: surviving.id },
      });
      // Advances and overpayments move too. They are matched by `vendorId`
      // where it is set, and by the free-text name for rows that predate that
      // column — otherwise a merged contact's prepaid balance is stranded under
      // a code that can no longer raise a document.
      await tx.customerAdvance.updateMany({
        where: {
          entityId: surviving.entityId,
          OR: [{ vendorId: source.id }, { counterparty: source.name }],
        },
        data: { vendorId: surviving.id, counterparty: surviving.name },
      });
      const keepPatch = applyVendorKeepFields(
        surviving as unknown as Record<string, unknown>,
        source as unknown as Record<string, unknown>,
        input.keepFields ?? {},
      );
      if (Object.keys(keepPatch).length > 0) {
        await tx.vendor.update({
          where: { id: surviving.id },
          data: keepPatch as Prisma.VendorUpdateInput,
        });
      }
      await tx.vendor.update({
        where: { id: source.id },
        data: {
          isActive: false,
          mergedIntoId: surviving.id,
          notes: [
            source.notes,
            input.missingTaxIdReason,
            `Merged into ${surviving.contactId || surviving.name}`,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      });
      const after = await this.vendorOutstandingBySide(tx, surviving.id);
      assertMergeOutstandingUnchanged(
        before.receivable,
        after.receivable,
        "receivable",
      );
      assertMergeOutstandingUnchanged(before.payable, after.payable, "payable");
      const advanceAfter = await this.contactAdvanceTotal(tx, surviving.id);
      assertMergeOutstandingUnchanged(advanceBefore, advanceAfter, "advance");
      const payments = await tx.payment.findMany({
        where: {
          deletedAt: null,
          invoice: { vendorId: surviving.id, type: "payable" },
        },
        select: {
          id: true,
          date: true,
          amount: true,
          reference: true,
          invoice: { select: { invoiceNo: true } },
        },
      });
      const duplicatePayments = scanDuplicatePaymentsAfterMerge(
        payments.map((p) => ({
          id: p.id,
          date: p.date.toISOString().slice(0, 10),
          amount: Number(p.amount),
          reference: p.reference,
          invoiceNo: p.invoice.invoiceNo,
        })),
      );
      const documents = {
        invoices: await tx.invoice.count({
          where: { vendorId: surviving.id, deletedAt: null },
        }),
        payments: payments.length,
      };
      return {
        survivingVendorId: surviving.id,
        sourceVendorId: source.id,
        mergedBy: actorId,
        warning: tax.warning,
        documents,
        duplicatePayments,
        keepFields: input.keepFields ?? {},
      };
    });
  }

  async listVendorDuplicateSuggestions(entityId?: string) {
    const vendors = await prisma.vendor.findMany({
      where: {
        deletedAt: null,
        mergedIntoId: null,
        ...(entityId ? { entityId } : {}),
      },
      select: {
        id: true,
        name: true,
        taxId: true,
        entityId: true,
        contactId: true,
        email: true,
        phone: true,
        branch: true,
        isActive: true,
      },
      take: 1000,
    });
    return groupVendorDuplicateSuggestions(vendors);
  }

  async listInvoices(
    query: InvoiceQuery,
    actorId: string,
    permissions: string[],
  ) {
    const { page, limit, ...filters } = query;
    // Without read-all/admin, force the row filter to the caller's own
    // documents — never trust a client-supplied owner filter (there isn't one
    // on the query schema, but the scope is enforced server-side regardless).
    const createdBy = canReadAllAccounting(permissions) ? undefined : actorId;
    const { data, total } = await accountingRepository.findInvoices(
      { ...filters, createdBy },
      page,
      limit,
    );

    return {
      data: data.map((row) =>
        row.deletedAt ? { ...row, status: "deleted" } : row,
      ),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async createInvoice(input: CreateInvoiceInput, actorId: string) {
    // Activation gate: a brand-new company still in "setup" can't issue
    // documents. Existing entities are grandfathered "active" so this is a
    // no-op for them.
    await this.assertEntityActivated(input.entityId);
    // Tax-month lock (M9): can't add a document dated into a filed VAT month.
    await this.assertTaxMonthOpen(input.entityId, new Date(input.issueDate));

    if (input.type === "payable") {
      await rejectDuplicateVendorTaxInvoice({
        vendorTaxInvoiceNo: input.vendorTaxInvoiceNo,
        findExisting: async () => {
          const no = input.vendorTaxInvoiceNo?.trim();
          if (!no || !input.vendorId) return null;
          return prisma.invoice.findFirst({
            where: {
              entityId: input.entityId,
              vendorId: input.vendorId,
              vendorTaxInvoiceNo: no,
              deletedAt: null,
            },
            select: { id: true },
          });
        },
      });
    }

    const clientNo = input.invoiceNo?.trim() || undefined;
    if (clientNo) {
      const existing = await accountingRepository.findInvoiceByEntityAndNo(
        input.entityId,
        clientNo,
      );
      if (existing) {
        throw new ConflictException(
          `Invoice number "${clientNo}" already exists for this entity`,
        );
      }
    }

    const calc = this.computeInvoiceCalc({
      lineItems: input.lineItems.map((li) => ({
        quantity: Number(li.quantity),
        unitPrice: Number(li.unitPrice),
        lineDiscount: li.lineDiscount,
        vatRate: li.vatRate,
        vatReason: li.vatReason,
        capitalised: li.capitalised,
      })),
      vatRate: input.vatRate,
      taxRate: input.taxRate,
      whtRate: input.whtRate,
      headerDiscount: input.headerDiscount,
      userTotal: input.userTotal,
    });

    const fxSide = accountingFxSide(input.type);
    let exchangeRate: number | undefined;
    let baseAmount: number | undefined;
    let fxRateDate: Date | undefined;
    if (await this.shouldPost(input.entityId)) {
      const base = await this.getBaseCurrency(input.entityId);
      exchangeRate = await this.resolveRateToBase(
        input.currency,
        base,
        new Date(input.issueDate),
        input.exchangeRate,
        `invoice ${clientNo ?? "draft"}`,
        fxSide,
      );
      baseAmount = this.round2(calc.total * exchangeRate);
      fxRateDate = new Date(input.issueDate);
    }

    let invoiceNo = clientNo;
    let draftNo: string | null = null;
    if (!invoiceNo) {
      invoiceNo = await prisma.$transaction((tx) =>
        allocateDraftNumber(tx, input.entityId, "invoice"),
      );
      draftNo = invoiceNo;
    } else if (invoiceNo.startsWith("DRAFT-")) {
      draftNo = invoiceNo;
    }

    return accountingRepository.createInvoice({
      entityId: input.entityId,
      invoiceNo,
      type: input.type,
      counterparty: input.counterparty,
      billToAddress: input.billToAddress ?? null,
      reference: input.reference ?? null,
      paymentTerms: input.paymentTerms ?? null,
      amount: calc.total,
      currency: input.currency,
      exchangeRate,
      baseAmount,
      carryingRate: exchangeRate,
      vatRate: input.vatRate,
      taxLabel: input.taxLabel ?? null,
      taxRate: input.taxRate,
      whtRate: input.whtRate,
      headerDiscount: input.headerDiscount ?? 0,
      roundingAmount: calc.doc.rounding,
      draftNo,
      vendorId: input.vendorId ?? null,
      vendorTaxInvoiceNo: input.vendorTaxInvoiceNo ?? null,
      taxInvoiceReceived: input.taxInvoiceReceived ?? false,
      fxSide,
      fxRateDate: fxRateDate ?? null,
      issueDate: new Date(input.issueDate),
      dueDate: new Date(input.dueDate),
      linkedJeId: input.linkedJeId ?? null,
      notes: input.notes ?? null,
      createdBy: actorId,
      lineItems: input.lineItems.map((li, i) => {
        const computed = calc.doc.lines[i]!;
        return {
          description: li.description,
          quantity: li.quantity,
          unitPrice: li.unitPrice,
          sortOrder: i,
          glAccountId: li.glAccountId ?? null,
          lineDiscount: computed.lineDiscount,
          vatRate: computed.vatRate,
          vatReason: li.vatReason ?? null,
          taxBase: computed.taxBase,
          vatAmount: computed.vatAmount,
          capitalised: computed.capitalised,
        };
      }),
    });
  }

  // Internal single-document fetch — NOT owner-scoped. Used by posting / void /
  // payment / document-render flows that run under their own permission gates.
  // Actor-facing routes must use `getInvoiceByIdForActor`.
  async getInvoiceById(id: string) {
    const invoice = await accountingRepository.findInvoiceById(id);
    if (!invoice) throw new NotFoundException("Invoice not found");
    return invoice;
  }

  // Actor-facing single-document read: 404 if missing, then 403 unless the
  // caller is the owner or a read-all/admin holder. Backs GET /invoices/:id,
  // the PDF/DOCX/XLSX downloads, and the payments sub-resource.
  async getInvoiceByIdForActor(
    id: string,
    actorId: string,
    permissions: string[],
  ) {
    const invoice = await this.getInvoiceById(id);
    assertInvoiceAccess(invoice, actorId, permissions);
    const attachments = await accountingRepository.findActiveLinkedUploads(
      ACCOUNTING_INVOICE_LINKED_TO,
      id,
    );
    return { ...invoice, attachments };
  }

  async updateInvoice(
    id: string,
    input: UpdateInvoiceInput,
    actorId: string,
    permissions: string[],
  ) {
    const invoice = await accountingRepository.findInvoiceById(id);
    if (!invoice) throw new NotFoundException("Invoice not found");
    assertInvoiceAccess(invoice, actorId, permissions);

    // Tax-month lock (M9): can't edit a document whose tax point is in a filed
    // VAT month, nor move one INTO a filed month.
    await this.assertTaxMonthOpen(invoice.entityId, invoice.issueDate);
    if (input.issueDate !== undefined) {
      await this.assertTaxMonthOpen(
        invoice.entityId,
        new Date(input.issueDate),
      );
    }

    const data: Prisma.InvoiceUncheckedUpdateInput = {
      ...(input.invoiceNo !== undefined && { invoiceNo: input.invoiceNo }),
      ...(input.type !== undefined && { type: input.type }),
      ...(input.counterparty !== undefined && {
        counterparty: input.counterparty,
      }),
      ...(input.billToAddress !== undefined && {
        billToAddress: input.billToAddress || null,
      }),
      ...(input.reference !== undefined && {
        reference: input.reference || null,
      }),
      ...(input.paymentTerms !== undefined && {
        paymentTerms: input.paymentTerms || null,
      }),
      ...(input.currency !== undefined && { currency: input.currency }),
      ...(input.vatRate !== undefined && { vatRate: input.vatRate }),
      ...(input.taxLabel !== undefined && {
        taxLabel: input.taxLabel || null,
      }),
      ...(input.taxRate !== undefined && { taxRate: input.taxRate }),
      ...(input.whtRate !== undefined && { whtRate: input.whtRate }),
      ...(input.issueDate !== undefined && {
        issueDate: new Date(input.issueDate),
      }),
      ...(input.dueDate !== undefined && { dueDate: new Date(input.dueDate) }),
      ...(input.linkedJeId !== undefined && {
        linkedJeId: input.linkedJeId || null,
      }),
      ...(input.notes !== undefined && { notes: input.notes || null }),
      ...(input.taxInvoiceReceived !== undefined && {
        taxInvoiceReceived: input.taxInvoiceReceived,
      }),
    };

    // Recompute the stored grand total whenever the lines, discounts, or rates
    // change — using existing values for whichever side wasn't sent.
    let lineItems:
      | {
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
        }[]
      | undefined;

    if (
      input.lineItems !== undefined ||
      input.vatRate !== undefined ||
      input.taxRate !== undefined ||
      input.whtRate !== undefined ||
      input.headerDiscount !== undefined ||
      input.userTotal !== undefined
    ) {
      const vatRate = input.vatRate ?? Number(invoice.vatRate);
      const whtRate = input.whtRate ?? Number(invoice.whtRate);
      const taxRate = input.taxRate ?? Number(invoice.taxRate);
      const headerDiscount =
        input.headerDiscount ?? Number(invoice.headerDiscount ?? 0);
      const effectiveLines =
        input.lineItems ??
        invoice.lineItems.map((li) => ({
          description: li.description,
          quantity: Number(li.quantity),
          unitPrice: Number(li.unitPrice),
          lineDiscount: Number(li.lineDiscount ?? 0),
          vatRate: li.vatRate != null ? Number(li.vatRate) : undefined,
          vatReason: li.vatReason ?? undefined,
          capitalised: li.capitalised === true,
          glAccountId: li.glAccountId ?? undefined,
        }));
      if (effectiveLines.length > 0) {
        const calc = this.computeInvoiceCalc({
          lineItems: effectiveLines.map((li) => ({
            quantity: Number(li.quantity),
            unitPrice: Number(li.unitPrice),
            lineDiscount: li.lineDiscount,
            vatRate: li.vatRate,
            vatReason: li.vatReason,
            capitalised: li.capitalised,
          })),
          vatRate,
          taxRate,
          whtRate,
          headerDiscount,
          userTotal: input.userTotal,
        });
        data.amount = calc.total;
        data.headerDiscount = headerDiscount;
        data.roundingAmount = calc.doc.rounding;

        if (input.lineItems !== undefined) {
          lineItems = input.lineItems.map((li, i) => {
            const computed = calc.doc.lines[i]!;
            return {
              description: li.description,
              quantity: li.quantity,
              unitPrice: li.unitPrice,
              sortOrder: i,
              glAccountId: li.glAccountId ?? null,
              lineDiscount: computed.lineDiscount,
              vatRate: computed.vatRate,
              vatReason: li.vatReason ?? null,
              taxBase: computed.taxBase,
              vatAmount: computed.vatAmount,
              capitalised: computed.capitalised,
            };
          });
        }
      }
    }

    // FX (M8): when the currency changes on a draft, clear the booked rate/base
    // so the send step re-resolves it — a stale rate (e.g. the THB `1` from
    // when the draft was created) must never be silently reused for the new
    // currency. An explicit manual rate is honoured.
    const currencyChanged =
      input.currency !== undefined &&
      input.currency.toUpperCase() !== invoice.currency.toUpperCase();
    if (input.exchangeRate !== undefined) {
      data.exchangeRate = input.exchangeRate;
    } else if (currencyChanged) {
      data.exchangeRate = null;
      data.baseAmount = null;
    }

    const updated = await accountingRepository.updateInvoice(
      id,
      data,
      lineItems,
    );
    const recogniseInputVat =
      invoice.type === "payable" &&
      input.taxInvoiceReceived === true &&
      invoice.taxInvoiceReceived !== true &&
      Boolean(invoice.linkedJeId) &&
      invoice.status !== "draft" &&
      invoice.status !== "cancelled";
    if (recogniseInputVat && (await this.shouldPost(invoice.entityId))) {
      const calc = this.computeInvoiceCalcFromStored(invoice);
      const fxSide = accountingFxSide(invoice.type);
      const base = await this.getBaseCurrency(invoice.entityId);
      const invoiceRate = this.bookedCarryingRate(
        invoice,
        await this.resolveRateToBase(
          invoice.currency,
          base,
          invoice.issueDate,
          invoice.exchangeRate != null
            ? Number(invoice.exchangeRate)
            : undefined,
          `invoice ${invoice.invoiceNo}`,
          fxSide,
        ),
      );
      const taxTotal = this.round2(
        (calc.doc.vatTotal + calc.extraTax) * invoiceRate,
      );
      if (taxTotal > 0) {
        await prisma.$transaction(async (tx) => {
          await assertPostingPeriodOpen(tx, invoice.entityId, new Date());
          const lines = await this.inputVatRecognitionLines(
            tx,
            invoice.entityId,
            taxTotal,
          );
          if (lines.length === 0) return;
          await postMoneyEvent(tx, {
            posting: {
              entityId: invoice.entityId,
              date: new Date(),
              description: `Recognise input VAT ${invoice.invoiceNo}`,
              reference: invoice.invoiceNo,
              sourceType: "bill",
              sourceRef: invoice.id,
              createdBy: actorId,
              lines,
            },
          });
        });
      }
    }
    return updated;
  }

  private round2(n: number): number {
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

  private computeInvoiceCalc(input: {
    lineItems: Array<{
      quantity: number;
      unitPrice: number;
      lineDiscount?: number;
      vatRate?: number;
      vatReason?: string;
      capitalised?: boolean;
    }>;
    vatRate: number;
    taxRate: number;
    whtRate: number;
    headerDiscount?: number;
    userTotal?: number;
  }) {
    const doc = computeArDocument(
      input.lineItems.map((li) => ({
        qty: li.quantity,
        unitPrice: li.unitPrice,
        lineDiscount: li.lineDiscount,
        vatRate: li.vatRate ?? input.vatRate,
        vatReason: li.vatReason,
        capitalised: li.capitalised,
      })),
      input.headerDiscount ?? 0,
      input.userTotal,
    );
    const extraTax = this.round2(doc.subtotal * (input.taxRate / 100));
    const whtAmount = this.round2(doc.subtotal * (input.whtRate / 100));
    const total = this.round2(doc.grandTotal + extraTax - whtAmount);
    return { doc, extraTax, whtAmount, total };
  }

  private computeInvoiceCalcFromStored(invoice: {
    vatRate: unknown;
    taxRate: unknown;
    whtRate: unknown;
    headerDiscount?: unknown;
    roundingAmount?: unknown;
    lineItems: Array<{
      quantity: unknown;
      unitPrice: unknown;
      lineDiscount?: unknown;
      vatRate?: unknown;
      vatReason?: string | null;
      capitalised?: boolean;
    }>;
  }) {
    return this.computeInvoiceCalc({
      lineItems: invoice.lineItems.map((li) => ({
        quantity: Number(li.quantity),
        unitPrice: Number(li.unitPrice),
        lineDiscount: Number(li.lineDiscount ?? 0),
        vatRate: li.vatRate != null ? Number(li.vatRate) : undefined,
        vatReason: li.vatReason ?? undefined,
        capitalised: li.capitalised === true,
      })),
      vatRate: Number(invoice.vatRate),
      taxRate: Number(invoice.taxRate),
      whtRate: Number(invoice.whtRate),
      headerDiscount: Number(invoice.headerDiscount ?? 0),
    });
  }

  private isDraftDocumentNo(invoiceNo: string): boolean {
    return invoiceNo.startsWith("DRAFT-");
  }

  private sameTaxMonth(issueDate: Date, asOf = new Date()): boolean {
    const issue = taxMonthOf(issueDate);
    const bkk = new Date(asOf.getTime() + BANGKOK_OFFSET_MS);
    return (
      issue.year === bkk.getUTCFullYear() &&
      issue.month === bkk.getUTCMonth() + 1
    );
  }

  // Booked carrying rate for remaining AR/AP. Prefers TAS 21 `carryingRate`
  // (set when a revaluation JE is approved) so realised FX is not double-counted.
  private bookedCarryingRate(
    invoice: {
      amount: unknown;
      baseAmount?: unknown;
      exchangeRate?: unknown;
      carryingRate?: unknown;
    },
    fallbackRate: number,
  ): number {
    if (invoice.carryingRate != null) return Number(invoice.carryingRate);
    const amount = Number(invoice.amount);
    if (invoice.baseAmount != null && amount !== 0) {
      return Number(invoice.baseAmount) / amount;
    }
    if (invoice.exchangeRate != null) return Number(invoice.exchangeRate);
    return fallbackRate;
  }

  private async assertLinkedAttachments(
    linkedTo: string | string[],
    linkedId: string,
  ): Promise<void> {
    const linkedTos = Array.isArray(linkedTo) ? linkedTo : [linkedTo];
    const attachments = await prisma.fileUpload.findMany({
      where: {
        linkedId,
        deletedAt: null,
        linkedTo: linkedTos.length === 1 ? linkedTos[0] : { in: linkedTos },
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
  }

  private async bankFeeLines(
    tx: Prisma.TransactionClient,
    opts: { entityId: string; bankGlAccountId: string; feeBase: number },
  ): Promise<PostingLine[]> {
    if (opts.feeBase <= 0) return [];
    return buildBankFeeLines(
      {
        bankCharges: await resolveMappedAccount(
          tx,
          opts.entityId,
          "bank_charges",
        ),
        bank: opts.bankGlAccountId,
      },
      opts.feeBase,
    );
  }

  private async inputVatRecognitionLines(
    tx: Prisma.TransactionClient,
    entityId: string,
    amount: number,
  ): Promise<PostingLine[]> {
    if (amount <= 0) return [];
    const inputVatAccount = await resolveMappedAccount(
      tx,
      entityId,
      "vat_input",
    );
    const deferredVatAccount =
      (await findMappedAccount(tx, entityId, "vat_input_deferred")) ??
      inputVatAccount;
    return buildInputVatRecognitionLines({
      deferredVatAccount,
      inputVatAccount,
      amount,
    });
  }

  private async outputVatRecognitionLines(
    tx: Prisma.TransactionClient,
    entityId: string,
    amount: number,
  ): Promise<PostingLine[]> {
    if (amount <= 0) return [];
    const outputVatAccount = await resolveMappedAccount(
      tx,
      entityId,
      "vat_output",
    );
    const deferredVatAccount =
      (await findMappedAccount(tx, entityId, "vat_output_deferred")) ??
      outputVatAccount;
    return buildOutputVatRecognitionLines({
      deferredVatAccount,
      outputVatAccount,
      amount,
    });
  }

  private async previouslyRecognisedVat(
    tx: Prisma.TransactionClient,
    invoiceId: string,
  ): Promise<number> {
    const agg = await tx.payment.aggregate({
      where: { invoiceId, deletedAt: null },
      _sum: { vatRecognised: true },
    });
    return Number(agg._sum.vatRecognised ?? 0);
  }

  private invoiceVatAmount(invoice: {
    amount: unknown;
    vatRate: unknown;
  }): number {
    const vatPct = Number(invoice.vatRate) || 0;
    if (vatPct === 0) return 0;
    return this.round2(Number(invoice.amount) * (vatPct / (100 + vatPct)));
  }

  private async buildIssuePostingLines(
    tx: Prisma.TransactionClient,
    opts: {
      entityId: string;
      isAr: boolean;
      lineAccount: string | null;
      subtotal: number;
      taxTotal: number;
      rounding: number;
      taxInvoiceReceived?: boolean;
    },
  ): Promise<PostingLine[]> {
    if (opts.isAr) {
      const vatOutput = await resolveMappedAccount(
        tx,
        opts.entityId,
        "vat_output",
      );
      const vatDeferred =
        (await findMappedAccount(tx, opts.entityId, "vat_output_deferred")) ??
        vatOutput;
      return buildInvoiceSendLines(
        {
          arControl: await resolveMappedAccount(
            tx,
            opts.entityId,
            "ar_control",
          ),
          revenue:
            opts.lineAccount ??
            (await resolveMappedAccount(tx, opts.entityId, "revenue_default")),
          vatOutput,
          vatDeferred,
          rounding: await resolveMappedAccount(tx, opts.entityId, "rounding"),
        },
        {
          subtotal: opts.subtotal,
          taxTotal: opts.taxTotal,
          rounding: opts.rounding,
        },
      );
    }
    const vatInput = await resolveMappedAccount(tx, opts.entityId, "vat_input");
    const vatDeferred =
      opts.taxInvoiceReceived === true
        ? undefined
        : ((await findMappedAccount(tx, opts.entityId, "vat_input_deferred")) ??
          vatInput);
    return buildBillRecordLines(
      {
        apControl: await resolveMappedAccount(tx, opts.entityId, "ap_control"),
        expense:
          opts.lineAccount ??
          (await resolveMappedAccount(tx, opts.entityId, "expense_default")),
        vatInput,
        vatDeferred,
      },
      { subtotal: opts.subtotal, taxTotal: opts.taxTotal },
    );
  }

  // Is this entity's account mapping complete? (Gate 2 of posting readiness —
  // the flag being gate 1 is checked separately by the caller.)
  private async isEntityMappingComplete(entityId: string): Promise<boolean> {
    const mapped = await accountingRepository.findAccountMappings(entityId);
    return computeReadiness(
      entityId,
      mapped.map((m) => m.role),
      true,
    ).mappingComplete;
  }

  // Both posting gates for a document: the env flag AND a complete mapping.
  private async shouldPost(entityId: string): Promise<boolean> {
    if (!isGlPostingEnabled()) return false;
    return this.isEntityMappingComplete(entityId);
  }

  // ── FX / multi-currency (M8) ─────────────────────────────────────────────
  // The entity's functional/base currency — the currency the general ledger is
  // kept in. FX gain/loss arises whenever a document's currency differs from
  // it. Defaults to THB (the reporting currency) when unset.
  private async getBaseCurrency(entityId: string): Promise<string> {
    // Read via the repository (whose entity-setup select includes `currency`)
    // rather than a direct prisma call, so unit tests that mock the repository
    // don't need a live database connection.
    const entity = await accountingRepository.findEntitySetup(entityId);
    return (entity?.currency || "THB").toUpperCase();
  }

  // Multiplier that converts `currency` into `base` on `date`
  // (amountBase = amount × rate). Identity when they match. A caller-supplied
  // manual rate wins (M8.3.2 — enter a rate when the day has none); otherwise
  // the ExchangeRate table is consulted and a missing rate is a hard error, not
  // a silent zero.
  private async resolveRateToBase(
    currency: string,
    base: string,
    date: Date,
    manualRate: number | undefined,
    label: string,
    side: AccountingFxSide = "buying",
  ): Promise<number> {
    if (!currency || currency.toUpperCase() === base) return 1;
    if (typeof manualRate === "number" && manualRate > 0) return manualRate;
    try {
      const fx = await resolveAccountingFx(currency, date, side);
      if (fx.source !== "identity") {
        return Number(fx.rate);
      }
    } catch {
      // AccountingFxRate may be absent in unit tests / pre-push DBs.
    }
    const lookup = await createExchangeRateService().resolveRate(
      currency,
      base,
      date,
    );
    if (lookup.source === "missing" || !(lookup.rate > 0)) {
      throw new BadRequestException(
        `No exchange rate for ${currency}→${base} on ` +
          `${date.toISOString().slice(0, 10)} for ${label}. ` +
          `Enter a rate manually on the document.`,
      );
    }
    return lookup.rate;
  }

  // Base-currency settlement lines (AR receipt / AP payment) including the
  // realised FX leg. `invoiceRate` is the rate the receivable/payable was
  // booked at; `settlementRate` the payment-date rate. The fx_gain/fx_loss
  // accounts are resolved ONLY when a non-zero FX delta arises, so THB-only
  // entities (which never map them) post exactly as before.
  private async buildSettlementLines(
    tx: Prisma.TransactionClient,
    opts: {
      entityId: string;
      isAr: boolean;
      bankGlAccountId: string;
      amount: number;
      whtAmount: number;
      invoiceRate: number;
      settlementRate: number;
    },
  ): Promise<PostingLine[]> {
    const bankBase = this.round2(opts.amount * opts.settlementRate);
    const whtBase = this.round2(opts.whtAmount * opts.invoiceRate);
    const settledBase = this.round2(
      (opts.amount + opts.whtAmount) * opts.invoiceRate,
    );
    const fxDelta = this.round2(settledBase - bankBase - whtBase);
    const needFx = Math.abs(fxDelta) > 0.005;
    const fxGain = needFx
      ? await resolveMappedAccount(tx, opts.entityId, "fx_gain")
      : "";
    const fxLoss = needFx
      ? await resolveMappedAccount(tx, opts.entityId, "fx_loss")
      : "";

    if (opts.isAr) {
      return buildArReceiptLines(
        {
          arControl: await resolveMappedAccount(
            tx,
            opts.entityId,
            "ar_control",
          ),
          bank: opts.bankGlAccountId,
          whtReceivable: await resolveMappedAccount(
            tx,
            opts.entityId,
            "wht_receivable",
          ),
          fxGain,
          fxLoss,
        },
        { bankBase, whtBase, arBase: settledBase },
      );
    }
    return buildApPaymentLines(
      {
        apControl: await resolveMappedAccount(tx, opts.entityId, "ap_control"),
        bank: opts.bankGlAccountId,
        whtPayable: await resolveMappedAccount(
          tx,
          opts.entityId,
          "wht_payable",
        ),
        fxGain,
        fxLoss,
      },
      { bankBase, whtBase, apBase: settledBase },
    );
  }

  private async writeOffSettlementLines(
    tx: Prisma.TransactionClient,
    opts: { entityId: string; isAr: boolean; writeOffBase: number },
  ): Promise<PostingLine[]> {
    if (Math.abs(opts.writeOffBase) <= 0.005) return [];
    const writeOff = await resolveMappedAccount(
      tx,
      opts.entityId,
      "settlement_writeoff",
    );
    const control = await resolveMappedAccount(
      tx,
      opts.entityId,
      opts.isAr ? "ar_control" : "ap_control",
    );
    if (opts.isAr) {
      return [
        {
          accountId: writeOff,
          debit: opts.writeOffBase,
          memo: "Short-payment write-off",
        },
        {
          accountId: control,
          credit: opts.writeOffBase,
          memo: "Write off residual AR",
        },
      ];
    }
    return [
      {
        accountId: control,
        debit: opts.writeOffBase,
        memo: "Write off residual AP",
      },
      {
        accountId: writeOff,
        credit: opts.writeOffBase,
        memo: "Short-payment write-off",
      },
    ];
  }

  /**
   * Move an invoice through its lifecycle. When GL posting is enabled AND the
   * entity's mapping is complete, a draft→sent transition posts the AR/AP
   * journal entry and a void posts its reversal — atomically. Otherwise this is
   * exactly the plain status flip it has always been (no journal entry), so the
   * behaviour users have today never regresses.
   */
  async updateInvoiceStatus(
    id: string,
    status: string,
    userId: string,
    permissions: string[],
    options: { skipSecondApprovalGate?: boolean } = {},
  ) {
    const invoice = await accountingRepository.findInvoiceById(id);
    if (!invoice) throw new NotFoundException("Invoice not found");
    // Send / approve / void a document: owner or read-all/admin only.
    assertInvoiceAccess(invoice, userId, permissions);

    const isSend =
      (invoice.status === "draft" ||
        invoice.status === "pending_second_approval") &&
      status === "sent";

    // A document at or over the threshold is HELD before it gets a real number
    // or a journal entry, so sending it back later costs nothing to unwind.
    // The second approver re-enters here with the gate skipped.
    if (isSend && !options.skipSecondApprovalGate) {
      const assessment = await this.assessSecondApproval(invoice);
      if (assessment.split.suspected) {
        logger.warn("Document may be part of a same-day split", {
          invoiceId: id,
          combinedTotal: assessment.split.combinedTotal,
          threshold: assessment.split.threshold,
          documentIds: assessment.split.documentIds,
        });
      }
      if (assessment.required) {
        const held = await accountingRepository.updateInvoiceApproval(id, {
          status: "pending_second_approval",
          approvedById: userId,
          approvedAt: new Date(),
          // Snapshotted: changing the configured limit later must not restate
          // a decision already taken under the old one.
          thresholdApplied: assessment.threshold,
          splitFlagged: assessment.split.suspected,
        });
        return {
          ...held,
          secondApprovalRequired: true,
          splitSuspected: assessment.split.suspected,
        };
      }
      if (assessment.split.suspected) {
        await accountingRepository.updateInvoiceApproval(id, {
          splitFlagged: true,
        });
      }
    }
    const isVoid = status === "cancelled" && invoice.status !== "cancelled";
    const isAr = invoice.type === "receivable";

    if (isVoid) {
      const collected = Number(invoice.amountPaid) > 0;
      const issued = invoice.status !== "draft" || Boolean(invoice.linkedJeId);
      if (collected || (issued && !this.sameTaxMonth(invoice.issueDate))) {
        throw new BadRequestException(CREDIT_NOTE_REQUIRED);
      }
    }

    if (isSend) {
      await this.assertLinkedAttachments(ACCOUNTING_INVOICE_LINKED_TO, id);
    }

    const post =
      (isSend || isVoid) && (await this.shouldPost(invoice.entityId));

    if (!post) {
      if (isSend && this.isDraftDocumentNo(invoice.invoiceNo)) {
        await prisma.$transaction(async (tx) => {
          const invoiceNo = await allocateDocumentNumber(
            tx,
            invoice.entityId,
            isAr ? "invoice" : "bill",
            invoice.issueDate,
          );
          await tx.invoice.update({
            where: { id },
            data: { status, invoiceNo, paidDate: null },
          });
        });
        return this.getInvoiceById(id);
      }
      return accountingRepository.updateInvoice(id, {
        status,
        paidDate: status === "paid" ? new Date() : null,
      });
    }

    const calc = this.computeInvoiceCalcFromStored(invoice);
    const roundingStored = Number(invoice.roundingAmount ?? calc.doc.rounding);
    const fxSide = accountingFxSide(invoice.type);
    const base = await this.getBaseCurrency(invoice.entityId);
    const invoiceRate = await this.resolveRateToBase(
      invoice.currency,
      base,
      invoice.issueDate,
      invoice.exchangeRate != null ? Number(invoice.exchangeRate) : undefined,
      `invoice ${invoice.invoiceNo}`,
      fxSide,
    );
    const subtotal = this.round2(calc.doc.subtotal * invoiceRate);
    const taxTotal = this.round2(
      (calc.doc.vatTotal + calc.extraTax) * invoiceRate,
    );
    const rounding = this.round2(roundingStored * invoiceRate);
    const gross = this.round2(subtotal + taxTotal + rounding);
    const lineAccount = singleLineAccount(invoice.lineItems);

    await prisma.$transaction(async (tx) => {
      await assertPostingPeriodOpen(tx, invoice.entityId, invoice.issueDate);

      if (isSend) {
        const invoiceNo = this.isDraftDocumentNo(invoice.invoiceNo)
          ? await allocateDocumentNumber(
              tx,
              invoice.entityId,
              isAr ? "invoice" : "bill",
              invoice.issueDate,
            )
          : invoice.invoiceNo;
        if (!invoice.linkedJeId && gross > 0) {
          const lines = await this.buildIssuePostingLines(tx, {
            entityId: invoice.entityId,
            isAr,
            lineAccount,
            subtotal,
            taxTotal,
            rounding,
            taxInvoiceReceived: invoice.taxInvoiceReceived === true,
          });
          const entry = await postMoneyEvent(tx, {
            posting: {
              entityId: invoice.entityId,
              date: invoice.issueDate,
              description: `${isAr ? "Invoice" : "Bill"} ${invoiceNo}`,
              reference: invoiceNo,
              sourceType: isAr ? "invoice" : "bill",
              sourceRef: invoice.id,
              createdBy: userId,
              lines,
            },
          });
          await tx.invoice.update({
            where: { id },
            data: {
              status,
              invoiceNo,
              linkedJeId: entry.id,
              paidDate: null,
              exchangeRate: invoiceRate,
              fxSide,
              baseAmount: this.round2(Number(invoice.amount) * invoiceRate),
            },
          });
          return;
        }
        await tx.invoice.update({
          where: { id },
          data: { status, invoiceNo },
        });
        return;
      }

      if (invoice.linkedJeId) {
        const lines = await this.buildIssuePostingLines(tx, {
          entityId: invoice.entityId,
          isAr,
          lineAccount,
          subtotal,
          taxTotal,
          rounding,
          taxInvoiceReceived: invoice.taxInvoiceReceived === true,
        });
        await postMoneyEvent(tx, {
          posting: {
            entityId: invoice.entityId,
            date: new Date(),
            description: `Void ${invoice.invoiceNo}`,
            reference: invoice.invoiceNo,
            sourceType: isAr ? "invoice-void" : "bill-void",
            sourceRef: invoice.id,
            createdBy: userId,
            lines: lines.map((l) => ({
              accountId: l.accountId,
              debit: l.credit,
              credit: l.debit,
              memo: `Reversal: ${l.memo ?? ""}`,
            })),
          },
        });
      }
      await tx.invoice.update({
        where: { id },
        data: { status: "cancelled", linkedJeId: null, paidDate: null },
      });
    });

    return this.getInvoiceById(id);
  }

  // ── Payments (M6) ──────────────────────────────────────────────────────

  /**
   * Record a receipt against an AR invoice or a disbursement against an AP
   * bill. Always writes the Payment + updates amountPaid/status. When posting
   * is enabled+ready, it also posts the receipt/payment journal entry and moves
   * the bank balance — all in one transaction, so the sub-ledger, the GL, and
   * the bank register commit together.
   */
  async recordPayment(
    userId: string,
    invoiceId: string,
    input: RecordPaymentInput,
    permissions: string[],
    // Bank reconciliation: when this payment settles an already-imported bank
    // statement line, its id is threaded onto the bank movement so the imported
    // row is adopted (matched + linked) instead of a duplicate register row
    // being created. See applyBankMovement.
    settleBankTransactionId?: string | null,
  ) {
    const invoice = await accountingRepository.findInvoiceById(invoiceId);
    if (!invoice) throw new NotFoundException("Invoice not found");
    // A receipt/disbursement is a write against the document — owner or
    // read-all/admin only, so a scoped user can't pay another owner's invoice.
    assertInvoiceAccess(invoice, userId, permissions);
    if (!["sent", "partial", "overdue"].includes(invoice.status)) {
      throw new BadRequestException(
        `Cannot record a payment against a ${invoice.status} invoice.`,
      );
    }

    await this.assertLinkedAttachments(
      [ACCOUNTING_INVOICE_LINKED_TO, ACCOUNTING_PAYMENT_LINKED_TO],
      invoiceId,
    );

    const post = await this.shouldPost(invoice.entityId);
    const isAr = invoice.type === "receivable";

    // FX (M8): resolve the settlement-date rate (payment currency → the
    // entity's base currency) and the rate the invoice was booked at, so cash
    // is converted to base and any realised FX difference is posted. The
    // payment currency defaults to the invoice's; everything is identity/1 for a
    // base-currency document.
    const base = await this.getBaseCurrency(invoice.entityId);
    const paymentCurrency = input.currency?.trim() || invoice.currency;
    const fxSide = accountingFxSide(invoice.type);
    const settlementRate = await this.resolveRateToBase(
      paymentCurrency,
      base,
      new Date(input.date),
      input.exchangeRate,
      `payment for ${invoice.invoiceNo}`,
      fxSide,
    );
    const invoiceRate = this.bookedCarryingRate(
      invoice,
      await this.resolveRateToBase(
        invoice.currency,
        base,
        invoice.issueDate,
        invoice.exchangeRate != null ? Number(invoice.exchangeRate) : undefined,
        `invoice ${invoice.invoiceNo}`,
        fxSide,
      ),
    );
    const bankBase = this.round2(input.amount * settlementRate);
    const bankFee = Number(input.bankFee ?? 0);
    const bankFeeBase = this.round2(bankFee * settlementRate);

    // Overpayment → customer/vendor advance (M3): opt-in, same-side, base
    // currency, no-WHT. AR posts customer_advances; AP posts vendor_advances.
    const outstanding = this.round2(
      Number(invoice.amount) - Number(invoice.amountPaid),
    );
    if (input.writeOffRemainder && input.allowOverpayment) {
      throw new BadRequestException(
        "Write-off and overpayment cannot be used on the same receipt",
      );
    }
    const writeOffAmount = input.writeOffRemainder
      ? this.round2(outstanding - input.amount - (input.whtAmount ?? 0))
      : 0;
    if (input.writeOffRemainder) {
      if (!input.writeOffReason?.trim()) {
        throw new BadRequestException("Write-off reason is required");
      }
      if (writeOffAmount <= 0.005) {
        throw new BadRequestException("Nothing remains to write off");
      }
    }
    // An excess is cash that no open document claimed. Withholding tax and a
    // foreign currency used to disqualify it, which meant a customer who
    // over-paid a WHT invoice simply got an error; both are now handled, so the
    // only questions are whether the caller opted in and whether cash is left.
    const canCaptureAdvance =
      input.allowOverpayment && input.amount > outstanding;
    if (canCaptureAdvance && !input.excessKind) {
      throw new BadRequestException(
        "Say what the excess is: an advance for future work (VAT is due on it now) " +
          "or money received in error that will be refunded.",
      );
    }
    if (!canCaptureAdvance) {
      const check = validatePaymentAmount(
        Number(invoice.amount),
        Number(invoice.amountPaid),
        input.amount,
      );
      if (!check.ok) {
        throw new BadRequestException(check.reason ?? "Invalid payment");
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      // Re-read inside the tx so concurrent payments can't over-settle.
      const fresh = await tx.invoice.findUnique({ where: { id: invoiceId } });
      if (!fresh) throw new NotFoundException("Invoice not found");
      // Split the receipt into the part that settles the invoice and any excess
      // that becomes a customer advance. Without the advance gate, `applied` is
      // the whole receipt and the strict recheck still guards over-settlement.
      const freshOutstanding = this.round2(
        Number(fresh.amount) - Number(fresh.amountPaid),
      );
      let applied = input.amount;
      let excess = 0;
      let excessVat = 0;
      if (canCaptureAdvance) {
        applied = Math.max(0, Math.min(input.amount, freshOutstanding));
        excess = computeSettlementExcess({
          cashAmount: input.amount,
          allocatedNet: applied,
        });
        // VAT falls due on an advance at receipt, because this system issues
        // the tax invoice when the money arrives. Money received in error is
        // not a sale, so it carries none. The rate comes from the entity's
        // effective-dated table, never a hardcoded 7.
        if (isAr && input.excessKind === "advance" && excess > 0) {
          const ratePercent = await this.resolveEntityVatRate(
            invoice.entityId,
            new Date(input.date),
            Number(invoice.vatRate ?? 0),
          );
          excessVat = splitAdvanceVat(excess, ratePercent).vat;
        }
      } else {
        const recheck = validatePaymentAmount(
          Number(fresh.amount),
          Number(fresh.amountPaid),
          input.amount,
        );
        if (!recheck.ok) {
          throw new BadRequestException(recheck.reason ?? "Invalid payment");
        }
      }

      await assertPostingPeriodOpen(tx, invoice.entityId, new Date(input.date));
      await tx.$queryRaw`SELECT id FROM invoices WHERE id = ${invoiceId} FOR UPDATE`;

      const receiptNo = isAr
        ? await allocateDocumentNumber(
            tx,
            invoice.entityId,
            "receipt",
            new Date(input.date),
          )
        : null;
      const invoiceVat = this.invoiceVatAmount(invoice);
      const previouslyRecognised = isAr
        ? await this.previouslyRecognisedVat(tx, invoiceId)
        : 0;
      const vatRecognised = isAr
        ? recognisedOutputVat({
            invoiceGross: Number(invoice.amount),
            invoiceVat,
            collected: applied,
            previouslyRecognised,
          })
        : 0;
      const payment = await tx.payment.create({
        data: {
          entityId: invoice.entityId,
          invoiceId,
          bankAccountId: input.bankAccountId,
          date: new Date(input.date),
          amount: input.amount,
          currency: paymentCurrency,
          exchangeRate: settlementRate,
          baseAmount: bankBase,
          receiptNo,
          vatRecognised,
          bankFee,
          whtAmount: input.whtAmount,
          writeOffAmount,
          writeOffReason: input.writeOffRemainder
            ? input.writeOffReason?.trim()
            : null,
          method: input.method,
          reference: input.reference ?? null,
          notes: input.notes ?? null,
          createdBy: userId,
        },
      });

      const newPaid = nextAmountPaid(
        Number(fresh.amountPaid),
        applied + writeOffAmount,
      );
      const settled = settledStatusAfter(Number(fresh.amount), newPaid);
      await tx.invoice.update({
        where: { id: invoiceId },
        data: {
          amountPaid: newPaid,
          status: settled,
          paidDate: settled === "paid" ? new Date(input.date) : null,
        },
      });

      // Capture the overpayment excess as a customer advance (sub-ledger record
      // written whether or not GL posting is enabled).
      let advanceId: string | null = null;
      if (excess > 0) {
        const advance = await tx.customerAdvance.create({
          data: {
            entityId: invoice.entityId,
            counterparty: invoice.counterparty,
            vendorId: invoice.vendorId,
            side: isAr ? "ar" : "ap",
            kind: input.excessKind ?? "refundable",
            currency: paymentCurrency,
            originalAmount: excess,
            balance: excess,
            vatAmount: excessVat,
            taxInvoiceNo: receiptNo,
            status: "open",
            sourcePaymentId: payment.id,
            createdBy: userId,
          },
        });
        advanceId = advance.id;
      }

      if (post) {
        const bank = await tx.bankAccount.findFirst({
          where: { id: input.bankAccountId, deletedAt: null },
          select: { id: true, entityId: true, glAccountId: true },
        });
        if (!bank) throw new BadRequestException("Bank account not found.");
        if (bank.entityId !== invoice.entityId) {
          throw new BadRequestException(
            "Bank account belongs to a different entity than the invoice.",
          );
        }
        if (!bank.glAccountId) {
          throw new BadRequestException(
            "Selected bank account has no GL account mapped; set one before posting payments.",
          );
        }

        const feeLines = await this.bankFeeLines(tx, {
          entityId: invoice.entityId,
          bankGlAccountId: bank.glAccountId,
          feeBase: bankFeeBase,
        });
        if (excess > 0) {
          const lines = isAr
            ? [
                ...buildOverpaymentReceiptLines(
                  {
                    bank: bank.glAccountId,
                    arControl: await resolveMappedAccount(
                      tx,
                      invoice.entityId,
                      "ar_control",
                    ),
                    // An advance and money-received-in-error are different
                    // accounts: one is deferred revenue, the other a debt to
                    // repay in cash.
                    excessAccount: await resolveMappedAccount(
                      tx,
                      invoice.entityId,
                      input.excessKind === "advance"
                        ? "customer_advances"
                        : "customer_overpayments_refundable",
                    ),
                    outputVat:
                      excessVat > 0
                        ? await resolveMappedAccount(
                            tx,
                            invoice.entityId,
                            "vat_output",
                          )
                        : undefined,
                  },
                  { applied, excess, excessVat },
                ),
                ...(await this.outputVatRecognitionLines(
                  tx,
                  invoice.entityId,
                  vatRecognised,
                )),
                ...feeLines,
              ]
            : [
                ...buildOverpaymentPaymentLines(
                  {
                    bank: bank.glAccountId,
                    apControl: await resolveMappedAccount(
                      tx,
                      invoice.entityId,
                      "ap_control",
                    ),
                    vendorAdvances: await resolveMappedAccount(
                      tx,
                      invoice.entityId,
                      input.excessKind === "advance"
                        ? "vendor_advances"
                        : "vendor_overpayments_refundable",
                    ),
                  },
                  { applied, excess },
                ),
                ...feeLines,
              ];
          const entry = await postMoneyEvent(tx, {
            posting: {
              entityId: invoice.entityId,
              date: new Date(input.date),
              description: isAr
                ? `Receipt ${invoice.invoiceNo} (+ customer advance)`
                : `Payment ${invoice.invoiceNo} (+ vendor advance)`,
              reference: invoice.invoiceNo,
              sourceType: "payment",
              sourceRef: payment.id,
              createdBy: userId,
              lines,
            },
            bankMovements: [
              {
                entityId: invoice.entityId,
                bankAccountId: input.bankAccountId,
                amount: input.amount,
                direction: isAr ? "in" : "out",
                date: new Date(input.date),
                description: `${isAr ? "Receipt" : "Payment"} ${invoice.invoiceNo}`,
                source: "payment",
                paymentId: payment.id,
                bankTransactionId: settleBankTransactionId ?? null,
              },
            ],
          });
          await tx.payment.update({
            where: { id: payment.id },
            data: { linkedJeId: entry.id },
          });
          if (advanceId) {
            await tx.customerAdvance.update({
              where: { id: advanceId },
              data: { linkedJeId: entry.id },
            });
          }
        } else {
          const lines = [
            ...(await this.buildSettlementLines(tx, {
              entityId: invoice.entityId,
              isAr,
              bankGlAccountId: bank.glAccountId,
              amount: input.amount,
              whtAmount: input.whtAmount,
              invoiceRate,
              settlementRate,
            })),
            ...(await this.writeOffSettlementLines(tx, {
              entityId: invoice.entityId,
              isAr,
              writeOffBase: this.round2(writeOffAmount * invoiceRate),
            })),
            ...(isAr
              ? await this.outputVatRecognitionLines(
                  tx,
                  invoice.entityId,
                  vatRecognised,
                )
              : []),
            ...feeLines,
          ];

          const entry = await postMoneyEvent(tx, {
            posting: {
              entityId: invoice.entityId,
              date: new Date(input.date),
              description: `Payment ${invoice.invoiceNo}`,
              reference: invoice.invoiceNo,
              sourceType: "payment",
              sourceRef: payment.id,
              createdBy: userId,
              lines,
            },
            bankMovements: [
              {
                entityId: invoice.entityId,
                bankAccountId: input.bankAccountId,
                amount: input.amount,
                direction: isAr ? "in" : "out",
                date: new Date(input.date),
                description: `Payment ${invoice.invoiceNo}`,
                source: "payment",
                paymentId: payment.id,
                bankTransactionId: settleBankTransactionId ?? null,
              },
            ],
          });
          await tx.payment.update({
            where: { id: payment.id },
            data: { linkedJeId: entry.id },
          });
        }
      }

      return { advanceId, excess };
    });

    return {
      invoice: await this.getInvoiceById(invoiceId),
      posted: post,
      advanceCaptured: result.excess > 0 ? result.excess : null,
    };
  }

  /**
   * Multi-invoice settlement (M3/M6): ONE receipt/disbursement clearing MANY
   * invoices. Gated behind ACCOUNTING_SETTLEMENT_V2 (fail-closed). Each
   * allocation's `amount` is the gross settled against that invoice (cash +
   * WHT); the cash that moves is Σ(amount − whtAmount). Posts ONE balanced
   * journal entry (the proven per-invoice settlement lines, concatenated) plus a
   * single bank movement — mirroring recordPayment's GL treatment per invoice.
   */
  async recordAllocatedPayment(
    userId: string,
    input: RecordAllocatedPaymentInput,
    permissions: string[],
  ) {
    if (!isSettlementV2Enabled()) {
      throw new BadRequestException("Multi-invoice settlement is not enabled.");
    }

    // Load + authorise every target invoice. They must share one entity and one
    // AR/AP side — a receipt can't clear a payable, and vice versa.
    type LoadedInvoice = NonNullable<
      Awaited<ReturnType<typeof accountingRepository.findInvoiceById>>
    >;
    const invoices: LoadedInvoice[] = [];
    for (const alloc of input.allocations) {
      const inv = await accountingRepository.findInvoiceById(alloc.invoiceId);
      if (!inv) {
        throw new NotFoundException(`Invoice ${alloc.invoiceId} not found`);
      }
      assertInvoiceAccess(inv, userId, permissions);
      if (!["sent", "partial", "overdue"].includes(inv.status)) {
        throw new BadRequestException(
          `Cannot settle a ${inv.status} invoice (${inv.invoiceNo}).`,
        );
      }
      invoices.push(inv);
    }
    const entityId = invoices[0].entityId;
    const isAr = invoices[0].type === "receivable";
    if (invoices.some((i) => i.entityId !== entityId)) {
      throw new BadRequestException("All invoices must belong to one entity.");
    }
    if (invoices.some((i) => (i.type === "receivable") !== isAr)) {
      throw new BadRequestException(
        "A settlement cannot mix receivable and payable invoices.",
      );
    }

    // Validate the allocations against the open balances (pure engine).
    const outstanding = new Map(
      invoices.map((i) => [
        i.id,
        this.round2(Number(i.amount) - Number(i.amountPaid)),
      ]),
    );
    const v = validateAllocations(
      input.allocations.map((a) => ({
        invoiceId: String(a.invoiceId),
        amount: Number(a.amount),
        whtAmount: Number(a.whtAmount ?? 0),
      })),
      outstanding,
    );
    if (!v.valid) throw new BadRequestException(v.errors[0]);

    const post = await this.shouldPost(entityId);
    const base = await this.getBaseCurrency(entityId);
    const paymentCurrency = input.currency?.trim() || invoices[0].currency;
    const fxSide = accountingFxSide(invoices[0].type);
    const settlementRate = await this.resolveRateToBase(
      paymentCurrency,
      base,
      new Date(input.date),
      input.exchangeRate,
      "multi-invoice settlement",
      fxSide,
    );
    const byId = new Map(invoices.map((i) => [i.id, i]));
    const invoiceRates = new Map<string, number>();
    for (const inv of invoices) {
      invoiceRates.set(
        inv.id,
        this.bookedCarryingRate(
          inv,
          await this.resolveRateToBase(
            inv.currency,
            base,
            inv.issueDate,
            inv.exchangeRate != null ? Number(inv.exchangeRate) : undefined,
            `invoice ${inv.invoiceNo}`,
            accountingFxSide(inv.type),
          ),
        ),
      );
    }

    // Each allocation `amount` is the NET cash applied to its invoice (WHT is
    // additional); the cash that moves is Σ amount, mirroring recordPayment.
    const totalCash = v.totalAmount;
    const totalWht = v.totalWht;
    const primaryInvoiceId = input.allocations[0].invoiceId;

    const payment = await prisma.$transaction(async (tx) => {
      await assertPostingPeriodOpen(tx, entityId, new Date(input.date));

      // Resolve the bank GL account up front when posting, so the settlement
      // lines are built once with the real account.
      let bankGlAccountId = "";
      if (post) {
        const bank = await tx.bankAccount.findFirst({
          where: { id: input.bankAccountId, deletedAt: null },
          select: { id: true, entityId: true, glAccountId: true },
        });
        if (!bank) throw new BadRequestException("Bank account not found.");
        if (bank.entityId !== entityId) {
          throw new BadRequestException(
            "Bank account belongs to a different entity than the invoices.",
          );
        }
        if (!bank.glAccountId) {
          throw new BadRequestException(
            "Selected bank account has no GL account mapped; set one before posting payments.",
          );
        }
        bankGlAccountId = bank.glAccountId;
      }

      const receiptNo = isAr
        ? await allocateDocumentNumber(
            tx,
            entityId,
            "receipt",
            new Date(input.date),
          )
        : null;
      const created = await tx.payment.create({
        data: {
          entityId,
          invoiceId: primaryInvoiceId,
          bankAccountId: input.bankAccountId,
          date: new Date(input.date),
          amount: totalCash,
          currency: paymentCurrency,
          exchangeRate: settlementRate,
          baseAmount: this.round2(totalCash * settlementRate),
          receiptNo,
          vatRecognised: 0,
          whtAmount: totalWht,
          method: input.method,
          reference: input.reference ?? null,
          notes: input.notes ?? null,
          createdBy: userId,
        },
      });

      // Per allocation: re-validate for concurrency, write the allocation row,
      // bump the invoice's sub-ledger, and (when posting) collect its balanced
      // settlement lines. Concatenated balanced sets stay balanced.
      const lines: PostingLine[] = [];
      let vatRecognisedTotal = 0;
      for (const alloc of input.allocations) {
        const fresh = await tx.invoice.findUnique({
          where: { id: alloc.invoiceId },
        });
        if (!fresh) throw new NotFoundException("Invoice not found");
        const recheck = validatePaymentAmount(
          Number(fresh.amount),
          Number(fresh.amountPaid),
          alloc.amount,
        );
        if (!recheck.ok) {
          throw new BadRequestException(recheck.reason ?? "Invalid allocation");
        }

        const rate = invoiceRates.get(alloc.invoiceId)!;

        await tx.paymentAllocation.create({
          data: {
            paymentId: created.id,
            invoiceId: alloc.invoiceId,
            amount: alloc.amount,
            whtAmount: alloc.whtAmount,
            baseAmount: this.round2(alloc.amount * settlementRate),
          },
        });

        const newPaid = nextAmountPaid(Number(fresh.amountPaid), alloc.amount);
        const settled = settledStatusAfter(Number(fresh.amount), newPaid);
        await tx.invoice.update({
          where: { id: alloc.invoiceId },
          data: {
            amountPaid: newPaid,
            status: settled,
            paidDate: settled === "paid" ? new Date(input.date) : null,
          },
        });

        let vatRecognised = 0;
        if (isAr) {
          const inv = byId.get(alloc.invoiceId)!;
          vatRecognised = recognisedOutputVat({
            invoiceGross: Number(inv.amount),
            invoiceVat: this.invoiceVatAmount(inv),
            collected: alloc.amount,
            previouslyRecognised: await this.previouslyRecognisedVat(
              tx,
              alloc.invoiceId,
            ),
          });
          vatRecognisedTotal = this.round2(vatRecognisedTotal + vatRecognised);
        }
        if (post) {
          lines.push(
            ...(await this.buildSettlementLines(tx, {
              entityId,
              isAr,
              bankGlAccountId,
              amount: alloc.amount,
              whtAmount: alloc.whtAmount,
              invoiceRate: rate,
              settlementRate,
            })),
            ...(await this.outputVatRecognitionLines(
              tx,
              entityId,
              vatRecognised,
            )),
          );
        }
      }

      if (post) {
        const entry = await postMoneyEvent(tx, {
          posting: {
            entityId,
            date: new Date(input.date),
            description: `Settlement of ${input.allocations.length} invoice(s)`,
            reference: byId.get(primaryInvoiceId)?.invoiceNo,
            sourceType: "payment",
            sourceRef: created.id,
            createdBy: userId,
            lines,
          },
          bankMovements: [
            {
              entityId,
              bankAccountId: input.bankAccountId,
              amount: totalCash,
              direction: isAr ? "in" : "out",
              date: new Date(input.date),
              description: `Settlement (${input.allocations.length} invoices)`,
              source: "payment",
              paymentId: created.id,
            },
          ],
        });
        await tx.payment.update({
          where: { id: created.id },
          data: {
            linkedJeId: entry.id,
            vatRecognised: vatRecognisedTotal,
          },
        });
      } else if (vatRecognisedTotal > 0) {
        await tx.payment.update({
          where: { id: created.id },
          data: { vatRecognised: vatRecognisedTotal },
        });
      }

      return created;
    });

    return {
      paymentId: payment.id,
      invoicesSettled: input.allocations.length,
      totalCash,
      totalWht,
      posted: post,
    };
  }

  // Payment run (M6): pay many supplier bills at once. Lines are grouped by
  // payee and each group is settled as ONE bank payment via the (flag-gated,
  // tested) multi-invoice write path — no new money-math here. Bills are
  // pre-validated (payable, single entity, access) before any payment is
  // created; each supplier group is then its own payment (not one atomic
  // transaction across suppliers).
  async runPaymentBatch(
    userId: string,
    input: PaymentRunInput,
    permissions: string[],
  ) {
    if (!isSettlementV2Enabled()) {
      throw new BadRequestException("Multi-invoice settlement is not enabled.");
    }

    type LoadedInvoice = NonNullable<
      Awaited<ReturnType<typeof accountingRepository.findInvoiceById>>
    >;
    const invById = new Map<string, LoadedInvoice>();
    for (const line of input.lines) {
      const inv = await accountingRepository.findInvoiceById(line.invoiceId);
      if (!inv) {
        throw new NotFoundException(`Invoice ${line.invoiceId} not found`);
      }
      assertInvoiceAccess(inv, userId, permissions);
      if (inv.type !== "payable") {
        throw new BadRequestException(
          `Payment runs pay supplier (payable) bills only (${inv.invoiceNo}).`,
        );
      }
      if (!["sent", "partial", "overdue"].includes(inv.status)) {
        throw new BadRequestException(
          `Cannot settle a ${inv.status} bill (${inv.invoiceNo}).`,
        );
      }
      invById.set(line.invoiceId, inv);
    }
    if (new Set([...invById.values()].map((i) => i.entityId)).size > 1) {
      throw new BadRequestException(
        "A payment run must be within a single entity.",
      );
    }

    const payeeKeyOf = (id: string) => {
      const inv = invById.get(id);
      return inv?.vendorId ?? `name:${inv?.counterparty ?? id}`;
    };
    const groups = groupLinesByPayee(
      input.lines.map((l) => ({
        invoiceId: l.invoiceId,
        amount: Number(l.amount),
        whtAmount: Number(l.whtAmount ?? 0),
      })),
      payeeKeyOf,
    );

    // Validate EVERY group against the open balances BEFORE any payment moves,
    // so a bad bill (over-allocation, duplicate, WHT > amount) can't leave a
    // partial run behind — recordAllocatedPayment manages its own transaction,
    // so hoisting the checks here is the practical equivalent of all-or-nothing
    // at the first money movement. (A runtime failure mid-loop is still
    // possible; true cross-supplier atomicity would need a shared transaction.)
    const outstanding = new Map<string, number>(
      [...invById.values()].map((i) => [
        i.id,
        this.round2(Number(i.amount) - Number(i.amountPaid)),
      ]),
    );
    for (const g of groups) {
      const v = validateAllocations(g.lines, outstanding);
      if (!v.valid) throw new BadRequestException(v.errors[0]);
    }

    const payments: Array<{
      payeeKey: string;
      paymentId: string;
      invoicesSettled: number;
      totalCash: number;
      totalWht: number;
      posted: boolean;
    }> = [];
    for (const g of groups) {
      const res = await this.recordAllocatedPayment(
        userId,
        {
          bankAccountId: input.bankAccountId,
          date: input.date,
          method: input.method,
          reference: input.reference,
          allocations: g.lines,
        },
        permissions,
      );
      payments.push({ payeeKey: g.payeeKey, ...res });
    }

    return {
      paymentsCreated: payments.length,
      totalCash: this.round2(payments.reduce((s, p) => s + p.totalCash, 0)),
      totalWht: this.round2(payments.reduce((s, p) => s + p.totalWht, 0)),
      payments,
    };
  }

  async listPaymentsForInvoice(
    invoiceId: string,
    actorId: string,
    permissions: string[],
  ) {
    await this.getInvoiceByIdForActor(invoiceId, actorId, permissions);
    return accountingRepository.findPaymentsForInvoice(invoiceId);
  }

  async listPayments(
    query: PaymentListQuery,
    actorId: string,
    permissions: string[],
  ) {
    const { page, limit, ...filters } = query;
    const createdBy = canReadAllAccounting(permissions) ? undefined : actorId;
    const { data, total } = await accountingRepository.findPayments(
      { ...filters, createdBy },
      page,
      limit,
    );
    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  // Withholding-tax certificate (Form 50 Bis) PDF for a supplier payment we
  // withheld tax on (M6). Payable payments with WHT only. Owner/read-all scoped.
  async getWhtCertificate(
    paymentId: string,
    actorId: string,
    permissions: string[],
  ): Promise<Buffer> {
    const payment =
      await accountingRepository.findPaymentForWhtCertificate(paymentId);
    if (!payment) throw new NotFoundException("Payment not found");
    assertInvoiceAccess(payment.invoice, actorId, permissions);
    if (payment.invoice.type !== "payable") {
      throw new BadRequestException(
        "WHT certificates are issued for supplier (payable) payments only.",
      );
    }
    if (Number(payment.whtAmount) <= 0) {
      throw new BadRequestException("This payment did not withhold any tax.");
    }
    const company = await this.getInvoiceCompany();
    const data = buildWhtCertificateData(
      {
        paymentId: payment.id,
        date: payment.date,
        currency: payment.currency,
        exchangeRate: Number(payment.exchangeRate ?? 1),
        whtAmount: Number(payment.whtAmount),
        invoice: {
          counterparty: payment.invoice.counterparty,
          whtRate: Number(payment.invoice.whtRate),
          vendor: payment.invoice.vendor,
        },
      },
      company,
    );
    return buildWhtCertificatePdfBuffer(data);
  }

  async getTaxInvoicePdf(
    paymentId: string,
    actorId: string,
    permissions: string[],
  ): Promise<Buffer> {
    const payment =
      await accountingRepository.findPaymentForWhtCertificate(paymentId);
    if (!payment) throw new NotFoundException("Payment not found");
    assertInvoiceAccess(payment.invoice, actorId, permissions);
    if (payment.invoice.type !== "receivable") {
      throw new BadRequestException(
        "Tax invoices print on customer receipts only.",
      );
    }
    if (!payment.receiptNo) {
      throw new BadRequestException("This receipt has no tax-invoice number.");
    }
    const company = await this.getInvoiceCompany();
    const data = buildTaxInvoiceData(
      {
        receiptNo: payment.receiptNo,
        date: payment.date,
        invoiceNo: payment.invoice.invoiceNo,
        counterparty: payment.invoice.counterparty,
        taxId: payment.invoice.vendor?.taxId ?? "",
        address: payment.invoice.vendor?.addressEn ?? "",
        currency: payment.currency ?? payment.invoice.currency,
        exchangeRate: Number(payment.exchangeRate ?? 1),
        amount: Number(payment.amount),
        vatRecognised: Number(payment.vatRecognised),
        whtAmount: Number(payment.whtAmount),
        bankFee: Number(payment.bankFee),
      },
      company,
    );
    return buildTaxInvoicePdfBuffer(data);
  }

  async markWhtCertificateReceived(paymentId: string, _actorId: string) {
    const payment = await accountingRepository.findPaymentById(paymentId);
    if (!payment) throw new NotFoundException("Payment not found");
    if (payment.invoice.type !== "receivable") {
      throw new BadRequestException(
        "Pending WHT certificates are tracked on customer receipts.",
      );
    }
    if (Number(payment.whtAmount) <= 0) {
      throw new BadRequestException("This receipt has no WHT.");
    }
    return prisma.payment.update({
      where: { id: paymentId },
      data: { whtCertificateReceivedAt: new Date() },
    });
  }

  async getStatutoryReports(query: TaxReportQuery) {
    const from = new Date(`${query.startDate}T00:00:00.000Z`);
    const to = new Date(`${query.endDate}T23:59:59.999Z`);
    const yearMonth = query.startDate.slice(0, 7).replace("-", "");
    const [journals, invoices, receipts, bills, payments, deletedFiles] =
      await Promise.all([
        prisma.journalEntry.findMany({
          where: {
            entityId: query.entityId,
            date: { gte: from, lte: to },
            entryNo: { startsWith: `JE${yearMonth}` },
          },
          select: {
            entryNo: true,
            status: true,
            cancelledAt: true,
            id: true,
          },
        }),
        prisma.invoice.findMany({
          where: {
            entityId: query.entityId,
            type: "receivable",
            issueDate: { gte: from, lte: to },
            invoiceNo: { startsWith: `INV${yearMonth}` },
          },
          select: {
            invoiceNo: true,
            status: true,
            cancelledAt: true,
          },
        }),
        prisma.payment.findMany({
          where: {
            entityId: query.entityId,
            date: { gte: from, lte: to },
            receiptNo: { startsWith: `RCP${yearMonth}` },
            deletedAt: null,
          },
          select: {
            receiptNo: true,
            invoice: { select: { type: true } },
          },
        }),
        prisma.invoice.findMany({
          where: {
            entityId: query.entityId,
            type: "payable",
            issueDate: { gte: from, lte: to },
            invoiceNo: { startsWith: `EXP${yearMonth}` },
          },
          select: { invoiceNo: true, status: true, cancelledAt: true },
        }),
        prisma.payment.findMany({
          where: {
            entityId: query.entityId,
            deletedAt: null,
            invoice: { type: "receivable" },
            whtAmount: { gt: 0 },
            date: { gte: from, lte: to },
          },
          select: {
            id: true,
            receiptNo: true,
            date: true,
            whtAmount: true,
            whtCertificateReceivedAt: true,
            invoice: { select: { invoiceNo: true, counterparty: true } },
          },
        }),
        prisma.fileUpload.findMany({
          where: {
            deletedAt: { not: null },
            linkedTo: {
              in: [
                ACCOUNTING_JOURNAL_LINKED_TO,
                ACCOUNTING_INVOICE_LINKED_TO,
                ACCOUNTING_PAYMENT_LINKED_TO,
              ],
            },
            createdAt: { gte: from, lte: to },
          },
          select: {
            id: true,
            originalName: true,
            linkedTo: true,
            linkedId: true,
            deletedAt: true,
            deletedBy: true,
          },
          take: 500,
        }),
      ]);

    const vatOnIssue = await prisma.invoice.findMany({
      where: {
        entityId: query.entityId,
        type: "receivable",
        status: { notIn: ["draft", "cancelled"] },
        issueDate: { gte: from, lte: to },
        deletedAt: null,
      },
      select: { amount: true, vatRate: true, lineItems: true },
    });
    const issuedDeferredVat = vatOnIssue.reduce((sum, inv) => {
      const lineVat = inv.lineItems.reduce(
        (s, li) => s + Number(li.vatAmount ?? 0),
        0,
      );
      if (lineVat > 0) return sum + lineVat;
      const net = inv.lineItems.reduce(
        (s, li) => s + Number(li.quantity) * Number(li.unitPrice),
        0,
      );
      return sum + this.round2(net * (Number(inv.vatRate) / 100));
    }, 0);
    const collected = await prisma.payment.aggregate({
      where: {
        entityId: query.entityId,
        deletedAt: null,
        date: { gte: from, lte: to },
        invoice: { type: "receivable" },
      },
      _sum: { vatRecognised: true },
    });
    const remainingRows = await prisma.invoice.findMany({
      where: {
        entityId: query.entityId,
        type: "receivable",
        status: { in: ["sent", "partial", "overdue"] },
        deletedAt: null,
      },
      select: {
        amount: true,
        amountPaid: true,
        vatRate: true,
        lineItems: true,
      },
    });
    const remainingDeferredVat = remainingRows.reduce((sum, inv) => {
      const lineVat = inv.lineItems.reduce(
        (s, li) => s + Number(li.vatAmount ?? 0),
        0,
      );
      const vat =
        lineVat > 0
          ? lineVat
          : this.round2(
              inv.lineItems.reduce(
                (s, li) => s + Number(li.quantity) * Number(li.unitPrice),
                0,
              ) *
                (Number(inv.vatRate) / 100),
            );
      const openRatio =
        Number(inv.amount) === 0
          ? 0
          : (Number(inv.amount) - Number(inv.amountPaid)) / Number(inv.amount);
      return sum + this.round2(vat * openRatio);
    }, 0);

    const journalIds = journals
      .filter(
        (j) => ["posted", "approved"].includes(j.status) && !j.cancelledAt,
      )
      .map((j) => j.id);
    const attached = journalIds.length
      ? await prisma.fileUpload.findMany({
          where: {
            linkedTo: ACCOUNTING_JOURNAL_LINKED_TO,
            linkedId: { in: journalIds },
            deletedAt: null,
          },
          select: { linkedId: true },
        })
      : [];
    const attachedSet = new Set(attached.map((f) => f.linkedId));
    const zeroAttachmentJournals = journals
      .filter(
        (j) =>
          ["posted", "approved"].includes(j.status) &&
          !j.cancelledAt &&
          !attachedSet.has(j.id),
      )
      .map((j) => j.entryNo);

    const numbered = (
      prefix: string,
      rows: Array<{ number: string; cancelled: boolean; status: string }>,
    ) =>
      buildNumberControlReport({
        prefix,
        yearMonth,
        padWidth: 3,
        issued: rows,
      });

    return {
      entityId: query.entityId,
      startDate: query.startDate,
      endDate: query.endDate,
      numberControl: {
        je: numbered(
          "JE",
          journals.map((j) => ({
            number: j.entryNo,
            status: j.status,
            cancelled: Boolean(j.cancelledAt) || j.status === "cancelled",
          })),
        ),
        inv: numbered(
          "INV",
          invoices.map((i) => ({
            number: i.invoiceNo,
            status: i.status,
            cancelled: Boolean(i.cancelledAt) || i.status === "cancelled",
          })),
        ),
        rcp: numbered(
          "RCP",
          receipts
            .filter((p) => p.receiptNo)
            .map((p) => ({
              number: p.receiptNo!,
              status: "posted",
              cancelled: false,
            })),
        ),
        exp: numbered(
          "EXP",
          bills.map((i) => ({
            number: i.invoiceNo,
            status: i.status,
            cancelled: Boolean(i.cancelledAt) || i.status === "cancelled",
          })),
        ),
      },
      deferredVatRecon: buildDeferredVatRecon({
        issuedDeferredVat,
        collectedRecognisedVat: Number(collected._sum.vatRecognised ?? 0),
        remainingDeferredVat,
      }),
      pendingWhtCertificates: payments
        .filter((p) => !p.whtCertificateReceivedAt)
        .map((p) => ({
          paymentId: p.id,
          receiptNo: p.receiptNo,
          date: p.date.toISOString().slice(0, 10),
          counterparty: p.invoice.counterparty,
          invoiceNo: p.invoice.invoiceNo,
          whtAmount: Number(p.whtAmount),
        })),
      zeroAttachmentJournals,
      attachmentDeletions: deletedFiles.map((f) => ({
        id: f.id,
        originalName: f.originalName,
        linkedTo: f.linkedTo,
        linkedId: f.linkedId,
        deletedAt: f.deletedAt?.toISOString() ?? null,
        deletedBy: f.deletedBy,
      })),
    };
  }

  /** Void a payment: reverse its journal entry + bank movement, restore the
   * invoice balance, and soft-delete it. Blocked if it sits in a reconciled
   * period. */
  async voidPayment(userId: string, paymentId: string) {
    const payment = await accountingRepository.findPaymentById(paymentId);
    if (!payment) throw new NotFoundException("Payment not found");
    const invoice = payment.invoice;
    const isAr = invoice.type === "receivable";

    // Customer-advance-linked payments (M3) can't go through the standard void:
    // it assumes payment.amount == the amountPaid delta and reverses via
    // buildSettlementLines, which would leave the advance dangling and the GL
    // half-reversed. Block both shapes with a clear message; unwinding advances
    // is a dedicated follow-up.
    if (payment.method === "customer-advance") {
      throw new BadRequestException(
        "This settlement was funded by a customer advance. Voiding advance " +
          "applications is not supported yet.",
      );
    }
    const sourcedAdvance =
      await accountingRepository.findCustomerAdvanceBySourcePayment(paymentId);
    if (sourcedAdvance) {
      throw new BadRequestException(
        "This receipt captured a customer advance and cannot be voided " +
          "directly. Reverse or apply the advance first.",
      );
    }

    await prisma.$transaction(async (tx) => {
      if (await paymentReconciled(tx, paymentId)) {
        throw new BadRequestException(
          "Payment is in a reconciled bank period and cannot be voided.",
        );
      }

      if (payment.linkedJeId && payment.bankAccount?.glAccountId) {
        // Resolve the invoice's booked rate the SAME way recordPayment did, so
        // the reversal rebuilds at the identical rate and fully unwinds the GL.
        // A null stored rate must re-resolve (not fall back to 1), or a foreign
        // invoice whose rate was cleared leaves a ghost AR/AP + FX balance.
        const base = await this.getBaseCurrency(invoice.entityId);
        const fxSide = accountingFxSide(invoice.type);
        const invoiceRate = this.bookedCarryingRate(
          invoice,
          await this.resolveRateToBase(
            invoice.currency,
            base,
            invoice.issueDate,
            invoice.exchangeRate != null
              ? Number(invoice.exchangeRate)
              : undefined,
            `invoice ${invoice.invoiceNo}`,
            fxSide,
          ),
        );
        const settlementRate =
          payment.exchangeRate != null ? Number(payment.exchangeRate) : 1;
        // Rebuild the original settlement lines (same base amounts + realised
        // FX leg) and reverse them by swapping debit/credit below. The
        // settlement rate is read back from the payment row it was stored on.
        const lines = [
          ...(await this.buildSettlementLines(tx, {
            entityId: invoice.entityId,
            isAr,
            bankGlAccountId: payment.bankAccount.glAccountId,
            amount: Number(payment.amount),
            whtAmount: Number(payment.whtAmount),
            invoiceRate,
            settlementRate,
          })),
          ...(isAr
            ? await this.outputVatRecognitionLines(
                tx,
                invoice.entityId,
                Number(payment.vatRecognised ?? 0),
              )
            : []),
          ...(await this.bankFeeLines(tx, {
            entityId: invoice.entityId,
            bankGlAccountId: payment.bankAccount.glAccountId,
            feeBase: this.round2(Number(payment.bankFee ?? 0) * settlementRate),
          })),
        ];
        await postMoneyEvent(tx, {
          posting: {
            entityId: invoice.entityId,
            date: new Date(),
            description: `Void payment ${invoice.invoiceNo}`,
            reference: invoice.invoiceNo,
            sourceType: "payment-void",
            sourceRef: paymentId,
            createdBy: userId,
            lines: lines.map((l) => ({
              accountId: l.accountId,
              debit: l.credit,
              credit: l.debit,
              memo: `Reversal: ${l.memo ?? ""}`,
            })),
          },
          bankMovements: [
            {
              entityId: invoice.entityId,
              bankAccountId: payment.bankAccount.id,
              amount: Number(payment.amount),
              direction: isAr ? "out" : "in",
              date: new Date(),
              description: `Void payment ${invoice.invoiceNo}`,
              source: "payment-void",
              paymentId,
            },
          ],
        });
      }

      const fresh = await tx.invoice.findUnique({ where: { id: invoice.id } });
      if (!fresh) throw new NotFoundException("Invoice not found");
      const restored = Math.max(
        0,
        this.round2(Number(fresh.amountPaid) - Number(payment.amount)),
      );
      await tx.invoice.update({
        where: { id: invoice.id },
        data: {
          amountPaid: restored,
          status: restored <= 0.005 ? "sent" : "partial",
          paidDate: null,
        },
      });
      await tx.payment.update({
        where: { id: paymentId },
        data: softDeleteUpdate(),
      });
    });

    return this.getInvoiceById(invoice.id);
  }

  // ── Bank accounts (M4) ─────────────────────────────────────────────────

  async listBankAccounts(query: BankAccountQuery) {
    return accountingRepository.findBankAccounts(query);
  }

  async getBankAccountById(id: string) {
    const account = await accountingRepository.findBankAccountById(id);
    if (!account) throw new NotFoundException("Bank account not found");
    return account;
  }

  async createBankAccount(input: CreateBankAccountInput) {
    return accountingRepository.createBankAccount(input);
  }

  async updateBankAccount(id: string, input: UpdateBankAccountInput) {
    await this.getBankAccountById(id);
    return accountingRepository.updateBankAccount(id, input);
  }

  async deleteBankAccount(id: string) {
    await this.getBankAccountById(id);
    const usage = await accountingRepository.countBankAccountUsage(id);
    if (usage > 0) {
      throw new ConflictException(
        "This account has transactions or payments; deactivate it instead of deleting.",
      );
    }
    return accountingRepository.softDeleteBankAccount(id);
  }

  // ── Financial reports (M19 / M20) ──────────────────────────────────────

  private static readonly FY_START_KEY = "accounting.fiscal_year_start";

  // Admin-editable fiscal-year start (month/day). Defaults to 1 January.
  async getFiscalYearStartConfig(): Promise<{
    startMonth: number;
    startDay: number;
  }> {
    const row = await prisma.systemSetting.findUnique({
      where: { key: AccountingService.FY_START_KEY },
    });
    const v = row?.value;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      return {
        startMonth: typeof o.startMonth === "number" ? o.startMonth : 1,
        startDay: typeof o.startDay === "number" ? o.startDay : 1,
      };
    }
    return { startMonth: 1, startDay: 1 };
  }

  private static asOfDate(asOf?: string): Date {
    return asOf ? new Date(`${asOf}T23:59:59.999Z`) : new Date();
  }

  async getTrialBalance(query: ReportAsOfQuery) {
    const asOf = AccountingService.asOfDate(query.asOf);
    const rows = await accountingRepository.getAccountActivity({
      entityId: query.entityId,
      to: asOf,
    });
    return {
      asOf: asOf.toISOString().slice(0, 10),
      ...buildTrialBalance(rows),
    };
  }

  async getProfitAndLoss(query: ReportPeriodQuery) {
    const from = new Date(`${query.startDate}T00:00:00.000Z`);
    const to = new Date(`${query.endDate}T23:59:59.999Z`);
    const rows = await accountingRepository.getAccountActivity({
      entityId: query.entityId,
      from,
      to,
      types: ["revenue", "expense"],
    });
    return {
      startDate: query.startDate,
      endDate: query.endDate,
      ...buildProfitAndLoss(rows),
    };
  }

  async getBalanceSheet(query: ReportAsOfQuery) {
    const asOf = AccountingService.asOfDate(query.asOf);
    const [asOfRows, fyCfg] = await Promise.all([
      accountingRepository.getAccountActivity({
        entityId: query.entityId,
        to: asOf,
      }),
      this.getFiscalYearStartConfig(),
    ]);
    const fyStart = fiscalYearStartOnOrBefore(
      asOf,
      fyCfg.startMonth,
      fyCfg.startDay,
    );
    const cyRows = await accountingRepository.getAccountActivity({
      entityId: query.entityId,
      from: fyStart,
      to: asOf,
      types: ["revenue", "expense"],
    });
    const currentYearEarnings = netIncome(cyRows);
    return {
      asOf: asOf.toISOString().slice(0, 10),
      fiscalYearStart: fyStart.toISOString().slice(0, 10),
      ...buildBalanceSheet(asOfRows, currentYearEarnings),
    };
  }

  async getCashFlow(query: ReportPeriodQuery) {
    const from = new Date(`${query.startDate}T00:00:00.000Z`);
    const to = new Date(`${query.endDate}T23:59:59.999Z`);
    const dayBefore = new Date(from.getTime() - 1);
    const [periodRows, cashIds, openingRows, closingRows] = await Promise.all([
      accountingRepository.getAccountActivity({
        entityId: query.entityId,
        from,
        to,
      }),
      accountingRepository.getCashAccountIds(query.entityId),
      accountingRepository.getAccountActivity({
        entityId: query.entityId,
        to: dayBefore,
      }),
      accountingRepository.getAccountActivity({
        entityId: query.entityId,
        to,
      }),
    ]);
    const cashSet = new Set(cashIds);
    const cashBalance = (
      rows: Array<{ accountId: string; debit: number; credit: number }>,
    ) =>
      this.round2(
        rows
          .filter((r) => cashSet.has(r.accountId))
          .reduce((s, r) => s + (r.debit - r.credit), 0),
      );
    return {
      startDate: query.startDate,
      endDate: query.endDate,
      ...buildCashFlow(
        periodRows,
        cashSet,
        cashBalance(openingRows),
        cashBalance(closingRows),
      ),
    };
  }

  // VAT output/input + WHT summary for a period, from movements on the mapped
  // tax control accounts (M18). Per entity — VAT is filed per legal entity.
  async getTaxReport(query: TaxReportQuery) {
    const from = new Date(`${query.startDate}T00:00:00.000Z`);
    const to = new Date(`${query.endDate}T23:59:59.999Z`);
    const [mappings, rows] = await Promise.all([
      accountingRepository.findAccountMappings(query.entityId),
      accountingRepository.getAccountActivity({
        entityId: query.entityId,
        from,
        to,
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

  // Revenue-Department tax-filing registers for a period (M9): output/input VAT
  // registers, the PP.30 summary, and the PND.3 / PND.53 WHT returns. Built
  // straight from the AR/AP documents + supplier payments (NOT the ledger), so
  // they populate whether or not GL posting is enabled. Amounts are reported in
  // the entity base currency — a foreign document is converted at its captured
  // document-date / settlement-date rate.
  async getTaxRegisters(query: TaxReportQuery) {
    const from = new Date(`${query.startDate}T00:00:00.000Z`);
    const to = new Date(`${query.endDate}T23:59:59.999Z`);
    const [salesDocs, purchaseDocs, whtPayments] = await Promise.all([
      accountingRepository.findTaxDocuments(
        query.entityId,
        "receivable",
        from,
        to,
      ),
      accountingRepository.findTaxDocuments(
        query.entityId,
        "payable",
        from,
        to,
      ),
      accountingRepository.findWhtPayments(query.entityId, from, to),
    ]);

    const toVatInput = (doc: (typeof salesDocs)[number]): VatDocInput => {
      const lineNet = doc.lineItems.reduce(
        (s, li) => s + Number(li.quantity) * Number(li.unitPrice),
        0,
      );
      const vatRate = Number(doc.vatRate);
      const taxRate = Number(doc.taxRate);
      // New docs carry line items; legacy summary rows store only the (tax-
      // inclusive) grand total, so back the net out via the combined rate.
      let subtotal: number;
      if (doc.lineItems.length > 0) {
        subtotal = this.round2(lineNet);
      } else {
        const divisor = 1 + vatRate / 100 + taxRate / 100;
        subtotal = this.round2(
          divisor > 0 ? Number(doc.amount) / divisor : Number(doc.amount),
        );
      }
      return {
        id: doc.id,
        docNo: doc.invoiceNo,
        date: doc.issueDate.toISOString().slice(0, 10),
        counterparty: doc.counterparty,
        taxId: doc.vendor?.taxId ?? null,
        branch: doc.vendor?.branchCode || doc.vendor?.branch || null,
        currency: doc.currency,
        exchangeRate: Number(doc.exchangeRate ?? 1),
        subtotal,
        vatRate,
        vatAmount: this.round2(subtotal * (vatRate / 100)),
      };
    };

    const classifyPayee = (
      businessType?: string | null,
      contactType?: string | null,
    ): PayeeKind =>
      `${businessType ?? ""} ${contactType ?? ""}`
        .toLowerCase()
        .includes("individual")
        ? "individual"
        : "juristic";

    const whtInputs: WhtPaymentInput[] = whtPayments.map((p) => {
      const vendor = p.invoice.vendor;
      return {
        paymentId: p.id,
        date: p.date.toISOString().slice(0, 10),
        payeeId: vendor?.id ?? `name:${p.invoice.counterparty}`,
        payee: p.invoice.counterparty,
        taxId: vendor?.taxId ?? null,
        payeeKind: classifyPayee(vendor?.businessType, vendor?.contactType),
        currency: p.currency ?? "",
        exchangeRate: Number(p.exchangeRate ?? 1),
        whtAmount: Number(p.whtAmount),
        whtRate: Number(p.invoice.whtRate),
      };
    });

    const output = buildVatRegister(salesDocs.map(toVatInput));
    const input = buildVatRegister(purchaseDocs.map(toVatInput));

    return {
      entityId: query.entityId,
      startDate: query.startDate,
      endDate: query.endDate,
      output,
      input,
      pp30: buildPp30(output, input),
      wht: buildWhtSummary(whtInputs),
      note: "Built from issued AR/AP documents and recorded supplier payments (document basis); foreign amounts converted to base currency at their captured rates. Input VAT is reported as fully claimable — non-claimable flagging arrives with the M5 attachment gate.",
    };
  }

  // ── Statement of account (M1) ────────────────────────────────────────────

  // Render a per-counterparty statement PDF: every non-draft AR/AP document,
  // its outstanding, and an aging of the open balance. Owner-scoped for callers
  // without read-all (mirrors listInvoices), so a scoped user only sees their
  // own documents on the statement.
  async getStatementPdf(
    query: StatementQuery,
    userId: string,
    permissions: string[],
  ): Promise<Buffer> {
    const createdBy = canReadAllAccounting(permissions) ? undefined : userId;
    const [invoices, company, entity] = await Promise.all([
      accountingRepository.findInvoicesForStatement({
        entityId: query.entityId,
        counterparty: query.counterparty,
        type: query.type,
        createdBy,
      }),
      this.getInvoiceCompany(),
      accountingRepository.findEntitySetup(query.entityId),
    ]);

    const base = (entity?.currency || "THB").toUpperCase();
    // A statement is per-counterparty and usually single-currency; label with
    // the documents' currency, falling back to the entity base.
    const currency = (invoices[0]?.currency || base).toUpperCase();

    // Default "as of" to today in Asia/Bangkok (matching the module's clock);
    // an explicit YYYY-MM-DD is taken at UTC midnight.
    const asOfInput = query.asOf
      ? new Date(query.asOf)
      : new Date(Date.now() + 7 * 60 * 60 * 1000);
    const asOf = new Date(
      Date.UTC(
        asOfInput.getUTCFullYear(),
        asOfInput.getUTCMonth(),
        asOfInput.getUTCDate(),
      ),
    );

    const statement = buildStatement(
      invoices.map((i) => ({
        invoiceNo: i.invoiceNo,
        issueDate: i.issueDate,
        dueDate: i.dueDate,
        amount: Number(i.amount),
        amountPaid: Number(i.amountPaid),
      })),
      asOf,
    );

    return buildStatementPdfBuffer({
      company,
      entityName: entity?.name ?? "",
      counterparty: query.counterparty,
      side: query.type,
      currency,
      asOf,
      statement,
    });
  }

  // ── Accounting audit log (M12) ───────────────────────────────────────────

  // Read-model over the shared audit_log, restricted to accounting resources.
  // Dates are inclusive day bounds resolved in UTC.
  async listAccountingAuditLogs(query: AuditLogQuery) {
    return accountingRepository.findAccountingAuditLogs({
      resource: query.resource,
      action: query.action,
      startDate: query.startDate
        ? new Date(`${query.startDate}T00:00:00.000Z`)
        : undefined,
      endDate: query.endDate
        ? new Date(`${query.endDate}T23:59:59.999Z`)
        : undefined,
      limit: query.limit,
    });
  }

  // ── Customer advances (M3) ───────────────────────────────────────────────

  /**
   * Record that a supplier issued their tax invoice for a prepayment.
   *
   * Paying a supplier does not create a right to input tax — that arises when
   * their tax invoice exists. So a prepayment is carried GROSS as an asset, and
   * this is the moment the VAT is split out of it. No cash moves.
   *
   * Until this is called, the prepayment sits in the "paid but no tax invoice
   * yet" report, which is what finance chases suppliers with.
   */
  async recordPrepaymentTaxInvoice(
    userId: string,
    advanceId: string,
    input: PrepaymentTaxInvoiceInput,
    permissions: string[],
  ) {
    const advance =
      await accountingRepository.findCustomerAdvanceById(advanceId);
    if (!advance) throw new NotFoundException("Prepayment not found");
    if (!canReadAllAccounting(permissions) && advance.createdBy !== userId) {
      throw new ForbiddenException("You can only update your own prepayments.");
    }
    if (advance.side !== "ap") {
      throw new BadRequestException(
        "Only a supplier prepayment receives a supplier tax invoice.",
      );
    }
    if (advance.kind !== "advance") {
      throw new BadRequestException(
        "Money paid in error is not a purchase, so it has no tax invoice.",
      );
    }
    if (Number(advance.vatAmount ?? 0) > 0) {
      throw new BadRequestException(
        "A tax invoice has already been recorded against this prepayment.",
      );
    }

    const date = input.date ? new Date(input.date) : new Date();
    const gross = input.grossAmount ?? Number(advance.balance);
    if (gross > Number(advance.balance) + 0.005) {
      throw new BadRequestException(
        `The tax invoice (${gross.toFixed(2)}) exceeds the prepayment balance ` +
          `(${Number(advance.balance).toFixed(2)}).`,
      );
    }
    const ratePercent =
      input.vatRatePercent ??
      (await this.resolveEntityVatRate(advance.entityId, date));
    const { vat } = splitAdvanceVat(gross, ratePercent);
    if (vat <= 0) {
      throw new BadRequestException(
        "That tax invoice carries no VAT, so there is nothing to split out.",
      );
    }

    const post = await this.shouldPost(advance.entityId);
    return prisma.$transaction(async (tx) => {
      await assertPostingPeriodOpen(tx, advance.entityId, date);
      let entryId: string | null = null;
      if (post) {
        const lines = buildPrepaymentTaxInvoiceLines(
          {
            inputVat: await resolveMappedAccount(
              tx,
              advance.entityId,
              "vat_input",
            ),
            vendorAdvances: await resolveMappedAccount(
              tx,
              advance.entityId,
              "vendor_advances",
            ),
          },
          vat,
        );
        const entry = await postBalancedEntry(tx, {
          entityId: advance.entityId,
          date,
          description: `Input VAT on prepayment ${input.taxInvoiceNo}`,
          reference: input.taxInvoiceNo,
          sourceType: "prepayment-tax-invoice",
          sourceRef: advanceId,
          createdBy: userId,
          lines,
        });
        entryId = entry.id;
      }

      // The asset is reduced by the tax; `vatAmount` records what was taken out
      // so a later refund knows how much input tax to give back.
      const updated = await tx.customerAdvance.update({
        where: { id: advanceId },
        data: {
          balance: this.round2(Number(advance.balance) - vat),
          vatAmount: vat,
          taxInvoiceNo: input.taxInvoiceNo,
        },
      });
      return {
        inputVat: vat,
        remainingAsset: Number(updated.balance),
        journalEntryId: entryId,
        posted: post,
      };
    });
  }

  /**
   * Return an advance or overpayment to the counterparty.
   *
   * The two kinds part company here, and the difference is a tax-document one:
   *
   *  - kind='advance' had a tax invoice raised when the money arrived, and the
   *    VAT on it was declared. Handing the money back without reversing that
   *    document leaves output tax remitted on a sale that never happened, so a
   *    credit note is REQUIRED before the cash moves.
   *  - kind='refundable' never was a sale and never had a tax invoice, so
   *    demanding a credit note would fabricate a tax document. It is refused.
   */
  async refundAdvance(
    userId: string,
    advanceId: string,
    input: RefundAdvanceInput,
    permissions: string[],
  ) {
    const advance =
      await accountingRepository.findCustomerAdvanceById(advanceId);
    if (!advance) throw new NotFoundException("Advance not found");
    if (!canReadAllAccounting(permissions) && advance.createdBy !== userId) {
      throw new ForbiddenException("You can only refund your own advances.");
    }
    if (advance.status !== "open") {
      throw new BadRequestException("This advance is not open.");
    }

    if (advance.kind === "advance") {
      if (!input.creditNoteId) {
        throw new BadRequestException(
          "This advance had a tax invoice issued when the money was received. " +
            "Issue a credit note against it first, then refund.",
        );
      }
      const note = await accountingRepository.findCreditNoteById(
        input.creditNoteId,
      );
      if (!note || note.entityId !== advance.entityId) {
        throw new BadRequestException("Credit note not found for this entity.");
      }
      if (note.status === "draft" || note.status === "cancelled") {
        throw new BadRequestException(
          `The credit note is ${note.status}; issue it before refunding.`,
        );
      }
    } else if (input.creditNoteId) {
      throw new BadRequestException(
        "Money received in error was never a sale, so it has no tax invoice to " +
          "credit. Refund it without a credit note.",
      );
    }

    const date = input.date ? new Date(input.date) : new Date();
    const requested = input.amount ?? Number(advance.balance);
    const split = applyAdvance({
      available: Number(advance.balance),
      vatAvailable: Number(advance.vatAmount ?? 0),
      requestedGross: requested,
    });
    if (split.grossApplied <= 0) {
      throw new BadRequestException("Nothing remains to refund.");
    }

    const post = await this.shouldPost(advance.entityId);
    return prisma.$transaction(async (tx) => {
      await assertPostingPeriodOpen(tx, advance.entityId, date);
      const bank = await tx.bankAccount.findFirst({
        where: { id: input.bankAccountId, deletedAt: null },
        select: { id: true, entityId: true, glAccountId: true },
      });
      if (!bank || bank.entityId !== advance.entityId) {
        throw new BadRequestException(
          "Bank account not found for this entity.",
        );
      }

      const isAr = advance.side === "ar";
      const newBalance = this.round2(
        Number(advance.balance) - split.grossApplied,
      );
      const newVat = this.round2(
        Number(advance.vatAmount ?? 0) - split.vatRelieved,
      );

      let entryId: string | null = null;
      if (post) {
        if (!bank.glAccountId) {
          throw new BadRequestException(
            "Selected bank account has no GL account mapped.",
          );
        }
        const holdingAccount = await resolveMappedAccount(
          tx,
          advance.entityId,
          advance.kind === "advance"
            ? isAr
              ? "customer_advances"
              : "vendor_advances"
            : isAr
              ? "customer_overpayments_refundable"
              : "vendor_overpayments_refundable",
        );
        const lines = buildAdvanceRefundLines(
          {
            customerAdvances: holdingAccount,
            bank: bank.glAccountId,
            outputVat:
              split.vatRelieved > 0
                ? await resolveMappedAccount(tx, advance.entityId, "vat_output")
                : undefined,
          },
          {
            baseRefunded: split.baseApplied,
            vatRelieved: split.vatRelieved,
          },
        );
        const entry = await postMoneyEvent(tx, {
          posting: {
            entityId: advance.entityId,
            date,
            description: `Refund advance ${advanceId.slice(0, 8)}`,
            reference: advance.taxInvoiceNo ?? advanceId.slice(0, 8),
            sourceType: "advance-refund",
            sourceRef: advanceId,
            createdBy: userId,
            lines,
          },
          bankMovements: [
            {
              entityId: advance.entityId,
              bankAccountId: input.bankAccountId,
              amount: split.grossApplied,
              // An AR advance refunded is cash LEAVING; an AP prepayment
              // recovered from a supplier is cash arriving.
              direction: isAr ? "out" : "in",
              date,
              description: `Refund advance ${advanceId.slice(0, 8)}`,
              source: "advance-refund",
            },
          ],
        });
        entryId = entry.id;
      }

      await tx.customerAdvance.update({
        where: { id: advanceId },
        data: {
          balance: newBalance,
          vatAmount: newVat,
          status: newBalance <= 0.005 ? "refunded" : "open",
          refundedAt: date,
          refundJeId: entryId,
        },
      });

      return {
        refunded: split.grossApplied,
        vatReversed: split.vatRelieved,
        remainingBalance: newBalance,
        posted: post,
      };
    });
  }

  /**
   * The VAT rate to apply to an advance received on `onDate`.
   *
   * Reads the entity's effective-dated rate table rather than a constant: the
   * PRD writes "default 7%", but a rate change would then be wrong everywhere
   * at once and silently. Falls back to the rate on the document the money came
   * in against, which is the rate the customer was actually quoted.
   */
  private async resolveEntityVatRate(
    entityId: string,
    onDate: Date,
    fallbackPercent = 0,
  ): Promise<number> {
    const row = await accountingRepository.findEntityTaxRateOn(
      entityId,
      onDate,
    );
    return row ? Number(row.ratePercent) : fallbackPercent;
  }

  async listCustomerAdvances(
    query: CustomerAdvanceQuery,
    userId: string,
    permissions: string[],
  ) {
    const createdBy = canReadAllAccounting(permissions) ? undefined : userId;
    return accountingRepository.findCustomerAdvances({
      entityId: query.entityId,
      counterparty: query.counterparty,
      status: query.status,
      createdBy,
    });
  }

  // Apply an open customer advance to an AR invoice: draws down the advance,
  // bumps the invoice's amountPaid, and (when posting) books Dr Customer
  // Advances / Cr AR. No cash moves — the receipt already hit the bank when the
  // advance was captured. Base-currency only (advance + invoice must match).
  async applyAdvance(
    userId: string,
    advanceId: string,
    input: ApplyAdvanceInput,
    permissions: string[],
  ) {
    const advance =
      await accountingRepository.findCustomerAdvanceById(advanceId);
    if (!advance) throw new NotFoundException("Customer advance not found");
    if (!canReadAllAccounting(permissions) && advance.createdBy !== userId) {
      throw new ForbiddenException(
        "You can only apply your own customer advances.",
      );
    }
    if (advance.status !== "open") {
      throw new BadRequestException("This advance is not open.");
    }
    // Reads the column now, not a sentinel string in free-text notes. Each side
    // draws down against its own document type — a supplier prepayment settles
    // a bill, a customer advance settles an invoice.
    const isAr = advance.side === "ar";
    const requiredType = isAr ? "receivable" : "payable";

    const invoice = await accountingRepository.findInvoiceById(input.invoiceId);
    if (!invoice) throw new NotFoundException("Invoice not found");
    assertInvoiceAccess(invoice, userId, permissions);
    if (invoice.type !== requiredType) {
      throw new BadRequestException(
        isAr
          ? "Customer advances apply to AR invoices only."
          : "Supplier prepayments apply to AP bills only.",
      );
    }
    if (invoice.entityId !== advance.entityId) {
      throw new BadRequestException(
        "The advance and invoice belong to different entities.",
      );
    }
    // Server-side scope: an advance may only clear ITS customer's invoices — the
    // web filters by counterparty, but never trust the client (RBAC convention).
    if (invoice.counterparty !== advance.counterparty) {
      throw new BadRequestException(
        "The advance and invoice are for different counterparties.",
      );
    }
    if (!["sent", "partial", "overdue"].includes(invoice.status)) {
      throw new BadRequestException(
        `Cannot apply to a ${invoice.status} invoice.`,
      );
    }
    if (
      (invoice.currency || "").toUpperCase() !==
      (advance.currency || "").toUpperCase()
    ) {
      throw new BadRequestException(
        "The advance and invoice currencies differ; cross-currency application is not supported.",
      );
    }

    const post = await this.shouldPost(advance.entityId);
    const date = input.date ? new Date(input.date) : new Date();

    const result = await prisma.$transaction(async (tx) => {
      const freshAdv = await tx.customerAdvance.findUnique({
        where: { id: advanceId },
      });
      if (!freshAdv || freshAdv.status !== "open") {
        throw new BadRequestException("This advance is no longer open.");
      }
      if (input.amount > Number(freshAdv.balance) + 0.005) {
        throw new BadRequestException(
          `Amount exceeds the advance balance ${Number(freshAdv.balance).toFixed(2)}.`,
        );
      }
      const freshInv = await tx.invoice.findUnique({
        where: { id: input.invoiceId },
      });
      if (!freshInv) throw new NotFoundException("Invoice not found");
      const recheck = validatePaymentAmount(
        Number(freshInv.amount),
        Number(freshInv.amountPaid),
        input.amount,
      );
      if (!recheck.ok) {
        throw new BadRequestException(recheck.reason ?? "Invalid application");
      }

      await assertPostingPeriodOpen(tx, advance.entityId, date);

      // A Payment row records the settlement (no bank movement — the cash
      // already landed when the advance was captured).
      const payment = await tx.payment.create({
        data: {
          entityId: advance.entityId,
          invoiceId: input.invoiceId,
          bankAccountId: null,
          date,
          amount: input.amount,
          currency: advance.currency,
          exchangeRate: 1,
          baseAmount: input.amount,
          whtAmount: 0,
          method: "customer-advance",
          reference: `Advance ${advanceId.slice(0, 8)}`,
          notes: null,
          createdBy: userId,
        },
      });

      const newPaid = nextAmountPaid(Number(freshInv.amountPaid), input.amount);
      const settled = settledStatusAfter(Number(freshInv.amount), newPaid);
      await tx.invoice.update({
        where: { id: input.invoiceId },
        data: {
          amountPaid: newPaid,
          status: settled,
          paidDate: settled === "paid" ? date : null,
        },
      });

      // `input.amount` is GROSS. Where the advance carried VAT, part of that
      // gross is tax already declared at receipt, and applying the advance has
      // to release it — otherwise this invoice charges VAT on a base the
      // advance was already taxed on.
      const split = applyAdvance({
        available: Number(freshAdv.balance),
        vatAvailable: Number(freshAdv.vatAmount ?? 0),
        requestedGross: input.amount,
      });
      const newBalance = this.round2(
        Number(freshAdv.balance) - split.grossApplied,
      );
      const newVat = this.round2(
        Number(freshAdv.vatAmount ?? 0) - split.vatRelieved,
      );
      await tx.customerAdvance.update({
        where: { id: advanceId },
        data: {
          balance: newBalance,
          vatAmount: newVat,
          status: newBalance <= 0.005 ? "applied" : "open",
        },
      });

      if (post) {
        const control = await resolveMappedAccount(
          tx,
          advance.entityId,
          isAr ? "ar_control" : "ap_control",
        );
        const advancesAccount = await resolveMappedAccount(
          tx,
          advance.entityId,
          advance.kind === "advance"
            ? isAr
              ? "customer_advances"
              : "vendor_advances"
            : isAr
              ? "customer_overpayments_refundable"
              : "vendor_overpayments_refundable",
        );
        // On the AP side the same two lines swap: the prepayment asset is
        // CREDITED away and the payable DEBITED down, so the builder is called
        // with the sides reversed rather than duplicated.
        const lines = isAr
          ? buildAdvanceApplicationLines(
              {
                customerAdvances: advancesAccount,
                arControl: control,
                outputVat:
                  split.vatRelieved > 0
                    ? await resolveMappedAccount(
                        tx,
                        advance.entityId,
                        "vat_output",
                      )
                    : undefined,
              },
              {
                baseApplied: split.baseApplied,
                vatRelieved: split.vatRelieved,
              },
            )
          : buildVendorPrepaymentApplicationLines(
              { vendorAdvances: advancesAccount, apControl: control },
              { grossApplied: split.grossApplied },
            );
        const entry = await postMoneyEvent(tx, {
          posting: {
            entityId: advance.entityId,
            date,
            description: `Apply advance to ${freshInv.invoiceNo}`,
            reference: freshInv.invoiceNo,
            sourceType: "payment",
            sourceRef: payment.id,
            createdBy: userId,
            lines,
          },
        });
        await tx.payment.update({
          where: { id: payment.id },
          data: { linkedJeId: entry.id },
        });
      }

      return { newBalance };
    });

    return {
      applied: input.amount,
      remainingBalance: result.newBalance,
      posted: post,
    };
  }

  // ── Tax filings + tax-month lock (M9) ────────────────────────────────────

  async listTaxFilings(query: TaxFilingQuery) {
    return accountingRepository.findTaxFilings({
      entityId: query.entityId,
      filingType: query.filingType,
      year: query.year,
    });
  }

  // File a tax month: snapshot the register totals for the month and mark it
  // 'filed', which locks the month against document edits. Re-filing a reopened
  // month refreshes the snapshot and re-locks it (clearing the reopen stamps).
  async fileTaxPeriod(userId: string, input: FileTaxInput) {
    const { startDate, endDate } = monthDateRange(input.year, input.month);
    const registers = await this.getTaxRegisters({
      entityId: input.entityId,
      startDate,
      endDate,
    });
    // Round-trip through JSON so the stored snapshot is a clean JSON value
    // (undefined stripped) and typed as Prisma.InputJsonValue without a cast.
    const snapshot: Prisma.InputJsonValue = JSON.parse(
      JSON.stringify({
        period: { startDate, endDate },
        pp30: registers.pp30,
        wht: registers.wht,
      }),
    );
    return accountingRepository.upsertTaxFiling({
      entityId: input.entityId,
      filingType: input.filingType,
      year: input.year,
      month: input.month,
      status: "filed",
      snapshot,
      notes: input.notes ?? null,
      filedBy: userId,
      // Stamp the (re-)filing instant so a re-filed month reflects who filed
      // it and when, not the original pre-reopen stamp.
      filedAt: new Date(),
      reopenedAt: null,
      reopenedBy: null,
    });
  }

  async reopenTaxPeriod(userId: string, input: ReopenTaxInput) {
    const existing = await accountingRepository.findTaxFiling(
      input.entityId,
      input.filingType,
      input.year,
      input.month,
    );
    if (!existing) {
      throw new NotFoundException("No filing exists for that tax month.");
    }
    return accountingRepository.upsertTaxFiling({
      entityId: input.entityId,
      filingType: input.filingType,
      year: input.year,
      month: input.month,
      status: "reopened",
      // Preserve the original filer (this is guaranteed an update — the row
      // exists — so filedBy/filedAt are left untouched).
      filedBy: existing.filedBy,
      reopenedBy: userId,
      reopenedAt: new Date(),
    });
  }

  // Reject creating/editing an AR/AP document whose tax point (issueDate) falls
  // in a filed (locked) VAT month. Default-open: a month with no filing row, or
  // one that has been reopened, is editable. A plain read (not tx-bound) — the
  // invoice write paths aren't transactional and this is a guard, not a posting.
  private async assertTaxMonthOpen(
    entityId: string,
    date: Date,
    filingType = "vat",
  ): Promise<void> {
    const { year, month } = taxMonthOf(date);
    const filing = await accountingRepository.findTaxFiling(
      entityId,
      filingType,
      year,
      month,
    );
    if (taxMonthLocked(filing?.status)) {
      throw new BadRequestException(
        `VAT for ${year}-${String(month).padStart(2, "0")} has been filed and ` +
          `is locked. Reopen the tax month before changing documents dated ` +
          `into it.`,
      );
    }
  }

  // ── Fiscal periods (M14) ────────────────────────────────────────────────

  async listFiscalPeriods(query: FiscalPeriodQuery) {
    return accountingRepository.findFiscalPeriods(query.entityId);
  }

  async closePeriod(userId: string, input: ClosePeriodInput) {
    return accountingRepository.upsertFiscalPeriod({
      entityId: input.entityId,
      year: input.year,
      month: input.month,
      status: "closed",
      closedBy: userId,
      note: input.note ?? null,
    });
  }

  async reopenPeriod(userId: string, input: ReopenPeriodInput) {
    return accountingRepository.upsertFiscalPeriod({
      entityId: input.entityId,
      year: input.year,
      month: input.month,
      status: "open",
      closedBy: userId,
    });
  }

  // ── Period-end FX revaluation (M8, unrealised, TAS 21) ───────────────────
  // Retranslate open foreign-currency monetary items (AR/AP) to the entity base
  // at the period-end closing rate, booking the unrealised difference to
  // fx_gain / fx_loss. The adjusting entry is dated the last day of the period
  // and REVERSED on the first day of the next period, so control accounts sit at
  // their booked rate during the period and realised FX at settlement (computed
  // vs the booked rate) stays correct. Idempotent per (entity, period). Foreign
  // bank-balance revaluation is a planned follow-up.
  async runFxRevaluation(userId: string, input: RevaluePeriodInput) {
    const { entityId, year, month } = input;
    if (!(await this.shouldPost(entityId))) {
      throw new BadRequestException(
        "Enable GL posting and complete the account mapping before running FX revaluation.",
      );
    }
    const base = await this.getBaseCurrency(entityId);
    const periodKey = `${year}-${String(month).padStart(2, "0")}`;

    const existing = await accountingRepository.findRevaluationEntry(
      entityId,
      periodKey,
    );
    if (existing) {
      throw new ConflictException(
        `FX revaluation for ${periodKey} is already posted (entry ${existing.entryNo}).`,
      );
    }

    // Period-end = last day of the month; reversal = first day of the next
    // month. Both UTC-midnight DATE instants.
    const asOf = new Date(Date.UTC(year, month, 0));
    // PRD: TAS 21 month-end drafts are NOT auto-reversed next month.

    const invoices = await accountingRepository.findOpenInvoicesForRevaluation(
      entityId,
      asOf,
    );

    const closingRateCache = new Map<string, number>();
    const resolveClosing = async (
      currency: string,
      side: AccountingFxSide,
    ): Promise<number> => {
      const key = `${currency.toUpperCase()}:${side}`;
      const cached = closingRateCache.get(key);
      if (cached !== undefined) return cached;
      const rate = await this.resolveRateToBase(
        currency,
        base,
        asOf,
        undefined,
        `${currency} revaluation ${periodKey}`,
        side,
      );
      closingRateCache.set(key, rate);
      return rate;
    };

    // Net debit to each control account + per-bank-GL net + net FX (>0 gain,
    // <0 loss). Each item contributes control/bank-vs-fx equally, so the
    // aggregate stays balanced.
    let controlNetAr = 0;
    let controlNetAp = 0;
    const bankNet = new Map<string, number>();
    let fxNet = 0;
    let itemsRevalued = 0;

    for (const inv of invoices) {
      if (inv.currency.toUpperCase() === base) continue;
      const outstanding = this.round2(
        Number(inv.amount) - Number(inv.amountPaid),
      );
      if (outstanding <= 0.005) continue;
      const bookedSide = accountingFxSide(inv.type);
      const bookedRate =
        inv.carryingRate != null
          ? Number(inv.carryingRate)
          : inv.exchangeRate != null
            ? Number(inv.exchangeRate)
            : await this.resolveRateToBase(
                inv.currency,
                base,
                inv.issueDate,
                undefined,
                `invoice ${inv.invoiceNo}`,
                bookedSide,
              );
      const closingRate = await resolveClosing(inv.currency, bookedSide);
      const delta = this.round2(outstanding * (closingRate - bookedRate));
      if (Math.abs(delta) <= 0.005) continue;
      if (inv.type === "receivable") {
        // AR is an asset: a higher closing rate raises its base value (gain).
        controlNetAr = this.round2(controlNetAr + delta);
        fxNet = this.round2(fxNet + delta);
      } else {
        // AP is a liability: a higher closing rate raises what we owe (loss).
        controlNetAp = this.round2(controlNetAp - delta);
        fxNet = this.round2(fxNet - delta);
      }
      itemsRevalued += 1;
    }

    // Foreign-currency bank balances: retranslate the account's current balance
    // at the closing rate and adjust its GL account to match. Bank is an asset,
    // so a higher base value than its carrying balance is a gain.
    const banks =
      await accountingRepository.findBankAccountsForRevaluation(entityId);
    for (const bank of banks) {
      if (!bank.glAccountId || !bank.glAccount) continue;
      if (bank.currency.toUpperCase() === base) continue;
      const closingRate = await resolveClosing(bank.currency, "buying");
      const carrying = this.round2(Number(bank.glAccount.balance));
      const revalued = this.round2(Number(bank.currentBalance) * closingRate);
      const delta = this.round2(revalued - carrying);
      if (Math.abs(delta) <= 0.005) continue;
      bankNet.set(
        bank.glAccountId,
        this.round2((bankNet.get(bank.glAccountId) ?? 0) + delta),
      );
      fxNet = this.round2(fxNet + delta);
      itemsRevalued += 1;
    }

    const bankHasNet = [...bankNet.values()].some((v) => Math.abs(v) > 0.005);
    const nothingToPost =
      Math.abs(controlNetAr) <= 0.005 &&
      Math.abs(controlNetAp) <= 0.005 &&
      !bankHasNet &&
      Math.abs(fxNet) <= 0.005;
    if (nothingToPost) {
      return {
        period: periodKey,
        itemsRevalued: 0,
        netFx: 0,
        entryId: null,
        reversalEntryId: null,
      };
    }

    const result = await prisma.$transaction(async (tx) => {
      await assertPostingPeriodOpen(tx, entityId, asOf);

      const lines: PostingLine[] = [];
      if (Math.abs(controlNetAr) > 0.005) {
        const ar = await resolveMappedAccount(tx, entityId, "ar_control");
        lines.push(
          controlNetAr > 0
            ? { accountId: ar, debit: controlNetAr, memo: "AR FX revaluation" }
            : {
                accountId: ar,
                credit: -controlNetAr,
                memo: "AR FX revaluation",
              },
        );
      }
      if (Math.abs(controlNetAp) > 0.005) {
        const ap = await resolveMappedAccount(tx, entityId, "ap_control");
        lines.push(
          controlNetAp > 0
            ? { accountId: ap, debit: controlNetAp, memo: "AP FX revaluation" }
            : {
                accountId: ap,
                credit: -controlNetAp,
                memo: "AP FX revaluation",
              },
        );
      }
      for (const [glAccountId, net] of bankNet) {
        if (Math.abs(net) <= 0.005) continue;
        lines.push(
          net > 0
            ? {
                accountId: glAccountId,
                debit: net,
                memo: "Bank FX revaluation",
              }
            : {
                accountId: glAccountId,
                credit: -net,
                memo: "Bank FX revaluation",
              },
        );
      }
      if (fxNet > 0.005) {
        const fxGain = await resolveMappedAccount(tx, entityId, "fx_gain");
        lines.push({
          accountId: fxGain,
          credit: fxNet,
          memo: "Unrealised FX gain",
        });
      } else if (fxNet < -0.005) {
        const fxLoss = await resolveMappedAccount(tx, entityId, "fx_loss");
        lines.push({
          accountId: fxLoss,
          debit: -fxNet,
          memo: "Unrealised FX loss",
        });
      }

      const draftNo = await allocateDraftNumber(tx, entityId, "je");
      const entry = await tx.journalEntry.create({
        data: {
          entityId,
          entryNo: draftNo,
          draftNo,
          date: asOf,
          description: `FX revaluation ${periodKey}`,
          reference: periodKey,
          status: "draft",
          sourceType: "fx-revaluation",
          sourceRef: periodKey,
          createdBy: userId,
          lines: {
            createMany: {
              data: lines.map((l) => ({
                accountId: l.accountId,
                debit: Number(l.debit ?? 0),
                credit: Number(l.credit ?? 0),
                memo: l.memo ?? null,
              })),
            },
          },
        },
      });
      return { entryId: entry.id, reversalEntryId: null as string | null };
    });

    return {
      period: periodKey,
      itemsRevalued,
      netFx: fxNet,
      entryId: result.entryId,
      reversalEntryId: result.reversalEntryId,
    };
  }

  // ── Daily status check (M22, cron) ──────────────────────────────────────
  // Auto-expire sent quotes past their expiry date, and flag sent/partial
  // invoices+bills past due as overdue. "Today" is Asia/Bangkok (UTC+7, no DST).
  // Idempotent: an already-expired/overdue row no longer matches the WHERE, and
  // the status + non-null-date guards mean no legacy row is ever touched.
  async runStatusChecks() {
    const bkk = new Date(Date.now() + 7 * 60 * 60 * 1000);
    const today = new Date(
      Date.UTC(bkk.getUTCFullYear(), bkk.getUTCMonth(), bkk.getUTCDate()),
    );
    const [expiredQuotes, overdueInvoices] = await prisma.$transaction([
      prisma.quote.updateMany({
        where: {
          status: "sent",
          deletedAt: null,
          expiryDate: { not: null, lt: today },
        },
        data: { status: "expired" },
      }),
      prisma.invoice.updateMany({
        where: {
          status: { in: ["sent", "partial"] },
          deletedAt: null,
          dueDate: { lt: today },
        },
        data: { status: "overdue" },
      }),
    ]);
    return {
      asOf: today.toISOString().slice(0, 10),
      quotesExpired: expiredQuotes.count,
      invoicesOverdue: overdueInvoices.count,
    };
  }

  async syncAccountingFxRates(
    sideRates?: Array<{
      currency: string;
      effectiveDate: Date;
      buyingRate: number;
      sellingRate: number;
      source: string;
    }>,
  ) {
    return syncAccountingFxRates({
      listSideRates: sideRates
        ? async () =>
            sideRates.map((row) => ({
              currency: row.currency,
              effectiveDate: row.effectiveDate,
              buyingRate: new Prisma.Decimal(row.buyingRate),
              sellingRate: new Prisma.Decimal(row.sellingRate),
              source: row.source,
            }))
        : undefined,
    });
  }

  // ── Credit notes (M16) ─────────────────────────────────────────────────
  // An AR credit note / AP debit note. Issuing posts a balanced reversal of the
  // original sale/purchase (the NFR-8 escape hatch for adjusting a finalised
  // document). Credit notes are THB-only (no currency column).

  async listCreditNotes(query: CreditNoteQuery) {
    return accountingRepository.findCreditNotes(query);
  }

  async getCreditNoteById(id: string) {
    const creditNote = await accountingRepository.findCreditNoteById(id);
    if (!creditNote) throw new NotFoundException("Credit note not found");
    return creditNote;
  }

  async createCreditNote(userId: string, input: CreateCreditNoteInput) {
    const lines = input.lines.map((l, i) => {
      const lineTotal = this.round2(l.quantity * l.unitPrice);
      const taxAmount = this.round2(lineTotal * (l.taxRate / 100));
      return {
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        lineTotal,
        taxRate: l.taxRate,
        taxAmount,
        glAccountId: l.glAccountId ?? null,
        sortOrder: i,
      };
    });
    const subtotal = this.round2(lines.reduce((s, l) => s + l.lineTotal, 0));
    const taxTotal = this.round2(lines.reduce((s, l) => s + l.taxAmount, 0));
    const grandTotal = this.round2(subtotal + taxTotal);

    const isDebit = input.noteKind === "debit";
    const created = await prisma.$transaction(async (tx) => {
      // Debit notes draw from the "debit-note" (DN-) series, credit notes from
      // "credit-note" (CN-) — each its own per-entity running number.
      const creditNoteNo = await allocateDocumentNumber(
        tx,
        input.entityId,
        isDebit ? "debit-note" : "credit-note",
        new Date(input.issueDate),
      );
      return tx.creditNote.create({
        data: {
          entityId: input.entityId,
          creditNoteNo,
          type: input.type,
          noteKind: input.noteKind,
          linkedInvoiceId: input.linkedInvoiceId ?? null,
          issueDate: new Date(input.issueDate),
          subtotal,
          taxTotal,
          grandTotal,
          reason: input.reason ?? null,
          notes: input.notes ?? null,
          status: "draft",
          createdBy: userId,
          lines: { createMany: { data: lines } },
        },
      });
    });
    return this.getCreditNoteById(created.id);
  }

  // Build the issue posting for an adjustment note. The (side, kind) pair picks
  // the sign: a CREDIT note reduces the AR/AP balance (reverses part of a
  // sale/purchase); a DEBIT note increases it (an incremental charge), so it
  // posts exactly like the original invoice/bill. All four combinations reuse
  // an existing balanced builder — see posting-builders.ts.
  private async resolveCreditNoteLines(
    tx: Prisma.TransactionClient,
    entityId: string,
    isAr: boolean,
    isDebit: boolean,
    doc: { subtotal: number; taxTotal: number },
  ) {
    if (isAr) {
      const acc = {
        arControl: await resolveMappedAccount(tx, entityId, "ar_control"),
        revenue: await resolveMappedAccount(tx, entityId, "revenue_default"),
        vatOutput: await resolveMappedAccount(tx, entityId, "vat_output"),
      };
      // AR debit note (ใบเพิ่มหนี้): Dr AR · Cr Revenue · Cr Output VAT — the
      // same shape as sending an invoice. AR credit note: the reverse.
      return isDebit
        ? buildInvoiceSendLines(acc, doc)
        : buildArCreditNoteLines(acc, doc);
    }
    const acc = {
      apControl: await resolveMappedAccount(tx, entityId, "ap_control"),
      expense: await resolveMappedAccount(tx, entityId, "expense_default"),
      vatInput: await resolveMappedAccount(tx, entityId, "vat_input"),
    };
    // AP debit note (supplier increases the bill): Dr Expense · Dr Input VAT ·
    // Cr AP — the same shape as recording a bill. AP credit note: the reverse.
    return isDebit
      ? buildBillRecordLines(acc, doc)
      : buildApDebitNoteLines(acc, doc);
  }

  async issueCreditNote(userId: string, id: string) {
    const cn = await accountingRepository.findCreditNoteById(id);
    if (!cn) throw new NotFoundException("Credit note not found");
    if (cn.status !== "draft") {
      throw new BadRequestException(
        `Only a draft credit note can be issued (this one is ${cn.status}).`,
      );
    }

    const post = await this.shouldPost(cn.entityId);
    const isAr = cn.type === "receivable";
    const isDebit = cn.noteKind === "debit";
    const noteLabel = isDebit ? "Debit note" : "Credit note";
    const doc = {
      subtotal: Number(cn.subtotal),
      taxTotal: Number(cn.taxTotal),
    };

    await prisma.$transaction(async (tx) => {
      await assertPostingPeriodOpen(tx, cn.entityId, cn.issueDate);
      if (post && Number(cn.grandTotal) > 0 && !cn.linkedJeId) {
        const lines = await this.resolveCreditNoteLines(
          tx,
          cn.entityId,
          isAr,
          isDebit,
          doc,
        );
        const entry = await postMoneyEvent(tx, {
          posting: {
            entityId: cn.entityId,
            date: cn.issueDate,
            description: `${noteLabel} ${cn.creditNoteNo}`,
            reference: cn.creditNoteNo,
            sourceType: "credit-note",
            sourceRef: cn.id,
            createdBy: userId,
            lines,
          },
        });
        await tx.creditNote.update({
          where: { id },
          data: { status: "issued", linkedJeId: entry.id },
        });
      } else {
        await tx.creditNote.update({
          where: { id },
          data: { status: "issued" },
        });
      }
    });

    return this.getCreditNoteById(id);
  }

  async voidCreditNote(userId: string, id: string) {
    const cn = await accountingRepository.findCreditNoteById(id);
    if (!cn) throw new NotFoundException("Credit note not found");
    if (cn.status === "cancelled") {
      throw new BadRequestException("Credit note is already cancelled.");
    }

    const isAr = cn.type === "receivable";
    const isDebit = cn.noteKind === "debit";
    const noteLabel = isDebit ? "debit note" : "credit note";
    const doc = {
      subtotal: Number(cn.subtotal),
      taxTotal: Number(cn.taxTotal),
    };

    await prisma.$transaction(async (tx) => {
      if (cn.linkedJeId) {
        const lines = await this.resolveCreditNoteLines(
          tx,
          cn.entityId,
          isAr,
          isDebit,
          doc,
        );
        await postMoneyEvent(tx, {
          posting: {
            entityId: cn.entityId,
            date: new Date(),
            description: `Void ${noteLabel} ${cn.creditNoteNo}`,
            reference: cn.creditNoteNo,
            sourceType: "credit-note-void",
            sourceRef: cn.id,
            createdBy: userId,
            lines: lines.map((l) => ({
              accountId: l.accountId,
              debit: l.credit,
              credit: l.debit,
              memo: `Reversal: ${l.memo ?? ""}`,
            })),
          },
        });
      }
      await tx.creditNote.update({
        where: { id },
        data: { status: "cancelled", linkedJeId: null },
      });
    });

    return this.getCreditNoteById(id);
  }

  // ── Suppliers: open-balance summary (M10) ───────────────────────────────

  async getSupplierSummary(query: SupplierSummaryQuery) {
    const [balances, totalSuppliers] = await Promise.all([
      accountingRepository.getSupplierOpenBalances(query.entityId),
      accountingRepository.countSuppliers(query.entityId),
    ]);
    const suppliers = balances
      .map((b) => ({ ...b, openBalance: this.round2(b.openBalance) }))
      .sort((a, b) => b.openBalance - a.openBalance);
    const totalOwed = this.round2(
      suppliers.reduce((s, x) => s + x.openBalance, 0),
    );
    return {
      totalSuppliers,
      suppliersWithOpenBalance: suppliers.filter((s) => s.openBalance > 0.005)
        .length,
      totalOwed,
      suppliers,
    };
  }

  // ── Quotes (M8) ─────────────────────────────────────────────────────────

  // Roll a set of quote lines into stored line rows + totals. Accepts the loose
  // Zod-inferred shape (coerced/defaulted fields widen to optional); values are
  // already schema-validated, so unset numerics default to 0.
  private computeDocLines(
    input: Array<{
      description?: string;
      quantity?: number;
      unitPrice?: number;
      taxRate?: number;
      glAccountId?: string;
    }>,
  ) {
    const lines = input.map((l, i) => {
      const quantity = l.quantity ?? 0;
      const unitPrice = l.unitPrice ?? 0;
      const taxRate = l.taxRate ?? 0;
      const lineTotal = this.round2(quantity * unitPrice);
      return {
        description: l.description ?? "",
        quantity,
        unitPrice,
        lineTotal,
        taxRate,
        taxAmount: this.round2(lineTotal * (taxRate / 100)),
        glAccountId: l.glAccountId ?? null,
        sortOrder: i,
      };
    });
    const subtotal = this.round2(lines.reduce((s, l) => s + l.lineTotal, 0));
    const taxTotal = this.round2(lines.reduce((s, l) => s + l.taxAmount, 0));
    return {
      lines,
      subtotal,
      taxTotal,
      grandTotal: this.round2(subtotal + taxTotal),
    };
  }

  async listQuotes(query: QuoteQuery) {
    return accountingRepository.findQuotes(query);
  }

  async getQuoteById(id: string) {
    const quote = await accountingRepository.findQuoteById(id);
    if (!quote) throw new NotFoundException("Quote not found");
    return quote;
  }

  async createQuote(userId: string, input: CreateQuoteInput) {
    const { lines, subtotal, taxTotal, grandTotal } = this.computeDocLines(
      input.lines,
    );
    const created = await prisma.$transaction(async (tx) => {
      const quoteNo = await allocateDocumentNumber(tx, input.entityId, "quote");
      return tx.quote.create({
        data: {
          entityId: input.entityId,
          quoteNo,
          vendorId: input.vendorId ?? null,
          issueDate: new Date(input.issueDate),
          expiryDate: input.expiryDate ? new Date(input.expiryDate) : null,
          currency: input.currency,
          subtotal,
          taxTotal,
          grandTotal,
          notes: input.notes ?? null,
          status: "draft",
          createdBy: userId,
          lines: { createMany: { data: lines } },
        },
      });
    });
    return this.getQuoteById(created.id);
  }

  async updateQuote(id: string, input: UpdateQuoteInput) {
    const quote = await accountingRepository.findQuoteById(id);
    if (!quote) throw new NotFoundException("Quote not found");
    if (quote.status !== "draft") {
      throw new BadRequestException("Only a draft quote can be edited.");
    }

    await prisma.$transaction(async (tx) => {
      const data: Prisma.QuoteUncheckedUpdateInput = {
        ...(input.vendorId !== undefined && {
          vendorId: input.vendorId ?? null,
        }),
        ...(input.issueDate !== undefined && {
          issueDate: new Date(input.issueDate),
        }),
        ...(input.expiryDate !== undefined && {
          expiryDate: input.expiryDate ? new Date(input.expiryDate) : null,
        }),
        ...(input.currency !== undefined && { currency: input.currency }),
        ...(input.notes !== undefined && { notes: input.notes || null }),
      };
      if (input.lines) {
        const { lines, subtotal, taxTotal, grandTotal } = this.computeDocLines(
          input.lines,
        );
        data.subtotal = subtotal;
        data.taxTotal = taxTotal;
        data.grandTotal = grandTotal;
        await tx.quoteLine.deleteMany({ where: { quoteId: id } });
        data.lines = { createMany: { data: lines } };
      }
      await tx.quote.update({ where: { id }, data });
    });
    return this.getQuoteById(id);
  }

  async sendQuote(id: string) {
    const quote = await accountingRepository.findQuoteById(id);
    if (!quote) throw new NotFoundException("Quote not found");
    if (quote.status !== "draft") {
      throw new BadRequestException("Only a draft quote can be sent.");
    }
    await prisma.quote.update({ where: { id }, data: { status: "sent" } });
    return this.getQuoteById(id);
  }

  // Convert an accepted/sent quote into a draft AR invoice, copying the lines.
  // The invoice's blended VAT rate reproduces the quote's tax total, and its
  // amount is set from the quote grand total so nothing drifts on rounding.
  async convertQuote(id: string) {
    const quote = await accountingRepository.findQuoteById(id);
    if (!quote) throw new NotFoundException("Quote not found");
    if (!["sent", "accepted"].includes(quote.status)) {
      throw new BadRequestException(
        "Only a sent or accepted quote can be converted.",
      );
    }
    if (quote.convertedInvoiceId) {
      throw new BadRequestException("Quote has already been converted.");
    }
    if (!quote.vendor) {
      throw new BadRequestException(
        "Attach a customer to the quote before converting it.",
      );
    }

    const subtotal = Number(quote.subtotal);
    const grandTotal = Number(quote.grandTotal);
    const blendedVat =
      subtotal > 0 ? this.round2((Number(quote.taxTotal) / subtotal) * 100) : 0;
    const vendorName = quote.vendor.name;
    const today = new Date();

    const invoiceId = await prisma.$transaction(async (tx) => {
      const invoiceNo = await allocateDocumentNumber(
        tx,
        quote.entityId,
        "invoice",
        today,
      );
      const invoice = await tx.invoice.create({
        data: {
          entityId: quote.entityId,
          invoiceNo,
          type: "receivable",
          counterparty: vendorName,
          vendorId: quote.vendorId,
          amount: grandTotal,
          currency: quote.currency,
          vatRate: blendedVat,
          taxRate: 0,
          whtRate: 0,
          issueDate: today,
          dueDate: today,
          status: "draft",
          notes: quote.notes,
          lineItems: {
            createMany: {
              data: quote.lines.map((l, i) => ({
                description: l.description,
                quantity: Number(l.quantity),
                unitPrice: Number(l.unitPrice),
                sortOrder: i,
              })),
            },
          },
        },
      });
      await tx.quote.update({
        where: { id },
        data: { status: "converted", convertedInvoiceId: invoice.id },
      });
      return invoice.id;
    });

    return { quote: await this.getQuoteById(id), invoiceId };
  }

  async deleteQuote(id: string) {
    const quote = await accountingRepository.findQuoteById(id);
    if (!quote) throw new NotFoundException("Quote not found");
    if (quote.status === "converted") {
      throw new BadRequestException(
        "A converted quote cannot be deleted; void its invoice instead.",
      );
    }
    return accountingRepository.softDeleteQuote(id);
  }

  // ── Purchase orders (M11) ────────────────────────────────────────────────

  async listPurchaseOrders(query: PurchaseOrderQuery) {
    return accountingRepository.findPurchaseOrders(query);
  }

  async getPurchaseOrderById(id: string) {
    const po = await accountingRepository.findPurchaseOrderById(id);
    if (!po) throw new NotFoundException("Purchase order not found");
    return po;
  }

  async createPurchaseOrder(userId: string, input: CreatePurchaseOrderInput) {
    const { lines, subtotal, taxTotal, grandTotal } = this.computeDocLines(
      input.lines,
    );
    const created = await prisma.$transaction(async (tx) => {
      const poNo = await allocateDocumentNumber(tx, input.entityId, "po");
      return tx.purchaseOrder.create({
        data: {
          entityId: input.entityId,
          poNo,
          vendorId: input.vendorId ?? null,
          orderDate: new Date(input.orderDate),
          expectedDate: input.expectedDate
            ? new Date(input.expectedDate)
            : null,
          currency: input.currency,
          subtotal,
          taxTotal,
          grandTotal,
          notes: input.notes ?? null,
          status: "awaiting-delivery",
          createdBy: userId,
          lines: {
            createMany: { data: lines.map((l) => ({ ...l, qtyReceived: 0 })) },
          },
        },
      });
    });
    return this.getPurchaseOrderById(created.id);
  }

  // Record received quantities. No `lines` → receive every line in full.
  // Status becomes completed when every line is fully received, else
  // partially-received.
  async receivePurchaseOrder(id: string, input: ReceivePurchaseOrderInput) {
    const po = await accountingRepository.findPurchaseOrderById(id);
    if (!po) throw new NotFoundException("Purchase order not found");
    if (!["awaiting-delivery", "partially-received"].includes(po.status)) {
      throw new BadRequestException(
        `Cannot receive a ${po.status} purchase order.`,
      );
    }
    const receivedByLine = new Map(
      (input.lines ?? []).map((l) => [l.lineId, l.qtyReceived]),
    );

    await prisma.$transaction(async (tx) => {
      let allReceived = true;
      for (const line of po.lines) {
        const ordered = Number(line.quantity);
        const qty = input.lines
          ? (receivedByLine.get(line.id) ?? Number(line.qtyReceived))
          : ordered;
        await tx.poLine.update({
          where: { id: line.id },
          data: { qtyReceived: qty },
        });
        if (qty < ordered) allReceived = false;
      }
      await tx.purchaseOrder.update({
        where: { id },
        data: { status: allReceived ? "completed" : "partially-received" },
      });
    });
    return this.getPurchaseOrderById(id);
  }

  // Convert a received PO into a draft AP bill (payable invoice) of the
  // received quantities. The bill still needs sending to post to the GL (M5).
  async convertPoToBill(id: string) {
    const po = await accountingRepository.findPurchaseOrderById(id);
    if (!po) throw new NotFoundException("Purchase order not found");
    if (!["completed", "partially-received"].includes(po.status)) {
      throw new BadRequestException(
        "Only a received (full or partial) purchase order can be converted to a bill.",
      );
    }
    if (po.convertedInvoiceId) {
      throw new BadRequestException(
        "Purchase order has already been converted to a bill.",
      );
    }
    if (!po.vendor) {
      throw new BadRequestException(
        "Attach a supplier to the purchase order before converting it.",
      );
    }

    const billLines = po.lines.filter((l) => Number(l.qtyReceived) > 0);
    if (billLines.length === 0) {
      throw new BadRequestException("No received quantities to bill.");
    }

    let subtotal = 0;
    let taxTotal = 0;
    const invLines = billLines.map((l, i) => {
      const qty = Number(l.qtyReceived);
      const unit = Number(l.unitPrice);
      const sub = this.round2(qty * unit);
      subtotal = this.round2(subtotal + sub);
      taxTotal = this.round2(
        taxTotal + this.round2(sub * (Number(l.taxRate) / 100)),
      );
      return {
        description: l.description,
        quantity: qty,
        unitPrice: unit,
        sortOrder: i,
      };
    });
    const grandTotal = this.round2(subtotal + taxTotal);
    const blendedVat =
      subtotal > 0 ? this.round2((taxTotal / subtotal) * 100) : 0;
    const vendorName = po.vendor.name;
    const today = new Date();

    const invoiceId = await prisma.$transaction(async (tx) => {
      const invoiceNo = await allocateDocumentNumber(
        tx,
        po.entityId,
        "bill",
        today,
      );
      const invoice = await tx.invoice.create({
        data: {
          entityId: po.entityId,
          invoiceNo,
          type: "payable",
          counterparty: vendorName,
          vendorId: po.vendorId,
          amount: grandTotal,
          currency: po.currency,
          vatRate: blendedVat,
          taxRate: 0,
          whtRate: 0,
          issueDate: today,
          dueDate: today,
          status: "draft",
          notes: po.notes,
          lineItems: { createMany: { data: invLines } },
        },
      });
      await tx.purchaseOrder.update({
        where: { id },
        data: { status: "billed", convertedInvoiceId: invoice.id },
      });
      return invoice.id;
    });

    return { purchaseOrder: await this.getPurchaseOrderById(id), invoiceId };
  }

  async deletePurchaseOrder(id: string) {
    const po = await accountingRepository.findPurchaseOrderById(id);
    if (!po) throw new NotFoundException("Purchase order not found");
    if (po.status === "billed") {
      throw new BadRequestException(
        "A billed purchase order cannot be deleted; void its bill instead.",
      );
    }
    return accountingRepository.softDeletePurchaseOrder(id);
  }

  // ─── Invoice company + bank block (global SystemSetting) ────────────────
  private static readonly INVOICE_COMPANY_KEY = "accounting.invoice_company";

  /**
   * Read the global invoice company block. The default is built from the
   * organization name in admin setup (`app.name`), and any admin-saved fields
   * overlay it — so the printed company follows the org, not a hardcoded entity.
   */
  async getInvoiceCompany(): Promise<InvoiceCompany> {
    const [row, appNameRow] = await Promise.all([
      prisma.systemSetting.findUnique({
        where: { key: AccountingService.INVOICE_COMPANY_KEY },
      }),
      prisma.systemSetting.findUnique({ where: { key: APP_NAME_SETTING_KEY } }),
    ]);
    const fallback = buildDefaultInvoiceCompany(
      orgNameFromSetting(appNameRow?.value),
    );
    const value = row?.value;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const v = value as Record<string, unknown>;
      const str = (k: string, d: string) =>
        typeof v[k] === "string" ? (v[k] as string) : d;
      return {
        name: str("name", fallback.name),
        addressLines: Array.isArray(v.addressLines)
          ? (v.addressLines as unknown[]).filter(
              (x): x is string => typeof x === "string",
            )
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

  /** Admin upsert of the global invoice company block. */
  async setInvoiceCompany(input: InvoiceCompanyInput): Promise<InvoiceCompany> {
    const value: InvoiceCompany = {
      name: (input.name ?? "").trim(),
      addressLines: (input.addressLines ?? [])
        .map((l) => l.trim())
        .filter(Boolean),
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
    await prisma.systemSetting.upsert({
      where: { key: AccountingService.INVOICE_COMPANY_KEY },
      create: {
        key: AccountingService.INVOICE_COMPANY_KEY,
        value: { ...value },
      },
      update: { value: { ...value } },
    });
    return value;
  }

  async deleteInvoice(id: string, actorId: string, permissions: string[]) {
    const invoice = await accountingRepository.findInvoiceById(id);
    if (!invoice) throw new NotFoundException("Invoice not found");
    // Defense-in-depth: the DELETE route is admin-gated, but enforce
    // owner-or-read-all here too (mirrors the soft-delete IDOR guidance).
    assertInvoiceAccess(invoice, actorId, permissions);
    return accountingRepository.softDeleteInvoice(id, actorId);
  }

  async restoreInvoice(id: string, actorId: string, permissions: string[]) {
    const invoice =
      await accountingRepository.findInvoiceByIdIncludingDeleted(id);
    if (!invoice) throw new NotFoundException("Invoice not found");
    assertInvoiceAccess(invoice, actorId, permissions);
    return accountingRepository.restoreInvoice(id);
  }

  async listBankTransactions(query: BankTransactionQuery) {
    const { page, limit, ...filters } = query;
    const { data, total } = await accountingRepository.findBankTransactions(
      filters,
      page,
      limit,
    );

    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async importBankStatement(input: ImportBankStatementInput) {
    const result = await accountingRepository.importBankTransactions(
      input.entityId,
      input.transactions,
    );

    return { imported: result.count };
  }

  // ── Bank reconciliation (M7) ─────────────────────────────────────────────

  // Mark a bank transaction reconciled (optionally coding it to a GL account).
  // Once reconciled, the payment that wrote it can no longer be voided
  // (paymentReconciled guard in voidPayment).
  async reconcileBankTransaction(id: string, input: ReconcileTransactionInput) {
    const existing = await accountingRepository.findBankTransactionById(id);
    if (!existing) throw new NotFoundException("Bank transaction not found");
    return accountingRepository.setBankTransactionReconciled(id, {
      reconciled: true,
      status: "reconciled",
      reconciledAt: new Date(),
      mappedAccountId: input.mappedAccountId,
    });
  }

  async unreconcileBankTransaction(id: string) {
    const existing = await accountingRepository.findBankTransactionById(id);
    if (!existing) throw new NotFoundException("Bank transaction not found");
    return accountingRepository.setBankTransactionReconciled(id, {
      reconciled: false,
      status: "unmatched",
      reconciledAt: null,
    });
  }

  // Reconciliation snapshot for an entity: matched vs outstanding totals and,
  // when a statement closing figure is supplied, the closing-figure difference.
  async getReconciliationSummary(query: ReconciliationSummaryQuery) {
    const rows =
      await accountingRepository.findBankTransactionsForReconciliation({
        entityId: query.entityId,
        asOf: query.asOf ? new Date(`${query.asOf}T23:59:59.999Z`) : undefined,
      });
    const summary = summarizeReconciliation(
      rows.map((r) => ({
        amount: Number(r.amount),
        direction: r.direction,
        reconciled: r.reconciled,
      })),
      query.statementBalance ?? null,
    );
    return {
      entityId: query.entityId,
      asOf: query.asOf ?? null,
      ...summary,
    };
  }

  private static readonly MATCH_WINDOW_DAYS = 5;

  // Read-only bank-match suggestions: for each unmatched imported bank line,
  // the single exact-amount + in-window open document it settles (or the
  // candidate list when the amount is ambiguous / a lump payment). Posts
  // nothing — the UI confirms a match to actually settle it. Rule: bank-matching.ts.
  async getBankMatchSuggestions(entityId: string) {
    const [docs, txns] = await Promise.all([
      accountingRepository.findOpenInvoicesForMatching(entityId),
      accountingRepository.findUnmatchedBankTransactions(entityId),
    ]);
    const openDocs: MatchDoc[] = docs.map((d) => ({
      invoiceId: d.id,
      invoiceNo: d.invoiceNo,
      type: d.type,
      outstanding: this.round2(Number(d.amount) - Number(d.amountPaid)),
      date: d.dueDate.toISOString().slice(0, 10),
      counterparty: d.counterparty,
    }));
    return txns.map((t) => {
      const result = matchBankTransaction(
        {
          amount: Number(t.amount),
          date: t.date.toISOString().slice(0, 10),
          direction: (t.direction as "in" | "out" | null) ?? null,
        },
        openDocs,
        AccountingService.MATCH_WINDOW_DAYS,
      );
      return {
        transaction: {
          id: t.id,
          date: t.date.toISOString().slice(0, 10),
          amount: Number(t.amount),
          description: t.description,
          direction: t.direction,
          bankAccountId: t.bankAccountId,
        },
        matched: result.matched,
        candidates: result.candidates,
      };
    });
  }

  // Bank reconciliation — confirm a match. Settle an imported bank line against
  // an open invoice: records the payment for the LINE's amount through the sole
  // cash path (recordPayment) and adopts the imported row as that payment's
  // register line (no duplicate). The line must still be unmatched/unlinked.
  async settleBankTransaction(
    userId: string,
    txnId: string,
    input: SettleBankTransactionInput,
    permissions: string[],
  ) {
    const txn = await accountingRepository.findBankTransactionById(txnId);
    if (!txn) throw new NotFoundException("Bank transaction not found");
    if (txn.status !== "unmatched" || txn.reconciled || txn.paymentId) {
      throw new BadRequestException(
        "This bank line is already matched or reconciled.",
      );
    }
    const invoice = await accountingRepository.findInvoiceById(input.invoiceId);
    if (!invoice) throw new NotFoundException("Invoice not found");
    if (invoice.entityId !== txn.entityId) {
      throw new BadRequestException(
        "Invoice belongs to a different entity than the bank line.",
      );
    }
    // Direction guard: a known statement direction must agree with the document
    // side — money 'in' settles a receivable, 'out' settles a payable.
    const isAr = invoice.type === "receivable";
    if (txn.direction && txn.direction !== (isAr ? "in" : "out")) {
      throw new BadRequestException(
        "Bank line direction does not match the invoice type.",
      );
    }
    // The cash that moved IS the statement line's amount. recordPayment enforces
    // owner access + the over-payment guard against the invoice's outstanding.
    return this.recordPayment(
      userId,
      input.invoiceId,
      {
        bankAccountId: input.bankAccountId,
        date: input.date ?? txn.date.toISOString().slice(0, 10),
        amount: Number(txn.amount),
        whtAmount: 0,
        method: input.method ?? "bank-transfer",
        reference: input.reference,
        allowOverpayment: false,
      },
      permissions,
      txnId,
    );
  }

  // Expense workspace header: total AP spend + by-category breakdown for a
  // month (or the whole year when `month` is omitted). Net (subtotal) spend,
  // grouped by each bill's single category account.
  async getExpenseSummary(query: ExpenseSummaryQuery) {
    const year = Number(query.year);
    const month = query.month != null ? Number(query.month) : undefined;
    const from = new Date(Date.UTC(year, month ? month - 1 : 0, 1));
    const to = month
      ? new Date(Date.UTC(year, month, 0, 23, 59, 59, 999))
      : new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));
    const bills = await accountingRepository.findPayableBillsForSummary(
      query.entityId,
      from,
      to,
    );
    const accountIds = [
      ...new Set(
        bills.flatMap((b) =>
          b.lineItems
            .map((l) => l.glAccountId)
            .filter((x): x is string => Boolean(x)),
        ),
      ),
    ];
    const accounts = accountIds.length
      ? await accountingRepository.findAccountsByIds(accountIds)
      : [];
    const labelById = new Map(
      accounts.map((a) => [a.id, `${a.code} — ${a.name}`]),
    );
    const forSummary: BillForSummary[] = bills.map((b) => {
      const subtotal = this.round2(
        b.lineItems.reduce(
          (s, l) => s + this.round2(Number(l.quantity) * Number(l.unitPrice)),
          0,
        ),
      );
      const categoryAccountId = singleLineAccount(b.lineItems);
      return {
        amount: subtotal,
        categoryAccountId,
        categoryLabel: categoryAccountId
          ? (labelById.get(categoryAccountId) ?? null)
          : null,
      };
    });
    return {
      entityId: query.entityId,
      year,
      month: month ?? null,
      ...summarizeExpenses(forSummary),
    };
  }

  // Global accounting search (header omnibox). One term across invoices/bills,
  // journal entries, chart of accounts, bank lines and payments — each group
  // capped at `limit`. Owner-scope (invoices + payments) mirrors listInvoices:
  // a non-read-all caller only sees their own documents. A purely-numeric term
  // also matches the amount column. Returns compact display rows + a total.
  async searchAccounting(
    query: AccountingSearchQuery,
    actorId: string,
    permissions: string[],
  ) {
    const term = query.q.trim();
    const entityId = query.entityId || undefined;
    const limit = query.limit;
    // Same scope rule as listInvoices — never trust the client, force own-docs
    // for invoices/payments unless the caller holds read-all/admin.
    const createdBy = canReadAllAccounting(permissions) ? undefined : actorId;
    // A short term scans too broadly to be useful; the client also gates at 2.
    const empty = {
      q: term,
      results: {
        invoices: [],
        journals: [],
        accounts: [],
        bank: [],
        payments: [],
      },
      total: 0,
    };
    if (term.length < 2) return empty;

    // Numeric term → also match the Decimal `amount` column exactly. Allow
    // thousands separators, but reject leading-zero forms ("0001", "00"): those
    // are identifiers (invoice/account numbers), and coercing them to an amount
    // would dredge up unrelated rows (0001 → amount 1). The text branch still
    // matches them as codes.
    const cleaned = term.replace(/[,\s]/g, "");
    const amount =
      /^\d+(\.\d+)?$/.test(cleaned) && !/^0\d/.test(cleaned)
        ? Number(cleaned)
        : undefined;

    const [invoices, journals, accounts, bank, payments] = await Promise.all([
      accountingRepository.searchInvoices(
        term,
        { entityId, createdBy, amount },
        limit,
      ),
      accountingRepository.searchJournals(term, { entityId }, limit),
      accountingRepository.searchAccounts(term, { entityId }, limit),
      accountingRepository.searchBankTransactions(
        term,
        { entityId, amount },
        limit,
      ),
      accountingRepository.searchPayments(
        term,
        { entityId, createdBy, amount },
        limit,
      ),
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
        date: i.issueDate.toISOString().slice(0, 10),
      })),
      journals: journals.map((j) => ({
        id: j.id,
        reference: j.reference,
        description: j.description,
        date: j.date.toISOString().slice(0, 10),
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
        date: b.date.toISOString().slice(0, 10),
        status: b.status,
        entityName: b.entity.name,
      })),
      payments: payments.map((p) => ({
        id: p.id,
        invoiceId: p.invoice.id,
        invoiceNo: p.invoice.invoiceNo,
        counterparty: p.invoice.counterparty,
        amount: Number(p.amount),
        method: p.method,
        date: p.date.toISOString().slice(0, 10),
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

  // AR/AP aging + liquidity roll-up (M11 dashboard). Scoped to ONE entity and
  // reported in that entity's base currency: each open document's outstanding
  // (amount − amountPaid) is converted to base via its stored send-time rate
  // (null → 1, i.e. already base), then bucketed by how overdue it is as of
  // `asOf`. Totals come from a server-side scan of every open row — never from
  // a page of loaded cards (paginated-aggregate pitfall). Owner-scoped for
  // callers without read-all, mirroring listInvoices. Bank balance sums the
  // entity's active accounts whose currency matches base; foreign-currency
  // accounts are excluded and counted (no stored per-account rate to convert).
  async getAgingSummary(
    query: AgingSummaryQuery,
    actorId: string,
    permissions: string[],
  ) {
    const base = await this.getBaseCurrency(query.entityId);
    const createdBy = canReadAllAccounting(permissions) ? undefined : actorId;

    // Resolve "as of" to a UTC-midnight instant so it lines up with the DATE
    // columns (which come back as UTC midnight). An explicit YYYY-MM-DD is taken
    // as-is; the default is *today in Asia/Bangkok* (UTC+7, no DST) — the same
    // convention runStatusChecks uses — so an evening-UTC caller doesn't age a
    // document a day early.
    const asOfInput = query.asOf
      ? new Date(query.asOf)
      : new Date(Date.now() + 7 * 60 * 60 * 1000);
    const asOf = new Date(
      Date.UTC(
        asOfInput.getUTCFullYear(),
        asOfInput.getUTCMonth(),
        asOfInput.getUTCDate(),
      ),
    );

    const [arRows, apRows, banks] = await Promise.all([
      accountingRepository.findOpenInvoicesForAging({
        entityId: query.entityId,
        type: "receivable",
        createdBy,
      }),
      accountingRepository.findOpenInvoicesForAging({
        entityId: query.entityId,
        type: "payable",
        createdBy,
      }),
      accountingRepository.findBankAccounts({ entityId: query.entityId }),
    ]);

    const toAging = (
      rows: Array<{
        dueDate: Date;
        amount: Prisma.Decimal;
        amountPaid: Prisma.Decimal;
        exchangeRate: Prisma.Decimal | null;
      }>,
    ) =>
      rows
        .map((r) => {
          const outstanding = this.round2(
            Number(r.amount) - Number(r.amountPaid),
          );
          const rate = r.exchangeRate != null ? Number(r.exchangeRate) : 1;
          return {
            dueDate: r.dueDate,
            outstandingBase: this.round2(outstanding * (rate || 1)),
          };
        })
        .filter((r) => r.outstandingBase > 0);

    const receivable = buildAgingSummary(toAging(arRows), asOf);
    const payable = buildAgingSummary(toAging(apRows), asOf);

    let bankBalance = 0;
    let excludedBankAccounts = 0;
    for (const b of banks) {
      if (b.currency.toUpperCase() === base) {
        bankBalance = this.round2(bankBalance + Number(b.currentBalance));
      } else {
        excludedBankAccounts += 1;
      }
    }

    return {
      entityId: query.entityId,
      asOf: asOf.toISOString().slice(0, 10),
      baseCurrency: base,
      buckets: AGING_BUCKETS.map((b) => ({ key: b.key, label: b.label })),
      receivable,
      payable,
      bankBalance,
      excludedBankAccounts,
    };
  }

  // ── Fixed assets ───────────────────────────────────────────────────────

  /**
   * The asset as it stood on `date`, rebuilt from disposal snapshots.
   *
   * A partial disposal permanently reduces the live row's cost / quantity /
   * opening anchor, so valuing a PAST date against the current row restates
   * history. Each approved disposal records what the asset looked like
   * immediately before it, so the state at `date` is simply the *Before values
   * of the EARLIEST approved disposal dated after `date` (every later disposal
   * is already reflected in that snapshot). No qualifying disposal — or a
   * pre-snapshot legacy row — falls back to the live values.
   */
  // Every carrying-amount event for an entity, grouped by asset — the history a
  // report needs to rebuild any past date's cost / quantity. Disposals and
  // remeasurements (WS2) feed ONE chain, which is the whole point of keying the
  // map by AssetEvent rather than by the disposal row: a remeasurement
  // re-anchors the live asset, so without its events every date before an
  // impairment would be valued against the post-impairment anchor.
  //
  // Known gap: a disposal row has no `openingAsOfDateBefore` column, so its
  // event falls back to the LIVE anchor date. For an asset that was disposed in
  // part and later remeasured, a date before both is valued with the disposal's
  // anchor VALUE against the remeasurement's anchor DATE. Fixing it needs a
  // column on fixed_asset_disposals; until then the remeasurement events still
  // remove the much larger error of having no chain at all.
  private async assetEventHistory(
    entityId: string,
  ): Promise<Map<string, faState.AssetEvent[]>> {
    const [disposals, remeasurements] = await Promise.all([
      accountingRepository.findApprovedDisposals(entityId),
      accountingRepository.findApprovedRemeasurements(entityId),
    ]);
    return faState.groupEventsByAsset([
      ...disposals.map((r) => ({
        assetId: r.assetId,
        ...faState.disposalToEvent(r),
      })),
      ...remeasurements.map((r) => ({
        assetId: r.assetId,
        ...faState.remeasurementToEvent(r),
      })),
    ]);
  }

  private assetStateAt(
    asset: faState.AssetStateRow,
    events: readonly faState.AssetEvent[],
    date: Date,
  ): DepreciationInput {
    return faState.assetStateAt(asset, events, date);
  }

  private assetAsOf(asset: faState.AssetLifecycleRow, reportDate: Date): Date {
    return faState.assetAsOf(asset, reportDate);
  }

  private heldAt(asset: faState.AssetLifecycleRow, date: Date): boolean {
    return faState.heldAt(asset, date);
  }

  private resolveAsOf(asOf?: string): Date {
    return asOf ? new Date(`${asOf}T00:00:00.000Z`) : new Date();
  }

  private toDepreciationInput(asset: faState.AssetStateRow): DepreciationInput {
    return faState.toDepreciationInput(asset);
  }

  // Attach the computed depreciation snapshot (NBV / accumulated dep / rate) as
  // at `asOf`. Depreciation is never stored — it is derived here from the
  // register row so the figures can never drift from the register.
  private enrichFixedAsset<
    T extends {
      purchasePrice: Prisma.Decimal;
      quantity: number;
      startDate: Date;
      usefulLifeMonths: number;
      openingBookValue: Prisma.Decimal | null;
      openingAsOfDate: Date | null;
    },
  >(asset: T, asOf: Date) {
    const dep = computeDepreciation(this.toDepreciationInput(asset), asOf);
    return {
      ...asset,
      netBookValue: dep.netBookValue.toNumber(),
      accumulatedDepreciation: dep.accumulatedDepreciation.toNumber(),
      dailyRate: Number(dep.dailyRate.toFixed(4)),
      totalDays: dep.totalDays,
    };
  }

  // Owner-or-read-all guard. Edit / delete / restore on a fixed asset is
  // allowed to the row's creator or any accounting:read-all holder; anyone
  // else is refused (IDOR guard — requirePermission alone can't express it).
  private assertCanManageFixedAsset(
    asset: { createdBy: string },
    actorId: string,
    permissions: string[],
  ): void {
    if (canReadAllAccounting(permissions) || asset.createdBy === actorId) {
      return;
    }
    throw new ForbiddenException(
      "You can only manage fixed assets you created",
    );
  }

  async listFixedAssets(
    query: FixedAssetQuery,
    actorId: string,
    permissions: string[],
  ) {
    const { page, limit, asOf, ...filters } = query;
    const createdBy = canReadAllAccounting(permissions) ? undefined : actorId;
    const { data, total } = await accountingRepository.findFixedAssets(
      { ...filters, createdBy },
      page,
      limit,
    );
    const asOfDate = this.resolveAsOf(asOf);
    return {
      data: data.map((a) => this.enrichFixedAsset(a, asOfDate)),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async getFixedAsset(
    id: string,
    actorId: string,
    permissions: string[],
    asOf?: string,
  ) {
    const asset = await accountingRepository.findFixedAssetById(id);
    if (!asset) throw new NotFoundException("Fixed asset not found");
    if (!canReadAllAccounting(permissions) && asset.createdBy !== actorId) {
      throw new ForbiddenException(
        "You can only view fixed assets you created",
      );
    }
    return this.enrichFixedAsset(asset, this.resolveAsOf(asOf));
  }

  async createFixedAsset(input: CreateFixedAssetInput, actorId: string) {
    const category = await accountingRepository.findFixedAssetCategoryByCode(
      input.entityId,
      input.categoryCode,
    );
    if (!category) {
      throw new BadRequestException(
        `Unknown asset category "${input.categoryCode}" — create it on the category list first`,
      );
    }
    const assetClass = input.assetClass ?? category.assetClass;
    const usefulLifeMonths =
      input.usefulLifeMonths ?? category.usefulLifeMonths;
    const purchaseDate = new Date(`${input.purchaseDate}T00:00:00.000Z`);
    const startDate = new Date(
      `${input.startDate ?? input.purchaseDate}T00:00:00.000Z`,
    );
    const openingAsOfDate = input.openingAsOfDate
      ? new Date(`${input.openingAsOfDate}T00:00:00.000Z`)
      : null;
    // TAX basis: stored exactly as supplied, defaulted to NULL. It is NOT
    // defaulted from usefulLifeMonths — see fixed-asset-tax-basis.ts. The
    // category's own tax life is resolved at report time, not copied here, so
    // editing the class default reaches assets already loaded.
    const openingTaxAsOfDate = input.openingTaxAsOfDate
      ? new Date(`${input.openingTaxAsOfDate}T00:00:00.000Z`)
      : null;

    return prisma.$transaction(async (tx) => {
      let assetNo = input.assetNo?.trim();
      if (assetNo) {
        const dup = await tx.fixedAsset.findFirst({
          where: { entityId: input.entityId, assetNo },
        });
        if (dup) {
          throw new ConflictException(
            `Asset code "${assetNo}" already exists for this entity`,
          );
        }
      } else {
        // Blank code → generate FA-{class}-{YYYY}-NNN via the race-safe
        // per-class annual counter (PRD §3.A.4).
        assetNo = await this.allocateFreeAssetNo(
          tx,
          input.entityId,
          assetClass,
        );
      }
      return tx.fixedAsset.create({
        data: {
          entityId: input.entityId,
          assetNo,
          name: input.name,
          nameTh: input.nameTh ?? null,
          categoryCode: input.categoryCode,
          assetClass,
          location: input.location ?? null,
          assignedUser: input.assignedUser ?? null,
          supplier: input.supplier ?? null,
          serialNo: input.serialNo ?? null,
          purchaseDate,
          startDate,
          usefulLifeMonths,
          quantity: input.quantity,
          purchasePrice: input.purchasePrice,
          openingBookValue: input.openingBookValue ?? null,
          openingAsOfDate,
          taxUsefulLifeMonths: input.taxUsefulLifeMonths ?? null,
          openingTaxWdv: input.openingTaxWdv ?? null,
          openingTaxAsOfDate,
          notes: input.notes ?? null,
          linkGroup: input.linkGroup ?? null,
          status: "active",
          createdBy: actorId,
        },
      });
    });
  }

  async updateFixedAsset(
    id: string,
    input: UpdateFixedAssetInput,
    actorId: string,
    permissions: string[],
  ) {
    const existing = await accountingRepository.findFixedAssetById(id);
    if (!existing) throw new NotFoundException("Fixed asset not found");
    this.assertCanManageFixedAsset(existing, actorId, permissions);

    // An asset with a disposal awaiting approval must not move: the approver is
    // reviewing figures computed from these fields, and editing cost/quantity/
    // dates underneath them desynchronises (or bricks) the approval.
    const pendingDisposals =
      await accountingRepository.countPendingDisposalsForAsset(id);
    if (pendingDisposals > 0) {
      throw new ConflictException(
        "This asset has a disposal awaiting approval — approve or reject it before editing",
      );
    }

    if (input.assetNo && input.assetNo !== existing.assetNo) {
      const dup = await accountingRepository.findFixedAssetByEntityAndNo(
        existing.entityId,
        input.assetNo,
      );
      if (dup) {
        throw new ConflictException(
          `Asset code "${input.assetNo}" already exists for this entity`,
        );
      }
    }

    const data: Prisma.FixedAssetUpdateInput = {};
    if (input.assetNo !== undefined) data.assetNo = input.assetNo;
    if (input.name !== undefined) data.name = input.name;
    if (input.nameTh !== undefined) data.nameTh = input.nameTh ?? null;
    if (input.categoryCode !== undefined) {
      data.categoryCode = input.categoryCode;
    }
    if (input.assetClass !== undefined) data.assetClass = input.assetClass;
    if (input.location !== undefined) data.location = input.location ?? null;
    if (input.assignedUser !== undefined) {
      data.assignedUser = input.assignedUser ?? null;
    }
    if (input.supplier !== undefined) data.supplier = input.supplier ?? null;
    if (input.serialNo !== undefined) data.serialNo = input.serialNo ?? null;
    if (input.purchaseDate !== undefined) {
      data.purchaseDate = new Date(`${input.purchaseDate}T00:00:00.000Z`);
    }
    if (input.startDate !== undefined) {
      data.startDate = new Date(`${input.startDate}T00:00:00.000Z`);
    }
    if (input.usefulLifeMonths !== undefined) {
      data.usefulLifeMonths = input.usefulLifeMonths;
    }
    if (input.quantity !== undefined) data.quantity = input.quantity;
    if (input.purchasePrice !== undefined) {
      data.purchasePrice = input.purchasePrice;
    }
    if (input.openingBookValue !== undefined) {
      data.openingBookValue = input.openingBookValue ?? null;
    }
    if (input.openingAsOfDate !== undefined) {
      data.openingAsOfDate = input.openingAsOfDate
        ? new Date(`${input.openingAsOfDate}T00:00:00.000Z`)
        : null;
    }
    if (input.taxUsefulLifeMonths !== undefined) {
      data.taxUsefulLifeMonths = input.taxUsefulLifeMonths ?? null;
    }
    if (input.openingTaxWdv !== undefined) {
      data.openingTaxWdv = input.openingTaxWdv ?? null;
    }
    if (input.openingTaxAsOfDate !== undefined) {
      data.openingTaxAsOfDate = input.openingTaxAsOfDate
        ? new Date(`${input.openingTaxAsOfDate}T00:00:00.000Z`)
        : null;
    }
    if (input.notes !== undefined) data.notes = input.notes ?? null;
    if (input.linkGroup !== undefined) data.linkGroup = input.linkGroup ?? null;

    return accountingRepository.updateFixedAsset(id, data);
  }

  async deleteFixedAsset(id: string, actorId: string, permissions: string[]) {
    const existing = await accountingRepository.findFixedAssetById(id);
    if (!existing) throw new NotFoundException("Fixed asset not found");
    this.assertCanManageFixedAsset(existing, actorId, permissions);
    await accountingRepository.softDeleteFixedAsset(id);
    return { success: true };
  }

  async restoreFixedAsset(id: string, actorId: string, permissions: string[]) {
    const existing =
      await accountingRepository.findFixedAssetByIdIncludingDeleted(id);
    if (!existing) throw new NotFoundException("Fixed asset not found");
    this.assertCanManageFixedAsset(existing, actorId, permissions);
    return accountingRepository.restoreFixedAsset(id);
  }

  async permanentDeleteFixedAsset(
    id: string,
    actorId: string,
    permissions: string[],
  ) {
    const existing =
      await accountingRepository.findFixedAssetByIdIncludingDeleted(id);
    if (!existing) throw new NotFoundException("Fixed asset not found");
    this.assertCanManageFixedAsset(existing, actorId, permissions);
    await accountingRepository.permanentDeleteFixedAsset(id);
    return { success: true };
  }

  // ── Fixed asset categories ───────────────────────────────────────────────

  async listFixedAssetCategories(query: FixedAssetCategoryQuery) {
    if (!query.entityId) {
      throw new BadRequestException("entityId is required");
    }
    return accountingRepository.findFixedAssetCategories(
      query.entityId,
      query.includeInactive ?? false,
    );
  }

  async getFixedAssetCategoryById(id: string) {
    const category = await accountingRepository.findFixedAssetCategoryById(id);
    if (!category) throw new NotFoundException("Asset category not found");
    return category;
  }

  async createFixedAssetCategory(input: CreateFixedAssetCategoryInput) {
    const existing = await accountingRepository.findFixedAssetCategoryByCode(
      input.entityId,
      input.code,
    );
    if (existing) {
      throw new ConflictException(
        `Asset category "${input.code}" already exists for this entity`,
      );
    }
    await this.assertFixedAssetCategoryAccounts(input.entityId, input);
    return accountingRepository.createFixedAssetCategory({
      entityId: input.entityId,
      code: input.code,
      name: input.name,
      nameTh: input.nameTh ?? null,
      assetClass: input.assetClass,
      usefulLifeMonths: input.usefulLifeMonths,
      taxUsefulLifeMonths: input.taxUsefulLifeMonths ?? null,
      assetGlAccountId: input.assetGlAccountId ?? null,
      depreciationGlAccountId: input.depreciationGlAccountId ?? null,
      accumulatedDepreciationGlAccountId:
        input.accumulatedDepreciationGlAccountId ?? null,
      disposalGainGlAccountId: input.disposalGainGlAccountId ?? null,
      disposalLossGlAccountId: input.disposalLossGlAccountId ?? null,
      isActive: input.isActive ?? true,
    });
  }

  // Every per-category GL override is a bare id, so validate each supplied one
  // against the entity before it is stored.
  private async assertFixedAssetCategoryAccounts(
    entityId: string,
    input: {
      assetGlAccountId?: string | null;
      depreciationGlAccountId?: string | null;
      accumulatedDepreciationGlAccountId?: string | null;
      disposalGainGlAccountId?: string | null;
      disposalLossGlAccountId?: string | null;
    },
  ) {
    const ids = [
      input.assetGlAccountId,
      input.depreciationGlAccountId,
      input.accumulatedDepreciationGlAccountId,
      input.disposalGainGlAccountId,
      input.disposalLossGlAccountId,
    ].filter((v): v is string => typeof v === "string" && v.length > 0);
    for (const id of ids) {
      await this.assertEntityGlAccount(entityId, id);
    }
  }

  async updateFixedAssetCategory(
    id: string,
    input: UpdateFixedAssetCategoryInput,
  ) {
    const existing = await this.getFixedAssetCategoryById(id);
    if (input.code && input.code !== existing.code) {
      const dup = await accountingRepository.findFixedAssetCategoryByCode(
        existing.entityId,
        input.code,
      );
      if (dup) {
        throw new ConflictException(
          `Asset category "${input.code}" already exists for this entity`,
        );
      }
    }
    await this.assertFixedAssetCategoryAccounts(existing.entityId, input);
    return accountingRepository.updateFixedAssetCategory(id, {
      ...(input.code !== undefined ? { code: input.code } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.nameTh !== undefined ? { nameTh: input.nameTh ?? null } : {}),
      ...(input.assetClass !== undefined
        ? { assetClass: input.assetClass }
        : {}),
      ...(input.usefulLifeMonths !== undefined
        ? { usefulLifeMonths: input.usefulLifeMonths }
        : {}),
      ...(input.taxUsefulLifeMonths !== undefined
        ? { taxUsefulLifeMonths: input.taxUsefulLifeMonths ?? null }
        : {}),
      ...(input.assetGlAccountId !== undefined
        ? { assetGlAccountId: input.assetGlAccountId ?? null }
        : {}),
      ...(input.depreciationGlAccountId !== undefined
        ? { depreciationGlAccountId: input.depreciationGlAccountId ?? null }
        : {}),
      ...(input.accumulatedDepreciationGlAccountId !== undefined
        ? {
            accumulatedDepreciationGlAccountId:
              input.accumulatedDepreciationGlAccountId ?? null,
          }
        : {}),
      ...(input.disposalGainGlAccountId !== undefined
        ? { disposalGainGlAccountId: input.disposalGainGlAccountId ?? null }
        : {}),
      ...(input.disposalLossGlAccountId !== undefined
        ? { disposalLossGlAccountId: input.disposalLossGlAccountId ?? null }
        : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    });
  }

  // Hard delete, guarded: a category referenced by any live asset cannot be
  // removed (deactivate via isActive instead) so historical assets keep it.
  async deleteFixedAssetCategory(id: string) {
    const existing = await this.getFixedAssetCategoryById(id);
    const usage = await accountingRepository.countFixedAssetCategoryUsage(
      existing.entityId,
      existing.code,
    );
    if (usage > 0) {
      throw new ConflictException(
        `Cannot delete a category used by ${usage} asset(s). Deactivate it instead.`,
      );
    }
    await accountingRepository.deleteFixedAssetCategory(id);
    return { success: true };
  }

  // ── Entity corporate income tax rates (WS5) ──────────────────────────────
  //
  // Admin-only (ACCOUNTING_ADMIN at the route). Nothing here moves value, so
  // there is no period lock and no maker-checker — but the rate DOES drive the
  // deferred tax schedule, so the two invariants below are enforced hard:
  //
  //   1. effectiveFrom <= effectiveTo (an inverted period matches no date and
  //      would silently make the whole schedule "no rate configured").
  //   2. no two periods for one entity overlap, so exactly one rate is in force
  //      on any date. The engine tolerates overlap (latest-starting wins) but an
  //      accountant should not need to know that tiebreak to predict the result.

  async listEntityTaxRates(query: { entityId: string }) {
    return accountingRepository.findEntityTaxRates(query.entityId);
  }

  private toUtcDate(ymd: string): Date {
    return new Date(`${ymd}T00:00:00.000Z`);
  }

  private async assertTaxRatePeriodFree(
    entityId: string,
    period: { effectiveFrom: Date; effectiveTo: Date | null },
    excludeId?: string,
  ): Promise<void> {
    if (
      period.effectiveTo &&
      period.effectiveTo.getTime() < period.effectiveFrom.getTime()
    ) {
      throw new BadRequestException("End date must not be before start date");
    }
    const existing = await accountingRepository.findEntityTaxRates(entityId);
    const clash = findOverlappingTaxRate(period, existing, excludeId);
    if (clash) {
      const to = clash.effectiveTo
        ? clash.effectiveTo.toISOString().slice(0, 10)
        : "open-ended";
      throw new ConflictException(
        `This period overlaps the existing rate ${clash.label ?? `${Number(clash.ratePercent)}%`} ` +
          `(${clash.effectiveFrom.toISOString().slice(0, 10)} → ${to}). ` +
          `Exactly one rate may be in force on a date — close that period first ` +
          `(end it the day before this one starts), then add this one.`,
      );
    }
  }

  async createEntityTaxRate(input: {
    entityId: string;
    effectiveFrom: string;
    effectiveTo: string | null;
    ratePercent: number;
    label: string | null;
  }) {
    const period = {
      effectiveFrom: this.toUtcDate(input.effectiveFrom),
      effectiveTo: input.effectiveTo ? this.toUtcDate(input.effectiveTo) : null,
    };
    await this.assertTaxRatePeriodFree(input.entityId, period);
    return accountingRepository.createEntityTaxRate({
      entityId: input.entityId,
      ...period,
      ratePercent: new Prisma.Decimal(input.ratePercent),
      label: input.label ?? null,
    });
  }

  async updateEntityTaxRate(
    id: string,
    input: {
      effectiveFrom?: string;
      effectiveTo?: string | null;
      ratePercent?: number;
      label?: string | null;
    },
  ) {
    const existing = await accountingRepository.findEntityTaxRateById(id);
    if (!existing) throw new NotFoundException("Tax rate not found");
    // Merge over the stored row: a PATCH that moves only one end of the period
    // still has to be checked against the other end and against its neighbours.
    const period = {
      effectiveFrom:
        input.effectiveFrom !== undefined
          ? this.toUtcDate(input.effectiveFrom)
          : existing.effectiveFrom,
      effectiveTo:
        input.effectiveTo !== undefined
          ? input.effectiveTo
            ? this.toUtcDate(input.effectiveTo)
            : null
          : existing.effectiveTo,
    };
    await this.assertTaxRatePeriodFree(existing.entityId, period, id);
    return accountingRepository.updateEntityTaxRate(id, {
      effectiveFrom: period.effectiveFrom,
      effectiveTo: period.effectiveTo,
      ...(input.ratePercent !== undefined
        ? { ratePercent: new Prisma.Decimal(input.ratePercent) }
        : {}),
      ...(input.label !== undefined ? { label: input.label ?? null } : {}),
    });
  }

  async deleteEntityTaxRate(id: string) {
    const existing = await accountingRepository.findEntityTaxRateById(id);
    if (!existing) throw new NotFoundException("Tax rate not found");
    await accountingRepository.deleteEntityTaxRate(id);
    return { success: true };
  }

  // ── Fixed asset depreciation posting (WS1) ────────────────────────────────

  /**
   * Compute — and optionally post — a period's depreciation.
   *
   * Structurally a clone of runFxRevaluation: period-keyed, idempotent on
   * (sourceType, sourceRef), computed OUTSIDE the transaction and asserted
   * inside it. One journal entry per entity per month with a line pair per
   * category, which is the grain the accounts are mapped at.
   *
   * `post: false` is the preview and is always safe — it reads, resolves and
   * reports without writing. That is the default the module ships with, since
   * ACCOUNTING_GL_POSTING is off.
   */
  async fixedAssetDepreciationRun(
    input: { entityId: string; year: number; month: number; post: boolean },
    userId: string,
  ) {
    const { entityId, year, month } = input;
    const periodKey = `${year}-${String(month).padStart(2, "0")}`;
    const sourceType = "fa-depreciation";

    const existing = await accountingRepository.findFixedAssetPostingEntry(
      entityId,
      sourceType,
      periodKey,
    );
    if (existing && input.post) {
      throw new ConflictException(
        `Depreciation for ${periodKey} is already posted (entry ${existing.entryNo}).`,
      );
    }

    // Closing = last day of the month; opening = the day before the month
    // starts, so the charge is exactly the month's movement.
    const closingAsOf = new Date(Date.UTC(year, month, 0));
    const openingAsOf = new Date(Date.UTC(year, month - 1, 0));

    const [assets, events, categories] = await Promise.all([
      accountingRepository.findFixedAssetsForPosting(entityId),
      this.assetEventHistory(entityId),
      accountingRepository.findFixedAssetCategories(entityId, true),
    ]);

    // Charge per asset, then rolled up per category. Rounding happens ONCE, on
    // the category subtotal — rounding each asset and summing would drift from
    // the register, and assertBalanced permits no epsilon.
    const byCategory = new Map<
      string,
      { charge: Prisma.Decimal; assets: number }
    >();
    const lines: Array<{
      assetId: string;
      assetNo: string;
      name: string;
      categoryCode: string;
      charge: string;
    }> = [];

    for (const a of assets) {
      const hist = events.get(a.id) ?? [];
      const charge = periodDepreciationCharge(
        {
          state: this.assetStateAt(a, hist, openingAsOf),
          asOf: this.assetAsOf(a, openingAsOf),
        },
        {
          state: this.assetStateAt(a, hist, closingAsOf),
          asOf: this.assetAsOf(a, closingAsOf),
        },
      );
      if (charge.isZero()) continue;
      const bucket = byCategory.get(a.categoryCode) ?? {
        charge: new Prisma.Decimal(0),
        assets: 0,
      };
      bucket.charge = bucket.charge.plus(charge);
      bucket.assets += 1;
      byCategory.set(a.categoryCode, bucket);
      lines.push({
        assetId: a.id,
        assetNo: a.assetNo,
        name: a.name,
        categoryCode: a.categoryCode,
        charge: charge.toFixed(2),
      });
    }

    const categoryTotals = [...byCategory.entries()]
      .map(([categoryCode, v]) => ({
        categoryCode,
        assets: v.assets,
        charge: v.charge.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
      }))
      .sort((a, b) => a.categoryCode.localeCompare(b.categoryCode));

    const total = categoryTotals.reduce(
      (s, c) => s.plus(c.charge),
      new Prisma.Decimal(0),
    );

    const summary = {
      period: periodKey,
      entityId,
      openingAsOf: openingAsOf.toISOString().slice(0, 10),
      closingAsOf: closingAsOf.toISOString().slice(0, 10),
      assetsCharged: lines.length,
      categories: categoryTotals.map((c) => ({
        categoryCode: c.categoryCode,
        assets: c.assets,
        charge: c.charge.toFixed(2),
      })),
      total: total.toFixed(2),
      lines,
      alreadyPosted: existing
        ? { entryId: existing.id, entryNo: existing.entryNo }
        : null,
    };

    if (!input.post) return { ...summary, posted: false as const };

    if (!(await this.shouldPost(entityId))) {
      throw new BadRequestException(
        "Enable GL posting and complete the account mapping before posting depreciation.",
      );
    }
    if (categoryTotals.length === 0) {
      throw new BadRequestException(
        `No depreciation to post for ${periodKey}.`,
      );
    }

    const inScope = categories.filter((c) =>
      categoryTotals.some((t) => t.categoryCode === c.code),
    );

    const posted = await prisma.$transaction(async (tx) => {
      await assertPostingPeriodOpen(tx, entityId, closingAsOf);
      // Fail-whole: every in-scope category must resolve BOTH accounts before a
      // single line is written. Skipping an unmapped category would understate
      // depreciation behind a successful-looking post.
      const accounts = await assertFixedAssetAccountsConfigured(
        tx,
        entityId,
        inScope,
        DEPRECIATION_ROLES,
      );
      const postingLines = categoryTotals.flatMap((c) => {
        const acc = accounts.get(c.categoryCode)!;
        return buildFixedAssetDepreciationLines(
          {
            depreciationExpense: acc.depreciationExpense!,
            accumulatedDepreciation: acc.accumulatedDepreciation!,
          },
          c.charge,
          `Depreciation ${periodKey} — ${c.categoryCode}`,
        );
      });
      return postBalancedEntry(tx, {
        entityId,
        date: closingAsOf,
        description: `Fixed asset depreciation ${periodKey}`,
        sourceType,
        sourceRef: periodKey,
        createdBy: userId,
        lines: postingLines,
      });
    });

    return {
      ...summary,
      posted: true as const,
      entryId: posted.id,
      entryNo: posted.entryNo,
    };
  }

  // ── Fixed asset disposals / write-offs ─────────────────────────────────────

  async listFixedAssetDisposals(
    query: FixedAssetDisposalQuery,
    actorId: string,
    permissions: string[],
  ) {
    const createdBy = canReadAllAccounting(permissions) ? undefined : actorId;
    const data = await accountingRepository.findFixedAssetDisposals({
      ...query,
      createdBy,
    });
    return { data };
  }

  async getFixedAssetDisposal(
    id: string,
    actorId: string,
    permissions: string[],
  ) {
    const disposal = await accountingRepository.findFixedAssetDisposalById(id);
    if (!disposal) throw new NotFoundException("Disposal not found");
    if (
      !canReadAllAccounting(permissions) &&
      disposal.asset.createdBy !== actorId
    ) {
      throw new ForbiddenException("You can only view your own disposals");
    }
    return disposal;
  }

  async submitFixedAssetDisposal(
    assetId: string,
    input: SubmitFixedAssetDisposalInput,
    actorId: string,
    permissions: string[],
  ) {
    const asset = await accountingRepository.findFixedAssetById(assetId);
    if (!asset) throw new NotFoundException("Fixed asset not found");
    this.assertCanManageFixedAsset(asset, actorId, permissions);
    if (!["active", "idle"].includes(asset.status)) {
      throw new BadRequestException(
        `Cannot dispose an asset with status "${asset.status}"`,
      );
    }
    if (input.unitsDisposed > asset.quantity) {
      throw new BadRequestException(
        `Cannot dispose ${input.unitsDisposed} of ${asset.quantity} unit(s) on hand`,
      );
    }
    const pending =
      await accountingRepository.countPendingDisposalsForAsset(assetId);
    if (pending > 0) {
      throw new ConflictException(
        "This asset already has a pending disposal awaiting approval",
      );
    }
    // A pending transfer claims the same units, so the exclusion has to run
    // both ways — the transfer path already blocks on a pending disposal.
    const pendingTransfers =
      await accountingRepository.countPendingTransfersForAsset(assetId);
    if (pendingTransfers > 0) {
      throw new ConflictException(
        "This asset already has a pending transfer awaiting approval",
      );
    }
    const disposalDate = new Date(`${input.disposalDate}T00:00:00.000Z`);
    if (daysBetween(asset.startDate, disposalDate) < 0) {
      throw new BadRequestException(
        "Disposal date cannot precede the depreciation start date",
      );
    }

    const result = computeDisposal(this.toDepreciationInput(asset), {
      unitsDisposed: input.unitsDisposed,
      disposalDate,
      proceeds: input.proceeds,
    });

    return prisma.$transaction(async (tx) => {
      const disposal = await tx.fixedAssetDisposal.create({
        data: {
          asset: { connect: { id: assetId } },
          entityId: asset.entityId,
          disposalType: input.disposalType,
          disposalDate,
          unitsDisposed: input.unitsDisposed,
          proceeds: input.proceeds,
          nbvDisposed: result.nbvDisposed,
          gainLoss: result.gainLoss,
          reason: input.reason ?? null,
          linkGroupId: input.linkGroupId ?? null,
          status: "pending",
          createdBy: actorId,
        },
      });
      // Asset stays "using" (pending_disposal) — depreciation keeps running
      // through the disposal date until an approver actions it.
      await tx.fixedAsset.update({
        where: { id: assetId },
        data: { status: "pending_disposal" },
      });
      return disposal;
    });
  }

  async approveFixedAssetDisposal(id: string, approverId: string) {
    const disposal = await accountingRepository.findFixedAssetDisposalById(id);
    if (!disposal) throw new NotFoundException("Disposal not found");
    if (disposal.status !== "pending") {
      throw new BadRequestException(
        `Cannot approve a disposal with status "${disposal.status}"`,
      );
    }
    const { blockSelfApproval } = await this.getMakerCheckerConfig();
    if (blockSelfApproval && disposal.createdBy === approverId) {
      throw new ForbiddenException(
        "Maker-checker is enabled: you cannot approve a disposal you submitted.",
      );
    }

    const asset = disposal.asset;
    // Re-assert the asset is still disposable at approval time — it may have
    // been disposed, restored or reduced since the request was raised.
    if (!["active", "idle", "pending_disposal"].includes(asset.status)) {
      throw new ConflictException(
        `Cannot approve: the asset is now "${asset.status}"`,
      );
    }
    if (disposal.unitsDisposed > asset.quantity) {
      throw new ConflictException(
        `Cannot approve: ${disposal.unitsDisposed} unit(s) requested but only ${asset.quantity} on hand`,
      );
    }
    // Recompute at approval — deterministic on the disposal date, so this
    // matches the submit-time figures unless the asset was edited meanwhile.
    const result = computeDisposal(this.toDepreciationInput(asset), {
      unitsDisposed: disposal.unitsDisposed,
      disposalDate: disposal.disposalDate,
      proceeds: Number(disposal.proceeds),
    });
    const fullDisposal = disposal.unitsDisposed >= asset.quantity;
    const assetData: Prisma.FixedAssetUpdateInput = fullDisposal
      ? {
          status:
            disposal.disposalType === "write_off" ? "written_off" : "disposed",
          disposalDate: disposal.disposalDate,
          sellingPrice: disposal.proceeds,
        }
      : {
          // Partial disposal: the line continues with the remaining units at a
          // proportional cost, back to active. Scale the opening-balance anchor
          // by the same fraction so a pre-cut-over multi-unit line keeps a
          // correct forward NBV after part of it is removed.
          quantity: result.remaining.quantity,
          purchasePrice: result.remaining.purchasePrice,
          status: "active",
          ...(asset.openingBookValue != null
            ? {
                openingBookValue: this.round2(
                  (Number(asset.openingBookValue) * result.remaining.quantity) /
                    asset.quantity,
                ),
              }
            : {}),
        };

    return prisma.$transaction(async (tx) => {
      // The disposal date governs the accounting period, and approving one
      // removes cost and accumulated depreciation as at that date. Every other
      // path that moves value asserts the period first; this one did not, so a
      // disposal could be back-dated into a month the accountant had closed.
      await assertPostingPeriodOpen(
        tx,
        disposal.entityId,
        disposal.disposalDate,
      );
      const updated = await tx.fixedAssetDisposal.update({
        where: { id },
        data: {
          status: "approved",
          approvedBy: approverId,
          approvedAt: new Date(),
          nbvDisposed: result.nbvDisposed,
          gainLoss: result.gainLoss,
          // Point-in-time snapshot of the asset BEFORE this disposal. A partial
          // disposal reduces the live cost/quantity, so without this an
          // old-dated report would restate history against today's figures.
          quantityBefore: asset.quantity,
          costBefore: asset.purchasePrice,
          openingBookValueBefore: asset.openingBookValue,
          costRemoved: result.costRemoved,
          accumulatedRemoved: result.accumulatedRemoved,
          rejectedBy: null,
          rejectedAt: null,
          rejectReason: null,
        },
        include: { asset: true },
      });
      await tx.fixedAsset.update({ where: { id: asset.id }, data: assetData });
      return updated;
    });
  }

  async rejectFixedAssetDisposal(
    id: string,
    reviewerId: string,
    reason: string,
  ) {
    const disposal = await accountingRepository.findFixedAssetDisposalById(id);
    if (!disposal) throw new NotFoundException("Disposal not found");
    if (disposal.status !== "pending") {
      throw new BadRequestException(
        `Cannot reject a disposal with status "${disposal.status}"`,
      );
    }
    return prisma.$transaction(async (tx) => {
      const updated = await tx.fixedAssetDisposal.update({
        where: { id },
        data: {
          status: "rejected",
          rejectedBy: reviewerId,
          rejectedAt: new Date(),
          rejectReason: reason,
          approvedBy: null,
          approvedAt: null,
        },
        include: { asset: true },
      });
      // Return the asset to service; disposal fields on the row are cleared.
      await tx.fixedAsset.update({
        where: { id: disposal.assetId },
        data: { status: "active" },
      });
      return updated;
    });
  }

  // ── Fixed asset revaluation / impairment (WS2) ─────────────────────────────
  //
  // The recognition split — how much of a movement lands in profit and how much
  // in OCI — is decided ONLY by recogniseRemeasurement
  // (fixed-asset-revaluation.ts); nothing here re-derives it. What this layer
  // owns is the three inputs the pure engine cannot know: the carrying amount
  // BEFORE the event, the asset's cumulative balances, and the IAS 36.117
  // reversal ceiling.

  /**
   * The asset's carrying amount at `date`, plus the ceiling a reversal is
   * capped at, both produced by the depreciation engine.
   *
   * The carrying amount is NEVER read from a column. `openingBookValue` is an
   * anchor, not a carrying amount — it is the NBV as at `openingAsOfDate`, and
   * taking it directly ignores every day of depreciation since. A remeasurement
   * measured off a stale column would be the one figure in the module that can
   * disagree with the register.
   *
   * `neverImpaired` is the IAS 36.117 ceiling: what the asset would be carried
   * at had no impairment ever been recognised. The anchors are deliberately
   * dropped, because approving a remeasurement WRITES one — honouring it would
   * cap every reversal at the impaired amount and no reversal could ever be
   * recognised. Cost and quantity still come from the event chain, so a partial
   * disposal is respected. (For an asset loaded at cut-over this also drops the
   * cut-over anchor, so the ceiling is the straight-line-from-cost amount. It is
   * a ceiling, never a recognised figure.)
   */
  private async fixedAssetValuationAt(
    asset: faState.AssetStateRow &
      faState.AssetLifecycleRow & { id: string; entityId: string },
    date: Date,
  ): Promise<{
    state: DepreciationInput;
    carrying: Prisma.Decimal;
    neverImpaired: Prisma.Decimal;
  }> {
    const history = await this.assetEventHistory(asset.entityId);
    const state = this.assetStateAt(asset, history.get(asset.id) ?? [], date);
    const asOf = this.assetAsOf(asset, date);
    return {
      state,
      carrying: computeDepreciation(state, asOf).netBookValue,
      neverImpaired: computeDepreciation(
        { ...state, openingBookValue: null, openingAsOfDate: null },
        asOf,
      ).netBookValue,
    };
  }

  /**
   * Refuse a remeasurement whose direction contradicts its kind.
   *
   * The pure engine splits whatever movement it is handed, so an "impairment"
   * that writes the asset UP would be recognised — correctly, as an increase —
   * under a label that says the opposite. The kind drives the ceiling, the
   * disclosure and the reader's understanding, so the mismatch is refused here
   * rather than silently reinterpreted.
   */
  private assertRemeasurementDirection(
    kind: RemeasurementKind,
    carryingBefore: Prisma.Decimal,
    carryingAfter: Prisma.Decimal,
    plLossBalance: Prisma.Decimal,
    onInvalid: (message: string) => Error,
  ): void {
    if (kind === "impairment" && !carryingAfter.lessThan(carryingBefore)) {
      throw onInvalid(
        `An impairment must reduce the carrying amount (currently ${carryingBefore.toFixed(2)}). Use a revaluation to write the asset up.`,
      );
    }
    if (kind === "impairment_reversal") {
      if (!carryingAfter.greaterThan(carryingBefore)) {
        throw onInvalid(
          `An impairment reversal must increase the carrying amount (currently ${carryingBefore.toFixed(2)}).`,
        );
      }
      // IAS 36.114: there is nothing to reverse without a prior impairment, and
      // recognising the uplift through profit anyway would skip the OCI
      // treatment a revaluation requires.
      if (!plLossBalance.greaterThan(0)) {
        throw onInvalid(
          "No impairment has been recognised on this asset, so there is nothing to reverse. Raise a revaluation instead.",
        );
      }
    }
  }

  /** The engine call. `reversalCap` applies to a reversal and nothing else. */
  private planRemeasurement(
    kind: RemeasurementKind,
    valuation: { carrying: Prisma.Decimal; neverImpaired: Prisma.Decimal },
    carryingAfter: Prisma.Decimal,
    balances: { surplusBalance: Prisma.Decimal; plLossBalance: Prisma.Decimal },
  ) {
    return recogniseRemeasurement({
      kind,
      carryingBefore: valuation.carrying,
      carryingAfter,
      balances,
      reversalCap:
        kind === "impairment_reversal" ? valuation.neverImpaired : null,
    });
  }

  async listFixedAssetRemeasurements(
    query: FixedAssetRemeasurementQuery,
    actorId: string,
    permissions: string[],
  ) {
    const createdBy = canReadAllAccounting(permissions) ? undefined : actorId;
    const data = await accountingRepository.findFixedAssetRemeasurements({
      ...query,
      createdBy,
    });
    return { data };
  }

  async getFixedAssetRemeasurement(
    id: string,
    actorId: string,
    permissions: string[],
  ) {
    const row = await accountingRepository.findFixedAssetRemeasurementById(id);
    if (!row) throw new NotFoundException("Remeasurement not found");
    if (!canReadAllAccounting(permissions) && row.asset.createdBy !== actorId) {
      throw new ForbiddenException("You can only view your own remeasurements");
    }
    return row;
  }

  /** The per-asset trail behind GET /fixed-assets/:id/remeasurements. */
  async listFixedAssetRemeasurementsForAsset(
    assetId: string,
    actorId: string,
    permissions: string[],
  ) {
    const asset = await accountingRepository.findFixedAssetById(assetId);
    if (!asset) throw new NotFoundException("Fixed asset not found");
    // Same guard as getFixedAsset: the trail is asset data, so it must not be
    // readable by someone who cannot read the asset itself.
    if (!canReadAllAccounting(permissions) && asset.createdBy !== actorId) {
      throw new ForbiddenException(
        "You can only view fixed assets you created",
      );
    }
    const data =
      await accountingRepository.findFixedAssetRemeasurementsForAsset(assetId);
    return { data };
  }

  async submitFixedAssetRemeasurement(
    assetId: string,
    input: SubmitFixedAssetRemeasurementInput,
    actorId: string,
    permissions: string[],
  ) {
    const asset = await accountingRepository.findFixedAssetById(assetId);
    if (!asset) throw new NotFoundException("Fixed asset not found");
    this.assertCanManageFixedAsset(asset, actorId, permissions);
    if (!["active", "idle"].includes(asset.status)) {
      throw new BadRequestException(
        `Cannot remeasure an asset with status "${asset.status}"`,
      );
    }

    // One open request at a time across the queues that move carrying amount. A
    // pending disposal and a pending remeasurement each claim the same NBV;
    // whichever is approved second would be applied against a row the first
    // already changed, and the loser is silently wrong rather than rejected.
    const pendingDisposals =
      await accountingRepository.countPendingDisposalsForAsset(assetId);
    if (pendingDisposals > 0) {
      throw new ConflictException(
        "This asset already has a pending disposal awaiting approval",
      );
    }
    const pendingRemeasurements =
      await accountingRepository.countPendingRemeasurementsForAsset(assetId);
    if (pendingRemeasurements > 0) {
      throw new ConflictException(
        "This asset already has a pending remeasurement awaiting approval",
      );
    }

    const effectiveDate = new Date(`${input.effectiveDate}T00:00:00.000Z`);
    if (daysBetween(asset.startDate, effectiveDate) < 0) {
      throw new BadRequestException(
        "Effective date cannot precede the depreciation start date",
      );
    }

    const kind = input.kind as RemeasurementKind;
    const valuation = await this.fixedAssetValuationAt(asset, effectiveDate);
    const carryingAfter = new Prisma.Decimal(input.carryingAfter);
    this.assertRemeasurementDirection(
      kind,
      valuation.carrying,
      carryingAfter,
      asset.impairmentPlLoss,
      (message) => new BadRequestException(message),
    );

    // Previewed, never committed: the split is recomputed against the LIVE
    // balances at approval, and that is the only figure ever recognised. Stored
    // here because the columns are non-null and the reviewer needs to see what
    // they are approving.
    const preview = this.planRemeasurement(kind, valuation, carryingAfter, {
      surplusBalance: asset.revaluationSurplus,
      plLossBalance: asset.impairmentPlLoss,
    });

    return accountingRepository.createFixedAssetRemeasurement({
      asset: { connect: { id: assetId } },
      entityId: asset.entityId,
      kind,
      effectiveDate,
      carryingBefore: valuation.carrying,
      // After the cap, not as requested — carryingBefore + movement is the
      // amount the asset would actually be carried at.
      carryingAfter: valuation.carrying.plus(preview.movement),
      movement: preview.movement,
      profitOrLoss: preview.profitOrLoss,
      oci: preview.otherComprehensiveIncome,
      surplusAfter: preview.balances.surplusBalance,
      plLossAfter: preview.balances.plLossBalance,
      cappedAt: preview.cappedAt ?? null,
      remainingLifeMonths: remainingLifeMonths(
        asset.startDate,
        asset.usefulLifeMonths,
        effectiveDate,
      ),
      reason: input.reason ?? null,
      evidenceUrl: input.evidenceUrl ?? null,
      status: "pending",
      createdBy: actorId,
    });
  }

  async approveFixedAssetRemeasurement(id: string, approverId: string) {
    const row = await accountingRepository.findFixedAssetRemeasurementById(id);
    if (!row) throw new NotFoundException("Remeasurement not found");
    if (row.status !== "pending") {
      throw new BadRequestException(
        `Cannot approve a remeasurement with status "${row.status}"`,
      );
    }
    const { blockSelfApproval } = await this.getMakerCheckerConfig();
    if (blockSelfApproval && row.createdBy === approverId) {
      throw new ForbiddenException(
        "Maker-checker is enabled: you cannot approve a remeasurement you submitted.",
      );
    }

    const asset = row.asset;
    // Re-assert the asset is still remeasurable — it may have been disposed or
    // written off since the request was raised.
    if (!["active", "idle"].includes(asset.status)) {
      throw new ConflictException(
        `Cannot approve: the asset is now "${asset.status}"`,
      );
    }

    const kind = row.kind as RemeasurementKind;
    // Re-valued against the LIVE row at the EFFECTIVE date, never replayed from
    // the stored carryingBefore: the asset may have been edited, or partly
    // disposed, since the request was raised.
    const valuation = await this.fixedAssetValuationAt(
      asset,
      row.effectiveDate,
    );
    this.assertRemeasurementDirection(
      kind,
      valuation.carrying,
      row.carryingAfter,
      asset.impairmentPlLoss,
      (message) => new ConflictException(`Cannot approve: ${message}`),
    );

    // The balances are the asset's CURRENT cumulative history, not the preview
    // stored at submit — another remeasurement may have been approved in
    // between, and the split depends entirely on where those balances stand.
    const result = this.planRemeasurement(kind, valuation, row.carryingAfter, {
      surplusBalance: asset.revaluationSurplus,
      plLossBalance: asset.impairmentPlLoss,
    });
    const carryingAfter = valuation.carrying.plus(result.movement);
    // Depreciation continues on the NEW amount from the effective date. Written
    // onto the live row's anchor pair so the register reflects the
    // remeasurement; the pre-event pair is preserved in the snapshot columns
    // below, which is what lets a past-dated report rebuild the old basis.
    const anchor = remeasurementAnchor(carryingAfter, row.effectiveDate);

    return prisma.$transaction(async (tx) => {
      // The EFFECTIVE date governs the accounting period, not the approval
      // date: approving in March a December impairment recognises it in
      // December. Asserted first so nothing is written into a closed month.
      await assertPostingPeriodOpen(tx, row.entityId, row.effectiveDate);

      const updated = await tx.fixedAssetRemeasurement.update({
        where: { id },
        data: {
          status: "approved",
          approvedBy: approverId,
          approvedAt: new Date(),
          carryingBefore: valuation.carrying,
          carryingAfter,
          movement: result.movement,
          profitOrLoss: result.profitOrLoss,
          oci: result.otherComprehensiveIncome,
          surplusAfter: result.balances.surplusBalance,
          plLossAfter: result.balances.plLossBalance,
          cappedAt: result.cappedAt ?? null,
          remainingLifeMonths: remainingLifeMonths(
            asset.startDate,
            asset.usefulLifeMonths,
            row.effectiveDate,
          ),
          // Point-in-time snapshot of the asset BEFORE this remeasurement.
          // Approving one re-anchors the live row, so without these an
          // old-dated report would value a pre-event date against the post-event
          // anchor. The anchor DATE is snapshotted too — unlike a disposal, a
          // remeasurement moves it.
          quantityBefore: asset.quantity,
          costBefore: asset.purchasePrice,
          openingBookValueBefore: asset.openingBookValue,
          openingAsOfDateBefore: asset.openingAsOfDate,
          rejectedBy: null,
          rejectedAt: null,
          rejectReason: null,
          // TODO(WS2-posting): leave linkedJeId null until the GL half lands.
          // The entry is a debit/credit to the asset (or an accumulated-
          // depreciation contra) against an impairment-loss expense for
          // `profitOrLoss` and a revaluation-surplus equity account for `oci`,
          // built the way buildFixedAssetDepreciationLines builds the
          // depreciation entry (posting-builders.ts) and resolved through
          // fixed-asset-accounts.ts. It needs two new account roles, so the
          // recognition split is persisted correctly first and posted second.
        },
        include: { asset: true },
      });

      await tx.fixedAsset.update({
        where: { id: asset.id },
        data: {
          // The cumulative balances the NEXT remeasurement splits against.
          // Persisted rather than re-derived: two assets at the same carrying
          // amount split the same movement differently.
          revaluationSurplus: result.balances.surplusBalance,
          impairmentPlLoss: result.balances.plLossBalance,
          openingBookValue: anchor.openingBookValue,
          openingAsOfDate: anchor.openingAsOfDate,
        },
      });
      return updated;
    });
  }

  async rejectFixedAssetRemeasurement(
    id: string,
    reviewerId: string,
    reason: string,
  ) {
    const row = await accountingRepository.findFixedAssetRemeasurementById(id);
    if (!row) throw new NotFoundException("Remeasurement not found");
    if (row.status !== "pending") {
      throw new BadRequestException(
        `Cannot reject a remeasurement with status "${row.status}"`,
      );
    }
    // Nothing to unwind: unlike a disposal (which parks the asset in
    // pending_disposal on submit), a remeasurement never touches the asset row
    // until it is approved, so rejecting is a status stamp.
    return accountingRepository.rejectFixedAssetRemeasurement(
      id,
      reviewerId,
      reason,
    );
  }

  // ── Fixed asset transfers (WS3) ────────────────────────────────────────────
  //
  // Location and custodian moves are field updates that carry no value; a
  // cross-entity move is a disposal in the source plus an acquisition in the
  // destination, carried at NET BOOK VALUE, and is the only kind that touches
  // the GL. All three share one approval gate so the movement trail is one
  // table. Every decision lives in the pure engine (fixed-asset-transfer.ts) —
  // nothing here re-derives it.

  /** Live register row → the engine's asset shape. */
  private toTransferAsset(asset: TransferAssetRow): TransferAsset {
    return {
      id: asset.id,
      entityId: asset.entityId,
      assetNo: asset.assetNo,
      quantity: asset.quantity,
      purchasePrice: asset.purchasePrice,
      startDate: asset.startDate,
      usefulLifeMonths: asset.usefulLifeMonths,
      location: asset.location,
      assignedUser: asset.assignedUser,
      status: asset.status,
      categoryCode: asset.categoryCode,
    };
  }

  /**
   * Plan a transfer against the live row. The cross-entity value carried is the
   * asset's accumulated depreciation AT THE TRANSFER DATE, not today's — a move
   * approved in March for a January date carries January's figures, exactly as
   * a disposal recognises in its own period.
   *
   * `onInvalid` maps the engine's TransferValidationError to the right HTTP
   * shape for the caller: a bad request at submit, a conflict at approve (where
   * the same message means "the asset changed under the pending request").
   */
  private planAssetTransfer(
    asset: TransferAssetRow,
    request: TransferRequest,
    onInvalid: (message: string) => Error,
  ): TransferPlan {
    const { accumulatedDepreciation } = computeDepreciation(
      this.toDepreciationInput(asset),
      request.transferDate,
    );
    try {
      return planTransfer(this.toTransferAsset(asset), request, {
        accumulatedDepreciation,
      });
    } catch (err) {
      if (err instanceof TransferValidationError) throw onInvalid(err.message);
      throw err;
    }
  }

  async listFixedAssetTransfers(
    query: FixedAssetTransferQuery,
    actorId: string,
    permissions: string[],
  ) {
    const createdBy = canReadAllAccounting(permissions) ? undefined : actorId;
    const data = await accountingRepository.findFixedAssetTransfers({
      ...query,
      createdBy,
    });
    return { data };
  }

  async getFixedAssetTransfer(
    id: string,
    actorId: string,
    permissions: string[],
  ) {
    const transfer = await accountingRepository.findFixedAssetTransferById(id);
    if (!transfer) throw new NotFoundException("Transfer not found");
    if (
      !canReadAllAccounting(permissions) &&
      transfer.asset.createdBy !== actorId
    ) {
      throw new ForbiddenException("You can only view your own transfers");
    }
    return transfer;
  }

  /** The per-asset movement trail behind GET /fixed-assets/:id/transfers. */
  async listFixedAssetTransfersForAsset(
    assetId: string,
    actorId: string,
    permissions: string[],
  ) {
    const asset = await accountingRepository.findFixedAssetById(assetId);
    if (!asset) throw new NotFoundException("Fixed asset not found");
    // Same guard as getFixedAsset: the trail is asset data, so it must not be
    // readable by someone who cannot read the asset itself.
    if (!canReadAllAccounting(permissions) && asset.createdBy !== actorId) {
      throw new ForbiddenException(
        "You can only view fixed assets you created",
      );
    }
    const data =
      await accountingRepository.findFixedAssetTransfersForAsset(assetId);
    return { data };
  }

  async submitFixedAssetTransfer(
    assetId: string,
    input: SubmitFixedAssetTransferInput,
    actorId: string,
    permissions: string[],
  ) {
    const asset = await accountingRepository.findFixedAssetById(assetId);
    if (!asset) throw new NotFoundException("Fixed asset not found");
    this.assertCanManageFixedAsset(asset, actorId, permissions);

    // One open request at a time, across BOTH queues. A pending disposal and a
    // pending transfer each claim the same units; whichever is approved second
    // would be applied against a row the first already changed, and the loser
    // is silently wrong rather than rejected.
    const pendingDisposals =
      await accountingRepository.countPendingDisposalsForAsset(assetId);
    if (pendingDisposals > 0) {
      throw new ConflictException(
        "This asset already has a pending disposal awaiting approval",
      );
    }
    const pendingTransfers =
      await accountingRepository.countPendingTransfersForAsset(assetId);
    if (pendingTransfers > 0) {
      throw new ConflictException(
        "This asset already has a pending transfer awaiting approval",
      );
    }

    const request: TransferRequest = {
      kind: input.kind,
      transferDate: new Date(`${input.transferDate}T00:00:00.000Z`),
      toLocation: input.toLocation ?? null,
      toCustodian: input.toCustodian ?? null,
      toEntityId: input.toEntityId ?? null,
      reason: input.reason ?? null,
    };
    const plan = this.planAssetTransfer(
      asset,
      request,
      (message) => new BadRequestException(message),
    );

    const transfer = await accountingRepository.createFixedAssetTransfer({
      asset: { connect: { id: assetId } },
      entityId: asset.entityId,
      kind: plan.kind,
      transferDate: plan.transferDate,
      // Where the asset stood when the request was raised. Re-stamped from the
      // live row on approval, which is what actually governs the trail.
      fromLocation: asset.location,
      fromCustodian: asset.assignedUser,
      toLocation: plan.fieldChanges.location ?? null,
      toCustodian: plan.fieldChanges.assignedUser ?? null,
      toEntityId: plan.crossEntity?.toEntityId ?? null,
      // Cost AND accumulated depreciation both cross, so the destination
      // inherits the NBV. Carrying only the cost would restate the group's
      // carrying amount upward by the whole accumulated depreciation.
      costTransferred: plan.crossEntity?.costTransferred ?? null,
      accumulatedTransferred: plan.crossEntity?.accumulatedTransferred ?? null,
      remainingLifeMonths: plan.crossEntity?.remainingLifeMonths ?? null,
      reason: request.reason,
      status: "pending",
      createdBy: actorId,
    });
    // The plan summary is not persisted — it is derived, and re-derived at
    // approval — so it rides back on the response for the preview panel.
    return {
      ...transfer,
      summary: plan.summary,
      movesValue: plan.movesValue,
    };
  }

  async approveFixedAssetTransfer(id: string, approverId: string) {
    const transfer = await accountingRepository.findFixedAssetTransferById(id);
    if (!transfer) throw new NotFoundException("Transfer not found");
    if (transfer.status !== "pending") {
      throw new BadRequestException(
        `Cannot approve a transfer with status "${transfer.status}"`,
      );
    }
    const { blockSelfApproval } = await this.getMakerCheckerConfig();
    if (blockSelfApproval && transfer.createdBy === approverId) {
      throw new ForbiddenException(
        "Maker-checker is enabled: you cannot approve a transfer you submitted.",
      );
    }

    const asset = transfer.asset;
    // Re-plan against the LIVE row rather than replaying the stored request:
    // the asset may have been disposed, already moved, or edited since the
    // request was raised, and the plan — not the stored destination — is what
    // gets applied.
    const plan = this.planAssetTransfer(
      asset,
      {
        kind: transfer.kind as TransferKind,
        transferDate: transfer.transferDate,
        toLocation: transfer.toLocation,
        toCustodian: transfer.toCustodian,
        toEntityId: transfer.toEntityId,
        reason: transfer.reason,
      },
      (message) => new ConflictException(`Cannot approve: ${message}`),
    );

    return prisma.$transaction(async (tx) => {
      if (plan.crossEntity) {
        // Value leaves one entity's books and lands on another's, so BOTH
        // periods govern the move and a closed month on either side blocks it.
        // Asserted before the refusal below so the guard is exercised — and
        // cannot be quietly forgotten — the day the posting half lands.
        await assertPostingPeriodOpen(
          tx,
          plan.crossEntity.fromEntityId,
          transfer.transferDate,
        );
        await assertPostingPeriodOpen(
          tx,
          plan.crossEntity.toEntityId,
          transfer.transferDate,
        );
        // Completing a cross-entity move means creating the destination asset
        // row and posting two journal entries — a credit out of the source and
        // a debit into the destination — whose other legs are intercompany
        // receivable / payable accounts. This chart of accounts has no
        // intercompany account role, and inventing one here would post the
        // whole NBV to an arbitrary account that reconciles to nothing.
        throw new BadRequestException(
          "Cross-entity transfer approval is not yet available. Completing one " +
            "requires posting an intercompany journal in each entity, and no " +
            "intercompany account is configured in the chart of accounts. The " +
            "request stays pending; location and custodian transfers are " +
            "unaffected.",
        );
      }

      // Location / custodian: no value moves, so no fiscal-period assertion —
      // the period lock governs postings, and this path writes none.
      const updated = await tx.fixedAssetTransfer.update({
        where: { id },
        data: {
          status: "approved",
          approvedBy: approverId,
          approvedAt: new Date(),
          // Re-stamp from the LIVE row: the trail must record where the asset
          // actually moved FROM, not where it sat when the request was filed.
          fromLocation: asset.location,
          fromCustodian: asset.assignedUser,
          rejectedBy: null,
          rejectedAt: null,
          rejectReason: null,
        },
      });
      await tx.fixedAsset.update({
        where: { id: asset.id },
        data: plan.fieldChanges,
      });
      return updated;
    });
  }

  async rejectFixedAssetTransfer(
    id: string,
    reviewerId: string,
    reason: string,
  ) {
    const transfer = await accountingRepository.findFixedAssetTransferById(id);
    if (!transfer) throw new NotFoundException("Transfer not found");
    if (transfer.status !== "pending") {
      throw new BadRequestException(
        `Cannot reject a transfer with status "${transfer.status}"`,
      );
    }
    // Nothing to unwind: unlike a disposal (which parks the asset in
    // pending_disposal on submit), a transfer never touches the asset row until
    // it is approved, so rejecting is a status stamp.
    return accountingRepository.rejectFixedAssetTransfer(
      id,
      reviewerId,
      reason,
    );
  }

  // ── Fixed asset physical count (WS4) ───────────────────────────────────────
  //
  // The count NEVER touches the GL and never auto-creates a disposal. A
  // shortfall is reported with suggestWriteOff so a human routes it into the
  // existing write-off flow, which carries approval, maker-checker, the period
  // lock and the point-in-time snapshot. A counter's tap must not bypass four
  // controls at once.

  /**
   * The single owner-scope value every count path uses.
   *
   * It drives all three surfaces together — which sessions you may open, which
   * assets a scanned tag may resolve to, and which assets carry an expectation.
   * Splitting them desynchronises the variance: buildCountVariance walks the
   * EXPECTATIONS, so an observation resolved against an asset with no
   * expectation is dropped silently and the asset reads as never counted.
   */
  private countScope(
    actorId: string,
    permissions: string[],
  ): string | undefined {
    return canReadAllAccounting(permissions) ? undefined : actorId;
  }

  private async loadCountSessionForActor(
    id: string,
    actorId: string,
    permissions: string[],
  ) {
    const session =
      await accountingRepository.findFixedAssetCountSessionById(id);
    if (!session) throw new NotFoundException("Count session not found");
    // IDOR guard in the service, not the route: accounting:create alone would
    // otherwise let any employee read or write another user's session.
    if (!canReadAllAccounting(permissions) && session.createdBy !== actorId) {
      throw new ForbiddenException(
        "You can only work on count sessions you created",
      );
    }
    return session;
  }

  /**
   * Every asset the register says was held ON THE SESSION'S AS-OF DATE, valued
   * at that date.
   *
   * THIS IS THE POINT OF THE WHOLE WORKSTREAM. A year-end count is walked over
   * the following fortnight, by which time disposals — including partial ones,
   * which permanently reduce the live row's quantity and cost — have already
   * landed. Expecting `asset.quantity` (today) makes the counter "correct" a
   * register that was right on the count date, and the correction is the error.
   * So the quantity comes from the event chain rebuilt at asOfDate
   * (assetEventHistory → assetStateAt, clamped by assetAsOf), never the live
   * row.
   *
   * `locationFilter` is matched against the LIVE location: the event chain
   * carries depreciable state only, so there is no point-in-time location to
   * consult. That is a scoping convenience for which assets to walk, never a
   * valuation input, so it cannot distort a quantity.
   */
  private async fixedAssetCountExpectations(
    session: {
      entityId: string;
      asOfDate: Date;
      locationFilter: string | null;
    },
    createdBy: string | undefined,
  ) {
    const [assets, history] = await Promise.all([
      accountingRepository.findFixedAssetsForReport(
        session.entityId,
        createdBy,
      ),
      this.assetEventHistory(session.entityId),
    ]);
    const asOf = session.asOfDate;
    const inScope = assets.filter((a) => {
      // Held on the count date — not "active today". An asset disposed after
      // the count date was still there to be counted; one disposed before it
      // was not, and expecting it would manufacture a shortfall.
      if (!this.heldAt(a, asOf)) return false;
      if (!session.locationFilter) return true;
      return (a.location ?? "") === session.locationFilter;
    });
    const expectations: CountExpectation[] = inScope.map((a) => {
      const state = this.assetStateAt(
        a,
        history.get(a.id) ?? [],
        this.assetAsOf(a, asOf),
      );
      return {
        assetId: a.id,
        assetNo: a.assetNo,
        name: a.name,
        categoryCode: a.categoryCode,
        location: a.location,
        expectedQuantity: state.quantity,
      };
    });
    return { assets: inScope, expectations };
  }

  /**
   * Tag → asset candidates. An asset is reachable by BOTH its register code and
   * its serial number, because a counter scans whichever label is on the item.
   *
   * Collapsed per (asset, normalised tag) first: when an import wrote the same
   * string into assetNo and serialNo the asset would otherwise appear twice and
   * resolveAssetByTag would report a two-hit ambiguity against itself, blocking
   * a scan that is not actually ambiguous.
   */
  private fixedAssetCountTagCandidates(
    assets: ReadonlyArray<{
      id: string;
      assetNo: string;
      serialNo: string | null;
    }>,
  ): Array<{ assetId: string; tag: string }> {
    const seen = new Set<string>();
    const candidates: Array<{ assetId: string; tag: string }> = [];
    for (const a of assets) {
      for (const tag of [a.assetNo, a.serialNo]) {
        if (!tag) continue;
        const normalised = normalizeTag(tag);
        if (!normalised) continue;
        const key = `${a.id}|${normalised}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({ assetId: a.id, tag });
      }
    }
    return candidates;
  }

  async createFixedAssetCountSession(
    input: CreateFixedAssetCountSessionInput,
    actorId: string,
  ) {
    const asOfDate = new Date(`${input.asOfDate}T00:00:00.000Z`);
    // Deliberately NO assertPostingPeriodOpen: opening a count moves no value.
    // Counting into a closed month is legitimate — the count is evidence ABOUT
    // that month. The write-off it recommends is what meets the period lock,
    // inside the existing disposal approval flow.
    return prisma.$transaction(async (tx) => {
      const sessionNo = await allocateDocumentNumber(
        tx,
        input.entityId,
        "fa-count",
      );
      return tx.fixedAssetCountSession.create({
        data: {
          entityId: input.entityId,
          sessionNo,
          asOfDate,
          name: input.name ?? null,
          locationFilter: input.locationFilter ?? null,
          status: "open",
          createdBy: actorId,
        },
      });
    });
  }

  async listFixedAssetCountSessions(
    query: FixedAssetCountSessionQuery,
    actorId: string,
    permissions: string[],
  ) {
    const data = await accountingRepository.findFixedAssetCountSessions({
      ...query,
      createdBy: this.countScope(actorId, permissions),
    });
    return { data };
  }

  async submitFixedAssetCountLine(
    sessionId: string,
    input: SubmitFixedAssetCountLineInput,
    actorId: string,
    permissions: string[],
  ) {
    const session = await this.loadCountSessionForActor(
      sessionId,
      actorId,
      permissions,
    );
    // A closed session is the frozen record the accountant acted on. Accepting
    // a late line would restate a variance that has already been routed into
    // write-offs. 409 so the client refetches rather than retries.
    if (session.status !== "open") {
      throw new ConflictException(
        `Count session ${session.sessionNo} is ${session.status} and no longer accepts lines`,
      );
    }

    const scannedTag = input.scannedTag?.trim()
      ? input.scannedTag.trim()
      : null;
    if (!input.assetId && !scannedTag) {
      throw new BadRequestException(
        "Provide either an assetId or a scanned tag",
      );
    }

    const { assets, expectations } = await this.fixedAssetCountExpectations(
      session,
      this.countScope(actorId, permissions),
    );
    const expectedByAsset = new Map(
      expectations.map((e) => [e.assetId, e.expectedQuantity]),
    );

    let assetId: string | null = null;
    if (input.assetId) {
      // An explicit pick is still checked against the session scope, so a
      // guessed id cannot attach a line to an asset outside the count.
      if (!expectedByAsset.has(input.assetId)) {
        throw new NotFoundException(
          "Asset is not in this count session's scope",
        );
      }
      assetId = input.assetId;
    } else {
      const resolved = resolveAssetByTag(
        scannedTag!,
        this.fixedAssetCountTagCandidates(assets),
      );
      if (resolved === null) {
        // No match is NOT an error: it is a found-but-unregistered item, which
        // the variance reports as "unregistered" and never writes off.
        assetId = null;
      } else if ("ambiguous" in resolved) {
        // Never guess. serialNo is nullable, non-unique and never de-duplicated
        // on import, so a tag genuinely hits two assets; picking one has the
        // counter confirm a count against the wrong asset, and the register is
        // then "corrected" into being wrong.
        throw new BadRequestException(
          `Tag "${normalizeTag(scannedTag!)}" matches ${resolved.count} assets in this count — pick the asset explicitly instead of scanning.`,
        );
      } else {
        assetId = resolved.assetId;
      }
    }

    const line = await accountingRepository.createFixedAssetCountLine({
      sessionId,
      assetId,
      scannedTag,
      // Stamped from the as-of expectation, not the live quantity, so the line
      // stays readable as the trail of what the counter was told to expect.
      expectedQuantity: assetId ? (expectedByAsset.get(assetId) ?? 0) : 0,
      countedQuantity: input.countedQuantity,
      note: input.note ?? null,
      countedBy: actorId,
    });
    return {
      ...line,
      resolution: assetId ? ("matched" as const) : ("unregistered" as const),
    };
  }

  async getFixedAssetCountVariance(
    sessionId: string,
    actorId: string,
    permissions: string[],
  ) {
    const session = await this.loadCountSessionForActor(
      sessionId,
      actorId,
      permissions,
    );
    const [{ expectations }, lines] = await Promise.all([
      this.fixedAssetCountExpectations(
        session,
        this.countScope(actorId, permissions),
      ),
      accountingRepository.findFixedAssetCountLines(sessionId),
    ]);
    const observations: CountObservation[] = lines.map((l) => ({
      assetId: l.assetId,
      scannedTag: l.scannedTag,
      countedQuantity: l.countedQuantity,
      note: l.note,
    }));
    return {
      session: {
        id: session.id,
        sessionNo: session.sessionNo,
        entityId: session.entityId,
        asOfDate: session.asOfDate.toISOString().slice(0, 10),
        name: session.name,
        locationFilter: session.locationFilter,
        status: session.status,
      },
      ...buildCountVariance(expectations, observations),
    };
  }

  /**
   * Freeze the session. Gated on accounting:approve at the route — closing is
   * the control act that fixes the variance an accountant then works from.
   *
   * No maker-checker and no period lock, unlike approveFixedAssetDisposal:
   * nothing here moves value. Both controls apply to the write-off a shortfall
   * recommends, which runs through the existing disposal flow.
   */
  async closeFixedAssetCountSession(id: string, actorId: string) {
    const session =
      await accountingRepository.findFixedAssetCountSessionById(id);
    if (!session) throw new NotFoundException("Count session not found");
    if (session.status !== "open") {
      throw new ConflictException(
        `Count session ${session.sessionNo} is already ${session.status}`,
      );
    }
    // Status-guarded update: two concurrent closes cannot both stamp closedBy,
    // and the loser is told so rather than silently overwriting the winner.
    const closed = await accountingRepository.closeFixedAssetCountSession(
      id,
      actorId,
    );
    if (closed === 0) {
      throw new ConflictException(
        "Count session was closed by someone else — refresh and try again",
      );
    }
    const updated =
      await accountingRepository.findFixedAssetCountSessionById(id);
    if (!updated) throw new NotFoundException("Count session not found");
    return updated;
  }

  // ── Fixed asset reports ────────────────────────────────────────────────────

  async fixedAssetRegisterReport(query: FixedAssetReportQuery) {
    const asOf = this.resolveAsOf(query.asOf);
    const assets = await accountingRepository.findFixedAssetsForReport(
      query.entityId,
    );
    const history = await this.assetEventHistory(query.entityId);
    const lines: RegisterLine[] = assets.map((a) => {
      // Value the asset as it stood on the report date, not as it stands today
      // — a later partial disposal must not restate this date's figures.
      const state = this.assetStateAt(a, history.get(a.id) ?? [], asOf);
      const dep = computeDepreciation(state, this.assetAsOf(a, asOf));
      return {
        assetNo: a.assetNo,
        name: a.name,
        categoryCode: a.categoryCode,
        status: a.status,
        quantity: state.quantity,
        cost: Number(state.purchasePrice),
        accumulatedDepreciation: dep.accumulatedDepreciation.toNumber(),
        netBookValue: dep.netBookValue.toNumber(),
      };
    });
    return {
      entityId: query.entityId,
      asOf: asOf.toISOString().slice(0, 10),
      ...buildFixedAssetRegisterReport(lines),
    };
  }

  async fixedAssetDepreciationSchedule(query: FixedAssetScheduleQuery) {
    // Opening = last day of the prior month; closing = last day of the period.
    const openingAsOf = new Date(Date.UTC(query.year, query.month - 1, 0));
    const closingAsOf = new Date(Date.UTC(query.year, query.month, 0));
    const assets = await accountingRepository.findFixedAssetsForReport(
      query.entityId,
    );
    const history = await this.assetEventHistory(query.entityId);
    const lines: ScheduleLine[] = [];
    for (const a of assets) {
      if (a.startDate.getTime() > closingAsOf.getTime()) continue; // not yet in service
      // Off the books before this period started — it charges nothing here.
      if (a.disposalDate && a.disposalDate.getTime() <= openingAsOf.getTime()) {
        continue;
      }
      const hist = history.get(a.id) ?? [];
      // Each end is valued against the asset as it stood on THAT date, and
      // clamped at the disposal date so the month containing a disposal charges
      // only up to it and later months charge nothing.
      const opening = computeDepreciation(
        this.assetStateAt(a, hist, openingAsOf),
        this.assetAsOf(a, openingAsOf),
      );
      const closing = computeDepreciation(
        this.assetStateAt(a, hist, closingAsOf),
        this.assetAsOf(a, closingAsOf),
      );
      const startedByOpening = a.startDate.getTime() <= openingAsOf.getTime();
      // The postable figure = depreciation charged during the month
      // (accumulated at close − accumulated at open), robust to mid-month adds.
      const depreciation = this.round2(
        closing.accumulatedDepreciation.toNumber() -
          opening.accumulatedDepreciation.toNumber(),
      );
      lines.push({
        assetNo: a.assetNo,
        name: a.name,
        categoryCode: a.categoryCode,
        openingNbv: startedByOpening ? opening.netBookValue.toNumber() : 0,
        depreciation,
        closingNbv: closing.netBookValue.toNumber(),
      });
    }
    const period = `${query.year}-${String(query.month).padStart(2, "0")}`;
    return {
      entityId: query.entityId,
      period,
      ...buildDepreciationSchedule(lines),
    };
  }

  /**
   * Deferred tax on the book-versus-tax useful life difference (WS5).
   *
   * Each asset is depreciated TWICE by the same engine as at the same date:
   * once on its book basis (the register figure) and once on its tax basis
   * (tax life + tax cut-over anchor). The gap is the temporary difference; the
   * entity's effective-dated rate turns it into a deferred tax liability/asset.
   *
   * THE FAILURE MODE. `taxDepreciationInput` returns null when an asset has no
   * tax life of its own AND its category has no class default, and that null is
   * passed straight through as `taxWdv: null` so the engine excludes the asset
   * BY NAME and reports coverage. Substituting the book life here would make
   * every temporary difference exactly zero and render a clean, plausible,
   * entirely wrong 0.00 that nobody can eyeball. Do not "fix" the exclusions by
   * defaulting the life — fix them by configuring the tax basis.
   *
   * Assets already off the books at the report date are skipped entirely: a
   * disposed asset has no carrying amount on either basis, so counting it would
   * only depress the coverage percentage with rows that can never be included.
   */
  async fixedAssetDeferredTaxReport(query: FixedAssetReportQuery) {
    const asOf = this.resolveAsOf(query.asOf);
    const [assets, categories, rateRows, history] = await Promise.all([
      accountingRepository.findFixedAssetsForReport(query.entityId),
      // Inactive categories included: a live asset can sit in a deactivated
      // class, and dropping its class default would silently exclude the asset.
      accountingRepository.findFixedAssetCategories(query.entityId, true),
      accountingRepository.findEntityTaxRates(query.entityId),
      this.assetEventHistory(query.entityId),
    ]);

    const categoryByCode = new Map<string, TaxBasisCategory>(
      categories.map((c) => [
        c.code,
        { taxUsefulLifeMonths: c.taxUsefulLifeMonths },
      ]),
    );

    const inputs: DeferredTaxAssetInput[] = [];
    for (const a of assets) {
      if (!this.heldAt(a, asOf)) continue;
      // Same point-in-time state and same valuation date on both bases, so the
      // difference can only come from the life and the anchor.
      const state = this.assetStateAt(a, history.get(a.id) ?? [], asOf);
      const valuationDate = this.assetAsOf(a, asOf);
      const taxState = taxDepreciationInput(
        state,
        a,
        categoryByCode.get(a.categoryCode),
      );
      inputs.push({
        assetId: a.id,
        assetNo: a.assetNo,
        name: a.name,
        categoryCode: a.categoryCode,
        bookCarrying: computeDepreciation(state, valuationDate).netBookValue,
        taxWdv: taxState
          ? computeDepreciation(taxState, valuationDate).netBookValue
          : null,
      });
    }

    const rates: TaxRatePeriod[] = rateRows.map((r) => ({
      effectiveFrom: r.effectiveFrom,
      effectiveTo: r.effectiveTo,
      ratePercent: Number(r.ratePercent),
      label: r.label ?? undefined,
    }));
    const schedule = buildDeferredTaxSchedule(inputs, { asOf, rates });

    return {
      entityId: query.entityId,
      asOf: asOf.toISOString().slice(0, 10),
      ratePercent: schedule.ratePercent,
      rateLabel: schedule.rateLabel,
      // Labelled a COMPONENT: this measures the fixed-asset part of deferred
      // tax only (provisions, unrealised FX and employee benefits are outside
      // it) and must never be presented as the entity's deferred tax position.
      scope: "fixed-assets" as const,
      lines: schedule.lines.map((l) => ({
        assetId: l.assetId,
        assetNo: l.assetNo,
        name: l.name,
        categoryCode: l.categoryCode,
        bookCarrying: l.bookCarrying.toNumber(),
        taxWdv: l.taxWdv.toNumber(),
        temporaryDifference: l.temporaryDifference.toNumber(),
        ratePercent: l.ratePercent,
        deferredTax: l.deferredTax.toNumber(),
      })),
      exclusions: schedule.exclusions,
      totals: {
        bookCarrying: schedule.totals.bookCarrying.toNumber(),
        taxWdv: schedule.totals.taxWdv.toNumber(),
        temporaryDifference: schedule.totals.temporaryDifference.toNumber(),
        deferredTax: schedule.totals.deferredTax.toNumber(),
        deferredTaxLiability: schedule.totals.deferredTaxLiability.toNumber(),
        deferredTaxAsset: schedule.totals.deferredTaxAsset.toNumber(),
      },
      coverage: schedule.coverage,
    };
  }

  async fixedAssetDisposalReport(query: FixedAssetPeriodReportQuery) {
    const from = new Date(`${query.from}T00:00:00.000Z`);
    const to = new Date(`${query.to}T23:59:59.999Z`);
    const disposals = await accountingRepository.findApprovedDisposals(
      query.entityId,
      from,
      to,
    );
    const lines: DisposalLine[] = disposals.map((d) => ({
      assetNo: d.asset.assetNo,
      name: d.asset.name,
      disposalDate: d.disposalDate.toISOString().slice(0, 10),
      disposalType: d.disposalType,
      proceeds: Number(d.proceeds),
      nbvDisposed: d.nbvDisposed ? Number(d.nbvDisposed) : 0,
      gainLoss: d.gainLoss ? Number(d.gainLoss) : 0,
    }));
    return {
      entityId: query.entityId,
      from: query.from,
      to: query.to,
      ...buildDisposalReport(lines),
    };
  }

  async fixedAssetMovementReport(query: FixedAssetPeriodReportQuery) {
    const from = new Date(`${query.from}T00:00:00.000Z`);
    const to = new Date(`${query.to}T00:00:00.000Z`);
    const openingAsOf = new Date(from.getTime() - 86_400_000); // day before window
    const assets = await accountingRepository.findFixedAssetsForReport(
      query.entityId,
    );
    const disposals = await accountingRepository.findApprovedDisposals(
      query.entityId,
      from,
      new Date(`${query.to}T23:59:59.999Z`),
    );

    const byCat = new Map<
      string,
      { opening: number; additions: number; disposals: number; closing: number }
    >();
    const bump = (cat: string) => {
      let g = byCat.get(cat);
      if (!g) {
        g = { opening: 0, additions: 0, disposals: 0, closing: 0 };
        byCat.set(cat, g);
      }
      return g;
    };
    const history = await this.assetEventHistory(query.entityId);
    for (const a of assets) {
      const g = bump(a.categoryCode);
      const hist = history.get(a.id) ?? [];
      // Membership is "was it on the books on that date" (heldAt), NOT the
      // asset's CURRENT status — an asset disposed mid-window was still held at
      // the opening date, and counting it only in the disposals column dumped
      // its whole NBV into the depreciation balancing figure.
      // Ownership (purchaseDate), not service start, decides inclusion: an
      // asset bought in-window whose depreciation starts later is still an
      // addition and still sits in closing at cost (the engine returns cost
      // before startDate).
      if (
        this.heldAt(a, openingAsOf) &&
        a.purchaseDate.getTime() <= openingAsOf.getTime()
      ) {
        g.opening += computeDepreciation(
          this.assetStateAt(a, hist, openingAsOf),
          this.assetAsOf(a, openingAsOf),
        ).netBookValue.toNumber();
      }
      if (this.heldAt(a, to) && a.purchaseDate.getTime() <= to.getTime()) {
        g.closing += computeDepreciation(
          this.assetStateAt(a, hist, to),
          this.assetAsOf(a, to),
        ).netBookValue.toNumber();
      }
      if (
        a.purchaseDate.getTime() >= from.getTime() &&
        a.purchaseDate.getTime() <= to.getTime()
      ) {
        g.additions += Number(
          this.assetStateAt(a, hist, a.purchaseDate).purchasePrice,
        );
      }
    }
    for (const d of disposals) {
      bump(d.asset.categoryCode).disposals += d.nbvDisposed
        ? Number(d.nbvDisposed)
        : 0;
    }

    const contributions: MovementContribution[] = [...byCat.entries()].map(
      ([categoryCode, v]) => ({
        categoryCode,
        opening: this.round2(v.opening),
        additions: this.round2(v.additions),
        disposals: this.round2(v.disposals),
        depreciation: this.round2(
          v.opening + v.additions - v.disposals - v.closing,
        ),
        closing: this.round2(v.closing),
      }),
    );
    return {
      entityId: query.entityId,
      from: query.from,
      to: query.to,
      ...buildMovementReport(contributions),
    };
  }

  // ── Fixed asset import (19-column layout) ──────────────────────────────────

  // Allocate the next free asset code. A manually-typed or imported code can
  // occupy a number the sequence will later hand out; without this the insert
  // hits the unique index and the whole transaction (or import) dies. Skips
  // taken numbers instead, bounded so a pathological register can't spin.
  private async allocateFreeAssetNo(
    tx: Prisma.TransactionClient,
    entityId: string,
    assetClass: string,
  ): Promise<string> {
    const docType = this.faDocTypeFor(assetClass);
    for (let attempt = 0; attempt < 50; attempt++) {
      const candidate = await allocateDocumentNumber(tx, entityId, docType);
      const taken = await tx.fixedAsset.findFirst({
        where: { entityId, assetNo: candidate },
        select: { id: true },
      });
      if (!taken) return candidate;
    }
    throw new ConflictException(
      "Could not allocate a free asset code — too many codes in this class are already taken",
    );
  }

  private faDocTypeFor(assetClass: string) {
    return assetClass === "IT"
      ? ("fa-it" as const)
      : assetClass === "PFA"
        ? ("fa-pfa" as const)
        : ("fa-ff" as const);
  }

  // Shared classifier used by BOTH preview and commit (single source of truth,
  // mirroring the COA / journal importers). Validates every row, dedupes asset
  // codes across the file, and splits insert vs update by existing code.
  private async classifyFixedAssetImport(input: ImportFixedAssetsInput) {
    const categories = await accountingRepository.findFixedAssetCategories(
      input.entityId,
      true,
    );
    const known = new Set(categories.map((c) => c.code.toLowerCase()));
    const catByCode = new Map(categories.map((c) => [c.code.toLowerCase(), c]));
    const errors: { rowNumber: number; messages: string[] }[] = [];
    const valid: ValidatedImportRow[] = [];
    const seen = new Set<string>();
    for (const raw of input.rows) {
      const res = validateFixedAssetImportRow(raw, {
        knownCategoryCodes: known,
        asOfDate: input.asOf,
      });
      if (res.errors.length > 0 || !res.value) {
        errors.push({ rowNumber: raw.rowNumber ?? 0, messages: res.errors });
        continue;
      }
      const value = res.value;
      if (value.assetCode) {
        const key = value.assetCode.toLowerCase();
        if (seen.has(key)) {
          errors.push({
            rowNumber: raw.rowNumber ?? 0,
            messages: [`Duplicate Asset Code "${value.assetCode}" in the file`],
          });
          continue;
        }
        seen.add(key);
      }
      valid.push(value);
    }
    const suppliedCodes = valid
      .map((v) => v.assetCode)
      .filter((c): c is string => !!c);
    const existingRows =
      await accountingRepository.findFixedAssetsByEntityAndNos(
        input.entityId,
        suppliedCodes,
      );
    // A code belonging to a soft-deleted asset still owns the unique index —
    // fail loudly rather than writing into the graveyard.
    const deletedRows = await accountingRepository.findDeletedFixedAssetNos(
      input.entityId,
      suppliedCodes,
    );
    const deletedCodes = new Set(
      deletedRows.map((d) => d.assetNo.toLowerCase()),
    );
    for (const v of valid) {
      if (v.assetCode && deletedCodes.has(v.assetCode.toLowerCase())) {
        errors.push({
          rowNumber: v.rowNumber,
          messages: [
            `Asset code "${v.assetCode}" belongs to a deleted asset — restore it before importing`,
          ],
        });
      }
    }
    const existing = new Set(existingRows.map((e) => e.assetNo.toLowerCase()));
    const existingById = new Map(
      existingRows.map((e) => [e.assetNo.toLowerCase(), e]),
    );
    const updates = valid.filter(
      (v) => v.assetCode && existing.has(v.assetCode.toLowerCase()),
    ).length;
    return {
      errors,
      valid,
      catByCode,
      existing,
      existingById,
      summary: {
        total: input.rows.length,
        valid: valid.length,
        inserts: valid.length - updates,
        updates,
        errorCount: errors.length,
      },
    };
  }

  async previewFixedAssetImport(input: ImportFixedAssetsInput) {
    const { errors, summary } = await this.classifyFixedAssetImport(input);
    return { ok: errors.length === 0, errors, summary };
  }

  async commitFixedAssetImport(
    input: ImportFixedAssetsInput,
    actorId: string,
    permissions: string[] = [],
  ) {
    const { errors, valid, catByCode, existing, existingById, summary } =
      await this.classifyFixedAssetImport(input);

    // Owner-or-read-all guard on the UPDATE path. Without this an
    // accounting:create holder could name another user's asset code in the file
    // and silently overwrite that row (IDOR) — every other mutator enforces the
    // same check via assertCanManageFixedAsset.
    const allErrors = [...errors];
    if (!canReadAllAccounting(permissions)) {
      for (const v of valid) {
        if (!v.assetCode) continue;
        const row = existingById.get(v.assetCode.toLowerCase());
        if (row && row.createdBy !== actorId) {
          allErrors.push({
            rowNumber: v.rowNumber,
            messages: [
              `Asset "${v.assetCode}" belongs to another user — you can only update assets you created`,
            ],
          });
        }
      }
    }
    // ALL-OR-NOTHING: any error loads zero rows and returns the full list.
    if (allErrors.length > 0) {
      return {
        ok: false as const,
        errors: allErrors,
        summary: { ...summary, errorCount: allErrors.length },
        loaded: 0,
      };
    }
    const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
    await prisma.$transaction(async (tx) => {
      for (const v of valid) {
        const cat = catByCode.get(v.categoryCode.toLowerCase())!;
        const assetClass = cat.assetClass;
        const common = {
          name: v.name,
          nameTh: v.nameTh,
          categoryCode: cat.code,
          assetClass,
          location: v.location,
          assignedUser: v.assignedUser,
          supplier: v.supplier,
          serialNo: v.serialNo,
          purchaseDate: toDate(v.purchaseDate),
          startDate: toDate(v.startDate),
          usefulLifeMonths: v.usefulLifeMonths ?? cat.usefulLifeMonths,
          quantity: v.quantity,
          purchasePrice: v.purchasePrice,
          openingBookValue: v.openingBookValue,
          openingAsOfDate: v.openingAsOfDate ? toDate(v.openingAsOfDate) : null,
          status: v.status,
          disposalDate: v.disposalDate ? toDate(v.disposalDate) : null,
          sellingPrice: v.sellingPrice,
          notes: v.notes,
          linkGroup: v.linkGroup,
        };
        if (v.assetCode && existing.has(v.assetCode.toLowerCase())) {
          const row = await tx.fixedAsset.findFirst({
            where: { entityId: input.entityId, assetNo: v.assetCode },
            include: { disposals: { where: { status: "pending" }, take: 1 } },
          });
          if (row) {
            // Retirement is an approval-gated transition (accounting:approve).
            // An import must never flip a live asset to disposed / written_off
            // or stamp proceeds — those columns are honoured only when seeding
            // a new row for the initial statutory load.
            const {
              status: _status,
              disposalDate: _disposalDate,
              sellingPrice: _sellingPrice,
              ...updatable
            } = common;
            await tx.fixedAsset.update({
              where: { id: row.id },
              data: updatable,
            });
            continue;
          }
        }
        const assetNo =
          v.assetCode ??
          (await this.allocateFreeAssetNo(tx, input.entityId, assetClass));
        await tx.fixedAsset.create({
          data: {
            entityId: input.entityId,
            assetNo,
            createdBy: actorId,
            ...common,
          },
        });
      }
    });
    return { ok: true as const, errors: [], summary, loaded: valid.length };
  }

  // Fixed Asset Report as a 19-column .xlsx buffer that round-trips back through
  // the importer (category-header + "Total" rows carry no asset code and are
  // skipped on re-import). Emits the FULL asset fields, not the summary report,
  // so an exported file can be edited and re-imported.
  async fixedAssetRegisterXlsx(
    query: FixedAssetReportQuery,
    actorId: string,
    permissions: string[] = [],
  ): Promise<Buffer> {
    const asOf = this.resolveAsOf(query.asOf);
    // Owner-scoped like every other read: a download must not hand a caller
    // rows the register list would hide from them.
    const assets = await accountingRepository.findFixedAssetsForReport(
      query.entityId,
      canReadAllAccounting(permissions) ? undefined : actorId,
    );
    const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");
    const history = await this.assetEventHistory(query.entityId);
    const rows: FixedAssetExportRow[] = assets.map((a) => {
      const state = this.assetStateAt(a, history.get(a.id) ?? [], asOf);
      const dep = computeDepreciation(state, this.assetAsOf(a, asOf));
      const sellingPrice =
        a.sellingPrice != null ? Number(a.sellingPrice) : null;
      return {
        assetCode: a.assetNo,
        name: a.name,
        nameTh: a.nameTh ?? "",
        quantity: state.quantity,
        categoryCode: a.categoryCode,
        location: a.location ?? "",
        user: a.assignedUser ?? "",
        supplier: a.supplier ?? "",
        serialNo: a.serialNo ?? "",
        purchaseDate: iso(a.purchaseDate),
        startDate: iso(a.startDate),
        usefulLifeMonths: a.usefulLifeMonths,
        usagePeriodDays: Math.max(0, daysBetween(a.startDate, asOf)),
        purchasePrice: Number(state.purchasePrice),
        bookValue: dep.netBookValue.toNumber(),
        status: a.status,
        disposalDate: iso(a.disposalDate),
        sellingPrice,
        profitLoss:
          sellingPrice != null
            ? this.round2(sellingPrice - dep.netBookValue.toNumber())
            : null,
        notes: a.notes ?? "",
        linkGroup: a.linkGroup ?? "",
      };
    });
    return buildFixedAssetRegisterXlsx(rows, asOf.toISOString().slice(0, 10));
  }
}

export const accountingService = new AccountingService();
