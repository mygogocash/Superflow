import type { JobName } from "../schedule";
import type { Bindings } from "../index";
import { registerJob, type JobHandler } from "./index";

const ALL_JOBS: JobName[] = [
  "expense-monthly-reminders",
  "accounting-status",
  "it-billing-reminders",
  "crm-deadline-reminders",
  "leave-escalation",
  "fx-sync",
  "stale-leads-digest",
  "crm-email-sync",
  "legal-expiry-digest",
  "visa-expiry-reminders",
  "ninety-day-reminders",
  "sync-storage-snapshot",
  "sync-telemetry",
  "aria-knowledge-sync",
  "aria-purge-pii",
  "attendance-missed-checks",
  "attendance-manager-alerts",
  "aria-daily-brief",
  "ow-snapshot-refresh",
  "marketing-drift-check",
];

function httpCronHandler(name: JobName): JobHandler {
  return async (_msg, env) => {
    const base = env.EDGE_API_URL?.replace(/\/$/, "");
    // Match edge verifySharedSecret floor (32) so jobs never call with a short secret.
    if (!base || !env.CRON_SECRET || env.CRON_SECRET.length < 32) {
      throw new Error(
        "EDGE_API_URL and CRON_SECRET (>=32 chars) must be configured",
      );
    }
    const res = await fetch(`${base}/api/cron/${name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cron-Secret": env.CRON_SECRET,
      },
      body: "{}",
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Cron ${name} HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
  };
}

export function registerHttpCronHandlers() {
  for (const name of ALL_JOBS) {
    registerJob(name, httpCronHandler(name));
  }
}
