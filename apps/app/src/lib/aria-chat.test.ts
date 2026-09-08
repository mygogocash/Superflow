import { describe, expect, it } from "vitest";
import { extractChatActions, peekConfirmTokenBody } from "./aria-chat";

describe("extractChatActions", () => {
  it("strips aria-actions fences into chips", () => {
    const content = `Here are options:\n\`\`\`aria-actions\n{"actions":[{"label":"Check leave","prompt":"What is my leave balance?"}]}\n\`\`\`\n`;
    const result = extractChatActions(content);
    expect(result.display).toContain("Here are options");
    expect(result.display).not.toContain("aria-actions");
    expect(result.actions).toEqual([{ label: "Check leave", prompt: "What is my leave balance?" }]);
  });

  it("parses aria-confirm fences with signed peek when token is decodable", () => {
    const body = Buffer.from(
      JSON.stringify({
        action: "submit_leave_request",
        userId: "u1",
        params: { leaveTypeId: "lt1", startDate: "2026-06-01", endDate: "2026-06-05" },
        jti: "jti-1",
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
      "utf-8",
    ).toString("base64");
    const token = `v1:${body}:deadbeef`;
    const content = `Confirm?\n\`\`\`aria-confirm\n{"action":"submit_leave","token":${JSON.stringify(token)},"summary":"Submit annual leave","params":{"leaveTypeId":"lt1"}}\n\`\`\``;
    const result = extractChatActions(content);
    expect(result.confirm?.summary).toBe("Submit annual leave");
    expect(result.confirm?.action).toBe("submit_leave");
    expect(result.confirm?.signedAction).toBe("submit_leave_request");
    expect(result.confirm?.signedParams).toEqual({
      leaveTypeId: "lt1",
      startDate: "2026-06-01",
      endDate: "2026-06-05",
    });
    expect(result.confirm?.fenceParams).toEqual({ leaveTypeId: "lt1" });
  });

  it("keeps malformed confirm fences visible instead of stripping", () => {
    const content = `Oops\n\`\`\`aria-confirm\n{"token":"only"}\n\`\`\``;
    const result = extractChatActions(content);
    expect(result.confirm).toBeUndefined();
    expect(result.display).toContain("aria-confirm");
  });
});

describe("peekConfirmTokenBody", () => {
  it("decodes v1 token bodies without verifying HMAC", () => {
    const body = Buffer.from(
      JSON.stringify({
        action: "submit_leave_request",
        userId: "u1",
        params: { days: 2 },
        jti: "abc",
        exp: 9999999999,
      }),
      "utf-8",
    ).toString("base64");
    const peeked = peekConfirmTokenBody(`v1:${body}:00`);
    expect(peeked).toEqual({
      action: "submit_leave_request",
      params: { days: 2 },
      exp: 9999999999,
    });
  });

  it("returns null for garbage tokens", () => {
    expect(peekConfirmTokenBody("not-a-token")).toBeNull();
    expect(peekConfirmTokenBody("v1:%%%:00")).toBeNull();
  });
});
