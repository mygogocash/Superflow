import { describe, expect, it } from "vitest";
import {
  canAssignOrgRole,
  isPlatformAdmin,
  mergeOrgAwarePermissions,
  orgRolePermissionCodes,
  orgRoleRank,
} from "./org-rbac";

describe("org-rbac", () => {
  it("treats only platform_admin as platform admin", () => {
    expect(isPlatformAdmin("platform_admin")).toBe(true);
    expect(isPlatformAdmin("platform_operator")).toBe(false);
    expect(isPlatformAdmin(null)).toBe(false);
  });

  it("expands org super_admin pack beyond user pack", () => {
    const user = orgRolePermissionCodes("user");
    const admin = orgRolePermissionCodes("admin");
    const superAdmin = orgRolePermissionCodes("super_admin");
    expect(admin.length).toBeGreaterThan(user.length);
    expect(superAdmin.length).toBeGreaterThan(admin.length);
    expect(user).toContain("leave:read");
    expect(admin).toContain("user:create");
  });

  it("platform admin merge expands to full catalog", () => {
    const perms = mergeOrgAwarePermissions({
      legacyPermissionCodes: ["leave:read"],
      orgRole: "user",
      platformRole: "platform_admin",
    });
    expect(perms.length).toBeGreaterThan(50);
  });

  it("unions legacy + org pack without platform bypass", () => {
    const perms = mergeOrgAwarePermissions({
      legacyPermissionCodes: ["crm:read"],
      orgRole: "user",
      platformRole: null,
    });
    expect(perms).toContain("crm:read");
    expect(perms).toContain("leave:read");
  });

  it("ranks and gates org role assignment", () => {
    expect(orgRoleRank("super_admin")).toBeGreaterThan(orgRoleRank("admin"));
    expect(canAssignOrgRole({ platformRole: "platform_admin", orgRole: null }, "super_admin")).toBe(true);
    expect(canAssignOrgRole({ platformRole: null, orgRole: "admin" }, "super_admin")).toBe(false);
    expect(canAssignOrgRole({ platformRole: null, orgRole: "admin" }, "user")).toBe(true);
    expect(canAssignOrgRole({ platformRole: null, orgRole: "user" }, "admin")).toBe(false);
  });
});
