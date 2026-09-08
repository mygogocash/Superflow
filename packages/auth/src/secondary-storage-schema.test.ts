import { getAuthTables } from "better-auth/db";
import { describe, expect, it } from "vitest";

/**
 * Regression for staging sign-in 500: Better Auth drops `session` (and
 * `verification`) from getAuthTables when secondaryStorage is set without
 * storeSessionInDatabase / storeInDatabase (better-auth#9370). Our Worker
 * always passes KV secondaryStorage, so these flags must stay true.
 */
describe("secondaryStorage auth table schema", () => {
  const secondaryStorage = {
    get: async () => null,
    getAndDelete: async () => null,
    increment: async () => 1,
    set: async () => undefined,
    delete: async () => undefined,
  };

  it("keeps session + verification when dual-write flags match createAuth", () => {
    const tables = getAuthTables({
      secondaryStorage,
      session: { storeSessionInDatabase: true },
      verification: { storeInDatabase: true },
      user: { modelName: "users" },
    });
    expect(Object.keys(tables).sort()).toEqual(
      ["account", "session", "user", "verification"].sort(),
    );
  });

  it("drops session without storeSessionInDatabase (the bug we hit)", () => {
    const tables = getAuthTables({
      secondaryStorage,
      user: { modelName: "users" },
    });
    expect(tables.session).toBeUndefined();
    expect(tables.verification).toBeUndefined();
  });
});
