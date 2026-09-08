import { describe, expect, it } from "vitest";

import { DEFAULT_INVOICE_COMPANY } from "@/modules/accounting/invoice-shared";
import {
  buildStatement,
  buildStatementPdfBuffer,
  type StatementInvoiceInput,
} from "@/modules/accounting/statement";

const asOf = new Date("2026-08-04T00:00:00.000Z");
const day = (n: number) => new Date(asOf.getTime() - n * 86_400_000);

const invoices: StatementInvoiceInput[] = [
  // Fully paid — outstanding 0, not in aging.
  {
    invoiceNo: "INV-1",
    issueDate: day(60),
    dueDate: day(30),
    amount: 100,
    amountPaid: 100,
  },
  // Partly paid, 45 days overdue → d31_60 bucket.
  {
    invoiceNo: "INV-2",
    issueDate: day(70),
    dueDate: day(45),
    amount: 200,
    amountPaid: 50,
  },
  // Not yet due (due in future).
  {
    invoiceNo: "INV-3",
    issueDate: day(5),
    dueDate: day(-10),
    amount: 300,
    amountPaid: 0,
  },
];

describe("buildStatement", () => {
  it("computes per-row outstanding + totals", () => {
    const s = buildStatement(invoices, asOf);
    expect(s.rows.map((r) => r.outstanding)).toEqual([0, 150, 300]);
    expect(s.totalAmount).toBe(600);
    expect(s.totalPaid).toBe(150);
    expect(s.totalOutstanding).toBe(450);
  });

  it("ages only the open balance, bucketed by due date", () => {
    const s = buildStatement(invoices, asOf);
    // INV-1 fully paid → excluded. INV-2 (45d) → d31_60. INV-3 (future) → notYetDue.
    expect(s.aging.buckets.d31_60).toBe(150);
    expect(s.aging.buckets.notYetDue).toBe(300);
    expect(s.aging.total).toBe(450);
    expect(s.aging.total).toBe(s.totalOutstanding);
  });

  it("handles an empty statement", () => {
    const s = buildStatement([], asOf);
    expect(s.totalOutstanding).toBe(0);
    expect(s.rows).toEqual([]);
  });
});

describe("buildStatementPdfBuffer", () => {
  it("produces a non-empty PDF buffer (sanitising non-Latin names)", async () => {
    const buf = await buildStatementPdfBuffer({
      company: DEFAULT_INVOICE_COMPANY,
      entityName: "Manut Thailand",
      counterparty: "ลูกค้า ABC Co.", // Thai chars must not crash Helvetica
      side: "receivable",
      currency: "THB",
      asOf,
      statement: buildStatement(invoices, asOf),
    });
    expect(buf.length).toBeGreaterThan(0);
    expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});
