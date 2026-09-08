import { getAppUrl, usesBetterAuth } from "./env";
import {
  clearSession,
  getAccessToken,
  getRefreshToken,
  isSessionPersistent,
  saveSession,
  type ExpoSession,
} from "./session";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function apiUrl(path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  if (path.startsWith("http")) return path;
  return `${getAppUrl()}/api${suffix}`;
}

function applyAuthHeaders(headers: Headers): void {
  headers.set("X-Client", "expo");
  const token = getAccessToken();
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }
}

let refreshInFlight: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  // Better Auth sessions are cookie + session-token; no Express /auth/refresh.
  if (usesBetterAuth()) return false;
  if (refreshInFlight) return refreshInFlight;
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;

  refreshInFlight = (async () => {
    const res = await fetch(apiUrl("/auth/refresh"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client": "expo",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) {
      clearSession();
      return false;
    }
    const body = (await res.json()) as { session?: ExpoSession };
    if (!body.session?.accessToken || !body.session.refreshToken) {
      clearSession();
      return false;
    }
    saveSession(body.session, isSessionPersistent());
    return true;
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

export async function apiRequest(path: string, init: RequestInit = {}, isRetry = false): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  const method = init.method?.toUpperCase() ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    headers.set("X-Requested-With", "XMLHttpRequest");
  }
  applyAuthHeaders(headers);

  const res = await fetch(apiUrl(path), {
    ...init,
    headers,
    // Same-origin SPA + Better Auth cookies; harmless for Express Bearer too.
    credentials: init.credentials ?? "include",
  });
  if (
    res.status === 401 &&
    !isRetry &&
    !usesBetterAuth() &&
    !path.includes("/auth/login") &&
    !path.includes("/auth/refresh")
  ) {
    const ok = await refreshAccessToken();
    if (ok) return apiRequest(path, init, true);
  }
  return res;
}

async function parseJson<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const raw = await res.text();
  const body = raw.trim() ? (JSON.parse(raw) as unknown) : {};
  if (!res.ok) {
    const err =
      body && typeof body === "object" && "error" in body
        ? (body as { error?: { code?: string; message?: string } }).error
        : undefined;
    throw new ApiError(
      res.status,
      err?.code ?? "UNKNOWN",
      err?.message ?? `HTTP ${res.status}`,
    );
  }
  return body as T;
}

export const api = {
  request: apiRequest,
  async get<T>(path: string): Promise<T> {
    return parseJson<T>(await apiRequest(path, { method: "GET" }));
  },
  async post<T>(path: string, body?: unknown): Promise<T> {
    return parseJson<T>(
      await apiRequest(path, {
        method: "POST",
        body: body != null ? JSON.stringify(body) : undefined,
      }),
    );
  },
  async put<T>(path: string, body?: unknown): Promise<T> {
    return parseJson<T>(
      await apiRequest(path, {
        method: "PUT",
        body: body != null ? JSON.stringify(body) : undefined,
      }),
    );
  },
};
