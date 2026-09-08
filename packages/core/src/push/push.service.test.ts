import { beforeEach, describe, expect, it, vi } from "vitest";

const upsertSubscription = vi.fn();
const deleteByEndpoint = vi.fn();
const deleteAllForUser = vi.fn();
const countForUser = vi.fn();

vi.mock("./push.repository.js", () => ({
  upsertSubscription: (...args: unknown[]) => upsertSubscription(...args),
  deleteByEndpoint: (...args: unknown[]) => deleteByEndpoint(...args),
  deleteAllForUser: (...args: unknown[]) => deleteAllForUser(...args),
  countForUser: (...args: unknown[]) => countForUser(...args),
}));

const { subscribe, unsubscribe } = await import("./push.service.js");

describe("push service hardening", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("subscribe response strips auth and p256dh secrets", async () => {
    upsertSubscription.mockResolvedValue({
      id: "sub-1",
      endpoint: "https://push.example/abc",
      p256dh: "secret-p256dh",
      auth: "secret-auth",
      userAgent: "test-agent",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const result = await subscribe({} as never, "user-1", {
      endpoint: "https://push.example/abc",
      keys: { p256dh: "secret-p256dh", auth: "secret-auth" },
      userAgent: "test-agent",
    });

    expect(result).toEqual({
      id: "sub-1",
      endpoint: "https://push.example/abc",
      userAgent: "test-agent",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(result).not.toHaveProperty("auth");
    expect(result).not.toHaveProperty("p256dh");
  });

  it("unsubscribe scopes delete by userId + endpoint", async () => {
    deleteByEndpoint.mockResolvedValue({ removed: false, count: 0 });
    const result = await unsubscribe({} as never, "user-a", "https://push.example/other");
    expect(deleteByEndpoint).toHaveBeenCalledWith(
      expect.anything(),
      "user-a",
      "https://push.example/other",
    );
    expect(result).toEqual({ removed: false, count: 0 });
  });
});
