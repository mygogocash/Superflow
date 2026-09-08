"use client";

import { useRouter } from "nextjs-toploader/app";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import { trackSessionEnded, trackSessionStarted } from "@/lib/events";
import { tracking } from "@/lib/tracking";
import { applyUserLocale } from "@/providers/i18n-provider";
import type {
  AuthRole,
  AuthUser,
  EntityMembership,
} from "@/services/auth.service";
import * as authService from "@/services/auth.service";
import { unsubscribeAllDevices } from "@/services/push.service";

const REFRESH_INTERVAL_MS = 4 * 60 * 1000; // 4 minutes

interface AuthState {
  user: AuthUser | null;
  roles: AuthRole[];
  permissions: string[];
  // Multi-company (PRD Rule 7). Empty for single-company users.
  memberships: EntityMembership[];
  activeEntityId: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
}

interface AuthContextType extends AuthState {
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  hasPermission: (code: string) => boolean;
  hasAnyPermission: (...codes: string[]) => boolean;
  hasRole: (name: string) => boolean;
  /**
   * Is this the system Admin role, rather than a custom role of the same name?
   *
   * For hiding controls that only a super admin may use. The API enforces the
   * same rule independently — this exists so the UI does not offer something that
   * would be refused.
   */
  isSystemAdmin: boolean;
  isEmployeeOnly: boolean;
  refreshUser: () => Promise<void>;
  // Switch the active company, then re-pull /me. No-op enforcement yet.
  switchEntity: (entityId: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

/**
 * The path `ProtectedRoute` parked in `?redirect=`, if it is safe to use.
 *
 * Only same-origin absolute paths are accepted. A value like
 * `//evil.example.com` or `https://evil.example.com` is a protocol-relative or
 * absolute URL that the browser would treat as another origin, so it is
 * rejected, an open redirect on the sign-in page is a phishing primitive.
 */
function safeRedirectTarget(): string | null {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("redirect");
  if (!raw) return null;
  let target: string;
  try {
    target = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!target.startsWith("/")) return null; // not a relative path
  if (target.startsWith("//")) return null; // protocol-relative -> other origin
  if (target.startsWith("/sign-in")) return null; // no bounce loops
  return target;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<AuthState>({
    user: null,
    roles: [],
    permissions: [],
    memberships: [],
    activeEntityId: null,
    isLoading: true,
    isAuthenticated: false,
  });
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const identifiedUserRef = useRef<string | null>(null);
  const sessionStartedAtRef = useRef<number | null>(null);

  const refreshUser = useCallback(async () => {
    try {
      const result = await authService.getMe();
      setState({
        user: result.user,
        roles: result.roles ?? [],
        permissions: result.permissions ?? [],
        memberships: result.memberships ?? [],
        activeEntityId: result.activeEntityId ?? null,
        isLoading: false,
        isAuthenticated: true,
      });

      // The server-stored language preference is authoritative, so it follows
      // the user across devices. Applied here (not just from localStorage) on
      // every /me refresh; no-op when it already matches.
      applyUserLocale(result.user.locale);

      const roles = result.roles ?? [];
      const employeeOnly =
        roles.length > 0 && roles.every((r) => r.name === "Employee");

      tracking.identify(result.user.id, {
        email: result.user.email,
        name: result.user.name,
        entity_id: result.user.entity?.id ?? null,
        entity_code: result.user.entity?.code ?? null,
        department: result.user.department ?? null,
        job_title: result.user.jobTitle ?? null,
        roles: roles.map((r) => r.name).join(","),
        is_employee_only: employeeOnly,
      });

      if (result.user.entity) {
        tracking.group("entity", result.user.entity.id, {
          code: result.user.entity.code,
          name: result.user.entity.name,
        });
      }

      // Fire session.started exactly once per identified user per page load.
      // refreshUser runs on mount, on visibility-return, and on the periodic
      // timer — guarding on identifiedUserRef stops it from re-firing.
      if (identifiedUserRef.current !== result.user.id) {
        identifiedUserRef.current = result.user.id;
        sessionStartedAtRef.current = Date.now();
        trackSessionStarted({ source: "token_refresh" });
      }
    } catch {
      setState({
        user: null,
        roles: [],
        permissions: [],
        memberships: [],
        activeEntityId: null,
        isLoading: false,
        isAuthenticated: false,
      });
      if (identifiedUserRef.current !== null) {
        identifiedUserRef.current = null;
        tracking.reset();
      }
    }
  }, []);

  // Switch the active company, then re-pull /me so the new selection (and
  // any future per-entity gating) is reflected in React state. Errors
  // bubble to the caller so the switcher can surface a toast.
  const switchEntity = useCallback(
    async (entityId: string) => {
      await authService.setActiveEntity(entityId);
      await refreshUser();
    },
    [refreshUser],
  );

  const startRefreshTimer = useCallback(() => {
    if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);

    // Refresh both the Supabase JWT (cheap keepalive) AND the cached
    // /me payload (roles + permissions). Without the /me call, an admin
    // granting a new role to a logged-in user has no effect on that
    // user's React state until they fully reload — sidebar modules tied
    // to the new permission stay hidden.
    refreshTimerRef.current = setInterval(() => {
      authService.refreshSession().catch(() => {});
      void refreshUser();
    }, REFRESH_INTERVAL_MS);
  }, [refreshUser]);

  const stopRefreshTimer = useCallback(() => {
    if (refreshTimerRef.current) {
      clearInterval(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    void refreshUser();
  }, [refreshUser]);

  useEffect(() => {
    if (state.isAuthenticated) {
      startRefreshTimer();
    } else {
      stopRefreshTimer();
    }
    return stopRefreshTimer;
  }, [state.isAuthenticated, startRefreshTimer, stopRefreshTimer]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && state.isAuthenticated) {
        authService.refreshSession().catch(() => {});
        // Pull /me on tab return so a user whose role was just changed
        // sees the new sidebar / route guards as soon as they switch
        // back to the app.
        void refreshUser();
        startRefreshTimer();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [state.isAuthenticated, startRefreshTimer, refreshUser]);

  const login = async (email: string, password: string) => {
    const result = await authService.login(email, password);

    const loginRoles = result.roles ?? [];
    const loginPermissions = result.permissions ?? [];

    setState({
      user: result.user,
      roles: loginRoles,
      permissions: loginPermissions,
      memberships: result.memberships ?? [],
      activeEntityId: result.activeEntityId ?? null,
      isLoading: false,
      isAuthenticated: true,
    });

    const employeeOnlyAtLogin =
      loginRoles.length > 0 && loginRoles.every((r) => r.name === "Employee");

    tracking.identify(result.user.id, {
      email: result.user.email,
      name: result.user.name,
      entity_id: result.user.entity?.id ?? null,
      entity_code: result.user.entity?.code ?? null,
      department: result.user.department ?? null,
      job_title: result.user.jobTitle ?? null,
      roles: loginRoles.map((r) => r.name).join(","),
      is_employee_only: employeeOnlyAtLogin,
    });

    if (result.user.entity) {
      tracking.group("entity", result.user.entity.id, {
        code: result.user.entity.code,
        name: result.user.entity.name,
      });
    }

    identifiedUserRef.current = result.user.id;
    sessionStartedAtRef.current = Date.now();
    trackSessionStarted({ source: "login" });
    if (result.user.mustChangePassword) {
      router.push("/change-password");
    } else {
      // Everyone with full-staff access lands on the Home dashboard
      // regardless of their role's stored defaultRoute. Employee-only
      // accounts stay on their portal — they have no Home in the
      // sidebar and the dashboard guard would bounce them anyway.
      const onlyEmployee =
        loginRoles.length > 0 && loginRoles.every((r) => r.name === "Employee");
      const home = onlyEmployee ? "/my-portal" : "/dashboard";
      // `ProtectedRoute` parks the page you were trying to reach in
      // `?redirect=`. Honour it, so a deep link from an approval email
      // survives the sign-in bounce instead of dumping you on Home.
      router.push(safeRedirectTarget() ?? home);
    }
  };

  const logout = async () => {
    // Drop this device's push subscriptions BEFORE the session goes, since the
    // call needs the cookie. Otherwise a shared or handed-on laptop keeps
    // delivering the previous person's notifications and they have no way to
    // revoke it. Best-effort and non-blocking: a failure here must never stop
    // somebody logging out.
    try {
      await unsubscribeAllDevices();
    } catch {
      // ignore — push cleanup is not worth failing a logout over
    }

    try {
      await authService.logout();
    } catch {
      // ignore
    }
    setState({
      user: null,
      roles: [],
      permissions: [],
      memberships: [],
      activeEntityId: null,
      isLoading: false,
      isAuthenticated: false,
    });
    identifiedUserRef.current = null;
    const startedAt = sessionStartedAtRef.current;
    sessionStartedAtRef.current = null;
    trackSessionEnded(
      startedAt
        ? { duration_seconds: Math.round((Date.now() - startedAt) / 1000) }
        : {},
    );
    tracking.reset();
    router.push("/sign-in");
  };

  const hasPermission = (code: string) =>
    (state.permissions ?? []).includes(code);
  const hasAnyPermission = (...codes: string[]) =>
    codes.some((c) => (state.permissions ?? []).includes(c));
  const hasRole = (name: string) =>
    (state.roles ?? []).some((r) => r.name === name);

  const isSystemAdmin = (state.roles ?? []).some(
    (r) => r.isSystem === true && r.name === "Admin",
  );

  const roles = state.roles ?? [];
  const isEmployeeOnly =
    roles.length > 0 && roles.every((r) => r.name === "Employee");

  return (
    <AuthContext.Provider
      value={{
        ...state,
        login,
        logout,
        hasPermission,
        hasAnyPermission,
        hasRole,
        isSystemAdmin,
        isEmployeeOnly,
        refreshUser,
        switchEntity,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}
