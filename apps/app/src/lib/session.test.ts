import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearSession,
  getAccessToken,
  isSessionPersistent,
  loadSession,
  resetSessionForTests,
  saveSession,
} from "./session";

function memoryStore(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (key) => {
      map.delete(key);
    },
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

describe("session persist", () => {
  const local = memoryStore();
  const session = memoryStore();

  afterEach(() => {
    local.clear();
    session.clear();
    resetSessionForTests();
    vi.unstubAllGlobals();
  });

  it("writes remember-me sessions to localStorage", () => {
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", session);
    saveSession({ accessToken: "a", refreshToken: "r" }, true);
    expect(local.getItem("intranet.session.v1")).toContain("accessToken");
    expect(session.getItem("intranet.session.v1")).toBeNull();
    expect(isSessionPersistent()).toBe(true);
    expect(getAccessToken()).toBe("a");
  });

  it("writes this-session-only tokens to sessionStorage", () => {
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", session);
    saveSession({ accessToken: "b", refreshToken: "s" }, false);
    expect(session.getItem("intranet.session.v1")).toContain("refreshToken");
    expect(local.getItem("intranet.session.v1")).toBeNull();
    expect(isSessionPersistent()).toBe(false);
  });

  it("loads from sessionStorage when local is empty", () => {
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", session);
    session.setItem("intranet.session.v1", JSON.stringify({ accessToken: "c", refreshToken: "t" }));
    expect(loadSession()?.accessToken).toBe("c");
    expect(isSessionPersistent()).toBe(false);
  });

  it("clears both stores", () => {
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", session);
    saveSession({ accessToken: "d", refreshToken: "u" }, true);
    clearSession();
    expect(loadSession()).toBeNull();
  });

  it("clears legacy session keys on logout", () => {
    vi.stubGlobal("localStorage", local);
    vi.stubGlobal("sessionStorage", session);
    local.setItem("manut.session.v1", JSON.stringify({ accessToken: "x", refreshToken: "y" }));
    clearSession();
    expect(local.getItem("manut.session.v1")).toBeNull();
    expect(local.getItem("intranet.session.v1")).toBeNull();
  });
});
