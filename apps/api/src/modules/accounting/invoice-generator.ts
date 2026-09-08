/**
 * Invoice PDF generator (pdf-lib). Renders one A4 page faithful to the Manut
 * invoice template: company letterhead, BILL TO + meta, a line-item table,
 * Subtotal / VAT / WHT / TOTAL DUE, and the bank payment block. Mirrors the
 * payslip-generator.ts pdf-lib idioms (Helvetica, rgb, Buffer return).
 *
 * Public API: buildInvoicePdfBuffer(doc, company, totals) → Buffer
 */
import { PDFDocument, type PDFFont, rgb, StandardFonts } from "pdf-lib";

import {
  formatInvoiceDate,
  formatMoney,
  type InvoiceCompany,
  type InvoiceDoc,
  type InvoiceTotals,
} from "@/modules/accounting/invoice-shared";

const PAGE_W = 595.28; // A4 portrait
const PAGE_H = 841.89;
const MARGIN = 50;
const RIGHT = PAGE_W - MARGIN;
const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.42, 0.42, 0.46);
const RULE = rgb(0.8, 0.8, 0.83);
const SHADE = rgb(0.95, 0.95, 0.96);

// Line-item column right edges / left starts. Spaced so the right-aligned
// column headers ("Unit Price (USD)") don't crowd the Qty column.
const COL_DESC_X = MARGIN;
const COL_QTY_R = 330;
const COL_UNIT_R = 445;
const COL_AMT_R = RIGHT;

export async function buildInvoicePdfBuffer(
  doc: InvoiceDoc,
  company: InvoiceCompany,
  totals: InvoiceTotals,
): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([PAGE_W, PAGE_H]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const text = (
    s: string,
    x: number,
    y: number,
    size = 9,
    f: PDFFont = font,
    color = INK,
  ) => page.drawText(s, { x, y, size, font: f, color });

  const rightText = (
    s: string,
    xRight: number,
    y: number,
    size = 9,
    f: PDFFont = font,
    color = INK,
  ) => text(s, xRight - f.widthOfTextAtSize(s, size), y, size, f, color);

  const rule = (y: number, x1 = MARGIN, x2 = RIGHT, color = RULE) =>
    page.drawLine({
      start: { x: x1, y },
      end: { x: x2, y },
      thickness: 0.75,
      color,
    });

  // Greedy word-wrap to a pixel width; returns the lines.
  const wrap = (s: string, width: number, size: number, f: PDFFont) => {
    const out: string[] = [];
    for (const paragraph of s.split("\n")) {
      let line = "";
      for (const word of paragraph.split(/\s+/).filter(Boolean)) {
        const trial = line ? `${line} ${word}` : word;
        if (f.widthOfTextAtSize(trial, size) > width && line) {
          out.push(line);
          line = word;
        } else {
          line = trial;
        }
      }
      out.push(line);
    }
    return out;
  };

  let y = PAGE_H - MARGIN;

  // ── Company letterhead ─────────────────────────────────────────────────
  text(company.name, MARGIN, y, 13, bold);
  // INVOICE title (top-right)
  rightText("INVOICE", RIGHT, y, 22, bold);
  y -= 15;
  for (const line of company.addressLines) {
    text(line, MARGIN, y, 8, font, MUTED);
    y -= 11;
  }
  if (company.taxId) {
    text(`Tax ID: ${company.taxId}`, MARGIN, y, 8, font, MUTED);
    y -= 11;
  }
  const contact = [
    company.email ? `Email: ${company.email}` : "",
    company.tel ? `Tel: ${company.tel}` : "",
  ]
    .filter(Boolean)
    .join("  |  ");
  if (contact) {
    text(contact, MARGIN, y, 8, font, MUTED);
    y -= 11;
  }
  rightText(
    `No. ${doc.invoiceNo}`,
    RIGHT,
    PAGE_H - MARGIN - 26,
    10,
    font,
    MUTED,
  );

  y -= 8;
  rule(y);
  y -= 18;

  // ── BILL TO (left) + meta (right) ──────────────────────────────────────
  const blockTop = y;
  text("BILL TO", MARGIN, y, 8, bold, MUTED);
  y -= 13;
  text(doc.counterparty, MARGIN, y, 10, bold);
  y -= 13;
  for (const line of wrap(doc.billToAddress, 250, 9, font)) {
    if (!line) continue;
    text(line, MARGIN, y, 9, font, MUTED);
    y -= 11;
  }

  // meta column on the right
  const metaX = 330;
  const metaValX = RIGHT;
  let my = blockTop;
  const meta: Array<[string, string]> = [
    ["Issue Date:", formatInvoiceDate(doc.issueDate)],
    ["Due Date:", formatInvoiceDate(doc.dueDate)],
    ...(doc.paymentTerms
      ? ([["Payment Terms:", doc.paymentTerms]] as Array<[string, string]>)
      : []),
    ["Currency:", doc.currency],
    ...(doc.reference
      ? ([["Reference:", doc.reference]] as Array<[string, string]>)
      : []),
  ];
  for (const [label, value] of meta) {
    text(label, metaX, my, 9, font, MUTED);
    rightText(value, metaValX, my, 9, bold);
    my -= 13;
  }

  y = Math.min(y, my) - 12;

  // ── Line-item table ────────────────────────────────────────────────────
  const rowH = 16;
  page.drawRectangle({
    x: MARGIN,
    y: y - rowH + 4,
    width: RIGHT - MARGIN,
    height: rowH,
    color: SHADE,
  });
  const cur = doc.currency;
  text("Description", COL_DESC_X + 4, y, 8, bold);
  rightText("Qty", COL_QTY_R, y, 8, bold);
  rightText(`Unit Price (${cur})`, COL_UNIT_R, y, 8, bold);
  rightText(`Amount (${cur})`, COL_AMT_R, y, 8, bold);
  y -= rowH + 2;

  for (const li of doc.lineItems) {
    const descLines = wrap(
      li.description,
      COL_QTY_R - COL_DESC_X - 35,
      9,
      font,
    );
    const firstY = y;
    descLines.forEach((line, i) => {
      text(line, COL_DESC_X + 4, y, 9, font);
      if (i < descLines.length - 1) y -= 11;
    });
    rightText(formatMoney(li.quantity), COL_QTY_R, firstY, 9);
    rightText(formatMoney(li.unitPrice), COL_UNIT_R, firstY, 9);
    rightText(formatMoney(li.amount), COL_AMT_R, firstY, 9);
    y -= 15;
    rule(y + 6, MARGIN, RIGHT, rgb(0.9, 0.9, 0.92));
  }

  y -= 4;

  // ── Notes (optional) + totals side by side ─────────────────────────────
  const totalsTop = y;
  let noteEndY = y;
  if (doc.notes) {
    text("Note", MARGIN, y, 8, bold, MUTED);
    let ny = y - 12;
    // Wrap within the left half so notes never run under the totals column.
    for (const line of wrap(doc.notes, 330, 8, font)) {
      text(line, MARGIN, ny, 8, font, MUTED);
      ny -= 10;
    }
    noteEndY = ny;
  }

  // totals stack (right)
  const labelX = 400;
  let ty = totalsTop;
  const totalsRows: Array<[string, string, boolean]> = [
    ["Subtotal", formatMoney(totals.subtotal), false],
    [`VAT (${doc.vatRate}%)`, formatMoney(totals.vatAmount), false],
    // Optional custom tax (e.g. GST) — only when a label or rate is set.
    ...(doc.taxLabel || doc.taxRate
      ? ([
          [
            `${doc.taxLabel || "Tax"} (${doc.taxRate}%)`,
            formatMoney(totals.taxAmount),
            false,
          ],
        ] as Array<[string, string, boolean]>)
      : []),
    [
      `WHT (${doc.whtRate}%)`,
      totals.whtAmount ? `(${formatMoney(totals.whtAmount)})` : formatMoney(0),
      false,
    ],
  ];
  for (const [label, value, strong] of totalsRows) {
    text(label, labelX, ty, 9, strong ? bold : font, MUTED);
    rightText(value, COL_AMT_R, ty, 9, font);
    ty -= 14;
  }
  rule(ty + 6, labelX, RIGHT);
  ty -= 4;
  // Currency in the label so the grand-total number right-aligns to the same
  // column as every other amount (previously " USD" pushed it out of column).
  text(`TOTAL DUE (${cur})`, labelX, ty, 10, bold);
  rightText(formatMoney(totals.total), COL_AMT_R, ty, 10, bold);

  // Start the next block below BOTH the totals stack and the (possibly long)
  // note column so they can't overlap.
  y = Math.min(ty, noteEndY) - 30;

  // ── Payment details (bank block) ───────────────────────────────────────
  if (company.bankName || company.bankAccountNo) {
    rule(y + 14);
    text("Payment Details", MARGIN, y, 9, bold);
    y -= 13;
    const bank: Array<[string, string]> = [
      ["Bank:", company.bankName],
      ["Account Type:", company.bankAccountType],
      ["Branch:", company.bankBranch],
      ["Account Name:", company.bankAccountName],
      ["Account No.:", company.bankAccountNo],
      ["SWIFT:", company.bankSwift],
    ];
    for (const [label, value] of bank) {
      if (!value) continue;
      text(label, MARGIN, y, 8, font, MUTED);
      text(value, MARGIN + 90, y, 8, font);
      y -= 11;
    }
  }

  if (company.footerNote) {
    y -= 6;
    for (const line of wrap(company.footerNote, RIGHT - MARGIN, 7.5, font)) {
      text(line, MARGIN, y, 7.5, font, MUTED);
      y -= 10;
    }
  }

  const bytes = await pdf.save();
  return Buffer.from(bytes);
}
