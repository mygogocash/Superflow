import { describe, expect, it } from "vitest";
import {
  MIN_SHARED_SECRET_LENGTH,
  timingSafeEqualString,
  verifySharedSecret,
} from "./secrets";

const LONG = "a".repeat(MIN_SHARED_SECRET_LENGTH);
const LONG_OTHER = "b".repeat(MIN_SHARED_SECRET_LENGTH);

describe("timingSafeEqualString", () => {
  it("accepts equal strings", () => {
    expect(timingSafeEqualString("abc", "abc")).toBe(true);
    expect(timingSafeEqualString(LONG, LONG)).toBe(true);
  });

  it("rejects unequal content or length", () => {
    expect(timingSafeEqualString("abc", "abd")).toBe(false);
    expect(timingSafeEqualString("abc", "ab")).toBe(false);
    expect(timingSafeEqualString(LONG, LONG_OTHER)).toBe(false);
  });
});

describe("verifySharedSecret", () => {
  it("accepts a valid long secret", () => {
    expect(verifySharedSecret(LONG, LONG)).toBe(true);
  });

  it("rejects wrong secret", () => {
    expect(verifySharedSecret(LONG_OTHER, LONG)).toBe(false);
  });

  it("fail-closed: empty / missing configured secret", () => {
    expect(verifySharedSecret(LONG, "")).toBe(false);
    expect(verifySharedSecret(LONG, null)).toBe(false);
    expect(verifySharedSecret(LONG, undefined)).toBe(false);
  });

  it("fail-closed: configured secret shorter than minLength", () => {
    const short = "short-secret";
    expect(verifySharedSecret(short, short)).toBe(false);
    expect(verifySharedSecret(short, short, { minLength: 8 })).toBe(true);
  });

  it("rejects missing provided secret", () => {
    expect(verifySharedSecret(undefined, LONG)).toBe(false);
    expect(verifySharedSecret("", LONG)).toBe(false);
    expect(verifySharedSecret(null, LONG)).toBe(false);
  });
});
