// Organization identity resolved from admin setup (Settings → System). Every
// generated document (invoices, payslips, tax invoices, WHT certificates,
// statements) defaults its company name from here, so a rebrand only needs the
// org name changed once in admin setup rather than edits across the codebase.

/** SystemSetting key holding the workspace-wide organization / brand name. */
export const APP_NAME_SETTING_KEY = "app.name";

/** Fallback org name used only when the `app.name` SystemSetting is unset. */
export const DEFAULT_ORG_NAME = "Manut";

/** Coerce a stored `app.name` value into a usable, trimmed org name. */
export function orgNameFromSetting(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return DEFAULT_ORG_NAME;
}
