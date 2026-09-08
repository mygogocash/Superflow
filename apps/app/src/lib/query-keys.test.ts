import { describe, expect, it } from "vitest";
import { queryKeys } from "./query-keys";

describe("queryKeys", () => {
  it("keeps leave requests stable for TanStack Query", () => {
    expect(queryKeys.leave.requests()).toEqual(["leave", "requests"]);
    expect(queryKeys.leave.types()).toEqual(["leave", "types"]);
    expect(queryKeys.travel.requests()).toEqual(["travel", "requests"]);
    expect(queryKeys.expenses.reports()).toEqual(["expenses", "reports"]);
    expect(queryKeys.aria.conversations()).toEqual(["aria", "conversations"]);
    expect(queryKeys.aria.conversation("c1")).toEqual(["aria", "conversation", "c1"]);
    expect(queryKeys.me()).toEqual(["me"]);
    expect(queryKeys.resource("/expenses/reports")).toEqual(["resource", "/expenses/reports"]);
    expect(queryKeys.dashboard.stats()).toEqual(["dashboard", "stats"]);
  });
});
