import { ALL_PERMISSION_CODES, normalizePermissionCode } from "@nexora/contracts/common/constants/permissions";
import { PERMISSIONS } from "@nexora/contracts";

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

/** Org Admin+ can manage members / org settings / org analytics. */
export function isOrgAdminRole(orgRole: OrgRole | null | undefined): boolean {
  return orgRole === "admin" || orgRole === "super_admin";
}

export function isOrgSuperAdminRole(orgRole: OrgRole | null | undefined): boolean {
  return orgRole === "super_admin";
}

/**
 * Phase-1 fixed permission packs per org role.
 * Super Admin expands to every known code (org-scoped at the service layer).
 * Admin gets elevated HR/user/admin ops; User keeps baseline employee modules.
 * Callers still union with legacy UserRole permissions during the dual-run period.
 */
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

/**
 * Merge legacy role permissions with org-role pack + platform bypass.
 * Platform admin expands to every code (same as today's System Admin spirit).
 * Org packs are additive so we never strip existing UserRole grants during rollout.
 */
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

/** Rank for promotion rules: higher can assign/revoke lower (and equal for Super Admin). */
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

/**
 * Can `actor` assign `targetRole` inside an org?
 * Platform admin: yes. Org Super Admin: any. Org Admin: user or admin (not super_admin).
 */
export function canAssignOrgRole(actor: {
  platformRole: string | null | undefined;
  orgRole: OrgRole | null | undefined;
}, targetRole: OrgRole): boolean {
  if (isPlatformAdmin(actor.platformRole)) return true;
  if (actor.orgRole === "super_admin") return true;
  if (actor.orgRole === "admin") return targetRole === "user" || targetRole === "admin";
  return false;
}

/** True when resource and actor share the same organization id. */
export function isSameOrg(
  resourceOrganizationId: string | null | undefined,
  actorActiveOrganizationId: string | null | undefined,
): boolean {
  if (!resourceOrganizationId || !actorActiveOrganizationId) return false;
  return resourceOrganizationId === actorActiveOrganizationId;
}

export class OrgScopeError extends Error {
  readonly code = "ORG_SCOPE_MISMATCH" as const;
  constructor(message = "Cross-organization access denied") {
    super(message);
    this.name = "OrgScopeError";
  }
}

/**
 * Fail-closed org-scope invariant for resources tagged with `organizationId`.
 * Callers that use HTTP exceptions should catch `OrgScopeError` and map to 403.
 */
export function assertSameOrg(
  resourceOrganizationId: string | null | undefined,
  actorActiveOrganizationId: string | null | undefined,
  message?: string,
): void {
  if (!isSameOrg(resourceOrganizationId, actorActiveOrganizationId)) {
    throw new OrgScopeError(message);
  }
}

/** Parse `ORG_TENANCY_ENFORCED` (and similar) env flags. */
export function isOrgTenancyEnforced(value: string | boolean | null | undefined): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

