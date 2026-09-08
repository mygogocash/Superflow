// Pure mapping between the Manut Analytics API (POST /v1/metrics/query) and
// the OneWave OwMetricRow contract. No I/O — unit tested.
import { type OwMetricKey, type OwTelco } from "@/modules/marketing/ow-aliases";
import type { OwMetricRow, OwRawTab } from "@/modules/marketing/ow-types";

export { parsePartnerOverrides as parsePartnerMap } from "@/modules/marketing/bnii-partners";

export interface ApiMetricPoint {
  date: string;
  metrics: Record<string, number | null>;
}
export interface ApiPartnerResult {
  partner_id: string;
  telco_name: string | null;
  series: ApiMetricPoint[];
}
export interface ApiQueryResponse {
  date_from: string;
  date_to: string;
  results: ApiPartnerResult[];
}

// API core metric name → OwDailyMetric column key. 23 entries = every core
// metric the API exposes. stwWins + accessPassUsers are NOT core (see below).
export const API_CORE_TO_KEY: Record<string, OwMetricKey> = {
  total_views_homepage: "homepageViews",
  dau: "dauCrm",
  dau_ga: "dauGa",
  mau_ga: "mauRolling30",
  mau: "mauNexus",
  unique_users: "uniqueUsers",
  new_users: "newUsers",
  new_users_ga: "newUsersGa",
  repeated_users: "repeatUsers",
  repeated_users_ga: "repeatUsersGa",
  sessions_ga: "sessionsGa",
  avg_time_spent_seconds: "avgSessionSec",
  total_user_games: "clicksBnryGames",
  total_credit: "totalCredit",
  total_debit: "totalDebit",
  total_transactions: "totalTransactions",
  total_spin_usage: "spinUsage",
  total_spin_win_tokens: "spinWinTokens",
  unique_spin_users: "uniqueSpinUsers",
  total_user_fando: "usersFando",
  total_user_ngage: "usersNgage",
  total_bnry_tokens_earned: "bnryEarned",
  total_bnry_tokens_spent: "bnryRedeemed",
};

// Duration metrics arrive as floats; store rounded ints.
const ROUND_KEYS: Set<OwMetricKey> = new Set(["avgSessionSec"]);

// Columns persisted as BigInt (values can exceed Int32); Task 4 coerces.
export const AMOUNT_KEYS: Set<OwMetricKey> = new Set([
  "bnryEarned",
  "bnryRedeemed",
  "totalCredit",
  "totalDebit",
  "spinWinTokens",
]);

// accessPassUsers is a tx.* metric, not a core column.
export const ACCESS_PASS_METRIC = "tx.use_pass.unique_users";

export const TX_FIELDS = ["count", "amount", "unique_users"] as const;

// Used when the catalog fetch fails — a curated subset that always exists.
export const FALLBACK_TX_TYPES = [
  "PURCHASE",
  "MEMBERSHIP_PURCHASE",
  "QUEST_REWARD",
  "SPIN_REWARD",
  "ONLINE_REWARD",
  "USE_PASS",
];

/** Full `metrics` request list: 23 core + access-pass + tx.<type>.<field>, deduped. */
export function buildMetricRequestList(
  txTypes: string[],
  txFields: readonly string[],
): string[] {
  const out = new Set<string>(Object.keys(API_CORE_TO_KEY));
  out.add(ACCESS_PASS_METRIC);
  for (const t of txTypes) {
    for (const f of txFields) out.add(`tx.${t}.${f}`);
  }
  return [...out];
}

function num(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// Vendor `point.date` must be a well-formed "YYYY-MM-DD" calendar date.
// downstream, refreshSnapshot does `new Date(`${m.date}T00:00:00.000Z`)`;
// an Invalid Date there throws on the Prisma upsert with no per-row
// try/catch, freezing the snapshot on every retry (the sheet path is
// immune because normalizeOwDate() filters bad dates first).
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Map API results → OwMetricRow[], bucketing by partner_id via the env map. */
export function mapResultsToRows(
  results: ApiPartnerResult[],
  byUuid: Map<string, OwTelco>,
): { rows: OwMetricRow[]; warnings: string[] } {
  const rows: OwMetricRow[] = [];
  const warnings: string[] = [];
  for (const result of results) {
    const telco = byUuid.get(result.partner_id);
    if (!telco) {
      warnings.push(
        `result partner_id "${result.partner_id}" not in partner map (skipped)`,
      );
      continue;
    }
    for (const point of result.series ?? []) {
      if (
        typeof point.date !== "string" ||
        !DATE_RE.test(point.date) ||
        Number.isNaN(Date.parse(point.date))
      ) {
        warnings.push(
          `partner "${result.partner_id}" skipped point with invalid date "${point.date}"`,
        );
        continue;
      }
      const values: Partial<Record<OwMetricKey, number>> = {};
      const txMetrics: Record<string, number> = {};
      for (const [apiName, rawVal] of Object.entries(point.metrics ?? {})) {
        const v = num(rawVal);
        if (v == null) continue;
        if (apiName === ACCESS_PASS_METRIC) values.accessPassUsers = v;
        if (apiName.startsWith("tx.")) {
          txMetrics[apiName] = v;
          continue;
        }
        const key = API_CORE_TO_KEY[apiName];
        if (!key) continue;
        values[key] = ROUND_KEYS.has(key) ? Math.round(v) : v;
      }
      rows.push({
        date: point.date,
        telco,
        values,
        txMetrics: Object.keys(txMetrics).length ? txMetrics : undefined,
        isIntraday: false,
        sourceTab: "analytics-api",
      });
    }
  }
  return { rows, warnings };
}

/** One raw grid per telco (headers = date + column keys) for the existing dashboard. */
export function synthesizeRawTabs(rows: OwMetricRow[]): OwRawTab[] {
  const cols = Object.values(API_CORE_TO_KEY);
  const byTelco = new Map<OwTelco, OwMetricRow[]>();
  for (const r of rows) {
    const list = byTelco.get(r.telco) ?? [];
    list.push(r);
    byTelco.set(r.telco, list);
  }
  const tabs: OwRawTab[] = [];
  for (const [telco, list] of byTelco) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    tabs.push({
      title: telco,
      telco,
      headers: ["date", ...cols],
      rows: list.map((r) => [
        r.date,
        ...cols.map((c) => {
          const v = r.values[c];
          return v == null ? "" : String(v);
        }),
      ]),
    });
  }
  return tabs;
}
