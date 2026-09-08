import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import { PERMISSIONS } from "@/common/constants/permissions";
import {
  BadRequestException,
  ForbiddenException,
} from "@/common/exceptions/http-exception";
import { travelRepository } from "@/modules/travel/travel.repository";
import { TravelService } from "@/modules/travel/travel.service";

vi.mock("./travel.repository", () => ({
  travelRepository: {
    findUserById: vi.fn(),
    findRequests: vi.fn(),
    findRequestById: vi.fn(),
    findAllRequests: vi.fn(),
    createRequest: vi.fn(),
    updateRequest: vi.fn(),
    updateRequestStatus: vi.fn(),
    findExpensesForTravel: vi.fn(),
    findApprovalSteps: vi.fn(),
    findApprovalStepById: vi.fn(),
    createApprovalStep: vi.fn(),
    updateApprovalStep: vi.fn(),
    deleteApprovalStep: vi.fn(),
    reorderApprovalSteps: vi.fn(),
    nextStepOrder: vi.fn(),
    createDecisions: vi.fn(),
    findDecisions: vi.fn(),
    findDecisionsForRequests: vi.fn(),
    updateDecision: vi.fn(),
  },
}));

vi.mock("@/infrastructure/email/email.service", () => ({
  sendEmail: vi.fn(),
}));

vi.mock("@/common/utils/data-scope", () => ({
  resolveDataScope: vi.fn().mockResolvedValue("self"),
  buildUserScopeFilter: vi.fn().mockResolvedValue({}),
}));

const baseInput = {
  destination: "Tokyo",
  purpose: "Conference",
  departureDate: "2026-06-01",
  returnDate: "2026-06-05",
  estimatedBudget: 1000,
  currency: "USD",
  hotelRequired: false,
};

describe("TravelService — approval chain", () => {
  let svc: TravelService;

  beforeEach(() => {
    svc = new TravelService();
    vi.clearAllMocks();
    (travelRepository.findUserById as Mock).mockResolvedValue({
      id: "emp-1",
      name: "Alice",
      email: "alice@x.com",
      entityId: null,
      reportingTo: "mgr-1",
    });
    (travelRepository.createRequest as Mock).mockResolvedValue({
      id: "req-1",
    });
    (travelRepository.findRequestById as Mock).mockResolvedValue({
      id: "req-1",
      employeeId: "emp-1",
      employee: { name: "Alice", email: "alice@x.com", reportingTo: "mgr-1" },
      destination: "Tokyo",
      departureDate: new Date("2026-06-01"),
      returnDate: new Date("2026-06-05"),
      purpose: "Conference",
      status: "pending",
      currentStepOrder: 1,
    });
    (travelRepository.updateRequest as Mock).mockResolvedValue({});
    (travelRepository.updateRequestStatus as Mock).mockResolvedValue({});
    (travelRepository.updateDecision as Mock).mockResolvedValue({});
    (travelRepository.createDecisions as Mock).mockResolvedValue({ count: 0 });
  });

  describe("createRequest", () => {
    it("snapshots configured chain into per-request decisions", async () => {
      (travelRepository.findApprovalSteps as Mock).mockResolvedValue([
        {
          id: "s1",
          name: "Manager",
          approverType: "manager",
          approverUserId: null,
        },
        {
          id: "s2",
          name: "HR",
          approverType: "user",
          approverUserId: "hr-1",
        },
      ]);

      await svc.createRequest("emp-1", baseInput);

      expect(travelRepository.createDecisions).toHaveBeenCalledWith(
        "req-1",
        expect.arrayContaining([
          expect.objectContaining({
            order: 1,
            name: "Manager",
            approverType: "manager",
            approverUserId: null,
          }),
          expect.objectContaining({
            order: 2,
            name: "HR",
            approverType: "user",
            approverUserId: "hr-1",
          }),
        ]),
      );
      expect(travelRepository.updateRequest).toHaveBeenCalledWith("req-1", {
        currentStepOrder: 1,
      });
    });

    it("falls back to a single manager step when chain is empty", async () => {
      (travelRepository.findApprovalSteps as Mock).mockResolvedValue([]);

      await svc.createRequest("emp-1", baseInput);

      expect(travelRepository.createDecisions).toHaveBeenCalledWith("req-1", [
        expect.objectContaining({
          order: 1,
          name: "Manager approval",
          approverType: "manager",
          approverUserId: null,
        }),
      ]);
    });
  });

  describe("approveRequest", () => {
    it("advances to the next pending step instead of finalising", async () => {
      (travelRepository.findDecisions as Mock).mockResolvedValue([
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
          approverUserId: "hr-1",
        },
      ]);

      await svc.approveRequest("req-1", "mgr-1", []);

      expect(travelRepository.updateDecision).toHaveBeenCalledWith(
        "d1",
        expect.objectContaining({ status: "approved" }),
      );
      expect(travelRepository.updateRequest).toHaveBeenCalledWith("req-1", {
        currentStepOrder: 2,
      });
      expect(travelRepository.updateRequestStatus).not.toHaveBeenCalled();
    });

    it("finalises as approved when no more pending steps remain", async () => {
      (travelRepository.findDecisions as Mock).mockResolvedValue([
        {
          id: "d1",
          order: 1,
          status: "pending",
          approverType: "manager",
          approverUserId: null,
        },
      ]);

      await svc.approveRequest("req-1", "mgr-1", []);

      expect(travelRepository.updateRequestStatus).toHaveBeenCalledWith(
        "req-1",
        expect.objectContaining({ status: "approved", approvedBy: "mgr-1" }),
      );
    });

    it("rejects acting user who is not the assigned approver", async () => {
      (travelRepository.findDecisions as Mock).mockResolvedValue([
        {
          id: "d1",
          order: 1,
          status: "pending",
          approverType: "user",
          approverUserId: "hr-1",
        },
      ]);

      await expect(
        svc.approveRequest("req-1", "someone-else", []),
      ).rejects.toThrow(ForbiddenException);
    });

    it("HR approver bypasses the per-step assignment check", async () => {
      (travelRepository.findDecisions as Mock).mockResolvedValue([
        {
          id: "d1",
          order: 1,
          status: "pending",
          approverType: "user",
          approverUserId: "hr-1",
        },
      ]);

      await svc.approveRequest("req-1", "hr-admin", [
        PERMISSIONS.TRAVEL_HR_APPROVE,
      ]);

      expect(travelRepository.updateDecision).toHaveBeenCalled();
    });
  });

  describe("rejectRequest", () => {
    it("marks the current decision rejected and finalises the request", async () => {
      (travelRepository.findDecisions as Mock).mockResolvedValue([
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
          approverUserId: "hr-1",
        },
      ]);

      await svc.rejectRequest("req-1", "mgr-1", "Out of policy", []);

      expect(travelRepository.updateDecision).toHaveBeenCalledWith(
        "d1",
        expect.objectContaining({
          status: "rejected",
          notes: "Out of policy",
        }),
      );
      expect(travelRepository.updateRequestStatus).toHaveBeenCalledWith(
        "req-1",
        expect.objectContaining({
          status: "rejected",
          rejectReason: "Out of policy",
        }),
      );
    });

    it("refuses to reject a request that is not pending", async () => {
      (travelRepository.findRequestById as Mock).mockResolvedValueOnce({
        id: "req-1",
        employeeId: "emp-1",
        employee: { name: "A", email: "a@x.com", reportingTo: "mgr-1" },
        destination: "Tokyo",
        departureDate: new Date(),
        returnDate: new Date(),
        purpose: "x",
        status: "approved",
        currentStepOrder: 1,
      });

      await expect(
        svc.rejectRequest("req-1", "mgr-1", "no", []),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("getRequestById — Wave 8 view scope", () => {
    beforeEach(() => {
      // Non-pending avoids attachViewerCanAct's Prisma decision lookup;
      // assertCanViewTravelRequest still checks manager/approver via the repo.
      (travelRepository.findRequestById as Mock).mockResolvedValue({
        id: "req-1",
        employeeId: "emp-1",
        employee: { name: "Alice", email: "alice@x.com", reportingTo: "mgr-1" },
        destination: "Tokyo",
        departureDate: new Date("2026-06-01"),
        returnDate: new Date("2026-06-05"),
        purpose: "Conference",
        status: "approved",
        currentStepOrder: 1,
      });
      (travelRepository.findDecisions as Mock).mockResolvedValue([]);
      (travelRepository.findDecisionsForRequests as Mock).mockResolvedValue([]);
    });

    it("allows the direct manager to open a report's request", async () => {
      await expect(
        svc.getRequestById("req-1", "mgr-1", [PERMISSIONS.TRAVEL_READ]),
      ).resolves.toMatchObject({ id: "req-1" });
    });

    it("allows an assigned approver who is not the manager", async () => {
      (travelRepository.findDecisions as Mock).mockResolvedValue([
        {
          id: "d1",
          order: 1,
          status: "approved",
          approverType: "user",
          approverUserId: "approver-9",
        },
      ]);

      await expect(
        svc.getRequestById("req-1", "approver-9", [PERMISSIONS.TRAVEL_READ]),
      ).resolves.toMatchObject({ id: "req-1" });
    });

    it("forbids an unrelated coworker", async () => {
      await expect(
        svc.getRequestById("req-1", "stranger", [PERMISSIONS.TRAVEL_READ]),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
