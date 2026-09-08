// Client-ready report export for a single telco. Fetches the current period
// and the prior comparable period, computes uplift, and opens a printable HTML
// document (Save-as-PDF from the browser) — mirroring the reference dashboard's
// Daily / Weekly / Month-on-Month reports.
import {
  type MetricsQueryResult,
  queryMarketingMetrics,
} from "@/services/marketing-analytics.service";
import {
  type CampaignListItem,
  listCampaigns,
} from "@/services/marketing-campaigns.service";

export type ReportKind = "daily" | "weekly" | "mom";

const KIND_DAYS: Record<ReportKind, number> = {
  daily: 1,
  weekly: 7,
  mom: 30,
};
const KIND_LABEL: Record<ReportKind, string> = {
  daily: "Daily Report",
  weekly: "Weekly Report",
  mom: "Month-on-Month Report",
};

const REPORT_METRICS = [
  { key: "unique_users", label: "Unique Users", agg: "avg" as const },
  { key: "new_users", label: "New Users", agg: "sum" as const },
  { key: "repeated_users", label: "Repeat Users", agg: "sum" as const },
  { key: "total_views_homepage", label: "Homepage Views", agg: "sum" as const },
  {
    key: "avg_time_spent_seconds",
    label: "Avg Session (s)",
    agg: "avg" as const,
  },
  { key: "tx.spin_reward.amount", label: "BNRY via STW", agg: "sum" as const },
  {
    key: "tx.online_reward.amount",
    label: "BNRY via Games",
    agg: "sum" as const,
  },
];

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function shift(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function fmt(n: number | null): string {
  if (n === null || Number.isNaN(n)) return "—";
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return Math.round(n).toLocaleString("en-US");
}

function aggregate(
  result: MetricsQueryResult,
  partnerId: string,
  from: string,
  to: string,
) {
  const series =
    result.results.find((r) => r.partner_id === partnerId)?.series ?? [];
  const window = series.filter((pt) => pt.date >= from && pt.date <= to);
  const out: Record<string, number | null> = {};
  for (const m of REPORT_METRICS) {
    const vals = window
      .map((pt) => pt.metrics[m.key])
      .filter((v): v is number => typeof v === "number");
    if (vals.length === 0) {
      out[m.key] = null;
    } else {
      const total = vals.reduce((a, b) => a + b, 0);
      out[m.key] = m.agg === "avg" ? total / vals.length : total;
    }
  }
  return out;
}

export async function generateTelcoReport(
  partnerId: string,
  telcoName: string,
  kind: ReportKind,
): Promise<void> {
  const days = KIND_DAYS[kind];
  const today = new Date();
  const currTo = iso(today);
  const currFrom = iso(shift(today, -(days - 1)));
  const prevTo = iso(shift(today, -days));
  const prevFrom = iso(shift(today, -(days * 2 - 1)));

  const [series, camps] = await Promise.all([
    queryMarketingMetrics({
      dateFrom: prevFrom,
      dateTo: currTo,
      metrics: REPORT_METRICS.map((m) => m.key),
      partnerIds: [partnerId],
    }),
    listCampaigns({ from: currFrom, to: currTo, limit: 100 }),
  ]);

  const curr = aggregate(series.data, partnerId, currFrom, currTo);
  const prev = aggregate(series.data, partnerId, prevFrom, prevTo);

  const rows = REPORT_METRICS.map((m) => {
    const c = curr[m.key];
    const p = prev[m.key];
    const uplift =
      typeof c === "number" && typeof p === "number" && p !== 0
        ? ((c - p) / p) * 100
        : null;
    const cls = uplift === null ? "" : uplift >= 0 ? "up" : "down";
    const upTxt =
      uplift === null ? "—" : `${uplift >= 0 ? "+" : ""}${uplift.toFixed(0)}%`;
    return `<tr><td>${m.label}</td><td class="num">${fmt(p)}</td><td class="num">${fmt(
      c,
    )}</td><td class="num ${cls}">${upTxt}</td></tr>`;
  }).join("");

  const campaignRows =
    camps.data.length > 0
      ? camps.data
          .map(
            (c: CampaignListItem) =>
              `<tr><td>${esc(c.name)}</td><td>${c.campaignDate.slice(0, 10)}</td><td>${esc(
                c.channel ?? "—",
              )}</td><td>${esc(c.status)}</td><td class="num">${fmt(
                c.actualReach,
              )}</td></tr>`,
          )
          .join("")
      : `<tr><td colspan="5" class="muted">No campaigns in this period.</td></tr>`;

  const html = `<!doctype html><html><head><meta charset="utf-8">
<title>${esc(telcoName)} — ${KIND_LABEL[kind]}</title>
<style>
  body{font-family:Georgia,'Times New Roman',serif;color:#1a1a1a;max-width:860px;margin:32px auto;padding:0 24px;}
  h1{font-size:26px;margin:0 0 4px;} .sub{color:#666;font-size:13px;margin-bottom:24px;}
  h2{font-size:16px;border-bottom:1px solid #ddd;padding-bottom:6px;margin-top:28px;}
  table{width:100%;border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;margin-top:10px;}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #eee;}
  th{color:#888;font-size:11px;text-transform:uppercase;letter-spacing:.06em;}
  td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;}
  .up{color:#2c8a4a;font-weight:600;} .down{color:#b73a3a;font-weight:600;} .muted{color:#999;text-align:center;}
  .foot{margin-top:32px;color:#999;font-size:11px;border-top:1px solid #ddd;padding-top:10px;}
  @media print{body{margin:0;}}
</style></head><body>
  <h1>${esc(telcoName)} — ${KIND_LABEL[kind]}</h1>
  <div class="sub">Current: ${currFrom} → ${currTo} · Prior: ${prevFrom} → ${prevTo} · Source: BNII Analytics API</div>
  <h2>Key metrics</h2>
  <table><thead><tr><th>Metric</th><th class="num">Prior</th><th class="num">Current</th><th class="num">Uplift</th></tr></thead><tbody>${rows}</tbody></table>
  <h2>Campaigns in period</h2>
  <table><thead><tr><th>Campaign</th><th>Date</th><th>Channel</th><th>Status</th><th class="num">Reach</th></tr></thead><tbody>${campaignRows}</tbody></table>
  <div class="foot">OneWave / Manut — generated ${currTo}. Share only with authorised partners.</div>
  <script>window.onload=function(){setTimeout(function(){window.print();},300);};</scr${""}ipt>
</body></html>`;

  // Every interpolated value above is HTML-escaped; serve via a Blob URL with
  // noopener/noreferrer (matches the reports/page.tsx export hardening).
  const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
  const w = window.open(url, "_blank", "noopener,noreferrer");
  if (w) {
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } else {
    URL.revokeObjectURL(url);
    throw new Error("Pop-up blocked — allow pop-ups to export the report.");
  }
}
