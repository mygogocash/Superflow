import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenException, NotFoundException } from "../http-exception.js";

const resolveActorOrgScope = vi.fn();
const listActiveMemberUserIds = vi.fn();
const findById = vi.fn();

vi.mock("../organizations/organizations.service.js", () => ({
  resolveActorOrgScope,
  listActiveMemberUserIds,
}));

vi.mock("./repository.js", () => ({
  findById,
  findMany: vi.fn(),
  findByEmployeeId: vi.fn(),
  update: vi.fn(),
  softDelete: vi.fn(),
  restore: vi.fn(),
  stats: vi.fn(),
  formLookups: vi.fn(),
  replaceRoles: vi.fn(),
  userHasPermission: vi.fn(),
  rolesWithAdminManage: vi.fn(),
}));

const { getById, list } = await import("./service.js");

const sampleUser = {
  id: "user-b",
  email: "b@example.com",
  name: "User B",
  avatarUrl: null,
  phone: null,
  department: null,
  jobTitle: null,
  employeeId: null,
  reportingTo: null,
  employmentType: null,
  startDate: null,
  endDate: null,
  dateOfBirth: null,
  salary: null,
  currency: null,
  location: null,
  country: null,
  timezone: null,
  passportNumber: null,
  thaiId: null,
  taxId: null,
  aadhaarNumber: null,
  panCardNumber: null,
  workPermitType: null,
  visaType: null,
  permitNumber: null,
  isActive: true,
  entity: null,
  manager: null,
  roles: [],
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("users tenancy scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("getById allows platform admin any user", async () => {
    findById.mockResolvedValue(sampleUser);
    resolveActorOrgScope.mockResolvedValue({
      isPlatformAdmin: true,
      activeOrganizationId: null,
      orgRole: null,
    });
    const result = await getById({} as never, "user-b", "actor-1");
    expect(result.data.id).toBe("user-b");
    expect(listActiveMemberUserIds).not.toHaveBeenCalled();
  });

  it("getById forbids cross-org user access", async () => {
    findById.mockResolvedValue(sampleUser);
    resolveActorOrgScope.mockResolvedValue({
      isPlatformAdmin: false,
      activeOrganizationId: "org-a",
      orgRole: "user",
    });
    listActiveMemberUserIds.mockResolvedValue(["actor-1"]);
    await expect(getById({} as never, "user-b", "actor-1")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("getById allows same-org member", async () => {
    findById.mockResolvedValue(sampleUser);
    resolveActorOrgScope.mockResolvedValue({
      isPlatformAdmin: false,
      activeOrganizationId: "org-a",
      orgRole: "admin",
    });
    listActiveMemberUserIds.mockResolvedValue(["actor-1", "user-b"]);
    const result = await getById({} as never, "user-b", "actor-1");
    expect(result.data.id).toBe("user-b");
  });

  it("list throws when tenancy enforced and no active org", async () => {
    resolveActorOrgScope.mockResolvedValue({
      isPlatformAdmin: false,
      activeOrganizationId: null,
      orgRole: null,
    });
    await expect(
      list({} as never, { page: 1, limit: 10 } as never, "actor-1", {
        tenancyEnforced: true,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("list returns empty when tenancy soft and no active org", async () => {
    resolveActorOrgScope.mockResolvedValue({
      isPlatformAdmin: false,
      activeOrganizationId: null,
      orgRole: null,
    });
    const result = await list({} as never, { page: 1, limit: 10 } as never, "actor-1");
    expect(result.data).toEqual([]);
    expect(result.meta.total).toBe(0);
  });

  it("getById still 404s for missing users", async () => {
    findById.mockResolvedValue(null);
    await expect(getById({} as never, "missing")).rejects.toBeInstanceOf(NotFoundException);
  });
});
