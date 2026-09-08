import { describe, expect, it } from "vitest";
import { unwrapList } from "./list";

describe("unwrapList", () => {
  it("returns a bare array", () => {
    expect(unwrapList<number>([1, 2])).toEqual([1, 2]);
  });

  it("unwraps { data: T[] }", () => {
    expect(unwrapList<{ id: string }>({ data: [{ id: "1" }] })).toEqual([{ id: "1" }]);
  });

  it("unwraps { rows: T[] } (proposals / queue envelopes)", () => {
    expect(
      unwrapList<{ id: string }>({ counts: { list: 1 }, rows: [{ id: "p1" }] }),
    ).toEqual([{ id: "p1" }]);
  });

  it("returns [] for missing or non-array payloads", () => {
    expect(unwrapList(null)).toEqual([]);
    expect(unwrapList({ data: { id: "1" } })).toEqual([]);
    expect(unwrapList({})).toEqual([]);
  });
});
