export { createAuth, kvSecondaryStorage, parseMagicLinkAllowedRoles } from "./server";
export type { Auth, AuthEnv, AuthEmailSender, SecondaryStorage, SessionUser } from "./server";
export { createAuthClientForApp } from "./client";
export type { AuthClient, AuthClientOptions } from "./client";
export {
  resolvePermissions,
  loadUserPermissions,
  countActiveDirectReports,
  isSystemAdmin,
  SYSTEM_ADMIN_ROLE,
} from "./rbac";
export type { RoleRow } from "./rbac";
export {
  ORG_ROLES,
  PLATFORM_ROLES,
  HOME_ORG_SLUG,
  HOME_ORG_ID,
  isOrgRole,
  isPlatformRole,
  isPlatformAdmin,
  isPlatformOperator,
  isOrgAdminRole,
  isOrgSuperAdminRole,
  orgRolePermissionCodes,
  mergeOrgAwarePermissions,
  orgRoleRank,
  canAssignOrgRole,
  isSameOrg,
  assertSameOrg,
  OrgScopeError,
  isOrgTenancyEnforced,
} from "./org-rbac";
export type { OrgRole, PlatformRole } from "./org-rbac";
export { isMagicLinkEligible } from "./magic-link";
export type { MagicLinkRole } from "./magic-link";
export { applyManagerImplicitPerms, MANAGER_IMPLICIT_PERMS } from "./manager-implicit-perms";
