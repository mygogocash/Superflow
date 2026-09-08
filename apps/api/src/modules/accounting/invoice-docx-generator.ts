/**
 * Invoice Word (.docx) generator (docx lib). Builds the document
 * programmatically to reproduce the Manut invoice template layout — company
 * letterhead, BILL TO + meta, line-item table, Subtotal / VAT / WHT /
 * TOTAL DUE, and the bank block. (Faithful reproduction rather than a
 * byte-for-byte fill of the source .docx; a docxtemplater-based exact-file
 * fill is a possible follow-up if pixel-identical formatting is required.)
 *
 * Public API: buildInvoiceDocxBuffer(doc, company, totals) → Buffer
 */
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";

import {
  formatInvoiceDate,
  formatMoney,
  type InvoiceCompany,
  type InvoiceDoc,
  type InvoiceTotals,
} from "@/modules/accounting/invoice-shared";

const MUTED = "6B6B72";

function line(
  text: string,
  opts: { bold?: boolean; size?: number; color?: string } = {},
) {
  return new Paragraph({
    children: [
      new TextRun({
        text,
        bold: opts.bold,
        size: (opts.size ?? 9) * 2, // docx sizes are half-points
        color: opts.color,
      }),
    ],
    spacing: { after: 20 },
  });
}

function cell(
  text: string,
  opts: {
    bold?: boolean;
    align?: (typeof AlignmentType)[keyof typeof AlignmentType];
    width?: number;
  } = {},
) {
  return new TableCell({
    width: opts.width
      ? { size: opts.width, type: WidthType.PERCENTAGE }
      : undefined,
    children: [
      new Paragraph({
        alignment: opts.align,
        children: [new TextRun({ text, bold: opts.bold, size: 18 })],
      }),
    ],
  });
}

export async function buildInvoiceDocxBuffer(
  doc: InvoiceDoc,
  company: InvoiceCompany,
  totals: InvoiceTotals,
): Promise<Buffer> {
  const cur = doc.currency;
  const children: (Paragraph | Table)[] = [];

  // ── Letterhead ─────────────────────────────────────────────────────────
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text: company.name, bold: true, size: 26 })],
    }),
  );
  for (const l of company.addressLines) {
    children.push(line(l, { size: 8, color: MUTED }));
  }
  if (company.taxId) {
    children.push(line(`Tax ID: ${company.taxId}`, { size: 8, color: MUTED }));
  }
  const contact = [
    company.email ? `Email: ${company.email}` : "",
    company.tel ? `Tel: ${company.tel}` : "",
  ]
    .filter(Boolean)
    .join("  |  ");
  if (contact) children.push(line(contact, { size: 8, color: MUTED }));

  children.push(
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      spacing: { before: 120, after: 20 },
      children: [new TextRun({ text: "INVOICE", bold: true, size: 40 })],
    }),
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      children: [
        new TextRun({ text: `No. ${doc.invoiceNo}`, size: 20, color: MUTED }),
      ],
    }),
  );

  // ── BILL TO + meta ───────────────────────────────────────────────────────
  children.push(line("BILL TO", { bold: true, size: 8, color: MUTED }));
  children.push(line(doc.counterparty, { bold: true, size: 10 }));
  for (const l of doc.billToAddress.split("\n").filter(Boolean)) {
    children.push(line(l, { size: 9, color: MUTED }));
  }
  const meta: Array<[string, string]> = [
    ["Issue Date", formatInvoiceDate(doc.issueDate)],
    ["Due Date", formatInvoiceDate(doc.dueDate)],
    ...(doc.paymentTerms
      ? ([["Payment Terms", doc.paymentTerms]] as [string, string][])
      : []),
    ["Currency", cur],
    ...(doc.reference
      ? ([["Reference", doc.reference]] as [string, string][])
      : []),
  ];
  for (const [k, v] of meta) children.push(line(`${k}: ${v}`, { size: 9 }));

  // ── Line-item table ──────────────────────────────────────────────────────
  const rows: TableRow[] = [
    new TableRow({
      tableHeader: true,
      children: [
        cell("Description", { bold: true, width: 55 }),
        cell("Qty", { bold: true, align: AlignmentType.RIGHT, width: 10 }),
        cell(`Unit Price (${cur})`, {
          bold: true,
          align: AlignmentType.RIGHT,
          width: 17,
        }),
        cell(`Amount (${cur})`, {
          bold: true,
          align: AlignmentType.RIGHT,
          width: 18,
        }),
      ],
    }),
  ];
  for (const li of doc.lineItems) {
    rows.push(
      new TableRow({
        children: [
          cell(li.description, { width: 55 }),
          cell(formatMoney(li.quantity), {
            align: AlignmentType.RIGHT,
            width: 10,
          }),
          cell(formatMoney(li.unitPrice), {
            align: AlignmentType.RIGHT,
            width: 17,
          }),
          cell(formatMoney(li.amount), {
            align: AlignmentType.RIGHT,
            width: 18,
          }),
        ],
      }),
    );
  }
  children.push(
    new Paragraph({ spacing: { before: 160 }, children: [] }),
    new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows }),
  );

  // ── Notes ─────────────────────────────────────────────────────────────────
  if (doc.notes) {
    children.push(
      new Paragraph({
        spacing: { before: 120 },
        children: [
          new TextRun({ text: "Note", bold: true, size: 16, color: MUTED }),
        ],
      }),
    );
    for (const l of doc.notes.split("\n").filter(Boolean)) {
      children.push(line(l, { size: 8, color: MUTED }));
    }
  }

  // ── Totals (right-aligned) ────────────────────────────────────────────────
  const totalRow = (label: string, value: string, strong = false) =>
    new Paragraph({
      alignment: AlignmentType.RIGHT,
      spacing: { before: strong ? 60 : 10 },
      children: [
        new TextRun({
          text: `${label}    `,
          bold: strong,
          size: strong ? 22 : 18,
          color: strong ? undefined : MUTED,
        }),
        new TextRun({ text: value, bold: strong, size: strong ? 22 : 18 }),
      ],
    });
  children.push(
    totalRow("Subtotal", formatMoney(totals.subtotal)),
    totalRow(`VAT (${doc.vatRate}%)`, formatMoney(totals.vatAmount)),
  );
  // Optional custom tax (e.g. GST) — only when a label or rate is set.
  if (doc.taxLabel || doc.taxRate) {
    children.push(
      totalRow(
        `${doc.taxLabel || "Tax"} (${doc.taxRate}%)`,
        formatMoney(totals.taxAmount),
      ),
    );
  }
  children.push(
    totalRow(
      `WHT (${doc.whtRate}%)`,
      totals.whtAmount ? `(${formatMoney(totals.whtAmount)})` : formatMoney(0),
    ),
    totalRow("TOTAL DUE", `${formatMoney(totals.total)} ${cur}`, true),
  );

  // ── Payment details ───────────────────────────────────────────────────────
  if (company.bankName || company.bankAccountNo) {
    children.push(
      new Paragraph({
        spacing: { before: 200 },
        children: [
          new TextRun({ text: "Payment Details", bold: true, size: 18 }),
        ],
      }),
    );
    const bank: Array<[string, string]> = [
      ["Bank", company.bankName],
      ["Account Type", company.bankAccountType],
      ["Branch", company.bankBranch],
      ["Account Name", company.bankAccountName],
      ["Account No.", company.bankAccountNo],
      ["SWIFT", company.bankSwift],
    ];
    for (const [k, v] of bank) {
      if (v) children.push(line(`${k}: ${v}`, { size: 8 }));
    }
  }
  if (company.footerNote) {
    children.push(
      new Paragraph({
        spacing: { before: 120 },
        children: [
          new TextRun({ text: company.footerNote, size: 15, color: MUTED }),
        ],
      }),
    );
  }

  const document = new Document({ sections: [{ children }] });
  return Packer.toBuffer(document);
}
