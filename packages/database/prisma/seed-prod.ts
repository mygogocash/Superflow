import { config } from "dotenv";
import { resolve } from "path";
import * as readline from "readline";

config({ path: resolve(__dirname, "../../../.env") });

import { PrismaClient } from "../src/generated/prisma";
import { randomUUID } from "node:crypto";

const prisma = new PrismaClient();

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

const ADMIN_EMAIL = "admin@manut.xyz";

const ADMIN_PERMISSIONS = [
  "home:read",
  "wall:create",
  "wall:delete",
  "news:create",
  "news:delete",
  "aria:use",
  "aria:parse",
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
  "directory:read",
  "directory:view-sensitive",
  "accounting:read",
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

async function main() {
  console.log("🌱 Production seed: Admin account + Admin role\n");

  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey || serviceKey === "placeholder") {
    console.error(
      "❌ SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for production seed",
    );
    process.exit(1);
  }

  // ─── 0. CLEANUP: Truncate all tables ───
  console.log("=== 0. Cleanup: Truncating all tables ===");
  const tablenames = await prisma.$queryRaw<
    { tablename: string }[]
  >`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;

  const tables = tablenames
    .map((t) => t.tablename)
    .filter((name) => !name.startsWith("_prisma"));

  if (tables.length > 0) {
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE ${tables.map((t) => `"${t}"`).join(", ")} CASCADE`,
    );
  }
  console.log(`  ✅ Truncated ${tables.length} tables\n`);

  // ─── 1. ENTITIES (at least one is required for the admin user) ───
  console.log("=== 1. Entities ===");
  const ENTITY_SEED = [
    {
      code: "TH",
      name: "Manut Thailand",
      country: "Thailand",
      currency: "THB",
      accountingStd: "TFRS for NPAEs",
    },
    {
      code: "AE",
      name: "Manut Dubai",
      country: "UAE",
      currency: "AED",
      accountingStd: "IFRS",
    },
    {
      code: "SG",
      name: "Manut Singapore",
      country: "Singapore",
      currency: "SGD",
      accountingStd: "IFRS",
    },
    {
      code: "PT",
      name: "Manut Portugal",
      country: "Portugal",
      currency: "EUR",
      accountingStd: "IFRS",
    },
    {
      code: "ID",
      name: "Manut Indonesia",
      country: "Indonesia",
      currency: "IDR",
      accountingStd: "PSAK",
    },
    {
      code: "VN",
      name: "Manut Vietnam",
      country: "Vietnam",
      currency: "VND",
      accountingStd: "VAS",
    },
    {
      code: "IN",
      name: "Manut India",
      country: "India",
      currency: "INR",
      accountingStd: "Ind AS",
    },
    {
      code: "BD",
      name: "Manut Bangladesh",
      country: "Bangladesh",
      currency: "BDT",
      accountingStd: "BFRS",
    },
  ];
  for (const e of ENTITY_SEED) {
    await prisma.entity.upsert({
      where: { code: e.code },
      // Re-assert canonical fields so an entity that drifted via direct DB
      // edit snaps back. isActive stays whatever's set in production —
      // admins disable old rows via the future entity-management UI.
      update: {
        name: e.name,
        country: e.country,
        currency: e.currency,
        accountingStd: e.accountingStd,
      },
      create: e,
    });
  }
  // Anchor the admin user to the Thailand entity (preserves existing
  // behaviour from when there was only one entity row).
  const entity = await prisma.entity.findUniqueOrThrow({
    where: { code: "TH" },
  });
  console.log(
    `  ✅ ${ENTITY_SEED.length} entities upserted; admin anchored on ${entity.name}\n`,
  );

  // ─── 2. ADMIN ROLE ───
  console.log("=== 2. Admin Role ===");
  const adminRole = await prisma.role.upsert({
    where: { name: "Admin" },
    update: {
      description: "Full system access",
      defaultRoute: "/dashboard",
    },
    create: {
      name: "Admin",
      description: "Full system access",
      isSystem: true,
      defaultRoute: "/dashboard",
    },
  });
  console.log(`  ✅ Role: ${adminRole.name} (${adminRole.id})\n`);

  // ─── 3. ROLE PERMISSIONS ───
  console.log("=== 3. Role Permissions ===");
  await prisma.rolePermission.deleteMany({
    where: { roleId: adminRole.id },
  });
  await prisma.rolePermission.createMany({
    data: ADMIN_PERMISSIONS.map((code) => ({
      roleId: adminRole.id,
      permissionCode: code,
    })),
    skipDuplicates: true,
  });
  console.log(`  ✅ ${ADMIN_PERMISSIONS.length} permissions assigned\n`);

  // ─── 4. ADMIN USER (Supabase Auth + Prisma) ───
  console.log("=== 4. Admin User ===");

  let adminUserId: string;

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
    console.log(`\n  🔐 Admin user not found in Supabase Auth.`);
    console.log(`     Email: ${ADMIN_EMAIL}`);
    const adminPassword = await promptPassword(
      "     Enter password for admin user: ",
    );

    if (!adminPassword || adminPassword.length < 6) {
      console.error("  ❌ Password must be at least 6 characters");
      process.exit(1);
    }

    console.log("  Creating admin in Supabase Auth...");
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
        user_metadata: { name: "Manut Admin" },
      }),
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      console.error(
        `  ❌ Failed to create admin in Supabase Auth: ${errText}`,
      );
      process.exit(1);
    }

    const newUser = (await createRes.json()) as { id: string };
    adminUserId = newUser.id;
    console.log(`  ✅ Created admin in Supabase Auth: ${adminUserId}`);
  }

  // Create admin employee record in Prisma
  await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    update: { id: adminUserId, name: "Manut Admin", isActive: true },
    create: {
      id: adminUserId,
      email: ADMIN_EMAIL,
      name: "Manut Admin",
      phone: "+66812345678",
      entityId: entity.id,
      department: "Management",
      jobTitle: "System Administrator",
      employeeId: "MNT-001",
      employmentType: "full_time",
      startDate: new Date("2023-01-01"),
      salary: 150000,
      currency: "THB",
      location: "Bangkok",
      country: "Thailand",
      timezone: "Asia/Bangkok",
      isActive: true,
    },
  });
  console.log(`  ✅ Admin user in DB: ${ADMIN_EMAIL}\n`);

  // ─── 5. ASSIGN ADMIN ROLE ───
  console.log("=== 5. Assign Admin Role ===");
  await prisma.userRole.upsert({
    where: {
      userId_roleId: { userId: adminUserId, roleId: adminRole.id },
    },
    update: {},
    create: {
      userId: adminUserId,
      roleId: adminRole.id,
      assignedBy: adminUserId,
    },
  });
  console.log(`  ✅ Admin role assigned to ${ADMIN_EMAIL}\n`);

  // ─── 5b. CRM LEAD SOURCES (PRD §11.7) ───
  console.log("=== 5b. CRM Lead Sources ===");
  const LEAD_SOURCE_SEED = [
    { code: "web", label: "Web inbound", sortOrder: 10 },
    { code: "referral", label: "Referral", sortOrder: 20 },
    { code: "conference", label: "Conference", sortOrder: 30 },
    { code: "partner", label: "Partner", sortOrder: 40 },
    { code: "cold", label: "Cold outreach", sortOrder: 50 },
    { code: "other", label: "Other", sortOrder: 60 },
  ];
  for (const s of LEAD_SOURCE_SEED) {
    await prisma.leadSource.upsert({
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
    });
  }
  console.log(`  ✅ ${LEAD_SOURCE_SEED.length} lead sources\n`);

  // ─── 5c. CRM LOST REASONS (PRD §11.7) ───
  console.log("=== 5c. CRM Lost Reasons ===");
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
  for (const r of LOST_REASON_SEED) {
    await prisma.lostReason.upsert({
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
    });
  }
  console.log(`  ✅ ${LOST_REASON_SEED.length} lost reasons\n`);

  // ─── 6. LEAVE TYPES ───
  console.log("=== 6. Leave Types ===");
  const LEAVE_TYPES = [
    { name: "Annual Leave", code: "AL", category: "earned", daysPerYear: 14, requiresApproval: true, isPaid: true },
    { name: "Sick Leave", code: "SL", category: "sick", daysPerYear: 30, requiresApproval: false, isPaid: true },
    { name: "Personal Leave", code: "PL", category: "casual", daysPerYear: 3, requiresApproval: true, isPaid: true },
    { name: "Work From Home", code: "WFH", category: "casual", daysPerYear: 365, requiresApproval: true, isPaid: true },
    { name: "Maternity Leave", code: "ML", category: "other", daysPerYear: 120, requiresApproval: true, isPaid: true },
    { name: "Paternity Leave", code: "PTL", category: "other", daysPerYear: 15, requiresApproval: true, isPaid: true },
    { name: "Compassionate Leave", code: "CL", category: "other", daysPerYear: 5, requiresApproval: true, isPaid: true },
    { name: "Leave Without Pay", code: "LWP", category: "unpaid", daysPerYear: 365, requiresApproval: true, isPaid: false },
    { name: "Bereavement Leave", code: "BL", category: "other", daysPerYear: 7, requiresApproval: true, isPaid: true },
  ];

  for (const lt of LEAVE_TYPES) {
    await prisma.leaveType.upsert({
      where: { code: lt.code },
      update: { name: lt.name, category: lt.category, daysPerYear: lt.daysPerYear, requiresApproval: lt.requiresApproval, isPaid: lt.isPaid },
      create: { id: randomUUID(), ...lt, isActive: true },
    });
  }
  console.log(`  ✅ ${LEAVE_TYPES.length} leave types seeded\n`);

  // ─── 7. EMPLOYEE ROLE ───
  console.log("=== 7. Employee Role ===");
  const employeeRole = await prisma.role.upsert({
    where: { name: "Employee" },
    update: { description: "Basic employee access", defaultRoute: "/my-portal" },
    create: { name: "Employee", description: "Basic employee access", isSystem: true, defaultRoute: "/my-portal" },
  });

  const EMPLOYEE_PERMISSIONS = [
    "home:read",
    "wall:create",
    "news:create",
    "aria:use",
    "integrations:use",
    "messages:read",
    "messages:create",
    "projects:read",
    "leave:read",
    "leave:request",
    "leave:team-calendar",
    "benefits:read",
    "benefits:enroll",
    "directory:read",
    "travel:read",
    "travel:request",
    "expense:read",
    "expense:create",
    "payroll:read",
    "hrms:read",
    "learning:read",
    "learning:complete",
    "visa:read",
    "office:read",
    "office:book",
    "investors:read",
    "investor-dashboard:read",
    "investor-updates:read",
    "performance:read",
    "performance:self-review",
    "performance:goals",
    "crm:read",
    "crm:create",
    "crm:update",
    // IT helpdesk is open to every employee — `it:read` scopes the
    // list to their own tickets via owner-filter, and `it:create`
    // lets them open a new ticket. Triage / resolve permissions
    // stay with the IT role.
    "it:read",
    "it:create",
  ];

  await prisma.rolePermission.deleteMany({ where: { roleId: employeeRole.id } });
  await prisma.rolePermission.createMany({
    data: EMPLOYEE_PERMISSIONS.map((code) => ({ roleId: employeeRole.id, permissionCode: code })),
    skipDuplicates: true,
  });
  console.log(`  ✅ Employee role: ${EMPLOYEE_PERMISSIONS.length} permissions\n`);

  // ─── 8. HR ROLE ───
  console.log("=== 8. HR Role ===");
  const hrRole = await prisma.role.upsert({
    where: { name: "HR" },
    update: { description: "Human Resources management", defaultRoute: "/employees" },
    create: { name: "HR", description: "Human Resources management", isSystem: true, defaultRoute: "/employees" },
  });

  const HR_PERMISSIONS = [
    ...EMPLOYEE_PERMISSIONS,
    "user:read",
    "user:create",
    "user:update",
    "user:delete",
    "user:assign-role",
    "leave:approve",
    "leave:hr-read",
    "leave:hr-adjust",
    "leave:hr-on-behalf",
    "leave:hr-settings",
    "leave:assign-approver",
    "leave:export",
    "leave:audit-read",
    "leave:bulk-import",
    "leave:analytics",
    "benefits:manage",
    "payroll:read",
    "payroll:create",
    "payroll:approve",
    "payroll:hr-admin",
    "hrms:read",
    "hrms:onboarding-manage",
    "hrms:esop-manage",
    "hrms:attendance-read",
    "hrms:attendance-manage",
    "hrms:attendance-policy-manage",
    "hrms:attendance-correction-approve",
    "hrms:attendance-report-export",
    "visa:hr-read",
    "visa:manage",
    "office:manage",
    "directory:view-sensitive",
    "travel:approve",
    "travel:hr-read",
    "travel:hr-approve",
    "travel:hr-on-behalf",
    "travel:assign-approver",
    "travel:export",
    "travel:audit-read",
    "travel:analytics",
    "expense:approve",
    "expense:hr-read",
    "expense:hr-approve",
    "expense:assign-approver",
    "expense:export",
    "expense:audit-read",
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
    "performance:manager-review",
    "performance:hr-manage",
    "learning:manage",
    "learning:hr-read",
  ];

  await prisma.rolePermission.deleteMany({ where: { roleId: hrRole.id } });
  await prisma.rolePermission.createMany({
    data: [...new Set(HR_PERMISSIONS)].map((code) => ({ roleId: hrRole.id, permissionCode: code })),
    skipDuplicates: true,
  });
  console.log(`  ✅ HR role: ${[...new Set(HR_PERMISSIONS)].length} permissions\n`);

  // ─── 9. MANAGER ROLE ───
  console.log("=== 9. Manager Role ===");
  const managerRole = await prisma.role.upsert({
    where: { name: "Manager" },
    update: {
      description: "Team management and approvals",
      defaultRoute: "/dashboard",
    },
    create: {
      name: "Manager",
      description: "Team management and approvals",
      isSystem: true,
      defaultRoute: "/dashboard",
    },
  });

  const MANAGER_PERMISSIONS = [
    ...EMPLOYEE_PERMISSIONS,
    "leave:approve",
    "projects:read-all",
    "projects:create",
    "projects:update",
    "partners:read",
    "deals:read",
    "deals:create",
    "deals:update",
    "crm:team-read",
    "expense:approve",
    "travel:approve",
    "performance:manager-review",
  ];

  await prisma.rolePermission.deleteMany({
    where: { roleId: managerRole.id },
  });
  await prisma.rolePermission.createMany({
    data: [...new Set(MANAGER_PERMISSIONS)].map((code) => ({
      roleId: managerRole.id,
      permissionCode: code,
    })),
    skipDuplicates: true,
  });
  console.log(
    `  ✅ Manager role: ${[...new Set(MANAGER_PERMISSIONS)].length} permissions\n`,
  );

  // ─── 10. ACCOUNTING MANAGER ROLE ───
  console.log("=== 10. Accounting Manager Role ===");
  const accountingManagerRole = await prisma.role.upsert({
    where: { name: "Accounting Manager" },
    update: {
      description: "Financial operations",
      defaultRoute: "/dashboard",
    },
    create: {
      name: "Accounting Manager",
      description: "Financial operations",
      isSystem: true,
      defaultRoute: "/dashboard",
    },
  });

  const ACCOUNTING_MANAGER_PERMISSIONS = [
    ...EMPLOYEE_PERMISSIONS,
    "accounting:read",
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

  await prisma.rolePermission.deleteMany({
    where: { roleId: accountingManagerRole.id },
  });
  await prisma.rolePermission.createMany({
    data: [...new Set(ACCOUNTING_MANAGER_PERMISSIONS)].map((code) => ({
      roleId: accountingManagerRole.id,
      permissionCode: code,
    })),
    skipDuplicates: true,
  });
  console.log(
    `  ✅ Accounting Manager role: ${[...new Set(ACCOUNTING_MANAGER_PERMISSIONS)].length} permissions\n`,
  );

  // ─── 11. FINANCE MANAGER ROLE ───
  console.log("=== 11. Finance Manager Role ===");
  const financeManagerRole = await prisma.role.upsert({
    where: { name: "Finance Manager" },
    update: {
      description: "Finance operations",
      defaultRoute: "/dashboard",
    },
    create: {
      name: "Finance Manager",
      description: "Finance operations",
      isSystem: true,
      defaultRoute: "/dashboard",
    },
  });

  const FINANCE_MANAGER_PERMISSIONS = [...ACCOUNTING_MANAGER_PERMISSIONS];

  await prisma.rolePermission.deleteMany({
    where: { roleId: financeManagerRole.id },
  });
  await prisma.rolePermission.createMany({
    data: [...new Set(FINANCE_MANAGER_PERMISSIONS)].map((code) => ({
      roleId: financeManagerRole.id,
      permissionCode: code,
    })),
    skipDuplicates: true,
  });
  console.log(
    `  ✅ Finance Manager role: ${[...new Set(FINANCE_MANAGER_PERMISSIONS)].length} permissions\n`,
  );

  console.log("─────────────────────────────────────────");
  console.log("✅ Production seed complete!");
  console.log(`   Admin: ${ADMIN_EMAIL}`);
  console.log(
    "   Roles: Admin, Employee, HR, Manager, Accounting Manager (system), Finance Manager (system)",
  );
  console.log("─────────────────────────────────────────");
}

main()
  .catch((e) => {
    console.error("❌ Production seed failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
