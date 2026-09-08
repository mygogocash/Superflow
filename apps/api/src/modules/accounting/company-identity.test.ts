import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import { DEFAULT_ORG_NAME, orgNameFromSetting } from "@/common/constants/org";
import { prisma } from "@/infrastructure/database/prisma";
import { accountingService } from "@/modules/accounting/accounting.service";
import {
  buildDefaultInvoiceCompany,
  DEFAULT_INVOICE_COMPANY,
} from "@/modules/accounting/invoice-shared";

vi.mock("@/infrastructure/database/prisma", () => ({
  prisma: { systemSetting: { findUnique: vi.fn() } },
}));

const findUnique = prisma.systemSetting.findUnique as unknown as Mock;

// Route each findUnique to the row for its key, so getInvoiceCompany can read
// both `app.name` and `accounting.invoice_company` independently.
function stubSettings(rows: Record<string, unknown>) {
  findUnique.mockImplementation(
    async ({ where }: { where: { key: string } }) => {
      if (!(where.key in rows)) return null;
      return { key: where.key, value: rows[where.key] };
    },
  );
}

beforeEach(() => {
  findUnique.mockReset();
});

describe("orgNameFromSetting", () => {
  it("trims a stored org name", () => {
    expect(orgNameFromSetting("  Acme Corp  ")).toBe("Acme Corp");
  });

  it("falls back to the default when unset, blank, or non-string", () => {
    expect(orgNameFromSetting(null)).toBe(DEFAULT_ORG_NAME);
    expect(orgNameFromSetting("   ")).toBe(DEFAULT_ORG_NAME);
    expect(orgNameFromSetting(42)).toBe(DEFAULT_ORG_NAME);
  });
});

describe("buildDefaultInvoiceCompany", () => {
  it("names the block after the org and leaves legal/bank identity blank", () => {
    const c = buildDefaultInvoiceCompany("Acme Corp");
    expect(c.name).toBe("Acme Corp");
    // Legal + bank identity must come from admin setup, never a hardcoded default.
    expect(c.taxId).toBe("");
    expect(c.bankAccountNo).toBe("");
    expect(c.bankName).toBe("");
    expect(c.addressLines).toEqual([]);
    // Only the non-identity payment-terms note is kept.
    expect(c.footerNote).toContain("reference the invoice number");
  });

  it("ships no legacy legal entity in the static fallback", () => {
    expect(DEFAULT_INVOICE_COMPANY.name).toBe(DEFAULT_ORG_NAME);
    expect(DEFAULT_INVOICE_COMPANY.taxId).toBe("");
  });
});

describe("accountingService.getInvoiceCompany", () => {
  it("derives the company name from app.name when no override is saved", async () => {
    stubSettings({ "app.name": "Acme Corp" });
    const company = await accountingService.getInvoiceCompany();
    expect(company.name).toBe("Acme Corp");
    expect(company.bankAccountNo).toBe("");
    expect(company.taxId).toBe("");
  });

  it("overlays the admin-saved block, org-defaulting only missing fields", async () => {
    stubSettings({
      "app.name": "Acme Corp",
      "accounting.invoice_company": {
        name: "Acme Holdings Ltd.",
        taxId: "TAX-123",
        bankAccountNo: "999-1-11111-1",
        // email intentionally omitted -> falls back to the org default ("")
      },
    });
    const company = await accountingService.getInvoiceCompany();
    expect(company.name).toBe("Acme Holdings Ltd.");
    expect(company.taxId).toBe("TAX-123");
    expect(company.bankAccountNo).toBe("999-1-11111-1");
    expect(company.email).toBe("");
  });

  it("falls back to the default org name when app.name is unset", async () => {
    stubSettings({});
    const company = await accountingService.getInvoiceCompany();
    expect(company.name).toBe(DEFAULT_ORG_NAME);
  });
});
