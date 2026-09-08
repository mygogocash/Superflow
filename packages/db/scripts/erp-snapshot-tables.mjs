/**
 * Allowlist + deny rules for Neon → Databricks bronze snapshot export.
 * Keep marketing / BNII / OneWave / parked revenue_* tables out of v1.
 */

/** @typedef {'p0' | 'p1'} SnapshotSlice */

/** @type {Record<SnapshotSlice, readonly string[]>} */
export const SLICE_TABLES = {
  p0: [
    "entities",
    "users",
    "roles",
    "role_permissions",
    "user_roles",
    "leave_requests",
    "leave_approval_steps",
    "leave_approval_decisions",
    "travel_requests",
    "travel_approval_steps",
    "travel_approval_decisions",
    "expenses",
    "expense_reports",
    "expense_approval_steps",
    "expense_approval_decisions",
    "cash_advance_requests",
    "cash_advance_approval_steps",
    "cash_advance_approval_decisions",
    "cash_advance_items",
  ],
  p1: [
    "crm_leads",
    "crm_accounts",
    "crm_contacts",
    "crm_opportunities",
    "projects",
    "project_tasks",
  ],
};

/** Explicit denylist (beyond prefix rules). */
export const DENY_TABLES = new Set([
  "ow_daily_metrics",
  "ow_snapshots",
  "revenue_accounts",
  "revenue_contacts",
  "revenue_leads",
  "revenue_opportunities",
  "revenue_lead_sources",
  "revenue_opportunity_business_units",
]);

/**
 * @param {string} table
 * @returns {boolean}
 */
export function isDeniedTable(table) {
  const name = String(table || "").toLowerCase();
  if (!name) return true;
  if (DENY_TABLES.has(name)) return true;
  if (name.startsWith("ow_")) return true;
  if (name.startsWith("revenue_")) return true;
  if (name.includes("marketing")) return true;
  if (name.startsWith("bnii")) return true;
  return false;
}

/**
 * @param {SnapshotSlice | 'all'} slice
 * @returns {string[]}
 */
export function resolveExportTables(slice) {
  /** @type {string[]} */
  let tables;
  if (slice === "all") {
    tables = [...SLICE_TABLES.p0, ...SLICE_TABLES.p1];
  } else if (slice === "p0" || slice === "p1") {
    tables = [...SLICE_TABLES[slice]];
  } else {
    throw new Error(`unknown slice '${slice}' (expected p0|p1|all)`);
  }

  const denied = tables.filter(isDeniedTable);
  if (denied.length) {
    throw new Error(
      `allowlist contains denied tables (fix the slice): ${denied.join(", ")}`,
    );
  }
  return tables;
}
