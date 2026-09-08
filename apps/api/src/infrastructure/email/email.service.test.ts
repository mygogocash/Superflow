import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/common/utils/logger", () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

const ORIGINAL_ENV = { ...process.env };

function stubOkFetch() {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response('{"id":"re_123"}', { status: 200 }),
    );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("email.service (Resend transport)", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("sends the welcome email as rendered HTML via Resend", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.EMAIL_FROM = "Manut <noreply@manut.xyz>";
    const fetchMock = stubOkFetch();

    const { sendWelcomeTemplateEmail } = await import("./email.service");
    await sendWelcomeTemplateEmail({
      to: "new.user@company.com",
      name: "Jane Doe",
      email: "new.user@company.com",
      temporaryPassword: "TempPass123!",
      portalUrl: "https://intranet.company.com",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(request).toMatchObject({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer re_test_key",
      },
    });
    const body = JSON.parse(request!.body as string);
    expect(body.from).toBe("Manut <noreply@manut.xyz>");
    expect(body.to).toBe("new.user@company.com");
    expect(body.subject).toContain("Welcome to Manut");
    expect(body.html).toContain("TempPass123!");
    expect(body.html).toContain("Jane Doe");
    expect(body.tags).toEqual([{ name: "template", value: "welcome-intranet" }]);
  });

  it("passes through a caller-provided subject + html", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    const fetchMock = stubOkFetch();

    const { sendEmail } = await import("./email.service");
    await sendEmail({
      to: ["a@x.com", "b@x.com"],
      templateId: "leave-approved",
      variables: {},
      subject: "Leave approved",
      html: "<p>approved</p>",
      replyTo: "hr@x.com",
    });

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.subject).toBe("Leave approved");
    expect(body.html).toBe("<p>approved</p>");
    expect(body.to).toEqual(["a@x.com", "b@x.com"]);
    expect(body.reply_to).toBe("hr@x.com");
  });

  it("renders a generic branded email when only templateId + variables are given", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    const fetchMock = stubOkFetch();

    const { deliverEmail } = await import("./email.service");
    const res = await deliverEmail({
      to: "ops@x.com",
      templateId: "attendance-missed-checkin",
      variables: { employeeName: "Sam Lee", date: "2026-09-07" },
    });

    expect(res.ok).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    // Humanized templateId -> subject, variables -> readable rows.
    expect(body.subject).toBe("Attendance Missed Checkin");
    expect(body.html).toContain("Sam Lee");
    expect(body.html).toContain("Employee Name");
  });

  it("reports a non-retryable failure when Resend is not configured", async () => {
    delete process.env.RESEND_API_KEY;
    const fetchMock = stubOkFetch();

    const { deliverEmail } = await import("./email.service");
    const res = await deliverEmail({
      to: "x@y.com",
      templateId: "t",
      variables: {},
      subject: "s",
      html: "<p>h</p>",
    });

    expect(res.ok).toBe(false);
    expect(res.retryable).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks 5xx as retryable and 4xx as not", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    const { deliverEmail } = await import("./email.service");

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response("boom", { status: 503 })),
    );
    const r5 = await deliverEmail({
      to: "x@y.com",
      templateId: "t",
      variables: {},
      subject: "s",
      html: "<p>h</p>",
    });
    expect(r5).toMatchObject({ ok: false, retryable: true });

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response("bad", { status: 422 })),
    );
    const r4 = await deliverEmail({
      to: "x@y.com",
      templateId: "t",
      variables: {},
      subject: "s",
      html: "<p>h</p>",
    });
    expect(r4).toMatchObject({ ok: false, retryable: false });
  });
});
