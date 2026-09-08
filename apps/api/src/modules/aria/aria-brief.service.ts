/**
 * ARIA proactive daily brief (#8).
 *
 * Builds a per-user morning summary by running section builders in
 * parallel against existing services and Prisma. Crucially, the
 * builder is **deterministic and LLM-free** — every brief is a
 * function of the caller's data + perms at delivery time. The LLM
 * only enters the picture when the user opens the brief in chat and
 * asks a follow-up.
 *
 * Cost model:
 *   build cost    = N Prisma queries + 1 Google Calendar fetch
 *   delivery cost = 1 email-service send + 1 row insert
 *   LLM cost      = 0 (the follow-up Q&A goes through the normal
 *                     `runAssistantTurn` path and counts against that)
 *
 * Sections are surfaced as discrete `BriefSection` objects so the FE
 * can render them in any layout — the markdown view, the inbox card,
 * or a future Slack adapter — without re-walking the rendering tree.
 */
import { PERMISSIONS } from "@/common/constants/permissions";
import { logger } from "@/common/utils/logger";
import { loadUserPermissions } from "@/core/guards/auth.guard";
import { prisma } from "@/infrastructure/database/prisma";
import { sendEmail } from "@/infrastructure/email/email.service";
import { googleTokenRepository } from "@/modules/integrations/google-token.repository";

export interface BriefSection {
  /** Stable id for FE filtering and subscription `sections` allowlist. */
  id:
    | "calendar"
    | "approvals"
    | "leave-balance"
    | "expiring-visas"
    | "pipeline"
    | "helpdesk-mine";
  /** Display title shown above the section. */
  title: string;
  /** Short one-line summary, e.g. "3 items need approval". */
  headline: string;
  /** Number of items inside — used for `totalAttention` rollup and inbox badge. */
  count: number;
  /** Markdown body. Already includes any `aria-*` fenced blocks. */
  markdown: string;
  /** Optional deep-link the FE renders as "Open". */
  href?: string;
}

export interface BriefPayload {
  /** Server-side generation timestamp (UTC ISO). */
  generatedAt: string;
  /** Calendar date in the user's timezone (yyyy-mm-dd). */
  deliveredOn: string;
  /** Empty sections are dropped before reaching here. */
  sections: BriefSection[];
  /** Sum of section.count; FE uses this for the unread badge. */
  totalAttention: number;
}

interface BuildContext {
  userId: string;
  perms: Set<string>;
  timezone: string;
  /** Allowlist of section ids; empty means "every section the user qualifies for". */
  sectionFilter: Set<string>;
}

const DEFAULT_SECTIONS: BriefSection["id"][] = [
  "calendar",
  "approvals",
  "leave-balance",
  "expiring-visas",
  "pipeline",
  "helpdesk-mine",
];

/**
 * Returns the calendar date (yyyy-mm-dd) in the caller's timezone.
 * Used for the idempotency unique key on `ManutAiBriefDelivery`.
 */
function localDate(timezone: string, when: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(when); // en-CA emits YYYY-MM-DD
}

/**
 * Build the brief for a user. Caller is responsible for confirming
 * the user has `aria:brief-subscribe`; this function trusts that gate.
 *
 * Returns `null` when every section is empty — the cron uses this to
 * skip delivery entirely (no "you have nothing waiting" email noise).
 */
export async function buildBrief(args: {
  userId: string;
  timezone: string;
  sectionFilter?: readonly string[];
}): Promise<BriefPayload | null> {
  const perms = new Set(await loadUserPermissions(args.userId));
  const filter = new Set(args.sectionFilter ?? []);
  const ctx: BuildContext = {
    userId: args.userId,
    perms,
    timezone: args.timezone,
    sectionFilter: filter,
  };

  // Run every builder in parallel — each one is independent and any
  // single failure should not poison the others.
  const results = await Promise.allSettled([
    buildCalendarSection(ctx),
    buildApprovalsSection(ctx),
    buildLeaveBalanceSection(ctx),
    buildExpiringVisasSection(ctx),
    buildPipelineSection(ctx),
    buildHelpdeskMineSection(ctx),
  ]);

  const sections: BriefSection[] = [];
  for (const result of results) {
    if (result.status === "rejected") {
      logger.warn("ARIA brief section failed", { err: result.reason });
      continue;
    }
    if (result.value && result.value.count > 0) {
      sections.push(result.value);
    }
  }

  if (sections.length === 0) {
    return null;
  }

  return {
    generatedAt: new Date().toISOString(),
    deliveredOn: localDate(args.timezone),
    sections,
    totalAttention: sections.reduce((acc, s) => acc + s.count, 0),
  };
}

function shouldInclude(ctx: BuildContext, id: BriefSection["id"]): boolean {
  if (ctx.sectionFilter.size === 0) return true;
  return ctx.sectionFilter.has(id);
}

// ── Section: calendar (today) ───────────────────────────────────────

interface GoogleCalendarEvent {
  id: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  htmlLink?: string;
  attendees?: { responseStatus?: string }[];
}

async function buildCalendarSection(
  ctx: BuildContext,
): Promise<BriefSection | null> {
  if (!shouldInclude(ctx, "calendar")) return null;
  if (!ctx.perms.has(PERMISSIONS.INTEGRATIONS_USE)) return null;

  let token: string;
  try {
    const { accessToken } = await googleTokenRepository.getValid(ctx.userId);
    token = accessToken;
  } catch {
    // Either not connected or token refresh failed. Skip silently —
    // the user reconnects via the settings page, and the brief should
    // not error-shout at them every morning.
    return null;
  }

  const dayStart = startOfLocalDay(ctx.timezone);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

  const params = new URLSearchParams({
    timeMin: dayStart.toISOString(),
    timeMax: dayEnd.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "25",
  });
  let events: GoogleCalendarEvent[] = [];
  try {
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { items?: GoogleCalendarEvent[] };
    events = (body.items ?? []).filter(
      (e) => !e.attendees?.some((a) => a.responseStatus === "declined"),
    );
  } catch (err) {
    logger.warn("ARIA brief calendar fetch failed", { err });
    return null;
  }

  if (events.length === 0) return null;

  const rows = events.slice(0, 8).map((e) => {
    const start =
      e.start?.dateTime ?? (e.start?.date ? `${e.start.date} (all day)` : "?");
    const hhmm = formatLocalTime(start, ctx.timezone);
    return `- ${hhmm} — ${e.summary ?? "(no title)"}`;
  });

  return {
    id: "calendar",
    title: "Today's calendar",
    headline: `${events.length} event${events.length === 1 ? "" : "s"} on your calendar`,
    count: events.length,
    markdown: rows.join("\n"),
    href: "https://calendar.google.com/",
  };
}

function startOfLocalDay(timezone: string): Date {
  // Get the local yyyy-mm-dd, then treat it as midnight in that tz by
  // formatting back. There is no native "give me UTC instant of local
  // midnight" so we round-trip through Intl.
  const day = localDate(timezone);
  // Build a Date in UTC at 00:00 of that day, then offset by the tz
  // shift at that moment. Good enough — DST gaps shift the brief by an
  // hour at worst, which is invisible to users.
  const utcMidnight = new Date(`${day}T00:00:00Z`);
  const tzOffsetMs = utcMidnight.getTime() - tzInstantAt(day, timezone);
  return new Date(utcMidnight.getTime() + tzOffsetMs);
}

function tzInstantAt(day: string, timezone: string): number {
  // Use the timezone's offset at noon (avoids DST boundary midnights).
  const probe = new Date(`${day}T12:00:00Z`);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = fmt.formatToParts(probe);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc;
}

function formatLocalTime(iso: string, timezone: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(d);
  } catch {
    return iso;
  }
}

// ── Section: pending approvals ──────────────────────────────────────

async function buildApprovalsSection(
  ctx: BuildContext,
): Promise<BriefSection | null> {
  if (!shouldInclude(ctx, "approvals")) return null;

  const [leave, travel, expense] = await Promise.all([
    prisma.leaveApprovalDecision.findMany({
      where: {
        status: "pending",
        approverUserId: ctx.userId,
        leaveRequest: { status: "pending" },
      },
      select: {
        leaveRequest: {
          select: {
            startDate: true,
            endDate: true,
            employee: { select: { name: true } },
          },
        },
      },
      take: 5,
    }),
    prisma.travelApprovalDecision.findMany({
      where: {
        status: "pending",
        approverUserId: ctx.userId,
        travelRequest: { status: "pending" },
      },
      select: {
        travelRequest: {
          select: {
            destination: true,
            departureDate: true,
            employee: { select: { name: true } },
          },
        },
      },
      take: 5,
    }),
    prisma.expenseApprovalDecision.findMany({
      where: {
        status: "pending",
        approverUserId: ctx.userId,
        expenseReport: { status: "submitted" },
      },
      select: {
        expenseReport: {
          select: {
            title: true,
            period: true,
            employee: { select: { name: true } },
          },
        },
      },
      take: 5,
    }),
  ]);

  const total = leave.length + travel.length + expense.length;
  if (total === 0) return null;

  const lines: string[] = [];
  for (const row of leave) {
    const r = row.leaveRequest;
    lines.push(
      `- **Leave** — ${r.employee.name}, ${fmtDate(r.startDate)}→${fmtDate(r.endDate)}`,
    );
  }
  for (const row of travel) {
    const r = row.travelRequest;
    lines.push(
      `- **Travel** — ${r.employee.name} to ${r.destination} (${fmtDate(r.departureDate)})`,
    );
  }
  for (const row of expense) {
    const r = row.expenseReport;
    lines.push(`- **Expense** — ${r.employee.name}: ${r.title} (${r.period})`);
  }

  return {
    id: "approvals",
    title: "Pending your approval",
    headline: `${total} item${total === 1 ? "" : "s"} need approval`,
    count: total,
    markdown: lines.join("\n"),
    href: "/dashboard?tab=approvals",
  };
}

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "?";
  const dt = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(dt.getTime())) return String(d);
  return dt.toISOString().slice(0, 10);
}

// ── Section: my leave balance ───────────────────────────────────────

async function buildLeaveBalanceSection(
  ctx: BuildContext,
): Promise<BriefSection | null> {
  if (!shouldInclude(ctx, "leave-balance")) return null;
  if (!ctx.perms.has(PERMISSIONS.LEAVE_READ)) return null;

  // Surface balance only on Mondays. Daily nagging about leave balance
  // is noise; once a week is informative.
  const localDow = new Intl.DateTimeFormat("en-US", {
    timeZone: ctx.timezone,
    weekday: "short",
  }).format(new Date());
  if (localDow !== "Mon") return null;

  const balances = await prisma.leaveBalance.findMany({
    where: { employeeId: ctx.userId, year: new Date().getFullYear() },
    select: {
      entitled: true,
      used: true,
      carried: true,
      carriedUsed: true,
      adjustment: true,
      leaveType: { select: { name: true } },
    },
  });
  if (balances.length === 0) return null;

  const lines = balances.map((b) => {
    // LeaveBalance is split across entitled/carried with separate used
    // counters per bucket plus an HR adjustment column. Brief surfaces
    // a single remaining number to keep the morning view scannable.
    const total = Number(b.entitled) + Number(b.carried) + Number(b.adjustment);
    const used = Number(b.used) + Number(b.carriedUsed);
    const remaining = total - used;
    return `- ${b.leaveType.name}: **${remaining}** / ${total} days remaining`;
  });

  return {
    id: "leave-balance",
    title: "Your leave balance",
    headline: "Weekly leave snapshot",
    count: balances.length,
    markdown: lines.join("\n"),
    href: "/my-portal/leave",
  };
}

// ── Section: expiring visas (HR-only) ───────────────────────────────

async function buildExpiringVisasSection(
  ctx: BuildContext,
): Promise<BriefSection | null> {
  if (!shouldInclude(ctx, "expiring-visas")) return null;
  if (
    !ctx.perms.has(PERMISSIONS.VISA_HR_READ) &&
    !ctx.perms.has(PERMISSIONS.VISA_MANAGE)
  ) {
    return null;
  }
  const horizon = new Date();
  horizon.setDate(horizon.getDate() + 30);
  const rows = await prisma.visaRecord.findMany({
    where: { expiryDate: { gte: new Date(), lte: horizon } },
    select: {
      expiryDate: true,
      country: true,
      visaType: true,
      holderName: true,
    },
    orderBy: { expiryDate: "asc" },
    take: 10,
  });
  if (rows.length === 0) return null;

  const lines = rows.map(
    (r) =>
      `- ${fmtDate(r.expiryDate)} — ${r.holderName ?? "(unknown)"} (${r.country}, ${r.visaType})`,
  );

  return {
    id: "expiring-visas",
    title: "Visas expiring in 30 days",
    headline: `${rows.length} visa${rows.length === 1 ? "" : "s"} expiring soon`,
    count: rows.length,
    markdown: lines.join("\n"),
    href: "/hrms/visa",
  };
}

// ── Section: BD pipeline (closing this week) ────────────────────────

async function buildPipelineSection(
  ctx: BuildContext,
): Promise<BriefSection | null> {
  if (!shouldInclude(ctx, "pipeline")) return null;
  if (!ctx.perms.has(PERMISSIONS.CRM_READ)) return null;

  const today = new Date();
  const horizon = new Date(today);
  horizon.setDate(horizon.getDate() + 7);

  const rows = await prisma.opportunity.findMany({
    where: {
      ownerId: ctx.userId,
      closeDate: { gte: today, lte: horizon },
      stage: { notIn: ["closed_won", "closed_lost"] },
    },
    select: {
      id: true,
      name: true,
      value: true,
      currency: true,
      stage: true,
      closeDate: true,
      account: { select: { name: true } },
    },
    orderBy: { closeDate: "asc" },
    take: 10,
  });
  if (rows.length === 0) return null;

  const lines = rows.map(
    (o) =>
      `- ${fmtDate(o.closeDate)} — **${o.name}** (${o.account.name}) · ${o.currency} ${Number(o.value).toLocaleString()} · _${o.stage}_`,
  );

  return {
    id: "pipeline",
    title: "Pipeline closing this week",
    headline: `${rows.length} opportunit${rows.length === 1 ? "y" : "ies"} due in 7 days`,
    count: rows.length,
    markdown: lines.join("\n"),
    href: "/sales-crm/opportunities",
  };
}

// ── Section: helpdesk tickets assigned to me ────────────────────────

async function buildHelpdeskMineSection(
  ctx: BuildContext,
): Promise<BriefSection | null> {
  if (!shouldInclude(ctx, "helpdesk-mine")) return null;
  // IT staff get `it:read-all` or `it:assign`; everyone else has only
  // `it:read` (their own tickets) so the assignee filter naturally
  // empties for non-IT users. We still gate so we don't run the query
  // for users with no IT perms at all.
  if (
    !ctx.perms.has(PERMISSIONS.IT_READ_ALL) &&
    !ctx.perms.has(PERMISSIONS.IT_ASSIGN)
  ) {
    return null;
  }
  const rows = await prisma.helpdeskTicket.findMany({
    where: {
      assigneeId: ctx.userId,
      status: { in: ["open", "in-progress", "review"] },
    },
    select: {
      id: true,
      title: true,
      status: true,
      priority: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: "desc" },
    take: 8,
  });
  if (rows.length === 0) return null;

  const lines = rows.map(
    (t) => `- **${t.priority}** · ${t.title} _(${t.status})_`,
  );

  return {
    id: "helpdesk-mine",
    title: "IT tickets assigned to you",
    headline: `${rows.length} open ticket${rows.length === 1 ? "" : "s"}`,
    count: rows.length,
    markdown: lines.join("\n"),
    href: "/helpdesk",
  };
}

// ── Markdown render (entry-point for in-app + email) ────────────────

/**
 * Renders a `BriefPayload` to a single markdown blob. Used for the
 * opening message of the brief conversation and as the body of the
 * email. FE can ignore this and re-render from `sections` directly for
 * a richer layout.
 */
export function renderBriefMarkdown(payload: BriefPayload): string {
  const header = `# Your brief — ${payload.deliveredOn}`;
  const intro =
    payload.totalAttention === 0
      ? "_Nothing pressing on your plate today._"
      : `_${payload.totalAttention} item${payload.totalAttention === 1 ? "" : "s"} need your attention._`;
  const body = payload.sections
    .map(
      (s) =>
        `## ${s.title}\n${s.headline}\n\n${s.markdown}` +
        (s.href ? `\n\n[Open →](${s.href})` : ""),
    )
    .join("\n\n");
  return `${header}\n\n${intro}\n\n${body}`;
}

/** Exposed for the section allowlist UI on the settings page. */
export const BRIEF_SECTION_IDS: readonly BriefSection["id"][] =
  DEFAULT_SECTIONS;

// ── Delivery ────────────────────────────────────────────────────────

export type BriefChannel = "in_app" | "email";

export interface DeliverBriefArgs {
  userId: string;
  payload: BriefPayload;
  channels: BriefChannel[];
  /** Email address; required when "email" is in `channels`. */
  email?: string;
  /** Display name used to address the user in the email greeting. */
  displayName?: string;
}

export interface DeliverBriefResult {
  /** Maps each requested channel to "ok" | "skipped:<reason>" | "error:<code>". */
  channelStatus: Record<string, string>;
  conversationId: string;
  deliveryId: string;
}

/**
 * Persist a brief and push it to the configured channels. Idempotent
 * per (userId, deliveredOn) — a second call inside the same calendar
 * day no-ops by returning the existing delivery row.
 *
 * Conversation strategy: we always create a *fresh* ManutAiConversation
 * per brief rather than appending to a long-running "Brief inbox"
 * conversation. That keeps each day's follow-up Q&A scoped to its own
 * context window so yesterday's pipeline noise doesn't leak into
 * today's calendar question.
 */
export async function deliverBrief(
  args: DeliverBriefArgs,
): Promise<DeliverBriefResult> {
  const { userId, payload, channels } = args;

  // Reserve the delivery row FIRST. The unique `(userId, deliveredOn)`
  // constraint is our only atomic dedupe gate — two concurrent cron
  // ticks could both pass a `findUnique` check, both fire the email,
  // and both create orphan conversations before either hit the row
  // insert. Inserting first means only one tick wins; the other gets
  // P2002 from Postgres and we fast-path to the "already delivered"
  // branch without any side effects.
  let delivery: { id: string };
  try {
    delivery = await prisma.manutAiBriefDelivery.create({
      data: {
        userId,
        deliveredOn: payload.deliveredOn,
        payloadJson: payload as unknown as object,
        // Channels rewritten after sends so a partial-failure call can
        // be re-run. Start empty; populate as each channel finishes.
        channelStatus: {},
      },
      select: { id: true },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return alreadyDeliveredResult(userId, payload, channels);
    }
    throw err;
  }

  const markdown = renderBriefMarkdown(payload);

  // In-app delivery is unconditional: even if the user has email
  // disabled we still want a chat thread waiting for them. Otherwise
  // an empty inbox masks the fact that the brief ran at all.
  const conversation = await prisma.manutAiConversation.create({
    data: {
      userId,
      title: briefTitleFor(payload.deliveredOn),
    },
    select: { id: true },
  });
  await prisma.manutAiMessage.create({
    data: {
      conversationId: conversation.id,
      role: "assistant",
      content: markdown,
      // Metadata lets the FE render the brief inbox card without
      // re-parsing the markdown body. Sections are duplicated here
      // because the FE may want richer rendering than markdown alone.
      // Cast through `unknown` because Prisma's `InputJsonValue` chokes
      // on TS interface arrays (it wants index signatures) but the
      // shape is plain-JSON and round-trips fine.
      metadata: {
        kind: "brief",
        deliveredOn: payload.deliveredOn,
        totalAttention: payload.totalAttention,
        sections: payload.sections,
      } as unknown as object,
    },
  });

  const channelStatus: Record<string, string> = { in_app: "ok" };

  if (channels.includes("email")) {
    if (!args.email) {
      channelStatus.email = "skipped:no_email";
    } else {
      try {
        await sendEmail({
          to: args.email,
          templateId: "aria-brief-email",
          variables: {
            displayName: args.displayName ?? "",
            totalAttention: payload.totalAttention,
            deliveredOn: payload.deliveredOn,
            sectionsHtml: briefSectionsHtml(payload),
            settingsUrl: absoluteUrl("/settings/aria"),
          },
        });
        channelStatus.email = "ok";
      } catch (err) {
        logger.error("ARIA brief email send failed", { err, userId });
        channelStatus.email = "error:send_failed";
      }
    }
  }

  // Persist the resolved channel status on the row we reserved.
  await prisma.manutAiBriefDelivery.update({
    where: { id: delivery.id },
    data: { channelStatus },
  });

  await prisma.manutAiBriefSubscription.update({
    where: { userId },
    data: { lastDeliveredAt: new Date() },
  });

  return {
    channelStatus,
    conversationId: conversation.id,
    deliveryId: delivery.id,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: string }).code === "P2002"
  );
}

async function alreadyDeliveredResult(
  userId: string,
  payload: BriefPayload,
  channels: BriefChannel[],
): Promise<DeliverBriefResult> {
  const existing = await prisma.manutAiBriefDelivery.findUnique({
    where: {
      userId_deliveredOn: { userId, deliveredOn: payload.deliveredOn },
    },
    select: { id: true },
  });
  const conv = await prisma.manutAiConversation.findFirst({
    where: {
      userId,
      title: { startsWith: briefTitleFor(payload.deliveredOn) },
    },
    select: { id: true },
    orderBy: { createdAt: "desc" },
  });
  return {
    channelStatus: Object.fromEntries(
      channels.map((c) => [c, "skipped:already_delivered"]),
    ),
    conversationId: conv?.id ?? "",
    deliveryId: existing?.id ?? "",
  };
}

function briefTitleFor(deliveredOn: string): string {
  return `Daily brief — ${deliveredOn}`;
}

/**
 * Render section fragments for the external email template.
 */
function briefSectionsHtml(payload: BriefPayload): string {
  return payload.sections
    .map((s) => {
      const body = mdToBasicHtml(s.markdown);
      const link = s.href
        ? `<p><a href="${escapeAttr(absoluteUrl(s.href))}">Open →</a></p>`
        : "";
      return `<h3 style="margin:24px 0 4px;font:600 16px/1.3 sans-serif;color:#111">${escapeHtml(s.title)}</h3>
              <p style="margin:0 0 8px;color:#444;font:14px/1.4 sans-serif">${escapeHtml(s.headline)}</p>
              <div style="font:14px/1.5 sans-serif;color:#222">${body}</div>
              ${link}`;
    })
    .join("");
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]!,
  );
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function absoluteUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const base =
    process.env.WEB_BASE_URL ?? "https://manut.xyz";
  return `${base.replace(/\/$/, "")}${path}`;
}

/**
 * Very small markdown-to-HTML pass. We only emit a handful of markdown
 * features in section bodies (bullet lists, `**bold**`, `_italic_`)
 * so a full parser is overkill. Anything richer ships verbatim — most
 * email clients tolerate raw newlines inside `<div>`.
 */
// ── Subscription + inbox accessors ──────────────────────────────────

/**
 * Read-through subscription accessor. If the user has never touched
 * their preferences we return the row that the cron would use today —
 * built from defaults — but we do NOT persist it. The first explicit
 * write is what materialises the row. This means an unsubscribed user
 * can still see "you would receive a brief at 07:00 Asia/Bangkok"
 * without us writing a row for every employee on first chat.
 */
export async function getBriefSubscription(userId: string) {
  const existing = await prisma.manutAiBriefSubscription.findUnique({
    where: { userId },
  });
  if (existing) return { ...existing, virtual: false };

  // Synthesise the default row. `timezone` falls back to the user's
  // own column when present so India / Vietnam staff don't get a
  // Thailand default.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  return {
    userId,
    enabled: true,
    hourLocal: 7,
    timezone: user?.timezone ?? "Asia/Bangkok",
    channels: ["in_app", "email"],
    sections: [] as string[],
    weekdaysOnly: false,
    lastDeliveredAt: null as Date | null,
    createdAt: null as Date | null,
    updatedAt: null as Date | null,
    virtual: true,
  };
}

export async function upsertBriefSubscription(
  userId: string,
  patch: Partial<{
    enabled: boolean;
    hourLocal: number;
    timezone: string;
    channels: string[];
    sections: string[];
    weekdaysOnly: boolean;
  }>,
) {
  // Upsert (rather than update-only) so the first PATCH from an
  // unsubscribed user creates the row instead of 404-ing.
  const updated = await prisma.manutAiBriefSubscription.upsert({
    where: { userId },
    create: {
      userId,
      enabled: patch.enabled ?? true,
      hourLocal: patch.hourLocal ?? 7,
      timezone: patch.timezone ?? "Asia/Bangkok",
      channels: patch.channels ?? ["in_app", "email"],
      sections: patch.sections ?? [],
      weekdaysOnly: patch.weekdaysOnly ?? false,
    },
    update: patch,
  });
  return { ...updated, virtual: false };
}

export async function listBriefDeliveries(userId: string, limit: number) {
  return prisma.manutAiBriefDelivery.findMany({
    where: { userId },
    orderBy: { generatedAt: "desc" },
    take: limit,
    select: {
      id: true,
      deliveredOn: true,
      generatedAt: true,
      payloadJson: true,
      channelStatus: true,
    },
  });
}

// ── Cron dispatcher ─────────────────────────────────────────────────

export interface CronRunSummary {
  /** Subscriber rows considered for this hourly tick. */
  considered: number;
  /** Subscribers whose local hour matched and were built. */
  built: number;
  /** Builds that produced sections and were actually delivered. */
  delivered: number;
  /** Subscribers skipped because their brief was empty. */
  skippedEmpty: number;
  /** Subscribers skipped because they were already delivered today. */
  skippedAlreadyDelivered: number;
  /** Subscribers where the build / delivery threw. */
  errors: number;
}

/**
 * Hourly cron entry-point. Iterates every enabled subscription whose
 * local hour matches the current local hour in their timezone and
 * fires a build + deliver for each. Errors are isolated per user —
 * one bad subscription does not poison the rest of the batch.
 */
export async function runBriefDispatcher(
  now: Date = new Date(),
): Promise<CronRunSummary> {
  const summary: CronRunSummary = {
    considered: 0,
    built: 0,
    delivered: 0,
    skippedEmpty: 0,
    skippedAlreadyDelivered: 0,
    errors: 0,
  };

  // We fetch ALL enabled subscriptions up front and filter in JS by
  // timezone-local hour. Counts are small (hundreds at most) and the
  // alternative — a SQL query per timezone — would race against
  // Postgres' timezone catalog if we ever add an unknown zone.
  const subs = await prisma.manutAiBriefSubscription.findMany({
    where: { enabled: true },
    select: {
      userId: true,
      hourLocal: true,
      timezone: true,
      channels: true,
      sections: true,
      weekdaysOnly: true,
      user: { select: { email: true, name: true } },
    },
  });

  for (const sub of subs) {
    summary.considered++;

    const localHour = currentLocalHour(sub.timezone, now);
    if (localHour !== sub.hourLocal) continue;

    if (sub.weekdaysOnly && isLocalWeekend(sub.timezone, now)) continue;

    try {
      const payload = await buildBrief({
        userId: sub.userId,
        timezone: sub.timezone,
        sectionFilter: sub.sections,
      });
      summary.built++;
      if (!payload) {
        summary.skippedEmpty++;
        continue;
      }
      const result = await deliverBrief({
        userId: sub.userId,
        payload,
        channels: sub.channels as BriefChannel[],
        email: sub.user.email ?? undefined,
        displayName: sub.user.name ?? undefined,
      });
      if (
        Object.values(result.channelStatus).every((s) =>
          s.startsWith("skipped:already_delivered"),
        )
      ) {
        summary.skippedAlreadyDelivered++;
      } else {
        summary.delivered++;
      }
    } catch (err) {
      summary.errors++;
      logger.error("ARIA brief dispatcher failed for user", {
        err,
        userId: sub.userId,
      });
    }
  }

  return summary;
}

function currentLocalHour(timezone: string, now: Date): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    hourCycle: "h23",
  });
  // formatToParts is the only way to get a raw 2-digit hour without
  // locale-specific suffixes. `formatToParts` returns `[{type:"hour", value:"07"}]`.
  const parts = fmt.formatToParts(now);
  return Number(parts.find((p) => p.type === "hour")?.value ?? -1);
}

function isLocalWeekend(timezone: string, now: Date): boolean {
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  }).format(now);
  return day === "Sat" || day === "Sun";
}

function mdToBasicHtml(md: string): string {
  const escaped = escapeHtml(md);
  const withBold = escaped.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  const withItalic = withBold.replace(
    /(^|\s)_(.+?)_(\s|$)/g,
    "$1<em>$2</em>$3",
  );
  const lines = withItalic.split("\n");
  const out: string[] = [];
  let inList = false;
  for (const line of lines) {
    if (line.startsWith("- ")) {
      if (!inList) {
        out.push('<ul style="margin:8px 0;padding-left:20px">');
        inList = true;
      }
      out.push(`<li>${line.slice(2)}</li>`);
    } else {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      if (line.trim()) out.push(`<p style="margin:6px 0">${line}</p>`);
    }
  }
  if (inList) out.push("</ul>");
  return out.join("");
}
