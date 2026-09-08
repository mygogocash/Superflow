import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenException } from "../http-exception.js";

const upsertSettings = vi.fn();
const findAllSettings = vi.fn();
const findModuleAccessByUser = vi.fn();
const upsertModuleAccess = vi.fn();
const assertActorCanAccessUser = vi.fn();

vi.mock("./admin.repository.js", () => ({
  upsertSettings: (...args: unknown[]) => upsertSettings(...args),
  findAllSettings: (...args: unknown[]) => findAllSettings(...args),
  findModuleAccessByUser: (...args: unknown[]) => findModuleAccessByUser(...args),
  upsertModuleAccess: (...args: unknown[]) => upsertModuleAccess(...args),
  findAuditLogs: vi.fn(),
  findUserGroups: vi.fn(),
  findUserGroupById: vi.fn(),
  createUserGroup: vi.fn(),
  updateUserGroup: vi.fn(),
  deleteUserGroup: vi.fn(),
  addGroupMembers: vi.fn(),
  removeGroupMembers: vi.fn(),
  findDepartments: vi.fn(),
  createDepartment: vi.fn(),
  updateDepartment: vi.fn(),
  deleteDepartment: vi.fn(),
}));

vi.mock("../users/service.js", () => ({
  assertActorCanAccessUser: (...args: unknown[]) => assertActorCanAccessUser(...args),
}));

const selectLimit = vi.fn();
const selectWhere = vi.fn(() => ({ limit: selectLimit }));
const selectFrom = vi.fn(() => ({ where: selectWhere }));
const db = { select: vi.fn(() => ({ from: selectFrom })) } as never;

const { updateSettings, getModuleAccess, updateModuleAccess } = await import("./admin.service.js");

describe("admin.service security gates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findAllSettings.mockResolvedValue([]);
    selectLimit.mockResolvedValue([{ id: "user-1" }]);
    findModuleAccessByUser.mockResolvedValue([]);
    upsertModuleAccess.mockResolvedValue(undefined);
    assertActorCanAccessUser.mockResolvedValue(undefined);
  });

  it("rejects security.* settings writes without system admin", async () => {
    await expect(
      updateSettings(
        db,
        { settings: [{ key: "security.sessionTimeoutMinutes", value: 30 }] },
        { isSystemAdmin: false },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(upsertSettings).not.toHaveBeenCalled();
  });

  it("allows security.* settings writes for system admin", async () => {
    upsertSettings.mockResolvedValue(undefined);
    await updateSettings(
      db,
      { settings: [{ key: "security.sessionTimeoutMinutes", value: 30 }] },
      { isSystemAdmin: true },
    );
    expect(upsertSettings).toHaveBeenCalled();
  });

  it("scopes module-access reads through assertActorCanAccessUser", async () => {
    await getModuleAccess(db, "user-1", "actor-1");
    expect(assertActorCanAccessUser).toHaveBeenCalledWith(db, "actor-1", "user-1");
  });

  it("scopes module-access writes through assertActorCanAccessUser", async () => {
    await updateModuleAccess(
      db,
      { userId: "user-1", modules: [{ moduleId: "crm", granted: true }] },
      "actor-1",
    );
    expect(assertActorCanAccessUser).toHaveBeenCalledWith(db, "actor-1", "user-1");
  });
});
