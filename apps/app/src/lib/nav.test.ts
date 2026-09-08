import { describe, expect, it } from "vitest";

import { DASHBOARD_HOME, EMPLOYEE_NAV_GROUPS, NAV_GROUPS, filterNavGroups, itemVisible, navItemActive } from "./nav";

describe("filterNavGroups", () => {
  it("keeps ungated items and drops gated ones the actor lacks", () => {
    const has = (code: string) => code === "leave:read";
    const filtered = filterNavGroups(NAV_GROUPS, has);
    const labels = filtered.flatMap((g) => g.items.map((i) => i.label));
    expect(labels).toContain("Survey");
    expect(labels).toContain("Leave");
    expect(labels).not.toContain("Accounting");
  });

  it("shows a gated item when any listed permission matches", () => {
    expect(
      itemVisible(
        { href: "/deals", label: "Sales", permissions: ["crm:read", "deals:read"] },
        (c) => c === "deals:read",
      ),
    ).toBe(true);
  });

  it("employee nav is a subset of personal routes", () => {
    const hrefs = EMPLOYEE_NAV_GROUPS.flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs).toContain("/leave");
    expect(hrefs).toContain("/aria");
    expect(hrefs).toContain(DASHBOARD_HOME);
    expect(hrefs).not.toContain("/accounting");
    expect(DASHBOARD_HOME).toBe("/dashboard");
  });
});

describe("navItemActive", () => {
  it("treats / and /dashboard as the home item", () => {
    expect(navItemActive("/dashboard", DASHBOARD_HOME)).toBe(true);
    expect(navItemActive("/", DASHBOARD_HOME)).toBe(true);
    expect(navItemActive("/leave", DASHBOARD_HOME)).toBe(false);
  });

  it("matches nested module paths without lighting siblings", () => {
    expect(navItemActive("/leave", "/leave")).toBe(true);
    expect(navItemActive("/leave/123", "/leave")).toBe(true);
    expect(navItemActive("/leads", "/leave")).toBe(false);
  });
});
