import { z } from "zod";

import { isValidOptionalYmdRange } from "../../common/optional-ymd-range";
import { MAPPING_ROLES } from "./gl-posting.constants";

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format");

export const ACCOUNT_SORT_FIELDS = ["code", "name", "type", "balance"] as const;
export type AccountSortField = (typeof ACCOUNT_SORT_FIELDS)[number];

export const accountQuerySchema = z.object({
  entityId: z.string().optional(),
  type: z.string().optional(),
  isActive: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  parentId: z.string().optional(),
  sortBy: z.enum(ACCOUNT_SORT_FIELDS).optional(),
  sortOrder: z.enum(["asc", "desc"]).default("asc"),
});

export const createAccountSchema = z.object({
  entityId: z.string().min(1, "Entity is required"),
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(200),
  nameTh: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(2000),
  descriptionTh: z.string().trim().min(1).max(2000),
  type: z.enum(["asset", "liability", "equity", "revenue", "expense"]),
  parentId: z.string().optional(),
  // Ticked by the user after reading the warning that this code or English name
  // last belonged to a DEACTIVATED account. Only accepted when that account is
  // squared off and off the financial-statement mapping — a dead account with a
  // balance is refused outright, with or without this flag.
  acknowledgeInactiveReuse: z.boolean().optional(),
});

// Preflight for the account form. `excludeAccountId` is the row being edited,
// so renaming an account never collides with itself.
export const accountReuseCheckSchema = z.object({
  entityId: z.string().min(1, "Entity is required"),
  code: z.string().trim().max(20).optional(),
  name: z.string().trim().max(200).optional(),
  excludeAccountId: z.string().optional(),
});
export type AccountReuseCheckInput = z.infer<typeof accountReuseCheckSchema>;

export const JOURNAL_SORT_FIELDS = [
  "entryNo",
  "reference",
  "date",
  "entity",
  "description",
  "totalDebit",
  "totalCredit",
  "status",
] as const;
export type JournalSortField = (typeof JOURNAL_SORT_FIELDS)[number];

export const journalQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
    entityId: z.string().optional(),
    status: z
      .enum([
        "draft",
        "approved",
        "posted",
        "rejected",
        "cancelled",
        "reversed",
        "deleted",
      ])
      .optional(),
    startDate: dateString.optional(),
    endDate: dateString.optional(),
    // Filter journals by which description column was populated at
    // import time. "en" → `description` is non-null, "th" → `descriptionTh`
    // is non-null. Omitted/"auto" returns every row regardless of which
    // language variant exists.
    descriptionLang: z.enum(["en", "th"]).optional(),
    sortBy: z.enum(JOURNAL_SORT_FIELDS).optional(),
    sortOrder: z.enum(["asc", "desc"]).default("desc"),
  })
  .refine((q) => isValidOptionalYmdRange(q.startDate, q.endDate), {
    message: "End date must not be before start date",
    path: ["endDate"],
  });

const journalLineSchema = z.object({
  accountId: z.string().min(1, "Account is required"),
  debit: z.coerce.number().min(0).default(0),
  credit: z.coerce.number().min(0).default(0),
  memo: z.string().max(500).optional(),
});

export const createJournalSchema = z
  .object({
    entityId: z.string().min(1, "Entity is required"),
    date: dateString,
    description: z.string().max(500).optional(),
    reference: z.string().max(100).optional(),
    lines: z.array(journalLineSchema).min(2, "At least 2 lines required"),
  })
  .refine(
    (data) => {
      const totalDebit = data.lines.reduce((s, l) => s + l.debit, 0);
      const totalCredit = data.lines.reduce((s, l) => s + l.credit, 0);
      return Math.abs(totalDebit - totalCredit) < 0.01;
    },
    { message: "Total debits must equal total credits", path: ["lines"] },
  )
  .refine((data) => data.lines.every((l) => l.debit > 0 || l.credit > 0), {
    message: "Each line must have either a debit or credit amount",
    path: ["lines"],
  });

export const INVOICE_SORT_FIELDS = [
  "invoiceNo",
  "type",
  "counterparty",
  "amount",
  "issueDate",
  "dueDate",
  "status",
] as const;
export type InvoiceSortField = (typeof INVOICE_SORT_FIELDS)[number];

export const invoiceQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  entityId: z.string().optional(),
  type: z.enum(["receivable", "payable"]).optional(),
  status: z
    .enum([
      "draft",
      "sent",
      "partial",
      "paid",
      "overdue",
      "cancelled",
      "deleted",
    ])
    .optional(),
  sortBy: z.enum(INVOICE_SORT_FIELDS).optional(),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

// One billable line. Amount = quantity × unitPrice is derived server-side, so
// it's never accepted from the client.
export const invoiceLineItemSchema = z.object({
  description: z.string().min(1, "Description is required").max(1000),
  quantity: z.coerce.number().positive("Quantity must be positive"),
  unitPrice: z.coerce.number().min(0, "Unit price must be zero or more"),
  lineDiscount: z.coerce.number().min(0).optional(),
  vatRate: z.coerce.number().min(0).max(100).optional(),
  vatReason: z.string().max(200).optional(),
  capitalised: z.boolean().optional(),
  // Optional per-line "category" GL account. When all lines share one, the
  // send posting debits/credits it instead of expense_default/revenue_default.
  glAccountId: z.string().optional(),
});

const invoiceFieldsSchema = z.object({
  entityId: z.string().min(1, "Entity is required"),
  // Statutory INV/EXP numbers are allocated at send. Create may omit this
  // and receive a DRAFT-INV-* placeholder.
  invoiceNo: z.string().min(1).optional(),
  type: z.enum(["receivable", "payable"]),
  counterparty: z.string().min(1, "Counterparty is required"),
  // BILL TO block address (multi-line free text).
  billToAddress: z.string().max(2000).optional(),
  reference: z.string().max(200).optional(),
  paymentTerms: z.string().max(200).optional(),
  currency: z.string().min(1).max(10),
  // FX (M8): optional manual document-date rate (source currency → the entity's
  // base currency). Omitted → the system resolves it from the rate table;
  // required only when a foreign currency has no rate for the issue date.
  exchangeRate: z.coerce.number().positive().optional(),
  // Tax rates as percentages (0..100). VAT + the optional custom tax add;
  // WHT is withheld (subtracted). `taxLabel` names the custom tax (e.g. "GST").
  vatRate: z.coerce.number().min(0).max(100).default(0),
  taxLabel: z.string().max(50).optional(),
  taxRate: z.coerce.number().min(0).max(100).default(0),
  whtRate: z.coerce.number().min(0).max(100).default(0),
  headerDiscount: z.coerce.number().min(0).optional(),
  // Optional satang tweak vs computed grand total (±1.00). Not the source of
  // truth for amount — computeArDocument applies it as rounding only.
  userTotal: z.coerce.number().optional(),
  issueDate: dateString,
  dueDate: dateString,
  linkedJeId: z.string().optional(),
  notes: z.string().max(2000).optional(),
  vendorTaxInvoiceNo: z.string().max(100).optional(),
  vendorId: z.string().uuid().optional(),
  taxInvoiceReceived: z.boolean().optional(),
  // The grand total (`amount`) is computed from these + the rates — the client
  // never sends it. At least one line is required on create.
  lineItems: z
    .array(invoiceLineItemSchema)
    .min(1, "At least 1 line item required"),
});

export const createInvoiceSchema = invoiceFieldsSchema.refine(
  (data) => data.dueDate >= data.issueDate,
  {
    message: "Due date must not be before issue date",
    path: ["dueDate"],
  },
);

// Invoice lifecycle statuses. A dedicated status-change path (not the edit
// form) so a row/detail action can move draft → sent → paid, etc.
export const INVOICE_STATUSES = [
  "draft",
  // Waiting on a second signature. It has no real document number and no
  // journal entry yet, so sending it back costs nothing.
  "pending_second_approval",
  "sent",
  // Set by the payment path when cash is received/paid but the balance isn't
  // fully settled. Not normally set via the manual status route.
  "partial",
  "paid",
  "overdue",
  "cancelled",
] as const;

export const updateInvoiceStatusSchema = z.object({
  status: z.enum(INVOICE_STATUSES),
});

// Admin-editable company + bank block that heads every generated invoice
// (PDF / print / docx). Stored as one global SystemSetting; falls back to the
// default-entity constant in the service.
export const invoiceCompanySchema = z.object({
  name: z.string().max(300),
  addressLines: z.array(z.string().max(300)).max(12).optional(),
  taxId: z.string().max(100).optional(),
  email: z.string().max(200).optional(),
  tel: z.string().max(100).optional(),
  bankName: z.string().max(200).optional(),
  bankAccountType: z.string().max(100).optional(),
  bankBranch: z.string().max(100).optional(),
  bankAccountName: z.string().max(200).optional(),
  bankAccountNo: z.string().max(100).optional(),
  bankSwift: z.string().max(100).optional(),
  footerNote: z.string().max(2000).optional(),
});

export const BANK_TX_SORT_FIELDS = [
  "date",
  "description",
  "entity",
  "amount",
  "status",
] as const;
export type BankTxSortField = (typeof BANK_TX_SORT_FIELDS)[number];

export const bankTransactionQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
    entityId: z.string().optional(),
    status: z.enum(["unmatched", "matched", "reconciled"]).optional(),
    startDate: dateString.optional(),
    endDate: dateString.optional(),
    sortBy: z.enum(BANK_TX_SORT_FIELDS).optional(),
    sortOrder: z.enum(["asc", "desc"]).default("desc"),
  })
  .refine((q) => isValidOptionalYmdRange(q.startDate, q.endDate), {
    message: "End date must not be before start date",
    path: ["endDate"],
  });

const bankTransactionRowSchema = z.object({
  date: dateString,
  description: z.string().min(1),
  amount: z.coerce.number(),
  balance: z.coerce.number().optional(),
  reference: z.string().optional(),
  bankAccount: z.string().optional(),
});

export const importBankStatementSchema = z.object({
  entityId: z.string().min(1, "Entity is required"),
  transactions: z
    .array(bankTransactionRowSchema)
    .min(1, "At least 1 transaction required"),
});

// ── Bank reconciliation (M7) ───────────────────────────────────────────────
export const reconcileTransactionSchema = z.object({
  // Optional GL account to code the transaction to on reconcile.
  mappedAccountId: z.string().min(1).optional(),
});
export type ReconcileTransactionInput = z.infer<
  typeof reconcileTransactionSchema
>;

export const reconciliationSummaryQuerySchema = z.object({
  entityId: z.string().min(1, "Entity is required"),
  asOf: dateString.optional(),
  // Statement closing balance to check the book balance against.
  statementBalance: z.coerce.number().optional(),
});
export type ReconciliationSummaryQuery = z.infer<
  typeof reconciliationSummaryQuerySchema
>;

// Bank-match suggestions are per entity (matched against that entity's open docs).
export const bankMatchQuerySchema = z.object({
  entityId: z.string().min(1, "Entity is required"),
});
export type BankMatchQuery = z.infer<typeof bankMatchQuerySchema>;

// Expense workspace summary — total + by-category AP spend for a year, or one
// month when `month` (1-12) is given.
export const expenseSummaryQuerySchema = z.object({
  entityId: z.string().min(1, "Entity is required"),
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12).optional(),
});
export type ExpenseSummaryQuery = z.infer<typeof expenseSummaryQuerySchema>;

// Global accounting search — one free-text term across invoices/bills, journal
// entries, chart of accounts, bank lines and payments. `limit` caps hits PER
// group (the panel shows the top N of each). `entityId` optionally narrows.
export const accountingSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(100),
  entityId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(20).default(6),
});
export type AccountingSearchQuery = z.infer<typeof accountingSearchQuerySchema>;

// AR/AP aging + liquidity roll-up (M11 dashboard). One entity, reported in its
// base currency, as of a date (defaults to today).
export const agingSummaryQuerySchema = z.object({
  entityId: z.string().min(1, "Entity is required"),
  asOf: dateString.optional(),
});
export type AgingSummaryQuery = z.infer<typeof agingSummaryQuerySchema>;

// Statement of account (M1): one counterparty, one AR/AP side, as of a date.
export const statementQuerySchema = z.object({
  entityId: z.string().min(1, "Entity is required"),
  counterparty: z.string().min(1, "Counterparty is required"),
  type: z.enum(["receivable", "payable"]).default("receivable"),
  asOf: dateString.optional(),
});
export type StatementQuery = z.infer<typeof statementQuerySchema>;

// ── Bank accounts (master) ─────────────────────────────────────────────────
export const BANK_ACCOUNT_KINDS = ["bank", "cash"] as const;

export const bankAccountQuerySchema = z.object({
  entityId: z.string().optional(),
  includeInactive: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

export const createBankAccountSchema = z.object({
  entityId: z.string().min(1, "Entity is required"),
  name: z.string().min(1, "Name is required").max(200),
  kind: z.enum(BANK_ACCOUNT_KINDS).default("bank"),
  accountNumber: z.string().max(100).optional(),
  currency: z.string().min(1).max(10).default("THB"),
  openingBalance: z.coerce.number().default(0),
  // GL cash/bank account this account posts through. Required before the
  // account can be used as a payment target while GL posting is enabled.
  glAccountId: z.string().optional(),
  sortOrder: z.coerce.number().int().optional(),
});

export const updateBankAccountSchema = createBankAccountSchema
  .partial()
  .omit({ entityId: true });

// ── Payments (receipt against AR / disbursement against AP) ─────────────────
export const PAYMENT_METHODS = [
  "cash",
  "bank-transfer",
  "cheque",
  "other",
] as const;

export const recordPaymentSchema = z.object({
  bankAccountId: z.string().min(1, "Bank account is required"),
  date: dateString,
  // Cash moved (net of WHT). Must be positive; over-payment is rejected in the
  // service against the invoice's outstanding balance.
  amount: z.coerce.number().positive("Payment amount must be positive"),
  // FX (M8): payment currency (defaults to the invoice's) + optional manual
  // settlement-date rate (payment currency → the entity's base currency).
  // Resolved automatically when omitted.
  currency: z.string().min(1).max(10).optional(),
  exchangeRate: z.coerce.number().positive().optional(),
  // Tax withheld by/from the counterparty. Booked as a separate GL leg.
  whtAmount: z.coerce.number().min(0).default(0),
  // Bank fee charged on the cash movement. Posted Dr bank_charges / Cr Bank.
  bankFee: z.coerce.number().min(0).default(0),
  method: z.enum(PAYMENT_METHODS).default("bank-transfer"),
  reference: z.string().max(200).optional(),
  notes: z.string().max(2000).optional(),
  // Overpayment → customer advance (M3): opt-in. When true and the receipt
  // exceeds the invoice's outstanding, the excess is captured as a customer
  // advance instead of being rejected. AR + base-currency + no-WHT only.
  // Explicit boolean (NOT z.coerce, which maps any non-empty string incl.
  // "false" → true) so a non-JSON caller can't silently enable it.
  allowOverpayment: z.boolean().optional().default(false),
  // What the leftover cash IS. Mandatory once there is an excess, because the
  // two answers have different tax consequences: an advance for future work is
  // a sale and VAT falls due on receipt; money received in error is not a sale
  // and carries none. The service refuses an excess with no answer rather than
  // picking one.
  excessKind: z.enum(["advance", "refundable"]).optional(),
  writeOffRemainder: z.boolean().optional().default(false),
  writeOffReason: z.string().trim().max(1000).optional(),
});

export const paymentListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  entityId: z.string().optional(),
  type: z.enum(["receivable", "payable"]).optional(),
});

// Settle an imported bank line against an open invoice: records the payment for
// the line's amount (via the sole cash path) and adopts the imported row as the
// payment's register line. The bank account the cash moved through must be
// supplied (imported rows don't carry it); date defaults to the line's date.
export const settleBankTransactionSchema = z.object({
  invoiceId: z.string().min(1, "Invoice is required"),
  bankAccountId: z.string().min(1, "Bank account is required"),
  date: dateString.optional(),
  method: z.enum(PAYMENT_METHODS).optional(),
  reference: z.string().max(200).optional(),
});
export type SettleBankTransactionInput = z.infer<
  typeof settleBankTransactionSchema
>;

// Apply an existing customer advance to an open AR invoice (M3).
export const applyAdvanceSchema = z.object({
  invoiceId: z.string().min(1, "Invoice is required"),
  amount: z.coerce.number().positive("Amount must be positive"),
  date: dateString.optional(),
});
export type ApplyAdvanceInput = z.infer<typeof applyAdvanceSchema>;

// Refund an advance / overpayment back to the counterparty.
//
// `creditNoteId` is mandatory for kind='advance' and refused for
// kind='refundable' — enforced in the service, where the advance's kind is
// known. An advance had a tax invoice issued against it when the money
// arrived, so returning the money needs the document that reverses that tax;
// money received in error never had one, so demanding a credit note would
// create a tax document for a sale that never happened.
export const refundAdvanceSchema = z.object({
  bankAccountId: z.string().min(1, "Bank account is required"),
  date: dateString.optional(),
  amount: z.coerce.number().positive("Amount must be positive").optional(),
  creditNoteId: z.string().optional(),
  reason: z.string().trim().max(1000).optional(),
});
export type RefundAdvanceInput = z.infer<typeof refundAdvanceSchema>;

// The supplier has issued their tax invoice for a prepayment already paid.
// Paying created no right to input tax; this document does, so the VAT is split
// out of the asset now rather than at payment time.
export const prepaymentTaxInvoiceSchema = z.object({
  taxInvoiceNo: z.string().trim().min(1, "Tax invoice number is required"),
  date: dateString.optional(),
  // Amount stated on the supplier's tax invoice, VAT-inclusive. Defaults to the
  // whole remaining prepayment.
  grossAmount: z.coerce.number().positive().optional(),
  vatRatePercent: z.coerce.number().min(0).max(100).optional(),
});
export type PrepaymentTaxInvoiceInput = z.infer<
  typeof prepaymentTaxInvoiceSchema
>;

export const customerAdvanceQuerySchema = z.object({
  entityId: z.string().min(1, "Entity is required"),
  counterparty: z.string().optional(),
  status: z.enum(["open", "applied", "void"]).optional(),
});
export type CustomerAdvanceQuery = z.infer<typeof customerAdvanceQuerySchema>;

// ── Multi-invoice settlement (M3/M6, behind ACCOUNTING_SETTLEMENT_V2) ────────
// One receipt/disbursement clearing many invoices at once. Each allocation's
// `amount` is the NET cash applied to that invoice (mirroring recordPayment's
// `amount`; invoices are stored net of WHT), and `whtAmount` is the tax withheld
// — booked as a separate GL leg, so the receivable/payable clears by their sum.
// The entity + AR/AP type are derived from the target invoices (which must agree).
export const recordAllocatedPaymentSchema = z.object({
  bankAccountId: z.string().min(1, "Bank account is required"),
  date: dateString,
  currency: z.string().min(1).max(10).optional(),
  exchangeRate: z.coerce.number().positive().optional(),
  method: z.enum(PAYMENT_METHODS).default("bank-transfer"),
  reference: z.string().max(200).optional(),
  notes: z.string().max(2000).optional(),
  allocations: z
    .array(
      z.object({
        invoiceId: z.string().min(1),
        amount: z.coerce
          .number()
          .positive("Allocation amount must be positive"),
        whtAmount: z.coerce.number().min(0).default(0),
      }),
    )
    .min(1, "At least one allocation is required")
    .max(200),
});
export type RecordAllocatedPaymentInput = z.infer<
  typeof recordAllocatedPaymentSchema
>;

// ── Payment run (M6, behind ACCOUNTING_SETTLEMENT_V2) ────────────────────────
// Pay many supplier bills in one operation. The lines are grouped by payee and
// each group is settled as one bank payment via the multi-invoice write path.
// `amount` is the net cash applied to each bill; `whtAmount` is additional.
export const paymentRunSchema = z.object({
  bankAccountId: z.string().min(1, "Bank account is required"),
  date: dateString,
  method: z.enum(PAYMENT_METHODS).default("bank-transfer"),
  reference: z.string().max(200).optional(),
  lines: z
    .array(
      z.object({
        invoiceId: z.string().min(1),
        amount: z.coerce.number().positive("Amount must be positive"),
        whtAmount: z.coerce.number().min(0).default(0),
      }),
    )
    .min(1, "At least one bill is required")
    .max(500),
});
export type PaymentRunInput = z.infer<typeof paymentRunSchema>;

// ── Financial reports ──────────────────────────────────────────────────────
// As-of statements (Trial Balance, Balance Sheet); asOf defaults to today.
export const reportAsOfQuerySchema = z.object({
  entityId: z.string().optional(),
  asOf: dateString.optional(),
});

// Period statements (Profit & Loss, Cash Flow).
export const reportPeriodQuerySchema = z
  .object({
    entityId: z.string().optional(),
    startDate: dateString,
    endDate: dateString,
  })
  .refine((q) => isValidOptionalYmdRange(q.startDate, q.endDate), {
    message: "End date must not be before start date",
    path: ["endDate"],
  });

// VAT/WHT tax summary — always per legal entity (VAT is filed per entity).
export const taxReportQuerySchema = z
  .object({
    entityId: z.string().min(1, "Entity is required"),
    startDate: dateString,
    endDate: dateString,
  })
  .refine((q) => isValidOptionalYmdRange(q.startDate, q.endDate), {
    message: "End date must not be before start date",
    path: ["endDate"],
  });
export type TaxReportQuery = z.infer<typeof taxReportQuerySchema>;

// ── Tax filings + tax-month lock (M9) ──────────────────────────────────────
export const TAX_FILING_TYPES = ["vat"] as const;

export const taxFilingQuerySchema = z.object({
  entityId: z.string().min(1, "Entity is required"),
  filingType: z.enum(TAX_FILING_TYPES).optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});
export type TaxFilingQuery = z.infer<typeof taxFilingQuerySchema>;

export const fileTaxSchema = z.object({
  entityId: z.string().min(1, "Entity is required"),
  filingType: z.enum(TAX_FILING_TYPES).default("vat"),
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
  notes: z.string().max(500).optional(),
});
export type FileTaxInput = z.infer<typeof fileTaxSchema>;

export const reopenTaxSchema = z.object({
  entityId: z.string().min(1, "Entity is required"),
  filingType: z.enum(TAX_FILING_TYPES).default("vat"),
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
});
export type ReopenTaxInput = z.infer<typeof reopenTaxSchema>;

// ── Accounting audit-log viewer (M12) ──────────────────────────────────────
export const auditLogQuerySchema = z.object({
  resource: z.string().max(100).optional(),
  action: z.string().max(100).optional(),
  startDate: dateString.optional(),
  endDate: dateString.optional(),
  limit: z.coerce.number().int().positive().max(200).default(100),
});
export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;

// ── Fiscal periods ─────────────────────────────────────────────────────────
export const fiscalPeriodQuerySchema = z.object({
  entityId: z.string().optional(),
});

export const closePeriodSchema = z.object({
  entityId: z.string().min(1, "Entity is required"),
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
  note: z.string().max(500).optional(),
});

export const reopenPeriodSchema = z.object({
  entityId: z.string().min(1, "Entity is required"),
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
});

// Period-end FX revaluation (M8, unrealised, TAS 21).
export const revaluePeriodSchema = z.object({
  entityId: z.string().min(1, "Entity is required"),
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
});

// ── Credit / debit notes (statutory adjustment notes) ──────────────────────
// `type` is the AR/AP side; `noteKind` is credit (reduce the balance) vs debit
// (increase it). The two axes are independent — all four combinations are valid.
export const CREDIT_NOTE_TYPES = ["receivable", "payable"] as const;
export const CREDIT_NOTE_KINDS = ["credit", "debit"] as const;

const creditNoteLineSchema = z.object({
  description: z.string().min(1, "Description is required").max(1000),
  quantity: z.coerce.number().positive("Quantity must be positive"),
  unitPrice: z.coerce.number().min(0, "Unit price must be zero or more"),
  taxRate: z.coerce.number().min(0).max(100).default(0),
  glAccountId: z.string().optional(),
});

export const creditNoteQuerySchema = z.object({
  entityId: z.string().optional(),
  type: z.enum(CREDIT_NOTE_TYPES).optional(),
  noteKind: z.enum(CREDIT_NOTE_KINDS).optional(),
  status: z.enum(["draft", "issued", "applied", "cancelled"]).optional(),
});

export const createCreditNoteSchema = z.object({
  entityId: z.string().min(1, "Entity is required"),
  type: z.enum(CREDIT_NOTE_TYPES),
  // Credit (reduce balance) or debit (increase balance). Defaults to credit so
  // existing callers are unaffected.
  noteKind: z.enum(CREDIT_NOTE_KINDS).default("credit"),
  // The invoice/bill this note credits, if any (informational link for now).
  linkedInvoiceId: z.string().optional(),
  issueDate: dateString,
  reason: z.string().max(500).optional(),
  notes: z.string().max(2000).optional(),
  lines: z.array(creditNoteLineSchema).min(1, "At least 1 line is required"),
});

export type CreditNoteQuery = z.infer<typeof creditNoteQuerySchema>;
export type CreateCreditNoteInput = z.infer<typeof createCreditNoteSchema>;

// ── Suppliers (open-balance summary) ───────────────────────────────────────
export const supplierSummaryQuerySchema = z.object({
  entityId: z.string().optional(),
});
export type SupplierSummaryQuery = z.infer<typeof supplierSummaryQuerySchema>;

// ── Quotes ─────────────────────────────────────────────────────────────────
export const QUOTE_STATUSES = [
  "draft",
  "sent",
  "accepted",
  "declined",
  "expired",
  "converted",
] as const;

const quoteLineSchema = z.object({
  description: z.string().min(1, "Description is required").max(1000),
  quantity: z.coerce.number().positive("Quantity must be positive"),
  unitPrice: z.coerce.number().min(0, "Unit price must be zero or more"),
  taxRate: z.coerce.number().min(0).max(100).default(0),
  glAccountId: z.string().optional(),
});

export const quoteQuerySchema = z.object({
  entityId: z.string().optional(),
  status: z.enum(QUOTE_STATUSES).optional(),
});

export const createQuoteSchema = z.object({
  entityId: z.string().min(1, "Entity is required"),
  vendorId: z.string().uuid().optional(),
  issueDate: dateString,
  expiryDate: dateString.optional(),
  currency: z.string().min(1).max(10).default("THB"),
  notes: z.string().max(2000).optional(),
  lines: z.array(quoteLineSchema).min(1, "At least 1 line is required"),
});

export const updateQuoteSchema = createQuoteSchema
  .partial()
  .omit({ entityId: true });

export type QuoteQuery = z.infer<typeof quoteQuerySchema>;
export type CreateQuoteInput = z.infer<typeof createQuoteSchema>;
export type UpdateQuoteInput = z.infer<typeof updateQuoteSchema>;

// ── Purchase orders ──────────────────────────────────────────────────────
export const PO_STATUSES = [
  "draft",
  "sent",
  "awaiting-delivery",
  "partially-received",
  "completed",
  "billed",
  "cancelled",
] as const;

const poLineSchema = z.object({
  description: z.string().min(1, "Description is required").max(1000),
  quantity: z.coerce.number().positive("Quantity must be positive"),
  unitPrice: z.coerce.number().min(0, "Unit price must be zero or more"),
  taxRate: z.coerce.number().min(0).max(100).default(0),
  glAccountId: z.string().optional(),
});

export const purchaseOrderQuerySchema = z.object({
  entityId: z.string().optional(),
  status: z.enum(PO_STATUSES).optional(),
});

export const createPurchaseOrderSchema = z.object({
  entityId: z.string().min(1, "Entity is required"),
  vendorId: z.string().uuid().optional(),
  orderDate: dateString,
  expectedDate: dateString.optional(),
  currency: z.string().min(1).max(10).default("THB"),
  notes: z.string().max(2000).optional(),
  lines: z.array(poLineSchema).min(1, "At least 1 line is required"),
});

// Mark quantities received. Omit `lines` to receive every line in full.
export const receivePurchaseOrderSchema = z.object({
  lines: z
    .array(
      z.object({
        lineId: z.string().min(1),
        qtyReceived: z.coerce.number().min(0),
      }),
    )
    .optional(),
});

export type PurchaseOrderQuery = z.infer<typeof purchaseOrderQuerySchema>;
export type CreatePurchaseOrderInput = z.infer<
  typeof createPurchaseOrderSchema
>;
export type ReceivePurchaseOrderInput = z.infer<
  typeof receivePurchaseOrderSchema
>;

export const updateAccountSchema = createAccountSchema
  .partial()
  .omit({ entityId: true })
  .extend({
    // Deactivate / reactivate. Not part of create (a new account is always
    // active) and deliberately distinct from delete, which soft-deletes the row:
    // a deactivated account keeps carrying its history on old documents.
    isActive: z.boolean().optional(),
  });

// Journal entry import — frontend parses the accounting-system GL xlsx
// locally, groups rows by Document No (voucher), and POSTs canonical
// journal-entry payloads. Each entry must balance (sum of debits == sum
// of credits) and reference accounts by their `code` so the backend can
// resolve them to ChartOfAccount.id per entity.
const journalImportLineSchema = z.object({
  accountCode: z.string().min(1).max(50),
  debit: z.coerce.number().min(0).default(0),
  credit: z.coerce.number().min(0).default(0),
  memo: z.string().max(500).optional(),
});

const journalImportEntrySchema = z.object({
  reference: z.string().min(1).max(100),
  date: dateString,
  description: z.string().max(500).optional(),
  lines: z.array(journalImportLineSchema).min(1),
});

export const importJournalsSchema = z.object({
  entityId: z.string().min(1, "Entity is required"),
  status: z.enum(["draft", "approved", "posted"]).default("posted"),
  // GL export is single-language per file. The importer fills
  // `description` for "en" and `descriptionTh` for "th"; when a
  // reference already exists, only the chosen language column is
  // overwritten. Defaults to English to preserve the previous import
  // behaviour for callers that don't pass the field yet.
  language: z.enum(["en", "th"]).default("en"),
  entries: z
    .array(journalImportEntrySchema)
    .min(1, "At least 1 entry required")
    .max(5000),
});

const accountImportRowSchema = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(200),
  nameTh: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  descriptionTh: z.string().max(2000).optional(),
  type: z.enum(["asset", "liability", "equity", "revenue", "expense"]),
});

export const importAccountsSchema = z.object({
  entityId: z.string().min(1, "Entity is required"),
  rows: z
    .array(accountImportRowSchema)
    .min(1, "At least 1 row required")
    .max(2000),
});

export const updateJournalSchema = z
  .object({
    date: dateString.optional(),
    description: z.string().max(500).optional(),
    reference: z.string().max(100).optional(),
    lines: z
      .array(journalLineSchema)
      .min(2, "At least 2 lines required")
      .optional(),
  })
  .refine(
    (data) => {
      if (!data.lines) return true;
      const totalDebit = data.lines.reduce((s, l) => s + l.debit, 0);
      const totalCredit = data.lines.reduce((s, l) => s + l.credit, 0);
      return Math.abs(totalDebit - totalCredit) < 0.01;
    },
    { message: "Total debits must equal total credits", path: ["lines"] },
  )
  .refine(
    (data) => {
      if (!data.lines) return true;
      return data.lines.every((l) => l.debit > 0 || l.credit > 0);
    },
    {
      message: "Each line must have either a debit or credit amount",
      path: ["lines"],
    },
  );

export const updateInvoiceSchema = invoiceFieldsSchema
  .partial()
  .omit({ entityId: true })
  .refine((data) => isValidOptionalYmdRange(data.issueDate, data.dueDate), {
    message: "Due date must not be before issue date",
    path: ["dueDate"],
  });

export const bulkDeleteJournalsSchema = z
  .object({
    all: z.boolean().optional(),
    ids: z.array(z.string().uuid()).max(1000).optional(),
  })
  .refine((v) => v.all === true || (v.ids && v.ids.length > 0), {
    message: "Provide `ids` to delete specific journals or set `all: true`",
  });

export type BulkDeleteJournalsInput = z.infer<typeof bulkDeleteJournalsSchema>;

export const rejectJournalSchema = z.object({
  reason: z.string().trim().min(1, "Rejection reason is required").max(1000),
});
export type RejectJournalInput = z.infer<typeof rejectJournalSchema>;

export const cancelJournalSchema = z.object({
  reason: z.string().trim().min(1, "Cancellation reason is required").max(1000),
  reverseDate: dateString.optional(),
});

export const mergeVendorsSchema = z.object({
  survivingVendorId: z.string().uuid(),
  sourceVendorId: z.string().uuid(),
  missingTaxIdReason: z.string().trim().max(1000).optional(),
  // Required when merging without a tax ID. A merge cannot be undone and the
  // identity is a judgement call at that point, so somebody has to own it.
  acknowledgedSameParty: z.boolean().optional(),
  keepFields: z.record(z.string(), z.enum(["surviving", "source"])).optional(),
});

export const vendorMergePreviewQuerySchema = z.object({
  survivingVendorId: z.string().uuid(),
  sourceVendorId: z.string().uuid(),
});

export const bulkReviewJournalsSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(1000),
});

export const bulkRejectJournalsSchema = bulkReviewJournalsSchema.extend({
  reason: z.string().trim().min(1, "Rejection reason is required").max(1000),
});

export const corporateOverviewQuerySchema = z
  .object({
    period: z.enum(["mtd", "qtd", "ytd", "custom"]).default("ytd"),
    entityId: z.string().optional(),
    startDate: dateString.optional(),
    endDate: dateString.optional(),
  })
  .refine((q) => isValidOptionalYmdRange(q.startDate, q.endDate), {
    message: "End date must not be before start date",
    path: ["endDate"],
  })
  .refine((q) => q.period !== "custom" || Boolean(q.startDate && q.endDate), {
    message: "Custom period requires start and end dates",
    path: ["startDate"],
  });

// ── Account-role mapping + GL posting readiness (foundation) ───────────────
// The mapping table (account_mappings) routes each posting role to a concrete
// ChartOfAccount per entity. Config-only surface; posting itself is gated
// separately on ACCOUNTING_GL_POSTING + a complete mapping.
export const accountMappingQuerySchema = z.object({
  entityId: z.string().min(1, "Entity is required"),
});

export const upsertAccountMappingSchema = z.object({
  entityId: z.string().min(1, "Entity is required"),
  role: z.enum(MAPPING_ROLES),
  // null / omitted clears the mapping for this role (leaves it unmapped).
  chartOfAccountId: z.string().min(1).nullish(),
});

export const postingReadinessQuerySchema = z.object({
  // Omitted → readiness for every entity that has a chart of accounts.
  entityId: z.string().optional(),
});

// ── Company setup, fiscal year & activation gate (Phase-1 Foundation, Chunk 2)
// The entity-scoped company profile that the accounting company-setup surface
// reads/writes. All writes are additive to the Entity row; existing data is
// never rewritten unless an admin submits a value.
export const VAT_REGISTRATION_STATUSES = [
  "registered",
  "not_registered",
  "exempt",
] as const;

export const RATE_SOURCES = ["bot", "commercial_bank"] as const;

// The consolidation / reporting currency. Every entity must keep it enabled so
// financial statements can always be expressed in it.
export const REPORTING_CURRENCY = "THB";

export const companyProfileQuerySchema = z.object({
  entityId: z.string().min(1, "Entity is required"),
});

export const updateCompanyProfileSchema = z
  .object({
    entityId: z.string().min(1, "Entity is required"),
    nameTh: z.string().max(300).nullish(),
    branchCode: z.string().max(20).nullish(),
    logoUrl: z.string().max(2000).nullish(),
    vatRegistrationStatus: z.enum(VAT_REGISTRATION_STATUSES).nullish(),
    boiType: z.string().max(100).nullish(),
    boiPeriod: z.string().max(100).nullish(),
    fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
    firstFiscalYearStart: z.coerce.date().nullish(),
    firstFiscalYearEnd: z.coerce.date().nullish(),
    defaultRateSource: z.enum(RATE_SOURCES).optional(),
    enabledCurrencies: z
      .array(z.string().trim().min(1).max(10))
      .max(50)
      .optional(),
  })
  // Only enforced when the caller actually submits the currency list — a PUT
  // that omits it leaves the stored value untouched.
  .refine(
    (v) =>
      v.enabledCurrencies === undefined ||
      v.enabledCurrencies.includes(REPORTING_CURRENCY),
    {
      message: `Enabled currencies must include ${REPORTING_CURRENCY} (the reporting currency)`,
      path: ["enabledCurrencies"],
    },
  );

export const activateCompanySchema = z.object({
  entityId: z.string().min(1, "Entity is required"),
});

// ── Opening-balance import (Chunk 6 · M0.1.9) ──────────────────────────────
// One dated opening journal entry that ties a newly set-up entity's books to
// its prior-year closing figures. Entered ONCE, during setup, before
// activation. The four arrays mirror a trial balance: plain GL rows, plus the
// AR / AP / bank figures which need control-account routing so the GL engine
// can post them (the opening-balance-equity account is the plug).
const openingAccountLineSchema = z
  .object({
    chartOfAccountId: z.string().min(1, "Account is required"),
    debit: z.coerce.number().min(0).optional(),
    credit: z.coerce.number().min(0).optional(),
  })
  // A trial-balance row is one-sided: exactly one of debit / credit is nonzero.
  .refine(
    (r) => {
      const hasDebit = typeof r.debit === "number" && r.debit !== 0;
      const hasCredit = typeof r.credit === "number" && r.credit !== 0;
      return hasDebit !== hasCredit;
    },
    {
      message: "Each account row needs either a debit or a credit (not both).",
    },
  );

const openingCounterpartyLineSchema = z.object({
  vendorId: z.string().min(1).nullish(),
  counterpartyName: z.string().trim().max(300).nullish(),
  amount: z.coerce.number(),
});

const openingBankLineSchema = z.object({
  chartOfAccountId: z.string().min(1, "Bank GL account is required"),
  amount: z.coerce.number(),
});

export const importOpeningBalancesSchema = z
  .object({
    entityId: z.string().min(1, "Entity is required"),
    // The go-live / opening date the entry is posted on.
    asOfDate: z.coerce.date(),
    accounts: z
      .array(openingAccountLineSchema)
      .max(2000)
      .optional()
      .default([]),
    openReceivables: z
      .array(openingCounterpartyLineSchema)
      .max(5000)
      .optional()
      .default([]),
    openPayables: z
      .array(openingCounterpartyLineSchema)
      .max(5000)
      .optional()
      .default([]),
    bankBalances: z
      .array(openingBankLineSchema)
      .max(500)
      .optional()
      .default([]),
  })
  .refine(
    (v) =>
      v.accounts.length +
        v.openReceivables.length +
        v.openPayables.length +
        v.bankBalances.length >
      0,
    { message: "Provide at least one opening-balance row." },
  );

export const openingBalancesQuerySchema = z.object({
  entityId: z.string().min(1, "Entity is required"),
});

export type AccountMappingQuery = z.infer<typeof accountMappingQuerySchema>;
export type UpsertAccountMappingInput = z.infer<
  typeof upsertAccountMappingSchema
>;
export type PostingReadinessQuery = z.infer<typeof postingReadinessQuerySchema>;
export type CompanyProfileQuery = z.infer<typeof companyProfileQuerySchema>;
export type UpdateCompanyProfileInput = z.infer<
  typeof updateCompanyProfileSchema
>;
export type ActivateCompanyInput = z.infer<typeof activateCompanySchema>;
export type ImportOpeningBalancesInput = z.infer<
  typeof importOpeningBalancesSchema
>;
export type OpeningBalancesQuery = z.infer<typeof openingBalancesQuerySchema>;

// ── Tax codes (Thai VAT + WHT config) ──────────────────────────────────────
// TaxCode drives line-level tax computation and the GL account tax posts to.
// Entity-scoped config; writes are admin-gated (mirrors account_mappings).
export const TAX_CODE_KINDS = ["vat-output", "vat-input", "wht"] as const;

export const taxCodesQuerySchema = z.object({
  entityId: z.string().min(1, "Entity is required"),
  // Inactive codes are hidden by default; the config screen opts in.
  includeInactive: z.coerce.boolean().optional(),
});

export const upsertTaxCodeSchema = z.object({
  entityId: z.string().min(1, "Entity is required"),
  code: z.string().trim().min(1, "Code is required").max(50),
  name: z.string().trim().min(1, "Name is required").max(200),
  kind: z.enum(TAX_CODE_KINDS),
  // Fractional rate, e.g. 0.07 for VAT 7%, 0.03 for WHT 3% (matches the
  // TaxCode.rate Decimal(7,4) column). 0..1 covers every real tax rate.
  rate: z.coerce.number().min(0, "Rate must be zero or more").max(1),
  // null / omitted leaves the tax GL account unset.
  glAccountId: z.string().min(1).nullish(),
  isActive: z.boolean().optional(),
});

// Update is a partial of the create shape; entityId is immutable once set.
export const updateTaxCodeSchema = upsertTaxCodeSchema
  .partial()
  .omit({ entityId: true });

export type TaxCodesQuery = z.infer<typeof taxCodesQuerySchema>;
export type UpsertTaxCodeInput = z.infer<typeof upsertTaxCodeSchema>;
export type UpdateTaxCodeInput = z.infer<typeof updateTaxCodeSchema>;

// ── Maker-checker config (block self-approval of journals) ──────────────────
// Stored as a single SystemSetting row; default OFF (behavior unchanged).
export const makerCheckerConfigSchema = z.object({
  blockSelfApproval: z.boolean(),
});

export type MakerCheckerConfigInput = z.infer<typeof makerCheckerConfigSchema>;

// ── Second-level approval config (PRD 9.6) ──────────────────────────────────
// One SystemSetting row. Ships disabled: a one-accountant team has nobody to be
// the second approver, and switching it on then would just stop work.
export const secondApprovalConfigSchema = z.object({
  enabled: z.boolean(),
  thresholds: z.object({
    invoice: z.number().min(0).nullable().optional(),
    bill: z.number().min(0).nullable().optional(),
    journal: z.number().min(0).nullable().optional(),
  }),
  staleDays: z.number().int().min(1).max(365).default(7),
});
export type SecondApprovalConfigInput = z.infer<
  typeof secondApprovalConfigSchema
>;

export const secondApprovalDecisionSchema = z.object({
  // Sending back is the only decision that needs an explanation — approving is
  // explained by the document.
  reason: z.string().trim().max(1000).optional(),
});
export type SecondApprovalDecisionInput = z.infer<
  typeof secondApprovalDecisionSchema
>;
export type CancelJournalInput = z.infer<typeof cancelJournalSchema>;

export type AccountQuery = z.infer<typeof accountQuerySchema>;
export type CreateAccountInput = z.infer<typeof createAccountSchema>;
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;
export type JournalQuery = z.infer<typeof journalQuerySchema>;
export type CorporateOverviewQuery = z.infer<
  typeof corporateOverviewQuerySchema
>;
export type CreateJournalInput = z.infer<typeof createJournalSchema>;
export type UpdateJournalInput = z.infer<typeof updateJournalSchema>;
export type InvoiceQuery = z.infer<typeof invoiceQuerySchema>;
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;
export type UpdateInvoiceInput = z.infer<typeof updateInvoiceSchema>;
export type InvoiceLineItemInput = z.infer<typeof invoiceLineItemSchema>;
export type InvoiceCompanyInput = z.infer<typeof invoiceCompanySchema>;
export type UpdateInvoiceStatusInput = z.infer<
  typeof updateInvoiceStatusSchema
>;
export type BankTransactionQuery = z.infer<typeof bankTransactionQuerySchema>;
export type ImportBankStatementInput = z.infer<
  typeof importBankStatementSchema
>;
export type BankAccountQuery = z.infer<typeof bankAccountQuerySchema>;
export type CreateBankAccountInput = z.infer<typeof createBankAccountSchema>;
export type UpdateBankAccountInput = z.infer<typeof updateBankAccountSchema>;
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;
export type PaymentListQuery = z.infer<typeof paymentListQuerySchema>;
export type ReportAsOfQuery = z.infer<typeof reportAsOfQuerySchema>;
export type ReportPeriodQuery = z.infer<typeof reportPeriodQuerySchema>;
export type FiscalPeriodQuery = z.infer<typeof fiscalPeriodQuerySchema>;
export type ClosePeriodInput = z.infer<typeof closePeriodSchema>;
export type ReopenPeriodInput = z.infer<typeof reopenPeriodSchema>;
export type RevaluePeriodInput = z.infer<typeof revaluePeriodSchema>;
export type ImportAccountsInput = z.infer<typeof importAccountsSchema>;
export type ImportAccountRow = z.infer<typeof accountImportRowSchema>;
export type ImportJournalsInput = z.infer<typeof importJournalsSchema>;
export type ImportJournalEntry = z.infer<typeof journalImportEntrySchema>;
export type ImportJournalLine = z.infer<typeof journalImportLineSchema>;

// ─── Fixed Asset Register ─────────────────────────────────────────

export const FIXED_ASSET_CLASSES = ["IT", "PFA", "FF"] as const;
const fixedAssetClassEnum = z.enum(FIXED_ASSET_CLASSES);

// active / idle / pending_disposal count as "asset using"; disposed /
// written_off / transferred as "asset not using" (PRD §4 statuses).
export const FIXED_ASSET_STATUSES = [
  "active",
  "idle",
  "pending_disposal",
  "disposed",
  "written_off",
  "transferred",
] as const;
const fixedAssetStatusEnum = z.enum(FIXED_ASSET_STATUSES);

export const FIXED_ASSET_SORT_FIELDS = [
  "assetNo",
  "name",
  "categoryCode",
  "purchaseDate",
  "purchasePrice",
  "status",
] as const;

export const fixedAssetQuerySchema = z.object({
  entityId: z.string().optional(),
  status: fixedAssetStatusEnum.optional(),
  categoryCode: z.string().optional(),
  assetClass: fixedAssetClassEnum.optional(),
  search: z.string().optional(),
  // "As at" date for the net-book-value / accumulated-depreciation snapshot.
  asOf: dateString.optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  sortBy: z.enum(FIXED_ASSET_SORT_FIELDS).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
});

const fixedAssetBase = z.object({
  entityId: z.string().min(1),
  // Blank → the service generates FA-{class}-{YYYY}-NNN; supplied → kept as-is.
  assetNo: z.string().max(60).optional(),
  name: z.string().min(1).max(200),
  nameTh: z.string().max(200).optional().nullable(),
  categoryCode: z.string().min(1),
  // Defaults from the category when omitted.
  assetClass: fixedAssetClassEnum.optional(),
  location: z.string().max(200).optional().nullable(),
  assignedUser: z.string().max(200).optional().nullable(),
  supplier: z.string().max(200).optional().nullable(),
  serialNo: z.string().max(120).optional().nullable(),
  purchaseDate: dateString,
  // Defaults to purchaseDate; may not precede it.
  startDate: dateString.optional(),
  // Defaults from the category when omitted.
  usefulLifeMonths: z.coerce.number().int().positive().max(1200).optional(),
  quantity: z.coerce.number().int().positive().default(1),
  // May be negative for a contra line (credit note / trade discount).
  purchasePrice: z.coerce.number(),
  // Cut-over opening anchor (pre-cut-over assets only); needs openingAsOfDate.
  openingBookValue: z.coerce.number().optional().nullable(),
  openingAsOfDate: dateString.optional().nullable(),
  // TAX basis, parallel to the book basis above (WS5). All optional and all
  // defaulting to NULL — never to the book life. An asset with no tax life is
  // excluded from the deferred tax schedule by name; defaulting it to the book
  // life would instead report a temporary difference of exactly zero.
  taxUsefulLifeMonths: z.coerce
    .number()
    .int()
    .positive()
    .max(1200)
    .optional()
    .nullable(),
  openingTaxWdv: z.coerce.number().optional().nullable(),
  openingTaxAsOfDate: dateString.optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  linkGroup: z.string().max(60).optional().nullable(),
});

export const createFixedAssetSchema = fixedAssetBase
  .refine((d) => d.purchasePrice !== 0, {
    message:
      "Purchase price cannot be zero — an asset can't be capitalised at nil",
    path: ["purchasePrice"],
  })
  .refine((d) => d.openingBookValue == null || d.openingAsOfDate != null, {
    message: "openingAsOfDate is required when openingBookValue is set",
    path: ["openingAsOfDate"],
  })
  .refine((d) => !d.startDate || d.startDate >= d.purchaseDate, {
    message: "Start date cannot precede the purchase date",
    path: ["startDate"],
  });

// PATCH must keep the same invariants as create for whichever fields it
// carries — `.partial()` alone dropped every refinement, letting an update set
// a zero price or an opening anchor with no date and break the engine's
// preconditions. (Cross-field rules against the STORED row are re-checked in
// the service, which merges input over the persisted asset.)
export const updateFixedAssetSchema = fixedAssetBase
  .partial()
  .omit({ entityId: true })
  .superRefine((d, ctx) => {
    if (d.purchasePrice !== undefined && d.purchasePrice === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["purchasePrice"],
        message:
          "Purchase price cannot be zero — an asset can't be capitalised at nil",
      });
    }
    if (
      d.openingBookValue !== undefined &&
      d.openingBookValue !== null &&
      d.openingAsOfDate === null
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["openingAsOfDate"],
        message: "openingAsOfDate is required when openingBookValue is set",
      });
    }
    if (
      d.startDate !== undefined &&
      d.purchaseDate !== undefined &&
      d.startDate < d.purchaseDate
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["startDate"],
        message: "Start date cannot precede the purchase date",
      });
    }
  });

export const fixedAssetCategoryQuerySchema = z.object({
  entityId: z.string().optional(),
  includeInactive: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
});

/**
 * A depreciation run. `post` defaults to FALSE so the endpoint is a preview
 * unless the caller explicitly asks to post — the safe default for a call that
 * moves ChartOfAccount.balance.
 *
 * NOT `z.coerce.boolean()`: that is `Boolean(input)`, so the string "false"
 * — and "0", and "no" — all coerce to TRUE and silently post a journal entry
 * the caller explicitly declined. The entry then blocks its own re-post
 * (ConflictException on the existing period), so undoing it needs a manual
 * reversal. The union accepts a real JSON boolean (the POST body) and the
 * literal strings "true"/"false" (a form-encoded or query caller) and rejects
 * anything else outright rather than guessing toward the destructive branch.
 */
export const fixedAssetDepreciationRunSchema = z.object({
  entityId: z.string().min(1),
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
  post: z
    .union([z.boolean(), z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => v === true || v === "true"),
});
export type FixedAssetDepreciationRunInput = z.infer<
  typeof fixedAssetDepreciationRunSchema
>;

export const createFixedAssetCategorySchema = z.object({
  entityId: z.string().min(1),
  code: z.string().min(1).max(30),
  name: z.string().min(1).max(120),
  nameTh: z.string().max(120).optional().nullable(),
  assetClass: fixedAssetClassEnum,
  usefulLifeMonths: z.coerce.number().int().positive().max(1200),
  // Class-level TAX life (WS5). Null = no separate tax basis for the class;
  // assets in it are then excluded from the deferred tax schedule unless they
  // carry their own. Deliberately NOT defaulted to usefulLifeMonths.
  taxUsefulLifeMonths: z.coerce
    .number()
    .int()
    .positive()
    .max(1200)
    .optional()
    .nullable(),
  assetGlAccountId: z.string().optional().nullable(),
  depreciationGlAccountId: z.string().optional().nullable(),
  accumulatedDepreciationGlAccountId: z.string().optional().nullable(),
  disposalGainGlAccountId: z.string().optional().nullable(),
  disposalLossGlAccountId: z.string().optional().nullable(),
  isActive: z.boolean().default(true),
});

export const updateFixedAssetCategorySchema = createFixedAssetCategorySchema
  .partial()
  .omit({ entityId: true });

export type FixedAssetQuery = z.infer<typeof fixedAssetQuerySchema>;
export type CreateFixedAssetInput = z.infer<typeof createFixedAssetSchema>;
export type UpdateFixedAssetInput = z.infer<typeof updateFixedAssetSchema>;
export type FixedAssetCategoryQuery = z.infer<
  typeof fixedAssetCategoryQuerySchema
>;
export type CreateFixedAssetCategoryInput = z.infer<
  typeof createFixedAssetCategorySchema
>;
export type UpdateFixedAssetCategoryInput = z.infer<
  typeof updateFixedAssetCategorySchema
>;

// ─── Fixed Asset disposals / write-offs ───────────────────────────

export const FIXED_ASSET_DISPOSAL_TYPES = ["disposal", "write_off"] as const;
const fixedAssetDisposalTypeEnum = z.enum(FIXED_ASSET_DISPOSAL_TYPES);

export const submitFixedAssetDisposalSchema = z.object({
  disposalType: fixedAssetDisposalTypeEnum,
  disposalDate: dateString,
  unitsDisposed: z.coerce.number().int().positive().default(1),
  // Selling price excluding VAT; 0 for a write-off.
  proceeds: z.coerce.number().nonnegative().default(0),
  reason: z.string().max(2000).optional().nullable(),
  linkGroupId: z.string().max(60).optional().nullable(),
});

export const rejectFixedAssetDisposalSchema = z.object({
  reason: z.string().min(1, "A rejection reason is required").max(2000),
});

export const fixedAssetDisposalQuerySchema = z.object({
  entityId: z.string().optional(),
  status: z.enum(["pending", "approved", "rejected"]).optional(),
  assetId: z.string().optional(),
});

export type SubmitFixedAssetDisposalInput = z.infer<
  typeof submitFixedAssetDisposalSchema
>;
export type RejectFixedAssetDisposalInput = z.infer<
  typeof rejectFixedAssetDisposalSchema
>;
export type FixedAssetDisposalQuery = z.infer<
  typeof fixedAssetDisposalQuerySchema
>;

// ─── Fixed Asset revaluation / impairment (WS2) ───────────────────

export const FIXED_ASSET_REMEASUREMENT_KINDS = [
  "revaluation",
  "impairment",
  "impairment_reversal",
] as const;
const fixedAssetRemeasurementKindEnum = z.enum(FIXED_ASSET_REMEASUREMENT_KINDS);

/**
 * A remeasurement request.
 *
 * `carryingAfter` is the ONLY value the caller supplies — the revalued /
 * recoverable amount the asset is to be carried at. The carrying amount BEFORE
 * is never accepted from the client: it is computed by the depreciation engine
 * at `effectiveDate`, because a client-supplied "before" is exactly how a
 * write-down of the wrong size gets recognised against a plausible number.
 *
 * The direction rules (an impairment must go down, a reversal must go up) live
 * in the service, where the computed before-amount is available.
 */
export const submitFixedAssetRemeasurementSchema = z.object({
  kind: fixedAssetRemeasurementKindEnum,
  effectiveDate: dateString,
  carryingAfter: z.coerce.number().nonnegative(),
  reason: z.string().max(2000).optional().nullable(),
  evidenceUrl: z.string().max(500).optional().nullable(),
});

export const rejectFixedAssetRemeasurementSchema = z.object({
  reason: z.string().min(1, "A rejection reason is required").max(2000),
});

export const fixedAssetRemeasurementQuerySchema = z.object({
  entityId: z.string().optional(),
  status: z.enum(["pending", "approved", "rejected"]).optional(),
  assetId: z.string().optional(),
  kind: fixedAssetRemeasurementKindEnum.optional(),
});

export type SubmitFixedAssetRemeasurementInput = z.infer<
  typeof submitFixedAssetRemeasurementSchema
>;
export type RejectFixedAssetRemeasurementInput = z.infer<
  typeof rejectFixedAssetRemeasurementSchema
>;
export type FixedAssetRemeasurementQuery = z.infer<
  typeof fixedAssetRemeasurementQuerySchema
>;

// ─── Fixed Asset transfers (WS3) ──────────────────────────────────

export const FIXED_ASSET_TRANSFER_KINDS = [
  "location",
  "custodian",
  "entity",
] as const;
const fixedAssetTransferKindEnum = z.enum(FIXED_ASSET_TRANSFER_KINDS);

/**
 * A transfer request. All three kinds share this shape, but only one
 * destination field is meaningful per kind. That branching is NOT duplicated
 * here as a refinement: `planTransfer` (fixed-asset-transfer.ts) is the single
 * place that decides which destination a kind needs, and two copies of the rule
 * would drift the moment one of them is edited.
 */
export const submitFixedAssetTransferSchema = z.object({
  kind: fixedAssetTransferKindEnum,
  transferDate: dateString,
  toLocation: z.string().max(200).optional().nullable(),
  toCustodian: z.string().max(200).optional().nullable(),
  toEntityId: z.string().max(60).optional().nullable(),
  reason: z.string().max(2000).optional().nullable(),
});

export const rejectFixedAssetTransferSchema = z.object({
  reason: z.string().min(1, "A rejection reason is required").max(2000),
});

export const fixedAssetTransferQuerySchema = z.object({
  entityId: z.string().optional(),
  status: z.enum(["pending", "approved", "rejected"]).optional(),
  assetId: z.string().optional(),
  kind: fixedAssetTransferKindEnum.optional(),
});

export type SubmitFixedAssetTransferInput = z.infer<
  typeof submitFixedAssetTransferSchema
>;
export type RejectFixedAssetTransferInput = z.infer<
  typeof rejectFixedAssetTransferSchema
>;
export type FixedAssetTransferQuery = z.infer<
  typeof fixedAssetTransferQuerySchema
>;

// ─── Fixed Asset physical count (WS4) ─────────────────────────────

/**
 * A count session. `asOfDate` is the date the count is AS AT, and it is the
 * only date the variance is ever measured against — a year-end count is walked
 * over the following fortnight, so "today" is the wrong expectation.
 */
export const createFixedAssetCountSessionSchema = z.object({
  entityId: z.string().min(1, "Entity is required"),
  asOfDate: dateString,
  name: z.string().max(200).optional().nullable(),
  locationFilter: z.string().max(200).optional().nullable(),
});

/**
 * One scanned observation. Either `assetId` (picked from the register) or
 * `scannedTag` (typed/scanned) identifies the asset; the service resolves the
 * tag and refuses to guess when it is ambiguous. A tag that matches nothing is
 * recorded as a found-but-unregistered asset, never as a shortfall.
 *
 * `countedQuantity` is deliberately allowed to be 0: counting zero is a
 * positive assertion that nothing was there, which is NOT the same as never
 * reaching the asset (that is the absence of a line).
 */
export const submitFixedAssetCountLineSchema = z.object({
  assetId: z.string().max(60).optional().nullable(),
  scannedTag: z.string().max(120).optional().nullable(),
  countedQuantity: z.coerce.number().int().nonnegative(),
  note: z.string().max(2000).optional().nullable(),
});

export const fixedAssetCountSessionQuerySchema = z.object({
  entityId: z.string().optional(),
  status: z.enum(["open", "closed"]).optional(),
});

export type CreateFixedAssetCountSessionInput = z.infer<
  typeof createFixedAssetCountSessionSchema
>;
export type SubmitFixedAssetCountLineInput = z.infer<
  typeof submitFixedAssetCountLineSchema
>;
export type FixedAssetCountSessionQuery = z.infer<
  typeof fixedAssetCountSessionQuerySchema
>;

// ─── Fixed Asset reports ──────────────────────────────────────────

export const fixedAssetReportQuerySchema = z.object({
  entityId: z.string().min(1, "Entity is required"),
  // "As at" cut-off for the register snapshot; defaults to today.
  asOf: dateString.optional(),
});

export const fixedAssetScheduleQuerySchema = z.object({
  entityId: z.string().min(1, "Entity is required"),
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
});

export const fixedAssetPeriodReportQuerySchema = z
  .object({
    entityId: z.string().min(1, "Entity is required"),
    from: dateString,
    to: dateString,
  })
  .refine((d) => d.to >= d.from, {
    message: "End date must not be before start date",
    path: ["to"],
  });

export type FixedAssetReportQuery = z.infer<typeof fixedAssetReportQuerySchema>;
export type FixedAssetScheduleQuery = z.infer<
  typeof fixedAssetScheduleQuerySchema
>;
export type FixedAssetPeriodReportQuery = z.infer<
  typeof fixedAssetPeriodReportQuerySchema
>;

// ─── Entity corporate income tax rates (WS5) ──────────────────────
//
// Effective-dated because a temporary difference is measured at the rate
// expected when it REVERSES (IAS 12.47), and because BOI promotions start and
// end on fixed dates. Periods must not overlap (enforced in the service against
// the stored rows) so exactly one rate is in force on any date.

export const entityTaxRateQuerySchema = z.object({
  entityId: z.string().min(1, "Entity is required"),
});

const entityTaxRateBase = z.object({
  entityId: z.string().min(1, "Entity is required"),
  effectiveFrom: dateString,
  // Null / omitted = open-ended.
  effectiveTo: dateString.optional().nullable(),
  // Percent, e.g. 20 for 20%. 0 is legitimate (a BOI-promoted entity) and must
  // never be confused with "no rate configured", which is a null ROW.
  ratePercent: z.coerce.number().min(0).max(100),
  label: z.string().max(120).optional().nullable(),
});

export const createEntityTaxRateSchema = entityTaxRateBase.refine(
  (d) => !d.effectiveTo || d.effectiveTo >= d.effectiveFrom,
  {
    message: "End date must not be before start date",
    path: ["effectiveTo"],
  },
);

// `.partial()` drops the refinement, so the same rule is re-stated here for the
// pair when BOTH arrive; the merged-against-stored-row check lives in the
// service (a PATCH that moves only one end still has to be validated).
export const updateEntityTaxRateSchema = entityTaxRateBase
  .partial()
  .omit({ entityId: true })
  .superRefine((d, ctx) => {
    if (
      d.effectiveFrom !== undefined &&
      d.effectiveTo !== undefined &&
      d.effectiveTo !== null &&
      d.effectiveTo < d.effectiveFrom
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["effectiveTo"],
        message: "End date must not be before start date",
      });
    }
  });

export type EntityTaxRateQuery = z.infer<typeof entityTaxRateQuerySchema>;
export type CreateEntityTaxRateInput = z.infer<
  typeof createEntityTaxRateSchema
>;
export type UpdateEntityTaxRateInput = z.infer<
  typeof updateEntityTaxRateSchema
>;

// ─── Fixed Asset import (19-column layout, parsed client-side) ─────

export const fixedAssetImportRowSchema = z.object({
  rowNumber: z.coerce.number().int(),
  assetCode: z.string().max(60).optional().nullable(),
  name: z.string().max(200).optional().nullable(),
  nameTh: z.string().max(200).optional().nullable(),
  quantity: z.coerce.number().optional().nullable(),
  categoryCode: z.string().max(60).optional().nullable(),
  location: z.string().max(200).optional().nullable(),
  assignedUser: z.string().max(200).optional().nullable(),
  supplier: z.string().max(200).optional().nullable(),
  serialNo: z.string().max(120).optional().nullable(),
  purchaseDate: z.string().max(20).optional().nullable(),
  startDate: z.string().max(20).optional().nullable(),
  usefulLifeMonths: z.coerce.number().optional().nullable(),
  purchasePrice: z.coerce.number().optional().nullable(),
  bookValue: z.coerce.number().optional().nullable(),
  status: z.string().max(40).optional().nullable(),
  disposalDate: z.string().max(20).optional().nullable(),
  sellingPrice: z.coerce.number().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  linkGroup: z.string().max(60).optional().nullable(),
});

export const importFixedAssetsSchema = z.object({
  entityId: z.string().min(1, "Entity is required"),
  // The "as at" date of the uploaded file — the date its Book Value column was
  // computed at. Book Value is anchored at this date so an export taken on any
  // date re-imports exactly. Omitted → the statutory cut-over (31-12-2025).
  asOf: dateString.optional(),
  rows: z.array(fixedAssetImportRowSchema).min(1).max(2000),
});

export type FixedAssetImportRowInput = z.infer<
  typeof fixedAssetImportRowSchema
>;
export type ImportFixedAssetsInput = z.infer<typeof importFixedAssetsSchema>;
