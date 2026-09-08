import { describe, expect, it } from "vitest";

import { DOCK_CONTENT_HEIGHT, RAIL_WIDTH, SIDEBAR_WIDTH } from "./glass-tokens";

describe("glass layout constants", () => {
  it("keeps chrome sizes in expected ranges", () => {
    expect(DOCK_CONTENT_HEIGHT).toBeGreaterThanOrEqual(56);
    expect(RAIL_WIDTH).toBeGreaterThanOrEqual(64);
    expect(SIDEBAR_WIDTH).toBeGreaterThanOrEqual(240);
  });
});
