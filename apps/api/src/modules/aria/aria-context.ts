import type { Prisma } from "@nexora/database";

import { PERMISSIONS } from "@/common/constants/permissions";
import { logger } from "@/common/utils/logger";
import { loadUserPermissions } from "@/core/guards/auth.guard";
import { prisma } from "@/infrastructure/database/prisma";

interface EntityFinancials {
  name: string;
  code: string;
  revenue: number;
  expenses: number;
  netIncome: number;
}

interface PartnerSummary {
  company: string;
  type: string;
  status: string;
  country: string | null;
}

interface SalesPipelineStage {
  stage: string;
  /** Per-Opportunity currency — same row may exist twice with two ccys. */
  currency: string;
  count: number;
  totalValue: number;
}

interface SalesPipelineSummary {
  /** Per-(stage, currency) breakdown of opportunities visible to the caller. */
  stages: SalesPipelineStage[];
  /** Open (non-terminal) leads visible to the caller. */
  openLeads: number;
}

interface InvestorKpis {
  totalInvestors: number;
  totalCommitted: number;
  totalReceived: number;
}

interface PeopleSnapshot {
  employeeCount: number;
  departmentBreakdown: Record<string, number>;
  /**
   * Active-headcount per entity (e.g. "Manut Thailand" → 23). Drives
   * questions like "how many employees in the Thailand office?" — the
   * canonical answer is the FK `User.entityId`, not the free-text
   * `location` / `country` columns which are often blank or stale.
   * `Unassigned` bucket captures users with `entityId = null`.
   */
  entityBreakdown: Record<string, number>;
}

/**
 * Per-user counters scoped to the caller's own rows. Surfaced so ARIA
 * can answer "what's pending for me?" questions without any extra perm
 * — every employee can see their own work.
 */
interface PersonalSnapshot {
  pendingLeaveRequests: number;
  upcomingApprovedTravel: number;
  draftExpenseReports: number;
  submittedExpenseReports: number;
  openHelpdeskTickets: number;
  awaitingMyApprovalLeave: number;
  awaitingMyApprovalTravel: number;
  awaitingMyApprovalExpense: number;
}

/**
 * Caller identity injected into the system prompt so the assistant
 * knows *who* it is talking to. Without this block ARIA cannot tie
 * follow-up turns ("my team", "for me") back to a real employee
 * record. Roles list is the caller's role names — feature flags /
 * scoping checks still happen via `loadUserPermissions`, not from
 * this block.
 */
interface CallerProfile {
  id: string;
  name: string;
  email: string;
  jobTitle: string | null;
  department: string | null;
  entityName: string | null;
  entityCode: string | null;
  location: string | null;
  country: string | null;
  managerName: string | null;
  startDate: string | null;
  roles: string[];
}

/** Workspace metrics gated by the caller's RBAC; `null` = no permission (do not query / show). */
interface WorkspaceSnapshot {
  caller: CallerProfile | null;
  entities: EntityFinancials[];
  people: PeopleSnapshot | null;
  partners: PartnerSummary[] | null;
  salesPipeline: SalesPipelineSummary | null;
  investorKpis: InvestorKpis | null;
  pendingExpenses: number | null;
  expiringVisas: number | null;
  activeProjects: number | null;
  pendingLeaveRequests: number | null;
  /** Caller-scoped rows. Always populated (no permission gate). */
  personal: PersonalSnapshot;
  omittedDataDomains: string[];
}

function canSeeRevenueFigures(perms: Set<string>): boolean {
  return (
    perms.has(PERMISSIONS.REVENUE_READ) ||
    perms.has(PERMISSIONS.ACCOUNTING_READ) ||
    perms.has(PERMISSIONS.ACCOUNTING_ADMIN)
  );
}

function canSeeExpenseFigures(perms: Set<string>): boolean {
  return (
    perms.has(PERMISSIONS.EXPENSE_READ) ||
    perms.has(PERMISSIONS.EXPENSE_HR_READ) ||
    perms.has(PERMISSIONS.EXPENSE_APPROVE) ||
    perms.has(PERMISSIONS.ACCOUNTING_READ) ||
    perms.has(PERMISSIONS.ACCOUNTING_ADMIN)
  );
}

function canSeePeopleRollup(perms: Set<string>): boolean {
  return (
    perms.has(PERMISSIONS.DIRECTORY_READ) ||
    perms.has(PERMISSIONS.USER_READ) ||
    perms.has(PERMISSIONS.ADMIN_READ) ||
    perms.has(PERMISSIONS.ADMIN_MANAGE)
  );
}

function canSeePartners(perms: Set<string>): boolean {
  return perms.has(PERMISSIONS.PARTNERS_READ);
}

function canSeeSalesCrm(perms: Set<string>): boolean {
  // BD-feedback (Vivek, May 2026) — Sales CRM v2 is the source of truth.
  // The legacy `deals` permission still gates the retired surface; ARIA's
  // workspace context now reads from `crm:read` (own) / `crm:team-read`
  // (all) so the assistant sees the same pipeline rendered on /sales.
  return (
    perms.has(PERMISSIONS.CRM_READ) || perms.has(PERMISSIONS.CRM_TEAM_READ)
  );
}

function canSeeInvestors(perms: Set<string>): boolean {
  return (
    perms.has(PERMISSIONS.INVESTORS_READ) ||
    perms.has(PERMISSIONS.INVESTORS_READ_ALL) ||
    perms.has(PERMISSIONS.INVESTOR_DASHBOARD_READ) ||
    perms.has(PERMISSIONS.INVESTOR_CRM_READ)
  );
}

function canSeePendingExpenseCount(perms: Set<string>): boolean {
  return (
    perms.has(PERMISSIONS.EXPENSE_READ) ||
    perms.has(PERMISSIONS.EXPENSE_APPROVE) ||
    perms.has(PERMISSIONS.EXPENSE_HR_READ) ||
    perms.has(PERMISSIONS.ACCOUNTING_READ) ||
    perms.has(PERMISSIONS.ACCOUNTING_ADMIN)
  );
}

function canSeeVisaExpiryRollup(perms: Set<string>): boolean {
  return (
    perms.has(PERMISSIONS.VISA_READ) ||
    perms.has(PERMISSIONS.VISA_HR_READ) ||
    perms.has(PERMISSIONS.VISA_MANAGE)
  );
}

function canSeeProjectCounts(perms: Set<string>): boolean {
  return perms.has(PERMISSIONS.PROJECTS_READ);
}

function canSeeLeaveQueueRollup(perms: Set<string>): boolean {
  return (
    perms.has(PERMISSIONS.LEAVE_READ) ||
    perms.has(PERMISSIONS.LEAVE_APPROVE) ||
    perms.has(PERMISSIONS.LEAVE_HR_READ) ||
    perms.has(PERMISSIONS.LEAVE_REQUEST) ||
    perms.has(PERMISSIONS.LEAVE_TEAM_CALENDAR)
  );
}

async function gatherWorkspaceSnapshot(
  userId: string,
  perms: Set<string>,
): Promise<WorkspaceSnapshot> {
  const omittedDataDomains: string[] = [];

  const seeRev = canSeeRevenueFigures(perms);
  const seeExp = canSeeExpenseFigures(perms);
  if (!seeRev && !seeExp) {
    omittedDataDomains.push("entity financials");
  }

  const [
    caller,
    entityFinancials,
    people,
    partners,
    salesPipeline,
    investorKpis,
    pendingExpenses,
    expiringVisas,
    activeProjects,
    pendingLeaveRequests,
    personal,
  ] = await Promise.all([
    getCallerProfile(userId),
    getEntityFinancials(seeRev, seeExp),
    getPeopleSnapshot(perms, omittedDataDomains),
    getPartnerSummary(perms, omittedDataDomains),
    getSalesPipeline(userId, perms, omittedDataDomains),
    getInvestorKpis(perms, omittedDataDomains),
    countPendingExpenses(perms, omittedDataDomains),
    countVisasExpiringWithinDays(perms, 90, omittedDataDomains),
    countActiveProjects(perms, omittedDataDomains),
    countPendingLeave(perms, omittedDataDomains),
    getPersonalSnapshot(userId),
  ]);

  return {
    caller,
    entities: entityFinancials,
    people,
    partners,
    salesPipeline,
    investorKpis,
    pendingExpenses,
    expiringVisas,
    activeProjects,
    pendingLeaveRequests,
    personal,
    omittedDataDomains,
  };
}

/**
 * Fetch the caller's profile in a single query. We only ever expose
 * non-sensitive identity fields here (no salary, no national-ID, no
 * passport) — sensitive HR data must continue to flow through the
 * tool-call path that re-checks permissions per request. Returns
 * `null` if the user row is missing (shouldn't happen for an
 * authenticated request, but we'd rather degrade than throw).
 */
async function getCallerProfile(userId: string): Promise<CallerProfile | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      jobTitle: true,
      department: true,
      location: true,
      country: true,
      startDate: true,
      entity: { select: { name: true, code: true } },
      manager: { select: { name: true } },
      userRoles: { select: { role: { select: { name: true } } } },
    },
  });
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    jobTitle: user.jobTitle,
    department: user.department,
    entityName: user.entity?.name ?? null,
    entityCode: user.entity?.code ?? null,
    location: user.location,
    country: user.country,
    managerName: user.manager?.name ?? null,
    startDate: user.startDate
      ? user.startDate.toISOString().slice(0, 10)
      : null,
    roles: user.userRoles.map((ur) => ur.role.name),
  };
}

/**
 * User-scoped counters. Each query filters on the caller's userId so
 * there's no permission gate — every employee is implicitly authorised
 * to see their own pending work. Cheap counts only; record-level
 * disclosure stays inside the module pages.
 */
async function getPersonalSnapshot(userId: string): Promise<PersonalSnapshot> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const [
    pendingLeaveRequests,
    upcomingApprovedTravel,
    draftExpenseReports,
    submittedExpenseReports,
    openHelpdeskTickets,
    awaitingMyApprovalLeave,
    awaitingMyApprovalTravel,
    awaitingMyApprovalExpense,
  ] = await Promise.all([
    prisma.leaveRequest.count({
      where: { employeeId: userId, status: "pending" },
    }),
    prisma.travelRequest.count({
      where: {
        employeeId: userId,
        status: "approved",
        departureDate: { gte: today },
      },
    }),
    prisma.expenseReport.count({
      where: { employeeId: userId, status: "draft" },
    }),
    prisma.expenseReport.count({
      where: { employeeId: userId, status: "submitted" },
    }),
    prisma.helpdeskTicket.count({
      where: {
        createdById: userId,
        status: { in: ["open", "in-progress", "review"] },
      },
    }),
    // Items waiting for the caller as the designated next approver.
    // Mirrors what the approver-inbox pages would show.
    prisma.leaveApprovalDecision.count({
      where: {
        status: "pending",
        approverUserId: userId,
        leaveRequest: { status: "pending" },
      },
    }),
    prisma.travelApprovalDecision.count({
      where: {
        status: "pending",
        approverUserId: userId,
        travelRequest: { status: "pending" },
      },
    }),
    prisma.expenseApprovalDecision.count({
      where: {
        status: "pending",
        approverUserId: userId,
        expenseReport: { status: "submitted" },
      },
    }),
  ]);

  return {
    pendingLeaveRequests,
    upcomingApprovedTravel,
    draftExpenseReports,
    submittedExpenseReports,
    openHelpdeskTickets,
    awaitingMyApprovalLeave,
    awaitingMyApprovalTravel,
    awaitingMyApprovalExpense,
  };
}

async function getEntityFinancials(
  seeRev: boolean,
  seeExp: boolean,
): Promise<EntityFinancials[]> {
  if (!seeRev && !seeExp) return [];

  // Aggregate at the database via groupBy + _sum instead of pulling
  // every paid invoice + non-rejected expense row into Node and
  // summing in JS. The previous shape was the dominant cost in the
  // chat startup path on accounts with thousands of invoices.
  const [entities, invoiceSums, expenseSums] = await Promise.all([
    prisma.entity.findMany({
      where: { isActive: true },
      select: { id: true, name: true, code: true },
    }),
    seeRev
      ? prisma.invoice.groupBy({
          by: ["entityId"],
          // Exclude soft-deleted invoices so ARIA revenue context matches the
          // ledger (accounting deletes are soft — deletedAt — per PRD Rule 3).
          where: { status: "paid", deletedAt: null },
          _sum: { amount: true },
        })
      : Promise.resolve([]),
    seeExp
      ? prisma.expense.groupBy({
          by: ["entityId"],
          where: { status: { not: "rejected" } },
          _sum: { amount: true },
        })
      : Promise.resolve([]),
  ]);

  const revByEntity = new Map<string, number>();
  for (const row of invoiceSums) {
    if (!row.entityId) continue;
    revByEntity.set(row.entityId, Number(row._sum.amount ?? 0));
  }
  const expByEntity = new Map<string, number>();
  for (const row of expenseSums) {
    if (!row.entityId) continue;
    expByEntity.set(row.entityId, Number(row._sum.amount ?? 0));
  }

  return entities.map((e) => {
    const revenue = revByEntity.get(e.id) ?? 0;
    const expenses = expByEntity.get(e.id) ?? 0;
    return {
      name: e.name,
      code: e.code,
      revenue,
      expenses,
      netIncome: revenue - expenses,
    };
  });
}

async function getPeopleSnapshot(
  perms: Set<string>,
  omitted: string[],
): Promise<PeopleSnapshot | null> {
  if (!canSeePeopleRollup(perms)) {
    omitted.push("people / directory counts");
    return null;
  }

  const employees = await prisma.user.findMany({
    where: { isActive: true },
    select: {
      department: true,
      entity: { select: { name: true, code: true } },
    },
  });

  const byDepartment: Record<string, number> = {};
  const byEntity: Record<string, number> = {};
  for (const emp of employees) {
    const dept = emp.department ?? "Unassigned";
    byDepartment[dept] = (byDepartment[dept] ?? 0) + 1;
    // Display name as "Manut Thailand (TH)" so the assistant can match
    // either the full label or the entity code in the prompt.
    const entityKey = emp.entity
      ? `${emp.entity.name} (${emp.entity.code})`
      : "Unassigned";
    byEntity[entityKey] = (byEntity[entityKey] ?? 0) + 1;
  }

  return {
    employeeCount: employees.length,
    departmentBreakdown: byDepartment,
    entityBreakdown: byEntity,
  };
}

async function getPartnerSummary(
  perms: Set<string>,
  omitted: string[],
): Promise<PartnerSummary[] | null> {
  if (!canSeePartners(perms)) {
    omitted.push("partners");
    return null;
  }

  return prisma.partner.findMany({
    select: { company: true, type: true, status: true, country: true },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
}

async function getSalesPipeline(
  userId: string,
  perms: Set<string>,
  omitted: string[],
): Promise<SalesPipelineSummary | null> {
  if (!canSeeSalesCrm(perms)) {
    omitted.push("sales pipeline");
    return null;
  }

  // `crm:team-read` widens the scope to the full pipeline; otherwise the
  // assistant sees only opportunities / leads the caller owns, mirroring
  // `opportunities.service.list` and `leads.service.list`.
  const canSeeAll = perms.has(PERMISSIONS.CRM_TEAM_READ);
  const ownerFilter: Prisma.OpportunityWhereInput = canSeeAll
    ? {}
    : { ownerId: userId };
  const leadOwnerFilter: Prisma.LeadWhereInput = canSeeAll
    ? {}
    : { ownerId: userId };

  const [grouped, openLeads] = await Promise.all([
    prisma.opportunity.groupBy({
      by: ["stage", "currency"],
      where: ownerFilter,
      _count: { id: true },
      _sum: { value: true },
    }),
    prisma.lead.count({
      where: {
        ...leadOwnerFilter,
        status: { notIn: ["converted", "disqualified"] },
      },
    }),
  ]);

  return {
    stages: grouped.map((row) => ({
      stage: row.stage,
      currency: row.currency,
      count: row._count.id,
      totalValue: Number(row._sum.value ?? 0),
    })),
    openLeads,
  };
}

async function getInvestorKpis(
  perms: Set<string>,
  omitted: string[],
): Promise<InvestorKpis | null> {
  if (!canSeeInvestors(perms)) {
    omitted.push("investors");
    return null;
  }

  const [totalInvestors, investments] = await Promise.all([
    prisma.investor.count(),
    prisma.investment.findMany({
      select: { amount: true, status: true },
    }),
  ]);

  let totalCommitted = 0;
  let totalReceived = 0;

  for (const inv of investments) {
    const amount = Number(inv.amount);
    if (inv.status === "committed" || inv.status === "received") {
      totalCommitted += amount;
    }
    if (inv.status === "received") {
      totalReceived += amount;
    }
  }

  return { totalInvestors, totalCommitted, totalReceived };
}

async function countPendingExpenses(
  perms: Set<string>,
  omitted: string[],
): Promise<number | null> {
  if (!canSeePendingExpenseCount(perms)) {
    omitted.push("pending expense totals");
    return null;
  }
  return prisma.expense.count({ where: { status: "pending" } });
}

async function countVisasExpiringWithinDays(
  perms: Set<string>,
  days: number,
  omitted: string[],
): Promise<number | null> {
  if (!canSeeVisaExpiryRollup(perms)) {
    omitted.push("visa expiry counts");
    return null;
  }
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + days);
  return prisma.visaRecord.count({
    where: {
      expiryDate: { gte: start, lte: end },
    },
  });
}

async function countActiveProjects(
  perms: Set<string>,
  omitted: string[],
): Promise<number | null> {
  if (!canSeeProjectCounts(perms)) {
    omitted.push("project counts");
    return null;
  }
  return prisma.project.count({ where: { status: "active" } });
}

async function countPendingLeave(
  perms: Set<string>,
  omitted: string[],
): Promise<number | null> {
  if (!canSeeLeaveQueueRollup(perms)) {
    omitted.push("pending leave queue");
    return null;
  }
  return prisma.leaveRequest.count({ where: { status: "pending" } });
}

function formatCurrency(amount: number): string {
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(2)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(1)}K`;
  return `$${amount.toFixed(0)}`;
}

function buildPersonalSection(p: PersonalSnapshot): string | null {
  const lines: string[] = [];
  if (p.pendingLeaveRequests > 0) {
    lines.push(
      `- Pending leave requests you submitted: ${p.pendingLeaveRequests}`,
    );
  }
  if (p.upcomingApprovedTravel > 0) {
    lines.push(`- Upcoming approved trips: ${p.upcomingApprovedTravel}`);
  }
  if (p.draftExpenseReports > 0) {
    lines.push(`- Expense reports in draft: ${p.draftExpenseReports}`);
  }
  if (p.submittedExpenseReports > 0) {
    lines.push(
      `- Expense reports awaiting approval: ${p.submittedExpenseReports}`,
    );
  }
  if (p.openHelpdeskTickets > 0) {
    lines.push(
      `- Open IT helpdesk tickets you raised: ${p.openHelpdeskTickets}`,
    );
  }

  const approvalLines: string[] = [];
  if (p.awaitingMyApprovalLeave > 0) {
    approvalLines.push(`leave: ${p.awaitingMyApprovalLeave}`);
  }
  if (p.awaitingMyApprovalTravel > 0) {
    approvalLines.push(`travel: ${p.awaitingMyApprovalTravel}`);
  }
  if (p.awaitingMyApprovalExpense > 0) {
    approvalLines.push(`expense: ${p.awaitingMyApprovalExpense}`);
  }
  if (approvalLines.length > 0) {
    lines.push(`- Items awaiting your approval — ${approvalLines.join(", ")}`);
  }

  if (lines.length === 0) return null;
  return `YOUR DATA (caller-scoped — counts of your own rows across the platform):\n${lines.join("\n")}`;
}

function buildCallerSection(caller: CallerProfile | null): string | null {
  if (!caller) return null;
  const lines: string[] = [
    `- Name: ${caller.name}`,
    `- Email: ${caller.email}`,
  ];
  if (caller.jobTitle) lines.push(`- Job title: ${caller.jobTitle}`);
  if (caller.department) lines.push(`- Department: ${caller.department}`);
  if (caller.entityName) {
    const code = caller.entityCode ? ` (${caller.entityCode})` : "";
    lines.push(`- Entity: ${caller.entityName}${code}`);
  }
  if (caller.location || caller.country) {
    lines.push(
      `- Location: ${[caller.location, caller.country].filter(Boolean).join(", ")}`,
    );
  }
  if (caller.managerName) lines.push(`- Manager: ${caller.managerName}`);
  if (caller.startDate) lines.push(`- Start date: ${caller.startDate}`);
  if (caller.roles.length > 0) {
    lines.push(`- Roles: ${caller.roles.join(", ")}`);
  }
  return `CALLER PROFILE (use this to resolve "me", "my team", and similar references):\n${lines.join("\n")}`;
}

function buildContextString(snapshot: WorkspaceSnapshot): string {
  const sections: string[] = [];

  const callerBlock = buildCallerSection(snapshot.caller);
  if (callerBlock) sections.push(callerBlock);

  const personalBlock = buildPersonalSection(snapshot.personal);
  if (personalBlock) sections.push(personalBlock);

  if (snapshot.entities.length > 0) {
    const lines = snapshot.entities.map(
      (e) =>
        `- ${e.name} (${e.code}): Revenue ${formatCurrency(e.revenue)}, Expenses ${formatCurrency(e.expenses)}, Net ${formatCurrency(e.netIncome)}`,
    );
    sections.push(`FINANCIALS BY ENTITY:\n${lines.join("\n")}`);
  }

  if (snapshot.people) {
    const deptLines = Object.entries(snapshot.people.departmentBreakdown)
      .sort(([, a], [, b]) => b - a)
      .map(([dept, count]) => `  ${dept}: ${count}`);
    const entityLines = Object.entries(snapshot.people.entityBreakdown)
      .sort(([, a], [, b]) => b - a)
      .map(([entity, count]) => `  ${entity}: ${count}`);
    sections.push(
      `PEOPLE:\n- Total active employees: ${snapshot.people.employeeCount}\n- By office / entity:\n${entityLines.join("\n")}\n- Departments:\n${deptLines.join("\n")}`,
    );
  }

  if (snapshot.partners && snapshot.partners.length > 0) {
    const statusCounts: Record<string, number> = {};
    for (const p of snapshot.partners) {
      statusCounts[p.status] = (statusCounts[p.status] ?? 0) + 1;
    }
    const statusLine = Object.entries(statusCounts)
      .map(([s, c]) => `${s}: ${c}`)
      .join(", ");
    sections.push(
      `PARTNERS (${snapshot.partners.length} total): ${statusLine}\nTop partners: ${snapshot.partners
        .slice(0, 10)
        .map((p) => `${p.company} (${p.type}, ${p.status})`)
        .join("; ")}`,
    );
  }

  if (snapshot.salesPipeline) {
    const sp = snapshot.salesPipeline;
    // Roll up per-currency rows into a per-stage line so the assistant
    // doesn't fixate on a single currency. Sales CRM v2 ships side-by-
    // side currencies (PRD §11.5 — no FX inside the schema), so each
    // stage may have multiple buckets.
    const byStage = new Map<
      string,
      { count: number; totals: Map<string, number> }
    >();
    for (const row of sp.stages) {
      const bucket = byStage.get(row.stage) ?? {
        count: 0,
        totals: new Map<string, number>(),
      };
      bucket.count += row.count;
      bucket.totals.set(
        row.currency,
        (bucket.totals.get(row.currency) ?? 0) + row.totalValue,
      );
      byStage.set(row.stage, bucket);
    }
    const stageOrder = [
      "qualified",
      "proposal",
      "negotiation",
      "closed_won",
      "closed_lost",
    ];
    const pipelineLines = stageOrder
      .filter((s) => byStage.has(s))
      .map((stage) => {
        const b = byStage.get(stage)!;
        const totalsLine = Array.from(b.totals.entries())
          .sort((a, b) => b[1] - a[1])
          .map(([ccy, v]) => `${ccy} ${v.toLocaleString("en-US")}`)
          .join(" + ");
        return `- ${stage}: ${b.count} opportunities (${totalsLine})`;
      });
    if (pipelineLines.length === 0 && sp.openLeads === 0) {
      sections.push(
        `SALES PIPELINE: empty — no opportunities or open leads visible at this scope.`,
      );
    } else {
      const block = [
        `SALES PIPELINE (Sales CRM v2 — Lead → Account/Contact → Opportunity):`,
        `- Open leads: ${sp.openLeads}`,
        ...pipelineLines,
      ].join("\n");
      sections.push(block);
    }
  }

  if (snapshot.investorKpis) {
    const inv = snapshot.investorKpis;
    sections.push(
      `INVESTORS:\n- Total investors: ${inv.totalInvestors}\n- Total committed: ${formatCurrency(inv.totalCommitted)}\n- Total received: ${formatCurrency(inv.totalReceived)}`,
    );
  }

  const alerts: string[] = [];
  if (snapshot.pendingExpenses !== null && snapshot.pendingExpenses > 0) {
    alerts.push(`${snapshot.pendingExpenses} pending expense reports`);
  }
  if (snapshot.expiringVisas !== null && snapshot.expiringVisas > 0) {
    alerts.push(`${snapshot.expiringVisas} expiring visa records`);
  }
  if (
    snapshot.pendingLeaveRequests !== null &&
    snapshot.pendingLeaveRequests > 0
  ) {
    alerts.push(`${snapshot.pendingLeaveRequests} pending leave requests`);
  }
  if (alerts.length > 0) {
    sections.push(
      `ATTENTION ITEMS:\n${alerts.map((a) => `- ${a}`).join("\n")}`,
    );
  }

  if (snapshot.activeProjects !== null && snapshot.activeProjects > 0) {
    sections.push(`PROJECTS: ${snapshot.activeProjects} active projects`);
  }

  if (snapshot.omittedDataDomains.length > 0) {
    sections.push(
      `ACCESS NOTE:\nThe following workspace data was not included because your account does not have the required module permissions: ${snapshot.omittedDataDomains.join(", ")}.`,
    );
  }

  return sections.join("\n\n");
}

// Per-user snapshot cache. Most chat usage happens in clusters (a user
// asks several questions back to back), so a short TTL avoids re-paying
// the 9-query workspace gather on every turn. Cleared automatically on
// process restart; deliberately not Redis-backed for v1.
//
// 15s lets a fresh deploy / data write surface in the next chat turn
// without manual cache busts. Workspace queries are aggregate counts
// only (≤10 round-trips, all `count()` / `groupBy`), so the per-burst
// cost stays bounded even with a tighter window.
const CONTEXT_CACHE_TTL_MS = 15_000;
const contextCache = new Map<string, { expiresAt: number; context: string }>();

export async function buildAriaContext(userId: string): Promise<string> {
  const now = Date.now();
  const cached = contextCache.get(userId);
  if (cached && cached.expiresAt > now) {
    return cached.context;
  }
  try {
    const perms = await loadUserPermissions(userId);
    const snapshot = await gatherWorkspaceSnapshot(userId, perms);
    const context = buildContextString(snapshot);

    const wrapped = !context.trim()
      ? `WORKSPACE CONTEXT: No permitted workspace metrics are available for your role. If you need access, request the relevant module permissions (e.g. directory, sales CRM, finance).`
      : `WORKSPACE CONTEXT (live data as of ${new Date().toISOString().slice(0, 10)}):\n\n${context}`;

    contextCache.set(userId, {
      expiresAt: now + CONTEXT_CACHE_TTL_MS,
      context: wrapped,
    });
    return wrapped;
  } catch (err) {
    logger.error("Failed to build ARIA context", err);
    return "WORKSPACE CONTEXT: Unable to load workspace data at this time.";
  }
}

/**
 * Drop a user's cached snapshot. Hooks for downstream callers that
 * mutate workspace state (e.g. payroll commit, leave approval) and
 * want the next ARIA chat to see fresh data immediately.
 */
export function invalidateAriaContext(userId: string): void {
  contextCache.delete(userId);
}
