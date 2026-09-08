import { describe, expect, it } from "vitest";

import {
  canAssignOrgRole,
  isPlatformAdmin,
  mergeOrgAwarePermissions,
  orgRolePermissionCodes,
  orgRoleRank,
} from "@/modules/auth/org-rbac";

describe("org-rbac (api mirror)", () => {
  it("ranks super_admin above admin and user", () => {
    expect(orgRoleRank("super_admin")).toBeGreaterThan(orgRoleRank("admin"));
    expect(orgRoleRank("admin")).toBeGreaterThan(orgRoleRank("user"));
  });

  it("lets super_admin assign admin but not the reverse", () => {
    expect(
      canAssignOrgRole({ platformRole: null, orgRole: "super_admin" }, "admin"),
    ).toBe(true);
    expect(
      canAssignOrgRole({ platformRole: null, orgRole: "admin" }, "super_admin"),
    ).toBe(false);
  });

  it("treats platform_admin as platform admin", () => {
    expect(isPlatformAdmin("platform_admin")).toBe(true);
    expect(isPlatformAdmin("platform_operator")).toBe(false);
    expect(isPlatformAdmin(null)).toBe(false);
  });

  it("merges platform bypass over legacy packs", () => {
    const codes = mergeOrgAwarePermissions({
      legacyPermissionCodes: ["leave:read"],
      platformRole: "platform_admin",
      orgRole: "user",
    });
    expect(codes.length).toBeGreaterThan(10);
    expect(codes).toEqual(expect.arrayContaining(["leave:read"]));
  });

  it("exposes org-role packs as additive codes", () => {
    expect(orgRolePermissionCodes("user").length).toBeGreaterThan(0);
    expect(orgRolePermissionCodes("super_admin").length).toBeGreaterThan(
      orgRolePermissionCodes("user").length,
    );
  });
});
