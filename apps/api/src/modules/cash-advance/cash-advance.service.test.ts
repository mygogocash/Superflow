import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import { ForbiddenException } from "@/common/exceptions/http-exception";
import { cashAdvanceRepository } from "@/modules/cash-advance/cash-advance.repository";
import { cashAdvanceService } from "@/modules/cash-advance/cash-advance.service";

vi.mock("@/modules/cash-advance/cash-advance.repository", () => ({
  cashAdvanceRepository: {
    findById: vi.fn(),
    findByIdIncludingDeleted: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    findApprovalSteps: vi.fn(),
    createDecisions: vi.fn(),
    findDecisions: vi.fn(),
    updateDecision: vi.fn(),
    findUserById: vi.fn(),
    permanentDelete: vi.fn(),
  },
}));
vi.mock("@/infrastructure/email/email.service", () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/modules/expenses/expense-shared", () => ({
  signReceiptUrlIfNeeded: vi.fn(async (u: string | null | undefined) =>
    u ? `signed:${u}` : null,
  ),
}));
vi.mock("@/infrastructure/database/prisma", () => ({
  prisma: {
    cashAdvanceApprovalDecision: { deleteMany: vi.fn() },
    systemSetting: { findUnique: vi.fn().mockResolvedValue(null) },
  },
}));

const findById = cashAdvanceRepository.findById as Mock;
const findByIdIncludingDeleted =
  cashAdvanceRepository.findByIdIncludingDeleted as Mock;
const create = cashAdvanceRepository.create as Mock;
const update = cashAdvanceRepository.update as Mock;
const findApprovalSteps = cashAdvanceRepository.findApprovalSteps as Mock;
const createDecisions = cashAdvanceRepository.createDecisions as Mock;
const findDecisions = cashAdvanceRepository.findDecisions as Mock;
const updateDecision = cashAdvanceRepository.updateDecision as Mock;
const findUserById = cashAdvanceRepository.findUserById as Mock;
const permanentDelete = cashAdvanceRepository.permanentDelete as Mock;

const REQUESTER = "emp-1";
const MANAGER = "mgr-1";
const APPROVE = ["cash-advance:approve"];

function baseRequest(over: Record<string, unknown> = {}) {
  return {
    id: "ca-1",
    requestNumber: 7,
    employeeId: REQUESTER,
    employee: {
      id: REQUESTER,
      name: "Emp",
      email: "emp@x.test",
      reportingTo: MANAGER,
    },
    payoutMode: "bank-transfer",
    currency: "THB",
    requestedTotal: 10000,
    status: "submitted",
    currentStepOrder: 1,
    items: [],
    approvalDecisions: [],
    entity: null,
    entityId: null,
    approver: null,
    approvedById: null,
    approvedTotal: 0,
    position: null,
    department: null,
    directManager: null,
    rejectReason: null,
    submittedAt: null,
    approvedAt: null,
    disbursedAt: null,
    disbursementProofUrl: null,
    clearedAt: null,
    requestDate: new Date("2026-05-30"),
    createdAt: new Date("2026-05-30"),
    updatedAt: new Date("2026-05-30"),
    bankName: "B",
    bankAccountNo: "1",
    bankCountry: "TH",
    swiftCode: "S",
    notes: null,
    ...over,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  update.mockImplementation((_id, _data) => Promise.resolve(baseRequest()));
  findUserById.mockResolvedValue({
    id: MANAGER,
    name: "Mgr",
    email: "mgr@x.test",
    reportingTo: null,
  });
});

describe("cashAdvanceService.submit — chain snapshot + conditions", () => {
  it("snapshots only steps whose conditions match, in order", async () => {
    findById.mockResolvedValue(
      baseRequest({ status: "draft", items: [{ id: "i1" }] }),
    );
    findApprovalSteps.mockResolvedValue([
      {
        name: "Manager",
        approverType: "manager",
        approverUserId: null,
        skipWhenSubmitterIds: [],
        onlyWhenSubmitterIds: [],
        payoutModeFilter: [],
        amountMin: null,
        amountMax: null,
      },
      // Only for big amounts (> 50000) — should be filtered out for 10000.
      {
        name: "C-Suite",
        approverType: "user",
        approverUserId: "u-cfo",
        skipWhenSubmitterIds: [],
        onlyWhenSubmitterIds: [],
        payoutModeFilter: [],
        amountMin: 50000,
        amountMax: null,
      },
      // Only for cash payouts — filtered out for bank-transfer.
      {
        name: "Cash desk",
        approverType: "user",
        approverUserId: "u-cash",
        skipWhenSubmitterIds: [],
        onlyWhenSubmitterIds: [],
        payoutModeFilter: ["cash"],
        amountMin: null,
        amountMax: null,
      },
    ]);
    await cashAdvanceService.submit("ca-1", REQUESTER);
    const rows = createDecisions.mock.calls[0][1];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ order: 1, name: "Manager" });
  });

  it("includes the high-amount step when the request clears the band", async () => {
    findById.mockResolvedValue(
      baseRequest({
        status: "draft",
        requestedTotal: 80000,
        items: [{ id: "i1" }],
      }),
    );
    findApprovalSteps.mockResolvedValue([
      {
        name: "Manager",
        approverType: "manager",
        approverUserId: null,
        skipWhenSubmitterIds: [],
        onlyWhenSubmitterIds: [],
        payoutModeFilter: [],
        amountMin: null,
        amountMax: null,
      },
      {
        name: "C-Suite",
        approverType: "user",
        approverUserId: "u-cfo",
        skipWhenSubmitterIds: [],
        onlyWhenSubmitterIds: [],
        payoutModeFilter: [],
        amountMin: 50000,
        amountMax: null,
      },
    ]);
    await cashAdvanceService.submit("ca-1", REQUESTER);
    const rows = createDecisions.mock.calls[0][1];
    expect(rows.map((r: { name: string }) => r.name)).toEqual([
      "Manager",
      "C-Suite",
    ]);
  });

  it("falls back to a single manager step when no chain is configured", async () => {
    findById.mockResolvedValue(
      baseRequest({ status: "draft", items: [{ id: "i1" }] }),
    );
    findApprovalSteps.mockResolvedValue([]);
    await cashAdvanceService.submit("ca-1", REQUESTER);
    const rows = createDecisions.mock.calls[0][1];
    expect(rows).toEqual([
      {
        order: 1,
        name: "Manager approval",
        approverType: "manager",
        approverUserId: null,
      },
    ]);
  });
});

describe("cashAdvanceService.approve — chain advance + authz", () => {
  it("advances to the next step instead of finalising when more remain", async () => {
    findById.mockResolvedValue(baseRequest({ currentStepOrder: 1 }));
    findDecisions.mockResolvedValue([
      {
        id: "d1",
        order: 1,
        status: "pending",
        approverType: "manager",
        approverUserId: null,
      },
      {
        id: "d2",
        order: 2,
        status: "pending",
        approverType: "user",
        approverUserId: "u-cfo",
      },
    ]);
    const res = await cashAdvanceService.approve("ca-1", {}, MANAGER, APPROVE);
    expect(updateDecision).toHaveBeenCalledWith(
      "d1",
      expect.objectContaining({ status: "approved" }),
    );
    expect(update).toHaveBeenCalledWith(
      "ca-1",
      expect.objectContaining({ currentStepOrder: 2 }),
    );
    // Not finalised → no status:approved write.
    expect(update.mock.calls.some((c) => c[1]?.status === "approved")).toBe(
      false,
    );
    expect(res.data).toBeDefined();
  });

  it("finalises (status approved) on the last step", async () => {
    findById.mockResolvedValue(baseRequest({ currentStepOrder: 2 }));
    findDecisions.mockResolvedValue([
      {
        id: "d1",
        order: 1,
        status: "approved",
        approverType: "manager",
        approverUserId: null,
      },
      {
        id: "d2",
        order: 2,
        status: "pending",
        approverType: "user",
        approverUserId: "u-cfo",
      },
    ]);
    await cashAdvanceService.approve("ca-1", {}, "u-cfo", APPROVE);
    expect(update.mock.calls.some((c) => c[1]?.status === "approved")).toBe(
      true,
    );
  });

  it("rejects an actor who is neither the step approver nor HR", async () => {
    findById.mockResolvedValue(baseRequest({ currentStepOrder: 1 }));
    findDecisions.mockResolvedValue([
      {
        id: "d1",
        order: 1,
        status: "pending",
        approverType: "user",
        approverUserId: "u-cfo",
      },
    ]);
    await expect(
      cashAdvanceService.approve("ca-1", {}, "someone-else", [
        "cash-advance:read",
      ]),
    ).rejects.toThrow(ForbiddenException);
  });
});

describe("cashAdvanceService.create — category + receipt persistence", () => {
  it("stores categoryId and receiptUrl on each line item", async () => {
    create.mockResolvedValue(baseRequest());
    await cashAdvanceService.create(
      {
        payoutMode: "bank-transfer",
        currency: "THB",
        items: [
          {
            description: "Flights",
            requestedAmount: 5000,
            approvedAmount: 0,
            categoryId: "cat-travel",
            receiptUrl: "https://x.test/receipts/r1.pdf",
          },
          {
            description: "Per diem",
            requestedAmount: 2000,
            approvedAmount: 0,
            categoryId: null,
            receiptUrl: null,
          },
        ],
      },
      REQUESTER,
    );

    const [data] = create.mock.calls[0];
    expect(data.items.create).toEqual([
      expect.objectContaining({
        description: "Flights",
        categoryId: "cat-travel",
        receiptUrl: "https://x.test/receipts/r1.pdf",
      }),
      expect.objectContaining({
        description: "Per diem",
        categoryId: null,
        receiptUrl: null,
      }),
    ]);
  });
});

describe("cashAdvanceService.getItemReceiptUrl — signed access", () => {
  it("returns a signed URL for the owner", async () => {
    findById.mockResolvedValue(
      baseRequest({
        items: [{ id: "it-1", receiptUrl: "https://x.test/receipts/r1.pdf" }],
      }),
    );
    const res = await cashAdvanceService.getItemReceiptUrl(
      "ca-1",
      "it-1",
      REQUESTER,
      [],
    );
    expect(res.url).toBe("signed:https://x.test/receipts/r1.pdf");
  });

  it("blocks a non-owner without read-all", async () => {
    findById.mockResolvedValue(
      baseRequest({
        items: [{ id: "it-1", receiptUrl: "https://x.test/receipts/r1.pdf" }],
      }),
    );
    await expect(
      cashAdvanceService.getItemReceiptUrl("ca-1", "it-1", "intruder", [
        "cash-advance:read",
      ]),
    ).rejects.toThrow(ForbiddenException);
  });

  it("404s when the line has no receipt", async () => {
    findById.mockResolvedValue(
      baseRequest({ items: [{ id: "it-1", receiptUrl: null }] }),
    );
    await expect(
      cashAdvanceService.getItemReceiptUrl("ca-1", "it-1", REQUESTER, []),
    ).rejects.toThrow(/no receipt/i);
  });
});

describe("cashAdvanceService.markDisbursed", () => {
  const PROOF = "https://x.test/documents/slip.pdf";

  it("requires approve permission", async () => {
    findById.mockResolvedValue(baseRequest({ status: "approved" }));
    await expect(
      cashAdvanceService.markDisbursed(
        "ca-1",
        { proofUrl: PROOF },
        "actor",
        [],
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it("stores disbursement proof and flips status", async () => {
    findById.mockResolvedValue(baseRequest({ status: "approved" }));
    update.mockImplementation((_id, data) =>
      Promise.resolve(
        baseRequest({
          status: "disbursed",
          disbursedAt: new Date(),
          disbursementProofUrl: data.disbursementProofUrl,
        }),
      ),
    );

    const res = await cashAdvanceService.markDisbursed(
      "ca-1",
      { proofUrl: PROOF },
      "finance-1",
      APPROVE,
    );

    expect(update).toHaveBeenCalledWith("ca-1", {
      status: "disbursed",
      disbursedAt: expect.any(Date),
      disbursementProofUrl: PROOF,
    });
    expect(res.data.status).toBe("disbursed");
    expect(res.data.disbursementProofUrl).toBe(PROOF);
  });

  it("rejects when request is not approved", async () => {
    findById.mockResolvedValue(baseRequest({ status: "submitted" }));
    await expect(
      cashAdvanceService.markDisbursed(
        "ca-1",
        { proofUrl: PROOF },
        "finance-1",
        APPROVE,
      ),
    ).rejects.toThrow(/only approved/i);
  });
});

describe("cashAdvanceService.withdraw — unsubmit to draft + authz", () => {
  it("reverts a submitted request to draft", async () => {
    findById.mockResolvedValue(baseRequest({ status: "submitted" }));
    update.mockResolvedValue(
      baseRequest({
        status: "draft",
        currentStepOrder: null,
        submittedAt: null,
      }),
    );
    const res = await cashAdvanceService.withdraw("ca-1", REQUESTER);
    expect(update).toHaveBeenCalledWith(
      "ca-1",
      expect.objectContaining({
        status: "draft",
        submittedAt: null,
        currentStepOrder: null,
      }),
    );
    expect(res.data.status).toBe("draft");
  });

  it("forbids unsubmitting someone else's request", async () => {
    findById.mockResolvedValue(baseRequest({ status: "submitted" }));
    await expect(
      cashAdvanceService.withdraw("ca-1", "intruder"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("rejects unsubmitting a request that is not submitted", async () => {
    findById.mockResolvedValue(baseRequest({ status: "approved" }));
    await expect(
      cashAdvanceService.withdraw("ca-1", REQUESTER),
    ).rejects.toThrow("Only submitted requests can be unsubmitted");
  });
});

describe("CashAdvanceService permanent delete (soft-delete IDOR)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("purges a soft-deleted row when the actor holds approve", async () => {
    findByIdIncludingDeleted.mockResolvedValue(
      baseRequest({ deletedAt: new Date() }),
    );
    permanentDelete.mockResolvedValue({ id: "ca-1" });

    await cashAdvanceService.permanentDelete("ca-1", APPROVE);

    expect(findByIdIncludingDeleted).toHaveBeenCalledWith("ca-1");
    expect(permanentDelete).toHaveBeenCalledWith("ca-1");
  });

  it("forbids permanent delete without approve permission", async () => {
    findByIdIncludingDeleted.mockResolvedValue(
      baseRequest({ deletedAt: new Date() }),
    );

    await expect(
      cashAdvanceService.permanentDelete("ca-1", ["cash-advance:create"]),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(permanentDelete).not.toHaveBeenCalled();
  });
});
