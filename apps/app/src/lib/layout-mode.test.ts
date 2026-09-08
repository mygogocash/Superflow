import { describe, expect, it } from "vitest";

import { DESKTOP_MIN, TABLET_MIN } from "./breakpoints";
import { layoutModeForWidth } from "./layout-mode";

describe("layoutModeForWidth", () => {
  it("classifies phone / tablet / desktop", () => {
    expect(layoutModeForWidth(390)).toBe("phone");
    expect(layoutModeForWidth(TABLET_MIN - 1)).toBe("phone");
    expect(layoutModeForWidth(TABLET_MIN)).toBe("tablet");
    expect(layoutModeForWidth(DESKTOP_MIN - 1)).toBe("tablet");
    expect(layoutModeForWidth(DESKTOP_MIN)).toBe("desktop");
  });
});
