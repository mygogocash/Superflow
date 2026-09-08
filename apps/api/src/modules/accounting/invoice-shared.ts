// Shared invoice-document helpers used by the accounting service AND both
// generators (PDF + DOCX) + the web print view (via the API payload), so the
// company block, totals math, and number formatting stay identical across
// every rendering path.

import { DEFAULT_ORG_NAME } from "@/common/constants/org";

/** Admin-editable company + bank block that heads every generated invoice. */
export interface InvoiceCompany {
  name: string;
  addressLines: string[];
  taxId: string;
  email: string;
  tel: string;
  bankName: string;
  bankAccountType: string;
  bankBranch: string;
  bankAccountName: string;
  bankAccountNo: string;
  bankSwift: string;
  footerNote: string;
}

// The company block is modular: the name defaults to the organization name from
// admin setup (Settings → System `app.name`), and the legal / bank / tax
// identity is intentionally left blank so it MUST be entered in Accounting →
// Invoices → company settings. Shipping a hardcoded legal entity would print
// the wrong company (and wrong bank account) on a rebranded org, so the only
// non-identity default kept here is the generic payment-terms footer note.
export function buildDefaultInvoiceCompany(orgName: string): InvoiceCompany {
  return {
    name: orgName,
    addressLines: [],
    taxId: "",
    email: "",
    tel: "",
    bankName: "",
    bankAccountType: "",
    bankBranch: "",
    bankAccountName: "",
    bankAccountNo: "",
    bankSwift: "",
    footerNote:
      "Please reference the invoice number in your payment. Late payments are " +
      "subject to a 1.5% monthly interest charge. Thank you for your business.",
  };
}

/**
 * Static fallback for callers that cannot resolve the org name from the
 * database (unit tests, generator smoke paths). The live service overlays the
 * admin-configured block on top of a name resolved from `app.name`.
 */
export const DEFAULT_INVOICE_COMPANY: InvoiceCompany =
  buildDefaultInvoiceCompany(DEFAULT_ORG_NAME);

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export interface InvoiceTotals {
  subtotal: number;
  vatAmount: number;
  taxAmount: number;
  whtAmount: number;
  total: number;
}

/**
 * Money math for an invoice. Subtotal = Σ(qty × unitPrice). VAT and the custom
 * named tax (e.g. GST) ADD to the total; WHT is withheld (subtracted); total is
 * the amount due. `taxRate` is an optional extra tax — it defaults to 0 so
 * existing 3-arg callers are unaffected. Every value is rounded to 2 decimals
 * so the persisted `amount` matches what the documents print.
 */
export function computeInvoiceTotals(
  lineItems: Array<{ quantity: number; unitPrice: number }>,
  vatRate: number,
  whtRate: number,
  taxRate = 0,
): InvoiceTotals {
  const subtotal = round2(
    lineItems.reduce((s, li) => s + li.quantity * li.unitPrice, 0),
  );
  const vatAmount = round2(subtotal * (vatRate / 100));
  const taxAmount = round2(subtotal * (taxRate / 100));
  const whtAmount = round2(subtotal * (whtRate / 100));
  const total = round2(subtotal + vatAmount + taxAmount - whtAmount);
  return { subtotal, vatAmount, taxAmount, whtAmount, total };
}

/** Thousands-separated 2dp money string, e.g. 20000 → "20,000.00". */
export function formatMoney(n: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Long date, e.g. "July 5, 2026" — matches the invoice template. */
export function formatInvoiceDate(d: Date): string {
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

// ─── Normalized document shape ──────────────────────────────────────────
// Prisma ships Decimals + nullable columns; the generators want plain numbers
// and empty strings. `toInvoiceDoc` is the single coercion point so PDF, DOCX
// and the API payload all agree.

export interface InvoiceLineDoc {
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

export interface InvoiceDoc {
  invoiceNo: string;
  type: string;
  counterparty: string;
  billToAddress: string;
  reference: string;
  paymentTerms: string;
  currency: string;
  vatRate: number;
  // Optional extra named tax (e.g. "GST") shown below VAT. Empty label +
  // 0 rate means "no custom tax".
  taxLabel: string;
  taxRate: number;
  whtRate: number;
  issueDate: Date;
  dueDate: Date;
  status: string;
  notes: string;
  entityName: string;
  // Stored grand total — source of truth, used as a fallback when a
  // legacy/summary invoice carries no line items.
  amount: number;
  lineItems: InvoiceLineDoc[];
}

/** Prisma invoice (with `lineItems` + `entity`) as the generators receive it. */
export interface RawInvoice {
  invoiceNo: string;
  type: string;
  counterparty: string;
  billToAddress: string | null;
  reference: string | null;
  paymentTerms: string | null;
  currency: string;
  amount: unknown;
  vatRate: unknown;
  taxLabel: string | null;
  taxRate: unknown;
  whtRate: unknown;
  issueDate: Date;
  dueDate: Date;
  status: string;
  notes: string | null;
  entity?: { name: string } | null;
  lineItems: Array<{
    description: string;
    quantity: unknown;
    unitPrice: unknown;
  }>;
}

export function toInvoiceDoc(inv: RawInvoice): InvoiceDoc {
  const amount = Number(inv.amount);
  const mapped = inv.lineItems.map((li) => {
    const quantity = Number(li.quantity);
    const unitPrice = Number(li.unitPrice);
    return {
      description: li.description,
      quantity,
      unitPrice,
      amount: round2(quantity * unitPrice),
    };
  });
  // Legacy/summary invoices predate the line-item model: they store a grand
  // total but no lines. Synthesize a single line from the stored amount so the
  // document isn't blank and TOTAL DUE isn't 0. (Such rows default to 0%
  // VAT/WHT, so subtotal = total = amount.)
  const lineItems: InvoiceLineDoc[] =
    mapped.length > 0
      ? mapped
      : [
          {
            description: inv.notes?.trim() || "—",
            quantity: 1,
            unitPrice: amount,
            amount,
          },
        ];
  return {
    invoiceNo: inv.invoiceNo,
    type: inv.type,
    counterparty: inv.counterparty,
    billToAddress: inv.billToAddress ?? "",
    reference: inv.reference ?? "",
    paymentTerms: inv.paymentTerms ?? "",
    currency: inv.currency,
    vatRate: Number(inv.vatRate),
    taxLabel: inv.taxLabel ?? "",
    taxRate: Number(inv.taxRate),
    whtRate: Number(inv.whtRate),
    issueDate: inv.issueDate,
    dueDate: inv.dueDate,
    status: inv.status,
    notes: inv.notes ?? "",
    entityName: inv.entity?.name ?? "",
    amount,
    lineItems,
  };
}
