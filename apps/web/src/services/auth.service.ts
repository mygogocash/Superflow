import { api } from "@/lib/api-client";

// ─── Types ──────────────────────────────────────────────

export interface AuthRole {
  id: string;
  name: string;
  defaultRoute: string | null;
  /**
   * True only for the built-in roles. Distinguishes the SYSTEM Admin role from a
   * custom role somebody happened to call Admin, which is the difference between
   * a super admin and an ordinary one.
   */
  isSystem?: boolean;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  department: string | null;
  jobTitle: string | null;
  entity: { id: string; name: string; code: string } | null;
  mustChangePassword: boolean;
  /** Preferred UI language (BCP-47 primary subtag) or null to follow defaults. */
  locale: string | null;
}

// Multi-company (PRD Rule 7) — an entity the user belongs to. `roleId`
// is the stored per-company role (enforced in a later chunk).
export interface EntityMembership {
  entityId: string;
  entityName: string;
  entityCode: string;
  roleId: string | null;
  isActive: boolean;
}

interface LoginResponse {
  user: AuthUser;
  roles: AuthRole[];
  permissions: string[];
  memberships?: EntityMembership[];
  activeEntityId?: string | null;
}

interface MeResponse {
  user: AuthUser;
  roles: AuthRole[];
  permissions: string[];
  memberships?: EntityMembership[];
  activeEntityId?: string | null;
}

interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

interface LinkSessionInput {
  accessToken: string;
  refreshToken: string;
}

interface RecoverPasswordInput extends LinkSessionInput {
  newPassword: string;
}

interface AuthLinkResponse {
  success: boolean;
  message: string;
}

// ─── Service ────────────────────────────────────────────

export async function login(
  email: string,
  password: string,
): Promise<LoginResponse> {
  return api.post<LoginResponse>("/auth/login", { email, password });
}

export async function logout(): Promise<void> {
  await api.post("/auth/logout");
}

export async function getMe(): Promise<MeResponse> {
  return api.get<MeResponse>("/auth/me");
}

export async function refreshSession(): Promise<{ success: boolean }> {
  return api.post<{ success: boolean }>("/auth/refresh");
}

// Multi-company switcher (PRD Rule 7). Server validates the caller holds
// an active membership in the target entity before switching.
export async function setActiveEntity(entityId: string): Promise<{
  data: {
    activeEntityId: string;
    entity: { id: string; name: string; code: string } | null;
  };
}> {
  return api.put("/auth/active-entity", { entityId });
}

export async function changePassword(
  input: ChangePasswordInput,
): Promise<{ success: boolean }> {
  return api.post<{ success: boolean }>("/auth/change-password", input);
}

export async function requestPasswordReset(
  email: string,
): Promise<AuthLinkResponse> {
  return api.post<AuthLinkResponse>("/auth/forgot-password", { email });
}

export async function requestMagicLink(
  email: string,
): Promise<AuthLinkResponse> {
  return api.post<AuthLinkResponse>("/auth/magic-link", { email });
}

export async function recoverPassword(
  input: RecoverPasswordInput,
): Promise<LoginResponse> {
  return api.post<LoginResponse>("/auth/recover-password", input);
}

export async function exchangeSession(
  input: LinkSessionInput,
): Promise<LoginResponse> {
  return api.post<LoginResponse>("/auth/exchange-session", input);
}
