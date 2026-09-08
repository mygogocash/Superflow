import { beforeEach, describe, expect, it, vi } from "vitest";

const queryRaw = vi.fn().mockResolvedValue([]);

vi.mock("@/infrastructure/database/prisma", () => ({
  prisma: {
    $queryRaw: (...args: unknown[]) => queryRaw(...args),
  },
}));

import { attendanceRepository } from "@/modules/hrms/attendance.repository";

function sqlTextFromQueryRawCall(args: unknown[]): string {
  const first = args[0] as { strings?: readonly string[] } | string | undefined;
  if (first && typeof first === "object" && Array.isArray(first.strings)) {
    return first.strings.join("?");
  }
  if (typeof first === "string") return first;
  // Tagged-template call shape: (strings, ...values)
  if (Array.isArray(first)) return (first as string[]).join("?");
  return String(first ?? "");
}

describe("attendanceRepository soft-delete filters on raw leave SQL", () => {
  beforeEach(() => {
    queryRaw.mockClear();
    queryRaw.mockResolvedValue([]);
  });

  it("hasApprovedLeaveOnDate ignores soft-deleted leave_requests", async () => {
    await attendanceRepository.hasApprovedLeaveOnDate(
      "11111111-1111-1111-1111-111111111111",
      new Date("2026-09-08"),
    );
    expect(queryRaw).toHaveBeenCalled();
    const sql = sqlTextFromQueryRawCall(queryRaw.mock.calls[0] as unknown[]);
    expect(sql).toMatch(/leave_requests/i);
    expect(sql).toMatch(/deleted_at\s+IS\s+NULL/i);
  });

  it("findApprovedLeavesInRange ignores soft-deleted leave_requests", async () => {
    await attendanceRepository.findApprovedLeavesInRange(
      ["11111111-1111-1111-1111-111111111111"],
      new Date("2026-09-01"),
      new Date("2026-09-30"),
    );
    expect(queryRaw).toHaveBeenCalled();
    const sql = sqlTextFromQueryRawCall(queryRaw.mock.calls[0] as unknown[]);
    expect(sql).toMatch(/leave_requests/i);
    expect(sql).toMatch(/deleted_at\s+IS\s+NULL/i);
  });
});
