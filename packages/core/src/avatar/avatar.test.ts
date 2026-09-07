import { describe, expect, it, vi } from "vitest";
import { ForbiddenException } from "../http-exception.js";
import { generateAndSetAvatar } from "./service.js";

describe("generateAndSetAvatar", () => {
  it("fail-closes when AVATAR_GENERATOR_ENABLED is not true", async () => {
    await expect(
      generateAndSetAvatar(
        {} as never,
        "user-1",
        { APP_URL: "http://localhost:8787", AVATAR_GENERATOR_ENABLED: "false" },
        { put: vi.fn(), delete: vi.fn() },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
