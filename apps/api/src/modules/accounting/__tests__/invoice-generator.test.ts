import { describe, expect, it } from "vitest";

import { buildInvoiceDocxBuffer } from "@/modules/accounting/invoice-docx-generator";
import { buildInvoicePdfBuffer } from "@/modules/accounting/invoice-generator";
import {
  computeInvoiceTotals,
  DEFAULT_INVOICE_COMPANY,
  type InvoiceDoc,
  toInvoiceDoc,
} from "@/modules/accounting/invoice-shared";
import { buildInvoiceXlsxBuffer } from "@/modules/accounting/invoice-xlsx-generator";

const sampleDoc: InvoiceDoc = {
  invoiceNo: "INV-2026-0700482",
  type: "receivable",
  counterparty: "Grameenphone, Bangladesh",
  billToAddress: "Bashundhara, Baridhara, Dhaka 1229,\nBangladesh",
  reference: "2026-0117",
  paymentTerms: "Net 45 days",
  currency: "USD",
  vatRate: 0,
  taxLabel: "",
  taxRate: 0,
  whtRate: 15,
  issueDate: new Date("2026-07-05T00:00:00.000Z"),
  dueDate: new Date("2026-08-19T00:00:00.000Z"),
  status: "sent",
  notes: "Service Period: 1 June 2026 – 30 June 2026",
  entityName: "Manut (Thailand) Co., Ltd.",
  amount: 17000,
  lineItems: [
    {
      description:
        "Revenue share for digital subscription services — June 2026",
      quantity: 1,
      unitPrice: 20000,
      amount: 20000,
    },
  ],
};

describe("computeInvoiceTotals", () => {
  it("matches the template: 20,000 subtotal, 0% VAT, 15% WHT → 17,000 due", () => {
    const t = computeInvoiceTotals([{ quantity: 1, unitPrice: 20000 }], 0, 15);
    expect(t.subtotal).toBe(20000);
    expect(t.vatAmount).toBe(0);
    expect(t.whtAmount).toBe(3000);
    expect(t.total).toBe(17000);
  });

  it("adds a custom tax (e.g. GST) alongside VAT, before withholding WHT", () => {
    // subtotal 1000; VAT 7% = 70; GST 10% = 100; WHT 3% = 30 → 1000+70+100-30
    const t = computeInvoiceTotals(
      [{ quantity: 1, unitPrice: 1000 }],
      7,
      3,
      10,
    );
    expect(t.subtotal).toBe(1000);
    expect(t.vatAmount).toBe(70);
    expect(t.taxAmount).toBe(100);
    expect(t.whtAmount).toBe(30);
    expect(t.total).toBe(1140);
  });

  it("adds VAT and withholds WHT off the subtotal, rounded to 2dp", () => {
    const t = computeInvoiceTotals(
      [
        { quantity: 3, unitPrice: 33.33 },
        { quantity: 1, unitPrice: 0.01 },
      ],
      7,
      3,
    );
    // subtotal = 99.99 + 0.01 = 100.00
    expect(t.subtotal).toBe(100);
    expect(t.vatAmount).toBe(7);
    expect(t.whtAmount).toBe(3);
    expect(t.total).toBe(104);
  });
});

describe("toInvoiceDoc — legacy invoice with no line items", () => {
  it("synthesizes one line from the stored amount so the total isn't 0", () => {
    const doc = toInvoiceDoc({
      invoiceNo: "123",
      type: "receivable",
      counterparty: "321",
      billToAddress: null,
      reference: null,
      paymentTerms: null,
      currency: "USD",
      amount: 100,
      vatRate: 0,
      taxLabel: null,
      taxRate: 0,
      whtRate: 0,
      issueDate: new Date("2026-07-23T00:00:00.000Z"),
      dueDate: new Date("2026-07-23T00:00:00.000Z"),
      status: "draft",
      notes: null,
      entity: { name: "Acme" },
      lineItems: [],
    });
    expect(doc.lineItems).toHaveLength(1);
    expect(doc.lineItems[0].amount).toBe(100);
    // TOTAL DUE computed off the synthesized line equals the stored amount.
    const totals = computeInvoiceTotals(
      doc.lineItems.map((li) => ({
        quantity: li.quantity,
        unitPrice: li.unitPrice,
      })),
      doc.vatRate,
      doc.whtRate,
    );
    expect(totals.subtotal).toBe(100);
    expect(totals.total).toBe(100);
  });
});

describe("invoice document generators", () => {
  const totals = computeInvoiceTotals(
    sampleDoc.lineItems.map((li) => ({
      quantity: li.quantity,
      unitPrice: li.unitPrice,
    })),
    sampleDoc.vatRate,
    sampleDoc.whtRate,
  );

  it("renders a non-empty PDF (%PDF- header)", async () => {
    const buf = await buildInvoicePdfBuffer(
      sampleDoc,
      DEFAULT_INVOICE_COMPANY,
      totals,
    );
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("renders a non-empty DOCX (PK zip header)", async () => {
    const buf = await buildInvoiceDocxBuffer(
      sampleDoc,
      DEFAULT_INVOICE_COMPANY,
      totals,
    );
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.subarray(0, 2).toString("latin1")).toBe("PK");
  });

  it("renders a non-empty XLSX (PK zip header)", () => {
    const buf = buildInvoiceXlsxBuffer(
      sampleDoc,
      DEFAULT_INVOICE_COMPANY,
      totals,
    );
    expect(buf.length).toBeGreaterThan(500);
    expect(buf.subarray(0, 2).toString("latin1")).toBe("PK");
  });
});
