import { config } from "dotenv";
import { resolve } from "path";
import * as readline from "readline";
import slugify from "slugify";

// Load .env from monorepo root
config({ path: resolve(__dirname, "../../../.env") });

import { PrismaClient, Prisma } from "../src/generated/prisma";
import { randomUUID } from "node:crypto";

const prisma = new PrismaClient();

/* ────────────────────────────────────────────────
   Terminal Input Helper
   ──────────────────────────────────────────────── */
async function promptPassword(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/* ────────────────────────────────────────────────
   Helpers
   ──────────────────────────────────────────────── */
const uuid = () => randomUUID();
const d = (iso: string) => new Date(iso);
const dec = (n: number) => new Prisma.Decimal(n);
const today = new Date();
const year = today.getFullYear();
function pastDate(daysAgo: number): Date {
  const dt = new Date();
  dt.setDate(dt.getDate() - daysAgo);
  return dt;
}

function futureDate(daysAhead: number): Date {
  const dt = new Date();
  dt.setDate(dt.getDate() + daysAhead);
  return dt;
}

/** Default password assigned to seeded employee Supabase auth users. */
const SEED_EMPLOYEE_PASSWORD =
  process.env.SEED_EMPLOYEE_PASSWORD || "WelcomeManut123!";

/** Page through Supabase Auth admin user list and return email → id map. */
async function listAllSupabaseAuthUsers(
  supabaseUrl: string,
  serviceKey: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let page = 1;
  const perPage = 200;
  while (true) {
    const res = await fetch(
      `${supabaseUrl}/auth/v1/admin/users?page=${page}&per_page=${perPage}`,
      {
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
        },
      },
    );
    if (!res.ok) break;
    const data = (await res.json()) as {
      users?: { id: string; email?: string }[];
    };
    const users = data.users ?? [];
    if (users.length === 0) break;
    for (const u of users) {
      if (u.email) map.set(u.email.toLowerCase(), u.id);
    }
    if (users.length < perPage) break;
    page += 1;
  }
  return map;
}

/** Create a Supabase Auth user; returns id on success or null on failure. */
async function createSupabaseAuthUser(
  supabaseUrl: string,
  serviceKey: string,
  email: string,
  password: string,
  name?: string,
): Promise<string | null> {
  const res = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: name ? { name } : undefined,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error(
      `     ⚠️ Failed to provision auth user for ${email}: ${errText}`,
    );
    return null;
  }
  const created = (await res.json()) as { id: string };
  return created.id;
}

/** Compact relational volume for local / demo (not load-testing). */
const SEED_MIN = 6;
/** Repeatable bulk row count for expenses, finance tx, bookings, etc. */
const BULK_ROWS = 12;
/** FX rows to seed (independent of survey/appraisal depth). */
const FX_RATE_COUNT = 10;

function deterministicSalary(
  currency: string,
  title: string,
  idx: number,
): Prisma.Decimal {
  const executive = /Chief|VP\b|Head of|CTO\b/i.test(title);
  const senior = /Senior|Manager|Lead\b/i.test(title);
  const tier = executive ? 2 : senior ? 1 : 0;
  const bases: Record<string, [number, number, number]> = {
    THB: [47000, 72000, 168000],
    AED: [13000, 21500, 49500],
    SGD: [7000, 11200, 23800],
    EUR: [4100, 6600, 12800],
  };
  const triplet = bases[currency] ?? bases["THB"]!;
  const base = triplet[tier]!;
  return dec(base + (idx % 11) * 1200);
}

function daysAgoDeterministic(seedIndex: number, spanDays: number): number {
  const span = Math.max(5, spanDays);
  return 3 + ((seedIndex * 13) % (span - 2));
}

const ESS_V2_SECTIONS_SEED: Prisma.InputJsonValue = [
  {
    key: "roleClarity",
    label: "Role Clarity",
    questionCount: 7,
    prefix: "Q_RC",
  },
  {
    key: "managerEffectiveness",
    label: "Manager Effectiveness",
    questionCount: 6,
    prefix: "Q_ME",
  },
  {
    key: "teamDynamics",
    label: "Team Dynamics",
    questionCount: 6,
    prefix: "Q_TD",
  },
  {
    key: "orgEffectiveness",
    label: "Org Effectiveness",
    questionCount: 6,
    prefix: "Q_OE",
  },
  {
    key: "leadershipTrust",
    label: "Leadership Trust",
    questionCount: 6,
    prefix: "Q_LT",
  },
  {
    key: "engagementRetention",
    label: "Engagement and Retention",
    questionCount: 4,
    prefix: "Q_ER",
  },
];

const ESS_V2_FEEDBACK_COLUMNS_SEED: Prisma.InputJsonValue = [
  { key: "feedbackStartDoing", header: "Feedback_StartDoing" },
  { key: "feedbackStopDoing", header: "Feedback_StopDoing" },
  { key: "feedbackContinueDoing", header: "Feedback_ContinueDoing" },
  { key: "feedbackGeneral", header: "Feedback_General" },
];

/* ────────────────────────────────────────────────
   Static IDs (for cross-referencing)
   ──────────────────────────────────────────────── */

const ADMIN_EMAIL = "admin@manut.xyz";

// Org identity for the demo tenant. Override with SEED_ORG_NAME to brand the
// whole demo (entities, offices, admin, app.name) for a different org — e.g.
// `SEED_ORG_NAME=Acme pnpm db:seed` produces an Acme-branded tenant. Defaults
// to Manut. This exercises the modular company-identity work: the invoice /
// payslip company blocks default their name from the `app.name` SystemSetting.
const ORG_NAME = (process.env.SEED_ORG_NAME || "Manut").trim() || "Manut";
const ADMIN_NAME = `${ORG_NAME} Admin`;
/** Rebrand the seed's built-in "Manut" org token to the configured org name. */
const brandOrg = (value: string): string => value.split("Manut").join(ORG_NAME);

/** Entity `code` values — DB assigns `Entity.id` (cuid). */
const ENTITY_CODE_ORDER = ["TH", "AE", "SG", "PT", "ID", "VN", "IN"] as const;

const USER_IDS: string[] = [];
const ROLE_IDS: Record<string, string> = {};
const LEAVE_TYPE_IDS: Record<string, string> = {};
const EXPENSE_CAT_IDS: string[] = [];
const ACCOUNT_IDS: Record<string, string[]> = {};
const PARTNER_IDS: string[] = [];
const PROJECT_IDS: string[] = [];
const OFFICE_IDS: string[] = [];
const DESK_IDS: string[] = [];
const ROOM_IDS: string[] = [];
const INVESTOR_IDS: string[] = [];
const TRAINING_IDS: string[] = [];
const BENEFIT_IDS: string[] = [];
const WALL_POST_IDS: string[] = [];
const JOB_IDS: string[] = [];

/* ────────────────────────────────────────────────
   1. Entities
   ──────────────────────────────────────────────── */
const ENTITIES = [
  {
    name: "Manut Thailand",
    code: "TH",
    country: "Thailand",
    currency: "THB",
    accountingStd: "TFRS for NPAEs",
  },
  {
    name: "Manut Dubai",
    code: "AE",
    country: "UAE",
    currency: "AED",
    accountingStd: "IFRS",
  },
  {
    name: "Manut Singapore",
    code: "SG",
    country: "Singapore",
    currency: "SGD",
    accountingStd: "IFRS",
  },
  {
    name: "Manut Portugal",
    code: "PT",
    country: "Portugal",
    currency: "EUR",
    accountingStd: "IFRS",
  },
  {
    name: "Manut Indonesia",
    code: "ID",
    country: "Indonesia",
    currency: "IDR",
    accountingStd: "PSAK",
  },
  {
    name: "Manut Vietnam",
    code: "VN",
    country: "Vietnam",
    currency: "VND",
    accountingStd: "VAS",
  },
  {
    name: "Manut India",
    code: "IN",
    country: "India",
    currency: "INR",
    accountingStd: "Ind AS",
  },
  {
    name: "Manut Bangladesh",
    code: "BD",
    country: "Bangladesh",
    currency: "BDT",
    accountingStd: "BFRS",
  },
];

/* ────────────────────────────────────────────────
   2. Roles & Permissions
   ──────────────────────────────────────────────── */
const SYSTEM_ROLES = [
  {
    name: "Admin",
    description: "Full system access",
    isSystem: true,
    defaultRoute: "/dashboard",
  },
  {
    name: "HR Manager",
    description: "HR operations and approvals",
    isSystem: true,
    defaultRoute: "/dashboard",
  },
  {
    name: "Accounting Manager",
    description: "Financial operations",
    isSystem: true,
    defaultRoute: "/dashboard",
  },
  {
    name: "Finance Manager",
    description: "Finance operations",
    isSystem: true,
    defaultRoute: "/dashboard",
  },
  {
    name: "Manager",
    description: "Team management and approvals",
    isSystem: true,
    defaultRoute: "/dashboard",
  },
  {
    name: "Employee",
    description: "Self-service access",
    isSystem: true,
    defaultRoute: "/my-portal",
  },
];

const ADMIN_PERMISSIONS = [
  "home:read",
  "wall:create",
  "wall:delete",
  "news:create",
  "news:delete",
  "aria:use",
  "aria:parse",
  "aria:brief-subscribe",
  "integrations:use",
  "integrations:manage",
  "messages:read",
  "messages:create",
  "messages:delete",
  "messages:admin",
  "projects:read",
  "projects:read-all",
  "projects:create",
  "projects:update",
  "projects:delete",
  "projects:manage",
  "partners:read",
  "partners:create",
  "partners:update",
  "partners:delete",
  "deals:read",
  "deals:create",
  "deals:update",
  "deals:delete",
  "deals:manage",
  "crm:read",
  "crm:team-read",
  "crm:create",
  "crm:update",
  "crm:delete",
  "crm:reassign",
  "crm:export",
  "crm:admin",
  "crm:settings-manage",
  "sales-revenue:read",
  "sales-revenue:team-read",
  "sales-revenue:create",
  "sales-revenue:update",
  "sales-revenue:delete",
  "sales-revenue:reassign",
  "sales-revenue:export",
  "sales-revenue:admin",
  "sales-revenue:settings-manage",
  "career:read",
  "career:create",
  "career:update",
  "career:delete",
  "career:export",
  "application:read",
  "application:delete",
  "application:export",
  "survey:manage-wave",
  "survey:manage",
  "leave:read",
  "leave:request",
  "leave:approve",
  "leave:approve-wfh",
  "leave:team-calendar",
  "leave:hr-read",
  "leave:hr-adjust",
  "leave:hr-on-behalf",
  "leave:hr-settings",
  "leave:assign-approver",
  "leave:export",
  "leave:audit-read",
  "leave:bulk-import",
  "leave:analytics",
  "benefits:read",
  "benefits:manage",
  "benefits:enroll",
  "payroll:read",
  "payroll:create",
  "payroll:approve",
  "payroll:hr-admin",
  "hrms:read",
  "hrms:esop-manage",
  "hrms:onboarding-manage",
  "hrms:offboarding-manage",
  "hrms:attendance-read",
  "hrms:attendance-manage",
  "hrms:attendance-policy-manage",
  "hrms:attendance-correction-approve",
  "hrms:attendance-report-export",
  "certificate:read",
  "certificate:manage",
  "learning:read",
  "learning:complete",
  "learning:manage",
  "learning:hr-read",
  "visa:read",
  "visa:hr-read",
  "visa:manage",
  "office:read",
  "office:book",
  "office:manage",
  "policy:read",
  "policy:manage",
  "directory:read",
  "directory:view-sensitive",
  "accounting:read",
  // read-all keeps the Admin role a full accounting reader once own-document
  // scoping lands (Chunk 5). Redundant with the Admin super-bypass, but the
  // seed must carry it so a db:seed re-run never drops it.
  "accounting:read-all",
  "accounting:create",
  "accounting:approve",
  "accounting:post",
  "accounting:admin",
  "travel:read",
  "travel:request",
  "travel:approve",
  "travel:assign-approver",
  "travel:hr-read",
  "travel:hr-approve",
  "travel:hr-on-behalf",
  "travel:export",
  "travel:audit-read",
  "travel:analytics",
  "expense:read",
  "expense:create",
  "expense:approve",
  "expense:hr-read",
  "expense:hr-approve",
  "expense:assign-approver",
  "expense:export",
  "expense:audit-read",
  "revenue:read",
  "investors:read",
  "investors:read-all",
  "investors:create",
  "investors:update",
  "investors:delete",
  "investor-dashboard:read",
  "investor-crm:read",
  "investor-crm:manage",
  "dataroom:read",
  "dataroom:upload",
  "dataroom:manage",
  "investor-updates:read",
  "investor-updates:create",
  "investor-updates:send",
  "admin:read",
  "admin:audit-log",
  "admin:manage",
  "admin:usage-report",
  "blog:read",
  "blog:create",
  "blog:update",
  "blog:delete",
  "docs:read",
  "docs:create",
  "docs:update",
  "docs:delete",
  "pr:read",
  "pr:create",
  "pr:update",
  "pr:delete",
  "performance:read",
  "performance:self-review",
  "performance:manager-review",
  "performance:hr-manage",
  "performance:goals",
  "access-control:read",
  "role:read",
  "role:create",
  "role:update",
  "role:delete",
  "user:read",
  "user:create",
  "user:update",
  "user:delete",
  "user:assign-role",
];

/* ────────────────────────────────────────────────
   3. Users (the admin + 24 employees)
   ──────────────────────────────────────────────── */
const DEPARTMENTS = [
  "Management",
  "Legal",
  "Marketing",
  "HR",
  "Accounting",
  "Finance",
  "Product",
  "Digital Social",
  "Business Development",
  "IT",
];
const TITLES = [
  "Software Engineer",
  "Senior Software Engineer",
  "Frontend Developer",
  "Backend Developer",
  "Product Manager",
  "UX Designer",
  "UI Designer",
  "Marketing Manager",
  "Financial Analyst",
  "HR Specialist",
  "DevOps Engineer",
  "Data Analyst",
  "QA Engineer",
  "Content Writer",
  "Business Analyst",
  "Growth Manager",
  "Chief Technology Officer",
  "VP of Engineering",
  "Head of Design",
  "Head of Finance",
  "Community Manager",
  "Legal Counsel",
  "Office Manager",
  "Support Lead",
];
const LOCATIONS = ["Bangkok", "Dubai", "Singapore", "Lisbon"];
const COUNTRIES = ["Thailand", "UAE", "Singapore", "Portugal"];
const EMPLOYEE_NAMES = [
  "Somchai Prasert",
  "Nattapong Wongsakul",
  "Priya Sharma",
  "Ahmed Al-Rashid",
  "Maria Santos",
  "Liam Chen",
  "Sofia Rodriguez",
  "Yuki Tanaka",
  "Oliver Smith",
  "Emma Johnson",
  "Lucas Müller",
  "Isabella Rossi",
  "Hugo Martin",
  "Chloe Dubois",
  "Ethan Nguyen",
  "Mia Williams",
  "Noah Brown",
  "Ava Davis",
  "Leo Garcia",
  "Zara Patel",
  "Max Anderson",
  "Ruby Taylor",
  "Jack Wilson",
  "Lily Martinez",
];

/* ────────────────────────────────────────────────
   4. Leave Types
   ──────────────────────────────────────────────── */
const LEAVE_TYPES = [
  {
    id: "lt_al",
    name: "Annual Leave",
    code: "AL",
    category: "earned",
    daysPerYear: 14,
    requiresApproval: true,
    isPaid: true,
  },
  {
    id: "lt_sl",
    name: "Sick Leave",
    code: "SL",
    category: "sick",
    daysPerYear: 30,
    requiresApproval: false,
    isPaid: true,
  },
  {
    id: "lt_pl",
    name: "Personal Leave",
    code: "PL",
    category: "casual",
    daysPerYear: 3,
    requiresApproval: true,
    isPaid: true,
  },
  {
    id: "lt_wfh",
    name: "Work From Home",
    code: "WFH",
    category: "casual",
    // Treated as effectively unlimited per HR policy. Stored as a high
    // sentinel rather than nullable to keep balance math simple.
    daysPerYear: 365,
    requiresApproval: true,
    isPaid: true,
  },
  {
    id: "lt_ml",
    name: "Maternity Leave",
    code: "ML",
    category: "other",
    // Thai Labour Act §41 — 120 days total, of which 60 are paid.
    daysPerYear: 120,
    requiresApproval: true,
    isPaid: true,
  },
  {
    id: "lt_ptl",
    name: "Paternity Leave",
    code: "PTL",
    category: "other",
    daysPerYear: 15,
    requiresApproval: true,
    isPaid: true,
  },
  {
    id: "lt_cl",
    name: "Compassionate Leave",
    code: "CL",
    category: "other",
    daysPerYear: 5,
    requiresApproval: true,
    isPaid: true,
  },
  {
    id: "lt_lwp",
    name: "Leave Without Pay",
    code: "LWP",
    category: "unpaid",
    // No statutory cap — HoD discretion. Use a high sentinel so the
    // balance check never fails on the type itself.
    daysPerYear: 365,
    requiresApproval: true,
    isPaid: false,
  },
  {
    id: "lt_bl",
    name: "Bereavement Leave",
    code: "BL",
    category: "other",
    daysPerYear: 7,
    requiresApproval: true,
    isPaid: true,
  },
];

/* ────────────────────────────────────────────────
   5. Expense Categories
   ──────────────────────────────────────────────── */
const EXPENSE_CATEGORIES = [
  "Travel & Transportation",
  "Meals & Entertainment",
  "Office Supplies",
  "Software & Subscriptions",
  "Equipment & Hardware",
  "Professional Development",
  "Client Entertainment",
  "Marketing & Advertising",
  "Communication",
  "Accommodation",
  "Team Building",
];

/* ────────────────────────────────────────────────
   MAIN SEED FUNCTION
   ──────────────────────────────────────────────── */
async function main() {
  console.log("🌱 Starting optimized seed...\n");
  const startTime = Date.now();

  // ─── CLEANUP (idempotent re-run) ──────────
  console.log("=== 0. Cleanup for idempotent re-run ===");

  // Phase 1: Delete leaf tables (no FK dependencies) in parallel
  await Promise.all([
    prisma.surveyResponse.deleteMany({}),
    prisma.goal.deleteMany({}),
    prisma.appraisalRating.deleteMany({}),
    prisma.appraisalComment.deleteMany({}),
    prisma.appraisalKRA.deleteMany({}),
    prisma.balanceTransaction.deleteMany({}),
    prisma.exchangeRate.deleteMany({ where: { source: "seed" } }),
    prisma.session.deleteMany({ where: { userAgent: "SeedRunner/1.0" } }),
    prisma.manutAiMessage.deleteMany({}),
    prisma.auditLog.deleteMany({}),
    prisma.moduleAccess.deleteMany({}),
    prisma.moduleOwner.deleteMany({
      where: { moduleId: { startsWith: "seed_mod_" } },
    }),
    prisma.wallComment.deleteMany({}),
    prisma.messageReaction.deleteMany({}),
    prisma.messageHiddenFor.deleteMany({}),
    prisma.message.deleteMany({}),
    prisma.roomBooking.deleteMany({}),
    prisma.deskBooking.deleteMany({}),
    prisma.asset.deleteMany({}),
    prisma.projectTask.deleteMany({}),
    prisma.projectColumn.deleteMany({}),
    prisma.projectMember.deleteMany({}),
    prisma.investment.deleteMany({}),
    prisma.companyDate.deleteMany({}),
    prisma.companyNews.deleteMany({}),
    prisma.partnerContact.deleteMany({}),
    prisma.bankTransaction.deleteMany({}),
    prisma.bnryTransaction.deleteMany({}),
    prisma.consultantInvoice.deleteMany({}),
    prisma.esopGrant.deleteMany({}),
    prisma.onboardingRun.deleteMany({}),
    prisma.trainingCompletion.deleteMany({}),
    prisma.visaRecord.deleteMany({}),
    prisma.benefitEnrollment.deleteMany({}),
    prisma.leaveRequest.deleteMany({}),
    prisma.expense.deleteMany({}),
    prisma.travelRequest.deleteMany({}),
    prisma.journalEntryLine.deleteMany({}),
    prisma.payslip.deleteMany({}),
  ]);

  // Phase 2: Delete mid-level tables
  await Promise.all([
    prisma.appraisal.deleteMany({}),
    prisma.manutAiConversation.deleteMany({}),
    prisma.wallPost.deleteMany({}),
    prisma.conversationMember.deleteMany({}),
    prisma.conversation.deleteMany({}),
    prisma.meetingRoom.deleteMany({}),
    prisma.officeDesk.deleteMany({}),
    prisma.project.deleteMany({}),
    prisma.trainingModule.deleteMany({}),
    prisma.benefit.deleteMany({}),
    prisma.journalEntry.deleteMany({}),
    prisma.invoice.deleteMany({}),
    prisma.payrollRun.deleteMany({}),
  ]);

  // Phase 3: Delete top-level tables
  await Promise.all([
    prisma.appraisalCycle.deleteMany({}),
    prisma.kRATemplate.deleteMany({}),
    prisma.office.deleteMany({}),
  ]);

  // User groups need sequential handling due to FK
  const seedGroupIds = await prisma.userGroup.findMany({
    where: {
      OR: [
        { name: { startsWith: "Seed User Group" } },
        { name: { startsWith: "DevGroup:" } },
      ],
    },
    select: { id: true },
  });
  if (seedGroupIds.length > 0) {
    const ids = seedGroupIds.map((g) => g.id);
    await prisma.userGroupMember.deleteMany({
      where: { groupId: { in: ids } },
    });
    await prisma.userGroup.deleteMany({ where: { id: { in: ids } } });
  }
  console.log("  ✅ Cleanup complete\n");

  // ─── 1. ENTITIES ────────────────────────────
  console.log("=== 1. Entities ===");
  await prisma.$transaction(
    ENTITIES.map((entity) => {
      const data = { ...entity, name: brandOrg(entity.name) };
      return prisma.entity.upsert({
        where: { code: entity.code },
        update: data,
        create: data,
      });
    }),
  );
  const entityRows = await prisma.entity.findMany({
    orderBy: { code: "asc" },
  });
  const entityIdByCode = Object.fromEntries(
    entityRows.map((e) => [e.code, e.id]),
  ) as Record<string, string>;
  const entityIdsRoundRobin = entityRows.map((e) => e.id);
  const entityIdAt = (i: number) =>
    entityIdsRoundRobin[i % entityIdsRoundRobin.length]!;
  console.log(`  ✅ ${entityRows.length} entities\n`);

  // ─── 2. ROLES ───────────────────────────────
  console.log("=== 2. Roles ===");
  const roles = await prisma.$transaction(
    SYSTEM_ROLES.map((role) =>
      prisma.role.upsert({
        where: { name: role.name },
        update: {
          description: role.description,
          defaultRoute: role.defaultRoute,
        },
        create: role,
      }),
    ),
  );
  roles.forEach((r, i) => {
    ROLE_IDS[SYSTEM_ROLES[i]!.name] = r.id;
  });

  const EXTRA_ROLE_SPECS = [
    {
      name: "External Consultant",
      description: "Contractor / vendor workspace access",
    },
    { name: "Intern", description: "Structured internship role" },
  ] as const;
  const extraRoleRows: { id: string; name: string }[] = [];
  for (const spec of EXTRA_ROLE_SPECS) {
    const r = await prisma.role.upsert({
      where: { name: spec.name },
      update: {
        description: spec.description,
        isSystem: false,
        defaultRoute: "/my-portal",
      },
      create: {
        name: spec.name,
        description: spec.description,
        isSystem: false,
        defaultRoute: "/my-portal",
      },
    });
    extraRoleRows.push({ id: r.id, name: r.name });
    ROLE_IDS[r.name] = r.id;
  }
  console.log(`  ✅ ${SYSTEM_ROLES.length + extraRoleRows.length} roles\n`);

  // ─── 3. ROLE PERMISSIONS (Admin gets all) ───
  console.log("=== 3. Role Permissions ===");
  const adminRoleId = ROLE_IDS["Admin"]!;
  const employeeRoleId = ROLE_IDS["Employee"]!;
  const hrRoleId = ROLE_IDS["HR Manager"]!;
  const acctRoleId = ROLE_IDS["Accounting Manager"]!;
  const financeRoleId = ROLE_IDS["Finance Manager"]!;
  const mgrRoleId = ROLE_IDS["Manager"]!;

  const employeePerms = [
    "home:read",
    "wall:create",
    "news:create",
    "aria:use",
    "aria:brief-subscribe",
    "integrations:use",
    "messages:read",
    "messages:create",
    "projects:read",
    "leave:read",
    "leave:request",
    "leave:team-calendar",
    "travel:read",
    "travel:request",
    "expense:read",
    "expense:create",
    "payroll:read",
    "benefits:read",
    "benefits:enroll",
    "hrms:read",
    "learning:read",
    "learning:complete",
    "visa:read",
    "office:read",
    "office:book",
    "policy:read",
    "directory:read",
    "docs:read",
    "investors:read",
    "investor-dashboard:read",
    "investor-updates:read",
    "performance:read",
    "performance:self-review",
    "performance:goals",
    "crm:read",
    "crm:create",
    "crm:update",
    "sales-revenue:read",
    "sales-revenue:create",
    "sales-revenue:update",
    // IT helpdesk is open to every employee — `it:read` scopes the
    // list to their own tickets via owner-filter, and `it:create`
    // lets them open a new ticket. Triage / resolve permissions
    // stay with the IT role.
    "it:read",
    "it:create",
    // IT Operations: every employee can request system access and track
    // their own requests; approval / grant / billing stay with IT.
    "it:access:request",
  ];

  const hrPerms = [
    ...employeePerms,
    "leave:hr-read",
    "leave:hr-on-behalf",
    "leave:approve",
    "payroll:create",
    "payroll:approve",
    "payroll:hr-admin",
    "hrms:esop-manage",
    "hrms:onboarding-manage",
    "hrms:offboarding-manage",
    "hrms:attendance-read",
    "hrms:attendance-manage",
    "hrms:attendance-policy-manage",
    "hrms:attendance-correction-approve",
    "hrms:attendance-report-export",
    "certificate:read",
    "certificate:manage",
    "learning:manage",
    "learning:hr-read",
    "visa:hr-read",
    "visa:manage",
    "office:manage",
    "policy:manage",
    "directory:view-sensitive",
    "expense:hr-read",
    "expense:approve",
    "expense:hr-approve",
    "travel:hr-read",
    "travel:approve",
    "travel:hr-approve",
    "career:read",
    "career:create",
    "career:update",
    "career:delete",
    "career:export",
    "application:read",
    "application:delete",
    "application:export",
    "survey:manage-wave",
    "survey:manage",
    "performance:hr-manage",
    "performance:manager-review",
    "user:read",
    "user:create",
    "user:update",
    "user:delete",
    "user:assign-role",
    // HR CRM workspace — HR Manager owns the workspace, so they need
    // every CRM perm including `manage` (lets them edit/transfer
    // ownership of HR projects they don't personally own).
    "hr-crm:read",
    "hr-crm:read-all",
    "hr-crm:create",
    "hr-crm:update",
    "hr-crm:delete",
    "hr-crm:manage",
  ];

  const acctPerms = [
    ...employeePerms,
    "accounting:read",
    // NON-BREAKING (Chunk 5): Accounting Manager + Finance Manager (which
    // spreads acctPerms) currently see every document via `accounting:read`.
    // Once own-document scoping lands, `read` alone means own-docs-only, so
    // grant `read-all` to preserve their full visibility. The seed carries it
    // so a re-run can't downgrade them.
    "accounting:read-all",
    "accounting:create",
    "accounting:approve",
    "accounting:post",
    "accounting:admin",
    "accounting-crm:read",
    "accounting-crm:read-all",
    "accounting-crm:create",
    "accounting-crm:update",
    "accounting-crm:delete",
    "accounting-crm:manage",
    "expense:hr-read",
    "expense:approve",
    "expense:hr-approve",
    "revenue:read",
    "payroll:read",
    "payroll:create",
    "payroll:approve",
  ];

  const financePerms = [...acctPerms];

  const mgrPerms = [
    ...employeePerms,
    "leave:approve",
    "projects:read-all",
    "projects:create",
    "projects:update",
    "partners:read",
    "deals:read",
    "deals:create",
    "deals:update",
    "crm:team-read",
    "sales-revenue:team-read",
    "expense:approve",
    "travel:approve",
    "performance:manager-review",
    // Per-team CRM workspace perms. The Manager role is the catchall
    // for team leads (no per-workspace manager role exists yet), so
    // grant the full set including `manage` to unblock ownership
    // transfer / row-level edits inside each CRM. Mirrors the
    // hr-crm:* grants on HR Manager.
    "it-crm:read",
    "it-crm:read-all",
    "it-crm:create",
    "it-crm:update",
    "it-crm:delete",
    "it-crm:manage",
    "product-crm:read",
    "product-crm:read-all",
    "product-crm:create",
    "product-crm:update",
    "product-crm:delete",
    "product-crm:manage",
    "legal-crm:read",
    "legal-crm:read-all",
    "legal-crm:create",
    "legal-crm:update",
    "legal-crm:delete",
    "legal-crm:manage",
    "accounting-crm:read",
    "accounting-crm:read-all",
    "accounting-crm:create",
    "accounting-crm:update",
    "accounting-crm:delete",
    "accounting-crm:manage",
    "qa-crm:read",
    "qa-crm:read-all",
    "qa-crm:create",
    "qa-crm:update",
    "qa-crm:delete",
    "qa-crm:manage",
    "hr-crm:read",
    "hr-crm:read-all",
    "hr-crm:create",
    "hr-crm:update",
    "hr-crm:delete",
    "hr-crm:manage",
    "voucher-crm:read",
    "voucher-crm:read-all",
    "voucher-crm:create",
    "voucher-crm:update",
    "voucher-crm:delete",
    "voucher-crm:manage",
    // IT Operations: the Manager role is the catchall for team leads
    // (no dedicated IT Manager role yet), so grant the full IT Ops set
    // including billing + access management. Mirrors the it-crm:* grants.
    "it:dashboard:view",
    "it:billing:view",
    "it:billing:manage",
    "it:access:view",
    "it:access:request",
    "it:access:approve",
    "it:access:manage",
    // Marketing Analytics (BNII Analytics dashboard + raw explorer).
    "marketing:dashboard:view",
    "marketing:raw:view",
    // Marketing CRM - Campaign CRM.
    "marketing:campaign:view",
    "marketing:campaign:create",
    "marketing:campaign:update",
    "marketing:campaign:delete",
    "marketing:reports:view",
  ];

  const allRolePermissions: Prisma.RolePermissionUncheckedCreateInput[] = [
    ...ADMIN_PERMISSIONS.map((code) => ({
      roleId: adminRoleId,
      permissionCode: code,
    })),
    ...employeePerms.map((code) => ({
      roleId: employeeRoleId,
      permissionCode: code,
    })),
    ...[...new Set(hrPerms)].map((code) => ({
      roleId: hrRoleId,
      permissionCode: code,
    })),
    ...[...new Set(acctPerms)].map((code) => ({
      roleId: acctRoleId,
      permissionCode: code,
    })),
    ...[...new Set(financePerms)].map((code) => ({
      roleId: financeRoleId,
      permissionCode: code,
    })),
    ...[...new Set(mgrPerms)].map((code) => ({
      roleId: mgrRoleId,
      permissionCode: code,
    })),
    ...extraRoleRows.flatMap((er) =>
      employeePerms.map((code) => ({
        roleId: er.id,
        permissionCode: code,
      })),
    ),
  ];

  const seededRoleIds = [
    adminRoleId,
    employeeRoleId,
    hrRoleId,
    acctRoleId,
    financeRoleId,
    mgrRoleId,
    ...extraRoleRows.map((er) => er.id),
  ];

  await prisma.rolePermission.deleteMany({
    where: {
      roleId: {
        in: seededRoleIds,
      },
    },
  });
  await prisma.rolePermission.createMany({
    data: allRolePermissions,
    skipDuplicates: true,
  });
  console.log(`  ✅ ${allRolePermissions.length} role-permission pairs\n`);

  // ─── 4. ADMIN USER (create in Supabase Auth + Prisma) ───
  console.log("=== 4. Users ===");

  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  let adminUserId: string;

  if (supabaseUrl && serviceKey && serviceKey !== "placeholder") {
    // Check if admin exists in Supabase Auth
    const listRes = await fetch(
      `${supabaseUrl}/auth/v1/admin/users?page=1&per_page=50`,
      {
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
        },
      },
    );
    const data = (await listRes.json()) as {
      users?: { id: string; email?: string }[];
    };
    const users = data.users || [];
    const existingAuth = users.find(
      (u: { email?: string }) => u.email === ADMIN_EMAIL,
    );

    if (existingAuth) {
      adminUserId = existingAuth.id;
      console.log(`  Found admin in Supabase Auth: ${adminUserId}`);
    } else {
      // Create admin in Supabase Auth - prompt for password
      console.log(`\n  🔐 Admin user not found in Supabase Auth.`);
      console.log(`     Email: ${ADMIN_EMAIL}`);
      const adminPassword = await promptPassword(
        "     Enter password for admin user: ",
      );

      if (!adminPassword || adminPassword.length < 6) {
        console.error(`  ❌ Password must be at least 6 characters`);
        adminUserId = uuid();
        console.log(`  Using generated UUID instead: ${adminUserId}`);
      } else {
        console.log(`  Creating admin in Supabase Auth...`);
        const createRes = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
          method: "POST",
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            email: ADMIN_EMAIL,
            password: adminPassword,
            email_confirm: true,
            user_metadata: { name: ADMIN_NAME },
          }),
        });

        if (!createRes.ok) {
          const errText = await createRes.text();
          console.error(
            `  ❌ Failed to create admin in Supabase Auth: ${errText}`,
          );
          adminUserId = uuid();
          console.log(`  Using generated UUID instead: ${adminUserId}`);
        } else {
          const newUser = (await createRes.json()) as { id: string };
          adminUserId = newUser.id;
          console.log(`  ✅ Created admin in Supabase Auth: ${adminUserId}`);
        }
      }
    }
  } else {
    adminUserId = uuid();
    console.log(
      `  ⚠️  No Supabase service key, using generated UUID: ${adminUserId}`,
    );
    console.log(`     Set SUPABASE_SERVICE_ROLE_KEY to create real auth user`);
  }

  // Create/update admin in Prisma database
  await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    update: { id: adminUserId, name: ADMIN_NAME, isActive: true },
    create: {
      id: adminUserId,
      email: ADMIN_EMAIL,
      name: ADMIN_NAME,
      phone: "+66812345678",
      entityId: entityIdByCode["TH"]!,
      department: "Operations",
      jobTitle: "System Administrator",
      employeeId: "MNT-001",
      employmentType: "full_time",
      startDate: d("2023-01-01"),
      salary: dec(150000),
      currency: "THB",
      location: "Bangkok",
      country: "Thailand",
      timezone: "Asia/Bangkok",
      isActive: true,
    },
  });
  USER_IDS.push(adminUserId);

  // Assign admin role
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: adminUserId, roleId: adminRoleId } },
    update: {},
    create: {
      userId: adminUserId,
      roleId: adminRoleId,
      assignedBy: adminUserId,
    },
  });

  // Prepare employee users data
  const employeeUsersData: Prisma.UserUncheckedCreateInput[] = [];

  for (let i = 0; i < 24; i++) {
    const entityIdx = i % 4;
    const name = EMPLOYEE_NAMES[i]!;
    const emailName = name
      .toLowerCase()
      .replace(/\s+/g, ".")
      .replace(/[^a-z.]/g, "");

    employeeUsersData.push({
      email: `${emailName}@manut.xyz`,
      name,
      entityId: entityIdByCode[ENTITY_CODE_ORDER[entityIdx]!]!,
      department: DEPARTMENTS[i % DEPARTMENTS.length]!,
      jobTitle: TITLES[i]!,
      employeeId: `MNT-${String(i + 2).padStart(3, "0")}`,
      reportingTo: adminUserId,
      employmentType: i < 20 ? "full_time" : "contractor",
      startDate: pastDate(380 - ((i * 19) % 340)),
      salary: deterministicSalary(
        ["THB", "AED", "SGD", "EUR"][entityIdx]!,
        TITLES[i]!,
        i,
      ),
      currency: ["THB", "AED", "SGD", "EUR"][entityIdx]!,
      location: LOCATIONS[entityIdx]!,
      country: COUNTRIES[entityIdx]!,
      timezone: [
        "Asia/Bangkok",
        "Asia/Dubai",
        "Asia/Singapore",
        "Europe/Lisbon",
      ][entityIdx]!,
      isActive: true,
    });
  }

  // Delete existing employee users by email or employeeId pattern (excluding admin)
  const existingEmails = employeeUsersData.map((u) => u.email);
  const existingEmployeeIds = employeeUsersData.map((u) => u.employeeId!);
  await prisma.user.deleteMany({
    where: {
      OR: [
        { email: { in: existingEmails } },
        { employeeId: { in: existingEmployeeIds } },
      ],
    },
  });

  // Provision a Supabase Auth user for every seeded employee so admins can
  // reset their password later. If the auth user already exists (re-seed),
  // reuse its id so the Prisma row stays in sync. Falls back to a fresh UUID
  // when no service key is available (local dev without Supabase).
  const supabaseEnabled =
    Boolean(supabaseUrl) && Boolean(serviceKey) && serviceKey !== "placeholder";
  const existingAuthByEmail = supabaseEnabled
    ? await listAllSupabaseAuthUsers(supabaseUrl!, serviceKey!)
    : new Map<string, string>();

  const employeeUsersWithIds: Prisma.UserUncheckedCreateInput[] = [];
  let provisionedCount = 0;
  for (const row of employeeUsersData) {
    const lookupKey = row.email.toLowerCase();
    let resolvedId = existingAuthByEmail.get(lookupKey);
    if (!resolvedId && supabaseEnabled) {
      const created = await createSupabaseAuthUser(
        supabaseUrl!,
        serviceKey!,
        row.email,
        SEED_EMPLOYEE_PASSWORD,
        row.name,
      );
      if (created) {
        resolvedId = created;
        provisionedCount += 1;
      }
    }
    if (!resolvedId) resolvedId = uuid();
    employeeUsersWithIds.push({
      ...row,
      id: resolvedId,
      mustChangePassword: true,
    });
  }
  if (supabaseEnabled) {
    console.log(
      `  ✅ ${provisionedCount} employee auth users provisioned (` +
        `${employeeUsersWithIds.length - provisionedCount} reused)`,
    );
  } else {
    console.log(
      `  ⚠️  Skipped Supabase auth provisioning for employees (no service key)`,
    );
  }

  await prisma.user.createMany({ data: employeeUsersWithIds });
  const employeeIdByEmail = new Map(
    employeeUsersWithIds.map((u) => [u.email, u.id!]),
  );
  for (const row of employeeUsersWithIds) {
    USER_IDS.push(row.id!);
  }

  const employeeUserRolesData: Prisma.UserRoleUncheckedCreateInput[] =
    employeeUsersData.map((row) => ({
      userId: employeeIdByEmail.get(row.email)!,
      roleId: employeeRoleId,
      assignedBy: adminUserId,
    }));
  await prisma.userRole.createMany({
    data: employeeUserRolesData,
    skipDuplicates: true,
  });
  console.log(
    `  ✅ ${1 + EMPLOYEE_NAMES.length} users (1 admin + ${EMPLOYEE_NAMES.length} employees)\n`,
  );

  // ─── 4a. ORGANIZATION TENANCY (home org) ───
  // Matches migration backfill so greenfield seed has the same shape as
  // migrate-deployed environments. Idempotent upserts.
  console.log("=== 4a. Organization tenancy ===");
  const HOME_ORG_ID = "org_manut_home";
  const homeOrg = await prisma.organization.upsert({
    where: { slug: "manut" },
    update: { name: "Manut", status: "active", deletedAt: null },
    create: {
      id: HOME_ORG_ID,
      name: "Manut",
      slug: "manut",
      status: "active",
    },
  });
  await prisma.entity.updateMany({
    where: { organizationId: null, deletedAt: null },
    data: { organizationId: homeOrg.id },
  });
  for (const userId of USER_IDS) {
    const isAdmin = userId === adminUserId;
    await prisma.organizationMembership.upsert({
      where: {
        organizationId_userId: {
          organizationId: homeOrg.id,
          userId,
        },
      },
      update: {
        orgRole: isAdmin ? "super_admin" : "user",
        isActive: true,
      },
      create: {
        organizationId: homeOrg.id,
        userId,
        orgRole: isAdmin ? "super_admin" : "user",
        isActive: true,
      },
    });
  }
  await prisma.user.update({
    where: { id: adminUserId },
    data: {
      activeOrganizationId: homeOrg.id,
      platformRole: "platform_admin",
    },
  });
  await prisma.user.updateMany({
    where: {
      id: { in: USER_IDS.filter((id) => id !== adminUserId) },
      activeOrganizationId: null,
    },
    data: { activeOrganizationId: homeOrg.id },
  });
  console.log(`  ✅ Home org ${homeOrg.slug} + ${USER_IDS.length} memberships\n`);

  // ─── 4b. MODULE ACCESS (sample overrides) ───
  console.log("=== 4b. Module Access ===");
  const MODULES_ALL = [
    "home",
    "aria",
    "messages",
    "projects",
    "partners",
    "deals",
    "career",
    "application",
    "survey",
    "leave",
    "travel",
    "expense",
    "directory",
    "admin",
    "role",
    "user",
  ];
  const sampleModuleAccess: Prisma.ModuleAccessUncheckedCreateInput[] = [];
  for (const uid of USER_IDS.slice(1, 4)) {
    for (const mod of MODULES_ALL) {
      sampleModuleAccess.push({
        userId: uid,
        moduleId: mod,
        granted: true,
        grantedBy: adminUserId,
      });
    }
  }
  await prisma.moduleAccess.createMany({
    data: sampleModuleAccess,
    skipDuplicates: true,
  });
  console.log(`  ✅ ${sampleModuleAccess.length} module access entries\n`);

  // ─── 4c. CRM LEAD SOURCES (PRD §11.7 lookup) ───
  console.log("=== 4c. CRM Lead Sources ===");
  const LEAD_SOURCE_SEED = [
    { code: "web", label: "Web inbound", sortOrder: 10 },
    { code: "referral", label: "Referral", sortOrder: 20 },
    { code: "conference", label: "Conference", sortOrder: 30 },
    { code: "partner", label: "Partner", sortOrder: 40 },
    { code: "cold", label: "Cold outreach", sortOrder: 50 },
    { code: "other", label: "Other", sortOrder: 60 },
  ];
  await prisma.$transaction(
    LEAD_SOURCE_SEED.map((s) =>
      prisma.leadSource.upsert({
        where: { code: s.code },
        // System rows always re-assert label / sort / isSystem so admins
        // can't rename them via the upcoming admin UI to confusing values.
        update: {
          label: s.label,
          sortOrder: s.sortOrder,
          isSystem: true,
          isActive: true,
        },
        create: {
          code: s.code,
          label: s.label,
          sortOrder: s.sortOrder,
          isSystem: true,
          isActive: true,
        },
      }),
    ),
  );
  console.log(`  ✅ ${LEAD_SOURCE_SEED.length} lead sources\n`);

  // ─── 4d. CRM LOST REASONS (PRD §11.7 lookup) ───
  console.log("=== 4d. CRM Lost Reasons ===");
  const LOST_REASON_SEED = [
    { code: "no-budget", label: "No budget", sortOrder: 10 },
    { code: "no-decision-maker", label: "No decision-maker", sortOrder: 20 },
    {
      code: "lost-to-competitor",
      label: "Lost to competitor",
      sortOrder: 30,
    },
    { code: "no-response", label: "No response / ghosted", sortOrder: 40 },
    { code: "bad-fit", label: "Bad fit", sortOrder: 50 },
    { code: "timing", label: "Timing — revisit later", sortOrder: 60 },
    { code: "other", label: "Other", sortOrder: 70 },
  ];
  await prisma.$transaction(
    LOST_REASON_SEED.map((r) =>
      prisma.lostReason.upsert({
        where: { code: r.code },
        update: {
          label: r.label,
          sortOrder: r.sortOrder,
          isSystem: true,
          isActive: true,
        },
        create: {
          code: r.code,
          label: r.label,
          sortOrder: r.sortOrder,
          isSystem: true,
          isActive: true,
        },
      }),
    ),
  );
  console.log(`  ✅ ${LOST_REASON_SEED.length} lost reasons\n`);

  // ─── 4e. SALES REVENUE CRM lookups ───
  // Independent parallel of the Sales CRM (revenue_* tables). The init
  // migration seeds these on prod (migrate deploy); staging uses db:push,
  // so this block is what populates them there.
  console.log("=== 4e. Sales Revenue CRM lookups ===");
  await prisma.$transaction(
    LEAD_SOURCE_SEED.map((s) =>
      prisma.revenueLeadSource.upsert({
        where: { code: s.code },
        update: {
          label: s.label,
          sortOrder: s.sortOrder,
          isSystem: true,
          isActive: true,
        },
        create: {
          code: s.code,
          label: s.label,
          sortOrder: s.sortOrder,
          isSystem: true,
          isActive: true,
        },
      }),
    ),
  );
  await prisma.$transaction(
    LOST_REASON_SEED.map((r) =>
      prisma.revenueLostReason.upsert({
        where: { code: r.code },
        update: {
          label: r.label,
          sortOrder: r.sortOrder,
          isSystem: true,
          isActive: true,
        },
        create: {
          code: r.code,
          label: r.label,
          sortOrder: r.sortOrder,
          isSystem: true,
          isActive: true,
        },
      }),
    ),
  );
  const REVENUE_STAGE_SEED = [
    { key: "qualified", label: "Qualified", probability: 20, sortOrder: 10, color: "border-t-blue-500" },
    { key: "proposal", label: "Proposal", probability: 40, sortOrder: 20, color: "border-t-violet-500" },
    { key: "negotiation", label: "Negotiation", probability: 60, sortOrder: 30, color: "border-t-amber-500" },
    { key: "closed_won", label: "Closed Won", probability: 100, sortOrder: 40, color: "border-t-emerald-500" },
    { key: "live", label: "Live", probability: 100, sortOrder: 50, color: "border-t-green-600" },
    { key: "closed_lost", label: "Closed Lost", probability: 0, sortOrder: 60, color: "border-t-red-500" },
  ];
  await prisma.$transaction(
    REVENUE_STAGE_SEED.map((s) =>
      prisma.revenueStageConfig.upsert({
        where: { key: s.key },
        update: { label: s.label, probability: s.probability, sortOrder: s.sortOrder, color: s.color },
        create: s,
      }),
    ),
  );
  console.log("  ✅ revenue lead sources + lost reasons + stage config\n");

  // ─── 5. LEAVE TYPES ────────────────────────
  console.log("=== 5. Leave Types ===");
  for (const lt of LEAVE_TYPES) {
    const existing = await prisma.leaveType.findFirst({
      where: { entityId: null, code: lt.code },
      select: { id: true },
    });
    if (existing) {
      await prisma.leaveType.update({
        where: { id: existing.id },
        data: {
          name: lt.name,
          category: lt.category,
          daysPerYear: lt.daysPerYear,
          requiresApproval: lt.requiresApproval,
          isPaid: lt.isPaid,
          isActive: true,
        },
      });
    } else {
      await prisma.leaveType.create({
        data: {
          ...lt,
          isActive: true,
        },
      });
    }
  }
  const leaveTypeRows = await prisma.leaveType.findMany({
    where: { code: { in: LEAVE_TYPES.map((lt) => lt.code) } },
  });
  for (const lt of leaveTypeRows) {
    LEAVE_TYPE_IDS[lt.code] = lt.id;
  }
  console.log(`  ✅ ${LEAVE_TYPES.length} leave types\n`);

  // ─── 6. LEAVE BALANCES ─────────────────────
  console.log("=== 6. Leave Balances ===");
  const leaveBalancesData: Prisma.LeaveBalanceUncheckedCreateInput[] = [];
  for (const uid of USER_IDS) {
    for (let li = 0; li < LEAVE_TYPES.length; li++) {
      const lt = LEAVE_TYPES[li]!;
      const seed =
        uid.split("").reduce((a, ch) => a + ch.charCodeAt(0), 0) + li * 19;
      const used = Math.min(
        lt.daysPerYear,
        (seed * 2 + (lt.code === "SL" ? 1 : 0)) % Math.min(lt.daysPerYear, 8),
      );
      leaveBalancesData.push({
        employeeId: uid,
        leaveTypeId: LEAVE_TYPE_IDS[lt.code]!,
        year,
        entitled: lt.daysPerYear,
        used,
        carried: seed % 3,
        adjustment: 0,
      });
    }
  }
  await prisma.leaveBalance.deleteMany({ where: { year } });
  await prisma.leaveBalance.createMany({ data: leaveBalancesData });
  console.log(`  ✅ ${leaveBalancesData.length} leave balances\n`);

  // ─── 6b. BALANCE TRANSACTIONS ─────────────
  console.log("=== 6b. Balance transactions ===");
  const balanceTxData: Prisma.BalanceTransactionUncheckedCreateInput[] = [];
  for (let i = 0; i < SEED_MIN; i++) {
    const lt = LEAVE_TYPES[i % LEAVE_TYPES.length]!;
    balanceTxData.push({
      employeeId: USER_IDS[1 + (i % 24)]!,
      leaveTypeId: LEAVE_TYPE_IDS[lt.code]!,
      year,
      type: i % 2 === 0 ? "accrual" : "adjustment",
      amount: 1 + (i % 5),
      description: `Leave ledger — ${lt.name} (${year})`,
    });
  }
  await prisma.balanceTransaction.createMany({ data: balanceTxData });
  console.log(`  ✅ ${balanceTxData.length} balance transactions\n`);

  // ─── 7. LEAVE REQUESTS ─────────────────────
  console.log("=== 7. Leave Requests ===");
  const LEAVE_STATUSES = [
    "pending",
    "approved",
    "approved",
    "approved",
    "rejected",
  ];
  const leaveRequestsData: Prisma.LeaveRequestUncheckedCreateInput[] = [];
  for (let i = 0; i < BULK_ROWS; i++) {
    const empId = USER_IDS[1 + (i % 24)]!;
    const lt = LEAVE_TYPES[i % LEAVE_TYPES.length]!;
    const status = LEAVE_STATUSES[i % LEAVE_STATUSES.length]!;
    const startDaysAgo = daysAgoDeterministic(i, 55);
    const days = 1 + (i % 4);
    leaveRequestsData.push({
      employeeId: empId,
      leaveTypeId: LEAVE_TYPE_IDS[lt.code]!,
      entityId: entityIdAt(i),
      startDate: pastDate(startDaysAgo),
      endDate: pastDate(startDaysAgo - days),
      days: dec(days),
      reason: [
        "Family event",
        "Medical appointment",
        "Personal matter",
        "Vacation trip",
        "Rest day",
      ][i % 5]!,
      status,
      // Mirror what the app does on approval: an approved request has
      // its days drawn down, so the refund paths (cancel / delete) know
      // there is something to give back.
      balanceDeducted: status === "approved",
      approvedBy: status === "approved" ? adminUserId : undefined,
      approvedAt:
        status === "approved" ? pastDate(startDaysAgo - 1) : undefined,
      rejectReason:
        status === "rejected" ? "Insufficient leave balance" : undefined,
    });
  }
  await prisma.leaveRequest.createMany({ data: leaveRequestsData });
  console.log(`  ✅ ${leaveRequestsData.length} leave requests\n`);

  // ─── 8. EXPENSE CATEGORIES ─────────────────
  console.log("=== 8. Expense Categories ===");
  const expenseCatsData = EXPENSE_CATEGORIES.map((name) => ({
    name,
    isActive: true,
  }));
  await prisma.expenseCategory.deleteMany({
    where: { name: { in: EXPENSE_CATEGORIES } },
  });
  await prisma.expenseCategory.createMany({ data: expenseCatsData });
  const expenseCatRows = await prisma.expenseCategory.findMany({
    where: { name: { in: EXPENSE_CATEGORIES } },
  });
  const expenseCatIdByName = new Map(expenseCatRows.map((r) => [r.name, r.id]));
  EXPENSE_CAT_IDS.length = 0;
  for (const name of EXPENSE_CATEGORIES) {
    EXPENSE_CAT_IDS.push(expenseCatIdByName.get(name)!);
  }
  console.log(`  ✅ ${EXPENSE_CATEGORIES.length} expense categories\n`);

  // ─── 8b. ALLOWANCE EXPENSE CATEGORIES ──────
  // IT-15: Meal/Transportation/Phone allowances route through the
  // dedicated 3-stage allowance approval chain (Sarah → Payroll → Kit)
  // configured below. Mirrors migration 20260711000000.
  const ALLOWANCE_CATEGORIES = [
    {
      name: "Meal Allowance",
      description:
        "Monthly meal allowance — routed through the allowance approval chain.",
    },
    {
      name: "Transportation Allowance",
      description:
        "Monthly transportation allowance — routed through the allowance approval chain.",
    },
    {
      name: "Phone Allowance",
      description:
        "Monthly phone bill allowance — routed through the allowance approval chain.",
    },
  ];
  for (const cat of ALLOWANCE_CATEGORIES) {
    await prisma.expenseCategory.upsert({
      where: { name: cat.name },
      create: {
        name: cat.name,
        description: cat.description,
        isActive: true,
        isAllowance: true,
      },
      update: { isAllowance: true, isActive: true },
    });
  }
  console.log(`  ✅ ${ALLOWANCE_CATEGORIES.length} allowance categories\n`);

  // ─── 8c. ALLOWANCE APPROVAL STEPS ──────────
  // Three stages, all gated on `report.category = "allowance"`. The
  // service layer overrides the report category at submit time when
  // every line item belongs to an `isAllowance` category.
  //
  // `approverUserId` is left null on a fresh seed; HR wires Sarah and
  // Kit through the admin UI (or here in dev — see below). Until the
  // assignment lands the step still appears in the snapshot but no
  // user holds the inbox row, so an `expense:hr-approve` holder must
  // action it via the HR escape hatch.
  //
  // We also narrow the seeded default Direct-Manager / Skip-Level-
  // Manager steps to non-allowance categories so they don't apply to
  // allowance reports. Only the as-shipped defaults are touched —
  // custom HR-configured rows keep their existing filters.
  await prisma.expenseApprovalStep.updateMany({
    where: {
      order: 1,
      approverType: "manager",
      name: "Direct Manager",
      categoryFilter: { equals: [] },
    },
    data: { categoryFilter: ["general", "business_or_bd"] },
  });
  await prisma.expenseApprovalStep.updateMany({
    where: {
      order: 2,
      approverType: "manager_l2",
      name: "Skip-Level Manager",
      categoryFilter: { equals: [] },
    },
    data: { categoryFilter: ["general", "business_or_bd"] },
  });

  const ALLOWANCE_STEPS = [
    {
      order: 100,
      name: "Allowance — First Approval (Sarah)",
      description:
        "First approval gate for monthly allowance reports (Meal, Transportation, Phone). Assigned to Khun Sarah.",
    },
    {
      order: 101,
      name: "Allowance — Payroll Filled",
      description:
        "Payroll team approves after the allowance figure has been entered into the payroll system. Triggers the final sign-off stage.",
    },
    {
      order: 102,
      name: "Allowance — Final Sign-off (Kit)",
      description:
        "Final sign-off after payroll transfer is complete. Closes the allowance report (status → reimbursed). Assigned to Kit.",
    },
  ];
  for (const step of ALLOWANCE_STEPS) {
    await prisma.expenseApprovalStep.upsert({
      where: { order: step.order },
      create: {
        order: step.order,
        name: step.name,
        description: step.description,
        approverType: "user",
        approverUserId: null,
        categoryFilter: ["allowance"],
        isActive: true,
      },
      update: {
        name: step.name,
        description: step.description,
        approverType: "user",
        categoryFilter: ["allowance"],
        isActive: true,
      },
    });
  }
  console.log(`  ✅ ${ALLOWANCE_STEPS.length} allowance approval steps\n`);

  // ─── 9. EXPENSES ───────────────────────────
  console.log("=== 9. Expenses ===");
  const EXP_STATUSES = [
    "pending",
    "pending",
    "approved",
    "approved",
    "rejected",
  ];
  const expenseDescriptions = [
    "Grab ride to client meeting",
    "Team lunch at Sushi Den",
    "AWS monthly subscription",
    "MacBook Pro charger",
    "Figma annual license",
    "Conference registration fee",
    "Client dinner",
    "Google Workspace",
    "Flight to Singapore",
    "Hotel in Dubai",
    "Team offsite activities",
    "Electricity bill",
    "Udemy course",
    "Office chairs",
    "DHL shipping",
    "Fuel reimbursement",
    "Notion subscription",
    "Zoom Pro license",
    "WeWork hot desk",
    "LinkedIn Premium",
    "Taxi to airport",
    "Co-working space rental",
    "Adobe Creative Cloud",
    "Slack Business",
    "Domain renewal",
  ];

  const expensesData: Prisma.ExpenseUncheckedCreateInput[] = [];
  for (let i = 0; i < BULK_ROWS; i++) {
    const empId = USER_IDS[1 + (i % 24)]!;
    const status = EXP_STATUSES[i % EXP_STATUSES.length]!;
    expensesData.push({
      employeeId: empId,
      entityId: entityIdAt(i),
      categoryId: EXPENSE_CAT_IDS[i % EXPENSE_CAT_IDS.length]!,
      description: expenseDescriptions[i % expenseDescriptions.length]!,
      amount: dec(890 + i * 1840 + (i % 5) * 220),
      currency: ["THB", "AED", "SGD", "EUR"][i % 4]!,
      date: pastDate(daysAgoDeterministic(i, 88)),
      status,
      approvedBy: status === "approved" ? adminUserId : undefined,
      approvedAt:
        status === "approved"
          ? pastDate(daysAgoDeterministic(i + 3, 28))
          : undefined,
      rejectReason: status === "rejected" ? "Missing receipt" : undefined,
    });
  }
  await prisma.expense.createMany({ data: expensesData });
  console.log(`  ✅ ${BULK_ROWS} expenses\n`);

  // ─── 10. CHART OF ACCOUNTS (per entity) ────
  console.log("=== 10. Chart of Accounts ===");
  const COA_TEMPLATE = [
    { code: "1000", name: "Cash and Cash Equivalents", type: "asset" },
    { code: "1100", name: "Accounts Receivable", type: "asset" },
    { code: "1200", name: "Prepaid Expenses", type: "asset" },
    { code: "1300", name: "Inventory", type: "asset" },
    { code: "1400", name: "Fixed Assets", type: "asset" },
    { code: "2000", name: "Accounts Payable", type: "liability" },
    { code: "2100", name: "Accrued Liabilities", type: "liability" },
    { code: "2200", name: "Short-Term Loans", type: "liability" },
    { code: "2300", name: "Tax Payable", type: "liability" },
    { code: "2400", name: "Unearned Revenue", type: "liability" },
    { code: "3000", name: "Common Stock", type: "equity" },
    { code: "3100", name: "Retained Earnings", type: "equity" },
    { code: "3200", name: "Additional Paid-In Capital", type: "equity" },
    { code: "4000", name: "Service Revenue", type: "revenue" },
    { code: "4100", name: "Product Revenue", type: "revenue" },
    { code: "4200", name: "Consulting Revenue", type: "revenue" },
    { code: "4300", name: "Interest Income", type: "revenue" },
    { code: "5000", name: "Cost of Goods Sold", type: "expense" },
    { code: "5100", name: "Salaries & Wages", type: "expense" },
    { code: "5200", name: "Rent Expense", type: "expense" },
    { code: "5300", name: "Utilities Expense", type: "expense" },
    { code: "5400", name: "Marketing Expense", type: "expense" },
    { code: "5500", name: "Travel Expense", type: "expense" },
    { code: "5600", name: "Depreciation Expense", type: "expense" },
    { code: "5700", name: "Insurance Expense", type: "expense" },
  ];

  const coaData: Prisma.ChartOfAccountUncheckedCreateInput[] = [];
  const entityIds = entityRows.map((e) => e.id);
  for (const entityId of entityIds) {
    ACCOUNT_IDS[entityId] = [];
    const entityIdx = entityIds.indexOf(entityId);
    for (const acct of COA_TEMPLATE) {
      coaData.push({
        entityId,
        code: acct.code,
        name: acct.name,
        type: acct.type,
        balance: dec(22000 + entityIdx * 15000 + parseInt(acct.code, 10) * 35),
      });
    }
  }
  // Finance-suite tax + rounding control accounts (beyond the base template).
  // Referenced by the accounting AccountMapping + TaxCode config in 10c below.
  const FINANCE_EXTRA_ACCOUNTS = [
    { code: "1150", name: "Input VAT (VAT Receivable)", type: "asset" },
    { code: "1160", name: "Withholding Tax Receivable", type: "asset" },
    { code: "2310", name: "Output VAT (VAT Payable)", type: "liability" },
    { code: "2320", name: "Withholding Tax Payable", type: "liability" },
    { code: "6000", name: "Rounding Difference", type: "expense" },
  ];
  for (const entityId of entityIds) {
    for (const acct of FINANCE_EXTRA_ACCOUNTS) {
      coaData.push({ entityId, code: acct.code, name: acct.name, type: acct.type });
    }
  }
  // Clear finance-suite config that FK-references chart_of_accounts
  // (account_mappings is ON DELETE RESTRICT) BEFORE wiping the CoA, so an
  // idempotent re-seed doesn't trip a foreign-key violation.
  await prisma.accountMapping.deleteMany({ where: { entityId: { in: entityIds } } });
  await prisma.taxCode.deleteMany({ where: { entityId: { in: entityIds } } });
  await prisma.documentSequence.deleteMany({ where: { entityId: { in: entityIds } } });
  await prisma.chartOfAccount.deleteMany({
    where: { entityId: { in: entityIds } },
  });
  await prisma.chartOfAccount.createMany({ data: coaData });
  const coaRows = await prisma.chartOfAccount.findMany({
    where: { entityId: { in: entityIds } },
  });
  const coaKey = (entityId: string, code: string) => `${entityId}::${code}`;
  const coaIdByKey = new Map(
    coaRows.map((r) => [coaKey(r.entityId, r.code), r.id]),
  );
  for (const entityId of entityIds) {
    ACCOUNT_IDS[entityId] = COA_TEMPLATE.map(
      (t) => coaIdByKey.get(coaKey(entityId, t.code))!,
    );
  }
  console.log(`  ✅ ${coaData.length} chart of accounts\n`);

  // ─── 10c. Accounting suite config (mappings, tax codes, doc sequences) ──
  // The GL posting engine resolves accounts through AccountMapping, computes
  // tax via TaxCode, and numbers documents via DocumentSequence. Seeded per
  // entity so a fresh dev DB can post immediately. (Prod finance configures
  // these via Accounting → Settings; prod seed does not create them.) Config
  // tables are cleared in section 10 above, before the CoA wipe, to respect
  // the account_mappings → chart_of_accounts RESTRICT FK.
  console.log("=== 10c. Accounting suite config ===");
  const acctId = (entityId: string, code: string) =>
    coaIdByKey.get(coaKey(entityId, code))!;

  const MAPPING_TEMPLATE: Array<{ role: string; code: string }> = [
    { role: "ar_control", code: "1100" },
    { role: "ap_control", code: "2000" },
    { role: "revenue_default", code: "4000" },
    { role: "expense_default", code: "5000" },
    { role: "vat_output", code: "2310" },
    { role: "vat_input", code: "1150" },
    { role: "wht_payable", code: "2320" },
    { role: "wht_receivable", code: "1160" },
    { role: "retained_earnings", code: "3100" },
    { role: "rounding", code: "6000" },
  ];
  await prisma.accountMapping.createMany({
    data: entityIds.flatMap((entityId) =>
      MAPPING_TEMPLATE.map((m) => ({
        entityId,
        role: m.role,
        chartOfAccountId: acctId(entityId, m.code),
      })),
    ),
  });

  const TAX_CODE_TEMPLATE: Array<{
    code: string;
    name: string;
    kind: string;
    rate: number;
    glCode?: string;
  }> = [
    { code: "VAT7-OUT", name: "Output VAT 7%", kind: "vat-output", rate: 0.07, glCode: "2310" },
    { code: "VAT7-IN", name: "Input VAT 7%", kind: "vat-input", rate: 0.07, glCode: "1150" },
    { code: "VAT0", name: "VAT 0% / Exempt", kind: "vat-output", rate: 0 },
    { code: "WHT3", name: "Withholding Tax 3% (services)", kind: "wht", rate: 0.03, glCode: "2320" },
    { code: "WHT5", name: "Withholding Tax 5% (rental)", kind: "wht", rate: 0.05, glCode: "2320" },
  ];
  await prisma.taxCode.createMany({
    data: entityIds.flatMap((entityId) =>
      TAX_CODE_TEMPLATE.map((t) => ({
        entityId,
        code: t.code,
        name: t.name,
        kind: t.kind,
        rate: dec(t.rate),
        glAccountId: t.glCode ? acctId(entityId, t.glCode) : null,
      })),
    ),
  });

  const DOC_SEQ_TEMPLATE: Array<{ docType: string; prefix: string; padWidth: number }> = [
    { docType: "invoice", prefix: "INV-", padWidth: 4 },
    { docType: "bill", prefix: "BILL-", padWidth: 4 },
    { docType: "quote", prefix: "QT-", padWidth: 4 },
    { docType: "po", prefix: "PO-", padWidth: 4 },
    { docType: "credit-note", prefix: "CN-", padWidth: 4 },
    { docType: "je", prefix: "JE-", padWidth: 6 },
  ];
  await prisma.documentSequence.createMany({
    data: entityIds.flatMap((entityId) =>
      DOC_SEQ_TEMPLATE.map((s) => ({
        entityId,
        docType: s.docType,
        prefix: s.prefix,
        padWidth: s.padWidth,
        nextNumber: 1,
      })),
    ),
  });
  console.log(
    `  ✅ accounting config: ${MAPPING_TEMPLATE.length} mappings, ${TAX_CODE_TEMPLATE.length} tax codes, ${DOC_SEQ_TEMPLATE.length} sequences per entity\n`,
  );

  // ─── 10b. EXCHANGE RATES ───────────────────
  console.log("=== 10b. Exchange rates ===");
  const FX_CURRENCIES = [
    "THB",
    "AED",
    "SGD",
    "EUR",
    "GBP",
    "JPY",
    "CHF",
    "CAD",
    "AUD",
    "NZD",
    "KRW",
    "CNY",
    "HKD",
    "INR",
    "MYR",
    "IDR",
    "PHP",
    "VND",
    "TWD",
    "MXN",
  ];
  const fxDate = d(`${year}-01-15`);
  const exchangeRatesData: Prisma.ExchangeRateUncheckedCreateInput[] =
    FX_CURRENCIES.slice(0, FX_RATE_COUNT).map((currency, i) => ({
      baseCurrency: "USD",
      currency,
      rate: dec(15 + i * 0.37),
      effectiveDate: fxDate,
      source: "seed",
    }));
  await prisma.exchangeRate.createMany({
    data: exchangeRatesData,
    skipDuplicates: true,
  });
  console.log(`  ✅ ${exchangeRatesData.length} exchange rates\n`);

  // ─── 11. JOURNAL ENTRIES ───────────────────
  console.log("=== 11. Journal Entries ===");
  const JE_STATUSES = ["draft", "draft", "posted", "posted", "approved"];
  const jeDescriptions = [
    "Monthly salary payment",
    "AWS cloud services",
    "Office rent payment",
    "Client invoice payment",
    "Equipment purchase",
    "Insurance premium",
    "Marketing campaign",
    "Travel reimbursement",
    "Software subscription",
    "Consulting fee",
    "Revenue recognition",
    "Depreciation entry",
    "Utility payment",
    "Tax provision",
    "Interest payment",
    "Inventory purchase",
    "Client deposit",
    "Loan payment",
    "Dividend distribution",
    "Payroll tax",
    "Year-end adjustment",
    "Prepaid insurance",
    "Accrued liabilities",
    "Bad debt provision",
    "Currency revaluation",
  ];

  const journalEntriesData: Prisma.JournalEntryUncheckedCreateInput[] = [];
  const journalEntryNos: string[] = [];

  for (let i = 0; i < BULK_ROWS; i++) {
    const entityId = entityIdAt(i);
    const status = JE_STATUSES[i % JE_STATUSES.length]!;
    const entryNo = `JE-${year}-${String(i + 1).padStart(4, "0")}`;
    journalEntryNos.push(entryNo);
    journalEntriesData.push({
      entityId,
      entryNo,
      date: pastDate(25 + ((i * 11) % 150)),
      description: jeDescriptions[i % jeDescriptions.length]!,
      status,
      createdBy: adminUserId,
      approvedBy: status !== "draft" ? adminUserId : undefined,
      approvedAt: status !== "draft" ? pastDate(30) : undefined,
      postedAt: status === "posted" ? pastDate(25) : undefined,
    });
  }
  await prisma.journalEntry.createMany({ data: journalEntriesData });
  const jeRows = await prisma.journalEntry.findMany({
    where: { entryNo: { in: journalEntryNos } },
  });
  const jeIdByEntryNo = new Map(jeRows.map((j) => [j.entryNo, j.id]));

  const journalEntryLinesData: Prisma.JournalEntryLineUncheckedCreateInput[] =
    [];
  for (let i = 0; i < BULK_ROWS; i++) {
    const entityId = entityIdAt(i);
    const entryNo = journalEntryNos[i]!;
    const jeId = jeIdByEntryNo.get(entryNo)!;
    const accounts = ACCOUNT_IDS[entityId]!;
    const amount = dec(4200 + i * 9100 + (i % 4) * 800);
    journalEntryLinesData.push(
      {
        entryId: jeId,
        accountId: accounts[0]!,
        debit: amount,
        credit: dec(0),
      },
      {
        entryId: jeId,
        accountId: accounts[5]!,
        debit: dec(0),
        credit: amount,
      },
    );
  }
  await prisma.journalEntryLine.createMany({ data: journalEntryLinesData });
  console.log(`  ✅ ${BULK_ROWS} journal entries with lines\n`);

  // ─── 12. INVOICES ─────────────────────────
  console.log("=== 12. Invoices ===");
  const INV_STATUSES = ["draft", "sent", "sent", "paid", "overdue"];
  const invoiceCounterparties = [
    "Amazon Web Services",
    "Google Cloud Platform",
    "Microsoft Azure",
    "Stripe Inc",
    "Cloudflare Inc",
    "Vercel Inc",
    "Figma Inc",
    "Notion Labs",
    "Slack Technologies",
    "Zoom Video Communications",
    "Atlassian Corporation",
    "GitHub Inc",
    "JetBrains s.r.o.",
    "MongoDB Inc",
    "Twilio Inc",
    "SendGrid (Twilio)",
    "Datadog Inc",
    "PagerDuty Inc",
    "Intercom Inc",
    "HubSpot Inc",
    "Sentry.io",
    "Linear Inc",
    "1Password (AgileBits)",
    "Loom Inc",
    "Miro (RealtimeBoard)",
  ];

  const invoicesData: Prisma.InvoiceUncheckedCreateInput[] = [];
  for (let i = 0; i < BULK_ROWS; i++) {
    invoicesData.push({
      entityId: entityIdAt(i),
      invoiceNo: `INV-${year}-${String(i + 1).padStart(4, "0")}`,
      type: i % 3 === 0 ? "payable" : "receivable",
      counterparty: invoiceCounterparties[i % invoiceCounterparties.length]!,
      amount: dec(12000 + i * 14200 + (i % 3) * 3300),
      currency: ["THB", "AED", "SGD", "EUR"][i % 4]!,
      issueDate: pastDate(55 + ((i * 3) % 25)),
      dueDate: futureDate(12 + ((i * 5) % 40)),
      status: INV_STATUSES[i % INV_STATUSES.length]!,
    });
  }
  await prisma.invoice.createMany({ data: invoicesData });
  console.log(`  ✅ ${BULK_ROWS} invoices\n`);

  // ─── 13. BANK TRANSACTIONS ────────────────
  console.log("=== 13. Bank Transactions ===");
  const BANK_STATUSES = [
    "unmatched",
    "unmatched",
    "matched",
    "matched",
    "reconciled",
  ];
  const bankDescriptions = [
    "Wire transfer from client",
    "Payroll disbursement",
    "AWS payment",
    "Google Cloud payment",
    "Rent payment",
    "Insurance premium",
    "Client deposit",
    "Vendor payment",
    "Equipment purchase",
    "Software license",
    "Marketing campaign",
    "Travel booking",
    "Utility bill payment",
    "Tax payment",
    "Loan repayment",
    "Interest earned",
    "Dividend received",
    "Consulting fee received",
    "Refund from vendor",
    "Subscription renewal",
    "Office supplies",
    "Team dinner",
    "Conference fee",
    "Domain renewal",
    "Hosting payment",
  ];

  const bankTxData: Prisma.BankTransactionUncheckedCreateInput[] = [];
  for (let i = 0; i < BULK_ROWS; i++) {
    const entityId = entityIdAt(i);
    bankTxData.push({
      entityId,
      date: pastDate(daysAgoDeterministic(i + 1, 85)),
      description: bankDescriptions[i % bankDescriptions.length]!,
      amount: dec((i % 2 === 0 ? 1 : -1) * (2400 + i * 6200 + (i % 5) * 900)),
      balance: dec(180000 + i * 12000 + (i % 7) * 4000),
      reference: `REF-${String(i + 1).padStart(6, "0")}`,
      bankAccount: ["SCB-TH-001", "ENBD-AE-001", "DBS-SG-001", "BPI-PT-001"][
        i % 4
      ]!,
      status: BANK_STATUSES[i % BANK_STATUSES.length]!,
    });
  }
  await prisma.bankTransaction.createMany({ data: bankTxData });
  console.log(`  ✅ ${BULK_ROWS} bank transactions\n`);

  // ─── 14. BNRY TRANSACTIONS ────────────────
  console.log("=== 14. BNRY Transactions ===");
  const bnryDescriptions = [
    "Token mint for Series A",
    "Burn from treasury",
    "Transfer to exchange",
    "Staking reward distribution",
    "Unstake from validator",
    "Community airdrop",
    "Partnership allocation",
    "Team vesting unlock",
    "Liquidity pool deposit",
    "Bridge transfer",
    "DAO treasury transfer",
    "Marketing campaign allocation",
    "Advisor token release",
    "Bug bounty reward",
    "Ecosystem grant",
    "Token buyback",
    "Strategic reserve",
    "OTC deal",
    "Market maker allocation",
    "Cross-chain bridge",
    "Governance reward",
    "Protocol fee distribution",
    "Referral bonus",
    "Testnet reward",
    "Migration swap",
  ];

  const bnryTxData: Prisma.BnryTransactionUncheckedCreateInput[] = [];
  for (let i = 0; i < BULK_ROWS; i++) {
    bnryTxData.push({
      date: pastDate(40 + ((i * 13) % 120)),
      type: ["mint", "burn", "transfer", "stake", "unstake"][i % 5]!,
      amount: dec(900 + i * 4100 + (i % 6) * 350),
      reference: `BNRY-${String(i + 1).padStart(6, "0")}`,
      description: bnryDescriptions[i % bnryDescriptions.length]!,
    });
  }
  await prisma.bnryTransaction.createMany({ data: bnryTxData });
  console.log(`  ✅ ${BULK_ROWS} BNRY transactions\n`);

  // ─── 15. PAYROLL RUNS + PAYSLIPS ──────────
  console.log("=== 15. Payroll Runs & Payslips ===");
  const months = [
    "2025-10",
    "2025-11",
    "2025-12",
    "2026-01",
    "2026-02",
    "2026-03",
  ];

  const payrollRunsData: Prisma.PayrollRunUncheckedCreateInput[] = [];
  type PayslipSeed = {
    entityId: string;
    period: string;
    employeeId: string;
    base: number;
    gross: number;
    net: number;
    currency: string;
  };
  const payslipSeeds: PayslipSeed[] = [];

  for (let m = 0; m < months.length; m++) {
    const period = months[m]!;
    for (let e = 0; e < 4; e++) {
      const entityId = entityIdByCode[ENTITY_CODE_ORDER[e]!]!;
      const status = m < 4 ? "completed" : m === 4 ? "approved" : "draft";

      payrollRunsData.push({
        entityId,
        period,
        status,
        totalGross: dec(248000 + m * 8200 + e * 4100),
        totalNet: dec(198000 + m * 6400 + e * 3300),
        totalTax: dec(36000 + m * 900 + e * 400),
        runBy: adminUserId,
        approvedBy: status !== "draft" ? adminUserId : undefined,
        approvedAt: status !== "draft" ? pastDate(m * 30) : undefined,
        paidAt: status === "completed" ? pastDate(m * 30 - 2) : undefined,
        notes: `Payroll for ${period}`,
      });

      const entityUsers = USER_IDS.filter((_, idx) => idx > 0 && idx % 4 === e);
      for (const uid of entityUsers.slice(0, 5)) {
        const base = 52000 + (entityUsers.indexOf(uid) % 6) * 8500 + m * 400;
        const gross = base * 1.15;
        const net = base * 0.85;
        payslipSeeds.push({
          entityId,
          period,
          employeeId: uid,
          base,
          gross,
          net,
          currency: ["THB", "AED", "SGD", "EUR"][e]!,
        });
      }
    }
  }
  await prisma.payrollRun.createMany({ data: payrollRunsData });
  const payrollRunRows = await prisma.payrollRun.findMany({
    where: { period: { in: months } },
  });
  const payrollRunIdByEntityPeriod = new Map(
    payrollRunRows.map((r) => [`${r.entityId}::${r.period}`, r.id]),
  );
  const payslipsData: Prisma.PayslipUncheckedCreateInput[] = payslipSeeds.map(
    (s) => ({
      payrollRunId: payrollRunIdByEntityPeriod.get(
        `${s.entityId}::${s.period}`,
      )!,
      employeeId: s.employeeId,
      baseSalary: dec(s.base),
      allowances: { housing: 5000, transport: 2000, meal: 1500 },
      deductions: { tax: s.base * 0.1, socialSecurity: 750 },
      grossPay: dec(s.gross),
      netPay: dec(s.net),
      currency: s.currency,
    }),
  );
  await prisma.payslip.createMany({ data: payslipsData });
  console.log(
    `  ✅ ${payrollRunsData.length} payroll runs, ${payslipsData.length} payslips\n`,
  );

  // ─── 16. CONSULTANT INVOICES ──────────────
  console.log("=== 16. Consultant Invoices ===");
  const consultantInvoicesData: Prisma.ConsultantInvoiceUncheckedCreateInput[] =
    [];
  for (let i = 0; i < BULK_ROWS; i++) {
    const consultantId = USER_IDS[Math.min(21 + (i % 4), USER_IDS.length - 1)]!;
    consultantInvoicesData.push({
      entityId: entityIdAt(i),
      consultantId,
      invoiceNo: `CI-${year}-${String(i + 1).padStart(4, "0")}`,
      amount: dec(28000 + i * 7200 + (i % 4) * 2100),
      whtRate: dec(3),
      whtAmount: dec(840 + i * 216 + (i % 3) * 90),
      netAmount: dec(27160 + i * 6984 + (i % 4) * 2037),
      period: months[i % months.length]!,
      status: ["pending", "approved", "paid"][i % 3]!,
      certIssued: i % 3 === 2,
    });
  }
  await prisma.consultantInvoice.createMany({ data: consultantInvoicesData });
  console.log(`  ✅ ${BULK_ROWS} consultant invoices\n`);

  // ─── 17. ESOP GRANTS ─────────────────────
  console.log("=== 17. ESOP Grants ===");
  const esopGrantsData: Prisma.EsopGrantUncheckedCreateInput[] = [];
  for (let i = 0; i < BULK_ROWS; i++) {
    esopGrantsData.push({
      employeeId: USER_IDS[1 + (i % 24)]!,
      grantDate: pastDate(400 + ((i * 17) % 300)),
      shares: 1800 + i * 420 + (i % 5) * 180,
      vestingMonths: [36, 48, 48, 60][i % 4]!,
      cliffMonths: 12,
      strikePrice: dec(0.12 + (i % 8) * 0.03),
      status: ["active", "active", "active", "vested", "exercised"][i % 5]!,
      exercisedShares: i % 5 === 4 ? 400 + (i % 4) * 120 : 0,
      notes: `Grant batch ${Math.ceil((i + 1) / 5)}`,
    });
  }
  await prisma.esopGrant.createMany({ data: esopGrantsData });
  console.log(`  ✅ ${BULK_ROWS} ESOP grants\n`);

  // ─── 18. ONBOARDING RUNS ─────────────────
  console.log("=== 18. Onboarding Runs ===");
  const ONBOARDING_TASKS = [
    { name: "IT Setup", description: "Laptop, accounts, VPN" },
    { name: "HR Orientation", description: "Policies, benefits, contracts" },
    { name: "Team Introduction", description: "Meet the team, buddy system" },
    { name: "Tool Training", description: "Slack, Jira, GitHub, Notion" },
    {
      name: "Security Training",
      description: "Infosec policies and 2FA setup",
    },
  ];

  const onboardingRunsData: Prisma.OnboardingRunUncheckedCreateInput[] = [];
  for (let i = 0; i < BULK_ROWS; i++) {
    const uid = USER_IDS[1 + (i % 24)]!;
    onboardingRunsData.push({
      employeeId: uid,
      employeeName: EMPLOYEE_NAMES[i % 24]!,
      department: DEPARTMENTS[i % DEPARTMENTS.length]!,
      startDate: pastDate(45 + ((i * 23) % 280)),
      tasks: ONBOARDING_TASKS.map((t, idx) => ({
        ...t,
        completed: idx <= i % 5,
      })),
      status: i < 9 ? "completed" : "in_progress",
      entityId: entityIdAt(i),
    });
  }
  await prisma.onboardingRun.createMany({ data: onboardingRunsData });
  console.log(`  ✅ ${BULK_ROWS} onboarding runs\n`);

  // ─── 19. TRAINING MODULES & COMPLETIONS ───
  console.log("=== 19. Training ===");
  const TRAININGS = [
    "Information Security Basics",
    "Anti-Money Laundering (AML)",
    "GDPR Compliance",
    "Workplace Safety",
    "Code of Conduct",
    "Diversity & Inclusion",
    "Project Management Fundamentals",
    "Agile & Scrum Methodology",
    "Leadership Skills",
    "Communication Skills",
    "Time Management",
    "Cloud Computing 101",
    "Data Analytics Intro",
    "Blockchain Fundamentals",
    "Web3 Security",
    "DeFi Protocols",
    "Smart Contract Development",
    "Customer Service Excellence",
    "Financial Literacy",
    "Public Speaking",
  ];

  const trainingCategories = [
    "compliance",
    "compliance",
    "compliance",
    "compliance",
    "compliance",
    "soft-skills",
    "technical",
    "technical",
    "soft-skills",
    "soft-skills",
    "soft-skills",
    "technical",
    "technical",
    "technical",
    "technical",
    "technical",
    "technical",
    "soft-skills",
    "soft-skills",
    "soft-skills",
  ];

  const trainingModulesData: Prisma.TrainingModuleUncheckedCreateInput[] = [];
  for (let i = 0; i < TRAININGS.length; i++) {
    trainingModulesData.push({
      title: TRAININGS[i]!,
      description: `Training module: ${TRAININGS[i]!}`,
      category: trainingCategories[i]!,
      duration: 42 + (i % 9) * 14,
      isMandatory: i < 6,
      isActive: true,
    });
  }
  await prisma.trainingModule.createMany({ data: trainingModulesData });
  const trainingRows = await prisma.trainingModule.findMany({
    where: { title: { in: TRAININGS } },
  });
  const trainingIdByTitle = new Map(trainingRows.map((m) => [m.title, m.id]));
  TRAINING_IDS.length = 0;
  for (const title of TRAININGS) {
    TRAINING_IDS.push(trainingIdByTitle.get(title)!);
  }

  const trainingCompletionsData: Prisma.TrainingCompletionUncheckedCreateInput[] =
    [];
  const completionSet = new Set<string>();

  for (let i = 0; i < Math.min(BULK_ROWS + 6, USER_IDS.length - 1); i++) {
    const uid = USER_IDS[i + 1]!;
    const numCompleted = 3 + (i % 4);
    for (let j = 0; j < numCompleted && j < TRAINING_IDS.length; j++) {
      const key = `${uid}-${TRAINING_IDS[j]}`;
      if (!completionSet.has(key)) {
        completionSet.add(key);
        trainingCompletionsData.push({
          employeeId: uid,
          moduleId: TRAINING_IDS[j]!,
          completedAt: pastDate(30 + (i + j) * 11),
          score: 72 + ((i + j) % 5) * 4,
        });
      }
    }
  }
  await prisma.trainingCompletion.createMany({ data: trainingCompletionsData });
  console.log(
    `  ✅ ${TRAININGS.length} modules, ${trainingCompletionsData.length} completions\n`,
  );

  // ─── 20. VISA RECORDS ─────────────────────
  console.log("=== 20. Visa Records ===");
  const VISA_TYPES = [
    "work_permit",
    "business_visa",
    "digital_nomad",
    "residence_permit",
    "investor_visa",
  ];

  const visaRecordsData: Prisma.VisaRecordUncheckedCreateInput[] = [];
  for (let i = 0; i < BULK_ROWS; i++) {
    visaRecordsData.push({
      employeeId: USER_IDS[1 + (i % 24)]!,
      visaType: VISA_TYPES[i % VISA_TYPES.length]!,
      country: COUNTRIES[i % 4]!,
      issueDate: pastDate(200 + ((i * 19) % 320)),
      expiryDate: futureDate(40 + ((i * 23) % 300)),
      status: ["active", "active", "active", "expiring_soon", "expired"][
        i % 5
      ]!,
      notes: `Visa for ${EMPLOYEE_NAMES[i % 24]!}`,
      entityId: entityIdAt(i),
    });
  }
  await prisma.visaRecord.createMany({ data: visaRecordsData });
  console.log(`  ✅ ${BULK_ROWS} visa records\n`);

  // ─── 21. BENEFITS & ENROLLMENTS ───────────
  console.log("=== 21. Benefits ===");
  const BENEFITS = [
    {
      name: "Health Insurance - Gold",
      category: "health",
      provider: "AIA",
      cost: 15000,
    },
    {
      name: "Health Insurance - Silver",
      category: "health",
      provider: "AIA",
      cost: 10000,
    },
    {
      name: "Dental Plan",
      category: "health",
      provider: "Pacific Cross",
      cost: 3000,
    },
    {
      name: "Life Insurance",
      category: "insurance",
      provider: "AIA",
      cost: 5000,
    },
    {
      name: "Gym Membership",
      category: "wellness",
      provider: "Fitness First",
      cost: 2500,
    },
    {
      name: "Mental Health Support",
      category: "wellness",
      provider: "Spring Health",
      cost: 1500,
    },
    {
      name: "Education Allowance",
      category: "development",
      provider: "Internal",
      cost: 20000,
    },
    {
      name: "Commuter Benefit",
      category: "transport",
      provider: "Internal",
      cost: 3000,
    },
    {
      name: "Child Education Allowance",
      category: "family",
      provider: "Internal",
      cost: 10000,
    },
    {
      name: "Co-working Space",
      category: "workspace",
      provider: "WeWork",
      cost: 8000,
    },
    {
      name: "Phone Allowance",
      category: "equipment",
      provider: "Internal",
      cost: 2000,
    },
    {
      name: "Home Office Setup",
      category: "equipment",
      provider: "Internal",
      cost: 15000,
    },
    {
      name: "Annual Checkup",
      category: "health",
      provider: "Bumrungrad",
      cost: 5000,
    },
    {
      name: "Vision Care",
      category: "health",
      provider: "Pacific Cross",
      cost: 2000,
    },
    {
      name: "Pet Insurance",
      category: "lifestyle",
      provider: "Pawsome",
      cost: 1500,
    },
    {
      name: "Travel Insurance",
      category: "insurance",
      provider: "AXA",
      cost: 3000,
    },
    {
      name: "Meal Voucher",
      category: "meals",
      provider: "Internal",
      cost: 3500,
    },
    {
      name: "Parking Benefit",
      category: "transport",
      provider: "Internal",
      cost: 2000,
    },
    {
      name: "Wellness Retreat",
      category: "wellness",
      provider: "Internal",
      cost: 5000,
    },
    {
      name: "Book Allowance",
      category: "development",
      provider: "Internal",
      cost: 1000,
    },
  ];

  const benefitsData: Prisma.BenefitUncheckedCreateInput[] = [];
  for (const b of BENEFITS) {
    benefitsData.push({
      name: b.name,
      category: b.category,
      provider: b.provider,
      cost: dec(b.cost),
      currency: "THB",
      entityId: entityIdByCode["TH"]!,
      isActive: true,
    });
  }
  await prisma.benefit.createMany({ data: benefitsData });
  const benefitRows = await prisma.benefit.findMany({
    where: { name: { in: BENEFITS.map((b) => b.name) } },
  });
  const benefitIdByName = new Map(benefitRows.map((r) => [r.name, r.id]));
  BENEFIT_IDS.length = 0;
  for (const b of BENEFITS) {
    BENEFIT_IDS.push(benefitIdByName.get(b.name)!);
  }

  const benefitEnrollmentsData: Prisma.BenefitEnrollmentUncheckedCreateInput[] =
    [];
  const enrollmentSet = new Set<string>();

  for (let i = 0; i < BULK_ROWS; i++) {
    const uid = USER_IDS[1 + (i % 24)]!;
    const numBenefits = 2 + (i % 3);
    for (let j = 0; j < numBenefits; j++) {
      const bid = BENEFIT_IDS[(i * 3 + j) % BENEFIT_IDS.length]!;
      const key = `${bid}-${uid}`;
      if (!enrollmentSet.has(key)) {
        enrollmentSet.add(key);
        benefitEnrollmentsData.push({
          benefitId: bid,
          employeeId: uid,
          startDate: pastDate(160 + (i + j) * 21),
          status: "active",
        });
      }
    }
  }
  await prisma.benefitEnrollment.createMany({ data: benefitEnrollmentsData });
  console.log(
    `  ✅ ${BENEFITS.length} benefits, ${benefitEnrollmentsData.length} enrollments\n`,
  );

  // ─── 22. PARTNERS ─────────────────────────
  console.log("=== 22. Partners ===");
  const PARTNER_DATA = [
    {
      company: "Binance",
      type: "exchange",
      status: "active",
      region: "Global",
      country: "Malta",
    },
    {
      company: "CoinGecko",
      type: "data_provider",
      status: "active",
      region: "APAC",
      country: "Malaysia",
    },
    {
      company: "Chainlink",
      type: "technology",
      status: "active",
      region: "Global",
      country: "USA",
    },
    {
      company: "Polygon",
      type: "blockchain",
      status: "active",
      region: "Global",
      country: "India",
    },
    {
      company: "AWS",
      type: "cloud",
      status: "active",
      region: "Global",
      country: "USA",
    },
    {
      company: "Google Cloud",
      type: "cloud",
      status: "active",
      region: "Global",
      country: "USA",
    },
    {
      company: "Alchemy",
      type: "infrastructure",
      status: "active",
      region: "Global",
      country: "USA",
    },
    {
      company: "The Graph",
      type: "indexer",
      status: "active",
      region: "Global",
      country: "USA",
    },
    {
      company: "Fireblocks",
      type: "custody",
      status: "prospect",
      region: "Global",
      country: "Israel",
    },
    {
      company: "Circle",
      type: "stablecoin",
      status: "prospect",
      region: "Global",
      country: "USA",
    },
    {
      company: "Consensys",
      type: "technology",
      status: "active",
      region: "Global",
      country: "USA",
    },
    {
      company: "Aave",
      type: "defi",
      status: "prospect",
      region: "Global",
      country: "UK",
    },
    {
      company: "Uniswap Labs",
      type: "defi",
      status: "active",
      region: "Global",
      country: "USA",
    },
    {
      company: "OpenSea",
      type: "nft",
      status: "inactive",
      region: "Global",
      country: "USA",
    },
    {
      company: "Dune Analytics",
      type: "analytics",
      status: "active",
      region: "EU",
      country: "Norway",
    },
    {
      company: "Nansen",
      type: "analytics",
      status: "prospect",
      region: "APAC",
      country: "Singapore",
    },
    {
      company: "Moralis",
      type: "infrastructure",
      status: "active",
      region: "EU",
      country: "Sweden",
    },
    {
      company: "QuickNode",
      type: "infrastructure",
      status: "active",
      region: "Global",
      country: "USA",
    },
    {
      company: "Ledger",
      type: "hardware",
      status: "prospect",
      region: "EU",
      country: "France",
    },
    {
      company: "Trezor",
      type: "hardware",
      status: "prospect",
      region: "EU",
      country: "Czech Republic",
    },
    {
      company: "Aptos Labs",
      type: "blockchain",
      status: "active",
      region: "Global",
      country: "USA",
    },
    {
      company: "Sui Foundation",
      type: "blockchain",
      status: "prospect",
      region: "Global",
      country: "USA",
    },
  ];

  const partnersData: Prisma.PartnerUncheckedCreateInput[] = [];
  type PartnerContactSeed = {
    company: string;
    name: string;
    title: string;
    email: string;
    phone: string;
    isPrimary: boolean;
  };
  const partnerContactSeeds: PartnerContactSeed[] = [];

  const PARTNER_CONTACT_NAMES = [
    "Changpeng Zhao",
    "Bobby Ong",
    "Sergey Nazarov",
    "Sandeep Nailwal",
    "Adam Selipsky",
    "Thomas Kurian",
    "Nikil Viswanathan",
    "Yaniv Tal",
    "Michael Shaulov",
    "Jeremy Allaire",
    "Joseph Lubin",
    "Stani Kulechov",
    "Hayden Adams",
    "Devin Finzer",
    "Fredrik Haga",
    "Alex Svanevik",
    "Ivan Liljeqvist",
    "Alex Porat",
    "Pascal Gauthier",
    "Marek Palatinus",
    "Mo Shaikh",
    "Evan Cheng",
  ];

  for (let i = 0; i < PARTNER_DATA.length; i++) {
    const p = PARTNER_DATA[i]!;
    partnersData.push({
      company: p.company,
      slug: `__seed_pending_${i}`,
      type: p.type,
      status: p.status,
      region: p.region,
      country: p.country,
      website: `https://${p.company.toLowerCase().replace(/\s+/g, "")}.com`,
      contractValue:
        p.status === "active"
          ? dec(120000 + (i % 9) * 38000 + (PARTNER_DATA.length - i) * 4000)
          : undefined,
      contractStart: p.status === "active" ? pastDate(365) : undefined,
      contractEnd: p.status === "active" ? futureDate(365) : undefined,
    });

    const contactName = PARTNER_CONTACT_NAMES[i]!;
    const contactEmail =
      contactName.toLowerCase().replace(/\s+/g, ".") +
      `@${p.company.toLowerCase().replace(/\s+/g, "")}.com`;
    partnerContactSeeds.push({
      company: p.company,
      name: contactName,
      title: [
        "CEO",
        "CTO",
        "Head of Partnerships",
        "BD Manager",
        "VP Strategy",
      ][i % 5]!,
      email: contactEmail,
      phone: `+1-${String(200 + (i % 8))}${String(100 + i * 7).padStart(3, "0")}-${String(1000 + i * 37).padStart(4, "0")}`,
      isPrimary: true,
    });
  }
  await prisma.partner.createMany({ data: partnersData });
  const partnerRows = await prisma.partner.findMany({
    where: { company: { in: PARTNER_DATA.map((p) => p.company) } },
  });
  await prisma.$transaction(
    partnerRows.map((row) =>
      prisma.partner.update({
        where: { id: row.id },
        data: {
          slug: `${slugify(row.company, { lower: true, strict: true }).slice(0, 80)}-${row.id}`,
        },
      }),
    ),
  );
  const partnerIdByCompany = new Map(partnerRows.map((r) => [r.company, r.id]));
  PARTNER_IDS.length = 0;
  for (const p of PARTNER_DATA) {
    PARTNER_IDS.push(partnerIdByCompany.get(p.company)!);
  }
  const partnerContactsData: Prisma.PartnerContactUncheckedCreateInput[] =
    partnerContactSeeds.map((c) => ({
      partnerId: partnerIdByCompany.get(c.company)!,
      name: c.name,
      title: c.title,
      email: c.email,
      phone: c.phone,
      isPrimary: c.isPrimary,
    }));
  await prisma.partnerContact.createMany({ data: partnerContactsData });
  console.log(`  ✅ ${PARTNER_DATA.length} partners with contacts\n`);

  // ─── 23. DEALS ────────────────────────────
  console.log("=== 23. Deals ===");
  const DEAL_CONFIGS: {
    company: string;
    contact: string;
    stage: string;
    probability: number;
    type: string;
    valueMin: number;
    valueMax: number;
    notes?: string;
  }[] = [
    {
      company: "Alpha Ventures",
      contact: "James Chen",
      stage: "lead",
      probability: 10,
      type: "partnership",
      valueMin: 10000,
      valueMax: 50000,
    },
    {
      company: "Beta Labs",
      contact: "Sarah Kim",
      stage: "lead",
      probability: 15,
      type: "integration",
      valueMin: 25000,
      valueMax: 75000,
    },
    {
      company: "Gamma DAO",
      contact: "Michael Torres",
      stage: "lead",
      probability: 20,
      type: "consulting",
      valueMin: 15000,
      valueMax: 40000,
    },
    {
      company: "Delta Protocol",
      contact: "Anna Weber",
      stage: "lead",
      probability: 15,
      type: "saas",
      valueMin: 30000,
      valueMax: 80000,
    },
    {
      company: "Epsilon Network",
      contact: "David Park",
      stage: "qualified",
      probability: 30,
      type: "partnership",
      valueMin: 100000,
      valueMax: 300000,
    },
    {
      company: "Zeta Finance",
      contact: "Lisa Chang",
      stage: "qualified",
      probability: 35,
      type: "licensing",
      valueMin: 150000,
      valueMax: 400000,
      notes: "Interested in white-label solution",
    },
    {
      company: "Theta Solutions",
      contact: "Robert Singh",
      stage: "qualified",
      probability: 40,
      type: "integration",
      valueMin: 80000,
      valueMax: 200000,
    },
    {
      company: "Iota Systems",
      contact: "Emily Nakamura",
      stage: "qualified",
      probability: 35,
      type: "saas",
      valueMin: 50000,
      valueMax: 150000,
    },
    {
      company: "Kappa Exchange",
      contact: "Daniel Okonkwo",
      stage: "proposal",
      probability: 50,
      type: "partnership",
      valueMin: 200000,
      valueMax: 800000,
      notes: "Proposal sent, awaiting board review",
    },
    {
      company: "Lambda DeFi",
      contact: "Maria Gonzalez",
      stage: "proposal",
      probability: 55,
      type: "licensing",
      valueMin: 250000,
      valueMax: 600000,
    },
    {
      company: "Mu Crypto",
      contact: "Thomas Lee",
      stage: "proposal",
      probability: 60,
      type: "integration",
      valueMin: 100000,
      valueMax: 350000,
      notes: "Technical POC completed successfully",
    },
    {
      company: "Nu Blockchain",
      contact: "Sophie Martin",
      stage: "proposal",
      probability: 50,
      type: "consulting",
      valueMin: 75000,
      valueMax: 200000,
    },
    {
      company: "Xi Analytics",
      contact: "Chris Johnson",
      stage: "negotiation",
      probability: 70,
      type: "saas",
      valueMin: 500000,
      valueMax: 1500000,
      notes: "Final pricing negotiation in progress",
    },
    {
      company: "Omicron Capital",
      contact: "Rachel Patel",
      stage: "negotiation",
      probability: 75,
      type: "partnership",
      valueMin: 800000,
      valueMax: 2000000,
      notes: "Legal review of terms",
    },
    {
      company: "Pi Protocol",
      contact: "Alex Huang",
      stage: "negotiation",
      probability: 80,
      type: "licensing",
      valueMin: 300000,
      valueMax: 900000,
    },
    {
      company: "Rho Ventures",
      contact: "Karen Wu",
      stage: "negotiation",
      probability: 70,
      type: "integration",
      valueMin: 400000,
      valueMax: 1200000,
      notes: "Contract redlining phase",
    },
    {
      company: "Sigma Labs",
      contact: "Mark Thompson",
      stage: "closed_won",
      probability: 100,
      type: "partnership",
      valueMin: 1000000,
      valueMax: 3000000,
      notes: "Signed Q1 2026",
    },
    {
      company: "Tau Network",
      contact: "Jennifer Liu",
      stage: "closed_won",
      probability: 100,
      type: "saas",
      valueMin: 500000,
      valueMax: 1500000,
      notes: "Multi-year contract signed",
    },
    {
      company: "Upsilon Finance",
      contact: "Steven Brown",
      stage: "closed_won",
      probability: 100,
      type: "licensing",
      valueMin: 750000,
      valueMax: 2500000,
      notes: "Enterprise license deal",
    },
    {
      company: "Phi Solutions",
      contact: "Diana Müller",
      stage: "closed_won",
      probability: 100,
      type: "consulting",
      valueMin: 200000,
      valueMax: 800000,
    },
    {
      company: "Chi Protocol",
      contact: "Kevin Yamamoto",
      stage: "closed_lost",
      probability: 0,
      type: "partnership",
      valueMin: 300000,
      valueMax: 900000,
      notes: "Lost to competitor - pricing concerns",
    },
    {
      company: "Psi Capital",
      contact: "Natasha Petrov",
      stage: "closed_lost",
      probability: 0,
      type: "integration",
      valueMin: 150000,
      valueMax: 500000,
      notes: "Budget frozen due to market conditions",
    },
    {
      company: "Omega DAO",
      contact: "Carlos Rivera",
      stage: "closed_lost",
      probability: 0,
      type: "licensing",
      valueMin: 400000,
      valueMax: 1000000,
      notes: "Went with in-house solution",
    },
    {
      company: "MetaVerse Inc",
      contact: "Amanda Foster",
      stage: "lead",
      probability: 10,
      type: "saas",
      valueMin: 50000,
      valueMax: 120000,
    },
    {
      company: "TokenBridge Ltd",
      contact: "Bryan Walsh",
      stage: "qualified",
      probability: 40,
      type: "partnership",
      valueMin: 180000,
      valueMax: 450000,
      notes: "Strong technical fit identified",
    },
  ];

  await prisma.deal.deleteMany({});
  const dealsData: Prisma.DealUncheckedCreateInput[] = [];
  for (let i = 0; i < DEAL_CONFIGS.length; i++) {
    const cfg = DEAL_CONFIGS[i]!;
    dealsData.push({
      company: cfg.company,
      contact: cfg.contact,
      value: dec(
        cfg.valueMin + ((i * 7919) % Math.max(1, cfg.valueMax - cfg.valueMin)),
      ),
      stage: cfg.stage,
      probability: cfg.probability,
      closeDate:
        cfg.stage === "closed_won"
          ? pastDate(20 + ((i * 3) % 70))
          : cfg.stage === "closed_lost"
            ? pastDate(10 + ((i * 2) % 50))
            : futureDate(40 + ((i * 7) % 120)),
      type: cfg.type,
      country: COUNTRIES[i % 4]!,
      notes: cfg.notes,
      partnerId:
        i < PARTNER_IDS.length
          ? PARTNER_IDS[i % PARTNER_IDS.length]!
          : undefined,
      ownerId: USER_IDS[i % Math.min(8, USER_IDS.length)]!,
    });
  }
  await prisma.deal.createMany({ data: dealsData });
  console.log(`  ✅ ${DEAL_CONFIGS.length} deals\n`);

  // ─── 24. PROJECTS & TASKS ────────────────
  console.log("=== 24. Projects & Tasks ===");
  const PROJECT_NAMES = [
    "BNRY Token Launch",
    "Intranet ERP Development",
    "Mobile App v2",
    "DeFi Integration",
    "Exchange Listing Campaign",
    "Website Redesign",
    "API Gateway Migration",
    "KYC/AML System",
    "Staking Platform",
    "Analytics Dashboard",
    "NFT Marketplace",
    "Cross-chain Bridge",
    "Governance Portal",
    "Community Platform",
    "Developer SDK",
    "Documentation Portal",
    "Smart Contract Audit",
    "Performance Optimization",
    "Security Hardening",
    "Data Pipeline",
    "Mobile Wallet",
    "Token Vesting",
  ];

  const PROJECT_DESCRIPTIONS = [
    "Launch the BNRY utility token across multiple exchanges with marketing & community campaigns",
    "Build the internal ERP platform (Intranet) covering HR, Finance, Projects, and Operations",
    "Redesign and rebuild the mobile app for iOS and Android with React Native",
    "Integrate DeFi protocols (lending, staking, yield) into the BNRY ecosystem",
    "Coordinate listings on Tier 1/2 exchanges with required compliance and market making",
    "Redesign the corporate website with new branding, blog, and investor portal",
    "Migrate legacy REST API gateway to a new cloud-native architecture on AWS",
    "Implement KYC/AML verification system compliant with FATF guidelines",
    "Build a non-custodial staking platform with flexible lock periods and rewards",
    "Create real-time analytics dashboard for token metrics, TVL, and user activity",
    "Develop an NFT marketplace for community-created digital collectibles",
    "Build a cross-chain bridge supporting Ethereum, Polygon, and BSC",
    "Implement on-chain governance portal for BNRY token holders",
    "Launch community platform with forums, rewards, and ambassador program",
    "Create developer SDK and tooling for third-party integrations",
    "Build comprehensive developer documentation portal with interactive examples",
    "Commission and manage third-party smart contract security audit",
    "Optimize platform performance: reduce load times, improve caching, CDN setup",
    "Harden security posture: penetration testing, bug bounty, SOC 2 prep",
    "Build data pipeline for real-time analytics from on-chain and off-chain sources",
    "Develop self-custody mobile wallet with WalletConnect and biometrics",
    "Implement token vesting smart contracts with cliff and linear release schedules",
  ];

  const PROJ_STATUSES = [
    "planning",
    "active",
    "active",
    "active",
    "on_hold",
    "completed",
  ];

  const TASK_TEMPLATES: {
    title: string;
    desc: string;
    status: string;
    priority: string;
    dueOffset: number;
  }[][] = [
    // Template A: Full lifecycle
    [
      {
        title: "Define project scope and requirements",
        desc: "Gather business requirements and document PRD with stakeholders",
        status: "done",
        priority: "P0",
        dueOffset: -14,
      },
      {
        title: "Create technical architecture document",
        desc: "Design system architecture, data models, and API contracts",
        status: "done",
        priority: "P0",
        dueOffset: -7,
      },
      {
        title: "Set up project infrastructure",
        desc: "Configure CI/CD pipelines, staging/production environments, monitoring",
        status: "done",
        priority: "P1",
        dueOffset: 0,
      },
      {
        title: "Implement core API endpoints",
        desc: "Build REST endpoints with authentication, validation, and error handling",
        status: "in_progress",
        priority: "P0",
        dueOffset: 14,
      },
      {
        title: "Build frontend UI components",
        desc: "Implement reusable React components following the design system",
        status: "in_progress",
        priority: "P0",
        dueOffset: 21,
      },
      {
        title: "Integrate third-party services",
        desc: "Connect payment gateway, email service, and analytics SDKs",
        status: "todo",
        priority: "P1",
        dueOffset: 28,
      },
      {
        title: "Write unit and integration tests",
        desc: "Achieve 80%+ code coverage with Jest and Playwright E2E tests",
        status: "todo",
        priority: "P1",
        dueOffset: 35,
      },
      {
        title: "Perform security review",
        desc: "Run OWASP checks, dependency audit, and penetration testing",
        status: "backlog",
        priority: "P0",
        dueOffset: 42,
      },
      {
        title: "User acceptance testing",
        desc: "Coordinate UAT sessions with stakeholders and fix reported issues",
        status: "backlog",
        priority: "P1",
        dueOffset: 49,
      },
      {
        title: "Prepare deployment and rollback plan",
        desc: "Document deployment steps, feature flags, and rollback procedures",
        status: "backlog",
        priority: "P2",
        dueOffset: 56,
      },
    ],
    // Template B: Design-heavy
    [
      {
        title: "Research and competitive analysis",
        desc: "Analyze competitor products and identify differentiation opportunities",
        status: "done",
        priority: "P1",
        dueOffset: -21,
      },
      {
        title: "Create wireframes and user flows",
        desc: "Design low-fidelity wireframes and map out user journeys in Figma",
        status: "done",
        priority: "P0",
        dueOffset: -14,
      },
      {
        title: "Design high-fidelity mockups",
        desc: "Create pixel-perfect designs with dark/light mode variants",
        status: "in_progress",
        priority: "P0",
        dueOffset: 7,
      },
      {
        title: "Build design system tokens",
        desc: "Export colors, typography, spacing tokens to Tailwind CSS config",
        status: "in_progress",
        priority: "P1",
        dueOffset: 14,
      },
      {
        title: "Implement responsive layouts",
        desc: "Build mobile-first responsive layouts matching Figma designs",
        status: "todo",
        priority: "P0",
        dueOffset: 21,
      },
      {
        title: "Add micro-interactions and animations",
        desc: "Implement smooth transitions, hover states, and loading animations",
        status: "todo",
        priority: "P2",
        dueOffset: 28,
      },
      {
        title: "Accessibility audit (WCAG 2.1 AA)",
        desc: "Test with screen readers, keyboard nav, and color contrast checks",
        status: "backlog",
        priority: "P1",
        dueOffset: 35,
      },
      {
        title: "Performance optimization",
        desc: "Optimize images, lazy loading, code splitting, and Core Web Vitals",
        status: "backlog",
        priority: "P1",
        dueOffset: 42,
      },
    ],
    // Template C: Backend/infra
    [
      {
        title: "Database schema design",
        desc: "Design normalized schema with proper indexes and constraints",
        status: "done",
        priority: "P0",
        dueOffset: -14,
      },
      {
        title: "API contract definition (OpenAPI)",
        desc: "Write OpenAPI 3.1 specs for all endpoints with examples and schemas",
        status: "done",
        priority: "P0",
        dueOffset: -7,
      },
      {
        title: "Implement data access layer",
        desc: "Build repository pattern with Prisma ORM and connection pooling",
        status: "in_progress",
        priority: "P0",
        dueOffset: 7,
      },
      {
        title: "Set up message queue",
        desc: "Configure RabbitMQ/Redis for async job processing and event-driven tasks",
        status: "in_progress",
        priority: "P1",
        dueOffset: 14,
      },
      {
        title: "Build worker services",
        desc: "Implement background workers for email, notifications, and data sync",
        status: "todo",
        priority: "P1",
        dueOffset: 21,
      },
      {
        title: "Implement caching strategy",
        desc: "Add Redis caching layer for frequently accessed data and API responses",
        status: "todo",
        priority: "P1",
        dueOffset: 28,
      },
      {
        title: "Set up monitoring and alerting",
        desc: "Configure Datadog/Grafana dashboards with PagerDuty alerts",
        status: "backlog",
        priority: "P0",
        dueOffset: 35,
      },
      {
        title: "Load testing and capacity planning",
        desc: "Run k6 load tests and document capacity requirements for scaling",
        status: "backlog",
        priority: "P2",
        dueOffset: 42,
      },
      {
        title: "Write runbooks and documentation",
        desc: "Document operational procedures, troubleshooting guides, and FAQs",
        status: "backlog",
        priority: "P2",
        dueOffset: 49,
      },
    ],
    // Template D: Blockchain/Web3
    [
      {
        title: "Smart contract development",
        desc: "Write Solidity contracts with OpenZeppelin standards and upgradeability",
        status: "in_progress",
        priority: "P0",
        dueOffset: 14,
      },
      {
        title: "Contract unit tests (Hardhat)",
        desc: "Write comprehensive test suite covering all edge cases and failure modes",
        status: "in_progress",
        priority: "P0",
        dueOffset: 21,
      },
      {
        title: "Deploy to testnet",
        desc: "Deploy contracts to Sepolia/Mumbai testnet with verification on Etherscan",
        status: "todo",
        priority: "P0",
        dueOffset: 28,
      },
      {
        title: "Build frontend dApp interface",
        desc: "Create React dApp with WalletConnect, ethers.js, and transaction UX",
        status: "todo",
        priority: "P0",
        dueOffset: 35,
      },
      {
        title: "Integrate subgraph indexer",
        desc: "Build and deploy The Graph subgraph for on-chain event indexing",
        status: "todo",
        priority: "P1",
        dueOffset: 42,
      },
      {
        title: "External security audit",
        desc: "Engage CertiK/OpenZeppelin for formal audit and fix findings",
        status: "backlog",
        priority: "P0",
        dueOffset: 56,
      },
      {
        title: "Mainnet deployment plan",
        desc: "Prepare multisig deployment, timelock, and emergency pause procedures",
        status: "backlog",
        priority: "P0",
        dueOffset: 63,
      },
    ],
  ];

  const projectsData: Prisma.ProjectUncheckedCreateInput[] = [];
  type ProjectTaskSeed = {
    slug: string;
    title: string;
    description: string;
    status: string;
    priority: string;
    ownerId: string;
    dueDate: Date;
    sortOrder: number;
  };
  const projectTaskSeeds: ProjectTaskSeed[] = [];

  for (let i = 0; i < PROJECT_NAMES.length; i++) {
    const slug = slugify(PROJECT_NAMES[i]!, { lower: true, strict: true });
    projectsData.push({
      name: PROJECT_NAMES[i]!,
      slug,
      description: PROJECT_DESCRIPTIONS[i]!,
      status: PROJ_STATUSES[i % PROJ_STATUSES.length]!,
      ownerId: USER_IDS[i % Math.min(10, USER_IDS.length)]!,
      partnerId:
        i < PARTNER_IDS.length / 2
          ? PARTNER_IDS[(i * 2) % PARTNER_IDS.length]!
          : undefined,
      startDate: pastDate(100 + ((i * 13) % 160)),
      endDate: futureDate(45 + ((i * 11) % 140)),
      budget: dec(88000 + i * 42000 + (i % 4) * 12000),
    });

    const template = TASK_TEMPLATES[i % TASK_TEMPLATES.length]!;
    for (let t = 0; t < template.length; t++) {
      const task = template[t]!;
      projectTaskSeeds.push({
        slug,
        title: task.title,
        description: task.desc,
        status: task.status,
        priority: task.priority,
        ownerId: USER_IDS[(i + t) % Math.min(15, USER_IDS.length)]!,
        dueDate:
          task.dueOffset >= 0
            ? futureDate(task.dueOffset)
            : pastDate(Math.abs(task.dueOffset)),
        sortOrder: t,
      });
    }
  }
  await prisma.project.createMany({ data: projectsData });
  const projectSlugs = PROJECT_NAMES.map((n) =>
    slugify(n, { lower: true, strict: true }),
  );
  const projectRows = await prisma.project.findMany({
    where: { slug: { in: projectSlugs } },
  });
  const projectIdBySlug = new Map(projectRows.map((p) => [p.slug, p.id]));
  PROJECT_IDS.length = 0;
  for (const slug of projectSlugs) {
    PROJECT_IDS.push(projectIdBySlug.get(slug)!);
  }
  const projectTasksData: Prisma.ProjectTaskUncheckedCreateInput[] =
    projectTaskSeeds.map((t) => ({
      projectId: projectIdBySlug.get(t.slug)!,
      title: t.title,
      description: t.description,
      status: t.status,
      priority: t.priority,
      ownerId: t.ownerId,
      endDate: t.dueDate,
      sortOrder: t.sortOrder,
    }));
  await prisma.projectTask.createMany({ data: projectTasksData });
  console.log(
    `  ✅ ${PROJECT_NAMES.length} projects, ${projectTasksData.length} tasks\n`,
  );

  // ─── 24b. PROJECT COLUMNS & MEMBERS ────────
  console.log("=== 24b. Project columns & members ===");
  const KANBAN_COLUMNS: {
    key: string;
    label: string;
    color: string;
    sortOrder: number;
  }[] = [
    { key: "backlog", label: "Backlog", color: "bg-slate-500", sortOrder: 0 },
    { key: "todo", label: "To Do", color: "bg-blue-500", sortOrder: 1 },
    {
      key: "in_progress",
      label: "In Progress",
      color: "bg-amber-500",
      sortOrder: 2,
    },
    { key: "done", label: "Done", color: "bg-emerald-500", sortOrder: 3 },
  ];
  const projectColumnsData: Prisma.ProjectColumnUncheckedCreateInput[] = [];
  for (const pid of PROJECT_IDS) {
    for (const col of KANBAN_COLUMNS) {
      projectColumnsData.push({
        projectId: pid,
        key: col.key,
        label: col.label,
        color: col.color,
        sortOrder: col.sortOrder,
      });
    }
  }
  await prisma.projectColumn.createMany({ data: projectColumnsData });

  const projectMembersData: Prisma.ProjectMemberUncheckedCreateInput[] = [];
  for (let pi = 0; pi < PROJECT_IDS.length; pi++) {
    const pid = PROJECT_IDS[pi]!;
    for (let mi = 0; mi < 3; mi++) {
      const uid = USER_IDS[(pi + mi) % USER_IDS.length]!;
      projectMembersData.push({
        projectId: pid,
        userId: uid,
        role: mi === 0 ? "lead" : "member",
      });
    }
  }
  await prisma.projectMember.createMany({
    data: projectMembersData,
    skipDuplicates: true,
  });
  console.log(
    `  ✅ ${projectColumnsData.length} columns, ${projectMembersData.length} members\n`,
  );

  // ─── 25. OFFICES, DESKS, ROOMS ────────────
  console.log("=== 25. Offices ===");
  const OFFICES = [
    {
      name: "Manut Bangkok HQ",
      city: "Bangkok",
      country: "Thailand",
      timezone: "Asia/Bangkok",
      capacity: 80,
    },
    {
      name: "Manut Dubai Office",
      city: "Dubai",
      country: "UAE",
      timezone: "Asia/Dubai",
      capacity: 40,
    },
    {
      name: "Manut Singapore Hub",
      city: "Singapore",
      country: "Singapore",
      timezone: "Asia/Singapore",
      capacity: 30,
    },
    {
      name: "Manut Lisbon Lab",
      city: "Lisbon",
      country: "Portugal",
      timezone: "Europe/Lisbon",
      capacity: 25,
    },
    {
      name: "Manut Bangkok Co-work",
      city: "Bangkok",
      country: "Thailand",
      timezone: "Asia/Bangkok",
      capacity: 20,
    },
    // Brand the office names to the configured org up front so every
    // downstream lookup (createMany, findMany-by-name, the per-office loop)
    // uses the same value.
  ].map((office) => ({ ...office, name: brandOrg(office.name) }));

  const officesData: Prisma.OfficeUncheckedCreateInput[] = OFFICES.map((o) => ({
    ...o,
  }));
  await prisma.office.createMany({ data: officesData });
  const officeRows = await prisma.office.findMany({
    where: { name: { in: OFFICES.map((o) => o.name) } },
  });
  const officeIdByName = new Map(officeRows.map((r) => [r.name, r.id]));

  const desksData: Prisma.OfficeDeskUncheckedCreateInput[] = [];
  const roomsData: Prisma.MeetingRoomUncheckedCreateInput[] = [];
  OFFICE_IDS.length = 0;
  DESK_IDS.length = 0;
  ROOM_IDS.length = 0;

  for (const o of OFFICES) {
    const officeId = officeIdByName.get(o.name)!;
    OFFICE_IDS.push(officeId);

    for (let d = 1; d <= 5; d++) {
      desksData.push({
        officeId,
        name: `${o.name.split(" ")[1]}-D${d}`,
        floor: `Floor ${Math.ceil(d / 3)}`,
        zone: ["A", "B", "C"][d % 3],
      });
    }

    for (let r = 1; r <= 4; r++) {
      roomsData.push({
        officeId,
        name: `${o.city} Room ${r}`,
        capacity: [6, 10, 16, 20][r - 1],
        amenities: [
          "whiteboard,projector",
          "tv,whiteboard,video_conf",
          "projector,video_conf,whiteboard",
          "tv,projector,video_conf,whiteboard,phone",
        ][r - 1],
      });
    }
  }
  await prisma.officeDesk.createMany({ data: desksData });
  await prisma.meetingRoom.createMany({ data: roomsData });
  const deskRows = await prisma.officeDesk.findMany({
    where: { officeId: { in: OFFICE_IDS } },
  });
  const roomRows = await prisma.meetingRoom.findMany({
    where: { officeId: { in: OFFICE_IDS } },
  });
  DESK_IDS.push(
    ...deskRows.sort((a, b) => a.name.localeCompare(b.name)).map((d) => d.id),
  );
  ROOM_IDS.push(
    ...roomRows.sort((a, b) => a.name.localeCompare(b.name)).map((r) => r.id),
  );
  console.log(
    `  ✅ ${OFFICES.length} offices, ${DESK_IDS.length} desks, ${ROOM_IDS.length} rooms\n`,
  );

  // ─── 26. DESK & ROOM BOOKINGS ────────────
  console.log("=== 26. Bookings ===");
  const deskBookingsData: Prisma.DeskBookingUncheckedCreateInput[] = [];
  const deskBookingSet = new Set<string>();

  for (let i = 0; i < BULK_ROWS; i++) {
    const deskId = DESK_IDS[i % DESK_IDS.length]!;
    const date = futureDate(i);
    const key = `${deskId}-${date.toISOString().split("T")[0]}`;
    if (!deskBookingSet.has(key)) {
      deskBookingSet.add(key);
      deskBookingsData.push({
        deskId,
        employeeId: USER_IDS[1 + (i % 24)]!,
        date,
      });
    }
  }

  const TIME_SLOTS = [
    "09:00-10:00",
    "10:00-11:00",
    "11:00-12:00",
    "13:00-14:00",
    "14:00-15:00",
    "15:00-16:00",
    "16:00-17:00",
  ];
  const roomBookingsData: Prisma.RoomBookingUncheckedCreateInput[] = [];
  const roomBookingSet = new Set<string>();

  for (let i = 0; i < BULK_ROWS; i++) {
    const roomId = ROOM_IDS[i % ROOM_IDS.length]!;
    const date = futureDate(i % 10);
    const timeSlot = TIME_SLOTS[i % TIME_SLOTS.length]!;
    const key = `${roomId}-${date.toISOString().split("T")[0]}-${timeSlot}`;
    if (!roomBookingSet.has(key)) {
      roomBookingSet.add(key);
      roomBookingsData.push({
        roomId,
        employeeId: USER_IDS[1 + (i % 24)]!,
        date,
        timeSlot,
        title: [
          "Sprint Planning",
          "Design Review",
          "1:1 Meeting",
          "All Hands",
          "Tech Talk",
        ][i % 5],
      });
    }
  }
  await prisma.deskBooking.createMany({ data: deskBookingsData });
  await prisma.roomBooking.createMany({ data: roomBookingsData });
  console.log(
    `  ✅ ${deskBookingsData.length} desk bookings, ${roomBookingsData.length} room bookings\n`,
  );

  // ─── 27. ASSETS ───────────────────────────
  console.log("=== 27. Assets ===");
  const ASSET_TYPES = [
    "laptop",
    "monitor",
    "keyboard",
    "mouse",
    "headset",
    "phone",
    "desk",
    "chair",
    "webcam",
    "tablet",
  ];
  const assetNames = [
    'MacBook Pro 16"',
    'Dell UltraSharp 27"',
    "Logitech MX Keys",
    "Logitech MX Master 3",
    "Sony WH-1000XM5",
    "iPhone 15 Pro",
    "Standing Desk",
    "Herman Miller Aeron",
    "Logitech Brio",
    'iPad Pro 12.9"',
    "MacBook Air M3",
    'LG 32" 4K Monitor',
    "Keychron K2",
    "Razer DeathAdder",
    "AirPods Pro",
    "Samsung Galaxy S24",
    "Motorized Desk",
    "Steelcase Leap",
    "Elgato Facecam",
    "Samsung Tab S9",
    "ThinkPad X1 Carbon",
    'ASUS ProArt 27"',
    "Apple Magic Keyboard",
    "Apple Magic Mouse",
    "Bose QC Ultra",
  ];

  const assetsData: Prisma.AssetUncheckedCreateInput[] = [];
  for (let i = 0; i < BULK_ROWS; i++) {
    assetsData.push({
      officeId: OFFICE_IDS[i % OFFICE_IDS.length]!,
      name: assetNames[i]!,
      type: ASSET_TYPES[i % ASSET_TYPES.length]!,
      serialNo: `SN-${String(10000 + i)}`,
      assignedTo: i < 10 ? USER_IDS[1 + (i % 24)]! : undefined,
      purchaseDate: pastDate(120 + ((i * 37) % 600)),
      purchaseCost: dec(12000 + i * 4800 + (i % 4) * 900),
      status: i < 10 ? "in_use" : "available",
    });
  }
  await prisma.asset.createMany({ data: assetsData });
  console.log(`  ✅ ${BULK_ROWS} assets\n`);

  // ─── 28. CHANNELS & MESSAGES ──────────────
  console.log("=== 28. Channels & Messages ===");
  console.log("  ⏭️  Skipped: message module tables remain empty\n");

  // ─── 29. WALL POSTS & COMMENTS ────────────
  console.log("=== 29. Wall Posts ===");
  const WALL_CONTENTS = [
    "Reminder: submit your timesheets by Friday 5pm local time.",
    "We wrapped the payments integration milestone — thanks to everyone who helped with QA.",
    "Volunteers wanted for the charity 5k next month; sign-up sheet is in #general.",
    "Congratulations to everyone hitting their one-year milestones this quarter.",
    "From next month, Wednesdays are optional WFH for teams that agree with their manager.",
    "Nice work on last night's production deploy — clean rollout.",
    "Photos from the Bangkok team lunch are in the shared album.",
    "Q1 OKR review sessions are scheduled; your manager will share a calendar invite.",
    "Welcome to the new joiners starting this week — say hi in your office channels.",
    "Internal hackathon recap: three prototypes will move to a discovery phase.",
    "Annual health screening slots are open on the benefits portal.",
    "Dubai office refresh is done — new meeting pods are bookable in Intranet.",
    "Shout-out to Support for keeping response times low during the traffic spike.",
    "New compliance refresher is live in Learning; please finish by month end.",
    "Save the date: company offsite in December (details to follow).",
    "Press pick-up: Manut mentioned in this week's regional tech roundup (link in thread).",
    "Casual board-game evening in Bangkok next Friday after work.",
    "We're piloting paperless expense bundles — finance will host a short walkthrough.",
    "Performance conversations start next week; prep notes are in the HR wiki.",
    "Partnership PR is being coordinated with Comms — no external posts until the kit lands.",
    "Engineering wrote up the API migration lessons learned — worth a read.",
  ];

  const wallPostsData: Prisma.WallPostUncheckedCreateInput[] =
    WALL_CONTENTS.map((content, i) => ({
      authorId: USER_IDS[i % Math.min(15, USER_IDS.length)]!,
      content,
      type: i % 5 === 0 ? "announcement" : "post",
      likes: USER_IDS.slice(0, Math.min(6 + (i % 4), USER_IDS.length)),
      createdAt: pastDate(6 + ((i * 5) % 48)),
    }));
  await prisma.wallPost.createMany({ data: wallPostsData });
  const wallPostRows = await prisma.wallPost.findMany({
    where: { content: { in: WALL_CONTENTS } },
  });
  const wallContentIndex = new Map(WALL_CONTENTS.map((c, idx) => [c, idx]));
  wallPostRows.sort(
    (a, b) =>
      wallContentIndex.get(a.content)! - wallContentIndex.get(b.content)!,
  );
  WALL_POST_IDS.length = 0;
  WALL_POST_IDS.push(...wallPostRows.map((p) => p.id));

  const COMMENT_TEXTS = [
    "Great news!",
    "Congratulations! 🎉",
    "Well done team!",
    "Count me in!",
    "Amazing work!",
    "This is awesome!",
    "Thanks for sharing!",
    "Looking forward to it!",
    "Incredible achievement!",
    "Keep it up!",
  ];

  const wallCommentsData: Prisma.WallCommentUncheckedCreateInput[] = [];
  for (let i = 0; i < BULK_ROWS; i++) {
    wallCommentsData.push({
      postId: WALL_POST_IDS[i % WALL_POST_IDS.length]!,
      authorId: USER_IDS[1 + (i % 24)]!,
      content: COMMENT_TEXTS[i % COMMENT_TEXTS.length]!,
      createdAt: pastDate(3 + ((i * 2) % 20)),
    });
  }
  await prisma.wallComment.createMany({ data: wallCommentsData });
  console.log(
    `  ✅ ${WALL_CONTENTS.length} posts, ${wallCommentsData.length} comments\n`,
  );

  // ─── 30. COMPANY NEWS ─────────────────────
  console.log("=== 30. Company News ===");
  const NEWS = [
    { title: "Manut Secures Series A Funding of $15M", category: "funding" },
    { title: "BNRY Token Launch Date Announced", category: "product" },
    { title: "New Office Opening in Lisbon", category: "company" },
    { title: "Partnership with Binance Ecosystem", category: "partnership" },
    { title: "Q1 2026 Financial Results", category: "financial" },
    { title: "Annual Company Retreat: December 2026", category: "event" },
    { title: "New CTO Joins Manut", category: "people" },
    { title: "Sustainability Report 2025 Published", category: "company" },
    { title: "Employee of the Quarter Announced", category: "people" },
    { title: "Manut Named Top 50 Web3 Companies", category: "awards" },
    { title: "New Health Insurance Benefits Package", category: "benefits" },
    { title: "Security Audit Results: All Clear", category: "security" },
    { title: "Mobile App V2 Launch", category: "product" },
    { title: "Community Reaches 100K Members", category: "milestone" },
    { title: "New Learning Platform Launch", category: "internal" },
    { title: "Cross-Chain Bridge Goes Live", category: "product" },
    { title: "Manut Featured on Bloomberg", category: "media" },
    { title: "ISO 27001 Certification Achieved", category: "compliance" },
    { title: "New Regional Office in Singapore", category: "company" },
    { title: "Hackathon 2026 Winners Announced", category: "event" },
    { title: "BNRY Staking Program Launch", category: "product" },
    { title: "Annual Salary Review Complete", category: "internal" },
  ];

  const companyNewsData: Prisma.CompanyNewsUncheckedCreateInput[] = [];
  const NEWS_CONTENT = [
    "We are thrilled to announce the successful closing of our Series A funding round, raising $15 million led by Sequoia Capital with participation from Pantera Capital and Electric Capital. This investment will accelerate our product development and global expansion plans. The funds will be allocated towards engineering talent acquisition, market expansion in Southeast Asia and the Middle East, and scaling our infrastructure to support the growing user base.",
    "After months of development and rigorous testing, we are excited to announce the official launch date for the BNRY utility token. The token will go live on Ethereum and Polygon networks on July 15, 2026. Early supporters will be eligible for bonus allocation through our loyalty program. Full tokenomics and distribution details are available on our updated whitepaper.",
    "We are expanding our European presence with a new office in Lisbon, Portugal. The 2,500 sq ft space in the Parque das Nações district will serve as our European engineering hub, initially housing 15 team members with capacity to grow to 40. The office features modern co-working spaces, dedicated meeting rooms, and a rooftop terrace.",
    "Manut has entered into a strategic partnership with the Binance ecosystem to integrate our BNRY token into their exchange infrastructure. This collaboration includes listing support, liquidity programs, and joint marketing initiatives. The partnership is expected to significantly increase our token's visibility and trading volume across global markets.",
    "We are pleased to share our Q1 2026 financial results. Revenue grew 42% quarter-over-quarter to $3.2M, driven by strong demand for our enterprise solutions. Operating expenses remained flat at $2.1M, reflecting improved operational efficiency. Cash position stands at $18.5M following the Series A close, providing a runway of 24+ months.",
    "Save the date for our annual company retreat in Koh Samui, Thailand from December 8-12, 2026. The retreat will feature team-building activities, strategic planning sessions, a hackathon, and plenty of opportunities for cross-team bonding. Flights and accommodation will be covered for all full-time employees. Detailed itinerary and logistics will be shared in November.",
    "We are excited to welcome Dr. Sarah Chen as our new Chief Technology Officer. Sarah joins us from Google, where she led the Cloud AI division for 5 years. She holds a PhD in Computer Science from Stanford and brings deep expertise in distributed systems, blockchain architecture, and AI. Sarah will lead our engineering organization and drive our technical roadmap.",
    "Our 2025 Sustainability Report has been published, highlighting key achievements including a 35% reduction in carbon emissions from our data centers, 100% renewable energy usage in our Bangkok and Lisbon offices, and the launch of our Green Blockchain initiative. We remain committed to building technology responsibly and minimizing our environmental footprint.",
    "Congratulations to Somchai Prasert from the Engineering team for being named Employee of the Quarter! Somchai led the migration of our core API to the new microservices architecture, reducing average response times by 60% and improving system reliability to 99.97% uptime. His dedication and technical excellence exemplify our company values.",
    "Manut has been recognized in CoinDesk's annual ranking of the Top 50 Web3 Companies to Watch in 2026. The recognition highlights our innovative approach to enterprise blockchain solutions, our growing global team, and the strong traction of the BNRY ecosystem. We are honored to be listed alongside industry leaders.",
    "We are upgrading our health insurance benefits package effective July 1, 2026. Key improvements include: expanded dental and vision coverage, mental health support with unlimited therapy sessions through Spring Health, increased annual checkup allowance to 15,000 THB, and new family coverage options. Visit the Benefits portal for full details and enrollment.",
    "Our comprehensive security audit by CertiK has been completed with zero critical vulnerabilities found. The audit covered all smart contracts, API endpoints, and infrastructure components. Two medium-severity findings were identified and promptly remediated. The full audit report is available in the Data Room for investors and stakeholders.",
    "Version 2.0 of the Manut Mobile App is now available on both iOS and Android. Key features include: biometric authentication, push notifications for approvals, offline mode for travel requests, improved UX with dark mode support, and integration with the BNRY wallet. Download from the App Store or Google Play and share your feedback.",
    "Our community has officially crossed the 100,000 member milestone across all platforms. Discord leads with 45K members, followed by Telegram at 32K, and Twitter/X at 23K. To celebrate, we are launching a community rewards program with exclusive NFT drops and governance token allocations for our most active contributors.",
    "The new Manut Learning Platform is live, featuring 200+ courses across technical, leadership, and compliance categories. All employees get unlimited access to courses from Coursera, Udemy Business, and our custom internal curriculum. Mandatory compliance training must be completed by end of Q2. Track your progress through the Learning tab in Intranet.",
    "The BNRY cross-chain bridge is now live, enabling seamless token transfers between Ethereum, Polygon, and BSC networks. The bridge supports fast finality with an average transfer time of 3 minutes and competitive gas fees. Over $2M in volume was processed during the beta period with zero security incidents.",
    "Manut was featured in a Bloomberg Technology segment discussing the future of enterprise blockchain adoption in Southeast Asia. CEO James Chen highlighted our unique position bridging traditional enterprise operations with Web3 infrastructure. The segment reached an estimated audience of 2.5 million viewers globally.",
    "We have achieved ISO 27001 certification for our Information Security Management System. The certification covers all our operations across Bangkok, Dubai, Singapore, and Lisbon offices. This milestone demonstrates our commitment to the highest standards of data protection and security practices for our clients and partners.",
    "Our Singapore regional office is now fully operational, located in the One Raffles Place tower in the CBD. The 3,000 sq ft space accommodates 25 team members across Engineering, Business Development, and Operations. Singapore serves as our gateway to the broader APAC market and strengthens our regulatory presence in a key financial hub.",
    "The results of Hackathon 2026 are in! First place goes to Team Phoenix with their AI-powered document processing tool that reduces invoice processing time by 80%. Second place goes to Team Quantum for their cross-chain analytics dashboard, and third place to Team Aurora for their gamified onboarding experience. All winning projects will be evaluated for production deployment.",
    "The BNRY Staking Program has officially launched with three tier options: Flex (no lock, 5% APY), Standard (3-month lock, 12% APY), and Premium (12-month lock, 20% APY). Early stakers receive a 2% bonus for the first 30 days. Over $5M in BNRY was staked within the first 48 hours of launch.",
    "The annual salary review cycle has been completed for all entities. Average salary adjustments across the company are: 8% for top performers, 5% for meets expectations, and market adjustments for roles identified in our compensation benchmarking study. Updated compensation will be reflected in the June payroll cycle.",
  ];
  const newsArticleCount = Math.min(10, NEWS.length, NEWS_CONTENT.length);
  for (let i = 0; i < newsArticleCount; i++) {
    companyNewsData.push({
      title: NEWS[i]!.title,
      content: NEWS_CONTENT[i]!,
      category: NEWS[i]!.category,
      authorId: USER_IDS[i % Math.min(5, USER_IDS.length)]!,
      isPinned: i < 3,
      createdAt: pastDate(i * 3),
    });
  }
  await prisma.companyNews.createMany({ data: companyNewsData });
  console.log(`  ✅ ${newsArticleCount} news articles\n`);

  // ─── 31. COMPANY DATES ────────────────────
  console.log("=== 31. Company Dates ===");
  const DATES = [
    { title: "New Year's Day", type: "holiday", daysFromNow: -113 },
    { title: "Songkran Festival", type: "holiday", daysFromNow: -10 },
    { title: "Labor Day", type: "holiday", daysFromNow: 7 },
    { title: "King's Birthday", type: "holiday", daysFromNow: 45 },
    { title: "Queen's Birthday", type: "holiday", daysFromNow: 70 },
    { title: "Father's Day", type: "holiday", daysFromNow: 230 },
    { title: "Q2 All-Hands", type: "event", daysFromNow: 14 },
    { title: "Q3 All-Hands", type: "event", daysFromNow: 105 },
    { title: "Company Retreat", type: "event", daysFromNow: 200 },
    { title: "Hackathon 2026", type: "event", daysFromNow: 60 },
    { title: "Team Building - Bangkok", type: "event", daysFromNow: 30 },
    { title: "Team Building - Dubai", type: "event", daysFromNow: 45 },
    { title: "Annual Party", type: "event", daysFromNow: 250 },
    { title: "Board Meeting Q2", type: "meeting", daysFromNow: 20 },
    { title: "Board Meeting Q3", type: "meeting", daysFromNow: 110 },
    { title: "Investor Day", type: "meeting", daysFromNow: 80 },
    { title: "Product Launch Event", type: "milestone", daysFromNow: 50 },
    { title: "Series B Kickoff", type: "milestone", daysFromNow: 150 },
    { title: "ISO Audit", type: "deadline", daysFromNow: 90 },
    { title: "Tax Filing Deadline - TH", type: "deadline", daysFromNow: 35 },
    { title: "Health Checkup Week", type: "event", daysFromNow: 40 },
    { title: "Charity Run", type: "event", daysFromNow: 55 },
  ];

  const companyDatesData: Prisma.CompanyDateUncheckedCreateInput[] = [];
  for (let di = 0; di < DATES.length; di++) {
    const cd = DATES[di]!;
    companyDatesData.push({
      title: cd.title,
      date:
        cd.daysFromNow >= 0
          ? futureDate(cd.daysFromNow)
          : pastDate(Math.abs(cd.daysFromNow)),
      type: cd.type,
      location: LOCATIONS[di % LOCATIONS.length]!,
      addedBy: adminUserId,
    });
  }
  await prisma.companyDate.createMany({ data: companyDatesData });
  console.log(`  ✅ ${DATES.length} company dates\n`);

  // ─── 32. INVESTORS & INVESTMENTS ──────────
  console.log("=== 32. Investors ===");
  const INVESTOR_DATA = [
    { name: "Sequoia Capital", type: "vc" },
    { name: "Andreessen Horowitz (a16z)", type: "vc" },
    { name: "Paradigm", type: "vc" },
    { name: "Pantera Capital", type: "vc" },
    { name: "Polychain Capital", type: "vc" },
    { name: "Electric Capital", type: "vc" },
    { name: "Dragonfly Capital", type: "vc" },
    { name: "Multicoin Capital", type: "vc" },
    { name: "Galaxy Digital", type: "institutional" },
    { name: "Animoca Brands", type: "strategic" },
    { name: "Coinbase Ventures", type: "vc" },
    { name: "Binance Labs", type: "vc" },
    { name: "Jump Crypto", type: "institutional" },
    { name: "Wintermute", type: "market_maker" },
    { name: "Bessemer Venture Partners", type: "vc" },
    { name: "Digital Currency Group", type: "vc" },
    { name: "HashKey Capital", type: "vc" },
    { name: "Framework Ventures", type: "vc" },
    { name: "Mechanism Capital", type: "vc" },
    { name: "Spartan Group", type: "vc" },
    { name: "DeFiance Capital", type: "vc" },
    { name: "Lightspeed Venture Partners", type: "vc" },
  ];
  const INVESTOR_STATUSES = [
    "active",
    "active",
    "active",
    "prospect",
    "prospect",
  ];

  const investorsData: Prisma.InvestorUncheckedCreateInput[] = [];
  for (let i = 0; i < INVESTOR_DATA.length; i++) {
    investorsData.push({
      name: INVESTOR_DATA[i]!.name,
      type: INVESTOR_DATA[i]!.type,
      contactName: `${INVESTOR_DATA[i]!.name} Contact`,
      contactEmail: `contact@${INVESTOR_DATA[i]!.name.toLowerCase().replace(/[^a-z]/g, "")}.com`,
      website: `https://${INVESTOR_DATA[i]!.name.toLowerCase().replace(/[^a-z]/g, "")}.com`,
      location: [
        "San Francisco",
        "New York",
        "Singapore",
        "Hong Kong",
        "London",
      ][i % 5]!,
      status: INVESTOR_STATUSES[i % INVESTOR_STATUSES.length]!,
      visibility: "team",
      addedBy: adminUserId,
    });
  }
  await prisma.investor.createMany({ data: investorsData });
  const investorRows = await prisma.investor.findMany({
    where: { name: { in: INVESTOR_DATA.map((d) => d.name) } },
  });
  const investorIdByName = new Map(investorRows.map((r) => [r.name, r.id]));
  INVESTOR_IDS.length = 0;
  for (const d of INVESTOR_DATA) {
    INVESTOR_IDS.push(investorIdByName.get(d.name)!);
  }

  const investmentsData: Prisma.InvestmentUncheckedCreateInput[] = [];
  for (let i = 0; i < BULK_ROWS; i++) {
    investmentsData.push({
      investorId: INVESTOR_IDS[i % INVESTOR_IDS.length]!,
      type: ["equity", "equity", "token", "convertible_note", "safe"][i % 5]!,
      amount: dec(320000 + i * 195000 + (i % 4) * 22000),
      currency: "USD",
      valuation: dec(24000000 + i * 2800000 + (i % 3) * 400000),
      shares: 14000 + i * 1800 + (i % 5) * 400,
      date: pastDate(120 + ((i * 31) % 520)),
      round: ["seed", "seed", "series_a", "series_a", "pre_seed"][i % 5]!,
      status: ["committed", "committed", "received", "received", "pledged"][
        i % 5
      ]!,
      terms: { cliff: "12 months", vesting: "4 years" },
    });
  }
  await prisma.investment.createMany({ data: investmentsData });
  console.log(
    `  ✅ ${INVESTOR_DATA.length} investors, ${investmentsData.length} investments\n`,
  );

  // ─── 33. DATA ROOM DOCUMENTS ──────────────
  console.log("=== 33. Data Room ===");
  const DR_DOCS: {
    category: string;
    name: string;
    mimeType: string;
    fileSizeMin: number;
    fileSizeMax: number;
    ext: string;
  }[] = [
    {
      category: "legal",
      name: "Certificate of Incorporation",
      mimeType: "application/pdf",
      fileSizeMin: 200000,
      fileSizeMax: 800000,
      ext: "pdf",
    },
    {
      category: "legal",
      name: "Articles of Association",
      mimeType: "application/pdf",
      fileSizeMin: 300000,
      fileSizeMax: 1200000,
      ext: "pdf",
    },
    {
      category: "legal",
      name: "Shareholders Agreement",
      mimeType: "application/pdf",
      fileSizeMin: 500000,
      fileSizeMax: 2000000,
      ext: "pdf",
    },
    {
      category: "legal",
      name: "Board Resolutions",
      mimeType: "application/pdf",
      fileSizeMin: 150000,
      fileSizeMax: 600000,
      ext: "pdf",
    },
    {
      category: "legal",
      name: "Term Sheet - Series A",
      mimeType: "application/pdf",
      fileSizeMin: 100000,
      fileSizeMax: 400000,
      ext: "pdf",
    },
    {
      category: "financial",
      name: "Audited Financial Statements 2025",
      mimeType: "application/pdf",
      fileSizeMin: 1000000,
      fileSizeMax: 5000000,
      ext: "pdf",
    },
    {
      category: "financial",
      name: "Monthly P&L Report",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      fileSizeMin: 200000,
      fileSizeMax: 1500000,
      ext: "xlsx",
    },
    {
      category: "financial",
      name: "Cash Flow Projection",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      fileSizeMin: 300000,
      fileSizeMax: 2000000,
      ext: "xlsx",
    },
    {
      category: "financial",
      name: "Cap Table",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      fileSizeMin: 100000,
      fileSizeMax: 800000,
      ext: "xlsx",
    },
    {
      category: "financial",
      name: "Revenue Forecast 2026",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      fileSizeMin: 250000,
      fileSizeMax: 1200000,
      ext: "xlsx",
    },
    {
      category: "financial",
      name: "Financial Model - 3 Year",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      fileSizeMin: 500000,
      fileSizeMax: 3000000,
      ext: "xlsx",
    },
    {
      category: "technical",
      name: "Technology Architecture",
      mimeType: "application/pdf",
      fileSizeMin: 2000000,
      fileSizeMax: 8000000,
      ext: "pdf",
    },
    {
      category: "technical",
      name: "Security Audit Report",
      mimeType: "application/pdf",
      fileSizeMin: 1500000,
      fileSizeMax: 5000000,
      ext: "pdf",
    },
    {
      category: "technical",
      name: "IP Portfolio & Patents",
      mimeType: "application/pdf",
      fileSizeMin: 800000,
      fileSizeMax: 3000000,
      ext: "pdf",
    },
    {
      category: "pitch",
      name: "Investor Pitch Deck",
      mimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      fileSizeMin: 5000000,
      fileSizeMax: 10000000,
      ext: "pptx",
    },
    {
      category: "pitch",
      name: "Executive Summary",
      mimeType: "application/pdf",
      fileSizeMin: 200000,
      fileSizeMax: 600000,
      ext: "pdf",
    },
    {
      category: "pitch",
      name: "Product Roadmap",
      mimeType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      fileSizeMin: 3000000,
      fileSizeMax: 8000000,
      ext: "pptx",
    },
    {
      category: "pitch",
      name: "Market Analysis Report",
      mimeType: "application/pdf",
      fileSizeMin: 1000000,
      fileSizeMax: 4000000,
      ext: "pdf",
    },
    {
      category: "pitch",
      name: "Competitive Landscape",
      mimeType: "application/pdf",
      fileSizeMin: 500000,
      fileSizeMax: 2000000,
      ext: "pdf",
    },
    {
      category: "other",
      name: "Organizational Chart",
      mimeType: "application/pdf",
      fileSizeMin: 200000,
      fileSizeMax: 800000,
      ext: "pdf",
    },
    {
      category: "other",
      name: "Employee Handbook",
      mimeType: "application/pdf",
      fileSizeMin: 1000000,
      fileSizeMax: 3000000,
      ext: "pdf",
    },
    {
      category: "other",
      name: "Privacy Policy",
      mimeType: "application/pdf",
      fileSizeMin: 150000,
      fileSizeMax: 500000,
      ext: "pdf",
    },
  ];

  await prisma.dataRoomDocument.deleteMany({});
  const dataRoomDocsData: Prisma.DataRoomDocumentUncheckedCreateInput[] = [];
  for (let i = 0; i < DR_DOCS.length; i++) {
    const doc = DR_DOCS[i]!;
    const slug = doc.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    dataRoomDocsData.push({
      category: doc.category,
      name: doc.name,
      description: `${doc.name} - uploaded for investor due diligence`,
      fileUrl: `https://storage.supabase.co/documents/${slug}.${doc.ext}`,
      fileSize:
        doc.fileSizeMin +
        Math.floor(((doc.fileSizeMax - doc.fileSizeMin) * ((i * 7) % 13)) / 13),
      mimeType: doc.mimeType,
      version: 1 + (i % 3),
      uploadedBy: USER_IDS[i % Math.min(5, USER_IDS.length)]!,
      uploadedAt: pastDate(18 + ((i * 9) % 120)),
    });
  }
  await prisma.dataRoomDocument.createMany({ data: dataRoomDocsData });
  console.log(`  ✅ ${DR_DOCS.length} data room documents\n`);

  // ─── 34. INVESTOR UPDATES ────────────────
  console.log("=== 34. Investor Updates ===");
  const UPDATE_PERIODS = [
    "2025-Q3",
    "2025-Q4",
    "2026-Q1",
    "2026-Q2",
    "2025-10",
    "2025-11",
    "2025-12",
    "2026-01",
    "2026-02",
    "2026-03",
    "2026-04",
  ];
  const UPDATE_TITLES = [
    "Q3 2025 Quarterly Update: Foundation Building",
    "Q4 2025 Quarterly Update: Year-End Review",
    "Q1 2026 Quarterly Update: Strong Start",
    "Q2 2026 Quarterly Update: Growth Acceleration",
    "October 2025: Product Milestone Achieved",
    "November 2025: Partnership Announcement",
    "December 2025: Year in Review",
    "January 2026: New Year Kickoff",
    "February 2026: Engineering Sprint Results",
    "March 2026: Market Expansion Update",
    "April 2026: Community Growth Metrics",
    "Token Launch Progress Report",
    "Hiring Update: Team Growth to 50+",
    "Security Audit Completion - All Clear",
    "Exchange Listing Progress: 3 New Listings",
    "Regulatory Compliance Update",
    "Technology Stack Evolution",
    "Customer Acquisition: 10K Users Milestone",
    "Operational Efficiency Report",
    "Staking Program Launch Results",
  ];

  await prisma.investorUpdate.deleteMany({});
  const investorUpdatesData: Prisma.InvestorUpdateUncheckedCreateInput[] = [];
  for (let i = 0; i < BULK_ROWS; i++) {
    const status = i < 9 ? "sent" : "draft";
    investorUpdatesData.push({
      title: UPDATE_TITLES[i]!,
      content: `Detailed update for period ${UPDATE_PERIODS[i % UPDATE_PERIODS.length]!}. Key metrics, achievements, and upcoming milestones are included in this report. We continue to execute on our roadmap and are seeing strong traction across all key areas.`,
      period: UPDATE_PERIODS[i % UPDATE_PERIODS.length]!,
      status,
      sentAt: status === "sent" ? pastDate(i * 12) : undefined,
      sentBy:
        status === "sent"
          ? USER_IDS[i % Math.min(3, USER_IDS.length)]!
          : undefined,
    });
  }
  await prisma.investorUpdate.createMany({ data: investorUpdatesData });
  console.log(`  ✅ ${BULK_ROWS} investor updates\n`);

  // ─── 35. ARIA CONVERSATIONS ───────────────
  console.log("=== 35. ARIA Conversations ===");
  const ARIA_TITLES = [
    "Help with leave policy",
    "Expense report question",
    "How to use ESOP portal",
    "Office booking help",
    "Payroll inquiry",
    "Benefits enrollment",
    "Project status check",
    "Partner onboarding",
    "Visa renewal process",
    "Training completion help",
    "Accounting journal help",
    "Invoice question",
  ] as const;

  const ariaTitlesSeed = ARIA_TITLES.slice(0, BULK_ROWS);
  const ariaConversationsData: Prisma.ManutAiConversationUncheckedCreateInput[] =
    ariaTitlesSeed.map((title, i) => ({
      userId: USER_IDS[i % Math.min(15, USER_IDS.length)]!,
      title,
      createdAt: pastDate(5 + ((i * 4) % 40)),
    }));
  await prisma.manutAiConversation.createMany({ data: ariaConversationsData });
  const ariaConvRows = await prisma.manutAiConversation.findMany({
    where: { title: { in: [...ariaTitlesSeed] } },
  });
  const ariaConvIdByTitle = new Map(ariaConvRows.map((c) => [c.title!, c.id]));

  const ariaMessagesData: Prisma.ManutAiMessageUncheckedCreateInput[] = [];
  for (let i = 0; i < BULK_ROWS; i++) {
    const convId = ariaConvIdByTitle.get(ariaTitlesSeed[i]!)!;
    ariaMessagesData.push(
      {
        conversationId: convId,
        role: "user",
        content: "Hi ARIA, I need help with something.",
        createdAt: pastDate(30),
      },
      {
        conversationId: convId,
        role: "assistant",
        content:
          "Hello! I'd be happy to help. What can I assist you with today?",
        createdAt: pastDate(30),
      },
      {
        conversationId: convId,
        role: "user",
        content: "Can you explain how this feature works?",
        createdAt: pastDate(29),
      },
      {
        conversationId: convId,
        role: "assistant",
        content: "Of course! Let me walk you through the details...",
        createdAt: pastDate(29),
      },
    );
  }
  await prisma.manutAiMessage.createMany({ data: ariaMessagesData });
  console.log(
    `  ✅ ${ariaTitlesSeed.length} ARIA conversations with messages\n`,
  );

  // ─── 36. AUDIT LOG ────────────────────────
  console.log("=== 36. Audit Logs ===");
  const ACTIONS = [
    "create",
    "update",
    "delete",
    "login",
    "logout",
    "approve",
    "reject",
    "export",
  ];
  const RESOURCES = [
    "user",
    "leave_request",
    "expense",
    "journal_entry",
    "payroll_run",
    "role",
    "partner",
    "project",
    "invoice",
    "wall_post",
  ];

  const auditLogsData: Prisma.AuditLogUncheckedCreateInput[] = [];
  for (let i = 0; i < BULK_ROWS; i++) {
    auditLogsData.push({
      userId: USER_IDS[i % Math.min(10, USER_IDS.length)]!,
      action: ACTIONS[i % ACTIONS.length]!,
      resource: RESOURCES[i % RESOURCES.length]!,
      resourceId: uuid(),
      details: { ip: `192.168.1.${10 + i}`, browser: "Chrome" },
      ipAddress: `192.168.1.${10 + i}`,
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      timestamp: pastDate(daysAgoDeterministic(i + 2, 85)),
    });
  }
  await prisma.auditLog.createMany({ data: auditLogsData });
  console.log(`  ✅ ${BULK_ROWS} audit logs\n`);

  // ─── 37. SYSTEM SETTINGS ──────────────────
  console.log("=== 37. System Settings ===");
  const SETTINGS = [
    { key: "app.name", value: ORG_NAME },
    { key: "app.version", value: "1.0.0" },
    { key: "app.timezone", value: "Asia/Bangkok" },
    { key: "app.locale", value: "en" },
    { key: "leave.require_approval", value: true },
    { key: "leave.max_days_advance", value: 90 },
    { key: "payroll.auto_approve", value: false },
    { key: "expense.max_amount_without_approval", value: 5000 },
    { key: "security.session_timeout_minutes", value: 480 },
    { key: "security.max_login_attempts", value: 5 },
    { key: "notification.email_enabled", value: true },
    { key: "notification.slack_enabled", value: true },
    { key: "feature.aria_enabled", value: true },
    { key: "feature.wall_enabled", value: true },
    { key: "feature.investors_enabled", value: true },
    { key: "storage.max_file_size_mb", value: 50 },
    {
      key: "storage.allowed_extensions",
      value: ["pdf", "png", "jpg", "xlsx", "docx"],
    },
    { key: "company.founded_year", value: 2022 },
    { key: "company.headquarters", value: "Bangkok, Thailand" },
    { key: "company.website", value: "https://manut.xyz" },
  ];

  await prisma.systemSetting.deleteMany({
    where: { key: { in: SETTINGS.map((s) => s.key) } },
  });
  await prisma.systemSetting.createMany({
    data: SETTINGS.map((s) => ({
      key: s.key,
      value: s.value as Prisma.InputJsonValue,
    })),
  });
  console.log(`  ✅ ${SETTINGS.length} system settings\n`);

  // ─── 38. USER SETTINGS ────────────────────
  console.log("=== 38. User Settings ===");
  const userSettingsData: Prisma.UserSettingUncheckedCreateInput[] = [];
  const userSettingKeys = [
    "theme",
    "language",
    "notifications_email",
    "notifications_push",
    "sidebar_collapsed",
  ];

  await prisma.userSetting.deleteMany({
    where: {
      userId: { in: USER_IDS.slice(0, 20) },
      key: { in: userSettingKeys },
    },
  });

  for (let i = 0; i < Math.min(20, USER_IDS.length); i++) {
    const uid = USER_IDS[i]!;
    userSettingsData.push(
      {
        userId: uid,
        key: "theme",
        value: i % 3 === 0 ? "dark" : ("light" as Prisma.InputJsonValue),
      },
      { userId: uid, key: "language", value: "en" as Prisma.InputJsonValue },
      {
        userId: uid,
        key: "notifications_email",
        value: true as Prisma.InputJsonValue,
      },
      {
        userId: uid,
        key: "notifications_push",
        value: (i % 2 === 0) as Prisma.InputJsonValue,
      },
      {
        userId: uid,
        key: "sidebar_collapsed",
        value: false as Prisma.InputJsonValue,
      },
    );
  }
  await prisma.userSetting.createMany({ data: userSettingsData });
  console.log(`  ✅ ${userSettingsData.length} user settings\n`);

  // ─── 38b. MODULE OWNERS, GROUPS, SURVEY, PERFORMANCE, SESSIONS ─
  console.log(
    "=== 38b. Module owners, user groups, survey, performance, sessions ===",
  );
  await Promise.all(
    Array.from({ length: SEED_MIN }, (_, i) =>
      prisma.moduleOwner.upsert({
        where: { moduleId: `seed_mod_${i}` },
        create: {
          moduleId: `seed_mod_${i}`,
          ownerId: USER_IDS[i % USER_IDS.length]!,
        },
        update: { ownerId: USER_IDS[i % USER_IDS.length]! },
      }),
    ),
  );

  const userGroupRows = await prisma.$transaction(
    Array.from({ length: SEED_MIN }, (_, i) =>
      prisma.userGroup.create({
        data: {
          name: `DevGroup: ${DEPARTMENTS[i % DEPARTMENTS.length]} (${String(i + 1).padStart(2, "0")})`,
          description: `Pilot distribution list for ${DEPARTMENTS[i % DEPARTMENTS.length]} comms`,
          isActive: true,
          createdBy: adminUserId,
        },
      }),
    ),
  );
  await prisma.userGroupMember.createMany({
    data: userGroupRows.map((g, i) => ({
      groupId: g.id,
      userId: USER_IDS[(i + 1) % USER_IDS.length]!,
      addedBy: adminUserId,
    })),
  });

  // NOTE: The ESS engagement-survey seed block (surveyDefinition / surveyWave
  // / wave-based surveyResponse / uploadJob) was removed — those Prisma models
  // no longer exist in the schema (packages/database/prisma/schema/hr.prisma
  // now models Survey/SurveyQuestion/SurveyResponse/SurveyAnswer instead), so
  // the block threw `Cannot read properties of undefined (reading 'create')`
  // and blocked the entire seed. See ESS_V2_* constants above (now unused).

  const kraTemplateRows = await prisma.$transaction(
    Array.from({ length: SEED_MIN }, (_, i) =>
      prisma.kRATemplate.create({
        data: {
          name: `${DEPARTMENTS[i % DEPARTMENTS.length]} — core outcomes`,
          description: "Mid-year objectives template (sample)",
          department: DEPARTMENTS[i % DEPARTMENTS.length]!,
          isActive: true,
        },
      }),
    ),
  );

  const cycleRows = await prisma.$transaction(
    Array.from({ length: SEED_MIN }, (_, i) =>
      prisma.appraisalCycle.create({
        data: {
          name: `FY${year} performance cycle ${i + 1}`,
          startDate: pastDate(400 - i),
          endDate: futureDate(60 + i),
          status: i % 2 === 0 ? "active" : "draft",
          createdBy: adminUserId,
        },
      }),
    ),
  );

  const primaryCycleId = cycleRows[0]!.id;
  const appraisalRows = await prisma.$transaction(
    Array.from({ length: SEED_MIN }, (_, i) =>
      prisma.appraisal.create({
        data: {
          cycleId: primaryCycleId,
          employeeId: USER_IDS[i + 1]!,
          managerId: adminUserId,
          status: "completed",
          selfRating: 3 + (i % 3),
          managerRating: 4,
          finalRating: 4,
          completedAt: pastDate(5 + i),
        },
      }),
    ),
  );

  const ratingsBulk: Prisma.AppraisalRatingUncheckedCreateInput[] = [];
  for (let i = 0; i < SEED_MIN; i++) {
    ratingsBulk.push({
      appraisalId: appraisalRows[i]!.id,
      raterId: adminUserId,
      category: [
        "overall",
        "communication",
        "leadership",
        "technical",
        "execution",
      ][i % 5]!,
      score: 3 + (i % 2),
      comment: "Consistent delivery; aligns with team expectations.",
    });
  }
  const sessionsBulk: Prisma.SessionUncheckedCreateInput[] = [];
  for (let i = 0; i < SEED_MIN; i++) {
    sessionsBulk.push({
      userId: USER_IDS[i % USER_IDS.length]!,
      tokenHash: `seedhash_${i}_${uuid().replace(/-/g, "")}`,
      expiresAt: futureDate(15 + i),
      ipAddress: `203.0.113.${(i % 200) + 1}`,
      userAgent: "SeedRunner/1.0",
    });
  }

  await Promise.all([
    prisma.appraisalKRA.createMany({
      data: appraisalRows.map((ap, i) => ({
        appraisalId: ap.id,
        kraTemplateId: kraTemplateRows[i % kraTemplateRows.length]!.id,
        title: `Objective ${i + 1}: delivery & quality`,
        description: "Ship agreed milestones with sustainable pace",
        weight: 25,
        selfScore: 4,
        managerScore: 4,
      })),
    }),
    prisma.appraisalComment.createMany({
      data: appraisalRows.map((ap, i) => ({
        appraisalId: ap.id,
        authorId: adminUserId,
        content: `Review note: strong collaboration and clear ownership on goals ${i + 1}.`,
      })),
    }),
    prisma.appraisalRating.createMany({ data: ratingsBulk }),
    prisma.goal.createMany({
      data: appraisalRows.map((ap, i) => ({
        appraisalId: ap.id,
        title: `Goal ${i + 1}: roadmap execution`,
        description: "Complete scoped deliverables with stakeholders aligned",
        weight: 50,
        selfScore: 4,
        managerScore: 4,
        status: "completed",
      })),
    }),
    prisma.session.createMany({ data: sessionsBulk }),
  ]);

  console.log(
    `  ✅ module owners, groups, survey (${SEED_MIN} each domain), performance, sessions\n`,
  );

  // ─── 39. TRAVEL REQUESTS ───────────────────
  console.log("=== 39. Travel Requests ===");
  const TRAVEL_DESTINATIONS = [
    {
      dest: "Singapore",
      purpose: "Two-day client workshop — product walkthrough and Q&A",
      flightType: "economy",
    },
    {
      dest: "Dubai, UAE",
      purpose: "Quarterly entity finance close with regional leads",
      flightType: "economy",
    },
    {
      dest: "Lisbon, Portugal",
      purpose: "Engineering architecture review with Lisbon squad",
      flightType: "economy",
    },
    {
      dest: "Bangkok, Thailand",
      purpose: "HQ visit — hiring loop and leadership sync",
      flightType: "economy",
    },
    {
      dest: "London, UK",
      purpose: "Partner legal review and contract negotiation",
      flightType: "economy",
    },
    {
      dest: "Tokyo, Japan",
      purpose: "Vendor security assessment onsite",
      flightType: "economy",
    },
    {
      dest: "San Francisco, USA",
      purpose: "Investor update meetings (two-day)",
      flightType: "business",
    },
    {
      dest: "Frankfurt, Germany",
      purpose: "Banking partner integration checkpoint",
      flightType: "economy",
    },
    {
      dest: "Hong Kong",
      purpose: "Compliance clinic with external counsel",
      flightType: "economy",
    },
    {
      dest: "Sydney, Australia",
      purpose: "APAC support coverage planning session",
      flightType: "economy",
    },
    {
      dest: "Kuala Lumpur, Malaysia",
      purpose: "Regional marketing campaign review",
      flightType: "economy",
    },
    {
      dest: "Bangkok → Singapore",
      purpose: "Split week: Bangkok office then Singapore client site",
      flightType: "economy",
    },
  ] as const;

  const TRAVEL_STATUSES = [
    "draft",
    "pending",
    "pending",
    "approved",
    "approved",
    "approved",
    "rejected",
  ];
  const travelRequestsData: Prisma.TravelRequestUncheckedCreateInput[] = [];
  for (let i = 0; i < BULK_ROWS; i++) {
    const empId = USER_IDS[1 + (i % 24)]!;
    const t = TRAVEL_DESTINATIONS[i % TRAVEL_DESTINATIONS.length]!;
    const status = TRAVEL_STATUSES[i % TRAVEL_STATUSES.length]!;
    const daysAhead = 14 + ((i * 11) % 45);
    const tripDays = 2 + (i % 4);
    travelRequestsData.push({
      requestCode: `TR-${year}-${String(i + 1).padStart(4, "0")}`,
      employeeId: empId,
      entityId: entityIdAt(i),
      destination: t.dest,
      purpose: t.purpose,
      departureDate: futureDate(daysAhead),
      returnDate: futureDate(daysAhead + tripDays),
      estimatedBudget: dec(24000 + i * 6200 + (i % 3) * 1800),
      currency: ["THB", "AED", "SGD", "EUR", "USD"][i % 5]!,
      flightType: t.flightType,
      hotelRequired: true,
      notes:
        i % 4 === 0
          ? "Prefer hotel walking distance to client office"
          : undefined,
      status,
      approvedBy: status === "approved" ? adminUserId : undefined,
      approvedAt: status === "approved" ? pastDate(3 + (i % 9)) : undefined,
      rejectReason:
        status === "rejected" ? "Over quarterly travel budget cap" : undefined,
      submittedAt: status !== "draft" ? pastDate(6 + (i % 14)) : undefined,
    });
  }
  await prisma.travelRequest.createMany({ data: travelRequestsData });
  console.log(`  ✅ ${travelRequestsData.length} travel requests\n`);

  // ─── 40. JOBS (Career Listings) ───────────
  console.log("=== 40. Jobs ===");
  const JOB_LISTINGS: {
    title: string;
    type: string;
    location: string;
    department: string;
    description: string;
    active: boolean;
  }[] = [
    {
      title: "Senior Solidity Engineer",
      type: "Full-time",
      location: "Bangkok / Remote",
      department: "Engineering",
      description:
        "<p>Design, develop, and audit smart contracts using Solidity and Foundry. You'll work on our core DeFi protocols including staking, governance, and token vesting contracts.</p><h3>Requirements</h3><ul><li>3+ years Solidity experience</li><li>Deep understanding of EVM internals and gas optimization</li><li>Experience with Foundry, Hardhat, or Truffle</li></ul>",
      active: true,
    },
    {
      title: "Full Stack Developer (Next.js)",
      type: "Full-time",
      location: "Bangkok",
      department: "Engineering",
      description:
        "<p>Build and maintain our internal Intranet ERP platform using Next.js 15, React 19, TypeScript, Prisma, and Tailwind CSS. You'll own entire features from API design to UI implementation.</p><h3>Requirements</h3><ul><li>Strong TypeScript and React experience</li><li>Experience with monorepo tooling (Turborepo)</li><li>Testing with Vitest, Playwright is a plus</li></ul>",
      active: true,
    },
    {
      title: "DevOps / Infrastructure Engineer",
      type: "Full-time",
      location: "Singapore / Remote",
      department: "Engineering",
      description:
        "<p>Manage our cloud infrastructure across AWS and GCP, maintain CI/CD pipelines, and ensure 99.99% uptime for production services.</p><h3>Requirements</h3><ul><li>Kubernetes, Terraform, Docker</li><li>Monitoring tools (Datadog, Grafana)</li><li>Blockchain node operations is a bonus</li></ul>",
      active: true,
    },
    {
      title: "Product Manager - DeFi",
      type: "Full-time",
      location: "Dubai",
      department: "Product",
      description:
        "<p>Own the product roadmap for our DeFi products including staking, lending, and yield protocols. Conduct user research, define requirements, and work closely with engineering and design teams.</p><h3>Requirements</h3><ul><li>3+ years PM experience in crypto/fintech</li><li>Strong analytical and communication skills</li></ul>",
      active: true,
    },
    {
      title: "Senior UX/UI Designer",
      type: "Full-time",
      location: "Bangkok / Remote",
      department: "Design",
      description:
        "<p>Lead the design of our consumer-facing dApp and internal enterprise tools. Create intuitive interfaces for complex blockchain interactions.</p><h3>Requirements</h3><ul><li>Proficiency in Figma</li><li>Strong portfolio in Web3/fintech</li><li>Experience with design systems</li></ul>",
      active: true,
    },
    {
      title: "Blockchain Security Researcher",
      type: "Full-time",
      location: "Remote",
      department: "Engineering",
      description:
        "<p>Conduct security audits of smart contracts, identify vulnerabilities in DeFi protocols, and develop automated security testing tools.</p><h3>Requirements</h3><ul><li>Formal verification and symbolic execution</li><li>Bug bounty program experience</li><li>CTF participation is a strong plus</li></ul>",
      active: true,
    },
    {
      title: "Growth Marketing Manager",
      type: "Full-time",
      location: "Dubai",
      department: "Marketing",
      description:
        "<p>Drive user acquisition and retention for the BNRY ecosystem across web3-native channels. Manage community growth on Discord and Telegram, plan token-incentivized campaigns.</p><h3>Requirements</h3><ul><li>3+ years crypto marketing experience</li><li>KOL/influencer management</li></ul>",
      active: true,
    },
    {
      title: "Financial Controller",
      type: "Full-time",
      location: "Bangkok",
      department: "Finance",
      description:
        "<p>Oversee financial reporting, budgeting, and compliance across all four entities (Thailand, UAE, Singapore, Portugal). Manage month-end close, coordinate external audits.</p><h3>Requirements</h3><ul><li>CPA/CA certification required</li><li>GAAP and IFRS standards knowledge</li></ul>",
      active: true,
    },
    {
      title: "Data Engineer",
      type: "Full-time",
      location: "Singapore",
      department: "Engineering",
      description:
        "<p>Build real-time data pipelines ingesting on-chain and off-chain data for our analytics platform.</p><h3>Requirements</h3><ul><li>Apache Kafka, Apache Spark</li><li>Blockchain indexing (The Graph, Dune)</li><li>Proficiency in Python and SQL</li></ul>",
      active: true,
    },
    {
      title: "Backend Developer (Node.js/Express)",
      type: "Full-time",
      location: "Bangkok",
      department: "Engineering",
      description:
        "<p>Build scalable API services powering our enterprise platform. Work with Express 5, PostgreSQL, Prisma ORM, and Redis.</p><h3>Requirements</h3><ul><li>Strong TypeScript skills</li><li>API design experience</li><li>Authentication and authorization patterns</li></ul>",
      active: true,
    },
    {
      title: "Community Manager",
      type: "Full-time",
      location: "Dubai / Remote",
      department: "Marketing",
      description:
        "<p>Grow and engage our global community across Discord (45K+), Telegram (32K+), and Twitter/X (23K+). Moderate discussions, organize AMAs, coordinate with ambassador programs.</p>",
      active: true,
    },
    {
      title: "HR Business Partner",
      type: "Full-time",
      location: "Bangkok",
      department: "HR",
      description:
        "<p>Partner with department heads to drive talent strategy, performance management, and organizational development. Manage employee relations, design compensation frameworks.</p>",
      active: true,
    },
    {
      title: "QA Automation Engineer",
      type: "Full-time",
      location: "Bangkok / Remote",
      department: "Engineering",
      description:
        "<p>Build and maintain our automated testing infrastructure using Playwright, Vitest, and custom tooling. Establish testing standards, implement CI quality gates.</p>",
      active: true,
    },
    {
      title: "Technical Writer",
      type: "Contract",
      location: "Remote",
      department: "Product",
      description:
        "<p>Create and maintain developer documentation, API references, integration guides, and tutorials for the BNRY SDK and platform APIs.</p><h3>Requirements</h3><ul><li>OpenAPI/Swagger experience</li><li>Markdown-based doc systems (Docusaurus/Nextra)</li></ul>",
      active: true,
    },
    {
      title: "Legal Counsel (Crypto/Fintech)",
      type: "Full-time",
      location: "Singapore",
      department: "Legal",
      description:
        "<p>Advise on regulatory compliance across multiple jurisdictions (Thailand, UAE, Singapore, EU). Draft and review token sale agreements, partnership contracts, and regulatory filings.</p><h3>Requirements</h3><ul><li>5+ years legal experience in fintech or digital assets</li></ul>",
      active: true,
    },
    {
      title: "Mobile Developer (React Native)",
      type: "Full-time",
      location: "Bangkok",
      department: "Engineering",
      description:
        "<p>Develop and maintain our cross-platform mobile wallet app using React Native. Implement biometric authentication, WalletConnect integration, push notifications.</p>",
      active: true,
    },
    {
      title: "Business Development Manager - APAC",
      type: "Full-time",
      location: "Singapore",
      department: "Sales",
      description:
        "<p>Identify and close partnership deals with exchanges, protocols, and enterprises in the APAC region. Manage a pipeline of $5M+ in deal value, negotiate contracts.</p>",
      active: true,
    },
    {
      title: "Site Reliability Engineer",
      type: "Full-time",
      location: "Remote",
      department: "Engineering",
      description:
        "<p>Ensure the reliability and performance of our production systems handling $10M+ in daily transaction volume. Implement SLOs/SLIs, manage incident response.</p>",
      active: true,
    },
    {
      title: "Tokenomics Analyst",
      type: "Contract",
      location: "Remote",
      department: "Product",
      description:
        "<p>Model and optimize BNRY token economics including emission schedules, staking rewards, governance incentives, and burn mechanisms.</p>",
      active: true,
    },
    {
      title: "Intern - Software Engineering",
      type: "Internship",
      location: "Bangkok",
      department: "Engineering",
      description:
        "<p>Join our engineering team for a 3-6 month internship working on real production features. Gain experience with modern web technologies, blockchain development, and agile practices.</p><h3>What you'll learn</h3><ul><li>TypeScript, React, Node.js</li><li>Git workflow and code review</li><li>Agile/scrum methodology</li></ul>",
      active: true,
    },
    {
      title: "Part-time Content Strategist",
      type: "Part-time",
      location: "Remote",
      department: "Marketing",
      description:
        "<p>Develop and execute content strategy for our blog, social media, and thought-leadership pieces. 20 hours/week, flexible schedule.</p>",
      active: true,
    },
    {
      title: "Office & Facilities Coordinator",
      type: "Full-time",
      location: "Bangkok",
      department: "Operations",
      description:
        "<p>Manage day-to-day operations of the Bangkok HQ including vendor management, office supplies, desk/room booking systems, and facility maintenance.</p>",
      active: false,
    },
  ];

  await prisma.job.deleteMany({});
  const jobsData: Prisma.JobUncheckedCreateInput[] = JOB_LISTINGS.map((j) => ({
    title: j.title,
    slug: slugify(j.title, { lower: true, strict: true }),
    type: j.type,
    location: j.location,
    department: j.department,
    description: j.description,
    active: j.active,
  }));
  await prisma.job.createMany({ data: jobsData });
  const jobRows = await prisma.job.findMany({
    where: { title: { in: JOB_LISTINGS.map((j) => j.title) } },
  });
  JOB_IDS.length = 0;
  for (const j of jobRows) JOB_IDS.push(j.id);
  console.log(`  ✅ ${JOB_LISTINGS.length} jobs\n`);

  // ─── 41. JOB APPLICATIONS ─────────────────
  console.log("=== 41. Applications ===");
  const APPLICANTS: {
    name: string;
    email: string;
    mobile: string;
    linkedin?: string;
    website?: string;
  }[] = [
    {
      name: "Arun Mehta",
      email: "arun.mehta@gmail.com",
      mobile: "+91-9876543210",
      linkedin: "https://linkedin.com/in/arunmehta",
      website: "https://arunmehta.dev",
    },
    {
      name: "Wei Zhang",
      email: "wei.zhang@outlook.com",
      mobile: "+86-13800138000",
      linkedin: "https://linkedin.com/in/weizhang-dev",
      website: "https://weizhang.io",
    },
    {
      name: "Natasha Kuznetsova",
      email: "natasha.k@yandex.ru",
      mobile: "+7-925-123-4567",
      linkedin: "https://linkedin.com/in/natashakuz",
    },
    {
      name: "Carlos Mendoza",
      email: "carlos.mendoza@protonmail.com",
      mobile: "+52-55-1234-5678",
      linkedin: "https://linkedin.com/in/carlosmendoza",
      website: "https://carlosmendoza.com",
    },
    {
      name: "Yuki Sato",
      email: "yuki.sato@gmail.com",
      mobile: "+81-90-1234-5678",
      linkedin: "https://linkedin.com/in/yukisato-eng",
    },
    {
      name: "Fatima Al-Zahra",
      email: "fatima.alzahra@gmail.com",
      mobile: "+971-50-1234567",
    },
    {
      name: "Jakub Novák",
      email: "jakub.novak@seznam.cz",
      mobile: "+420-603-123-456",
      linkedin: "https://linkedin.com/in/jakubnovak",
      website: "https://jakubnovak.cz",
    },
    {
      name: "Priscilla Oliveira",
      email: "priscilla.oliveira@gmail.com",
      mobile: "+55-11-98765-4321",
      linkedin: "https://linkedin.com/in/priscillaoliveira",
    },
    {
      name: "Kwame Asante",
      email: "kwame.asante@gmail.com",
      mobile: "+233-24-123-4567",
    },
    {
      name: "Linnea Andersson",
      email: "linnea.andersson@outlook.se",
      mobile: "+46-70-123-4567",
      linkedin: "https://linkedin.com/in/linneadev",
      website: "https://linnea.dev",
    },
    {
      name: "Raj Patel",
      email: "raj.patel@protonmail.com",
      mobile: "+91-9012345678",
      linkedin: "https://linkedin.com/in/rajpatel-blockchain",
    },
    {
      name: "Mina Park",
      email: "mina.park@naver.com",
      mobile: "+82-10-1234-5678",
      linkedin: "https://linkedin.com/in/minapark",
    },
    {
      name: "Tobias Richter",
      email: "tobias.richter@web.de",
      mobile: "+49-170-1234567",
      linkedin: "https://linkedin.com/in/tobiasrichter",
      website: "https://tobias-richter.de",
    },
    {
      name: "Chiara Romano",
      email: "chiara.romano@gmail.com",
      mobile: "+39-320-1234567",
    },
    {
      name: "Thao Nguyen",
      email: "thao.nguyen@gmail.com",
      mobile: "+84-912-345-678",
      linkedin: "https://linkedin.com/in/thaonguyen",
    },
    {
      name: "Oluwaseun Adesanya",
      email: "seun.adesanya@gmail.com",
      mobile: "+234-802-345-6789",
      linkedin: "https://linkedin.com/in/seundev",
      website: "https://seundev.com",
    },
    {
      name: "Anya Petrova",
      email: "anya.petrova@gmail.com",
      mobile: "+7-916-234-5678",
    },
    {
      name: "Hiroshi Tanaka",
      email: "hiroshi.tanaka@gmail.com",
      mobile: "+81-80-2345-6789",
      linkedin: "https://linkedin.com/in/hiroshitanaka",
    },
    {
      name: "Siti Nurhaliza",
      email: "siti.nurhaliza@gmail.com",
      mobile: "+60-12-345-6789",
      linkedin: "https://linkedin.com/in/sitinurhaliza",
    },
    {
      name: "Erik Johansson",
      email: "erik.johansson@gmail.com",
      mobile: "+46-73-234-5678",
      website: "https://erikj.se",
    },
    {
      name: "Amara Diallo",
      email: "amara.diallo@outlook.com",
      mobile: "+221-77-123-4567",
      linkedin: "https://linkedin.com/in/amaradiallo",
    },
    {
      name: "Chen Wei-Lin",
      email: "weilin.chen@gmail.com",
      mobile: "+886-912-345-678",
      linkedin: "https://linkedin.com/in/weilinchen",
    },
    {
      name: "Isabella Martinez",
      email: "isabella.martinez@gmail.com",
      mobile: "+34-612-345-678",
    },
    {
      name: "Omar Hassan",
      email: "omar.hassan@gmail.com",
      mobile: "+20-100-234-5678",
      linkedin: "https://linkedin.com/in/omarhassan",
    },
    {
      name: "Karolina Kowalska",
      email: "karolina.kowalska@wp.pl",
      mobile: "+48-512-345-678",
      linkedin: "https://linkedin.com/in/karolinakowalska",
    },
  ];

  await prisma.application.deleteMany({});
  const applicationsData: Prisma.ApplicationUncheckedCreateInput[] =
    APPLICANTS.map((a, i) => ({
      name: a.name,
      email: a.email,
      mobile: a.mobile,
      linkedin: a.linkedin,
      website: a.website,
      attachment: `resumes/${a.name.toLowerCase().replace(/\s+/g, "-")}-cv.pdf`,
      jobId: JOB_IDS[i % JOB_IDS.length]!,
      createdAt: pastDate(4 + ((i * 5) % 45)),
    }));
  await prisma.application.createMany({ data: applicationsData });
  console.log(`  ✅ ${APPLICANTS.length} applications\n`);

  // ─── 42. BLOGS ─────────────────────────────
  console.log("=== 42. Blogs ===");
  const BLOG_POSTS: { title: string; content: string }[] = [
    {
      title: "Building a Scalable ERP with Next.js 15 and Turborepo",
      content:
        "<p>When we set out to build Intranet, our internal ERP platform, we faced a critical architectural decision: monolith or microservices? We chose a pragmatic middle ground using a pnpm monorepo powered by Turborepo.</p><p>Our stack includes Next.js 15 with App Router for the frontend, Express 5 for the API layer, and Prisma ORM with PostgreSQL for data persistence. This setup gives us the benefits of shared code (types, utilities, UI components) while maintaining clear boundaries between the web app, API, and database packages.</p><p>Key lessons learned: invest early in CI/CD caching (Turborepo remote cache saved us 60% build time), adopt strict TypeScript with no <code>any</code>, and use Prisma's multi-file schema feature to keep domain models organized.</p>",
    },
    {
      title: "Understanding BNRY Tokenomics: A Deep Dive",
      content:
        "<p>The BNRY token serves as the utility backbone of our ecosystem. In this post, we break down the tokenomics model that drives value for holders, stakers, and protocol participants.</p><p>Total supply is capped at 1 billion BNRY tokens with the following allocation: 30% community rewards, 20% team and advisors (4-year vesting with 1-year cliff), 25% ecosystem fund, 15% treasury, and 10% public sale. The emission schedule follows a declining curve, reducing by 15% annually.</p><p>Our staking mechanism uses a dual-reward model: base staking rewards in BNRY plus protocol fee sharing in stablecoins. This creates sustainable yield without relying solely on inflationary emissions.</p>",
    },
    {
      title: "How We Achieved ISO 27001 Certification in 6 Months",
      content:
        "<p>Achieving ISO 27001 certification as a 50-person startup might seem ambitious, but with the right approach, it's entirely achievable. Here's our playbook.</p><p>Phase 1 (Month 1-2): We conducted a comprehensive gap analysis against the ISO 27001 controls, documenting our existing security posture. Phase 2 (Month 3-4): We implemented missing controls including formal access management, incident response procedures, and business continuity planning. Phase 3 (Month 5-6): Internal audits, management reviews, and the external certification audit.</p><p>The total cost was approximately $45,000 including consulting, tooling, and audit fees. The investment has already paid for itself through increased trust from enterprise clients and investors.</p>",
    },
    {
      title: "Designing for Web3: UX Patterns That Actually Work",
      content:
        "<p>Web3 UX has a reputation problem. Wallet connections, gas fees, transaction confirmations—these are friction points that alienate mainstream users. Here's how our design team tackled these challenges.</p><p>First, we adopted progressive disclosure: users start with familiar patterns (email/password login) and gradually encounter Web3 concepts as they explore advanced features. Second, we built an abstraction layer that handles gas estimation, transaction batching, and error recovery behind a clean interface.</p><p>Our key principle: every blockchain interaction should feel no more complex than a traditional fintech app. We reduced our onboarding drop-off rate from 68% to 23% by applying these patterns.</p>",
    },
    {
      title: "Cross-Chain Bridge Architecture: Lessons from Production",
      content:
        "<p>Building a cross-chain bridge that moves real value is one of the most challenging engineering problems in blockchain. After 6 months in production handling $50M+ in volume, here are our key architectural decisions and lessons learned.</p><p>We chose a committee-based validation model with 7 validators requiring 5/7 consensus. Each bridge transaction goes through: 1) source chain lock, 2) validator attestation, 3) destination chain mint/release, 4) finality confirmation. Average transfer time is 3 minutes with 99.97% success rate.</p><p>Security-first design means every smart contract has a 48-hour timelock for parameter changes, circuit breakers for unusual volume, and rate limiting per wallet. We also maintain a 110% collateral reserve for all bridged assets.</p>",
    },
    {
      title: "Prisma ORM at Scale: Performance Patterns for PostgreSQL",
      content:
        "<p>Running Prisma ORM against a PostgreSQL database serving 10,000+ daily active users taught us valuable lessons about query optimization, connection pooling, and schema design.</p><p>Key patterns that made a difference: 1) Use <code>select</code> and <code>include</code> judiciously—never fetch full relations when you only need IDs. 2) Implement cursor-based pagination for large datasets instead of offset. 3) Use <code>createMany</code> and <code>$transaction</code> for batch operations. 4) Split your Prisma schema into domain-specific files for team scalability.</p><p>Our P99 query latency dropped from 850ms to 120ms after applying these optimizations. Connection pooling via PgBouncer with Supabase's session pooler was the single biggest improvement.</p>",
    },
    {
      title: "Building Real-Time Analytics for On-Chain Data",
      content:
        "<p>Our analytics dashboard processes 2M+ events daily from Ethereum, Polygon, and BSC. Here's the architecture that makes it possible.</p><p>The pipeline starts with blockchain node providers (Alchemy, QuickNode) feeding events into Apache Kafka topics. Stream processors transform raw events into structured metrics (TVL, volume, unique wallets), which are written to TimescaleDB for time-series queries and Redis for real-time dashboards.</p><p>Frontend uses React 19 with TanStack Query for data fetching and Recharts for visualization. WebSocket connections push live updates to connected clients. The entire system runs on AWS with auto-scaling based on block production rates.</p>",
    },
    {
      title:
        "Remote-First Culture: How We Keep 50+ People Connected Across 4 Countries",
      content:
        "<p>With team members in Bangkok, Dubai, Singapore, and Lisbon spanning UTC+1 to UTC+8, building a cohesive culture requires intentional effort. Here are the practices that work for us.</p><p>Communication: We have a 4-hour overlap window (1 PM - 5 PM Bangkok time) for synchronous meetings. Everything else is async via Notion docs and Slack threads. Every meeting has a written agenda and published notes.</p><p>Connection: Monthly virtual socials (trivia, cooking sessions, show-and-tell), quarterly in-person meetups at rotating offices, and an annual all-company retreat. Our Intranet Wall feature serves as an internal social feed for celebrating wins and sharing moments.</p><p>Trust: We measure output, not hours. Flexible schedules, unlimited PTO with a 15-day minimum, and transparent communication about company performance keep our engagement scores above 85%.</p>",
    },
    {
      title: "Smart Contract Security: Our Audit Playbook",
      content:
        "<p>Before deploying any smart contract to mainnet, we follow a rigorous 4-stage security process that has prevented every potential exploit to date.</p><p>Stage 1 - Internal Review: Peer code review with at least 2 senior engineers, using our custom Solidity linting rules and static analysis tools (Slither, Mythril). Stage 2 - Automated Testing: 100% branch coverage with Hardhat tests, including edge cases for integer overflow, reentrancy, and flash loan attacks.</p><p>Stage 3 - External Audit: We engage two independent audit firms (currently CertiK and OpenZeppelin) for every contract handling user funds. Stage 4 - Bug Bounty: A $250K bounty program on Immunefi runs continuously for all deployed contracts.</p><p>Total security investment represents approximately 20% of our engineering budget—a cost that's non-negotiable when securing user assets.</p>",
    },
    {
      title: "Migrating 100K Users to a New Authentication System",
      content:
        "<p>Last quarter, we migrated our entire user base from a custom JWT implementation to Supabase Auth. Here's how we did it with zero downtime and no forced password resets.</p><p>The migration ran in three phases: 1) Shadow writes - every auth event wrote to both old and new systems simultaneously for 2 weeks. 2) Read migration - gradually shifted reads to Supabase Auth using feature flags (10% → 50% → 100% over 5 days). 3) Cleanup - decommissioned the old auth service after 30 days of stable operation.</p><p>The tricky part was preserving bcrypt password hashes. We worked with Supabase to use their custom password import API, ensuring users could log in with existing credentials without any disruption.</p>",
    },
    {
      title: "RBAC Implementation: Beyond Simple Role Checks",
      content:
        "<p>Most RBAC implementations stop at role-based checks: is the user an admin? We needed something more granular for Intranet, where a Finance Manager should see accounting but not HR data, and a Team Lead should approve leave but not access salary information.</p><p>Our solution: granular permission codes following the <code>module:action</code> pattern (e.g., <code>leave:approve</code>, <code>payroll:read</code>, <code>accounting:post</code>). Permissions are assigned to roles, and users can have multiple roles. The system supports 270+ unique permission codes across 15 modules.</p><p>On the frontend, we use a <code>usePermission</code> hook that checks permissions client-side for UI rendering, while the API enforces the same checks server-side. This dual-layer approach prevents both unauthorized UI access and direct API exploitation.</p>",
    },
    {
      title: "Tailwind CSS 4 Migration: What Changed and Why It Matters",
      content:
        "<p>We recently migrated Intranet's frontend from Tailwind CSS 3 to v4, and the improvements are substantial. Here are the highlights from our migration experience.</p><p>The biggest win: native CSS layers and cascade management. Tailwind 4 uses <code>@layer</code> directives that work with the browser's native cascade, eliminating many specificity issues we previously solved with <code>!important</code> hacks. Build times dropped 40% thanks to the new Rust-based engine (Oxide).</p><p>Migration effort was moderate—about 3 engineering days for our 200+ component codebase. The main breaking changes were around custom configuration syntax and a few deprecated utility names. The PostCSS plugin setup was replaced with a simpler CSS import approach.</p>",
    },
    {
      title: "Building a Staking Platform: Technical Architecture",
      content:
        "<p>Our BNRY staking platform handles $15M+ in total value locked across three tiers. Here's the technical architecture that ensures security and reliability.</p><p>Smart contracts are written in Solidity 0.8.24 with OpenZeppelin's upgradeable proxy pattern. The staking contract uses a modified MasterChef-style reward distribution with per-second reward calculation. Lock periods are enforced on-chain with time-weighted multipliers.</p><p>The frontend polls contract state via ethers.js and updates every 15 seconds. For better UX, we estimate pending rewards client-side between polls. The indexer (The Graph subgraph) provides historical data for the earnings chart and portfolio performance tracking.</p>",
    },
    {
      title: "DevOps at Manut: From Manual Deploys to GitOps",
      content:
        "<p>18 months ago, deploying our services involved SSH into servers and running shell scripts. Today, every deployment is automated, tested, and reversible. Here's how we transformed our DevOps practices.</p><p>Infrastructure: All cloud resources are defined in Terraform with state stored in S3. Kubernetes clusters run on EKS with Karpenter for auto-scaling. Each service gets dedicated CPU/memory limits based on load testing data.</p><p>CI/CD: GitHub Actions handles build, test, and Docker image creation. ArgoCD watches our GitOps repository and reconciles the desired state automatically. Rollbacks are a simple git revert. Average deployment time from merge to production: 8 minutes.</p><p>Monitoring: Datadog for metrics and traces, PagerDuty for alerting, and Sentry for error tracking. We maintain a 99.97% uptime SLA with MTTR under 15 minutes for P1 incidents.</p>",
    },
    {
      title: "Data Room Best Practices for Fundraising",
      content:
        "<p>Having raised our Series A with a well-organized data room, here are the documents and structure that impressed our investors and accelerated due diligence.</p><p>Our data room is organized into five categories: Legal (incorporation docs, shareholder agreements, IP assignments), Financial (audited statements, monthly P&L, cap table, financial model), Technical (architecture docs, security audit reports, patent portfolio), Pitch (deck, executive summary, roadmap, market analysis), and Other (org chart, employee handbook, key policies).</p><p>Tips that saved us time: version all documents (v1, v2, v3), include a summary index document, update financials monthly during fundraising, and pre-answer common DD questions in a FAQ document. Our data room reduced the typical DD timeline from 6 weeks to 3 weeks.</p>",
    },
    {
      title: "Implementing Multi-Entity Accounting with Prisma",
      content:
        "<p>Supporting four legal entities across four countries with different accounting standards and currencies was one of our biggest technical challenges. Here's how we modeled it in Prisma and PostgreSQL.</p><p>Each entity has its own chart of accounts, journal entries, and financial reports. The key insight was using composite unique constraints: <code>@@unique([entityId, code])</code> on Chart of Accounts allows the same account code (e.g., '1000' for Cash) in each entity while maintaining referential integrity.</p><p>Currency handling uses a standardized Decimal(15,2) type for amounts with explicit currency codes. Exchange rates are stored as a time-series table, and multi-currency reports use the closing rate method. Intercompany transactions automatically generate offsetting journal entries in both entities.</p>",
    },
    {
      title: "Community Building in Web3: Our Growth Playbook",
      content:
        "<p>Growing from 0 to 100,000 community members in 12 months required a deliberate strategy beyond just announcing products. Here's what worked for us.</p><p>Phase 1 (0-10K): Focus on builders. We sponsored hackathons, published technical content, and ran a developer grants program. Early community members are your most passionate advocates. Phase 2 (10K-50K): Expand to enthusiasts. Ambassador program, educational content series, and strategic partnerships with established communities. Phase 3 (50K-100K): Scale with incentives. Token-gated experiences, governance participation, and retroactive airdrops for consistent contributors.</p><p>Key metrics we track: Daily Active Users (not just members), message quality score, governance participation rate, and Net Promoter Score. Vanity metrics like total members are less meaningful than engagement depth.</p>",
    },
    {
      title: "E2E Testing Strategy for a Complex Dashboard App",
      content:
        "<p>Testing a multi-module ERP dashboard with Playwright requires a thoughtful strategy. With 15+ modules and 200+ pages, we can't test everything in every CI run. Here's our tiered approach.</p><p>Tier 1 (Every PR): Critical user flows - login, navigation, CRUD for core entities. ~50 tests, runs in 3 minutes. Tier 2 (Nightly): Module integration tests - leave approval workflow, expense submission to journal entry, payroll run lifecycle. ~150 tests, runs in 12 minutes. Tier 3 (Weekly): Full regression - all pages render, all forms validate, all exports work. ~400 tests, runs in 30 minutes.</p><p>We use Page Object Model pattern, custom fixtures for authenticated sessions, and parallel test execution across 4 workers. Test data is seeded per-test to avoid flakiness from shared state.</p>",
    },
    {
      title: "The Future of Enterprise Blockchain: Our 2027 Thesis",
      content:
        "<p>After 3 years building in the enterprise blockchain space, here are the trends we believe will define 2027 and how Manut is positioning for them.</p><p>1) Account abstraction will make wallets invisible - users won't know they're using blockchain. We're building our mobile wallet with this principle. 2) Regulatory clarity in APAC and Middle East will unlock institutional adoption. Our multi-jurisdiction compliance framework is designed for this. 3) Real-world asset tokenization will be the killer use case, not DeFi speculation. Our partnerships with traditional finance institutions are strategic bets on this thesis.</p><p>4) Privacy-preserving computation (ZK proofs, FHE) will enable enterprise data on public chains. We're investing in ZK research for our cross-chain bridge. 5) AI agents will become the primary users of blockchain infrastructure. Our ARIA AI assistant already processes on-chain data for internal use.</p>",
    },
    {
      title: "Lessons from Running a Global Payroll System",
      content:
        "<p>Processing payroll across Thailand (TFRS for NPAEs), UAE (IFRS), Singapore (IFRS), and Portugal (IFRS) is a monthly exercise in complexity. Here's what we've learned building Intranet's payroll module.</p><p>Each jurisdiction has unique requirements: Thailand requires social security contributions capped at 750 THB/month, UAE has no income tax but requires WPS (Wage Protection System) compliance, Singapore mandates CPF contributions at tiered rates, and Portugal applies progressive income tax brackets.</p><p>Our approach: a unified payroll engine with country-specific calculation plugins. Each entity's payroll run generates entity-specific payslips with localized deduction breakdowns. The system auto-generates journal entries to the correct GL accounts, keeping accounting in sync without manual intervention.</p>",
    },
  ];

  const blogsData: Prisma.BlogUncheckedCreateInput[] = BLOG_POSTS.map(
    (b, i) => ({
      title: b.title,
      content: b.content,
      coverImage: `https://images.unsplash.com/photo-${1550000000000 + i * 10000000}?w=1200&h=630&fit=crop`,
      slug: slugify(b.title, { lower: true, strict: true }),
      active: i < 18,
      authorId: USER_IDS[i % Math.min(10, USER_IDS.length)]!,
      createdAt: pastDate(i * 4),
    }),
  );

  // ─── 43. ARTICLES (PR / Press) ────────────
  console.log("=== 43. Articles & Blogs & Files (parallel) ===");
  const PR_ARTICLES: {
    title: string;
    date: string;
    link: string;
    img: string;
  }[] = [
    {
      title:
        "Manut Raises $15M Series A to Expand Web3 Enterprise Platform",
      date: "2026-04-15",
      link: "https://techcrunch.com/2026/04/15/manut-series-a",
      img: "https://images.unsplash.com/photo-1639762681057-408e52192e55?w=600&h=400&fit=crop",
    },
    {
      title:
        "BNRY Token Launches on Ethereum and Polygon with $5M First-Day Volume",
      date: "2026-03-20",
      link: "https://coindesk.com/business/2026/03/20/bnry-token-launch",
      img: "https://images.unsplash.com/photo-1621761191319-c6fb62004040?w=600&h=400&fit=crop",
    },
    {
      title:
        "How Manut Is Bridging Traditional Enterprise Operations with Blockchain",
      date: "2026-03-05",
      link: "https://bloomberg.com/technology/2026/03/05/manut-enterprise-blockchain",
      img: "https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=600&h=400&fit=crop",
    },
    {
      title:
        "CoinDesk Names Manut in Top 50 Web3 Companies to Watch",
      date: "2026-02-28",
      link: "https://coindesk.com/consensus-magazine/2026/02/28/top-50-web3-companies",
      img: "https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?w=600&h=400&fit=crop",
    },
    {
      title:
        "Manut Partners with Binance Ecosystem for Cross-Platform Integration",
      date: "2026-02-15",
      link: "https://theblock.co/post/2026/02/15/manut-binance-partnership",
      img: "https://images.unsplash.com/photo-1516245834210-c4c142787335?w=600&h=400&fit=crop",
    },
    {
      title: "Inside the Engineering Culture at Manut",
      date: "2026-02-01",
      link: "https://hackernoon.com/inside-the-engineering-culture-at-manut",
      img: "https://images.unsplash.com/photo-1522071820081-009f0129c71c?w=600&h=400&fit=crop",
    },
    {
      title: "Manut Opens Singapore Office as Regional Hub",
      date: "2026-01-20",
      link: "https://techinasia.com/manut-singapore-office",
      img: "https://images.unsplash.com/photo-1525625293386-3f8f99389edd?w=600&h=400&fit=crop",
    },
    {
      title: "BNRY Cross-Chain Bridge Processes $50M in First Quarter",
      date: "2026-01-10",
      link: "https://defipulse.com/blog/bnry-bridge-milestone",
      img: "https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=600&h=400&fit=crop",
    },
    {
      title: "Manut Achieves ISO 27001 Certification Across All Operations",
      date: "2025-12-15",
      link: "https://finextra.com/newsarticle/manut-iso-27001",
      img: "https://images.unsplash.com/photo-1563986768609-322da13575f2?w=600&h=400&fit=crop",
    },
    {
      title:
        "The Future of DeFi Staking: An Interview with Manut CTO Dr. Sarah Chen",
      date: "2025-12-01",
      link: "https://cointelegraph.com/news/manut-defi-staking-interview",
      img: "https://images.unsplash.com/photo-1551434678-e076c223a692?w=600&h=400&fit=crop",
    },
    {
      title: "Manut Smart Contracts Pass CertiK Security Audit with Clean Report",
      date: "2025-11-20",
      link: "https://certik.com/projects/manut",
      img: "https://images.unsplash.com/photo-1550751827-4bd374c3f58b?w=600&h=400&fit=crop",
    },
    {
      title: "How Manut Built a 100K Community in 12 Months",
      date: "2025-11-05",
      link: "https://decrypt.co/manut-community-growth-story",
      img: "https://images.unsplash.com/photo-1529156069898-49953e39b3ac?w=600&h=400&fit=crop",
    },
    {
      title: "Manut Featured at GITEX Global Dubai as Top Web3 Innovator",
      date: "2025-10-25",
      link: "https://gulfnews.com/business/manut-gitex-global-2025",
      img: "https://images.unsplash.com/photo-1540575467063-178a50c2df87?w=600&h=400&fit=crop",
    },
    {
      title: "Enterprise Blockchain Adoption Is Accelerating in Southeast Asia",
      date: "2025-10-10",
      link: "https://forbes.com/sites/digital-assets/enterprise-blockchain-sea",
      img: "https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?w=600&h=400&fit=crop",
    },
    {
      title:
        "Manut Announces $250K Bug Bounty Program on Immunefi",
      date: "2025-09-28",
      link: "https://immunefi.com/bounty/manut",
      img: "https://images.unsplash.com/photo-1555949963-ff9fe0c870eb?w=600&h=400&fit=crop",
    },
    {
      title:
        "From Bangkok to the World: Manut's Global Expansion Story",
      date: "2025-09-15",
      link: "https://restofworld.org/2025/manut-global-expansion",
      img: "https://images.unsplash.com/photo-1508009603885-50cf7c579365?w=600&h=400&fit=crop",
    },
    {
      title: "Manut Intranet: Building an Open-Source ERP for the Web3 Era",
      date: "2025-09-01",
      link: "https://opensource.com/article/manut-nexora-erp",
      img: "https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=600&h=400&fit=crop",
    },
    {
      title: "Staking Wars: How BNRY Competes with Established DeFi Protocols",
      date: "2025-08-20",
      link: "https://thedefiant.io/bnry-staking-competition",
      img: "https://images.unsplash.com/photo-1620321023374-d1a68fbc720d?w=600&h=400&fit=crop",
    },
    {
      title: "Manut Joins Polygon Ecosystem as Official Partner",
      date: "2025-08-05",
      link: "https://polygon.technology/blog/manut-partnership",
      img: "https://images.unsplash.com/photo-1639322537228-f710d846310a?w=600&h=400&fit=crop",
    },
    {
      title: "Why We Chose Supabase Over Firebase for Our Enterprise Platform",
      date: "2025-07-22",
      link: "https://dev.to/manutengineering/supabase-vs-firebase-enterprise",
      img: "https://images.unsplash.com/photo-1544197150-b99a580bb7a8?w=600&h=400&fit=crop",
    },
  ];

  const articlesData: Prisma.ArticleUncheckedCreateInput[] = PR_ARTICLES.map(
    (a, i) => ({
      title: a.title,
      date: a.date,
      link: a.link,
      img: a.img,
      authorId: USER_IDS[i % Math.min(5, USER_IDS.length)]!,
      createdAt: d(a.date),
    }),
  );

  // ─── 44. FILE UPLOADS ─────────────────────
  const FILE_UPLOADS: {
    filename: string;
    originalName: string;
    mimeType: string;
    size: number;
    purpose: string;
    linkedTo?: string;
  }[] = [
    {
      filename: "annual-report-2025.pdf",
      originalName: "Manut Annual Report 2025.pdf",
      mimeType: "application/pdf",
      size: 4500000,
      purpose: "document",
    },
    {
      filename: "pitch-deck-series-b.pdf",
      originalName: "Manut Series B Pitch Deck.pdf",
      mimeType: "application/pdf",
      size: 8200000,
      purpose: "investor",
    },
    {
      filename: "team-photo-bkk-retreat.jpg",
      originalName: "Bangkok Retreat Team Photo.jpg",
      mimeType: "image/jpeg",
      size: 3200000,
      purpose: "wall_post",
    },
    {
      filename: "q1-2026-financials.xlsx",
      originalName: "Q1 2026 Financial Report.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      size: 1800000,
      purpose: "finance",
    },
    {
      filename: "employee-handbook-v3.pdf",
      originalName: "Employee Handbook v3.0.pdf",
      mimeType: "application/pdf",
      size: 2100000,
      purpose: "hr",
    },
    {
      filename: "architecture-diagram.png",
      originalName: "System Architecture Diagram.png",
      mimeType: "image/png",
      size: 950000,
      purpose: "document",
    },
    {
      filename: "security-audit-certik.pdf",
      originalName: "CertiK Security Audit Report.pdf",
      mimeType: "application/pdf",
      size: 5600000,
      purpose: "compliance",
    },
    {
      filename: "brand-guidelines.pdf",
      originalName: "Manut Brand Guidelines 2026.pdf",
      mimeType: "application/pdf",
      size: 15000000,
      purpose: "marketing",
    },
    {
      filename: "cap-table-apr-2026.xlsx",
      originalName: "Cap Table April 2026.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      size: 420000,
      purpose: "investor",
    },
    {
      filename: "office-floorplan-bkk.pdf",
      originalName: "Bangkok Office Floor Plan.pdf",
      mimeType: "application/pdf",
      size: 1200000,
      purpose: "facilities",
    },
    {
      filename: "onboarding-checklist.pdf",
      originalName: "New Hire Onboarding Checklist.pdf",
      mimeType: "application/pdf",
      size: 350000,
      purpose: "hr",
    },
    {
      filename: "travel-policy-2026.pdf",
      originalName: "Travel & Expense Policy 2026.pdf",
      mimeType: "application/pdf",
      size: 680000,
      purpose: "policy",
    },
    {
      filename: "product-roadmap-h2.pdf",
      originalName: "Product Roadmap H2 2026.pdf",
      mimeType: "application/pdf",
      size: 3800000,
      purpose: "product",
    },
    {
      filename: "compensation-benchmark.xlsx",
      originalName: "Compensation Benchmark Report.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      size: 920000,
      purpose: "hr",
    },
    {
      filename: "data-privacy-policy.pdf",
      originalName: "Data Privacy Policy.pdf",
      mimeType: "application/pdf",
      size: 450000,
      purpose: "compliance",
    },
    {
      filename: "bnry-whitepaper-v2.pdf",
      originalName: "BNRY Whitepaper v2.0.pdf",
      mimeType: "application/pdf",
      size: 6700000,
      purpose: "investor",
    },
    {
      filename: "tax-filing-th-2025.pdf",
      originalName: "Thailand Tax Filing 2025.pdf",
      mimeType: "application/pdf",
      size: 2300000,
      purpose: "finance",
    },
    {
      filename: "meeting-notes-board-q1.pdf",
      originalName: "Board Meeting Notes Q1 2026.pdf",
      mimeType: "application/pdf",
      size: 780000,
      purpose: "governance",
    },
    {
      filename: "infrastructure-costs.xlsx",
      originalName: "Infrastructure Cost Report.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      size: 540000,
      purpose: "finance",
    },
    {
      filename: "insurance-certificate.pdf",
      originalName: "Group Insurance Certificate.pdf",
      mimeType: "application/pdf",
      size: 1100000,
      purpose: "hr",
    },
  ];

  const fileUploadsData: Prisma.FileUploadUncheckedCreateInput[] =
    FILE_UPLOADS.map((f, i) => ({
      filename: f.filename,
      originalName: f.originalName,
      mimeType: f.mimeType,
      size: f.size,
      path: `uploads/${f.purpose}/${f.filename}`,
      bucket: "documents",
      uploadedBy: USER_IDS[i % Math.min(10, USER_IDS.length)]!,
      purpose: f.purpose,
      createdAt: pastDate(12 + ((i * 7) % 140)),
    }));

  await Promise.all([
    prisma.blog
      .deleteMany({})
      .then(() => prisma.blog.createMany({ data: blogsData })),
    prisma.article
      .deleteMany({})
      .then(() => prisma.article.createMany({ data: articlesData })),
    prisma.fileUpload
      .deleteMany({})
      .then(() => prisma.fileUpload.createMany({ data: fileUploadsData })),
  ]);
  console.log(
    `  ✅ ${BLOG_POSTS.length} blogs, ${PR_ARTICLES.length} articles, ${FILE_UPLOADS.length} files\n`,
  );

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log("════════════════════════════════════════");
  console.log(`🎉 SEED COMPLETE in ${elapsed}s!`);
  console.log("════════════════════════════════════════");
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
