import {
  ALL_PERMISSION_CODES,
  normalizePermissionCode,
  PERMISSIONS,
} from "@/common/constants/permissions";

/** Per-organization membership roles (docs/ORG_TENANCY_RBAC_PLAN.md). */
export const ORG_ROLES = ["user", "admin", "super_admin"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

/** Manut-team cross-org roles on `users.platform_role`. */
export const PLATFORM_ROLES = ["platform_admin", "platform_operator"] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const HOME_ORG_SLUG = "manut";
export const HOME_ORG_ID = "org_manut_home";

export function isOrgRole(value: string | null | undefined): value is OrgRole {
  return value != null && (ORG_ROLES as readonly string[]).includes(value);
}

export function isPlatformRole(value: string | null | undefined): value is PlatformRole {
  return value != null && (PLATFORM_ROLES as readonly string[]).includes(value);
}

export function isPlatformAdmin(platformRole: string | null | undefined): boolean {
  return platformRole === "platform_admin";
}

export function isPlatformOperator(platformRole: string | null | undefined): boolean {
  return platformRole === "platform_operator" || platformRole === "platform_admin";
}

export function isOrgAdminRole(orgRole: OrgRole | null | undefined): boolean {
  return orgRole === "admin" || orgRole === "super_admin";
}

export function isOrgSuperAdminRole(orgRole: OrgRole | null | undefined): boolean {
  return orgRole === "super_admin";
}

const ORG_USER_PACK: readonly string[] = [
  PERMISSIONS.LEAVE_READ,
  PERMISSIONS.LEAVE_REQUEST,
  PERMISSIONS.EXPENSE_READ,
  PERMISSIONS.EXPENSE_CREATE,
  PERMISSIONS.TRAVEL_READ,
  PERMISSIONS.TRAVEL_REQUEST,
  PERMISSIONS.CASH_ADVANCE_READ,
  PERMISSIONS.CASH_ADVANCE_CREATE,
  PERMISSIONS.USER_READ,
  PERMISSIONS.DIRECTORY_READ,
];

const ORG_ADMIN_PACK: readonly string[] = [
  ...ORG_USER_PACK,
  PERMISSIONS.USER_CREATE,
  PERMISSIONS.USER_UPDATE,
  PERMISSIONS.USER_ASSIGN_ROLE,
  PERMISSIONS.LEAVE_HR_READ,
  PERMISSIONS.LEAVE_APPROVE,
  PERMISSIONS.EXPENSE_HR_READ,
  PERMISSIONS.EXPENSE_APPROVE,
  PERMISSIONS.TRAVEL_HR_READ,
  PERMISSIONS.TRAVEL_APPROVE,
  PERMISSIONS.CASH_ADVANCE_APPROVE,
  PERMISSIONS.ADMIN_USAGE_REPORT,
  PERMISSIONS.ADMIN_MANAGE,
];

export function orgRolePermissionCodes(orgRole: OrgRole | null | undefined): string[] {
  if (!orgRole) return [];
  if (orgRole === "super_admin") {
    return ALL_PERMISSION_CODES.map(normalizePermissionCode);
  }
  if (orgRole === "admin") {
    return [...new Set(ORG_ADMIN_PACK.map(normalizePermissionCode))];
  }
  return [...new Set(ORG_USER_PACK.map(normalizePermissionCode))];
}

export function mergeOrgAwarePermissions(input: {
  legacyPermissionCodes: readonly string[];
  orgRole: OrgRole | null | undefined;
  platformRole: string | null | undefined;
}): string[] {
  if (isPlatformAdmin(input.platformRole)) {
    return ALL_PERMISSION_CODES.map(normalizePermissionCode);
  }
  const set = new Set<string>();
  for (const code of input.legacyPermissionCodes) set.add(normalizePermissionCode(code));
  for (const code of orgRolePermissionCodes(input.orgRole)) set.add(code);
  return [...set];
}

export function orgRoleRank(orgRole: OrgRole): number {
  switch (orgRole) {
    case "user":
      return 1;
    case "admin":
      return 2;
    case "super_admin":
      return 3;
    default: {
      const _exhaustive: never = orgRole;
      return _exhaustive;
    }
  }
}

export function canAssignOrgRole(
  actor: {
    platformRole: string | null | undefined;
    orgRole: OrgRole | null | undefined;
  },
  targetRole: OrgRole,
): boolean {
  if (isPlatformAdmin(actor.platformRole)) return true;
  if (actor.orgRole === "super_admin") return true;
  if (actor.orgRole === "admin") return targetRole === "user" || targetRole === "admin";
  return false;
}
