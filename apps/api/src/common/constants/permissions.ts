export interface PermissionDef {
  code: string;
  module: string;
  action: string;
  description: string;
}

export const PERMISSION_DEFINITIONS: PermissionDef[] = [
  // ── Home / Wall ──
  {
    code: "home:read",
    module: "home",
    action: "read",
    description: "View home dashboard",
  },
  {
    code: "wall:create",
    module: "home",
    action: "create",
    description: "Post on company wall",
  },
  {
    code: "wall:delete",
    module: "home",
    action: "delete",
    description: "Delete wall posts",
  },
  {
    code: "news:create",
    module: "home",
    action: "create-news",
    description: "Create company news",
  },
  {
    code: "news:delete",
    module: "home",
    action: "delete-news",
    description: "Delete company news",
  },

  // ── Manut AI (assistant; routes/codes stay aria:*) ──
  {
    code: "aria:use",
    module: "aria",
    action: "use",
    description: "Use Manut AI assistant",
  },
  {
    code: "aria:parse",
    module: "aria",
    action: "parse",
    description: "Parse documents with Manut AI",
  },
  {
    code: "aria:knowledge-manage",
    module: "aria",
    action: "knowledge-manage",
    description:
      "Manage the Manut AI knowledge corpus (immigration, HR policies, etc.)",
  },
  {
    code: "aria:brief-subscribe",
    module: "aria",
    action: "brief-subscribe",
    description: "Receive Manut AI's proactive daily brief",
  },

  // ── Integrations (Gmail, Drive via Anthropic MCP) ──
  {
    code: "integrations:use",
    module: "integrations",
    action: "use",
    description: "Use Gmail and Google Drive integrations",
  },
  {
    code: "integrations:manage",
    module: "integrations",
    action: "manage",
    description: "Configure integrations and connection settings",
  },

  // ── Messages ──
  {
    code: "messages:read",
    module: "messages",
    action: "read",
    description: "View messages",
  },
  {
    code: "messages:create",
    module: "messages",
    action: "create",
    description: "Send messages",
  },
  {
    code: "messages:delete",
    module: "messages",
    action: "delete",
    description: "Delete messages",
  },
  {
    code: "messages:admin",
    module: "messages",
    action: "admin",
    description: "Manage all messages",
  },

  // ── Projects ──
  {
    code: "projects:read",
    module: "projects",
    action: "read",
    description: "View projects you own or are assigned to",
  },
  {
    code: "projects:read-all",
    module: "projects",
    action: "read-all",
    description: "View every project in the workspace (HR / leadership)",
  },
  {
    code: "projects:create",
    module: "projects",
    action: "create",
    description: "Create projects",
  },
  {
    code: "projects:update",
    module: "projects",
    action: "update",
    description: "Edit projects",
  },
  {
    code: "projects:delete",
    module: "projects",
    action: "delete",
    description: "Delete projects",
  },
  {
    code: "projects:manage",
    module: "projects",
    action: "manage",
    description: "Full project management",
  },

  // ── Project Approval Workflow ──
  // One code per stage of the linear approval chain. The required code is
  // determined by the project's CURRENT state, so it is enforced in the
  // workflow service rather than in route middleware. Admin bypasses every
  // gate via the permission resolver.
  {
    code: "workflow:submit",
    module: "workflow",
    action: "submit",
    description:
      "Submit a project into the approval workflow (Sales & Marketing)",
  },
  {
    code: "workflow:pm-approve",
    module: "workflow",
    action: "pm-approve",
    description: "Approve or reject at the Project Manager stage",
  },
  {
    code: "workflow:business-head-approve",
    module: "workflow",
    action: "business-head-approve",
    description: "Approve or reject at the Business Head stage",
  },
  {
    code: "workflow:product-admin-approve",
    module: "workflow",
    action: "product-admin-approve",
    description: "Approve or reject at the Product Admin stage",
  },
  {
    code: "workflow:complete",
    module: "workflow",
    action: "complete",
    description: "Mark a project as Completed (Project Manager)",
  },
  // Project Manager operational authority. The PM is the workflow owner and
  // retains these throughout the lifecycle — including after Business Head and
  // Product Admin approval.
  {
    code: "workflow:return",
    module: "workflow",
    action: "return",
    description:
      "Return a request to the requester for changes (Project Manager)",
  },
  {
    code: "workflow:reopen",
    module: "workflow",
    action: "reopen",
    description: "Reopen a rejected request (Project Manager)",
  },
  {
    code: "workflow:archive",
    module: "workflow",
    action: "archive",
    description: "Archive a project (Project Manager)",
  },
  {
    code: "workflow:escalate",
    module: "workflow",
    action: "escalate",
    description: "Escalate a project to stakeholders (Project Manager)",
  },
  {
    code: "workflow:reassign",
    module: "workflow",
    action: "reassign",
    description:
      "Reassign the development team / project owner (Project Manager)",
  },
  {
    code: "workflow:timeline-manage",
    module: "workflow",
    action: "timeline-manage",
    description:
      "Assign or modify the expected completion date (Development Team, Project Manager)",
  },
  {
    code: "workflow:progress-update",
    module: "workflow",
    action: "progress-update",
    description:
      "Update implementation progress and upload deliverables (Development Team)",
  },

  // ── Product Proposals ──
  // Ideas, change requests, and anything else product-related needing a
  // decision. Separate from `workflow:*`, which gates the project request
  // chain: the two flows have different approvers and different shapes, so
  // sharing codes would mean granting one to get the other.
  {
    code: "proposals:read",
    module: "proposals",
    action: "read",
    description: "View product proposals and their decision history",
  },
  {
    code: "proposals:create",
    module: "proposals",
    action: "create",
    description: "Raise a product proposal (idea, change request, or other)",
  },
  {
    code: "proposals:review",
    module: "proposals",
    action: "review",
    description:
      "Decide at the first review stage, and ask others for information",
  },
  {
    code: "proposals:approve",
    module: "proposals",
    action: "approve",
    description: "Give final approval on a product proposal",
  },

  // ── Executive Analytics ──
  // Read-only analytics over project operational data. `analytics:read` is
  // the department / PM / dev-lead scope; `analytics:read-all` is the
  // executive / admin org-wide scope. Reuses the existing RBAC resolver.
  {
    code: "analytics:read",
    module: "analytics",
    action: "read",
    description: "View analytics for your own scope",
  },
  {
    code: "analytics:read-all",
    module: "analytics",
    action: "read-all",
    description: "View org-wide executive analytics + generate reports",
  },

  // ── Partners CRM ──
  {
    code: "partners:read",
    module: "partners",
    action: "read",
    description: "View partners",
  },
  {
    code: "partners:create",
    module: "partners",
    action: "create",
    description: "Add partners",
  },
  {
    code: "partners:update",
    module: "partners",
    action: "update",
    description: "Edit partners",
  },
  {
    code: "partners:delete",
    module: "partners",
    action: "delete",
    description: "Delete partners",
  },

  // ── Deals / Sales CRM ──
  {
    code: "deals:read",
    module: "deals",
    action: "read",
    description: "View deals",
  },
  {
    code: "deals:create",
    module: "deals",
    action: "create",
    description: "Create deals",
  },
  {
    code: "deals:update",
    module: "deals",
    action: "update",
    description: "Edit deals",
  },
  {
    code: "deals:delete",
    module: "deals",
    action: "delete",
    description: "Delete deals",
  },
  {
    code: "deals:manage",
    module: "deals",
    action: "manage",
    description: "Full deal management",
  },

  // ── Sales CRM v2 (Leads / Accounts / Contacts / Opportunities / Activities / Tasks) ──
  {
    code: "crm:read",
    module: "crm",
    action: "read",
    description: "View own + team-shared CRM records",
  },
  {
    code: "crm:team-read",
    module: "crm",
    action: "team-read",
    description: "View all CRM records owned by direct reports",
  },
  {
    code: "crm:create",
    module: "crm",
    action: "create",
    description: "Create leads, accounts, contacts, opportunities",
  },
  {
    code: "crm:update",
    module: "crm",
    action: "update",
    description: "Update CRM records (own + team-shared)",
  },
  {
    code: "crm:delete",
    module: "crm",
    action: "delete",
    description: "Delete CRM records (own only by default)",
  },
  {
    code: "crm:reassign",
    module: "crm",
    action: "reassign",
    description: "Change owner on a lead or opportunity",
  },
  {
    code: "crm:export",
    module: "crm",
    action: "export",
    description: "Export pipeline to XLSX",
  },
  {
    code: "crm:admin",
    module: "crm",
    action: "admin",
    description: "Manage stages, sources, lost-reasons",
  },
  {
    code: "crm:settings-manage",
    module: "crm",
    action: "settings-manage",
    description: "Configure Sales CRM notification settings",
  },

  // ── Sales Revenue CRM (independent parallel of Sales CRM) ──
  {
    code: "sales-revenue:read",
    module: "sales-revenue",
    action: "read",
    description: "View own + team-shared ARIA sales revenue records",
  },
  {
    code: "sales-revenue:team-read",
    module: "sales-revenue",
    action: "team-read",
    description: "View all ARIA sales revenue records owned by direct reports",
  },
  {
    code: "sales-revenue:create",
    module: "sales-revenue",
    action: "create",
    description: "Create revenue leads, accounts, contacts, opportunities",
  },
  {
    code: "sales-revenue:update",
    module: "sales-revenue",
    action: "update",
    description: "Update ARIA sales revenue records (own + team-shared)",
  },
  {
    code: "sales-revenue:delete",
    module: "sales-revenue",
    action: "delete",
    description: "Delete ARIA sales revenue records (own only by default)",
  },
  {
    code: "sales-revenue:reassign",
    module: "sales-revenue",
    action: "reassign",
    description: "Change owner on a revenue lead or opportunity",
  },
  {
    code: "sales-revenue:export",
    module: "sales-revenue",
    action: "export",
    description: "Export revenue pipeline to XLSX",
  },
  {
    code: "sales-revenue:admin",
    module: "sales-revenue",
    action: "admin",
    description: "Manage revenue stages, sources, lost-reasons",
  },
  {
    code: "sales-revenue:settings-manage",
    module: "sales-revenue",
    action: "settings-manage",
    description: "Configure ARIA sales revenue notification settings",
  },

  // ── Career (Jobs) ──
  {
    code: "career:read",
    module: "career",
    action: "read",
    description: "View job postings",
  },
  {
    code: "career:create",
    module: "career",
    action: "create",
    description: "Create job posting",
  },
  {
    code: "career:update",
    module: "career",
    action: "update",
    description: "Edit job posting",
  },
  {
    code: "career:delete",
    module: "career",
    action: "delete",
    description: "Delete job posting",
  },
  {
    code: "career:export",
    module: "career",
    action: "export",
    description: "Export jobs CSV",
  },

  // ── Application ──
  {
    code: "application:read",
    module: "application",
    action: "read",
    description: "View applications",
  },
  {
    code: "application:delete",
    module: "application",
    action: "delete",
    description: "Delete application",
  },
  {
    code: "application:export",
    module: "application",
    action: "export",
    description: "Export applications CSV",
  },

  // ── Survey ──
  {
    code: "survey:manage-wave",
    module: "survey",
    action: "manage-wave",
    description: "Create/edit/archive survey wave",
  },
  {
    code: "survey:manage",
    module: "survey",
    action: "manage",
    description: "Create/edit/publish/close/analyze surveys (form builder)",
  },

  // ── Leave Management ──
  {
    code: "leave:read",
    module: "leave",
    action: "read",
    description: "View own dashboard, balance, holidays, requests",
  },
  {
    code: "leave:request",
    module: "leave",
    action: "request",
    description: "Create/update/cancel own pending leave per policy",
  },
  {
    code: "leave:approve",
    module: "leave",
    action: "approve",
    description: "Approve, reject, or forward leave requests",
  },
  {
    code: "leave:approve-wfh",
    module: "leave",
    action: "approve-wfh",
    description:
      "Approve or reject Work From Home requests (executive / CEO line)",
  },
  {
    code: "leave:team-calendar",
    module: "leave",
    action: "team-calendar",
    description: "View team conflict calendar",
  },
  {
    code: "leave:hr-read",
    module: "leave",
    action: "hr-read",
    description: "View any employee leave profile",
  },
  {
    code: "leave:hr-adjust",
    module: "leave",
    action: "hr-adjust",
    description: "Adjust employee leave balances",
  },
  {
    code: "leave:hr-on-behalf",
    module: "leave",
    action: "hr-on-behalf",
    description: "Submit leave on behalf of employee",
  },
  {
    code: "leave:hr-settings",
    module: "leave",
    action: "hr-settings",
    description: "Manage leave types and policies",
  },
  {
    code: "leave:assign-approver",
    module: "leave",
    action: "assign-approver",
    description: "Assign approver per employee",
  },
  {
    code: "leave:export",
    module: "leave",
    action: "export",
    description: "Export leave reports CSV/XLSX",
  },
  {
    code: "leave:audit-read",
    module: "leave",
    action: "audit-read",
    description: "View leave audit logs",
  },
  {
    code: "leave:bulk-import",
    module: "leave",
    action: "bulk-import",
    description: "Bulk import balances or policy assignments",
  },
  {
    code: "leave:analytics",
    module: "leave",
    action: "analytics",
    description: "View leave utilization analytics",
  },

  // ── Benefits ──
  {
    code: "benefits:read",
    module: "benefits",
    action: "read",
    description: "View benefits",
  },
  {
    code: "benefits:manage",
    module: "benefits",
    action: "manage",
    description: "Manage benefits",
  },
  {
    code: "benefits:enroll",
    module: "benefits",
    action: "enroll",
    description: "Enroll in benefits",
  },

  // ── Payroll ──
  {
    code: "payroll:read",
    module: "payroll",
    action: "read",
    description: "View payroll data",
  },
  {
    code: "payroll:create",
    module: "payroll",
    action: "create",
    description: "Create payroll runs",
  },
  {
    code: "payroll:approve",
    module: "payroll",
    action: "approve",
    description: "Approve payroll runs",
  },
  {
    code: "payroll:hr-admin",
    module: "payroll",
    action: "hr-admin",
    description: "Full payroll admin (HR)",
  },

  // ── HRMS ──
  {
    code: "hrms:read",
    module: "hrms",
    action: "read",
    description: "View HRMS dashboard",
  },
  {
    code: "hrms:esop-manage",
    module: "hrms",
    action: "esop-manage",
    description: "Manage ESOP grants",
  },
  {
    code: "hrms:onboarding-manage",
    module: "hrms",
    action: "onboarding-manage",
    description: "Manage onboarding",
  },
  {
    code: "hrms:offboarding-manage",
    module: "hrms",
    action: "offboarding-manage",
    description: "Manage offboarding (exit checklists)",
  },
  {
    code: "hrms:agreements-manage",
    module: "hrms",
    action: "agreements-manage",
    description: "Upload, edit, delete employee agreement documents",
  },
  {
    code: "hrms:attendance-read",
    module: "hrms",
    action: "attendance-read",
    description: "View attendance dashboard, live monitor, and reports",
  },
  {
    code: "hrms:attendance-manage",
    module: "hrms",
    action: "attendance-manage",
    description: "Manage attendance policies and HR-wide attendance data",
  },
  {
    code: "hrms:attendance-policy-manage",
    module: "hrms",
    action: "attendance-policy-manage",
    description: "Configure attendance policies, shifts, and settings",
  },
  {
    code: "hrms:attendance-correction-approve",
    module: "hrms",
    action: "attendance-correction-approve",
    description: "Approve or reject attendance correction requests",
  },
  {
    code: "hrms:attendance-report-export",
    module: "hrms",
    action: "attendance-report-export",
    description: "Export attendance reports (CSV/Excel)",
  },

  // ── Learning ──
  {
    code: "learning:read",
    module: "learning",
    action: "read",
    description: "View learning courses",
  },
  {
    code: "learning:complete",
    module: "learning",
    action: "complete",
    description: "Complete courses",
  },
  {
    code: "learning:manage",
    module: "learning",
    action: "manage",
    description: "Manage learning content",
  },
  {
    code: "learning:hr-read",
    module: "learning",
    action: "hr-read",
    description: "View all learning progress (HR)",
  },

  // ── Visa ──
  {
    code: "visa:read",
    module: "visa",
    action: "read",
    description: "View own visa status",
  },
  {
    code: "visa:hr-read",
    module: "visa",
    action: "hr-read",
    description: "View all visas (HR)",
  },
  {
    code: "visa:manage",
    module: "visa",
    action: "manage",
    description: "Manage visa applications",
  },

  // ── Office ──
  {
    code: "office:read",
    module: "office",
    action: "read",
    description: "View office resources",
  },
  {
    code: "office:book",
    module: "office",
    action: "book",
    description: "Book meeting rooms",
  },
  {
    code: "office:manage",
    module: "office",
    action: "manage",
    description: "Manage office resources",
  },

  // ── Policy & Handbook ──
  {
    code: "policy:read",
    module: "policy",
    action: "read",
    description: "View company policies and handbook documents",
  },
  {
    code: "policy:manage",
    module: "policy",
    action: "manage",
    description: "Upload / edit / delete company policies",
  },

  // ── Legal Tracker ──
  {
    code: "legal:read",
    module: "legal",
    action: "read",
    description: "View legal documents",
  },
  {
    code: "legal:create",
    module: "legal",
    action: "create",
    description: "Create legal documents",
  },
  {
    code: "legal:update",
    module: "legal",
    action: "update",
    description: "Update legal documents",
  },
  {
    code: "legal:delete",
    module: "legal",
    action: "delete",
    description: "Delete legal documents",
  },
  {
    code: "legal:sign-send",
    module: "legal",
    action: "sign-send",
    description: "Send legal documents for signature",
  },
  {
    code: "legal:sign-view",
    module: "legal",
    action: "sign-view",
    description: "View signature requests on legal documents",
  },
  {
    code: "legal:sign-docusign-admin",
    module: "legal",
    action: "sign-docusign-admin",
    description: "Manage the DocuSign integration (consent + status)",
  },
  {
    code: "legal:share",
    module: "legal",
    action: "share",
    description: "Share legal documents with users / departments / groups",
  },
  {
    code: "legal:view-shared",
    module: "legal",
    action: "view-shared",
    description: "View legal documents shared with the user",
  },
  {
    code: "legal:announcement-read",
    module: "legal",
    action: "announcement-read",
    description: "Read legal announcements (notice board)",
  },
  {
    code: "legal:announcement-manage",
    module: "legal",
    action: "announcement-manage",
    description: "Create, edit, publish or archive legal announcements",
  },

  // ── Directory ──
  {
    code: "directory:read",
    module: "directory",
    action: "read",
    description: "View employee directory",
  },
  {
    code: "directory:view-sensitive",
    module: "directory",
    action: "view-sensitive",
    description: "View sensitive info",
  },

  // ── Accounting ──
  {
    code: "accounting:read",
    module: "accounting",
    action: "read",
    description: "View accounting data",
  },
  {
    // Bypasses the own-document scoping applied to AR/AP documents: a holder
    // sees every invoice/bill regardless of who created it. Mirrors
    // `investors:read-all`. Granted to every current `accounting:read` holder
    // so the scoping rollout is non-breaking (see 20261206 migration + seed).
    code: "accounting:read-all",
    module: "accounting",
    action: "read-all",
    description: "View all accounting documents (bypass own-document scoping)",
  },
  {
    code: "accounting:create",
    module: "accounting",
    action: "create",
    description: "Create journal entries",
  },
  {
    code: "accounting:approve",
    module: "accounting",
    action: "approve",
    description: "Approve journal entries",
  },
  {
    code: "accounting:post",
    module: "accounting",
    action: "post",
    description: "Post journal entries",
  },
  {
    code: "accounting:admin",
    module: "accounting",
    action: "admin",
    description: "Full accounting admin",
  },

  // ── Travel Management ──
  {
    code: "travel:read",
    module: "travel",
    action: "read",
    description: "View own travel requests and status",
  },
  {
    code: "travel:request",
    module: "travel",
    action: "request",
    description: "Create/update travel requests",
  },
  {
    code: "travel:approve",
    module: "travel",
    action: "approve",
    description: "Approve or reject travel requests",
  },
  {
    code: "travel:assign-approver",
    module: "travel",
    action: "assign-approver",
    description: "Assign travel approvers per employee",
  },
  {
    code: "travel:hr-read",
    module: "travel",
    action: "hr-read",
    description: "View all travel requests (HR console)",
  },
  {
    code: "travel:hr-approve",
    module: "travel",
    action: "hr-approve",
    description: "Approve or reject any travel request (HR)",
  },
  {
    code: "travel:hr-on-behalf",
    module: "travel",
    action: "hr-on-behalf",
    description: "Submit travel request on behalf of employee",
  },
  {
    code: "travel:hr-settings",
    module: "travel",
    action: "hr-settings",
    description: "Manage travel approval chain and settings",
  },
  {
    code: "travel:export",
    module: "travel",
    action: "export",
    description: "Export travel reports CSV",
  },
  {
    code: "travel:audit-read",
    module: "travel",
    action: "audit-read",
    description: "View travel audit logs",
  },
  {
    code: "travel:analytics",
    module: "travel",
    action: "analytics",
    description: "View travel analytics dashboard",
  },

  // ── Expenses ──
  {
    code: "expense:read",
    module: "expense",
    action: "read",
    description: "View own expense reports",
  },
  {
    code: "expense:create",
    module: "expense",
    action: "create",
    description: "Create and edit own expense reports",
  },
  {
    code: "expense:approve",
    module: "expense",
    action: "approve",
    description: "Approve or reject assigned expense reports",
  },
  {
    code: "expense:hr-read",
    module: "expense",
    action: "hr-read",
    description: "View all expense reports (HR)",
  },
  {
    code: "expense:hr-approve",
    module: "expense",
    action: "hr-approve",
    description: "HR approve or reject any expense report",
  },
  {
    code: "expense:hr-settings",
    module: "expense",
    action: "hr-settings",
    description: "Manage expense approval chain and settings",
  },
  {
    code: "expense:assign-approver",
    module: "expense",
    action: "assign-approver",
    description: "Assign expense approver for employees",
  },
  {
    code: "expense:export",
    module: "expense",
    action: "export",
    description: "Export expense reports CSV/XLSX",
  },
  {
    code: "expense:audit-read",
    module: "expense",
    action: "audit-read",
    description: "View expense audit logs",
  },
  {
    code: "expense:hr-delete",
    module: "expense",
    action: "hr-delete",
    description:
      "Delete any expense report regardless of owner or status (admin)",
  },

  // ── Revenue ──
  {
    code: "revenue:read",
    module: "revenue",
    action: "read",
    description: "View revenue data",
  },

  // ── Investors ──
  {
    code: "investors:read",
    module: "investors",
    action: "read",
    description: "View investor data",
  },
  {
    code: "investors:read-all",
    module: "investors",
    action: "read-all",
    description: "View all investor details",
  },
  {
    code: "investors:create",
    module: "investors",
    action: "create",
    description: "Add investors",
  },
  {
    code: "investors:update",
    module: "investors",
    action: "update",
    description: "Edit investor info",
  },
  {
    code: "investors:delete",
    module: "investors",
    action: "delete",
    description: "Delete investors",
  },

  // ── Investor Dashboard ──
  {
    code: "investor-dashboard:read",
    module: "investor-dashboard",
    action: "read",
    description: "View investor dashboard",
  },

  // ── Investor CRM ──
  {
    code: "investor-crm:read",
    module: "investor-crm",
    action: "read",
    description: "View investor CRM",
  },
  {
    code: "investor-crm:manage",
    module: "investor-crm",
    action: "manage",
    description: "Manage investor relationships",
  },

  // ── Data Room ──
  {
    code: "dataroom:read",
    module: "dataroom",
    action: "read",
    description: "View data room",
  },
  {
    code: "dataroom:upload",
    module: "dataroom",
    action: "upload",
    description: "Upload documents",
  },
  {
    code: "dataroom:manage",
    module: "dataroom",
    action: "manage",
    description: "Manage data room",
  },

  // ── Investor Updates ──
  {
    code: "investor-updates:read",
    module: "investor-updates",
    action: "read",
    description: "View investor updates",
  },
  {
    code: "investor-updates:create",
    module: "investor-updates",
    action: "create",
    description: "Draft investor updates",
  },
  {
    code: "investor-updates:send",
    module: "investor-updates",
    action: "send",
    description: "Send investor updates",
  },

  // ── Administration ──
  {
    code: "admin:read",
    module: "admin",
    action: "read",
    description: "View admin dashboard",
  },
  {
    code: "admin:audit-log",
    module: "admin",
    action: "audit-log",
    description: "View audit logs",
  },
  {
    code: "admin:manage",
    module: "admin",
    action: "manage",
    description: "Manage admin settings",
  },
  {
    code: "admin:usage-report",
    module: "admin",
    action: "usage-report",
    description: "View workspace usage and storage rollups",
  },

  // ── Blog Management ──
  {
    code: "blog:read",
    module: "blog",
    action: "read",
    description: "View blog posts",
  },
  {
    code: "blog:create",
    module: "blog",
    action: "create",
    description: "Create blog posts",
  },
  {
    code: "blog:update",
    module: "blog",
    action: "update",
    description: "Edit blog posts",
  },
  {
    code: "blog:delete",
    module: "blog",
    action: "delete",
    description: "Delete blog posts",
  },

  // ── Docs / Wiki Repository ──
  {
    code: "docs:read",
    module: "docs",
    action: "read",
    description: "View wiki pages",
  },
  {
    code: "docs:create",
    module: "docs",
    action: "create",
    description: "Create wiki pages",
  },
  {
    code: "docs:update",
    module: "docs",
    action: "update",
    description: "Edit wiki pages",
  },
  {
    code: "docs:delete",
    module: "docs",
    action: "delete",
    description: "Delete wiki pages",
  },

  // ── PR Management ──
  {
    code: "pr:read",
    module: "pr",
    action: "read",
    description: "View PR articles",
  },
  {
    code: "pr:create",
    module: "pr",
    action: "create",
    description: "Create PR articles",
  },
  {
    code: "pr:update",
    module: "pr",
    action: "update",
    description: "Edit PR articles",
  },
  {
    code: "pr:delete",
    module: "pr",
    action: "delete",
    description: "Delete PR articles",
  },

  // ── Performance Review ──
  {
    code: "performance:read",
    module: "performance",
    action: "read",
    description: "View performance reviews and cycles",
  },
  {
    code: "performance:self-review",
    module: "performance",
    action: "self-review",
    description: "Submit self-review for appraisals",
  },
  {
    code: "performance:manager-review",
    module: "performance",
    action: "manager-review",
    description: "Submit manager review for appraisals",
  },
  {
    code: "performance:hr-manage",
    module: "performance",
    action: "hr-manage",
    description: "Full HR management of performance cycles",
  },
  {
    code: "performance:goals",
    module: "performance",
    action: "goals",
    description: "Manage performance goals",
  },

  // ── Access Control ──
  {
    code: "access-control:read",
    module: "access-control",
    action: "read",
    description: "View access control settings",
  },

  // ── Role Management ──
  {
    code: "role:read",
    module: "role-management",
    action: "read",
    description: "View roles & permissions",
  },
  {
    code: "role:create",
    module: "role-management",
    action: "create",
    description: "Create custom roles",
  },
  {
    code: "role:update",
    module: "role-management",
    action: "update",
    description: "Edit roles & permissions",
  },
  {
    code: "role:delete",
    module: "role-management",
    action: "delete",
    description: "Delete custom roles",
  },

  // ── User Management ──
  {
    code: "user:read",
    module: "user-management",
    action: "read",
    description: "View user list",
  },
  {
    code: "user:create",
    module: "user-management",
    action: "create",
    description: "Create new users",
  },
  {
    code: "user:update",
    module: "user-management",
    action: "update",
    description: "Edit user profiles",
  },
  {
    code: "user:delete",
    module: "user-management",
    action: "delete",
    description: "Delete users",
  },
  {
    code: "user:assign-role",
    module: "user-management",
    action: "assign-role",
    description: "Assign/remove user roles",
  },

  // ── IT CRM (Projects workspace scoped to team=it) ──
  // Note: these are separate from the IT Helpdesk perms below — the
  // IT CRM is a Projects-style workspace at /it-crm, not the ticket
  // queue. The IT team typically holds both sets so they can run
  // their own roadmap alongside the helpdesk inbox. Mirrors the full
  // 6-perm Projects set so a non-admin IT lead can run their own
  // workspace end-to-end.
  {
    code: "it-crm:read",
    module: "it-crm",
    action: "read",
    description: "View own IT CRM (Projects) workspace",
  },
  {
    code: "it-crm:read-all",
    module: "it-crm",
    action: "read-all",
    description: "View every project in the IT CRM workspace",
  },
  {
    code: "it-crm:create",
    module: "it-crm",
    action: "create",
    description: "Create projects in the IT CRM workspace",
  },
  {
    code: "it-crm:update",
    module: "it-crm",
    action: "update",
    description: "Edit projects in the IT CRM workspace",
  },
  {
    code: "it-crm:delete",
    module: "it-crm",
    action: "delete",
    description: "Delete projects in the IT CRM workspace",
  },
  {
    code: "it-crm:manage",
    module: "it-crm",
    action: "manage",
    description:
      "Full management of the IT CRM workspace (row-level edit / delete on any project)",
  },

  // ── Product CRM (Projects workspace scoped to team=product) ──
  {
    code: "product-crm:read",
    module: "product-crm",
    action: "read",
    description: "View own Product CRM (Projects) workspace",
  },
  {
    code: "product-crm:read-all",
    module: "product-crm",
    action: "read-all",
    description: "View every project in the Product CRM workspace",
  },
  {
    code: "product-crm:create",
    module: "product-crm",
    action: "create",
    description: "Create projects in the Product CRM workspace",
  },
  {
    code: "product-crm:update",
    module: "product-crm",
    action: "update",
    description: "Edit projects in the Product CRM workspace",
  },
  {
    code: "product-crm:delete",
    module: "product-crm",
    action: "delete",
    description: "Delete projects in the Product CRM workspace",
  },
  {
    code: "product-crm:manage",
    module: "product-crm",
    action: "manage",
    description:
      "Full management of the Product CRM workspace (row-level edit / delete on any project)",
  },

  // ── Legal CRM (Projects workspace scoped to team=legal) ──
  {
    code: "legal-crm:read",
    module: "legal-crm",
    action: "read",
    description: "View own Legal CRM (Projects) workspace",
  },
  {
    code: "legal-crm:read-all",
    module: "legal-crm",
    action: "read-all",
    description: "View every project in the Legal CRM workspace",
  },
  {
    code: "legal-crm:create",
    module: "legal-crm",
    action: "create",
    description: "Create projects in the Legal CRM workspace",
  },
  {
    code: "legal-crm:update",
    module: "legal-crm",
    action: "update",
    description: "Edit projects in the Legal CRM workspace",
  },
  {
    code: "legal-crm:delete",
    module: "legal-crm",
    action: "delete",
    description: "Delete projects in the Legal CRM workspace",
  },
  {
    code: "legal-crm:manage",
    module: "legal-crm",
    action: "manage",
    description:
      "Full management of the Legal CRM workspace (row-level edit / delete on any project)",
  },

  // ── Accounting CRM (Projects workspace scoped to team=accounting) ──
  {
    code: "accounting-crm:read",
    module: "accounting-crm",
    action: "read",
    description: "View own Accounting CRM (Projects) workspace",
  },
  {
    code: "accounting-crm:read-all",
    module: "accounting-crm",
    action: "read-all",
    description: "View every project in the Accounting CRM workspace",
  },
  {
    code: "accounting-crm:create",
    module: "accounting-crm",
    action: "create",
    description: "Create projects in the Accounting CRM workspace",
  },
  {
    code: "accounting-crm:update",
    module: "accounting-crm",
    action: "update",
    description: "Edit projects in the Accounting CRM workspace",
  },
  {
    code: "accounting-crm:delete",
    module: "accounting-crm",
    action: "delete",
    description: "Delete projects in the Accounting CRM workspace",
  },
  {
    code: "accounting-crm:manage",
    module: "accounting-crm",
    action: "manage",
    description:
      "Full management of the Accounting CRM workspace (row-level edit / delete on any project)",
  },

  // ── HR CRM (Projects workspace scoped to team=hr) ──
  {
    code: "hr-crm:read",
    module: "hr-crm",
    action: "read",
    description: "View own HR CRM (Projects) workspace",
  },
  {
    code: "hr-crm:read-all",
    module: "hr-crm",
    action: "read-all",
    description: "View every project in the HR CRM workspace",
  },
  {
    code: "hr-crm:create",
    module: "hr-crm",
    action: "create",
    description: "Create projects in the HR CRM workspace",
  },
  {
    code: "hr-crm:update",
    module: "hr-crm",
    action: "update",
    description: "Edit projects in the HR CRM workspace",
  },
  {
    code: "hr-crm:delete",
    module: "hr-crm",
    action: "delete",
    description: "Delete projects in the HR CRM workspace",
  },
  {
    code: "hr-crm:manage",
    module: "hr-crm",
    action: "manage",
    description:
      "Full management of the HR CRM workspace (row-level edit / delete on any project)",
  },

  // ── Voucher CRM (flat per-partner voucher ledger) ──
  {
    code: "voucher-crm:read",
    module: "voucher-crm",
    action: "read",
    description: "View own Voucher CRM rows",
  },
  {
    code: "voucher-crm:read-all",
    module: "voucher-crm",
    action: "read-all",
    description: "View every row in the Voucher CRM",
  },
  {
    code: "voucher-crm:create",
    module: "voucher-crm",
    action: "create",
    description: "Add partner voucher rows",
  },
  {
    code: "voucher-crm:update",
    module: "voucher-crm",
    action: "update",
    description: "Edit partner voucher rows",
  },
  {
    code: "voucher-crm:delete",
    module: "voucher-crm",
    action: "delete",
    description: "Delete partner voucher rows",
  },
  {
    code: "voucher-crm:manage",
    module: "voucher-crm",
    action: "manage",
    description:
      "Full management of the Voucher CRM (edit / delete any partner row)",
  },

  // ── QA CRM (standalone Option A workspace) ──
  // Greenfield CRM at /qa-crm. Same 6-perm shape as the other
  // per-team workspaces. Task model extends with QA-specific fields
  // (issue date, product, observation, expectation, ETA, comment).
  {
    code: "qa-crm:read",
    module: "qa-crm",
    action: "read",
    description: "View own QA CRM workspace",
  },
  {
    code: "qa-crm:read-all",
    module: "qa-crm",
    action: "read-all",
    description: "View every project in the QA CRM workspace",
  },
  {
    code: "qa-crm:create",
    module: "qa-crm",
    action: "create",
    description: "Create projects in the QA CRM workspace",
  },
  {
    code: "qa-crm:update",
    module: "qa-crm",
    action: "update",
    description: "Edit projects + issues in the QA CRM workspace",
  },
  {
    code: "qa-crm:delete",
    module: "qa-crm",
    action: "delete",
    description: "Delete projects + issues in the QA CRM workspace",
  },
  {
    code: "qa-crm:manage",
    module: "qa-crm",
    action: "manage",
    description:
      "Full management of the QA CRM workspace (row-level edit / delete on any project)",
  },

  // ── IT Helpdesk ──
  {
    code: "it:read",
    module: "it-helpdesk",
    action: "read",
    description: "View own IT helpdesk tickets",
  },
  {
    code: "it:read-all",
    module: "it-helpdesk",
    action: "read-all",
    description: "View all IT helpdesk tickets (IT team)",
  },
  {
    code: "it:create",
    module: "it-helpdesk",
    action: "create",
    description: "Create IT helpdesk tickets",
  },
  {
    code: "it:update",
    module: "it-helpdesk",
    action: "update",
    description: "Update IT helpdesk tickets (status / priority / category)",
  },
  {
    code: "it:assign",
    module: "it-helpdesk",
    action: "assign",
    description: "Assign IT helpdesk tickets to an IT team member",
  },
  {
    code: "it:resolve",
    module: "it-helpdesk",
    action: "resolve",
    description: "Resolve or close IT helpdesk tickets",
  },
  {
    code: "it:delete",
    module: "it-helpdesk",
    action: "delete",
    description: "Delete IT helpdesk tickets",
  },
  {
    code: "it:validator-alert-manage",
    module: "it-helpdesk",
    action: "validator-alert-manage",
    description: "Create, update, delete validator-monitor email alerts",
  },
  {
    code: "it:settings-manage",
    module: "it-helpdesk",
    action: "settings-manage",
    description: "Configure IT helpdesk notification settings",
  },

  // ── IT Operations (IT Billing Monitoring + Access Management) ──
  // Distinct from the IT Helpdesk (`it:*`) and IT CRM (`it-crm:*`) modules.
  // The IT team typically holds all three. Billing is HR/Finance-ish
  // (vendors, subscriptions, spend); Access Management is request →
  // manager -> IT approval -> grant.
  {
    code: "it:dashboard:view",
    module: "it-operations",
    action: "dashboard-view",
    description: "View the IT Operations dashboard + Office Network Checkup",
  },
  {
    code: "it:billing:view",
    module: "it-operations",
    action: "billing-view",
    description: "View IT vendors, subscriptions, billing, and reports",
  },
  {
    code: "it:billing:manage",
    module: "it-operations",
    action: "billing-manage",
    description: "Create / edit / delete IT vendors, subscriptions, billing",
  },
  {
    code: "it:access:view",
    module: "it-operations",
    action: "access-view",
    description: "View all access requests, assignments, and audit trail",
  },
  {
    code: "it:access:request",
    module: "it-operations",
    action: "access-request",
    description: "Submit and track own access requests",
  },
  {
    code: "it:access:approve",
    module: "it-operations",
    action: "access-approve",
    description: "Approve or reject access requests at the IT step",
  },
  {
    code: "it:access:manage",
    module: "it-operations",
    action: "access-manage",
    description: "Grant / revoke access, manage systems, run offboarding",
  },

  // ── Marketing Analytics (BNII Analytics API dashboard + raw explorer) ──
  {
    code: "marketing:dashboard:view",
    module: "marketing-analytics",
    action: "dashboard-view",
    description: "View the Marketing Analytics dashboard",
  },
  {
    code: "marketing:raw:view",
    module: "marketing-analytics",
    action: "raw-view",
    description: "View and export the Marketing Analytics raw metrics catalog",
  },
  {
    code: "marketing:campaign:view",
    module: "marketing-analytics",
    action: "campaign-view",
    description: "View marketing campaigns, creatives, and predictions",
  },
  {
    code: "marketing:campaign:create",
    module: "marketing-analytics",
    action: "campaign-create",
    description: "Create marketing campaigns and upload creatives/predictions",
  },
  {
    code: "marketing:campaign:update",
    module: "marketing-analytics",
    action: "campaign-update",
    description: "Edit marketing campaigns and manage levers",
  },
  {
    code: "marketing:campaign:delete",
    module: "marketing-analytics",
    action: "campaign-delete",
    description: "Delete marketing campaigns and their assets",
  },
  {
    code: "marketing:reports:view",
    module: "marketing-analytics",
    action: "reports-view",
    description:
      "View marketing analytics, prediction-vs-actual, and generate reports",
  },

  // ── Cash Advance Requests ──
  {
    code: "cash-advance:read",
    module: "cash-advance",
    action: "read",
    description: "View own cash advance requests",
  },
  {
    code: "cash-advance:create",
    module: "cash-advance",
    action: "create",
    description: "Submit cash advance requests",
  },
  {
    code: "cash-advance:read-all",
    module: "cash-advance",
    action: "read-all",
    description: "View every cash advance request (HR / Finance)",
  },
  {
    code: "cash-advance:approve",
    module: "cash-advance",
    action: "approve",
    description: "Approve, reject, or mark a cash advance disbursed / cleared",
  },
  {
    code: "certificate:read",
    module: "certificate",
    action: "read",
    description: "View issued certificates",
  },
  {
    code: "certificate:manage",
    module: "certificate",
    action: "manage",
    description: "Create, issue, and email recognition certificates",
  },
];

export const PERMISSIONS = PERMISSION_DEFINITIONS.reduce(
  (acc, p) => {
    const key = p.code.replace(/[:-]/g, "_").toUpperCase();
    acc[key] = p.code;
    return acc;
  },
  {} as Record<string, string>,
) as {
  HOME_READ: "home:read";
  CERTIFICATE_READ: "certificate:read";
  CERTIFICATE_MANAGE: "certificate:manage";
  WALL_CREATE: "wall:create";
  WALL_DELETE: "wall:delete";
  NEWS_CREATE: "news:create";
  NEWS_DELETE: "news:delete";
  ARIA_USE: "aria:use";
  ARIA_PARSE: "aria:parse";
  ARIA_KNOWLEDGE_MANAGE: "aria:knowledge-manage";
  ARIA_BRIEF_SUBSCRIBE: "aria:brief-subscribe";
  INTEGRATIONS_USE: "integrations:use";
  INTEGRATIONS_MANAGE: "integrations:manage";
  MESSAGES_READ: "messages:read";
  MESSAGES_CREATE: "messages:create";
  MESSAGES_DELETE: "messages:delete";
  MESSAGES_ADMIN: "messages:admin";
  PROJECTS_READ: "projects:read";
  PROJECTS_READ_ALL: "projects:read-all";
  PROJECTS_CREATE: "projects:create";
  PROJECTS_UPDATE: "projects:update";
  PROJECTS_DELETE: "projects:delete";
  PROJECTS_MANAGE: "projects:manage";
  WORKFLOW_SUBMIT: "workflow:submit";
  WORKFLOW_PM_APPROVE: "workflow:pm-approve";
  WORKFLOW_BUSINESS_HEAD_APPROVE: "workflow:business-head-approve";
  WORKFLOW_PRODUCT_ADMIN_APPROVE: "workflow:product-admin-approve";
  WORKFLOW_COMPLETE: "workflow:complete";
  WORKFLOW_RETURN: "workflow:return";
  WORKFLOW_REOPEN: "workflow:reopen";
  WORKFLOW_ARCHIVE: "workflow:archive";
  WORKFLOW_ESCALATE: "workflow:escalate";
  WORKFLOW_REASSIGN: "workflow:reassign";
  WORKFLOW_TIMELINE_MANAGE: "workflow:timeline-manage";
  WORKFLOW_PROGRESS_UPDATE: "workflow:progress-update";
  PROPOSALS_READ: "proposals:read";
  PROPOSALS_CREATE: "proposals:create";
  PROPOSALS_REVIEW: "proposals:review";
  PROPOSALS_APPROVE: "proposals:approve";
  ANALYTICS_READ: "analytics:read";
  ANALYTICS_READ_ALL: "analytics:read-all";
  PARTNERS_READ: "partners:read";
  PARTNERS_CREATE: "partners:create";
  PARTNERS_UPDATE: "partners:update";
  PARTNERS_DELETE: "partners:delete";
  DEALS_READ: "deals:read";
  DEALS_CREATE: "deals:create";
  DEALS_UPDATE: "deals:update";
  DEALS_DELETE: "deals:delete";
  DEALS_MANAGE: "deals:manage";
  CRM_READ: "crm:read";
  CRM_TEAM_READ: "crm:team-read";
  CRM_CREATE: "crm:create";
  CRM_UPDATE: "crm:update";
  CRM_DELETE: "crm:delete";
  CRM_REASSIGN: "crm:reassign";
  CRM_EXPORT: "crm:export";
  CRM_ADMIN: "crm:admin";
  CRM_SETTINGS_MANAGE: "crm:settings-manage";
  SALES_REVENUE_READ: "sales-revenue:read";
  SALES_REVENUE_TEAM_READ: "sales-revenue:team-read";
  SALES_REVENUE_CREATE: "sales-revenue:create";
  SALES_REVENUE_UPDATE: "sales-revenue:update";
  SALES_REVENUE_DELETE: "sales-revenue:delete";
  SALES_REVENUE_REASSIGN: "sales-revenue:reassign";
  SALES_REVENUE_EXPORT: "sales-revenue:export";
  SALES_REVENUE_ADMIN: "sales-revenue:admin";
  SALES_REVENUE_SETTINGS_MANAGE: "sales-revenue:settings-manage";
  CAREER_READ: "career:read";
  CAREER_CREATE: "career:create";
  CAREER_UPDATE: "career:update";
  CAREER_DELETE: "career:delete";
  CAREER_EXPORT: "career:export";
  APPLICATION_READ: "application:read";
  APPLICATION_DELETE: "application:delete";
  APPLICATION_EXPORT: "application:export";
  SURVEY_MANAGE_WAVE: "survey:manage-wave";
  SURVEY_MANAGE: "survey:manage";
  LEAVE_READ: "leave:read";
  LEAVE_REQUEST: "leave:request";
  LEAVE_APPROVE: "leave:approve";
  LEAVE_APPROVE_WFH: "leave:approve-wfh";
  LEAVE_TEAM_CALENDAR: "leave:team-calendar";
  LEAVE_HR_READ: "leave:hr-read";
  LEAVE_HR_ADJUST: "leave:hr-adjust";
  LEAVE_HR_ON_BEHALF: "leave:hr-on-behalf";
  LEAVE_HR_SETTINGS: "leave:hr-settings";
  LEAVE_ASSIGN_APPROVER: "leave:assign-approver";
  LEAVE_EXPORT: "leave:export";
  LEAVE_AUDIT_READ: "leave:audit-read";
  LEAVE_BULK_IMPORT: "leave:bulk-import";
  LEAVE_ANALYTICS: "leave:analytics";
  BENEFITS_READ: "benefits:read";
  BENEFITS_MANAGE: "benefits:manage";
  BENEFITS_ENROLL: "benefits:enroll";
  PAYROLL_READ: "payroll:read";
  PAYROLL_CREATE: "payroll:create";
  PAYROLL_APPROVE: "payroll:approve";
  PAYROLL_HR_ADMIN: "payroll:hr-admin";
  HRMS_READ: "hrms:read";
  HRMS_ESOP_MANAGE: "hrms:esop-manage";
  HRMS_ONBOARDING_MANAGE: "hrms:onboarding-manage";
  HRMS_OFFBOARDING_MANAGE: "hrms:offboarding-manage";
  HRMS_AGREEMENTS_MANAGE: "hrms:agreements-manage";
  HRMS_ATTENDANCE_READ: "hrms:attendance-read";
  HRMS_ATTENDANCE_MANAGE: "hrms:attendance-manage";
  HRMS_ATTENDANCE_POLICY_MANAGE: "hrms:attendance-policy-manage";
  HRMS_ATTENDANCE_CORRECTION_APPROVE: "hrms:attendance-correction-approve";
  HRMS_ATTENDANCE_REPORT_EXPORT: "hrms:attendance-report-export";
  LEARNING_READ: "learning:read";
  LEARNING_COMPLETE: "learning:complete";
  LEARNING_MANAGE: "learning:manage";
  LEARNING_HR_READ: "learning:hr-read";
  VISA_READ: "visa:read";
  VISA_HR_READ: "visa:hr-read";
  VISA_MANAGE: "visa:manage";
  OFFICE_READ: "office:read";
  OFFICE_BOOK: "office:book";
  OFFICE_MANAGE: "office:manage";
  POLICY_READ: "policy:read";
  POLICY_MANAGE: "policy:manage";
  LEGAL_READ: "legal:read";
  LEGAL_CREATE: "legal:create";
  LEGAL_UPDATE: "legal:update";
  LEGAL_DELETE: "legal:delete";
  LEGAL_SIGN_SEND: "legal:sign-send";
  LEGAL_SIGN_VIEW: "legal:sign-view";
  LEGAL_SIGN_DOCUSIGN_ADMIN: "legal:sign-docusign-admin";
  LEGAL_SHARE: "legal:share";
  LEGAL_VIEW_SHARED: "legal:view-shared";
  LEGAL_ANNOUNCEMENT_READ: "legal:announcement-read";
  LEGAL_ANNOUNCEMENT_MANAGE: "legal:announcement-manage";
  DIRECTORY_READ: "directory:read";
  DIRECTORY_VIEW_SENSITIVE: "directory:view-sensitive";
  ACCOUNTING_READ: "accounting:read";
  ACCOUNTING_READ_ALL: "accounting:read-all";
  ACCOUNTING_CREATE: "accounting:create";
  ACCOUNTING_APPROVE: "accounting:approve";
  ACCOUNTING_POST: "accounting:post";
  ACCOUNTING_ADMIN: "accounting:admin";
  TRAVEL_READ: "travel:read";
  TRAVEL_REQUEST: "travel:request";
  TRAVEL_APPROVE: "travel:approve";
  TRAVEL_ASSIGN_APPROVER: "travel:assign-approver";
  TRAVEL_HR_READ: "travel:hr-read";
  TRAVEL_HR_APPROVE: "travel:hr-approve";
  TRAVEL_HR_ON_BEHALF: "travel:hr-on-behalf";
  TRAVEL_HR_SETTINGS: "travel:hr-settings";
  TRAVEL_EXPORT: "travel:export";
  TRAVEL_AUDIT_READ: "travel:audit-read";
  TRAVEL_ANALYTICS: "travel:analytics";
  EXPENSE_READ: "expense:read";
  EXPENSE_CREATE: "expense:create";
  EXPENSE_APPROVE: "expense:approve";
  EXPENSE_HR_READ: "expense:hr-read";
  EXPENSE_HR_APPROVE: "expense:hr-approve";
  EXPENSE_HR_SETTINGS: "expense:hr-settings";
  EXPENSE_ASSIGN_APPROVER: "expense:assign-approver";
  EXPENSE_EXPORT: "expense:export";
  EXPENSE_AUDIT_READ: "expense:audit-read";
  EXPENSE_HR_DELETE: "expense:hr-delete";
  REVENUE_READ: "revenue:read";
  INVESTORS_READ: "investors:read";
  INVESTORS_READ_ALL: "investors:read-all";
  INVESTORS_CREATE: "investors:create";
  INVESTORS_UPDATE: "investors:update";
  INVESTORS_DELETE: "investors:delete";
  INVESTOR_DASHBOARD_READ: "investor-dashboard:read";
  INVESTOR_CRM_READ: "investor-crm:read";
  INVESTOR_CRM_MANAGE: "investor-crm:manage";
  DATAROOM_READ: "dataroom:read";
  DATAROOM_UPLOAD: "dataroom:upload";
  DATAROOM_MANAGE: "dataroom:manage";
  INVESTOR_UPDATES_READ: "investor-updates:read";
  INVESTOR_UPDATES_CREATE: "investor-updates:create";
  INVESTOR_UPDATES_SEND: "investor-updates:send";
  ADMIN_READ: "admin:read";
  ADMIN_AUDIT_LOG: "admin:audit-log";
  ADMIN_MANAGE: "admin:manage";
  ADMIN_USAGE_REPORT: "admin:usage-report";
  BLOG_READ: "blog:read";
  BLOG_CREATE: "blog:create";
  BLOG_UPDATE: "blog:update";
  BLOG_DELETE: "blog:delete";
  DOCS_READ: "docs:read";
  DOCS_CREATE: "docs:create";
  DOCS_UPDATE: "docs:update";
  DOCS_DELETE: "docs:delete";
  PR_READ: "pr:read";
  PR_CREATE: "pr:create";
  PR_UPDATE: "pr:update";
  PR_DELETE: "pr:delete";
  PERFORMANCE_READ: "performance:read";
  PERFORMANCE_SELF_REVIEW: "performance:self-review";
  PERFORMANCE_MANAGER_REVIEW: "performance:manager-review";
  PERFORMANCE_HR_MANAGE: "performance:hr-manage";
  PERFORMANCE_GOALS: "performance:goals";
  ACCESS_CONTROL_READ: "access-control:read";
  ROLE_READ: "role:read";
  ROLE_CREATE: "role:create";
  ROLE_UPDATE: "role:update";
  ROLE_DELETE: "role:delete";
  USER_READ: "user:read";
  USER_CREATE: "user:create";
  USER_UPDATE: "user:update";
  USER_DELETE: "user:delete";
  USER_ASSIGN_ROLE: "user:assign-role";
  IT_CRM_READ: "it-crm:read";
  IT_CRM_READ_ALL: "it-crm:read-all";
  IT_CRM_CREATE: "it-crm:create";
  IT_CRM_UPDATE: "it-crm:update";
  IT_CRM_DELETE: "it-crm:delete";
  IT_CRM_MANAGE: "it-crm:manage";
  PRODUCT_CRM_READ: "product-crm:read";
  PRODUCT_CRM_READ_ALL: "product-crm:read-all";
  PRODUCT_CRM_CREATE: "product-crm:create";
  PRODUCT_CRM_UPDATE: "product-crm:update";
  PRODUCT_CRM_DELETE: "product-crm:delete";
  PRODUCT_CRM_MANAGE: "product-crm:manage";
  LEGAL_CRM_READ: "legal-crm:read";
  LEGAL_CRM_READ_ALL: "legal-crm:read-all";
  LEGAL_CRM_CREATE: "legal-crm:create";
  LEGAL_CRM_UPDATE: "legal-crm:update";
  LEGAL_CRM_DELETE: "legal-crm:delete";
  LEGAL_CRM_MANAGE: "legal-crm:manage";
  ACCOUNTING_CRM_READ: "accounting-crm:read";
  ACCOUNTING_CRM_READ_ALL: "accounting-crm:read-all";
  ACCOUNTING_CRM_CREATE: "accounting-crm:create";
  ACCOUNTING_CRM_UPDATE: "accounting-crm:update";
  ACCOUNTING_CRM_DELETE: "accounting-crm:delete";
  ACCOUNTING_CRM_MANAGE: "accounting-crm:manage";
  HR_CRM_READ: "hr-crm:read";
  HR_CRM_READ_ALL: "hr-crm:read-all";
  HR_CRM_CREATE: "hr-crm:create";
  HR_CRM_UPDATE: "hr-crm:update";
  HR_CRM_DELETE: "hr-crm:delete";
  HR_CRM_MANAGE: "hr-crm:manage";
  VOUCHER_CRM_READ: "voucher-crm:read";
  VOUCHER_CRM_READ_ALL: "voucher-crm:read-all";
  VOUCHER_CRM_CREATE: "voucher-crm:create";
  VOUCHER_CRM_UPDATE: "voucher-crm:update";
  VOUCHER_CRM_DELETE: "voucher-crm:delete";
  VOUCHER_CRM_MANAGE: "voucher-crm:manage";
  QA_CRM_READ: "qa-crm:read";
  QA_CRM_READ_ALL: "qa-crm:read-all";
  QA_CRM_CREATE: "qa-crm:create";
  QA_CRM_UPDATE: "qa-crm:update";
  QA_CRM_DELETE: "qa-crm:delete";
  QA_CRM_MANAGE: "qa-crm:manage";
  IT_READ: "it:read";
  IT_READ_ALL: "it:read-all";
  IT_CREATE: "it:create";
  IT_UPDATE: "it:update";
  IT_ASSIGN: "it:assign";
  IT_RESOLVE: "it:resolve";
  IT_DELETE: "it:delete";
  IT_VALIDATOR_ALERT_MANAGE: "it:validator-alert-manage";
  IT_SETTINGS_MANAGE: "it:settings-manage";
  CASH_ADVANCE_READ: "cash-advance:read";
  CASH_ADVANCE_CREATE: "cash-advance:create";
  CASH_ADVANCE_READ_ALL: "cash-advance:read-all";
  CASH_ADVANCE_APPROVE: "cash-advance:approve";
  IT_DASHBOARD_VIEW: "it:dashboard:view";
  IT_BILLING_VIEW: "it:billing:view";
  IT_BILLING_MANAGE: "it:billing:manage";
  IT_ACCESS_VIEW: "it:access:view";
  IT_ACCESS_REQUEST: "it:access:request";
  IT_ACCESS_APPROVE: "it:access:approve";
  IT_ACCESS_MANAGE: "it:access:manage";
  MARKETING_DASHBOARD_VIEW: "marketing:dashboard:view";
  MARKETING_RAW_VIEW: "marketing:raw:view";
  MARKETING_CAMPAIGN_VIEW: "marketing:campaign:view";
  MARKETING_CAMPAIGN_CREATE: "marketing:campaign:create";
  MARKETING_CAMPAIGN_UPDATE: "marketing:campaign:update";
  MARKETING_CAMPAIGN_DELETE: "marketing:campaign:delete";
  MARKETING_REPORTS_VIEW: "marketing:reports:view";
};

export const ALL_PERMISSION_CODES = PERMISSION_DEFINITIONS.map((p) => p.code);

/**
 * Older docs/seeds used different strings; some DBs still store these.
 * Mapped to the canonical codes used by guards and the permission catalog.
 */
export const LEGACY_PERMISSION_CODE_ALIASES: Readonly<Record<string, string>> =
  {
    "leave:create": "leave:request",
    "expenses:read": "expense:read",
    "expenses:create": "expense:create",
    "expenses:approve": "expense:approve",
    "expenses:hr-read": "expense:hr-read",
    "expenses:hr-approve": "expense:hr-approve",
    "expenses:assign-approver": "expense:assign-approver",
    "expenses:export": "expense:export",
    "expenses:audit-read": "expense:audit-read",
  };

export function normalizePermissionCode(code: string): string {
  const trimmed = code.trim();
  return LEGACY_PERMISSION_CODE_ALIASES[trimmed] ?? trimmed;
}

/** Trim, apply legacy aliases, dedupe (preserves first occurrence order). */
export function normalizePermissionCodes(codes: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of codes) {
    const c = normalizePermissionCode(raw);
    if (!seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}

export const PERMISSIONS_BY_MODULE = PERMISSION_DEFINITIONS.reduce<
  Record<string, PermissionDef[]>
>((acc, p) => {
  const existing = acc[p.module] ?? [];
  return { ...acc, [p.module]: [...existing, p] };
}, {});

export function isValidPermissionCode(code: string): boolean {
  return ALL_PERMISSION_CODES.includes(code);
}
