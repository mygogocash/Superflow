import { type Request, Router } from "express";

import { asyncHandler } from "@/core/middleware/async-handler";
import { accountingService } from "@/modules/accounting/accounting.service";
import { syncCrmEmailsForAllUsers } from "@/modules/accounts/crm-email-sync.service";
import { storageSnapshotService } from "@/modules/admin/usage/storage-snapshot.service";
import { ariaService } from "@/modules/aria/aria.service";
import { runBriefDispatcher } from "@/modules/aria/aria-brief.service";
import { ariaTrainingService } from "@/modules/aria-training/aria-training.service";
import { processCrmDeadlineReminders } from "@/modules/crm-shared/crm-reminders";
import { botFxService } from "@/modules/exchange-rates/bot-fx.service";
import { expensesService } from "@/modules/expenses/expenses.service";
import { attendanceMissedService } from "@/modules/hrms/attendance-missed.service";
import { attendanceNotificationService } from "@/modules/hrms/attendance-notification.service";
import { processBillingReminders } from "@/modules/it-billing/it-billing.reminders";
import { leadService } from "@/modules/leads/leads.service";
import { leaveService } from "@/modules/leave/leave.service";
import { legalService } from "@/modules/legal/legal.service";
import { marketingService } from "@/modules/marketing/marketing.service";
import { runMarketingDriftCheck } from "@/modules/marketing-analytics/drift/drift.service";
import { ninetyDayService } from "@/modules/ninety-day/ninety-day.service";
import { telemetryService } from "@/modules/telemetry";
import { visaService } from "@/modules/visa/visa.service";

const router = Router();

function verifyCronSecret(provided: string | undefined): provided is string {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 8) return false;
  return provided === secret;
}

function readSecret(req: Request): string | undefined {
  return (
    req.header("x-cron-secret") ??
    req.header("authorization")?.replace(/^Bearer\s+/i, "") ??
    undefined
  );
}

// Monthly expense submission reminders — runs on the 22nd (Asia/Bangkok).
// Thailand employees get allowance copy; India and other entities get
// reimbursement copy. Skips users who already filed for the period.
// Schedule: `0 9 22 * *` in Asia/Bangkok. Body `{ "force": true }` bypasses
// the day guard for manual verification.
router.post(
  "/expense-monthly-reminders",
  asyncHandler(async (req, res) => {
    if (!verifyCronSecret(readSecret(req))) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const force =
      req.body &&
      typeof req.body === "object" &&
      (req.body as { force?: unknown }).force === true;
    const data = await expensesService.processMonthlySubmissionReminders({
      force,
    });
    res.json({ data });
  }),
);

// Accounting daily status check: auto-expire sent quotes past expiry, flag
// sent/partial invoices+bills past due as overdue. "Today" = Asia/Bangkok.
// Idempotent — safe to re-run. Schedule daily, e.g. `0 8 * * *`.
router.post(
  "/accounting-status",
  asyncHandler(async (req, res) => {
    if (!verifyCronSecret(readSecret(req))) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const data = await accountingService.runStatusChecks();
    res.json({ data });
  }),
);

// IT Operations billing reminders: renewal (30/15/7) + payment-due (7).
// Idempotent + debounced per subscription. Schedule daily, e.g. `0 8 * * *`.
router.post(
  "/it-billing-reminders",
  asyncHandler(async (req, res) => {
    if (!verifyCronSecret(readSecret(req))) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const data = await processBillingReminders();
    res.json({ data });
  }),
);

// CRM deadline reminders across every enabled board CRM (IT + Project + HR …):
// project go-live (30/14/7/1 + overdue) + task due dates (7/3/1 + overdue).
// Idempotent + debounced per row (reminders_sent). Schedule: `0 8 * * *`
// Asia/Bangkok. Safe to re-run. The legacy `/it-crm-deadline-reminders` path
// is kept as an alias so an already-provisioned Cloud Scheduler job keeps
// firing — both hit the same generalized worker.
const crmDeadlineReminderHandler = asyncHandler(async (req, res) => {
  if (!verifyCronSecret(readSecret(req))) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const data = await processCrmDeadlineReminders();
  res.json({ data });
});
router.post("/crm-deadline-reminders", crmDeadlineReminderHandler);
router.post("/it-crm-deadline-reminders", crmDeadlineReminderHandler);

router.post(
  "/leave-escalation",
  asyncHandler(async (req, res) => {
    if (!verifyCronSecret(readSecret(req))) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const data = await leaveService.processEscalationReminders();
    res.json({ data });
  }),
);

// Daily FX sync from Bank of Thailand → upserts <CUR>→THB exchange rates
// so the expense module can convert mixed-currency reports. No-op
// (configured: false) until BOT_API_CLIENT_ID is set. Schedule daily
// ~07:00 SGT (after BOT publishes the daily average). Idempotent.
router.post(
  "/fx-sync",
  asyncHandler(async (req, res) => {
    if (!verifyCronSecret(readSecret(req))) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const data = await botFxService.syncBotRates();
    await accountingService.syncAccountingFxRates(
      data.synced.map((row) => ({
        currency: row.currency,
        effectiveDate: new Date(`${row.period}T00:00:00.000Z`),
        buyingRate: row.buyingRate,
        sellingRate: row.sellingRate,
        source: row.source,
      })),
    );
    res.json({ data });
  }),
);

// PRD §11.3 follow-up — daily stale-lead digest. Caller schedules this
// once per day (e.g. Cloud Scheduler). The job sends one email per owner
// with at least one stale lead and returns counters for monitoring.
router.post(
  "/stale-leads-digest",
  asyncHandler(async (req, res) => {
    if (!verifyCronSecret(readSecret(req))) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const data = await leadService.processStaleLeadDigest();
    res.json({ data });
  }),
);

// Sales CRM email auto-sync (Sid + BD feedback, 2026-05-24). For every
// user with a connected Gmail account, scans messages newer than the
// per-user cursor, matches recipients against `Contact.email`, and
// logs a `CrmActivity` for each matched account. Idempotent via
// `CrmActivity.externalRef` unique constraint. Recommended schedule:
// every 10 min in Asia/Bangkok.
router.post(
  "/crm-email-sync",
  asyncHandler(async (req, res) => {
    if (!verifyCronSecret(readSecret(req))) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const data = await syncCrmEmailsForAllUsers();
    res.json({ data });
  }),
);

// Daily legal-document expiry digest. Caller schedules this once per
// day. Job sends one email per owner with all of their soon-to-expire
// docs grouped together; counters returned for monitoring.
router.post(
  "/legal-expiry-digest",
  asyncHandler(async (req, res) => {
    if (!verifyCronSecret(readSecret(req))) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const data = await legalService.processExpiryDigest();
    res.json({ data });
  }),
);

// Daily visa + work-permit expiry reminders (90-day window). Caller
// schedules this once per day (e.g. Cloud Scheduler at 08:00 SGT). The
// job emails the employee for each active visa_record whose visa or
// work permit will expire within the window; rows are stamped with
// `last_reminder_sent_at` so repeat runs don't double-send within the
// cooldown period. Optional `VISA_REMINDER_CC` carbon-copies HR.
router.post(
  "/visa-expiry-reminders",
  asyncHandler(async (req, res) => {
    if (!verifyCronSecret(readSecret(req))) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const data = await visaService.processExpiryReminders();
    res.json({ data });
  }),
);

// Daily 90-day immigration (TM.47) reminders. Fires at T-21 / T-15
// before the 90-day mark and once during the T+7 final report window.
// Schedule via Cloud Scheduler at 08:00 SGT, same cadence as the visa
// expiry cron above.
router.post(
  "/ninety-day-reminders",
  asyncHandler(async (req, res) => {
    if (!verifyCronSecret(readSecret(req))) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const data = await ninetyDayService.dispatchReminders();
    res.json({ data });
  }),
);

// Daily Supabase Storage snapshot — walks every bucket, sums object sizes,
// writes one row per bucket into `storage_snapshots`. The Workspace Usage
// admin screen reads the latest row per bucket so dashboards stay cheap.
// Schedule via Cloud Scheduler at quiet hours (e.g. 04:30 SGT — after the
// PostHog sync).
router.post(
  "/sync-storage-snapshot",
  asyncHandler(async (req, res) => {
    if (!verifyCronSecret(readSecret(req))) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const data = await storageSnapshotService.refresh();
    res.json({ data });
  }),
);

// Daily PostHog snapshot sync — refreshes person/group traits with rolling
// 30-day counts. Schedule via Cloud Scheduler at quiet hours (e.g. 04:00 SGT).
router.post(
  "/sync-telemetry",
  asyncHandler(async (req, res) => {
    if (!verifyCronSecret(readSecret(req))) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const data = await telemetryService.runSnapshotSync();
    res.json({ data });
  }),
);

// Phase 4 — daily auto-sync of operational tables into the ARIA
// knowledge corpus. Pulls active leave types, public holidays,
// partners, projects, and company policies, upserts one
// `aria_knowledge_articles` row per source row, and soft-deactivates
// orphans. Idempotent — safe to retry. Schedule alongside the other
// nightly crons (e.g. 03:00 SGT).
router.post(
  "/aria-knowledge-sync",
  asyncHandler(async (req, res) => {
    if (!verifyCronSecret(readSecret(req))) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const data = await ariaService.runKnowledgeSync();
    res.json(data);
  }),
);

// Daily PII redaction on `aria_query_logs.user_message`. Retention
// window is `ARIA_PII_RETENTION_DAYS` (defaults to 30 per CLAUDE.md).
// Idempotent — rows already carrying the sentinel are skipped via
// the `NOT user_message = sentinel` filter. Schedule daily at quiet
// hours (e.g. 02:30 SGT, between the visa cron and the knowledge
// sync cron).
router.post(
  "/aria-purge-pii",
  asyncHandler(async (req, res) => {
    if (!verifyCronSecret(readSecret(req))) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const data = await ariaService.runPiiPurge();
    res.json(data);
  }),
);

// Daily PII redaction of interaction traces (training-data substrate).
// Pseudonymizes emails/phones/ids in place and flips pii_redacted once a
// trace is older than ARIA_TRACE_REDACT_AFTER_DAYS (default 7). Idempotent —
// already-redacted rows are excluded. Schedule daily alongside the other
// ARIA maintenance crons.
router.post(
  "/aria-redact-traces",
  asyncHandler(async (req, res) => {
    if (!verifyCronSecret(readSecret(req))) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const data = await ariaTrainingService.runTraceRedaction();
    res.json(data);
  }),
);

// Missed check-in/out, consecutive absences, and manager attendance alerts.
// Schedule hourly or after shift start (e.g. 10:00 and 19:00 local).
router.post(
  "/attendance-missed-checks",
  asyncHandler(async (req, res) => {
    if (!verifyCronSecret(readSecret(req))) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const data = await attendanceMissedService.runMissedAttendanceChecks();
    res.json({ data });
  }),
);

// Daily attendance manager alerts (late arrivals, pending corrections,
// high absenteeism). Schedule once per day after shift start (e.g. 10:00).
router.post(
  "/attendance-manager-alerts",
  asyncHandler(async (req, res) => {
    if (!verifyCronSecret(readSecret(req))) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    await attendanceNotificationService.runDailyManagerAlerts();
    res.json({ data: { ok: true } });
  }),
);

// Phase 8 — proactive daily brief. Cloud Scheduler hits this once per
// hour; the dispatcher filters subscribers by their local hour, so a
// user opted into 07:00 Asia/Bangkok and a user opted into 07:00
// Asia/Kolkata both get one brief at 07:00 of their respective
// timezones from a single hourly cron. Idempotent — a same-day re-run
// no-ops on the (user_id, delivered_on) unique key.
router.post(
  "/aria-daily-brief",
  asyncHandler(async (req, res) => {
    if (!verifyCronSecret(readSecret(req))) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const data = await runBriefDispatcher();
    // Surface a non-2xx when the whole batch failed so Cloud Scheduler
    // (or whatever's calling) raises an alert instead of swallowing
    // it. "Some errored but some delivered" stays as 200 because
    // partial success is still useful work, and `errors` in the
    // payload tells the operator what to dig into.
    const totalFailure =
      data.errors > 0 && data.delivered === 0 && data.skippedEmpty === 0;
    if (totalFailure) {
      res.status(500).json({ data, error: "All brief deliveries failed" });
      return;
    }
    if (data.errors > 0) {
      // Partial-failure visibility — surfaces in Cloud Logging without
      // tripping the 5xx alert.
      const { logger } = await import("@/common/utils/logger");
      logger.warn("ARIA brief dispatcher had per-user errors", { ...data });
    }
    res.json({ data });
  }),
);

// OneWave holistic dashboard (P1) — re-ingest the multi-tab OW2.0 sheet
// into normalized ow_daily_metrics + a fresh ow_snapshots row. Idempotent
// (upsert on (date,telco)). Schedule a few times/day (refresh cadence TBC
// with marketing); the dashboard also self-refreshes past its TTL.
router.post(
  "/ow-snapshot-refresh",
  asyncHandler(async (req, res) => {
    if (!verifyCronSecret(readSecret(req))) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const data = await marketingService.refreshSnapshot();
    res.json({ data });
  }),
);

// DAU/MAU drift check — audits that the two readers of BNII still agree.
// `/marketing-analytics/dau-mau` queries the API live and persists nothing,
// while the OneWave dashboard reads ow_daily_metrics written by the snapshot
// cron above; nothing previously compared them, so a missed run or an upstream
// restatement could leave the two pages disagreeing about the same day.
// Read-only apart from the alert-debounce fingerprint, so re-runs are safe.
// Schedule: `0 9 * * *` Asia/Bangkok — after the 08:00 reminder jobs.
// Body accepts `{ "force": true }` to re-send an unchanged alert,
// `{ "dryRun": true }` to report without emailing, and `{ "today": "YYYY-MM-DD" }`
// to audit a historical window.
router.post(
  "/marketing-drift-check",
  asyncHandler(async (req, res) => {
    if (!verifyCronSecret(readSecret(req))) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const body = (req.body ?? {}) as {
      force?: unknown;
      dryRun?: unknown;
      today?: unknown;
      days?: unknown;
    };
    const data = await runMarketingDriftCheck({
      force: body.force === true,
      dryRun: body.dryRun === true,
      ...(typeof body.today === "string" ? { today: body.today } : {}),
      ...(typeof body.days === "number" ? { days: body.days } : {}),
    });
    res.json({ data });
  }),
);

export default router;
