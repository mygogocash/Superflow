import { DEFAULT_ORG_NAME } from "../lib/org";

/** Admin-editable company + bank block for generated invoices. */
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
// the wrong company (and wrong bank account) on a rebranded org.
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

/** Static fallback for callers that cannot resolve the org name from the DB. */
export const DEFAULT_INVOICE_COMPANY: InvoiceCompany =
  buildDefaultInvoiceCompany(DEFAULT_ORG_NAME);

export const INVOICE_COMPANY_KEY = "accounting.invoice_company";
