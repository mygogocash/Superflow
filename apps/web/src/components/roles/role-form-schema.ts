import { z } from "zod";

export const roleSchema = z.object({
  name: z.string().min(2, "Role name is required").max(50),
  description: z.string().max(500).optional().or(z.literal("")),
  permissions: z.array(z.string()).min(1, "Select at least one permission"),
});

export type RoleFormValues = z.infer<typeof roleSchema>;

export const ALL_MODULES = "__all__";

// Explicit labels for modules whose codes are awkward when title-cased
// (acronyms, the Sales CRM v2 vs legacy split, etc.). Anything not listed
// falls through to a generic "split-on-dash + capitalise" rule.
const MODULE_LABELS: Record<string, string> = {
  crm: "Sales CRM",
  deals: "Sales CRM (legacy deals)",
  "investor-crm": "Investor CRM",
  hrms: "HRMS",
  pr: "PR",
  aria: "Manut AI",
  "access-control": "Access Control",
  "user-management": "Users",
  "role-management": "Roles",
  "investor-updates": "Investor Updates",
  "investor-dashboard": "Investor Dashboard",
  "qa-crm": "QA CRM",
  "voucher-crm": "Voucher CRM",
};

export function humanizeModule(module: string): string {
  if (MODULE_LABELS[module]) return MODULE_LABELS[module];
  return module
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
