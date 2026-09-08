const EXPRESS_DEV = "http://localhost:3001";
const EXPO_DEV_PORTS = new Set(["8081", "19006", "8082"]);

function isExpoDevOrigin(origin: string): boolean {
  try {
    return EXPO_DEV_PORTS.has(new URL(origin).port);
  } catch {
    return false;
  }
}

/** Express :3001 by default. Set EXPO_PUBLIC_APP_URL to the Worker (:8787) for edge. */
export function getAppUrl(): string {
  const fromEnv =
    typeof process !== "undefined"
      ? (process.env.EXPO_PUBLIC_APP_URL as string | undefined)
      : undefined;
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  if (typeof globalThis !== "undefined" && "location" in globalThis) {
    const loc = (globalThis as { location?: { origin?: string } }).location;
    if (loc?.origin && !isExpoDevOrigin(loc.origin)) return loc.origin;
  }
  return EXPRESS_DEV;
}

/**
 * Edge / staging / production Workers speak Better Auth (`/api/auth/*`).
 * Local Express (`:3001`) still uses JWT `/auth/login` + Bearer.
 * Same-origin SPA on manut.xyz / staging.manut.xyz → Better Auth + cookies.
 */
export function usesBetterAuth(): boolean {
  try {
    const { hostname, port } = new URL(getAppUrl());
    if (hostname === "localhost" || hostname === "127.0.0.1") {
      return port === "8787";
    }
    return true;
  } catch {
    return false;
  }
}
