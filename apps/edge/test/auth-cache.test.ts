import { describe, expect, it, vi } from "vitest";
import { invalidateUserPermissions, permissionCacheKey } from "../src/middleware/auth";

describe("permission cache invalidation", () => {
  it("deletes the rbac KV key for the user", async () => {
    const kv = { delete: vi.fn(async () => undefined) } as unknown as KVNamespace;
    await invalidateUserPermissions(kv, "user_123");
    expect(kv.delete).toHaveBeenCalledWith(permissionCacheKey("user_123"));
  });
});
