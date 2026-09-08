import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  executeTool,
  normalizeVisaTypeQuery,
  toolDefinitions,
  toolDefinitionsFor,
  toolNames,
} from "@/modules/aria/aria-tools";

/**
 * ARIA Phase 5 — tool registry eval.
 *
 * Verifies the static surface every tool exposes to Anthropic
 * (description, JSON schema, name) and runs each tool through
 * `executeTool` with mocked Prisma + perms to confirm the RBAC gate
 * fires. No live LLM is involved here so the eval runs in PR CI.
 */

// ── Hoisted mocks ───────────────────────────────────────────────────
//
// vi.mock factories run before imports, so anything they reference
// must be hoisted with `vi.hoisted` or defined inside the factory.

const prismaMock = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
  visaRecord: {
    findMany: vi.fn(),
  },
  leaveBalance: {
    findMany: vi.fn(),
  },
  leaveType: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
  },
  leaveApprovalDecision: {
    findMany: vi.fn(),
  },
  travelApprovalDecision: {
    findMany: vi.fn(),
  },
  expenseApprovalDecision: {
    findMany: vi.fn(),
  },
  expenseReport: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
  helpdeskTicket: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
  },
  partner: {
    findMany: vi.fn(),
  },
  project: {
    findMany: vi.fn(),
  },
}));

vi.mock("@/infrastructure/database/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("@/infrastructure/supabase/admin", () => ({
  supabaseAdmin: { auth: { admin: {} } },
}));

vi.mock("@/core/guards/auth.guard", () => ({
  loadUserPermissions: vi.fn().mockResolvedValue(new Set<string>()),
}));

vi.mock("@/modules/aria/aria-embedding.service", () => ({
  generateEmbedding: vi.fn().mockResolvedValue(null),
  vectorLiteral: vi.fn((vec: number[]) => `[${vec.join(",")}]`),
}));

vi.mock("@/modules/aria/aria.repository", () => ({
  ariaRepository: {
    findKnowledgeByEmbedding: vi.fn().mockResolvedValue([]),
    findActiveKnowledgeForRetrieval: vi.fn().mockResolvedValue([]),
    deleteMemoryEntriesMatching: vi.fn().mockResolvedValue([]),
  },
}));

// Calendar tool reaches into the Google token repo; permission-denied
// cases short-circuit before this is called, so the mock can stay
// minimal.
vi.mock("@/modules/integrations/google-token.repository", () => ({
  googleTokenRepository: {
    getValid: vi.fn().mockRejectedValue(new Error("GOOGLE_NOT_CONNECTED")),
  },
}));

// submit_leave_request signs an HMAC token. Provide a stable key
// during tests so the signer doesn't throw on missing env.
const ORIGINAL_INTEGRATIONS_KEY = process.env.INTEGRATIONS_TOKEN_KEY;

const CALLER_ID = "00000000-0000-0000-0000-000000000001";

function ctx(perms: string[] = [], conversationId?: string) {
  return {
    userId: CALLER_ID,
    perms: new Set(perms),
    conversationId,
  };
}

function parseResult(json: string): Record<string, unknown> {
  return JSON.parse(json) as Record<string, unknown>;
}

beforeEach(() => {
  for (const model of Object.values(prismaMock)) {
    for (const fn of Object.values(model)) {
      (fn as ReturnType<typeof vi.fn>).mockReset();
    }
  }
  // 64 hex chars (32 bytes) — minimum the HMAC key gate accepts.
  process.env.INTEGRATIONS_TOKEN_KEY =
    "a".repeat(64) === "" ? "" : "0".repeat(64);
});

afterEach(() => {
  if (ORIGINAL_INTEGRATIONS_KEY === undefined) {
    delete process.env.INTEGRATIONS_TOKEN_KEY;
  } else {
    process.env.INTEGRATIONS_TOKEN_KEY = ORIGINAL_INTEGRATIONS_KEY;
  }
});

// ── Static surface ──────────────────────────────────────────────────

describe("ARIA tool registry shape", () => {
  const EXPECTED_TOOLS = [
    "lookup_employee",
    "lookup_visa",
    "list_expiring_visas",
    "lookup_leave_balance",
    "list_my_pending_approvals",
    "lookup_expense_report",
    "lookup_helpdesk_ticket",
    "lookup_partner",
    "lookup_project",
    "search_policy",
    // Sales CRM tools (Sid + BD feedback, 2026-05-24). Each one is a
    // thin Prisma wrapper gated on `crm:read`; `crm:team-read` widens
    // scope past the caller's own accounts.
    "lookup_account",
    "lookup_opportunity",
    "list_my_pipeline",
    "account_email_summary",
    // ARIA improvement #4, #6, #7 (2026-05-25)
    "lookup_my_calendar",
    "aria_memory_forget",
    "submit_leave_request",
  ];

  it("exposes the canonical tool set", () => {
    expect(toolNames().sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it("every tool has a valid Anthropic input_schema", () => {
    for (const def of toolDefinitions()) {
      expect(def.name).toMatch(/^[a-z][a-z0-9_]+$/);
      expect(def.description.length).toBeGreaterThan(20);
      expect(def.input_schema.type).toBe("object");
      expect(def.input_schema.additionalProperties).toBe(false);
      const required = def.input_schema.required ?? [];
      const props = def.input_schema.properties ?? {};
      // Every entry in `required` must also be declared in `properties`.
      for (const r of required) {
        expect(Object.keys(props)).toContain(r);
      }
    }
  });

  it("toolDefinitionsFor omits gated tools the caller cannot use", () => {
    const bare = toolDefinitionsFor(new Set());
    const bareNames = bare.map((t) => t.name).sort();
    // Always-on / self-scoped tools stay advertised so the model can
    // attempt them; handlers still enforce ownership on the result.
    expect(bareNames).toEqual(
      [
        "aria_memory_forget",
        "list_my_pending_approvals",
        "lookup_expense_report",
        "lookup_helpdesk_ticket",
        "lookup_leave_balance",
        "search_policy",
      ].sort(),
    );
    expect(bareNames).not.toContain("lookup_employee");
    expect(bareNames).not.toContain("lookup_account");
    expect(bareNames).not.toContain("lookup_my_calendar");
    expect(bareNames).not.toContain("submit_leave_request");
  });

  it("toolDefinitionsFor advertises CRM tools when crm:read is held", () => {
    const names = toolDefinitionsFor(new Set(["crm:read"])).map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "lookup_account",
        "lookup_opportunity",
        "list_my_pipeline",
        "account_email_summary",
      ]),
    );
    expect(names).not.toContain("lookup_employee");
  });

  it("toolDefinitionsFor with full perms matches toolDefinitions()", () => {
    const full = new Set([
      "directory:read",
      "visa:read",
      "partners:read",
      "projects:read",
      "crm:read",
      "integrations:use",
      "leave:request",
    ]);
    expect(toolDefinitionsFor(full).map((t) => t.name).sort()).toEqual(
      toolDefinitions()
        .map((t) => t.name)
        .sort(),
    );
  });
});

// ── Per-tool RBAC + happy-path ─────────────────────────────────────

describe("lookup_employee", () => {
  it("rejects callers without directory:read", async () => {
    const result = await executeTool(
      { id: "t1", name: "lookup_employee", input: { query: "Alice" } },
      ctx([]),
    );
    // Handler runs without throwing; permission denial is encoded in
    // the payload so the model can recover gracefully.
    expect(parseResult(result.resultJson).error).toBe("permission_denied");
    expect(prismaMock.user.findMany).not.toHaveBeenCalled();
  });

  it("returns results for callers with directory:read", async () => {
    prismaMock.user.findMany.mockResolvedValue([
      {
        id: "u1",
        name: "Alice Lee",
        email: "alice@example.com",
        jobTitle: "Engineer",
        department: "Tech",
        location: "Bangkok",
        country: "TH",
        entity: { name: "TBH Thailand", code: "TH" },
        manager: null,
      },
    ]);
    const result = await executeTool(
      { id: "t2", name: "lookup_employee", input: { query: "Alice" } },
      ctx(["directory:read"]),
    );
    expect(result.ok).toBe(true);
    const payload = parseResult(result.resultJson) as {
      results: Array<{ name: string }>;
    };
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0].name).toBe("Alice Lee");
  });
});

describe("lookup_visa", () => {
  it("rejects when caller has no visa perm and target is someone else", async () => {
    prismaMock.user.findFirst.mockResolvedValue({
      id: "other",
      name: "Bob",
      email: "bob@example.com",
    });
    const result = await executeTool(
      { id: "t3", name: "lookup_visa", input: { employee: "Bob" } },
      ctx([]),
    );
    expect(result.ok).toBe(true);
    expect(parseResult(result.resultJson).error).toBe("permission_denied");
  });

  it("allows self-lookup without any visa perm", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: CALLER_ID,
      name: "Me",
      email: "me@example.com",
    });
    prismaMock.visaRecord.findMany.mockResolvedValue([]);
    const result = await executeTool(
      { id: "t4", name: "lookup_visa", input: { employee: "me" } },
      ctx([]),
    );
    expect(result.ok).toBe(true);
    const payload = parseResult(result.resultJson) as {
      employee: { id: string };
      employeeRecords: unknown[];
      dependentRecords: unknown[];
    };
    expect(payload.employee.id).toBe(CALLER_ID);
    expect(payload.employeeRecords).toEqual([]);
    expect(payload.dependentRecords).toEqual([]);
  });

  it("defaults to holderType=employee in the prisma filter", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: CALLER_ID,
      name: "Me",
      email: "me@example.com",
    });
    prismaMock.visaRecord.findMany.mockResolvedValue([]);
    await executeTool(
      { id: "t-default", name: "lookup_visa", input: { employee: "me" } },
      ctx([]),
    );
    const whereArg = prismaMock.visaRecord.findMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
    };
    expect(whereArg.where.holderType).toBe("employee");
  });

  it("country filter is case-insensitive contains", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: CALLER_ID,
      name: "Me",
      email: "me@example.com",
    });
    prismaMock.visaRecord.findMany.mockResolvedValue([]);
    await executeTool(
      {
        id: "t-country",
        name: "lookup_visa",
        input: { employee: "me", country: "thailand" },
      },
      ctx([]),
    );
    const whereArg = prismaMock.visaRecord.findMany.mock.calls[0]?.[0] as {
      where: { country: { contains: string; mode: string } };
    };
    expect(whereArg.where.country.contains).toBe("thailand");
    expect(whereArg.where.country.mode).toBe("insensitive");
  });

  it("Thai 'business' query expands to business_visa + work_visa", async () => {
    prismaMock.user.findFirst.mockResolvedValue({
      id: "u-manit",
      name: "Manit Sachin Parikh",
      email: "manit@example.com",
    });
    prismaMock.visaRecord.findMany.mockResolvedValue([
      {
        id: "v-nonb",
        holderType: "employee",
        holderName: null,
        holderRelationship: null,
        visaType: "work_visa",
        country: "Thailand",
        nationality: "Indian",
        issueDate: new Date("2024-01-15"),
        expiryDate: new Date("2026-12-31"),
        workPermitNumber: "WP-12345",
        workPermitIssueDate: new Date("2024-01-20"),
        workPermitExpiryDate: new Date("2026-12-30"),
        notes: null,
        status: "active",
      },
    ]);
    const result = await executeTool(
      {
        id: "t-business",
        name: "lookup_visa",
        input: {
          employee: "Manit",
          country: "Thailand",
          visaTypeQuery: "business",
        },
      },
      ctx(["visa:hr-read"]),
    );
    const payload = parseResult(result.resultJson) as {
      filters: { candidateVisaTypes: string[] };
      employeeRecords: Array<{
        visaType: string;
        visaTypeLabel: string;
        country: string;
      }>;
    };
    expect(payload.filters.candidateVisaTypes.sort()).toEqual(
      ["business_visa", "work_visa"].sort(),
    );
    expect(payload.employeeRecords).toHaveLength(1);
    expect(payload.employeeRecords[0].visaType).toBe("work_visa");
    expect(payload.employeeRecords[0].visaTypeLabel).toBe("Work Visa");

    const whereArg = prismaMock.visaRecord.findMany.mock.calls[0]?.[0] as {
      where: { visaType: { in: string[] } };
    };
    expect(whereArg.where.visaType.in.sort()).toEqual(
      ["business_visa", "work_visa"].sort(),
    );
  });

  it("splits employee vs dependent records when holderType='all'", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: CALLER_ID,
      name: "Me",
      email: "me@example.com",
    });
    prismaMock.visaRecord.findMany.mockResolvedValue([
      {
        id: "v-self",
        holderType: "employee",
        holderName: null,
        holderRelationship: null,
        visaType: "work_visa",
        country: "Thailand",
        nationality: null,
        issueDate: null,
        expiryDate: new Date("2027-01-01"),
        workPermitNumber: null,
        workPermitIssueDate: null,
        workPermitExpiryDate: null,
        notes: null,
        status: "active",
      },
      {
        id: "v-spouse",
        holderType: "dependent",
        holderName: "Miloni",
        holderRelationship: "spouse",
        visaType: "other",
        country: "Thailand",
        nationality: null,
        issueDate: null,
        expiryDate: new Date("2028-01-04"),
        workPermitNumber: null,
        workPermitIssueDate: null,
        workPermitExpiryDate: null,
        notes: null,
        status: "active",
      },
    ]);
    const result = await executeTool(
      {
        id: "t-split",
        name: "lookup_visa",
        input: { employee: "me", holderType: "all" },
      },
      ctx([]),
    );
    const payload = parseResult(result.resultJson) as {
      employeeRecords: Array<{ id: string }>;
      dependentRecords: Array<{ id: string; holderName: string }>;
      totals: { employee: number; dependent: number };
    };
    expect(payload.employeeRecords.map((r) => r.id)).toEqual(["v-self"]);
    expect(payload.dependentRecords[0].holderName).toBe("Miloni");
    expect(payload.totals).toEqual({ employee: 1, dependent: 1 });
  });
});

describe("normalizeVisaTypeQuery", () => {
  it.each([
    ["business", ["business_visa", "work_visa"]],
    ["Business Visa", ["business_visa", "work_visa"]],
    ["non-b", ["business_visa", "work_visa"]],
    ["Non-Immigrant B", ["business_visa", "work_visa"]],
    ["work permit", ["work_visa"]],
    ["wp", ["work_visa"]],
    ["tourist", ["tourist_visa"]],
    ["transit", ["transit_visa"]],
    ["residence", ["residence_visa"]],
    ["", []],
    ["random gibberish", []],
  ])("%s → %j", (input, expected) => {
    expect(normalizeVisaTypeQuery(input).sort()).toEqual(expected.sort());
  });
});

describe("list_expiring_visas", () => {
  it("requires a visa permission", async () => {
    const result = await executeTool(
      { id: "t5", name: "list_expiring_visas", input: { days: 60 } },
      ctx([]),
    );
    expect(parseResult(result.resultJson).error).toBe("permission_denied");
  });

  it("returns a windowed list for permitted callers", async () => {
    prismaMock.visaRecord.findMany.mockResolvedValue([
      {
        id: "v1",
        visaType: "B",
        country: "TH",
        expiryDate: new Date("2026-06-01"),
        holderType: "employee",
        holderName: null,
        employee: { name: "Alice Lee", email: "alice@example.com" },
      },
    ]);
    const result = await executeTool(
      { id: "t6", name: "list_expiring_visas", input: { days: 90 } },
      ctx(["visa:hr-read"]),
    );
    expect(result.ok).toBe(true);
    const payload = parseResult(result.resultJson) as {
      windowDays: number;
      total: number;
    };
    expect(payload.windowDays).toBe(90);
    expect(payload.total).toBe(1);
  });
});

describe("lookup_leave_balance", () => {
  it("defaults to caller when employee omitted, no extra perm needed", async () => {
    prismaMock.user.findUnique.mockResolvedValue({
      id: CALLER_ID,
      name: "Me",
      email: "me@example.com",
    });
    prismaMock.leaveBalance.findMany.mockResolvedValue([
      {
        leaveTypeId: "lt1",
        entitled: 14,
        used: 4,
        carried: 0,
        carriedUsed: 0,
      },
    ]);
    prismaMock.leaveType.findMany.mockResolvedValue([
      { id: "lt1", name: "Annual", code: "AL", isPaid: true },
    ]);
    const result = await executeTool(
      { id: "t7", name: "lookup_leave_balance", input: {} },
      ctx([]),
    );
    expect(result.ok).toBe(true);
    const payload = parseResult(result.resultJson) as {
      balances: Array<{ leaveTypeName: string; remaining: number }>;
    };
    expect(payload.balances[0].leaveTypeName).toBe("Annual");
    expect(payload.balances[0].remaining).toBe(10);
  });

  it("blocks looking up another employee without leave:hr-read", async () => {
    prismaMock.user.findFirst.mockResolvedValue({
      id: "u-other",
      name: "Bob",
      email: "bob@example.com",
    });
    const result = await executeTool(
      {
        id: "t8",
        name: "lookup_leave_balance",
        input: { employee: "Bob" },
      },
      ctx([]),
    );
    expect(parseResult(result.resultJson).error).toBe("permission_denied");
  });
});

describe("lookup_partner / lookup_project", () => {
  it("partners requires partners:read", async () => {
    const result = await executeTool(
      { id: "t9", name: "lookup_partner", input: { query: "Acme" } },
      ctx([]),
    );
    expect(parseResult(result.resultJson).error).toBe("permission_denied");
  });

  it("project requires projects:read", async () => {
    const result = await executeTool(
      { id: "t10", name: "lookup_project", input: { query: "Atlas" } },
      ctx([]),
    );
    expect(parseResult(result.resultJson).error).toBe("permission_denied");
  });
});

describe("Sales CRM tools", () => {
  it("lookup_account requires crm:read", async () => {
    const result = await executeTool(
      { id: "crm1", name: "lookup_account", input: { query: "Safaricom" } },
      ctx([]),
    );
    expect(parseResult(result.resultJson).error).toBe("permission_denied");
  });

  it("lookup_opportunity requires crm:read", async () => {
    const result = await executeTool(
      {
        id: "crm2",
        name: "lookup_opportunity",
        input: { query: "GrameenPhone" },
      },
      ctx([]),
    );
    expect(parseResult(result.resultJson).error).toBe("permission_denied");
  });

  it("list_my_pipeline requires crm:read", async () => {
    const result = await executeTool(
      { id: "crm3", name: "list_my_pipeline", input: {} },
      ctx([]),
    );
    expect(parseResult(result.resultJson).error).toBe("permission_denied");
  });

  it("account_email_summary requires crm:read", async () => {
    const result = await executeTool(
      {
        id: "crm4",
        name: "account_email_summary",
        input: { query: "Safaricom" },
      },
      ctx([]),
    );
    expect(parseResult(result.resultJson).error).toBe("permission_denied");
  });
});

// ── ARIA improvement #4 — calendar ──────────────────────────────────

describe("lookup_my_calendar", () => {
  it("rejects callers without integrations:use", async () => {
    const result = await executeTool(
      { id: "cal1", name: "lookup_my_calendar", input: {} },
      ctx([]),
    );
    expect(parseResult(result.resultJson).error).toBe("permission_denied");
  });

  it("surfaces google_not_connected when the user has no Google token", async () => {
    const result = await executeTool(
      { id: "cal2", name: "lookup_my_calendar", input: {} },
      ctx(["integrations:use"]),
    );
    // googleTokenRepository.getValid rejects with GOOGLE_NOT_CONNECTED
    // in the mock; the tool maps that to a structured error rather
    // than a 500 so the model can suggest a reconnect.
    expect(parseResult(result.resultJson).error).toBe("google_not_connected");
  });
});

// ── ARIA improvement #6 — memory forget ─────────────────────────────

describe("aria_memory_forget", () => {
  it("no-ops with a clear error when no conversation is in scope", async () => {
    const result = await executeTool(
      { id: "f1", name: "aria_memory_forget", input: { matching: "abc" } },
      ctx([]),
    );
    expect(parseResult(result.resultJson).error).toBe("no_conversation");
  });

  it("scopes the delete by conversationId from the tool context", async () => {
    const { ariaRepository } = await import("@/modules/aria/aria.repository");
    (
      ariaRepository.deleteMemoryEntriesMatching as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce([{ id: "m1", key: "preference", value: "vegan" }]);

    const result = await executeTool(
      { id: "f2", name: "aria_memory_forget", input: { matching: "vegan" } },
      ctx([], "conv-xyz"),
    );

    expect(parseResult(result.resultJson).deleted).toEqual([
      { id: "m1", key: "preference", value: "vegan" },
    ]);
    expect(
      ariaRepository.deleteMemoryEntriesMatching as ReturnType<typeof vi.fn>,
    ).toHaveBeenCalledWith("conv-xyz", "vegan");
  });
});

// ── ARIA improvement #7 — submit_leave_request (draft-and-confirm) ──

describe("submit_leave_request", () => {
  it("rejects callers without leave:request", async () => {
    const result = await executeTool(
      {
        id: "lr1",
        name: "submit_leave_request",
        input: {
          leaveType: "annual",
          startDate: "2026-06-01",
          endDate: "2026-06-02",
        },
      },
      ctx(["leave:read"]),
    );
    expect(parseResult(result.resultJson).error).toBe("permission_denied");
  });

  it("returns a confirm token (does NOT mutate state)", async () => {
    prismaMock.leaveType.findFirst.mockResolvedValueOnce({
      id: "lt-1",
      name: "Annual Leave",
    });
    prismaMock.leaveType.findMany.mockResolvedValueOnce([
      { id: "lt-1", name: "Annual Leave" },
    ]);

    const result = await executeTool(
      {
        id: "lr2",
        name: "submit_leave_request",
        input: {
          leaveType: "annual",
          startDate: "2026-06-01",
          endDate: "2026-06-02",
          reason: "wedding",
        },
      },
      ctx(["leave:request"]),
    );
    const payload = parseResult(result.resultJson) as {
      confirm?: { action: string; token: string; params: unknown };
    };
    expect(payload.confirm?.action).toBe("submit_leave_request");
    expect(typeof payload.confirm?.token).toBe("string");
    expect(payload.confirm?.token).toMatch(/^v1:[^:]+:[0-9a-f]+$/);
  });
});

describe("invalid input handling", () => {
  it("rejects unknown tool", async () => {
    const result = await executeTool(
      { id: "tX", name: "does_not_exist", input: {} },
      ctx([]),
    );
    expect(result.ok).toBe(false);
    expect(parseResult(result.resultJson).error).toBe("unknown_tool");
  });

  it("rejects malformed args", async () => {
    const result = await executeTool(
      { id: "tY", name: "lookup_employee", input: { query: "" } },
      ctx(["directory:read"]),
    );
    expect(result.ok).toBe(false);
    expect(parseResult(result.resultJson).error).toBe("invalid_arguments");
  });
});
