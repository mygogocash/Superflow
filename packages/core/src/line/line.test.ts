import { describe, expect, it } from "vitest";
import { verifyLineSignature } from "./signature.js";
import { generateAvatarSvg } from "../avatar/generate.js";

describe("verifyLineSignature", () => {
  it("accepts a valid HMAC-SHA256 signature", async () => {
    const secret = "channel-secret";
    const body = '{"events":[]}';
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    const signature = btoa(String.fromCharCode(...new Uint8Array(mac)));
    await expect(verifyLineSignature(body, signature, secret)).resolves.toBe(true);
  });

  it("rejects a missing or wrong signature", async () => {
    await expect(verifyLineSignature("{}", null, "secret")).resolves.toBe(false);
    await expect(verifyLineSignature("{}", "nope", "secret")).resolves.toBe(false);
  });
});

describe("generateAvatarSvg", () => {
  it("returns an SVG with Manut-safe initials", () => {
    const out = generateAvatarSvg({
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@manut.xyz",
      style: "initials",
    });
    expect(out.contentType).toBe("image/svg+xml");
    const text = new TextDecoder().decode(out.bytes);
    expect(text).toContain("<svg");
    expect(text).toContain("AL");
    expect(text).toMatch(/#5B5BD6|#0B0B0A|#3F3F46|#18181B|#4F46E5/);
  });

  it("falls back to email initials", () => {
    const out = generateAvatarSvg({ email: "ops@manut.xyz", style: "soft" });
    const text = new TextDecoder().decode(out.bytes);
    expect(text).toContain("OP");
  });
});
