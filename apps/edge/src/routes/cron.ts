import { Hono } from "hono";
import { verifySharedSecret } from "@nexora/auth";
import { cronService } from "@nexora/core";
import type { AppEnv } from "../lib/context";
import { UnauthorizedException } from "../lib/errors";

function verifyCron(c: { req: { header: (n: string) => string | undefined }; env: AppEnv["Bindings"] }) {
  const provided =
    c.req.header("x-cron-secret") ??
    c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ??
    undefined;
  // Fail-closed: empty/short CRON_SECRET never authenticates (timing-safe compare).
  if (!verifySharedSecret(provided, c.env.CRON_SECRET)) {
    throw new UnauthorizedException(
      c.env.CRON_SECRET ? "Unauthorized" : "Cron not configured",
    );
  }
}

function mountJob(app: Hono<AppEnv>, name: string) {
  app.post(`/${name}`, async (c) => {
    verifyCron(c);
    const body = await c.req.json().catch(() => ({}));
    const data = await cronService.runJob(c.var.db, name, {
      BOT_API_CLIENT_ID: c.env.BOT_API_CLIENT_ID,
      BOT_API_BASE_URL: c.env.BOT_API_BASE_URL,
      BOT_FX_CURRENCIES: c.env.BOT_FX_CURRENCIES,
      BOT_FX_UNITS: c.env.BOT_FX_UNITS,
      FX_FALLBACK_ENABLED: c.env.FX_FALLBACK_ENABLED,
      FX_FALLBACK_API_KEY: c.env.FX_FALLBACK_API_KEY,
      FX_FALLBACK_BASE_URL: c.env.FX_FALLBACK_BASE_URL,
    }, body);
    return c.json({ data });
  });
}

export const cron = new Hono<AppEnv>();
for (const name of [
  "expense-monthly-reminders",
  "accounting-status",
  "it-billing-reminders",
  "crm-deadline-reminders",
  "it-crm-deadline-reminders",
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
] as const) {
  if (name === "it-crm-deadline-reminders") {
    cron.post("/it-crm-deadline-reminders", async (c) => {
      verifyCron(c);
      const body = await c.req.json().catch(() => ({}));
      const data = await cronService.runJob(c.var.db, "crm-deadline-reminders", {
        BOT_API_CLIENT_ID: c.env.BOT_API_CLIENT_ID,
        BOT_API_BASE_URL: c.env.BOT_API_BASE_URL,
        BOT_FX_CURRENCIES: c.env.BOT_FX_CURRENCIES,
        BOT_FX_UNITS: c.env.BOT_FX_UNITS,
        FX_FALLBACK_ENABLED: c.env.FX_FALLBACK_ENABLED,
        FX_FALLBACK_API_KEY: c.env.FX_FALLBACK_API_KEY,
        FX_FALLBACK_BASE_URL: c.env.FX_FALLBACK_BASE_URL,
      }, body);
      return c.json({ data });
    });
  } else {
    mountJob(cron, name);
  }
}
