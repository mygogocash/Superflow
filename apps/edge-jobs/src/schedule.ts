/**
 * The 20 scheduled jobs formerly in GCP Cloud Scheduler (docs/ops/cloud-scheduler-cron-jobs.md
 * + deploy.yml). ONE Cron Trigger fires every 10 minutes; `dueJobs()` returns the jobs
 * whose local (Asia/Bangkok) wall-clock schedule matches that tick.
 *
 * The GCP Cloud Scheduler project these were migrated from has been retired;
 * this list is now the source of truth for the schedule.
 */
export type JobName =
  | "expense-monthly-reminders" | "accounting-status" | "it-billing-reminders" | "crm-deadline-reminders"
  | "leave-escalation" | "fx-sync" | "stale-leads-digest" | "crm-email-sync" | "legal-expiry-digest"
  | "visa-expiry-reminders" | "ninety-day-reminders" | "sync-storage-snapshot" | "sync-telemetry"
  | "aria-knowledge-sync" | "aria-purge-pii" | "attendance-missed-checks" | "attendance-manager-alerts"
  | "aria-daily-brief" | "ow-snapshot-refresh" | "marketing-drift-check";

export type Schedule =
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "hourly"; minute: number }
  | { kind: "every"; minutes: number }
  | { kind: "monthly"; day: number; hour: number; minute: number };

/** Where the schedule comes from: `deploy.yml` (auto-provisioned) or the ops doc (hand-made in GCP). */
export type JobDef = { name: JobName; schedule: Schedule; source: "deploy.yml" | "docs/ops"; fanOut?: "per-item" };

export const JOBS: readonly JobDef[] = [
  { name: "sync-storage-snapshot", schedule: { kind: "daily", hour: 4, minute: 30 }, source: "deploy.yml" },
  { name: "aria-knowledge-sync", schedule: { kind: "daily", hour: 3, minute: 0 }, source: "deploy.yml", fanOut: "per-item" },
  { name: "aria-purge-pii", schedule: { kind: "daily", hour: 2, minute: 30 }, source: "deploy.yml" },
  { name: "expense-monthly-reminders", schedule: { kind: "monthly", day: 22, hour: 9, minute: 0 }, source: "deploy.yml" },
  { name: "it-billing-reminders", schedule: { kind: "daily", hour: 8, minute: 0 }, source: "docs/ops" },
  { name: "crm-deadline-reminders", schedule: { kind: "daily", hour: 8, minute: 0 }, source: "docs/ops" },
  { name: "accounting-status", schedule: { kind: "daily", hour: 8, minute: 0 }, source: "docs/ops" },
  { name: "marketing-drift-check", schedule: { kind: "daily", hour: 9, minute: 0 }, source: "docs/ops" },
  { name: "leave-escalation", schedule: { kind: "daily", hour: 8, minute: 30 }, source: "docs/ops" },
  { name: "stale-leads-digest", schedule: { kind: "daily", hour: 8, minute: 30 }, source: "docs/ops" },
  { name: "legal-expiry-digest", schedule: { kind: "daily", hour: 8, minute: 30 }, source: "docs/ops" },
  { name: "visa-expiry-reminders", schedule: { kind: "daily", hour: 8, minute: 30 }, source: "docs/ops" },
  { name: "ninety-day-reminders", schedule: { kind: "daily", hour: 8, minute: 30 }, source: "docs/ops" },
  { name: "attendance-missed-checks", schedule: { kind: "hourly", minute: 10 }, source: "docs/ops" },
  { name: "attendance-manager-alerts", schedule: { kind: "daily", hour: 10, minute: 0 }, source: "docs/ops" },
  { name: "aria-daily-brief", schedule: { kind: "hourly", minute: 0 }, source: "docs/ops", fanOut: "per-item" },
  { name: "ow-snapshot-refresh", schedule: { kind: "daily", hour: 6, minute: 0 }, source: "docs/ops" },
  { name: "fx-sync", schedule: { kind: "daily", hour: 7, minute: 0 }, source: "docs/ops" },
  { name: "sync-telemetry", schedule: { kind: "daily", hour: 5, minute: 0 }, source: "docs/ops", fanOut: "per-item" },
  { name: "crm-email-sync", schedule: { kind: "every", minutes: 10 }, source: "docs/ops", fanOut: "per-item" },
];

export type LocalTime = { year: number; month: number; day: number; hour: number; minute: number };

/** Wall-clock parts of `at` in `timeZone` (year, month, day, hour, minute). */
export function localTime(at: Date, timeZone: string): LocalTime {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? NaN);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

/** Jobs whose schedule matches this tick. Ticks arrive on 10-minute boundaries; minutes compare on the same grid. */
export function dueJobs(at: Date, timeZone: string, jobs: readonly JobDef[] = JOBS): JobDef[] {
  const t = localTime(at, timeZone);
  const grid = Math.floor(t.minute / 10) * 10;
  return jobs.filter(({ schedule: s }) => {
    switch (s.kind) {
      case "every": return t.minute % s.minutes === 0;
      case "hourly": return grid === s.minute;
      case "daily": return t.hour === s.hour && grid === s.minute;
      case "monthly": return t.day === s.day && t.hour === s.hour && grid === s.minute;
    }
  });
}

/** Idempotency key: one enqueue per job per tick bucket, deduped in KV by the scheduler. */
export function tickKey(name: JobName, at: Date, timeZone: string): string {
  const t = localTime(at, timeZone);
  const grid = Math.floor(t.minute / 10) * 10;
  // Use the *local* calendar date — UTC `toISOString().slice(0,10)` drifts near midnight in Asia/Bangkok.
  const ymd = `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
  return `job:${name}:${ymd}T${String(t.hour).padStart(2, "0")}${String(grid).padStart(2, "0")}`;
}
