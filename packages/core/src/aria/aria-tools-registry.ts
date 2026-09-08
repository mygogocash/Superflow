/** Static tool metadata for GET /aria/tools (edge-safe subset). */
export type AriaToolMeta = {
  name: string;
  description: string;
  requiredPermissions: string[];
};

export const ARIA_TOOLS_REGISTRY: AriaToolMeta[] = [
  // Keep gates in sync with apps/api aria-tools TOOL_REQUIRED_ANY_OF /
  // handler checks — the chat loop filters advertised tools the same way.
  { name: "lookup_employee", description: "Find an employee by name or email", requiredPermissions: ["directory:read"] },
  { name: "lookup_visa", description: "Look up visa details for an employee", requiredPermissions: ["visa:read"] },
  { name: "list_expiring_visas", description: "List visas expiring soon", requiredPermissions: ["visa:hr-read", "visa:manage"] },
  { name: "lookup_leave_balance", description: "Check leave balances", requiredPermissions: [] },
  { name: "list_my_pending_approvals", description: "List pending approvals for the caller", requiredPermissions: [] },
  { name: "lookup_expense_report", description: "Look up an expense report", requiredPermissions: [] },
  { name: "lookup_helpdesk_ticket", description: "Look up a helpdesk ticket", requiredPermissions: [] },
  { name: "lookup_partner", description: "Look up a partner record", requiredPermissions: ["partners:read"] },
  { name: "lookup_project", description: "Look up a project", requiredPermissions: ["projects:read"] },
  { name: "search_policy", description: "Search company policies", requiredPermissions: [] },
  { name: "lookup_account", description: "Look up a CRM account", requiredPermissions: ["crm:read"] },
  { name: "lookup_opportunity", description: "Look up a sales opportunity", requiredPermissions: ["crm:read"] },
  { name: "list_my_pipeline", description: "Summarise the caller's pipeline", requiredPermissions: ["crm:read"] },
  { name: "account_email_summary", description: "Summarise recent emails for an account", requiredPermissions: ["crm:read"] },
  { name: "lookup_my_calendar", description: "Look up calendar events for the caller", requiredPermissions: ["integrations:use"] },
  { name: "submit_leave_request", description: "Submit a leave request on behalf of the caller", requiredPermissions: ["leave:request"] },
  { name: "aria_memory_forget", description: "Forget a stored Manut AI memory item", requiredPermissions: ["aria:use"] },
];

export function listToolsForPermissions(permissions: string[], isSystemAdmin: boolean) {
  const allowed = new Set(permissions);
  return ARIA_TOOLS_REGISTRY.filter((tool) => {
    if (isSystemAdmin) return true;
    if (tool.requiredPermissions.length === 0) return true;
    return tool.requiredPermissions.some((p) => allowed.has(p));
  });
}
