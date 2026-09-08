import { z } from "zod";

import { PERMISSIONS } from "@/common/constants/permissions";
import { logger } from "@/common/utils/logger";
import { loadUserPermissions } from "@/core/guards/auth.guard";
import { prisma } from "@/infrastructure/database/prisma";
import { ariaRepository } from "@/modules/aria/aria.repository";
import {
  generateEmbedding,
  vectorLiteral,
} from "@/modules/aria/aria-embedding.service";

/**
 * ARIA Phase 3 — Anthropic tool registry.
 *
 * Each tool is a thin RBAC-gated wrapper over Prisma. The Anthropic
 * model receives the `definitions` array (Anthropic tool-use shape);
 * when it emits a `tool_use` block we dispatch through
 * `executeTool(...)` which:
 *
 *   1. validates the args with Zod (rejects malformed model output)
 *   2. re-loads the caller's permissions per call (no trust in args)
 *   3. invokes the handler, which scopes its query to what the caller
 *      may see (`owner = userId` when the broader read perm is absent)
 *
 * Return shape is always a JSON string. The model is told this in the
 * tool description so it can parse without prompting tricks.
 */

const MAX_RESULTS = 5;
const VISA_MAX_RESULTS = 20;
const VISA_DEFAULT_WINDOW_DAYS = 90;

/**
 * Canonical visa types used in the directory (`apps/web/src/services/visa.service.ts`).
 * Kept in sync with the UI's `VISA_TYPES` array — order matters only
 * for the human-readable label fallback below.
 */
const VISA_TYPE_LABELS: Record<string, string> = {
  work_visa: "Work Visa",
  residence_visa: "Residence Visa",
  tourist_visa: "Tourist Visa",
  business_visa: "Business Visa",
  transit_visa: "Transit Visa",
  other: "Other",
};

function visaTypeLabel(raw: string): string {
  return VISA_TYPE_LABELS[raw] ?? raw;
}

/**
 * Map a free-text visa query ("business", "non-b", "work permit",
 * etc.) into the set of canonical `visa_type` values it should match.
 *
 * Thailand-specific note: a Thai "Non-Immigrant B" is informally
 * called a "business visa" by HR but Manut usually catalogues it under
 * `work_visa` because the same row also carries the work-permit
 * fields. We deliberately expand "business" → `business_visa` +
 * `work_visa` so HR queries like "Manit's Thailand business visa"
 * still surface the Non-B row that lives under `work_visa`.
 */
export function normalizeVisaTypeQuery(query: string): string[] {
  const lower = query.toLowerCase().trim();
  if (!lower) return [];
  const out = new Set<string>();
  if (/business|\bnon[- ]?b\b|non[- ]?immigrant\s*b|\bb\s*visa\b/.test(lower)) {
    out.add("business_visa");
    out.add("work_visa");
  }
  if (/\bwork\b|\bwp\b|labour|labor|employment|work\s*permit/.test(lower)) {
    out.add("work_visa");
  }
  if (/tourist|\btr\b|visit/.test(lower)) out.add("tourist_visa");
  if (/transit/.test(lower)) out.add("transit_visa");
  if (/residen|permanent|\bpr\b/.test(lower)) out.add("residence_visa");
  if (/\bother\b/.test(lower)) out.add("other");
  return Array.from(out);
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
}

interface ToolHandler<Args> {
  // ZodTypeAny avoids friction with z.object() inference where optional
  // fields make `z.ZodType<Args>` mismatch its inferred shape. Runtime
  // safety still comes from `.safeParse(...)` in executeTool.
  schema: z.ZodTypeAny;
  run: (args: Args, ctx: ToolContext) => Promise<unknown>;
}

interface ToolContext {
  userId: string;
  perms: Set<string>;
  /**
   * Active conversation id when the tool is dispatched from the chat
   * stream. Optional so tools triggered outside chat (eval suite,
   * future REST surface) still load without crashing — they just skip
   * the conversation-scoped features.
   */
  conversationId?: string;
}

interface ToolEntry<Args = unknown> {
  definition: ToolDefinition;
  handler: ToolHandler<Args>;
}

// ── Helpers ─────────────────────────────────────────────────────────

function safeNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (value == null) return 0;
  // Prisma Decimal exposes toNumber(); fall back to Number(...) so we
  // don't crash on plain numerics.
  if (typeof value === "object" && "toNumber" in (value as object)) {
    try {
      return (value as { toNumber: () => number }).toNumber();
    } catch {
      return Number(value);
    }
  }
  return Number(value);
}

/**
 * Find a user by id (when the query looks like a uuid), email, or
 * name fragment. Returns null when no match. Used by every "lookup_X"
 * tool that accepts a human-friendly name or "me".
 */
async function resolveEmployee(
  query: string,
  callerId: string,
): Promise<{ id: string; name: string; email: string } | null> {
  const trimmed = query.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase() === "me" || trimmed.toLowerCase() === "myself") {
    return prisma.user.findUnique({
      where: { id: callerId },
      select: { id: true, name: true, email: true },
    });
  }
  // Try uuid first — cheap exact match.
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      trimmed,
    )
  ) {
    const byId = await prisma.user.findUnique({
      where: { id: trimmed },
      select: { id: true, name: true, email: true },
    });
    if (byId) return byId;
  }
  // Email exact match.
  if (trimmed.includes("@")) {
    const byEmail = await prisma.user.findUnique({
      where: { email: trimmed.toLowerCase() },
      select: { id: true, name: true, email: true },
    });
    if (byEmail) return byEmail;
  }
  // Name fragment — case-insensitive contains. Take the most recently
  // updated active row to bias against legacy soft-deleted duplicates.
  const byName = await prisma.user.findFirst({
    where: {
      isActive: true,
      OR: [
        { name: { contains: trimmed, mode: "insensitive" } },
        { email: { contains: trimmed, mode: "insensitive" } },
        { employeeId: trimmed },
      ],
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true, name: true, email: true },
  });
  return byName;
}

// ── Tools ───────────────────────────────────────────────────────────

// 1. lookup_employee
const lookupEmployee: ToolEntry<{ query: string }> = {
  definition: {
    name: "lookup_employee",
    description:
      "Find one or more employees by name, email, or employee ID. Returns up to 5 matches with name, email, job title, department, entity, and manager. Use this whenever the user names a person Manut AI does not already know about. Returns JSON string {results: [...]} (empty array when no match).",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Free-text name fragment, email, or employee ID.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  handler: {
    schema: z.object({ query: z.string().min(1).max(120) }),
    async run({ query }, { perms }) {
      if (!perms.has(PERMISSIONS.DIRECTORY_READ)) {
        return {
          error: "permission_denied",
          message:
            "You do not have the directory:read permission required to look up employees.",
        };
      }
      const rows = await prisma.user.findMany({
        where: {
          isActive: true,
          OR: [
            { name: { contains: query, mode: "insensitive" } },
            { email: { contains: query, mode: "insensitive" } },
            { employeeId: query },
          ],
        },
        select: {
          id: true,
          name: true,
          email: true,
          jobTitle: true,
          department: true,
          location: true,
          country: true,
          entity: { select: { name: true, code: true } },
          manager: { select: { name: true, email: true } },
        },
        orderBy: { name: "asc" },
        take: MAX_RESULTS,
      });
      return { results: rows };
    },
  },
};

// 2. lookup_visa
const lookupVisa: ToolEntry<{
  employee: string;
  country?: string;
  holderType?: "employee" | "dependent" | "all";
  visaTypeQuery?: string;
}> = {
  definition: {
    name: "lookup_visa",
    description: [
      "Return active visa records for an employee with optional filters.",
      "Returns JSON string {employee, filters, employeeRecords, dependentRecords}.",
      "Each record carries the raw `visaType` (one of: work_visa | residence_visa | tourist_visa | business_visa | transit_visa | other) plus a human `visaTypeLabel`, country, issue/expiry dates, work-permit fields, and holder info.",
      'Defaults: holderType="employee" (only the employee\'s own visas; pass "dependent" or "all" to include family). Empty filters return every active employee row.',
      'Country filter is case-insensitive substring match ("thailand" matches "Thailand").',
      'visaTypeQuery accepts natural language ("business", "non-b", "work permit", "tourist"). A Thai Non-Immigrant B is informally a "business visa" but Manut usually catalogues it under work_visa — passing visaTypeQuery="business" matches both business_visa and work_visa rows so HR-style questions surface the Non-B record.',
      "Caller's own visa is always accessible; others require visa:read or visa:hr-read.",
    ].join(" "),
    input_schema: {
      type: "object",
      properties: {
        employee: {
          type: "string",
          description:
            'Name, email, employee ID, or the literal string "me" to query the caller.',
        },
        country: {
          type: "string",
          description:
            "Optional country filter (case-insensitive substring match).",
        },
        holderType: {
          type: "string",
          enum: ["employee", "dependent", "all"],
          description:
            'Which holder type to return. Defaults to "employee" (omit family). Pass "dependent" or "all" when the user explicitly asks about spouses / children.',
        },
        visaTypeQuery: {
          type: "string",
          description:
            'Natural-language visa-type filter (e.g. "business", "non-b", "work permit", "tourist").',
        },
      },
      required: ["employee"],
      additionalProperties: false,
    },
  },
  handler: {
    schema: z.object({
      employee: z.string().min(1).max(120),
      country: z.string().min(1).max(80).optional(),
      holderType: z.enum(["employee", "dependent", "all"]).optional(),
      visaTypeQuery: z.string().min(1).max(80).optional(),
    }),
    async run(
      { employee, country, holderType, visaTypeQuery },
      { userId, perms },
    ) {
      const target = await resolveEmployee(employee, userId);
      if (!target) {
        return { error: "not_found", message: "No matching employee." };
      }
      const isSelf = target.id === userId;
      const hasReadAll =
        perms.has(PERMISSIONS.VISA_READ) ||
        perms.has(PERMISSIONS.VISA_HR_READ) ||
        perms.has(PERMISSIONS.VISA_MANAGE);
      if (!isSelf && !hasReadAll) {
        return {
          error: "permission_denied",
          message:
            "Looking up another employee's visa requires visa:read or visa:hr-read.",
        };
      }

      const effectiveHolderType = holderType ?? "employee";
      const candidateTypes = visaTypeQuery
        ? normalizeVisaTypeQuery(visaTypeQuery)
        : [];

      const where: Record<string, unknown> = {
        employeeId: target.id,
        status: "active",
      };
      if (effectiveHolderType !== "all") where.holderType = effectiveHolderType;
      if (country) {
        where.country = { contains: country, mode: "insensitive" };
      }
      if (candidateTypes.length > 0) where.visaType = { in: candidateTypes };

      const rows = await prisma.visaRecord.findMany({
        where,
        select: {
          id: true,
          holderType: true,
          holderName: true,
          holderRelationship: true,
          visaType: true,
          country: true,
          nationality: true,
          issueDate: true,
          expiryDate: true,
          workPermitNumber: true,
          workPermitIssueDate: true,
          workPermitExpiryDate: true,
          notes: true,
          status: true,
        },
        orderBy: { expiryDate: "asc" },
        take: VISA_MAX_RESULTS,
      });

      const mapped = rows.map((r) => ({
        ...r,
        visaTypeLabel: visaTypeLabel(r.visaType),
      }));
      const employeeRecords = mapped.filter((r) => r.holderType === "employee");
      const dependentRecords = mapped.filter(
        (r) => r.holderType === "dependent",
      );

      return {
        employee: target,
        filters: {
          country: country ?? null,
          holderType: effectiveHolderType,
          visaTypeQuery: visaTypeQuery ?? null,
          candidateVisaTypes: candidateTypes,
        },
        employeeRecords,
        dependentRecords,
        // Convenience for the model: pre-computed totals so it can
        // distinguish "no records at all" from "no records matched
        // the filter" without recounting.
        totals: {
          employee: employeeRecords.length,
          dependent: dependentRecords.length,
        },
      };
    },
  },
};

// 3. list_expiring_visas
const listExpiringVisas: ToolEntry<{
  days?: number;
  country?: string;
  visaTypeQuery?: string;
}> = {
  definition: {
    name: "list_expiring_visas",
    description: [
      "List visa records expiring within the next N days (default 90).",
      "Optional `country` (substring match) and `visaTypeQuery` (natural-language, see lookup_visa) filters.",
      "Requires visa:hr-read or visa:manage (org-wide expiry scan — not available to visa:read alone).",
      "Returns JSON string {windowDays, total, results: [...]} where each result carries `visaType`, `visaTypeLabel`, country, expiry date, holder info, and the sponsoring employee.",
    ].join(" "),
    input_schema: {
      type: "object",
      properties: {
        days: {
          type: "integer",
          description: "Look-ahead window in days. Defaults to 90.",
          minimum: 1,
          maximum: 365,
        },
        country: {
          type: "string",
          description:
            "Optional country filter (case-insensitive substring match).",
        },
        visaTypeQuery: {
          type: "string",
          description:
            'Natural-language visa type filter (e.g. "business", "non-b", "work permit").',
        },
      },
      additionalProperties: false,
    },
  },
  handler: {
    schema: z.object({
      days: z.number().int().min(1).max(365).optional(),
      country: z.string().min(1).max(80).optional(),
      visaTypeQuery: z.string().min(1).max(80).optional(),
    }),
    async run({ days, country, visaTypeQuery }, { perms }) {
      // Match daily-brief gate: visa:read is self-only elsewhere; this
      // tool scans the whole org, so advertise/run only for HR/manage.
      if (
        !perms.has(PERMISSIONS.VISA_HR_READ) &&
        !perms.has(PERMISSIONS.VISA_MANAGE)
      ) {
        return {
          error: "permission_denied",
          message: "Requires visa:hr-read or visa:manage.",
        };
      }
      const windowDays = days ?? VISA_DEFAULT_WINDOW_DAYS;
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(end.getDate() + windowDays);

      const candidateTypes = visaTypeQuery
        ? normalizeVisaTypeQuery(visaTypeQuery)
        : [];
      const where: Record<string, unknown> = {
        status: "active",
        expiryDate: { gte: start, lte: end },
      };
      if (country) {
        where.country = { contains: country, mode: "insensitive" };
      }
      if (candidateTypes.length > 0) where.visaType = { in: candidateTypes };

      const rows = await prisma.visaRecord.findMany({
        where,
        select: {
          id: true,
          visaType: true,
          country: true,
          expiryDate: true,
          holderType: true,
          holderName: true,
          employee: { select: { name: true, email: true } },
        },
        orderBy: { expiryDate: "asc" },
        take: 20,
      });
      return {
        windowDays,
        filters: {
          country: country ?? null,
          visaTypeQuery: visaTypeQuery ?? null,
          candidateVisaTypes: candidateTypes,
        },
        total: rows.length,
        results: rows.map((r) => ({
          ...r,
          visaTypeLabel: visaTypeLabel(r.visaType),
        })),
      };
    },
  },
};

// 4. lookup_leave_balance
const lookupLeaveBalance: ToolEntry<{ employee?: string; year?: number }> = {
  definition: {
    name: "lookup_leave_balance",
    description:
      "Return per-leave-type balances (entitled, used, carried, remaining) for an employee in a given year. Querying the caller's own balance needs no extra permission; another employee requires leave:hr-read. Returns JSON string {employee, year, balances: [...]}.",
    input_schema: {
      type: "object",
      properties: {
        employee: {
          type: "string",
          description:
            'Name, email, employee ID, or "me". Defaults to the caller.',
        },
        year: {
          type: "integer",
          description:
            "Calendar year to look up. Defaults to the current year.",
          minimum: 2020,
          maximum: 2100,
        },
      },
      additionalProperties: false,
    },
  },
  handler: {
    schema: z.object({
      employee: z.string().min(1).max(120).optional(),
      year: z.number().int().min(2020).max(2100).optional(),
    }),
    async run({ employee, year }, { userId, perms }) {
      const target = employee
        ? await resolveEmployee(employee, userId)
        : await prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, name: true, email: true },
          });
      if (!target) {
        return { error: "not_found", message: "No matching employee." };
      }
      const isSelf = target.id === userId;
      const hasReadAll = perms.has(PERMISSIONS.LEAVE_HR_READ);
      if (!isSelf && !hasReadAll) {
        return {
          error: "permission_denied",
          message:
            "Looking up another employee's leave balance requires leave:hr-read.",
        };
      }
      const targetYear = year ?? new Date().getFullYear();
      const rows = await prisma.leaveBalance.findMany({
        where: { employeeId: target.id, year: targetYear },
        select: {
          leaveTypeId: true,
          entitled: true,
          used: true,
          carried: true,
          carriedUsed: true,
        },
      });
      const typeIds = rows.map((r) => r.leaveTypeId);
      const types = await prisma.leaveType.findMany({
        where: { id: { in: typeIds } },
        select: { id: true, name: true, code: true, isPaid: true },
      });
      const typeMap = new Map(types.map((t) => [t.id, t]));
      const balances = rows.map((r) => {
        const t = typeMap.get(r.leaveTypeId);
        const entitled = safeNumber(r.entitled);
        const used = safeNumber(r.used);
        const carried = safeNumber(r.carried);
        const carriedUsed = safeNumber(r.carriedUsed);
        return {
          leaveTypeId: r.leaveTypeId,
          leaveTypeName: t?.name ?? null,
          leaveTypeCode: t?.code ?? null,
          isPaid: t?.isPaid ?? null,
          entitled,
          used,
          carried,
          carriedUsed,
          remaining: entitled - used + (carried - carriedUsed),
        };
      });
      return { employee: target, year: targetYear, balances };
    },
  },
};

// 5. list_my_pending_approvals
const listMyPendingApprovals: ToolEntry<Record<string, never>> = {
  definition: {
    name: "list_my_pending_approvals",
    description:
      "List items waiting for the caller as the designated approver (leave, travel, expense). No arguments. Returns JSON string {leave: number, travel: number, expense: number, items: [...]}.",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  handler: {
    schema: z.object({}),
    async run(_args, { userId }) {
      const [leave, travel, expense] = await Promise.all([
        prisma.leaveApprovalDecision.findMany({
          where: {
            status: "pending",
            approverUserId: userId,
            leaveRequest: { status: "pending" },
          },
          select: {
            id: true,
            leaveRequest: {
              select: {
                id: true,
                startDate: true,
                endDate: true,
                days: true,
                reason: true,
                employee: { select: { name: true, email: true } },
              },
            },
          },
          take: 10,
        }),
        prisma.travelApprovalDecision.findMany({
          where: {
            status: "pending",
            approverUserId: userId,
            travelRequest: { status: "pending" },
          },
          select: {
            id: true,
            travelRequest: {
              select: {
                id: true,
                destination: true,
                departureDate: true,
                returnDate: true,
                purpose: true,
                employee: { select: { name: true, email: true } },
              },
            },
          },
          take: 10,
        }),
        prisma.expenseApprovalDecision.findMany({
          where: {
            status: "pending",
            approverUserId: userId,
            expenseReport: { status: "submitted" },
          },
          select: {
            id: true,
            expenseReport: {
              select: {
                id: true,
                title: true,
                period: true,
                employee: { select: { name: true, email: true } },
              },
            },
          },
          take: 10,
        }),
      ]);
      return {
        leave: leave.length,
        travel: travel.length,
        expense: expense.length,
        items: {
          leave: leave.map((d) => d.leaveRequest),
          travel: travel.map((d) => d.travelRequest),
          expense: expense.map((d) => d.expenseReport),
        },
      };
    },
  },
};

// 6. lookup_expense_report
const lookupExpenseReport: ToolEntry<{
  query: string;
  status?: string;
}> = {
  definition: {
    name: "lookup_expense_report",
    description:
      "Find expense reports owned by an employee, or by a report id. Caller can always see their own; viewing another employee's reports requires expense:hr-read or accounting:read. Returns JSON string {results: [...]} with id, title, period, status, total, currency.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'Employee name/email/id, report id, or "me" for the caller\'s reports.',
        },
        status: {
          type: "string",
          description:
            "Optional status filter: draft | submitted | approved | rejected | paid.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  handler: {
    schema: z.object({
      query: z.string().min(1).max(120),
      status: z
        .enum(["draft", "submitted", "approved", "rejected", "paid"])
        .optional(),
    }),
    async run({ query, status }, { userId, perms }) {
      // Direct report id hit first — cheap and avoids the name resolve.
      if (
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          query.trim(),
        )
      ) {
        const report = await prisma.expenseReport.findUnique({
          where: { id: query.trim() },
          select: {
            id: true,
            employeeId: true,
            title: true,
            period: true,
            status: true,
            employee: { select: { name: true, email: true } },
          },
        });
        if (!report) return { error: "not_found" };
        const isSelf = report.employeeId === userId;
        if (
          !isSelf &&
          !perms.has(PERMISSIONS.EXPENSE_HR_READ) &&
          !perms.has(PERMISSIONS.ACCOUNTING_READ) &&
          !perms.has(PERMISSIONS.ACCOUNTING_ADMIN)
        ) {
          return { error: "permission_denied" };
        }
        return { results: [report] };
      }

      const target = await resolveEmployee(query, userId);
      if (!target) return { error: "not_found" };
      const isSelf = target.id === userId;
      const hasReadAll =
        perms.has(PERMISSIONS.EXPENSE_HR_READ) ||
        perms.has(PERMISSIONS.ACCOUNTING_READ) ||
        perms.has(PERMISSIONS.ACCOUNTING_ADMIN);
      if (!isSelf && !hasReadAll) {
        return { error: "permission_denied" };
      }
      const rows = await prisma.expenseReport.findMany({
        where: {
          employeeId: target.id,
          ...(status && { status }),
        },
        select: {
          id: true,
          title: true,
          period: true,
          status: true,
          category: true,
        },
        orderBy: { createdAt: "desc" },
        take: MAX_RESULTS,
      });
      return { employee: target, results: rows };
    },
  },
};

// 7. lookup_helpdesk_ticket
const lookupHelpdeskTicket: ToolEntry<{ query: string }> = {
  definition: {
    name: "lookup_helpdesk_ticket",
    description:
      'Find IT helpdesk tickets by ticket number, title fragment, or by the caller ("my tickets"). Caller can always see their own tickets; viewing others requires helpdesk:read-all. Returns JSON string {results: [...]}.',
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'Ticket number (e.g. "42"), title fragment, or "me"/"my" for the caller\'s open tickets.',
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  handler: {
    schema: z.object({ query: z.string().min(1).max(120) }),
    async run({ query }, { userId, perms }) {
      const trimmed = query.trim().toLowerCase();
      const hasReadAll =
        perms.has("helpdesk:read-all") ||
        perms.has("admin:read") ||
        perms.has("admin:manage");

      // Numeric → ticket_number lookup.
      const asNumber = Number(trimmed);
      if (Number.isInteger(asNumber) && asNumber > 0) {
        const ticket = await prisma.helpdeskTicket.findUnique({
          where: { ticketNumber: asNumber },
          select: {
            id: true,
            ticketNumber: true,
            title: true,
            category: true,
            priority: true,
            status: true,
            createdById: true,
            createdBy: { select: { name: true, email: true } },
            assignee: { select: { name: true, email: true } },
            createdAt: true,
          },
        });
        if (!ticket) return { error: "not_found" };
        if (ticket.createdById !== userId && !hasReadAll) {
          return { error: "permission_denied" };
        }
        return { results: [ticket] };
      }

      const baseWhere =
        trimmed === "me" || trimmed === "my" || trimmed === "mine"
          ? { createdById: userId }
          : {
              title: { contains: query, mode: "insensitive" as const },
              ...(hasReadAll ? {} : { createdById: userId }),
            };

      const rows = await prisma.helpdeskTicket.findMany({
        where: baseWhere,
        select: {
          id: true,
          ticketNumber: true,
          title: true,
          category: true,
          priority: true,
          status: true,
          createdBy: { select: { name: true, email: true } },
          assignee: { select: { name: true, email: true } },
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: MAX_RESULTS,
      });
      return { results: rows };
    },
  },
};

// 8. lookup_partner
const lookupPartner: ToolEntry<{ query: string }> = {
  definition: {
    name: "lookup_partner",
    description:
      "Find partner records by company name fragment. Requires partners:read. Returns JSON string {results: [...]} with company, type, status, country, contractValue, contractEnd.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Company name fragment.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  handler: {
    schema: z.object({ query: z.string().min(1).max(120) }),
    async run({ query }, { perms }) {
      if (!perms.has(PERMISSIONS.PARTNERS_READ)) {
        return { error: "permission_denied" };
      }
      const rows = await prisma.partner.findMany({
        where: { company: { contains: query, mode: "insensitive" } },
        select: {
          id: true,
          company: true,
          type: true,
          status: true,
          country: true,
          contractValue: true,
          contractEnd: true,
        },
        orderBy: { company: "asc" },
        take: MAX_RESULTS,
      });
      return {
        results: rows.map((r) => ({
          ...r,
          contractValue: safeNumber(r.contractValue),
        })),
      };
    },
  },
};

// 9. lookup_project
// `query` is optional — when omitted (e.g. user asks "how many
// projects are we doing?") the tool returns the most recently
// updated projects instead of erroring. Anthropic's Claude
// frequently invokes lookup tools with no args when the user phrases
// a question about totals or recency; requiring a string here used
// to surface as `Invalid args for lookup_project` in the chat
// transcript.
const lookupProject: ToolEntry<{ query?: string }> = {
  definition: {
    name: "lookup_project",
    description:
      "Find a project by name fragment, slug, or id, or — when no query is given — list the most recently updated projects (use for 'how many projects', 'show recent projects', etc.). Requires projects:read; callers without projects:read-all only see projects they own or are a member of. Returns JSON string {results: [...]} with name, status, owner, partner, start/end dates, progress.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Optional. Project name fragment, slug, or id. Omit to list recent projects.",
        },
      },
      additionalProperties: false,
    },
  },
  handler: {
    schema: z.object({ query: z.string().min(1).max(120).optional() }),
    async run({ query }, { userId, perms }) {
      if (!perms.has(PERMISSIONS.PROJECTS_READ)) {
        return { error: "permission_denied" };
      }
      const trimmed = query?.trim();
      const filters: Record<string, unknown>[] = [];
      if (trimmed) {
        filters.push({
          OR: [
            { id: trimmed },
            { slug: trimmed },
            { name: { contains: trimmed, mode: "insensitive" as const } },
          ],
        });
      }
      // Mirror ProjectService.list: projects:read is own/assigned;
      // projects:read-all unlocks the org-wide board.
      if (!perms.has(PERMISSIONS.PROJECTS_READ_ALL)) {
        filters.push({
          OR: [
            { ownerId: userId },
            { members: { some: { userId } } },
          ],
        });
      }
      const where =
        filters.length === 0
          ? {}
          : filters.length === 1
            ? filters[0]
            : { AND: filters };
      const [rows, total] = await Promise.all([
        prisma.project.findMany({
          where,
          select: {
            id: true,
            name: true,
            slug: true,
            status: true,
            progress: true,
            startDate: true,
            endDate: true,
            owner: { select: { name: true, email: true } },
            partner: { select: { company: true } },
          },
          orderBy: { updatedAt: "desc" },
          take: MAX_RESULTS,
        }),
        // Total count lets the model answer "how many projects" without
        // chasing pagination. Cheap — same `where` clause and Postgres
        // executes both in parallel.
        prisma.project.count({ where }),
      ]);
      return { results: rows, total };
    },
  },
};

// 10. search_policy — wraps the curated knowledge corpus as a tool so
//     the model can pick when to consult it (rather than relying on
//     the implicit knowledge block injected on every turn).
const searchPolicy: ToolEntry<{ query: string }> = {
  definition: {
    name: "search_policy",
    description:
      "Search the curated knowledge base (HR policies, immigration, finance, etc.) for articles relevant to a topic. Use this when the user asks a policy / process question whose answer lives in documentation rather than transactional data. Returns JSON string {results: [...]} with title, category, body.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Topic to look up (e.g. 'thai work permit renewal', 'expense per diem policy').",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  handler: {
    schema: z.object({ query: z.string().min(1).max(400) }),
    async run({ query }, { perms }) {
      const userPerms = perms;
      // Try vector first; on any failure fall back to keyword scoring
      // the same way the chat-time knowledge lookup does.
      try {
        const embedding = await generateEmbedding(query);
        if (embedding) {
          const literal = vectorLiteral(embedding);
          const rows = await ariaRepository.findKnowledgeByEmbedding(
            literal,
            10,
          );
          const filtered = rows
            .filter((r) => Number(r.distance) <= 0.6)
            .filter((r) => {
              if (r.requiredPermissions.length === 0) return true;
              return r.requiredPermissions.some((p) => userPerms.has(p));
            })
            .slice(0, 5)
            .map((r) => ({
              id: r.id,
              title: r.title,
              category: r.category,
              body: r.body,
              distance: Number(r.distance),
            }));
          if (filtered.length > 0) return { results: filtered };
        }
      } catch (err) {
        logger.warn("ARIA tool search_policy vector path failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      }
      const all = await ariaRepository.findActiveKnowledgeForRetrieval();
      const lower = query.toLowerCase();
      const scored = all
        .filter((a) => {
          if (a.requiredPermissions.length === 0) return true;
          return a.requiredPermissions.some((p) => userPerms.has(p));
        })
        .map((a) => {
          let score = 0;
          for (const kw of a.keywords) {
            const k = kw.toLowerCase().trim();
            if (k && lower.includes(k)) score += k.length;
          }
          if (score === 0 && lower.includes(a.title.toLowerCase())) {
            score = 5;
          }
          return { article: a, score };
        })
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
      return {
        results: scored.map((s) => ({
          id: s.article.id,
          title: s.article.title,
          category: s.article.category,
          body: s.article.body,
        })),
      };
    },
  },
};

// ── Sales CRM tools ────────────────────────────────────────────────

/**
 * RBAC for CRM tools:
 * - `crm:read` is the baseline read perm. Without it the tool refuses
 *   to disclose anything (even names).
 * - `crm:team-read` widens the scope to every account regardless of
 *   ownership. Without it, the tool restricts to rows owned by the
 *   caller. Mirrors the same scoping the REST controllers apply.
 */
function crmReadScope(perms: Set<string>): {
  allowed: boolean;
  ownerOnly: boolean;
} {
  if (!perms.has(PERMISSIONS.CRM_READ)) {
    return { allowed: false, ownerOnly: true };
  }
  return { allowed: true, ownerOnly: !perms.has(PERMISSIONS.CRM_TEAM_READ) };
}

const lookupAccount: ToolEntry<{ query: string }> = {
  definition: {
    name: "lookup_account",
    description:
      "Find a Sales CRM account by name fragment, domain, or country. Returns the account header, primary contacts, open opportunities, and the most recent activity entries. Use this when the user asks about a partner / customer relationship (e.g. 'what's the status on Safaricom?', 'when did we last hear from Vodacom?').",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Account name fragment, domain, or country (e.g. 'Safaricom', 'vodafone.com', 'Kenya').",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  handler: {
    schema: z.object({ query: z.string().min(1).max(120) }),
    async run({ query }, { userId, perms }) {
      const scope = crmReadScope(perms);
      if (!scope.allowed) {
        return {
          error: "permission_denied",
          message:
            "You do not have crm:read permission — cannot disclose account data.",
        };
      }
      const trimmed = query.trim();
      const where = {
        AND: [
          {
            OR: [
              { name: { contains: trimmed, mode: "insensitive" as const } },
              { domain: { contains: trimmed, mode: "insensitive" as const } },
              { country: { contains: trimmed, mode: "insensitive" as const } },
            ],
          },
          scope.ownerOnly ? { ownerId: userId } : {},
        ],
      };
      const accounts = await prisma.account.findMany({
        where,
        take: MAX_RESULTS,
        orderBy: { updatedAt: "desc" },
        include: {
          owner: { select: { id: true, name: true, email: true } },
          contacts: {
            where: { isPrimary: true },
            take: 3,
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              title: true,
            },
          },
          opportunities: {
            where: { stage: { notIn: ["closed_won", "closed_lost"] } },
            take: 5,
            orderBy: { updatedAt: "desc" },
            select: {
              id: true,
              name: true,
              stage: true,
              value: true,
              currency: true,
              probability: true,
              closeDate: true,
            },
          },
          activities: {
            take: 5,
            orderBy: { occurredAt: "desc" },
            select: {
              id: true,
              type: true,
              subject: true,
              body: true,
              occurredAt: true,
            },
          },
        },
      });
      return {
        results: accounts.map((a) => ({
          id: a.id,
          name: a.name,
          domain: a.domain,
          country: a.country,
          industry: a.industry,
          owner: a.owner,
          picName: a.picName,
          designation: a.designation,
          lastFollowUpDate: a.lastFollowUpDate,
          agreementSignedDate: a.agreementSignedDate,
          totalUsers: a.totalUsers,
          appUsers: a.appUsers,
          blocker: a.blocker,
          remarks: a.remarks,
          primaryContacts: a.contacts,
          openOpportunities: a.opportunities,
          recentActivities: a.activities,
        })),
      };
    },
  },
};

const lookupOpportunity: ToolEntry<{ query: string }> = {
  definition: {
    name: "lookup_opportunity",
    description:
      "Find a Sales CRM opportunity by name or account name. Returns stage, value, probability, close date, owner, account, and the latest activity entries. Use this when the user asks about deal progress (e.g. 'how's the GrameenPhone proposal looking?').",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Opportunity name fragment or account name (e.g. 'GrameenPhone', 'Q3 expansion').",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  handler: {
    schema: z.object({ query: z.string().min(1).max(120) }),
    async run({ query }, { userId, perms }) {
      const scope = crmReadScope(perms);
      if (!scope.allowed) {
        return {
          error: "permission_denied",
          message:
            "You do not have crm:read permission — cannot disclose opportunity data.",
        };
      }
      const trimmed = query.trim();
      const where = {
        AND: [
          {
            OR: [
              { name: { contains: trimmed, mode: "insensitive" as const } },
              {
                account: {
                  name: { contains: trimmed, mode: "insensitive" as const },
                },
              },
            ],
          },
          scope.ownerOnly ? { ownerId: userId } : {},
        ],
      };
      const opps = await prisma.opportunity.findMany({
        where,
        take: MAX_RESULTS,
        orderBy: { updatedAt: "desc" },
        include: {
          owner: { select: { id: true, name: true, email: true } },
          account: { select: { id: true, name: true, country: true } },
          contact: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
          activities: {
            take: 5,
            orderBy: { occurredAt: "desc" },
            select: {
              id: true,
              type: true,
              subject: true,
              occurredAt: true,
            },
          },
        },
      });
      return { results: opps };
    },
  },
};

const listMyPipeline: ToolEntry<Record<string, never>> = {
  definition: {
    name: "list_my_pipeline",
    description:
      "Summarise the requesting officer's open Sales CRM pipeline grouped by stage. Returns count + total value + weighted-by-probability value per stage. Use this for self-status queries ('how does my pipeline look?', 'what's in negotiation?').",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  handler: {
    schema: z.object({}),
    async run(_args, { userId, perms }) {
      if (!perms.has(PERMISSIONS.CRM_READ)) {
        return {
          error: "permission_denied",
          message: "You do not have crm:read permission.",
        };
      }
      const opps = await prisma.opportunity.findMany({
        where: {
          ownerId: userId,
          stage: { notIn: ["closed_won", "closed_lost"] },
        },
        select: {
          id: true,
          name: true,
          stage: true,
          value: true,
          currency: true,
          probability: true,
          closeDate: true,
          account: { select: { id: true, name: true } },
        },
        orderBy: { closeDate: "asc" },
      });
      const byStage: Record<
        string,
        { count: number; totalValue: number; weightedValue: number }
      > = {};
      for (const o of opps) {
        const stage = o.stage;
        const v = Number(o.value);
        if (!byStage[stage]) {
          byStage[stage] = { count: 0, totalValue: 0, weightedValue: 0 };
        }
        byStage[stage].count += 1;
        byStage[stage].totalValue += v;
        byStage[stage].weightedValue += v * (o.probability / 100);
      }
      return {
        stages: byStage,
        opportunities: opps,
      };
    },
  },
};

const accountEmailSummary: ToolEntry<{ query: string; limit?: number }> = {
  definition: {
    name: "account_email_summary",
    description:
      "List the most recent email exchanges logged against a Sales CRM account (sourced from the Gmail auto-sync feed). Use this when the user asks 'when did we last email Safaricom?' or 'show me the email thread with Vodacom'.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Account name fragment (e.g. 'Safaricom').",
        },
        limit: {
          type: "number",
          description: "How many recent emails to return. Defaults to 10.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  handler: {
    schema: z.object({
      query: z.string().min(1).max(120),
      limit: z.coerce.number().int().min(1).max(50).optional(),
    }),
    async run({ query, limit }, { userId, perms }) {
      const scope = crmReadScope(perms);
      if (!scope.allowed) {
        return {
          error: "permission_denied",
          message: "You do not have crm:read permission.",
        };
      }
      const accountFilter = {
        name: { contains: query.trim(), mode: "insensitive" as const },
      };
      const account = await prisma.account.findFirst({
        where: scope.ownerOnly
          ? { AND: [accountFilter, { ownerId: userId }] }
          : accountFilter,
        select: { id: true, name: true },
      });
      if (!account) {
        return {
          error: `No account matched "${query}" (within your visible scope).`,
        };
      }
      const emails = await prisma.crmActivity.findMany({
        where: { accountId: account.id, type: "email" },
        take: limit ?? 10,
        orderBy: { occurredAt: "desc" },
        select: {
          id: true,
          subject: true,
          body: true,
          occurredAt: true,
          owner: { select: { name: true, email: true } },
        },
      });
      return {
        account,
        emails,
      };
    },
  },
};

// ── Calendar tool (ARIA improvement #4, 2026-05-25) ────────────────

interface CalendarEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: Array<{
    email: string;
    displayName?: string;
    responseStatus?: string;
  }>;
  hangoutLink?: string;
  htmlLink?: string;
}

interface CalendarListResponse {
  items?: CalendarEvent[];
  nextPageToken?: string;
}

const lookupMyCalendar: ToolEntry<{
  fromDate?: string;
  toDate?: string;
  maxResults?: number;
}> = {
  definition: {
    name: "lookup_my_calendar",
    description:
      "List the requesting officer's Google Calendar events for an optional date range. Default window is now → +7 days. Returns event time, attendees, location, and meeting link. Use this when the user asks 'what's on my calendar?', 'when am I free?', 'who am I meeting tomorrow?'.",
    input_schema: {
      type: "object",
      properties: {
        fromDate: {
          type: "string",
          description:
            "ISO date or datetime for the window start (e.g. '2026-05-25' or '2026-05-25T09:00:00Z'). Defaults to now.",
        },
        toDate: {
          type: "string",
          description:
            "ISO date or datetime for the window end. Defaults to fromDate + 7 days.",
        },
        maxResults: {
          type: "number",
          description: "Cap on events returned (default 25, max 50).",
        },
      },
      additionalProperties: false,
    },
  },
  handler: {
    schema: z.object({
      fromDate: z.string().min(1).max(50).optional(),
      toDate: z.string().min(1).max(50).optional(),
      maxResults: z.coerce.number().int().min(1).max(50).optional(),
    }),
    async run({ fromDate, toDate, maxResults }, { userId, perms }) {
      if (!perms.has(PERMISSIONS.INTEGRATIONS_USE)) {
        return {
          error: "permission_denied",
          message:
            "You do not have the integrations:use permission required to read your calendar.",
        };
      }
      const { googleTokenRepository } =
        await import("@/modules/integrations/google-token.repository");
      let accessToken: string;
      try {
        const { accessToken: tok } =
          await googleTokenRepository.getValid(userId);
        accessToken = tok;
      } catch (err) {
        if (err instanceof Error && err.message === "GOOGLE_NOT_CONNECTED") {
          return {
            error: "google_not_connected",
            message:
              "Google account not connected. Reconnect in Settings → Integrations.",
          };
        }
        throw err;
      }
      const now = new Date();
      const start = fromDate ? new Date(fromDate) : now;
      const defaultEnd = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
      const end = toDate ? new Date(toDate) : defaultEnd;
      const params = new URLSearchParams({
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        maxResults: String(maxResults ?? 25),
        singleEvents: "true",
        orderBy: "startTime",
      });
      const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        const body = await res.text();
        // 403 with insufficient-scope = user predates the calendar
        // scope; tell ARIA to nudge a reconnect.
        if (res.status === 403 && body.includes("insufficient")) {
          return {
            error: "calendar_scope_required",
            message:
              "Calendar scope missing on your Google connection. Reconnect Google in Settings to grant calendar read access.",
          };
        }
        logger.warn("ARIA lookup_my_calendar fetch failed", {
          status: res.status,
          body: body.slice(0, 300),
        });
        return {
          error: "calendar_fetch_failed",
          message: `Google Calendar returned ${res.status}.`,
        };
      }
      const data = (await res.json()) as CalendarListResponse;
      const items = (data.items ?? []).map((e) => ({
        id: e.id,
        summary: e.summary ?? "(no title)",
        start: e.start?.dateTime ?? e.start?.date ?? null,
        end: e.end?.dateTime ?? e.end?.date ?? null,
        timezone: e.start?.timeZone ?? null,
        location: e.location ?? null,
        meetingLink: e.hangoutLink ?? null,
        eventLink: e.htmlLink ?? null,
        attendees:
          e.attendees?.map((a) => ({
            email: a.email,
            displayName: a.displayName ?? null,
            responseStatus: a.responseStatus ?? null,
          })) ?? [],
      }));
      return {
        window: { from: start.toISOString(), to: end.toISOString() },
        events: items,
      };
    },
  },
};

// ── Write tool: submit_leave_request (ARIA improvement #7) ─────────

const submitLeaveRequest: ToolEntry<{
  leaveType: string;
  startDate: string;
  endDate: string;
  reason?: string;
}> = {
  definition: {
    name: "submit_leave_request",
    description:
      "Draft a leave request for the requesting officer (e.g. annual, sick, personal). DOES NOT submit immediately — emits a signed `aria-confirm` block that the user must Approve in the chat UI before the request is filed. Use this when the user clearly asks Manut AI to file leave on their behalf.",
    input_schema: {
      type: "object",
      properties: {
        leaveType: {
          type: "string",
          description:
            "Leave type name as displayed to HR (e.g. 'Annual leave', 'Sick leave', 'Personal'). The tool resolves this to the canonical leave_types row before drafting.",
        },
        startDate: {
          type: "string",
          description: "First day of leave, YYYY-MM-DD.",
        },
        endDate: {
          type: "string",
          description:
            "Last day of leave inclusive, YYYY-MM-DD. Must be >= startDate.",
        },
        reason: {
          type: "string",
          description: "Optional free-text reason (<= 1000 chars).",
        },
      },
      required: ["leaveType", "startDate", "endDate"],
      additionalProperties: false,
    },
  },
  handler: {
    schema: z.object({
      leaveType: z.string().min(1).max(100),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      reason: z.string().max(1000).optional(),
    }),
    async run({ leaveType, startDate, endDate, reason }, { userId, perms }) {
      if (!perms.has(PERMISSIONS.LEAVE_REQUEST)) {
        return {
          error: "permission_denied",
          message:
            "You do not have the leave:request permission required to file leave.",
        };
      }
      if (endDate < startDate) {
        return {
          error: "invalid_range",
          message: "endDate must be on or after startDate.",
        };
      }
      const type = await prisma.leaveType.findFirst({
        where: {
          isActive: true,
          name: { contains: leaveType.trim(), mode: "insensitive" },
        },
        select: { id: true, name: true, code: true },
      });
      if (!type) {
        return {
          error: "leave_type_not_found",
          message: `No active leave type matches "${leaveType}".`,
        };
      }
      const { signActionToken } =
        await import("@/modules/aria/aria-action-tokens");
      const params = {
        leaveTypeId: type.id,
        startDate,
        endDate,
        reason: reason?.trim() || undefined,
      };
      const token = signActionToken({
        action: "submit_leave_request",
        userId,
        params,
      });
      // The "confirm" payload triggers the assistant to wrap the
      // result inside an `aria-confirm` fenced block per the system
      // prompt's interactive-blocks section.
      return {
        confirm: {
          action: "submit_leave_request",
          token,
          summary: `Submit ${type.name} from ${startDate} to ${endDate}`,
          params: {
            leaveType: type.name,
            startDate,
            endDate,
            reason: params.reason ?? null,
          },
        },
      };
    },
  },
};

// ── Memory forget (ARIA improvement #6, 2026-05-25) ────────────────

const ariaMemoryForget: ToolEntry<{ matching: string }> = {
  definition: {
    name: "aria_memory_forget",
    description:
      "Delete pinned memory entries on this conversation whose key or value contains the given fragment (case-insensitive). Use this when the requesting officer says 'forget …' or asks Manut AI to drop a previously-remembered fact. Returns the deleted entries so the response can acknowledge what was forgotten.",
    input_schema: {
      type: "object",
      properties: {
        matching: {
          type: "string",
          description:
            "Substring to match against memory key or value (e.g. 'meal preference', 'Manut Vietnam').",
        },
      },
      required: ["matching"],
      additionalProperties: false,
    },
  },
  handler: {
    schema: z.object({ matching: z.string().min(1).max(200) }),
    async run({ matching }, { conversationId }) {
      if (!conversationId) {
        return {
          error: "no_conversation",
          message: "This tool only runs inside an active Manut AI conversation.",
        };
      }
      const deleted = await ariaRepository.deleteMemoryEntriesMatching(
        conversationId,
        matching,
      );
      return { deleted };
    },
  },
};

// ── Registry ────────────────────────────────────────────────────────

const REGISTRY: Record<string, ToolEntry<never>> = {
  lookup_employee: lookupEmployee as ToolEntry<never>,
  lookup_visa: lookupVisa as ToolEntry<never>,
  list_expiring_visas: listExpiringVisas as ToolEntry<never>,
  lookup_leave_balance: lookupLeaveBalance as ToolEntry<never>,
  list_my_pending_approvals: listMyPendingApprovals as ToolEntry<never>,
  lookup_expense_report: lookupExpenseReport as ToolEntry<never>,
  lookup_helpdesk_ticket: lookupHelpdeskTicket as ToolEntry<never>,
  lookup_partner: lookupPartner as ToolEntry<never>,
  lookup_project: lookupProject as ToolEntry<never>,
  search_policy: searchPolicy as ToolEntry<never>,
  lookup_account: lookupAccount as ToolEntry<never>,
  lookup_opportunity: lookupOpportunity as ToolEntry<never>,
  list_my_pipeline: listMyPipeline as ToolEntry<never>,
  account_email_summary: accountEmailSummary as ToolEntry<never>,
  lookup_my_calendar: lookupMyCalendar as ToolEntry<never>,
  aria_memory_forget: ariaMemoryForget as ToolEntry<never>,
  submit_leave_request: submitLeaveRequest as ToolEntry<never>,
};

export function toolDefinitions(): ToolDefinition[] {
  return Object.values(REGISTRY).map((t) => t.definition);
}

/**
 * Permission gates for advertising tools to the model. Empty = always
 * exposed (tool still enforces ownership / finer gates in the handler).
 * Values are OR'd — any matching code is enough to advertise the tool.
 */
const TOOL_REQUIRED_ANY_OF: Record<string, readonly string[]> = {
  lookup_employee: [PERMISSIONS.DIRECTORY_READ],
  lookup_visa: [
    PERMISSIONS.VISA_READ,
    PERMISSIONS.VISA_HR_READ,
    PERMISSIONS.VISA_MANAGE,
  ],
  list_expiring_visas: [
    PERMISSIONS.VISA_HR_READ,
    PERMISSIONS.VISA_MANAGE,
  ],
  lookup_leave_balance: [],
  list_my_pending_approvals: [],
  lookup_expense_report: [],
  lookup_helpdesk_ticket: [],
  lookup_partner: [PERMISSIONS.PARTNERS_READ],
  lookup_project: [PERMISSIONS.PROJECTS_READ],
  search_policy: [],
  lookup_account: [PERMISSIONS.CRM_READ],
  lookup_opportunity: [PERMISSIONS.CRM_READ],
  list_my_pipeline: [PERMISSIONS.CRM_READ],
  account_email_summary: [PERMISSIONS.CRM_READ],
  lookup_my_calendar: [PERMISSIONS.INTEGRATIONS_USE],
  aria_memory_forget: [],
  submit_leave_request: [PERMISSIONS.LEAVE_REQUEST],
};

/**
 * Tools the model may call for this caller. Forbidden tools are omitted
 * so they cannot burn a tool-loop iteration on a known permission deny.
 */
export function toolDefinitionsFor(perms: Set<string>): ToolDefinition[] {
  return Object.entries(REGISTRY)
    .filter(([name]) => {
      const need = TOOL_REQUIRED_ANY_OF[name] ?? [];
      if (need.length === 0) return true;
      return need.some((p) => perms.has(p));
    })
    .map(([, entry]) => entry.definition);
}

/**
 * Test-friendly: list the tool names currently exposed to Anthropic.
 * Lets evals enforce a stable set without importing the full registry.
 */
export function toolNames(): string[] {
  return Object.keys(REGISTRY);
}

export interface ExecuteResult {
  ok: boolean;
  name: string;
  toolUseId: string;
  /** JSON-stringified payload returned to Anthropic via `tool_result`. */
  resultJson: string;
  /** Short summary surfaced to the UI (e.g. "Looked up Alice Lee"). */
  summary: string;
}

function buildSummary(name: string, args: Record<string, unknown>): string {
  // Best-effort label for the UI pill. Falls back to the tool name.
  switch (name) {
    case "lookup_employee":
      return `Looking up employee: ${truncate(args.query)}`;
    case "lookup_visa":
      return `Checking visa for ${truncate(args.employee)}`;
    case "list_expiring_visas":
      return `Listing visas expiring within ${args.days ?? VISA_DEFAULT_WINDOW_DAYS} days`;
    case "lookup_leave_balance":
      return `Checking leave balance for ${truncate(args.employee) ?? "me"}`;
    case "list_my_pending_approvals":
      return "Pulling your pending approvals";
    case "lookup_expense_report":
      return `Finding expense reports for ${truncate(args.query)}`;
    case "lookup_helpdesk_ticket":
      return `Searching helpdesk: ${truncate(args.query)}`;
    case "lookup_partner":
      return `Searching partners: ${truncate(args.query)}`;
    case "lookup_project":
      return `Looking up project: ${truncate(args.query)}`;
    case "search_policy":
      return `Searching policies: ${truncate(args.query)}`;
    case "lookup_account":
      return `Looking up account: ${truncate(args.query)}`;
    case "lookup_opportunity":
      return `Looking up opportunity: ${truncate(args.query)}`;
    case "list_my_pipeline":
      return "Summarising your CRM pipeline";
    case "account_email_summary":
      return `Recent emails for account: ${truncate(args.query)}`;
    case "lookup_my_calendar":
      return "Checking your calendar";
    case "aria_memory_forget":
      return `Forgetting: ${truncate(args.matching)}`;
    case "submit_leave_request":
      return `Drafting leave: ${truncate(args.leaveType)}`;
    default:
      return name;
  }
}

function truncate(value: unknown, max = 40): string {
  if (typeof value !== "string") return "";
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * Dispatch a single tool_use block from Anthropic. Always returns an
 * `ExecuteResult` — on failure we still hand back a JSON-string error
 * payload so the model can recover gracefully on the next turn.
 */
export async function executeTool(
  block: {
    id: string;
    name: string;
    input: Record<string, unknown>;
  },
  ctx: ToolContext,
): Promise<ExecuteResult> {
  const entry = REGISTRY[block.name] as ToolEntry<unknown> | undefined;
  if (!entry) {
    const payload = { error: "unknown_tool", name: block.name };
    return {
      ok: false,
      name: block.name,
      toolUseId: block.id,
      resultJson: JSON.stringify(payload),
      summary: `Unknown tool ${block.name}`,
    };
  }
  const parsed = entry.handler.schema.safeParse(block.input ?? {});
  if (!parsed.success) {
    const payload = {
      error: "invalid_arguments",
      detail: parsed.error.flatten(),
    };
    return {
      ok: false,
      name: block.name,
      toolUseId: block.id,
      resultJson: JSON.stringify(payload),
      summary: `Invalid args for ${block.name}`,
    };
  }
  try {
    const result = await entry.handler.run(parsed.data, ctx);
    const json = JSON.stringify(result);
    return {
      ok: true,
      name: block.name,
      toolUseId: block.id,
      resultJson: json.length > 50_000 ? json.slice(0, 50_000) : json,
      summary: buildSummary(block.name, block.input ?? {}),
    };
  } catch (err) {
    logger.warn("ARIA tool execution failed", {
      tool: block.name,
      err: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      name: block.name,
      toolUseId: block.id,
      resultJson: JSON.stringify({ error: "tool_failed" }),
      summary: `${block.name} failed`,
    };
  }
}

export async function loadToolContext(
  userId: string,
  conversationId?: string,
): Promise<ToolContext> {
  const perms = await loadUserPermissions(userId);
  return { userId, perms, conversationId };
}
