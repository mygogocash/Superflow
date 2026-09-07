import { describe, expect, it } from "vitest";
import {
  dashboardRecap,
  firstNameOf,
  formatMoneyThb,
  formatRelativeTime,
  greetingForHour,
  unwrapDashboardStats,
  urgentItemHref,
} from "./dashboard";

describe("dashboard helpers", () => {
  it("greets by hour", () => {
    expect(greetingForHour(8)).toBe("Good morning");
    expect(greetingForHour(13)).toBe("Good afternoon");
    expect(greetingForHour(20)).toBe("Good evening");
  });

  it("takes the first name", () => {
    expect(firstNameOf("Ada Lovelace")).toBe("Ada");
    expect(firstNameOf("  ")).toBe("there");
  });

  it("formats THB without cents", () => {
    expect(formatMoneyThb(12500)).toMatch(/12,500/);
  });

  it("formats relative time", () => {
    const now = Date.parse("2026-09-05T12:00:00.000Z");
    expect(formatRelativeTime("2026-09-05T11:59:30.000Z", now)).toBe("just now");
    expect(formatRelativeTime("2026-09-05T11:10:00.000Z", now)).toBe("50m ago");
    expect(formatRelativeTime("2026-09-04T12:00:00.000Z", now)).toBe("1d ago");
  });

  it("builds a recap from pending and urgent counts", () => {
    expect(dashboardRecap({ pendingActions: [], urgentItems: [] })).toBe(
      "Nothing needs your attention right now.",
    );
    expect(
      dashboardRecap({
        pendingActions: [{ id: "1" } as never],
        urgentItems: [{ label: "x" } as never, { label: "y" } as never],
      }),
    ).toBe("Since you last checked: 2 urgent items and 1 pending approval.");
  });

  it("unwraps { data } envelopes and fills missing arrays", () => {
    const stats = unwrapDashboardStats({
      data: { kpis: { pendingLeaves: 3, expensesThisMonth: 100 } },
    });
    expect(stats?.kpis.pendingLeaves).toBe(3);
    expect(stats?.pendingActions).toEqual([]);
  });

  it("defaults missing kpis instead of blanking the dashboard", () => {
    const stats = unwrapDashboardStats({
      pendingActions: [],
      urgentItems: [],
    });
    expect(stats?.kpis.totalEmployees).toBe(0);
    expect(stats?.pendingActions).toEqual([]);
    expect(unwrapDashboardStats(null)).toBeNull();
  });

  it("maps urgent labels to module routes", () => {
    expect(urgentItemHref("2 visas expiring within 30 days")).toBe("/visa");
    expect(urgentItemHref("3 pending expense claims ($120)")).toBe("/expenses");
    expect(urgentItemHref("1 travel request awaiting approval")).toBe("/travel");
    expect(urgentItemHref("4 leave requests awaiting approval")).toBe("/leave");
    expect(urgentItemHref("Something else")).toBe("/dashboard");
  });
});
