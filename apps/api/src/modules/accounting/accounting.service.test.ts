import { Prisma } from "@nexora/database";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@/common/exceptions/http-exception";
import { accountingRepository } from "@/modules/accounting/accounting.repository";
import { accountingService } from "@/modules/accounting/accounting.service";
import { updateCompanyProfileSchema } from "@/modules/accounting/accounting.validation";
import { createExchangeRateService } from "@/modules/exchange-rates/exchange-rates.service";

vi.mock("@/modules/accounting/accounting.repository", () => ({
  accountingRepository: {
    findJournalById: vi.fn(),
    findJournalByIdIncludingDeleted: vi.fn(),
    approveJournal: vi.fn(),
    rejectJournal: vi.fn(),
    updateJournal: vi.fn(),
    bulkApproveJournals: vi.fn(),
    bulkRejectJournals: vi.fn(),
    softDeleteJournal: vi.fn(),
    restoreJournal: vi.fn(),
    bulkSoftDeleteJournals: vi.fn(),
    softDeleteAllJournals: vi.fn(),
    cancelJournal: vi.fn(),
    findInvoiceById: vi.fn(),
    findInvoiceByIdIncludingDeleted: vi.fn(),
    softDeleteInvoice: vi.fn(),
    restoreInvoice: vi.fn(),
    getMakerCheckerSetting: vi.fn(),
    findJournalsCreatedBy: vi.fn(),
    getPnlRows: vi.fn(),
    getReviewSummary: vi.fn(),
    getReviewQueue: vi.fn(),
    getOverdueInvoiceSummary: vi.fn(),
    getUnmatchedBankSummary: vi.fn(),
    findExhibitInvoices: vi.fn(),
    findAssetAccountIds: vi.fn(),
    // Company setup, fiscal year & activation gate (Chunk 2).
    findEntitySetup: vi.fn(),
    updateEntitySetup: vi.fn(),
    getEntitySetupState: vi.fn(),
    countActiveAccounts: vi.fn(),
    hasOpeningEntry: vi.fn(),
    findInvoiceByEntityAndNo: vi.fn(),
    createInvoice: vi.fn(),
    findInvoices: vi.fn(),
    updateInvoice: vi.fn(),
    findPaymentsForInvoice: vi.fn(),
    findActiveLinkedUploads: vi.fn(),
    // Tax-month lock (M9): default undefined → month open, nothing blocked.
    findTaxFiling: vi.fn(),
  },
}));

vi.mock("@/modules/exchange-rates/exchange-rates.service", () => ({
  createExchangeRateService: vi.fn(),
}));

const findJournalById = accountingRepository.findJournalById as Mock;
const approveJournal = accountingRepository.approveJournal as Mock;
const rejectJournal = accountingRepository.rejectJournal as Mock;
const updateJournal = accountingRepository.updateJournal as Mock;
const bulkApproveJournals = accountingRepository.bulkApproveJournals as Mock;
const bulkRejectJournals = accountingRepository.bulkRejectJournals as Mock;
const findJournalByIdIncludingDeleted =
  accountingRepository.findJournalByIdIncludingDeleted as Mock;
const softDeleteJournal = accountingRepository.softDeleteJournal as Mock;
const restoreJournal = accountingRepository.restoreJournal as Mock;
const bulkSoftDeleteJournals =
  accountingRepository.bulkSoftDeleteJournals as Mock;
const softDeleteAllJournals =
  accountingRepository.softDeleteAllJournals as Mock;
const cancelJournal = accountingRepository.cancelJournal as Mock;
const findInvoiceById = accountingRepository.findInvoiceById as Mock;
const findInvoiceByIdIncludingDeleted =
  accountingRepository.findInvoiceByIdIncludingDeleted as Mock;
const softDeleteInvoice = accountingRepository.softDeleteInvoice as Mock;
const restoreInvoice = accountingRepository.restoreInvoice as Mock;
const getMakerCheckerSetting =
  accountingRepository.getMakerCheckerSetting as Mock;
const findJournalsCreatedBy =
  accountingRepository.findJournalsCreatedBy as Mock;
const getPnlRows = accountingRepository.getPnlRows as Mock;
const getReviewSummary = accountingRepository.getReviewSummary as Mock;
const getReviewQueue = accountingRepository.getReviewQueue as Mock;
const getOverdueInvoiceSummary =
  accountingRepository.getOverdueInvoiceSummary as Mock;
const getUnmatchedBankSummary =
  accountingRepository.getUnmatchedBankSummary as Mock;
const findExhibitInvoices = accountingRepository.findExhibitInvoices as Mock;
const findAssetAccountIds = accountingRepository.findAssetAccountIds as Mock;
const findEntitySetup = accountingRepository.findEntitySetup as Mock;
const updateEntitySetup = accountingRepository.updateEntitySetup as Mock;
const getEntitySetupState = accountingRepository.getEntitySetupState as Mock;
const countActiveAccounts = accountingRepository.countActiveAccounts as Mock;
const hasOpeningEntry = accountingRepository.hasOpeningEntry as Mock;
const findInvoiceByEntityAndNo =
  accountingRepository.findInvoiceByEntityAndNo as Mock;
const createInvoiceRepo = accountingRepository.createInvoice as Mock;
const findInvoices = accountingRepository.findInvoices as Mock;
const updateInvoiceRepo = accountingRepository.updateInvoice as Mock;
const findPaymentsForInvoice =
  accountingRepository.findPaymentsForInvoice as Mock;
const findActiveLinkedUploads =
  accountingRepository.findActiveLinkedUploads as Mock;
const createFx = createExchangeRateService as Mock;

function journal(
  status = "draft",
  createdBy = "creator-1",
  extras: Record<string, unknown> = {},
) {
  return {
    id: "journal-1",
    status,
    createdBy,
    reversesEntryId: null,
    sourceType: null,
    draftNo: "DRAFT-000001",
    entryNo: status === "draft" ? "DRAFT-000001" : "JE202608001",
    lines: [
      {
        accountId: "account-1",
        debit: new Prisma.Decimal(100),
        credit: new Prisma.Decimal(100),
      },
    ],
    ...extras,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  findExhibitInvoices.mockResolvedValue([]);
  // Capex classification asks whether a line's account is an asset account; an
  // empty set means "nothing is capex", which is right for these fixtures.
  findAssetAccountIds.mockResolvedValue(new Set<string>());
  findActiveLinkedUploads.mockResolvedValue([]);
});

describe("AccountingService journal review", () => {
  it("rejects a draft journal with reviewer metadata", async () => {
    findJournalById.mockResolvedValue(journal("draft"));
    rejectJournal.mockResolvedValue(journal("rejected"));

    await accountingService.rejectJournal(
      "journal-1",
      "reviewer-1",
      "Wrong expense account",
    );

    expect(rejectJournal).toHaveBeenCalledWith(
      "journal-1",
      "reviewer-1",
      "Wrong expense account",
    );
  });

  it("prevents rejecting a journal that is no longer draft", async () => {
    findJournalById.mockResolvedValue(journal("approved"));

    await expect(
      accountingService.rejectJournal(
        "journal-1",
        "reviewer-1",
        "Needs correction",
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(rejectJournal).not.toHaveBeenCalled();
  });

  it("returns a rejected journal to draft when corrected", async () => {
    findJournalById.mockResolvedValue(journal("rejected"));
    updateJournal.mockResolvedValue(journal("draft"));

    await accountingService.updateJournal("journal-1", {
      description: "Corrected entry",
    });

    expect(updateJournal).toHaveBeenCalledWith(
      "journal-1",
      { description: "Corrected entry" },
      true,
    );
  });

  it("bulk review returns the number of eligible journals changed", async () => {
    findJournalById
      .mockResolvedValueOnce(journal("draft"))
      .mockResolvedValueOnce(journal("draft"))
      .mockResolvedValueOnce(journal("draft"))
      .mockResolvedValueOnce(journal("draft"))
      .mockResolvedValueOnce(journal("posted"));
    approveJournal.mockResolvedValue(journal("posted"));
    bulkRejectJournals.mockResolvedValue({ count: 1 });

    await expect(
      accountingService.bulkApproveJournals(
        ["journal-1", "journal-2", "posted-journal"],
        "reviewer-1",
      ),
    ).resolves.toEqual({ updatedCount: 2 });
    expect(approveJournal).toHaveBeenCalledTimes(2);
    await expect(
      accountingService.bulkRejectJournals(
        ["journal-3", "approved-journal"],
        "reviewer-1",
        "Missing support",
      ),
    ).resolves.toEqual({ updatedCount: 1 });
  });
});

describe("AccountingService maker-checker (block self-approval)", () => {
  it("allows self-approval when the flag is OFF (default, no config row)", async () => {
    getMakerCheckerSetting.mockResolvedValue(null);
    findJournalById.mockResolvedValue(journal("draft", "user-1"));
    approveJournal.mockResolvedValue(journal("approved", "user-1"));

    await expect(
      accountingService.approveJournal("journal-1", "user-1"),
    ).resolves.toMatchObject({ status: "approved" });
    expect(approveJournal).toHaveBeenCalledWith("journal-1", "user-1");
  });

  it("blocks self-approval when the flag is ON", async () => {
    getMakerCheckerSetting.mockResolvedValue({
      key: "accounting.maker_checker",
      value: { blockSelfApproval: true },
    });
    findJournalById.mockResolvedValue(journal("draft", "user-1"));

    await expect(
      accountingService.approveJournal("journal-1", "user-1"),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(approveJournal).not.toHaveBeenCalled();
  });

  it("allows a different approver to approve when the flag is ON", async () => {
    getMakerCheckerSetting.mockResolvedValue({
      key: "accounting.maker_checker",
      value: { blockSelfApproval: true },
    });
    findJournalById.mockResolvedValue(journal("draft", "user-1"));
    approveJournal.mockResolvedValue(journal("approved", "user-1"));

    await expect(
      accountingService.approveJournal("journal-1", "approver-2"),
    ).resolves.toMatchObject({ status: "approved" });
    expect(approveJournal).toHaveBeenCalledWith("journal-1", "approver-2");
  });

  it("blocks a bulk approve that includes a journal the approver created", async () => {
    getMakerCheckerSetting.mockResolvedValue({
      key: "accounting.maker_checker",
      value: { blockSelfApproval: true },
    });
    findJournalsCreatedBy.mockResolvedValue([{ id: "journal-1" }]);

    await expect(
      accountingService.bulkApproveJournals(
        ["journal-1", "journal-2"],
        "user-1",
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(bulkApproveJournals).not.toHaveBeenCalled();
  });
});

describe("AccountingService corporate finance overview", () => {
  it("consolidates entity P&L in USD and compares the previous period", async () => {
    getPnlRows
      .mockResolvedValueOnce([
        {
          accountId: "rev-th",
          accountCode: "4000",
          accountName: "Revenue",
          accountType: "revenue",
          entityId: "th",
          entityName: "TBH Thailand",
          entityCode: "TH",
          currency: "THB",
          debit: 0,
          credit: 3600,
        },
        {
          accountId: "exp-th",
          accountCode: "5000",
          accountName: "Payroll",
          accountType: "expense",
          entityId: "th",
          entityName: "TBH Thailand",
          entityCode: "TH",
          currency: "THB",
          debit: 1800,
          credit: 0,
        },
        {
          accountId: "rev-us",
          accountCode: "4000",
          accountName: "Revenue",
          accountType: "revenue",
          entityId: "us",
          entityName: "TBH US",
          entityCode: "US",
          currency: "USD",
          debit: 0,
          credit: 200,
        },
      ])
      .mockResolvedValueOnce([
        {
          accountId: "rev-th",
          accountCode: "4000",
          accountName: "Revenue",
          accountType: "revenue",
          entityId: "th",
          entityName: "TBH Thailand",
          entityCode: "TH",
          currency: "THB",
          debit: 0,
          credit: 1800,
        },
      ]);
    getReviewSummary.mockResolvedValue({
      draft: 3,
      rejected: 1,
      approved: 2,
      staleDrafts: 1,
    });
    getReviewQueue.mockResolvedValue([]);
    getOverdueInvoiceSummary.mockResolvedValue({ count: 0, items: [] });
    getUnmatchedBankSummary.mockResolvedValue({ count: 0, items: [] });
    createFx.mockReturnValue({
      resolveRate: vi.fn(async (from: string) =>
        from === "THB"
          ? { rate: 1 / 36, source: "inverse" }
          : { rate: 1, source: "identity" },
      ),
    });

    const result = await accountingService.getCorporateOverview({
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    });

    expect(result.reportingCurrency).toBe("USD");
    expect(result.totals).toMatchObject({
      revenue: 300,
      expenses: 50,
      netProfit: 250,
      previousNetProfit: 50,
      netProfitChangePct: 400,
    });
    expect(result.entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityId: "th",
          revenue: 3600,
          expenses: 1800,
          netProfitUsd: 50,
          fxRate: 1 / 36,
        }),
      ]),
    );
    expect(result.review.counts).toEqual({
      draft: 3,
      rejected: 1,
      approved: 2,
      staleDrafts: 1,
    });
  });

  it("keeps prior-period entities when current-period activity is zero", async () => {
    getPnlRows.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        accountId: "rev-us",
        accountCode: "4000",
        accountName: "Revenue",
        accountType: "revenue",
        entityId: "us",
        entityName: "TBH US",
        entityCode: "US",
        currency: "USD",
        debit: 0,
        credit: 200,
      },
    ]);
    getReviewSummary.mockResolvedValue({
      draft: 0,
      rejected: 0,
      approved: 0,
      staleDrafts: 0,
    });
    getReviewQueue.mockResolvedValue([]);
    getOverdueInvoiceSummary.mockResolvedValue({ count: 0, items: [] });
    getUnmatchedBankSummary.mockResolvedValue({ count: 0, items: [] });
    createFx.mockReturnValue({
      resolveRate: vi.fn().mockResolvedValue({
        rate: 1,
        source: "identity",
      }),
    });

    const result = await accountingService.getCorporateOverview({
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    });

    expect(result.totals).toMatchObject({
      netProfit: 0,
      previousNetProfit: 200,
      netProfitChangePct: -100,
    });
    expect(result.entities[0]).toMatchObject({
      entityId: "us",
      netProfitUsd: 0,
      previousNetProfitUsd: 200,
    });
  });

  it("marks consolidated totals incomplete when an entity has no FX path", async () => {
    getPnlRows
      .mockResolvedValueOnce([
        {
          accountId: "rev-in",
          accountCode: "4000",
          accountName: "Revenue",
          accountType: "revenue",
          entityId: "in",
          entityName: "TBH India",
          entityCode: "IN",
          currency: "INR",
          debit: 0,
          credit: 1000,
        },
      ])
      .mockResolvedValueOnce([]);
    getReviewSummary.mockResolvedValue({
      draft: 0,
      rejected: 0,
      approved: 0,
      staleDrafts: 0,
    });
    getReviewQueue.mockResolvedValue([]);
    getOverdueInvoiceSummary.mockResolvedValue({ count: 0, items: [] });
    getUnmatchedBankSummary.mockResolvedValue({ count: 0, items: [] });
    createFx.mockReturnValue({
      resolveRate: vi.fn().mockResolvedValue({
        rate: 0,
        source: "missing",
      }),
    });

    const result = await accountingService.getCorporateOverview({
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    });

    expect(result.fxCompleteness).toEqual({
      isComplete: false,
      excludedEntityCount: 1,
      missingCurrencies: ["INR"],
    });
    expect(result.entities[0]).toMatchObject({
      entityId: "in",
      fxSource: "missing",
      netProfitUsd: 0,
    });
  });
});

// Own-document RBAC tokens used by soft-delete restore IDOR tests below and
// by the Chunk 5 scoping suite further down.
const READ_ALL = ["accounting:read", "accounting:read-all"];
const ADMIN_ONLY = ["accounting:admin"];
const OWN_ONLY = ["accounting:read", "accounting:create"]; // Sales / Purchasing

describe("AccountingService soft delete + restore (Rule 3)", () => {
  it("soft-deletes a draft journal instead of hard-deleting it", async () => {
    findJournalById.mockResolvedValue(journal("draft"));
    softDeleteJournal.mockResolvedValue({
      ...journal("draft"),
      deletedAt: new Date(),
    });

    const result = await accountingService.deleteJournal("journal-1");

    expect(softDeleteJournal).toHaveBeenCalledWith("journal-1", undefined);
    expect((result as { deletedAt: Date | null }).deletedAt).toBeInstanceOf(
      Date,
    );
  });

  it("restores a soft-deleted journal via the include-deleted lookup", async () => {
    findJournalByIdIncludingDeleted.mockResolvedValue({
      ...journal("draft"),
      deletedAt: new Date(),
    });
    restoreJournal.mockResolvedValue({ ...journal("draft"), deletedAt: null });

    const result = await accountingService.restoreJournal(
      "journal-1",
      "creator-1",
      OWN_ONLY,
    );

    expect(findJournalByIdIncludingDeleted).toHaveBeenCalledWith("journal-1");
    expect(restoreJournal).toHaveBeenCalledWith("journal-1");
    expect((result as { deletedAt: Date | null }).deletedAt).toBeNull();
  });

  it("blocks restoring another user's journal without read-all", async () => {
    findJournalByIdIncludingDeleted.mockResolvedValue({
      ...journal("draft", "owner-a"),
      deletedAt: new Date(),
    });

    await expect(
      accountingService.restoreJournal("journal-1", "owner-b", OWN_ONLY),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(restoreJournal).not.toHaveBeenCalled();
  });

  it("allows read-all callers to restore another user's journal", async () => {
    findJournalByIdIncludingDeleted.mockResolvedValue({
      ...journal("draft", "owner-a"),
      deletedAt: new Date(),
    });
    restoreJournal.mockResolvedValue({
      ...journal("draft", "owner-a"),
      deletedAt: null,
    });

    await accountingService.restoreJournal("journal-1", "admin-1", READ_ALL);
    expect(restoreJournal).toHaveBeenCalledWith("journal-1");
  });

  it("404s when restoring a journal absent even including deleted rows", async () => {
    findJournalByIdIncludingDeleted.mockResolvedValue(null);

    await expect(
      accountingService.restoreJournal("missing", "creator-1", OWN_ONLY),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(restoreJournal).not.toHaveBeenCalled();
  });

  it("bulk-deletes a specific id set through the soft-delete path", async () => {
    bulkSoftDeleteJournals.mockResolvedValue({ count: 2 });

    await expect(
      accountingService.bulkDeleteJournals({ ids: ["a", "b"] }),
    ).resolves.toEqual({ deletedCount: 2, mode: "ids" });
    expect(bulkSoftDeleteJournals).toHaveBeenCalledWith(["a", "b"]);
    expect(softDeleteAllJournals).not.toHaveBeenCalled();
  });

  it("bulk-deletes every journal through the soft-delete path", async () => {
    softDeleteAllJournals.mockResolvedValue({ count: 9 });

    await expect(
      accountingService.bulkDeleteJournals({ all: true }),
    ).resolves.toEqual({ deletedCount: 9, mode: "all" });
    expect(softDeleteAllJournals).toHaveBeenCalledTimes(1);
    expect(bulkSoftDeleteJournals).not.toHaveBeenCalled();
  });

  it("soft-deletes an invoice instead of hard-deleting it", async () => {
    findInvoiceById.mockResolvedValue({ id: "inv-1", createdBy: "creator-1" });
    softDeleteInvoice.mockResolvedValue({ id: "inv-1", deletedAt: new Date() });

    const result = await accountingService.deleteInvoice("inv-1", "admin-1", [
      "accounting:read-all",
    ]);

    expect(softDeleteInvoice).toHaveBeenCalledWith("inv-1", "admin-1");
    expect((result as { deletedAt: Date | null }).deletedAt).toBeInstanceOf(
      Date,
    );
  });

  it("restores a soft-deleted invoice via the include-deleted lookup", async () => {
    findInvoiceByIdIncludingDeleted.mockResolvedValue({
      id: "inv-1",
      createdBy: "creator-1",
      deletedAt: new Date(),
    });
    restoreInvoice.mockResolvedValue({ id: "inv-1", deletedAt: null });

    const result = await accountingService.restoreInvoice(
      "inv-1",
      "creator-1",
      OWN_ONLY,
    );

    expect(findInvoiceByIdIncludingDeleted).toHaveBeenCalledWith("inv-1");
    expect(restoreInvoice).toHaveBeenCalledWith("inv-1");
    expect((result as { deletedAt: Date | null }).deletedAt).toBeNull();
  });

  it("blocks restoring another user's invoice without read-all", async () => {
    findInvoiceByIdIncludingDeleted.mockResolvedValue({
      id: "inv-1",
      createdBy: "owner-a",
      deletedAt: new Date(),
    });

    await expect(
      accountingService.restoreInvoice("inv-1", "owner-b", OWN_ONLY),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(restoreInvoice).not.toHaveBeenCalled();
  });

  it("allows read-all callers to restore another user's invoice", async () => {
    findInvoiceByIdIncludingDeleted.mockResolvedValue({
      id: "inv-1",
      createdBy: "owner-a",
      deletedAt: new Date(),
    });
    restoreInvoice.mockResolvedValue({ id: "inv-1", deletedAt: null });

    await accountingService.restoreInvoice("inv-1", "admin-1", READ_ALL);
    expect(restoreInvoice).toHaveBeenCalledWith("inv-1");
  });

  it("404s when restoring an invoice absent even including deleted rows", async () => {
    findInvoiceByIdIncludingDeleted.mockResolvedValue(null);

    await expect(
      accountingService.restoreInvoice("missing", "creator-1", OWN_ONLY),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(restoreInvoice).not.toHaveBeenCalled();
  });
});

// ── Own-document RBAC scoping (Chunk 5) ────────────────────────────────────
// Non-breaking safety rule: a caller with `accounting:read-all` (or
// `accounting:admin`) sees/acts on every document; everyone else is scoped to
// documents they created. These tests pin the enforcement in the service.

describe("AccountingService own-document scoping — reads", () => {
  it("a read-all caller lists every invoice (no owner filter)", async () => {
    findInvoices.mockResolvedValue({ data: [{ id: "inv-1" }], total: 1 });

    await accountingService.listInvoices(
      { page: 1, limit: 20 } as Parameters<
        typeof accountingService.listInvoices
      >[0],
      "actor-1",
      READ_ALL,
    );

    // createdBy is undefined → the repository returns all rows.
    expect(findInvoices).toHaveBeenCalledWith(
      expect.objectContaining({ createdBy: undefined }),
      1,
      20,
    );
  });

  it("accounting:admin alone also bypasses the owner filter", async () => {
    findInvoices.mockResolvedValue({ data: [], total: 0 });

    await accountingService.listInvoices(
      { page: 1, limit: 20 } as Parameters<
        typeof accountingService.listInvoices
      >[0],
      "actor-1",
      ADMIN_ONLY,
    );

    expect(findInvoices).toHaveBeenCalledWith(
      expect.objectContaining({ createdBy: undefined }),
      1,
      20,
    );
  });

  it("a non-read-all caller only lists their own invoices", async () => {
    findInvoices.mockResolvedValue({ data: [], total: 0 });

    await accountingService.listInvoices(
      { page: 1, limit: 20 } as Parameters<
        typeof accountingService.listInvoices
      >[0],
      "sales-9",
      OWN_ONLY,
    );

    // The owner filter is forced to the caller — client can't widen it.
    expect(findInvoices).toHaveBeenCalledWith(
      expect.objectContaining({ createdBy: "sales-9" }),
      1,
      20,
    );
  });

  it("getInvoiceByIdForActor 403s a non-owner without read-all", async () => {
    findInvoiceById.mockResolvedValue({ id: "inv-1", createdBy: "other-user" });

    await expect(
      accountingService.getInvoiceByIdForActor("inv-1", "sales-9", OWN_ONLY),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("getInvoiceByIdForActor returns the doc for its owner", async () => {
    findInvoiceById.mockResolvedValue({ id: "inv-1", createdBy: "sales-9" });
    findActiveLinkedUploads.mockResolvedValue([]);

    await expect(
      accountingService.getInvoiceByIdForActor("inv-1", "sales-9", OWN_ONLY),
    ).resolves.toMatchObject({ id: "inv-1" });
  });

  it("getInvoiceByIdForActor returns any doc for a read-all caller", async () => {
    findInvoiceById.mockResolvedValue({ id: "inv-1", createdBy: "other-user" });
    findActiveLinkedUploads.mockResolvedValue([]);

    await expect(
      accountingService.getInvoiceByIdForActor("inv-1", "viewer-1", READ_ALL),
    ).resolves.toMatchObject({ id: "inv-1" });
  });
});

describe("AccountingService own-document scoping — mutations", () => {
  it("updateInvoice 403s a non-owner without read-all", async () => {
    findInvoiceById.mockResolvedValue({
      id: "inv-1",
      createdBy: "other-user",
      lineItems: [],
    });

    await expect(
      accountingService.updateInvoice(
        "inv-1",
        {} as Parameters<typeof accountingService.updateInvoice>[1],
        "sales-9",
        OWN_ONLY,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(updateInvoiceRepo).not.toHaveBeenCalled();
  });

  it("deleteInvoice 403s a non-owner without read-all", async () => {
    findInvoiceById.mockResolvedValue({ id: "inv-1", createdBy: "other-user" });

    await expect(
      accountingService.deleteInvoice("inv-1", "sales-9", OWN_ONLY),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(softDeleteInvoice).not.toHaveBeenCalled();
  });

  it("updateInvoiceStatus 403s a non-owner without read-all", async () => {
    findInvoiceById.mockResolvedValue({
      id: "inv-1",
      createdBy: "other-user",
      status: "draft",
    });

    await expect(
      accountingService.updateInvoiceStatus(
        "inv-1",
        "sent",
        "sales-9",
        OWN_ONLY,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("listPaymentsForInvoice 403s a non-owner without read-all", async () => {
    findInvoiceById.mockResolvedValue({ id: "inv-1", createdBy: "other-user" });

    await expect(
      accountingService.listPaymentsForInvoice("inv-1", "sales-9", OWN_ONLY),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(findPaymentsForInvoice).not.toHaveBeenCalled();
  });

  it("deleteInvoice allows the owner (own-docs) through", async () => {
    findInvoiceById.mockResolvedValue({ id: "inv-1", createdBy: "sales-9" });
    softDeleteInvoice.mockResolvedValue({ id: "inv-1", deletedAt: new Date() });

    await expect(
      accountingService.deleteInvoice("inv-1", "sales-9", OWN_ONLY),
    ).resolves.toMatchObject({ id: "inv-1" });
    expect(softDeleteInvoice).toHaveBeenCalledWith("inv-1", "sales-9");
  });
});

describe("AccountingService journal cancel (PRD 2)", () => {
  it("cancels a posted journal with a reason", async () => {
    findJournalById.mockResolvedValue(journal("posted"));
    cancelJournal.mockResolvedValue({
      journal: journal("cancelled"),
      warnings: [],
    });

    await expect(
      accountingService.cancelJournal("journal-1", "user-1", {
        reason: "Wrong account",
      }),
    ).resolves.toMatchObject({ status: "cancelled", warnings: [] });
    expect(cancelJournal).toHaveBeenCalledWith({
      id: "journal-1",
      actorId: "user-1",
      reason: "Wrong account",
      reverseDate: undefined,
    });
  });

  it("passes the reversal warnings back to the caller", async () => {
    findJournalById.mockResolvedValue(journal("posted"));
    cancelJournal.mockResolvedValue({
      journal: journal("reversed"),
      warnings: [
        {
          code: "reversal_affects_tax_filing",
          message: "…moves into the 2026-08 return…",
          messageTh: "…",
        },
      ],
    });

    const result = await accountingService.cancelJournal(
      "journal-1",
      "user-1",
      { reason: "Wrong month", reverseDate: "2026-08-01" },
    );

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.code).toBe("reversal_affects_tax_filing");
  });

  it("rejects cancel without a reason", async () => {
    findJournalById.mockResolvedValue(journal("posted"));
    await expect(
      accountingService.cancelJournal("journal-1", "user-1", { reason: "  " }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(cancelJournal).not.toHaveBeenCalled();
  });

  it("rejects cancel of a draft", async () => {
    findJournalById.mockResolvedValue(journal("draft"));
    await expect(
      accountingService.cancelJournal("journal-1", "user-1", {
        reason: "Changed mind",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(cancelJournal).not.toHaveBeenCalled();
  });

  it("rejects cancel of an imported journal with no draft number", async () => {
    findJournalById.mockResolvedValue(
      journal("posted", "creator-1", { draftNo: null, sourceType: null }),
    );
    await expect(
      accountingService.cancelJournal("journal-1", "user-1", {
        reason: "Imported in error",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(cancelJournal).not.toHaveBeenCalled();
  });

  it("rejects cancel of an engine-posted journal", async () => {
    findJournalById.mockResolvedValue(
      journal("posted", "creator-1", { sourceType: "invoice" }),
    );
    await expect(
      accountingService.cancelJournal("journal-1", "user-1", {
        reason: "Wrong invoice",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(cancelJournal).not.toHaveBeenCalled();
  });

  it("rejects cancel of a reversing journal", async () => {
    findJournalById.mockResolvedValue(
      journal("posted", "creator-1", { reversesEntryId: "orig-1" }),
    );
    await expect(
      accountingService.cancelJournal("journal-1", "user-1", {
        reason: "Undo the reversal",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(cancelJournal).not.toHaveBeenCalled();
  });
});

// ── Company setup, fiscal year & activation gate (Chunk 2) ─────────────────

function entitySetup(overrides: Record<string, unknown> = {}) {
  return {
    id: "ent-1",
    name: "TBH Thailand",
    code: "TH",
    country: "TH",
    currency: "THB",
    setupState: "setup",
    fiscalYearStartMonth: 1,
    defaultRateSource: "bot",
    enabledCurrencies: ["THB"],
    ...overrides,
  };
}

describe("AccountingService activation gate", () => {
  it("allows issuance when the entity is active", async () => {
    getEntitySetupState.mockResolvedValue("active");
    await expect(
      accountingService.assertEntityActivated("ent-1"),
    ).resolves.toBeUndefined();
  });

  it("throws ConflictException when the entity is still in setup", async () => {
    getEntitySetupState.mockResolvedValue("setup");
    await expect(
      accountingService.assertEntityActivated("ent-1"),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("does not block issuance for a grandfathered (default active) entity", async () => {
    // Existing rows backfilled to "active" by the migration read back "active".
    getEntitySetupState.mockResolvedValue("active");
    await expect(
      accountingService.assertEntityActivated("legacy-ent"),
    ).resolves.toBeUndefined();
  });

  it("blocks createInvoice for an entity in setup before any write", async () => {
    getEntitySetupState.mockResolvedValue("setup");
    await expect(
      accountingService.createInvoice(
        {
          entityId: "ent-1",
          invoiceNo: "INV-001",
          type: "receivable",
          counterparty: "ACME",
          currency: "THB",
          vatRate: 7,
          taxRate: 0,
          whtRate: 0,
          issueDate: "2026-07-01",
          dueDate: "2026-07-31",
          lineItems: [{ description: "Item", quantity: 1, unitPrice: 100 }],
        } as Parameters<typeof accountingService.createInvoice>[0],
        "user-1",
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(findInvoiceByEntityAndNo).not.toHaveBeenCalled();
    expect(createInvoiceRepo).not.toHaveBeenCalled();
  });

  it("proceeds with createInvoice when the entity is active", async () => {
    getEntitySetupState.mockResolvedValue("active");
    findInvoiceByEntityAndNo.mockResolvedValue(null);
    createInvoiceRepo.mockResolvedValue({ id: "inv-1" });

    await expect(
      accountingService.createInvoice(
        {
          entityId: "ent-1",
          invoiceNo: "INV-001",
          type: "receivable",
          counterparty: "ACME",
          currency: "THB",
          vatRate: 7,
          taxRate: 0,
          whtRate: 0,
          issueDate: "2026-07-01",
          dueDate: "2026-07-31",
          lineItems: [{ description: "Item", quantity: 1, unitPrice: 100 }],
        } as Parameters<typeof accountingService.createInvoice>[0],
        "user-7",
      ),
    ).resolves.toEqual({ id: "inv-1" });
    expect(createInvoiceRepo).toHaveBeenCalledTimes(1);
    // The author is stamped so own-document scoping can attribute the row.
    expect(createInvoiceRepo).toHaveBeenCalledWith(
      expect.objectContaining({ createdBy: "user-7" }),
    );
  });
});

describe("updateCompanyProfileSchema validation", () => {
  it("rejects a fiscal-year start month outside 1–12", () => {
    expect(
      updateCompanyProfileSchema.safeParse({
        entityId: "ent-1",
        fiscalYearStartMonth: 13,
      }).success,
    ).toBe(false);
    expect(
      updateCompanyProfileSchema.safeParse({
        entityId: "ent-1",
        fiscalYearStartMonth: 0,
      }).success,
    ).toBe(false);
    expect(
      updateCompanyProfileSchema.safeParse({
        entityId: "ent-1",
        fiscalYearStartMonth: 4,
      }).success,
    ).toBe(true);
  });

  it("requires THB in enabledCurrencies when the list is submitted", () => {
    expect(
      updateCompanyProfileSchema.safeParse({
        entityId: "ent-1",
        enabledCurrencies: ["USD", "EUR"],
      }).success,
    ).toBe(false);
    expect(
      updateCompanyProfileSchema.safeParse({
        entityId: "ent-1",
        enabledCurrencies: ["THB", "USD"],
      }).success,
    ).toBe(true);
  });

  it("leaves currencies unvalidated when the list is omitted", () => {
    expect(
      updateCompanyProfileSchema.safeParse({
        entityId: "ent-1",
        nameTh: "ทีบีเอช",
      }).success,
    ).toBe(true);
  });
});

describe("AccountingService activateCompany", () => {
  it("activates when a fiscal-year month, ≥1 active account and an opening entry are present", async () => {
    findEntitySetup.mockResolvedValue(
      entitySetup({ setupState: "setup", fiscalYearStartMonth: 1 }),
    );
    countActiveAccounts.mockResolvedValue(2);
    hasOpeningEntry.mockResolvedValue(true);
    updateEntitySetup.mockResolvedValue(
      entitySetup({ setupState: "active", fiscalYearStartMonth: 1 }),
    );

    const result = await accountingService.activateCompany({
      entityId: "ent-1",
    });

    expect(result).toMatchObject({ setupState: "active", activated: true });
    expect(updateEntitySetup).toHaveBeenCalledWith("ent-1", {
      setupState: "active",
    });
  });

  it("refuses activation when the entity has no active accounts", async () => {
    findEntitySetup.mockResolvedValue(entitySetup({ setupState: "setup" }));
    countActiveAccounts.mockResolvedValue(0);

    await expect(
      accountingService.activateCompany({ entityId: "ent-1" }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(updateEntitySetup).not.toHaveBeenCalled();
  });

  it("blocks activation of a 'setup' entity until an opening entry exists", async () => {
    findEntitySetup.mockResolvedValue(
      entitySetup({ setupState: "setup", fiscalYearStartMonth: 1 }),
    );
    countActiveAccounts.mockResolvedValue(2);
    hasOpeningEntry.mockResolvedValue(false);

    await expect(
      accountingService.activateCompany({ entityId: "ent-1" }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(updateEntitySetup).not.toHaveBeenCalled();
  });

  it("is an idempotent no-op when the entity is already active", async () => {
    findEntitySetup.mockResolvedValue(entitySetup({ setupState: "active" }));

    const result = await accountingService.activateCompany({
      entityId: "ent-1",
    });

    expect(result).toMatchObject({ setupState: "active", activated: false });
    expect(countActiveAccounts).not.toHaveBeenCalled();
    expect(updateEntitySetup).not.toHaveBeenCalled();
  });

  it("404s on an unknown entity", async () => {
    findEntitySetup.mockResolvedValue(null);
    await expect(
      accountingService.activateCompany({ entityId: "nope" }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
