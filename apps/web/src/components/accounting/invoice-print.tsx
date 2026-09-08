import type { Invoice, InvoiceCompany } from "@/services/accounting.service";

// ─── Formatting + totals (spec-exact) ────────────────────────────────────

/** Banker-safe 2dp rounding used for every money figure on the invoice. */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Fixed 2dp thousands-grouped money, e.g. 1234.5 → "1,234.50". */
function money(n: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Long-form date rendered in UTC so it never drifts a day across zones. */
function formatDate(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

interface InvoicePrintProps {
  invoice: Invoice;
  company: InvoiceCompany;
}

/**
 * On-screen, print-ready reproduction of the Manut invoice template. Purely
 * presentational — the parent page fetches + owns loading/not-found state.
 * Forced to white background + dark text so it reads correctly on paper and
 * regardless of the app's light/dark theme.
 */
export function InvoicePrint({ invoice, company }: InvoicePrintProps) {
  const { currency } = invoice;

  // Legacy/summary invoices predate the line-item model — they carry a stored
  // total but no lines. Synthesize a single line from the stored amount so the
  // view isn't blank and the total isn't 0.
  const sourceLineItems =
    invoice.lineItems.length > 0
      ? invoice.lineItems
      : [
          {
            id: "fallback",
            description: invoice.notes?.trim() || "—",
            quantity: "1",
            unitPrice: invoice.amount,
            sortOrder: 0,
          },
        ];

  const rows = sourceLineItems.map((li) => {
    const qty = Number(li.quantity);
    const unitPrice = Number(li.unitPrice);
    return { ...li, qty, unitPrice, amount: qty * unitPrice };
  });

  const subtotal = round2(rows.reduce((sum, r) => sum + r.amount, 0));
  const vatRate = Number(invoice.vatRate);
  const whtRate = Number(invoice.whtRate);
  const taxRate = Number(invoice.taxRate);
  const vat = round2((subtotal * vatRate) / 100);
  const wht = round2((subtotal * whtRate) / 100);
  const tax = round2((subtotal * taxRate) / 100);
  const total = round2(subtotal + vat + tax - wht);

  const contactLine = [
    company.email ? `Email: ${company.email}` : null,
    company.tel ? `Tel: ${company.tel}` : null,
  ]
    .filter(Boolean)
    .join(" | ");

  const paymentDetails = [
    { label: "Bank", value: company.bankName },
    { label: "Account Type", value: company.bankAccountType },
    { label: "Branch", value: company.bankBranch },
    { label: "Account Name", value: company.bankAccountName },
    { label: "Account No.", value: company.bankAccountNo },
    { label: "SWIFT", value: company.bankSwift },
  ].filter((d) => d.value && d.value.trim() !== "");

  return (
    <div
      className={`
        mx-auto max-w-[800px] bg-white p-10 font-sans text-[13px]
        leading-relaxed text-neutral-900
        [print-color-adjust:exact]
      `}
    >
      {/* 1 — Letterhead */}
      <header className="flex items-start justify-between gap-8">
        <div className="max-w-[60%]">
          <h1 className="font-serif text-xl font-bold text-neutral-900">
            {company.name}
          </h1>
          <div className="mt-1 space-y-0.5 text-[12px] text-neutral-600">
            {company.addressLines.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
            {company.taxId && <div>Tax ID: {company.taxId}</div>}
            {contactLine && <div>{contactLine}</div>}
          </div>
        </div>
        <div className="text-right">
          <div
            className={`
              font-serif text-3xl font-bold tracking-widest text-neutral-900
            `}
          >
            INVOICE
          </div>
          <div className="mt-1 text-[13px] text-neutral-600">
            No. {invoice.invoiceNo}
          </div>
          {invoice.entity?.name && (
            <div className="mt-0.5 text-[12px] text-neutral-500">
              {invoice.entity.name}
            </div>
          )}
        </div>
      </header>

      <hr className="my-6 border-neutral-300" />

      {/* 2 — Bill-to + meta */}
      <section className="grid grid-cols-2 gap-8">
        <div>
          <div
            className={`
              text-[11px] font-semibold tracking-wider text-neutral-500
              uppercase
            `}
          >
            Bill To
          </div>
          <div className="mt-1 font-semibold text-neutral-900">
            {invoice.counterparty}
          </div>
          {invoice.billToAddress && (
            <div
              className={`mt-1 text-[12px] whitespace-pre-line text-neutral-600`}
            >
              {invoice.billToAddress}
            </div>
          )}
        </div>
        <dl className="space-y-1 text-[12px]">
          <MetaRow label="Issue Date" value={formatDate(invoice.issueDate)} />
          <MetaRow label="Due Date" value={formatDate(invoice.dueDate)} />
          {invoice.paymentTerms && (
            <MetaRow label="Payment Terms" value={invoice.paymentTerms} />
          )}
          <MetaRow label="Currency" value={currency} />
          {invoice.reference && (
            <MetaRow label="Reference" value={invoice.reference} />
          )}
        </dl>
      </section>

      {/* 3 — Line items */}
      <table className="mt-8 w-full border-collapse text-[12px]">
        <thead>
          <tr className="border-b-2 border-neutral-800 text-left">
            <th className="py-2 pr-3 font-semibold text-neutral-700">
              Description
            </th>
            <th
              className={`
                w-20 px-3 py-2 text-right font-semibold text-neutral-700
              `}
            >
              Qty
            </th>
            <th
              className={`
                w-32 px-3 py-2 text-right font-semibold text-neutral-700
              `}
            >
              Unit Price ({currency})
            </th>
            <th
              className={`
                w-32 py-2 pl-3 text-right font-semibold text-neutral-700
              `}
            >
              Amount ({currency})
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-neutral-200 align-top">
              <td className="py-2 pr-3 text-neutral-800">{r.description}</td>
              <td
                className={`px-3 py-2 text-right text-neutral-800 tabular-nums`}
              >
                {money(r.qty)}
              </td>
              <td
                className={`px-3 py-2 text-right text-neutral-800 tabular-nums`}
              >
                {money(r.unitPrice)}
              </td>
              <td
                className={`py-2 pl-3 text-right text-neutral-800 tabular-nums`}
              >
                {money(r.amount)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* 4 — Notes */}
      {invoice.notes && (
        <section className="mt-6">
          <div
            className={`
              text-[11px] font-semibold tracking-wider text-neutral-500
              uppercase
            `}
          >
            Notes
          </div>
          <div
            className={`mt-1 text-[12px] whitespace-pre-line text-neutral-600`}
          >
            {invoice.notes}
          </div>
        </section>
      )}

      {/* 5 — Totals */}
      <section className="mt-6 flex justify-end">
        <dl className="w-72 space-y-1 text-[12px]">
          <TotalRow label="Subtotal" value={money(subtotal)} />
          <TotalRow label={`VAT (${invoice.vatRate}%)`} value={money(vat)} />
          {(invoice.taxLabel || taxRate > 0) && (
            <TotalRow
              label={`${invoice.taxLabel || "Tax"} (${taxRate}%)`}
              value={money(tax)}
            />
          )}
          <TotalRow
            label={`WHT (${invoice.whtRate}%)`}
            value={`(${money(wht)})`}
          />
          <div
            className={`
              mt-1 flex items-center justify-between border-t-2
              border-neutral-800 pt-2 font-bold text-neutral-900
            `}
          >
            <dt>TOTAL DUE</dt>
            <dd className="tabular-nums">
              {currency} {money(total)}
            </dd>
          </div>
        </dl>
      </section>

      {/* 6 — Payment details + footer */}
      {(paymentDetails.length > 0 || company.footerNote) && (
        <footer className="mt-10 border-t border-neutral-300 pt-4">
          {paymentDetails.length > 0 && (
            <>
              <div
                className={`
                  text-[11px] font-semibold tracking-wider text-neutral-500
                  uppercase
                `}
              >
                Payment Details
              </div>
              <dl
                className={`mt-2 grid grid-cols-2 gap-x-8 gap-y-1 text-[12px]`}
              >
                {paymentDetails.map((d) => (
                  <div key={d.label} className="flex gap-2">
                    <dt className="w-28 shrink-0 text-neutral-500">
                      {d.label}
                    </dt>
                    <dd className="text-neutral-800">{d.value}</dd>
                  </div>
                ))}
              </dl>
            </>
          )}
          {company.footerNote && (
            <p
              className={`mt-4 text-[11px] whitespace-pre-line text-neutral-500`}
            >
              {company.footerNote}
            </p>
          )}
        </footer>
      )}
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-neutral-500">{label}</dt>
      <dd className="text-right font-medium text-neutral-800">{value}</dd>
    </div>
  );
}

function TotalRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-neutral-700">
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
