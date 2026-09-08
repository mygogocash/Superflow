import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/infrastructure/database/prisma";
import { attendanceRepository } from "@/modules/hrms/attendance.repository";

vi.mock("@/infrastructure/database/prisma", () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([]),
  },
}));

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
    vi.mocked(prisma.$queryRaw).mockClear();
    vi.mocked(prisma.$queryRaw).mockResolvedValue([]);
  });

  it("hasApprovedLeaveOnDate ignores soft-deleted leave_requests", async () => {
    await attendanceRepository.hasApprovedLeaveOnDate(
      "11111111-1111-1111-1111-111111111111",
      new Date("2026-09-08"),
    );
    expect(prisma.$queryRaw).toHaveBeenCalled();
    const sql = sqlTextFromQueryRawCall(
      vi.mocked(prisma.$queryRaw).mock.calls[0] as unknown[],
    );
    expect(sql).toMatch(/leave_requests/i);
    expect(sql).toMatch(/deleted_at\s+IS\s+NULL/i);
  });

  it("findApprovedLeavesInRange ignores soft-deleted leave_requests", async () => {
    await attendanceRepository.findApprovedLeavesInRange(
      ["11111111-1111-1111-1111-111111111111"],
      new Date("2026-09-01"),
      new Date("2026-09-30"),
    );
    expect(prisma.$queryRaw).toHaveBeenCalled();
    const sql = sqlTextFromQueryRawCall(
      vi.mocked(prisma.$queryRaw).mock.calls[0] as unknown[],
    );
    expect(sql).toMatch(/leave_requests/i);
    expect(sql).toMatch(/deleted_at\s+IS\s+NULL/i);
  });
});
