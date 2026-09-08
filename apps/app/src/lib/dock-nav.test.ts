import { describe, expect, it } from "vitest";

import { buildTabletRail, DOCK_DESTINATIONS, filterDockDestinations } from "./dock-nav";
import { DASHBOARD_HOME } from "./nav";

describe("filterDockDestinations", () => {
  it("always keeps More and ungated Home", () => {
    const items = filterDockDestinations(DOCK_DESTINATIONS, () => false);
    expect(items.map((i) => i.id)).toEqual(["home", "more"]);
  });

  it("includes permission-gated destinations when allowed", () => {
    const items = filterDockDestinations(DOCK_DESTINATIONS, (c) => c === "aria:use");
    expect(items.map((i) => i.id)).toEqual(["home", "aria", "more"]);
  });
});

describe("buildTabletRail", () => {
  it("caps extras and ends with More", () => {
    const rail = buildTabletRail(() => true);
    expect(rail.at(-1)?.opensMore).toBe(true);
    expect(rail.some((i) => i.href === DASHBOARD_HOME)).toBe(true);
    expect(rail.length).toBeLessThanOrEqual(6);
  });
});
