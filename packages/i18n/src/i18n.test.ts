import { describe, expect, it } from "vitest";

import {
  formatCurrency,
  formatDate,
  formatNumber,
  toBuddhistYear,
} from "./format";
import { DEFAULT_LOCALE, isLocale, resolveLocale } from "./locales";
import { en, messages, th } from "./messages";

describe("resolveLocale", () => {
  it("matches the primary subtag of a BCP-47 tag", () => {
    expect(resolveLocale("th-TH")).toBe("th");
    expect(resolveLocale("en-US")).toBe("en");
    expect(resolveLocale("th_TH")).toBe("th");
  });

  it("walks the candidate chain and skips empties", () => {
    expect(resolveLocale(null, undefined, "", "th")).toBe("th");
    // user (null) → org default ("th") wins before browser ("en")
    expect(resolveLocale(null, "th", "en-US")).toBe("th");
  });

  it("falls back to the default when nothing is supported", () => {
    expect(resolveLocale("fr", "de", "zz")).toBe(DEFAULT_LOCALE);
    expect(resolveLocale()).toBe(DEFAULT_LOCALE);
  });

  it("isLocale guards unknown values", () => {
    expect(isLocale("th")).toBe(true);
    expect(isLocale("fr")).toBe(false);
    expect(isLocale(42)).toBe(false);
  });
});

describe("Buddhist-era dates", () => {
  it("converts Gregorian year to BE (+543)", () => {
    expect(toBuddhistYear(2026)).toBe(2569);
    expect(toBuddhistYear(1990)).toBe(2533);
  });

  it("renders the BE year for Thai by default", () => {
    const d = new Date("2026-01-15T00:00:00.000Z");
    const formatted = formatDate(d, "th");
    // 2026 CE → 2569 BE, in Latin digits.
    expect(formatted).toContain("2569");
    expect(formatted).not.toContain("2026");
  });

  it("renders the Gregorian year for English", () => {
    const d = new Date("2026-01-15T00:00:00.000Z");
    const formatted = formatDate(d, "en");
    expect(formatted).toContain("2026");
  });

  it("can force Gregorian for Thai (statutory override)", () => {
    const d = new Date("2026-01-15T00:00:00.000Z");
    expect(formatDate(d, "th", { buddhistEra: false })).toContain("2026");
  });
});

describe("number + currency formatting", () => {
  it("groups thousands per locale", () => {
    expect(formatNumber(1234567, "en")).toBe("1,234,567");
    expect(formatNumber(1234567, "th")).toBe("1,234,567");
  });

  it("formats currency with the given ISO code", () => {
    expect(formatCurrency(1000, "THB", "en")).toContain("1,000");
  });
});

describe("catalog parity", () => {
  it("th has exactly the same key paths as en", () => {
    const paths = (obj: Record<string, unknown>, prefix = ""): string[] =>
      Object.entries(obj).flatMap(([k, v]) =>
        v && typeof v === "object"
          ? paths(v as Record<string, unknown>, `${prefix}${k}.`)
          : [`${prefix}${k}`],
      );
    expect(paths(th).sort()).toEqual(paths(en).sort());
  });

  it("exposes every supported locale in the messages map", () => {
    expect(Object.keys(messages).sort()).toEqual(["en", "th"]);
  });
});
