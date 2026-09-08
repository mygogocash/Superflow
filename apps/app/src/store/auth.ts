import { create } from "zustand";
import { authClient } from "@/lib/auth-client";
import { api, ApiError } from "@/lib/api-client";
import { usesBetterAuth } from "@/lib/env";
import { clearSession, loadSession, saveSession, type ExpoSession } from "@/lib/session";

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string | null;
  mustChangePassword?: boolean;
  platformRole?: string | null;
  lineLinked?: boolean;
};

type AuthRole = { id: string; name: string; isSystem: boolean; defaultRoute: string | null };

type OrgMembership = {
  organizationId: string;
  orgRole: "user" | "admin" | "super_admin";
  isActive: boolean;
  organization: { id: string; name: string; slug: string; status: string };
};

type AuthState = {
  user: AuthUser | null;
  roles: AuthRole[];
  permissions: string[];
  isSystemAdmin: boolean;
  isEmployeeOnly: boolean;
  memberships: Array<{ entityId: string; entity: { id: string; name: string; code: string } }>;
  activeEntityId: string | null;
  organizationMemberships: OrgMembership[];
  activeOrganizationId: string | null;
  orgRole: OrgMembership["orgRole"] | null;
  setSession: (payload: {
    user: AuthUser | null;
    roles?: AuthRole[];
    permissions?: string[];
    isSystemAdmin?: boolean;
    memberships?: AuthState["memberships"];
    activeEntityId?: string | null;
    organizationMemberships?: OrgMembership[];
    activeOrganizationId?: string | null;
    orgRole?: OrgMembership["orgRole"] | null;
  }) => void;
  hasPermission: (code: string) => boolean;
  hasRole: (name: string) => boolean;
  login: (email: string, password: string, remember?: boolean) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  clear: () => void;
};

const empty = {
  user: null as AuthUser | null,
  roles: [] as AuthRole[],
  permissions: [] as string[],
  isSystemAdmin: false,
  isEmployeeOnly: false,
  memberships: [] as AuthState["memberships"],
  activeEntityId: null as string | null,
  organizationMemberships: [] as OrgMembership[],
  activeOrganizationId: null as string | null,
  orgRole: null as OrgMembership["orgRole"] | null,
};

type MeResponse = {
  user: AuthUser;
  roles: AuthRole[];
  permissions: string[];
  memberships?: AuthState["memberships"];
  activeEntityId?: string | null;
  organizationMemberships?: OrgMembership[];
  activeOrganizationId?: string | null;
  orgRole?: OrgMembership["orgRole"] | null;
  session?: ExpoSession;
};

function applyMe(get: () => AuthState, data: MeResponse) {
  const isSystemAdmin = data.roles.some((r) => r.isSystem && r.name === "Admin");
  get().setSession({
    user: data.user,
    roles: data.roles,
    permissions: data.permissions,
    isSystemAdmin,
    memberships: data.memberships ?? [],
    activeEntityId: data.activeEntityId ?? null,
    organizationMemberships: data.organizationMemberships ?? [],
    activeOrganizationId: data.activeOrganizationId ?? null,
    orgRole: data.orgRole ?? null,
  });
}

function baErrorMessage(error: { message?: string | null; statusText?: string } | null | undefined): string {
  return error?.message || error?.statusText || "Sign-in failed";
}

async function loginWithBetterAuth(
  get: () => AuthState,
  email: string,
  password: string,
  remember: boolean,
): Promise<void> {
  const { data, error } = await authClient.signIn.email({
    email,
    password,
    rememberMe: remember,
  });
  if (error) throw new Error(baErrorMessage(error));
  const token = data?.token;
  if (!token) throw new Error("Sign-in did not return a session token");
  // Better Auth session token works as Bearer; refresh is cookie/session based.
  saveSession({ accessToken: token, refreshToken: token }, remember);
  const me = await api.get<MeResponse>("/auth/me");
  applyMe(get, me);
}

async function loginWithExpressJwt(
  get: () => AuthState,
  email: string,
  password: string,
  remember: boolean,
): Promise<void> {
  const data = await api.post<MeResponse>("/auth/login", { email, password });
  if (!data.session?.accessToken || !data.session.refreshToken) {
    throw new Error("Sign-in did not return a session");
  }
  saveSession(data.session, remember);
  applyMe(get, data);
}

export const useAuth = create<AuthState>((set, get) => ({
  ...empty,
  setSession: ({
    user,
    roles = [],
    permissions = [],
    isSystemAdmin = false,
    memberships = [],
    activeEntityId = null,
    organizationMemberships = [],
    activeOrganizationId = null,
    orgRole = null,
  }) => {
    const isEmployeeOnly = roles.length > 0 && roles.every((r) => r.name === "Employee");
    set({
      user,
      roles,
      permissions,
      isSystemAdmin,
      memberships,
      activeEntityId,
      organizationMemberships,
      activeOrganizationId,
      orgRole,
      isEmployeeOnly,
    });
  },
  hasPermission: (code) => get().isSystemAdmin || get().permissions.includes(code),
  hasRole: (name) => get().roles.some((r) => r.name === name),
  clear: () => {
    clearSession();
    set(empty);
  },
  login: async (email, password, remember = true) => {
    if (usesBetterAuth()) {
      await loginWithBetterAuth(get, email, password, remember);
      return;
    }
    await loginWithExpressJwt(get, email, password, remember);
  },
  logout: async () => {
    try {
      if (usesBetterAuth()) {
        await authClient.signOut();
      } else {
        await api.post("/auth/logout");
      }
    } catch {
      // still clear local session
    }
    get().clear();
  },
  refreshUser: async () => {
    // No stored session — skip the probe so a fresh visit doesn't log a
    // predictable 401 in the browser console.
    if (!loadSession()) {
      get().clear();
      return;
    }
    try {
      const data = await api.get<MeResponse>("/auth/me");
      applyMe(get, data);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        get().clear();
        return;
      }
      throw e;
    }
  },
}));
