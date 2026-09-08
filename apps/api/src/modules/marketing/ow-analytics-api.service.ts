// Manut Analytics API ("Rahul API") ingester — the sole source for the OneWave
// dashboard. This is the same upstream the team read when they filled in the
// OW2.0 traction spreadsheet by hand, so it replaced that sheet rather than
// supplementing it.
//
// Best-effort: a flaky read yields an empty/partial OwIngestResult and never
// throws to the caller, so a bad upstream day leaves the last good snapshot in
// place instead of blanking the dashboard.
import { logger } from "@/common/utils/logger";
import {
  activePartnerMap,
  bniiBaseUrl,
} from "@/modules/marketing/bnii-partners";
import { OW_TELCOS } from "@/modules/marketing/ow-aliases";
import {
  type ApiQueryResponse,
  buildMetricRequestList,
  FALLBACK_TX_TYPES,
  mapResultsToRows,
  synthesizeRawTabs,
  TX_FIELDS,
} from "@/modules/marketing/ow-analytics-map";
import type { OwIngestResult, OwMetricRow } from "@/modules/marketing/ow-types";

const QUERY_PATH = "/v1/metrics/query";
const CATALOG_PATH = "/v1/metrics/catalog";
const PARTNER_CHUNK = 10;
const FETCH_TIMEOUT_MS = 20_000;

function backfillFrom(): string {
  return process.env.MARKETING_ANALYTICS_BACKFILL_FROM?.trim() || "2026-05-01";
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTxTypes(base: string): Promise<string[]> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${base}${CATALOG_PATH}`, {
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`catalog HTTP ${res.status}`);
      const cat = (await res.json()) as { known_transaction_types?: string[] };
      const types = cat.known_transaction_types;
      return Array.isArray(types) && types.length ? types : FALLBACK_TX_TYPES;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    logger.warn(
      `OW analytics catalog fetch failed, using fallback tx types: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return FALLBACK_TX_TYPES;
  }
}

export async function ingestAnalyticsApi(): Promise<OwIngestResult> {
  const fetchedAt = new Date().toISOString();
  const empty: OwIngestResult = {
    metrics: [],
    rawTabs: [],
    telcos: [...OW_TELCOS],
    warnings: [],
    fetchedAt,
  };

  // Both default to the registry, so the ingest runs with no configuration at
  // all; the env vars are overrides, not prerequisites.
  const base = bniiBaseUrl();
  const { byUuid, warnings } = activePartnerMap();
  if (byUuid.size === 0) return { ...empty, warnings };

  const allRows: OwMetricRow[] = [];
  try {
    const txTypes = await fetchTxTypes(base);
    const metricsReq = buildMetricRequestList(txTypes, TX_FIELDS);
    const uuids = [...byUuid.keys()];
    const date_from = backfillFrom();
    const date_to = todayUtc();

    for (const group of chunk(uuids, PARTNER_CHUNK)) {
      const resp = await postJson<ApiQueryResponse>(`${base}${QUERY_PATH}`, {
        partner_ids: group,
        date_from,
        date_to,
        metrics: metricsReq,
      });
      const mapped = mapResultsToRows(resp.results ?? [], byUuid);
      allRows.push(...mapped.rows);
      warnings.push(...mapped.warnings);
    }

    return {
      metrics: allRows,
      rawTabs: synthesizeRawTabs(allRows),
      telcos: [...OW_TELCOS],
      warnings,
      fetchedAt,
    };
  } catch (err) {
    logger.error(
      `OW analytics API ingest failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      metrics: allRows,
      rawTabs: synthesizeRawTabs(allRows),
      telcos: [...OW_TELCOS],
      warnings: [
        ...warnings,
        `analytics API read failed: ${err instanceof Error ? err.message : String(err)}`,
      ],
      fetchedAt,
    };
  }
}
