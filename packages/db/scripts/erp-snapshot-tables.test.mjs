import { describe, expect, it } from "vitest";
import {
  DENY_TABLES,
  isDeniedTable,
  resolveExportTables,
  SLICE_TABLES,
} from "./erp-snapshot-tables.mjs";

describe("erp-snapshot-tables", () => {
  it("denies marketing / ow_* / revenue_*", () => {
    expect(isDeniedTable("ow_daily_metrics")).toBe(true);
    expect(isDeniedTable("revenue_leads")).toBe(true);
    expect(isDeniedTable("marketing_reports")).toBe(true);
    expect(isDeniedTable("bnii_foo")).toBe(true);
    expect(isDeniedTable("users")).toBe(false);
    expect(isDeniedTable("crm_leads")).toBe(false);
  });

  it("keeps every allowlisted table outside the denylist", () => {
    for (const t of [...SLICE_TABLES.p0, ...SLICE_TABLES.p1]) {
      expect(DENY_TABLES.has(t), t).toBe(false);
      expect(isDeniedTable(t), t).toBe(false);
    }
  });

  it("resolves p0 / p1 / all without overlap bugs", () => {
    const p0 = resolveExportTables("p0");
    const p1 = resolveExportTables("p1");
    const all = resolveExportTables("all");
    expect(p0).toEqual([...SLICE_TABLES.p0]);
    expect(p1).toEqual([...SLICE_TABLES.p1]);
    expect(all).toEqual([...SLICE_TABLES.p0, ...SLICE_TABLES.p1]);
    expect(new Set(all).size).toBe(all.length);
  });

  it("rejects unknown slices", () => {
    expect(() => resolveExportTables("p2")).toThrow(/unknown slice/);
  });
});
