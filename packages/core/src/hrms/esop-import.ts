/**
 * Parser for HR's "Equity Summary Report" template — the canonical
 * per-employee grant sheet maintained off the employment contracts.
 *
 * Two layouts are supported:
 *
 *   V0 (legacy, wide) — sheet "Tokens and Equity Structure": one row
 *   per person, one column per grant type. Each non-empty grant cell
 *   becomes its own EsopGrant record.
 *
 *   V1 (current, long) — sheet "Equity Summary": long format with an
 *   assumptions header band, a section header per team, a person
 *   header row (encoding "BNRY Tokens (Contract): ..." / "Shark Tank
 *   Bonus: ..." as inline text), five fixed grant rows per person
 *   keyed by Equity Type, and a per-person Total row. The V1 parser
 *   collapses each person's block into one ParsedRow whose `grants[]`
 *   merges the person-header extras with the per-Equity-Type values.
 *
 * Cell values in V0 come in three shapes:
 *   • currency           — "THB 280,000", "USD 4,000", "INR 65,000"
 *   • shares             — "50,000 Shares", "1,000 Share", "3,000 Shares"
 *   • percent of base    — bare number (e.g. 10, 20) — only valid on the
 *                          "Equity % of base pay" column
 *   • skip               — "N/A", "Separately", blank
 *
 * In V1 grant rows have dedicated USD/THB/Shares columns. Priority
 * order is Shares > USD > THB so a row with shares=50,000 and a
 * derived THB cell yields a shares grant.
 *
 * Default strike price is USD 100 / share (HR's stated 1 share = $100).
 */

import {
  ESOP_CURRENCIES,
  type ESOP_GRANT_TYPES,
} from "@nexora/contracts/modules/hrms/hrms.validation";

export const ESOP_IMPORT_SHEET = "Tokens and Equity Structure";
export const ESOP_IMPORT_SHEET_V1 = "Equity Summary";

export const ESOP_IMPORT_DEFAULT_STRIKE = 100;

type EsopGrantType = (typeof ESOP_GRANT_TYPES)[number];

interface GrantColumnSpec {
  /** Column header in the HR template (first row). */
  header: string;
  /** Maps to `EsopGrant.grantType`. */
  grantType: EsopGrantType;
  /**
   * How to interpret a bare numeric cell:
   *   - "percent":     Equity % of base pay column (10 = 10% of base)
   *   - "shares":      share-only columns (CXO Equity, Golden Handcuff, etc.)
   *   - "currency_usd": Shark Tank Winner — bare number is a USD payout
   *   - undefined: bare numbers are an error (the column needs an
   *                explicit currency prefix or "Shares" suffix).
   */
  bareNumberMeans?: "percent" | "shares" | "currency_usd";
}

export const ESOP_IMPORT_GRANT_COLUMNS: readonly GrantColumnSpec[] = [
  {
    header: "BNRY Tokens (contract)",
    grantType: "tokens",
  },
  {
    header: "Equity (contract)",
    grantType: "equity",
  },
  {
    header: "Sign-up Equity Bonus",
    grantType: "sign_up_bonus",
    bareNumberMeans: "shares",
  },
  {
    header: "CXO Equity",
    grantType: "cxo_equity",
    bareNumberMeans: "shares",
  },
  {
    header: "Equity % of base pay (annual review 2024)",
    grantType: "annual_review",
    bareNumberMeans: "percent",
  },
  {
    header: "Golden Handcuff (transfer shares)",
    grantType: "golden_handcuff",
    bareNumberMeans: "shares",
  },
  {
    header: "Shark Tank Winner",
    grantType: "shark_tank",
    bareNumberMeans: "currency_usd",
  },
] as const;

// Period fields are optional on every variant. V1 parses them out of
// the Lock / Vesting / Increasing free-text cells so the integer-month
// columns on EsopGrant land with the right values instead of schema
// defaults; V0 grants still leave them undefined and the import
// service falls back to defaults.
interface ParsedGrantPeriods {
  lockMonths?: number;
  vestingMonths?: number;
  cliffMonths?: number;
  allocationStartMonth?: Date;
  allocationEndMonth?: Date;
  vestedToDateOverride?: number;
}

export type ParsedGrant =
  | ({
      kind: "shares";
      grantType: EsopGrantType;
      shares: number;
      sourceColumn: string;
      rawValue: string;
      /** V1 only: extra cells (Lock/Vesting/Increasing/Notes) folded into notes. */
      extraNotes?: string;
    } & ParsedGrantPeriods)
  | ({
      kind: "currency";
      grantType: EsopGrantType;
      currencyCode: (typeof ESOP_CURRENCIES)[number];
      currencyAmount: number;
      sourceColumn: string;
      rawValue: string;
      extraNotes?: string;
    } & ParsedGrantPeriods)
  | ({
      kind: "percent";
      grantType: EsopGrantType;
      percentOfBase: number;
      sourceColumn: string;
      rawValue: string;
      extraNotes?: string;
    } & ParsedGrantPeriods);

export interface ParsedRow {
  rowNumber: number;
  employeeName: string;
  position: string | null;
  team: string | null;
  grants: ParsedGrant[];
}

function normaliseCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") {
    return Number.isFinite(v) ? String(v) : "";
  }
  // Strip non-breaking and thin spaces that Excel/SheetJS sometimes
  // emits, then collapse runs of whitespace and trim. The final slice bounds
  // the length so the many regexes that run on this value cannot backtrack
  // polynomially on a pathological cell (CodeQL js/polynomial-redos); a real
  // ESOP cell is never anywhere near 2000 chars.
  return String(v)
    .replace(/[\u00a0\u2009\u200a\u202f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000);
}

const SKIP_TOKENS = new Set(["", "n/a", "na", "-", "—", "separately", "none"]);

function shouldSkip(value: string): boolean {
  return SKIP_TOKENS.has(value.toLowerCase());
}

/** Strip whitespace + group separators; keep sign and dot. */
export function coerceImportNumber(raw: string): number | null {
  const cleaned = raw
    .replace(/\s/g, "")
    .replace(/[,'_]/g, "")
    .replace(/[^\d.\-+eE]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === "+") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a single cell. Returns null when the cell is empty / N/A or the
 * value can't be interpreted with confidence.
 */
export function parseGrantCell(
  rawValue: unknown,
  spec: GrantColumnSpec,
): ParsedGrant | { error: string } | null {
  const text = normaliseCell(rawValue);
  if (shouldSkip(text)) return null;

  // "X Shares" / "X Share"
  const sharesMatch = text.match(/^([\d,\s.]+)\s*share(s)?$/i);
  if (sharesMatch) {
    const n = coerceImportNumber(sharesMatch[1]!);
    if (n === null || n <= 0) {
      return { error: `Could not parse share count from "${text}"` };
    }
    return {
      kind: "shares",
      grantType: spec.grantType,
      shares: Math.round(n),
      sourceColumn: spec.header,
      rawValue: text,
    };
  }

  // "<CURRENCY> <amount>" e.g. "THB 280,000", "USD 4,000"
  const currencyMatch = text.match(/^([A-Za-z]{3})\s+([\d,\s.]+)$/);
  if (currencyMatch) {
    const code =
      currencyMatch[1]!.toUpperCase() as (typeof ESOP_CURRENCIES)[number];
    if (!ESOP_CURRENCIES.includes(code)) {
      return { error: `Unsupported currency "${currencyMatch[1]}"` };
    }
    const amount = coerceImportNumber(currencyMatch[2]!);
    if (amount === null || amount <= 0) {
      return { error: `Could not parse currency amount from "${text}"` };
    }
    return {
      kind: "currency",
      grantType: spec.grantType,
      currencyCode: code,
      currencyAmount: amount,
      sourceColumn: spec.header,
      rawValue: text,
    };
  }

  // Bare number — interpretation depends on the column spec.
  if (spec.bareNumberMeans) {
    const n = coerceImportNumber(text);
    if (n !== null) {
      if (spec.bareNumberMeans === "percent") {
        if (n <= 0 || n > 100) {
          return { error: `Percent "${text}" must be between 0 and 100` };
        }
        return {
          kind: "percent",
          grantType: spec.grantType,
          percentOfBase: n,
          sourceColumn: spec.header,
          rawValue: text,
        };
      }
      if (spec.bareNumberMeans === "currency_usd") {
        if (n <= 0) {
          return { error: `USD amount must be greater than 0` };
        }
        return {
          kind: "currency",
          grantType: spec.grantType,
          currencyCode: "USD",
          currencyAmount: n,
          sourceColumn: spec.header,
          rawValue: text,
        };
      }
      if (n <= 0) {
        return { error: `Share count must be greater than 0` };
      }
      return {
        kind: "shares",
        grantType: spec.grantType,
        shares: Math.round(n),
        sourceColumn: spec.header,
        rawValue: text,
      };
    }
  }

  return { error: `Unrecognised value "${text}"` };
}

function normaliseHeader(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Parse one workbook row keyed by header name. Returns null when the
 * row carries no employee name (blank spacer rows between teams).
 *
 * Header lookups are normalised (trimmed + lower-cased) because HR's
 * template often has stray leading/trailing whitespace in the header
 * cells (e.g. `" BNRY Tokens (contract) "`).
 */
export function parseWorkbookRow(
  row: Record<string, unknown>,
  rowNumber: number,
): { row: ParsedRow; cellErrors: string[] } | null {
  const normalised = new Map<string, unknown>();
  for (const [k, v] of Object.entries(row)) {
    normalised.set(normaliseHeader(k), v);
  }
  const get = (header: string): unknown =>
    normalised.get(normaliseHeader(header));

  const name = normaliseCell(get("Name"));
  if (!name) return null;

  const grants: ParsedGrant[] = [];
  const cellErrors: string[] = [];

  for (const spec of ESOP_IMPORT_GRANT_COLUMNS) {
    const result = parseGrantCell(get(spec.header), spec);
    if (!result) continue;
    if ("error" in result) {
      cellErrors.push(`${spec.header}: ${result.error}`);
      continue;
    }
    grants.push(result);
  }

  return {
    row: {
      rowNumber,
      employeeName: name,
      position: normaliseCell(get("Position")) || null,
      team: normaliseCell(get("Team")) || null,
      grants,
    },
    cellErrors,
  };
}

/** Normalise an employee name for matching against `User.name`. */
export function normaliseEmployeeName(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

// ── V1 long-format parser ─────────────────────────────────────────────

/** Map V1 "Equity Type" cell values to internal grant types. */
export const V1_EQUITY_TYPE_MAP: Record<string, EsopGrantType> = {
  "equity from contract": "equity",
  "sign-up equity": "sign_up_bonus",
  "sign up equity": "sign_up_bonus",
  "cxo equity": "cxo_equity",
  "equity from 2024 bonus": "annual_review",
  "equity from annual review": "annual_review",
  "golden handcuff": "golden_handcuff",
};

/**
 * Column indexes (0-based) inside a V1 grant row. Resolved per-workbook
 * from the header row by `resolveV1Columns` so that HR inserting columns
 * (e.g. the "Start Lock Date" / "Start Vesting Date" pair in the
 * "Claude V1" revision) doesn't silently shift Vesting/Increasing/Notes
 * onto the wrong cells. `-1` means "column absent in this workbook".
 */
interface V1Columns {
  NAME: number;
  EQUITY_TYPE: number;
  USD: number;
  THB: number;
  SHARES: number;
  LOCK: number;
  START_LOCK: number;
  VESTING: number;
  START_VESTING: number;
  INCREASING: number;
  NOTES: number;
}

/**
 * Legacy 9-column layout (no start-date columns). Used as the default
 * for direct `parseV1GrantRow` calls and as the fallback when a header
 * label can't be found.
 */
const V1_COL: V1Columns = {
  NAME: 0,
  EQUITY_TYPE: 1,
  USD: 2,
  THB: 3,
  SHARES: 4,
  LOCK: 5,
  START_LOCK: -1,
  VESTING: 6,
  START_VESTING: -1,
  INCREASING: 7,
  NOTES: 8,
};

/** Build a column map from a V1 header row by matching header labels. */
export function resolveV1Columns(headerRow: unknown[]): V1Columns {
  const index = new Map<string, number>();
  for (let i = 0; i < headerRow.length; i++) {
    const label = normaliseCell(headerRow[i]).toLowerCase();
    if (label && !index.has(label)) index.set(label, i);
  }
  const find = (...labels: string[]): number => {
    for (const l of labels) {
      const i = index.get(l);
      if (i !== undefined) return i;
    }
    return -1;
  };
  const resolved: V1Columns = {
    NAME: find("name of staff", "name"),
    EQUITY_TYPE: find("equity type"),
    USD: find("equity in usd"),
    THB: find("equity in thb"),
    SHARES: find("no. of shares", "number of shares", "shares"),
    LOCK: find("lock period"),
    START_LOCK: find("start lock date"),
    VESTING: find("vesting period"),
    START_VESTING: find("start vesting date"),
    INCREASING: find("increasing period"),
    NOTES: find("source / notes", "source/notes", "notes"),
  };
  // Fall back to the legacy index for any core column the header didn't
  // name, so a partial / renamed header still parses the basics.
  for (const key of Object.keys(resolved) as (keyof V1Columns)[]) {
    if (resolved[key] < 0 && V1_COL[key] >= 0) resolved[key] = V1_COL[key];
  }
  return resolved;
}

const DASHBOARD_COL = {
  EQUITY_TYPE: 1,
  SHARES: 2,
  START: 3,
  END: 4,
  VESTED_TO_DATE: 5,
} as const;

function getCell(row: unknown[], index: number): unknown {
  return index < row.length ? row[index] : undefined;
}

function readNumericCell(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const txt = normaliseCell(v);
    if (!txt || shouldSkip(txt)) return null;
    return coerceImportNumber(txt);
  }
  return null;
}

function excelSerialDate(serial: number): Date | null {
  if (!Number.isFinite(serial) || serial < 1) return null;
  const epoch = Date.UTC(1899, 11, 30);
  const d = new Date(epoch + Math.round(serial) * 86_400_000);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function parseMonthCell(raw: unknown): Date | null {
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return new Date(Date.UTC(raw.getUTCFullYear(), raw.getUTCMonth(), 1));
  }
  if (typeof raw === "number") return excelSerialDate(raw);

  const text = normaliseCell(raw);
  if (!text || shouldSkip(text)) return null;

  const iso = text.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/);
  if (iso) {
    return new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, 1));
  }

  const named = text.match(/^([A-Za-z]{3,9})[\s-]+(\d{2}|\d{4})(?:\s|$)/);
  if (named) {
    const months: Record<string, number> = {
      jan: 0,
      january: 0,
      feb: 1,
      february: 1,
      mar: 2,
      march: 2,
      apr: 3,
      april: 3,
      may: 4,
      jun: 5,
      june: 5,
      jul: 6,
      july: 6,
      aug: 7,
      august: 7,
      sep: 8,
      sept: 8,
      september: 8,
      oct: 9,
      october: 9,
      nov: 10,
      november: 10,
      dec: 11,
      december: 11,
    };
    const month = months[named[1]!.toLowerCase()];
    if (month !== undefined) {
      const yearText = named[2]!;
      const year =
        yearText.length === 2 ? 2000 + Number(yearText) : Number(yearText);
      return new Date(Date.UTC(year, month, 1));
    }
  }

  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), 1));
  }

  return null;
}

/**
 * Parse a value that may carry an optional currency prefix and an
 * optional "/month" suffix. Used for V1's THB column where HR often
 * writes "280000/month" or "THB 87975/month".
 */
function parseCurrencyText(
  text: string,
  defaultCurrency: (typeof ESOP_CURRENCIES)[number],
):
  | { code: (typeof ESOP_CURRENCIES)[number]; amount: number }
  | { error: string }
  | null {
  if (!text || shouldSkip(text)) return null;
  const stripMonth = text.slice(0, 2000).replace(/\/\s*month\s*$/i, "").trim();
  const ccyMatch = stripMonth.match(/^([A-Za-z]{3})\s+([\d,\s.+-]+)$/);
  if (ccyMatch) {
    const code = ccyMatch[1]!.toUpperCase() as (typeof ESOP_CURRENCIES)[number];
    if (!ESOP_CURRENCIES.includes(code)) {
      return { error: `Unsupported currency "${ccyMatch[1]}"` };
    }
    const n = coerceImportNumber(ccyMatch[2]!);
    if (n === null || n <= 0) {
      return { error: `Could not parse amount from "${text}"` };
    }
    return { code, amount: n };
  }
  const n = coerceImportNumber(stripMonth);
  if (n !== null && n > 0) {
    return { code: defaultCurrency, amount: n };
  }
  return { error: `Unrecognised value "${text}"` };
}

export interface PersonHeaderV1 {
  employeeName: string;
  position: string | null;
  extras: ParsedGrant[];
  extraErrors: string[];
}

const PERSON_HEADER_SPLIT = /\s+[—–]\s+|\s+-\s+/;

/**
 * Parse a V1 person header row (col A). Returns null if the cell
 * doesn't look like a person header (no separator between name and
 * position).
 *
 * Examples:
 *   "Manit Sachin Parikh  —  Chief Executive Officer   |   BNRY Tokens (Contract): THB 280,000   |   Shark Tank Bonus: 50,000 Tokens"
 *   "Vivek Vadwa  —  VP of Business Development   |   BNRY Tokens (Contract): THB 21,000"
 *   "Sakshi Dolia  —  Digital Marketing Manager   |   BNRY Tokens (Contract): N/A"
 */
export function parsePersonHeaderV1(rawText: string): PersonHeaderV1 | null {
  const text = normaliseCell(rawText);
  if (!text) return null;
  // Person headers always carry an em-/en-dash or hyphen between name
  // and position. Section headers ("CEO Office", "Marketing Team")
  // never do, so this is a cheap discriminator.
  if (!PERSON_HEADER_SPLIT.test(text)) return null;
  if (/^total\b/i.test(text)) return null;

  const segments = text
    .split(/\s*\|\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 0) return null;

  const [firstSeg, ...extraSegs] = segments;
  const firstParts = firstSeg!.split(PERSON_HEADER_SPLIT);
  const employeeName = firstParts[0]?.trim() ?? "";
  if (!employeeName) return null;
  const position = firstParts.slice(1).join(" - ").trim() || null;

  const extras: ParsedGrant[] = [];
  const extraErrors: string[] = [];

  for (const seg of extraSegs) {
    const colon = seg.indexOf(":");
    if (colon < 0) continue;
    const label = seg.slice(0, colon).trim().toLowerCase();
    const value = seg.slice(colon + 1).trim();
    if (!value || shouldSkip(value)) continue;

    if (label.includes("bnry tokens") || label.includes("tokens (contract)")) {
      const parsed = parseCurrencyText(value, "THB");
      if (!parsed) continue;
      if ("error" in parsed) {
        extraErrors.push(`BNRY Tokens (Contract): ${parsed.error}`);
        continue;
      }
      extras.push({
        kind: "currency",
        grantType: "tokens",
        currencyCode: parsed.code,
        currencyAmount: parsed.amount,
        sourceColumn: "BNRY Tokens (Contract)",
        rawValue: value,
      });
    } else if (label.includes("shark tank")) {
      // V1 expresses Shark Tank as a token count, e.g. "50,000 Tokens".
      const sharesMatch = value
        .slice(0, 2000)
        .match(/^([\d,\s.]+)\s*(?:tokens?|shares?)?$/i);
      const n = sharesMatch ? coerceImportNumber(sharesMatch[1]!) : null;
      if (n !== null && n > 0) {
        extras.push({
          kind: "shares",
          grantType: "shark_tank",
          shares: Math.round(n),
          sourceColumn: "Shark Tank Bonus",
          rawValue: value,
        });
        continue;
      }
      // Fall back to currency parsing (legacy "USD 5,000" style).
      const parsed = parseCurrencyText(value, "USD");
      if (parsed && !("error" in parsed)) {
        extras.push({
          kind: "currency",
          grantType: "shark_tank",
          currencyCode: parsed.code,
          currencyAmount: parsed.amount,
          sourceColumn: "Shark Tank Bonus",
          rawValue: value,
        });
      } else if (parsed && "error" in parsed) {
        extraErrors.push(`Shark Tank Bonus: ${parsed.error}`);
      }
    }
  }

  return { employeeName, position, extras, extraErrors };
}

/**
 * Translate HR's free-text Lock / Vesting / Increasing cells into a
 * month count. Handles the patterns observed in the Equity Summary
 * Report:
 *   • "2 year from 1 Jun 2024"   → 24
 *   • "1 Years from 1 Feb 2025"  → 12
 *   • "3 years"                  → 36
 *   • "6 months"                 → 6
 *   • "Annual" / "Annual (Equal Tranches)" → 12
 *   • "1-Year Cliff" / "1 Year Cliff"      → 12
 *   • "" / "N/A" / "Separately"  → null  (caller uses the default)
 *
 * The verbatim cell text is preserved separately via `buildExtraNotes`
 * so HR can audit the integer the importer chose.
 */
export function parseMonthsText(raw: unknown): number | null {
  const text = normaliseCell(raw);
  if (!text || shouldSkip(text)) return null;
  const lower = text.toLowerCase();

  // "Annual (Equal Tranches)" / "Annual" → 12 months.
  if (/^annual\b/.test(lower)) return 12;

  // "X-Year Cliff" / "X Year Cliff" / "X Yr Cliff" → X * 12.
  const cliff = lower.match(/^(\d+(?:\.\d+)?)\s*[-\s]?\s*y(?:ea)?rs?\s*cliff/);
  if (cliff) return Math.round(Number(cliff[1]) * 12);

  // "X year(s)" / "X year(s) from <date>".
  const yrs = lower.match(/(\d+(?:\.\d+)?)\s*y(?:ea)?rs?\b/);
  if (yrs) return Math.round(Number(yrs[1]) * 12);

  // "X month(s)".
  const mos = lower.match(/(\d+(?:\.\d+)?)\s*months?\b/);
  if (mos) return Math.round(Number(mos[1]));

  return null;
}

/**
 * Build the "extra notes" string from V1's Lock/Vesting/Increasing/Notes
 * columns. Returns undefined if every column is empty.
 */
function buildExtraNotes(
  row: unknown[],
  cols: V1Columns = V1_COL,
): string | undefined {
  const parts: string[] = [];
  const lock = normaliseCell(getCell(row, cols.LOCK));
  const vest = normaliseCell(getCell(row, cols.VESTING));
  const incr = normaliseCell(getCell(row, cols.INCREASING));
  const notes = normaliseCell(getCell(row, cols.NOTES));
  if (lock && !shouldSkip(lock)) parts.push(`Lock: ${lock}`);
  if (vest && !shouldSkip(vest)) parts.push(`Vesting: ${vest}`);
  if (incr && !shouldSkip(incr)) parts.push(`Increasing: ${incr}`);
  if (notes && !shouldSkip(notes)) parts.push(`Notes: ${notes}`);
  return parts.length > 0 ? parts.join(" • ") : undefined;
}

/**
 * Parse one V1 grant row into at most one grant. The row may instead
 * be a section header / total / blank — in which case we return
 * `{ kind: "skip" }` and the caller moves on.
 */
export function parseV1GrantRow(
  row: unknown[],
  cols: V1Columns = V1_COL,
):
  | { kind: "grant"; grant: ParsedGrant }
  | { kind: "skip" }
  | { kind: "error"; errors: string[] } {
  const typeText = normaliseCell(getCell(row, cols.EQUITY_TYPE));
  if (!typeText) return { kind: "skip" };
  const grantType = V1_EQUITY_TYPE_MAP[typeText.toLowerCase()];
  if (!grantType) return { kind: "skip" };
  // "Equity from Contract" is salary-style monthly contract equity, out
  // of scope for the ESOP pool (HR decision, 2026-06). Skip those rows.
  if (grantType === "equity") return { kind: "skip" };

  const usdCell = getCell(row, cols.USD);
  const thbCell = getCell(row, cols.THB);
  const sharesCell = getCell(row, cols.SHARES);

  const extraNotes = buildExtraNotes(row, cols);
  // Lock / Vesting / Increasing arrive as free-text; Start Lock /
  // Start Vesting as dates. Lock is the cliff (a "2-year lock then 100%"
  // grant → 0 vested until month 24, then full). Vesting Period drives
  // the linear schedule; when absent, the lock period doubles as the
  // vesting window so the grant fully vests exactly at lock-end. The
  // tranche cadence in "Increasing Period" isn't modelled (linear
  // approximation) — verbatim text stays in extraNotes for HR to audit.
  const lockMonths = parseMonthsText(getCell(row, cols.LOCK)) ?? undefined;
  const vestingMonths =
    parseMonthsText(getCell(row, cols.VESTING)) ?? lockMonths;
  const startMonth =
    parseMonthCell(getCell(row, cols.START_VESTING)) ??
    parseMonthCell(getCell(row, cols.START_LOCK)) ??
    undefined;
  const periods: ParsedGrantPeriods & { allocationStartMonth?: Date } = {
    lockMonths,
    vestingMonths,
    cliffMonths: lockMonths,
    ...(startMonth ? { allocationStartMonth: startMonth } : {}),
  };
  const errors: string[] = [];

  // Priority 1 — explicit share count.
  const sharesN = readNumericCell(sharesCell);
  if (sharesN !== null && sharesN > 0) {
    return {
      kind: "grant",
      grant: {
        kind: "shares",
        grantType,
        shares: Math.round(sharesN),
        sourceColumn: typeText,
        rawValue: `${sharesN} Shares`,
        extraNotes,
        ...periods,
      },
    };
  }

  // Priority 2 — USD column.
  const usdN = readNumericCell(usdCell);
  if (usdN !== null && usdN > 0) {
    return {
      kind: "grant",
      grant: {
        kind: "currency",
        grantType,
        currencyCode: "USD",
        currencyAmount: usdN,
        sourceColumn: typeText,
        rawValue: `USD ${usdN}`,
        extraNotes,
        ...periods,
      },
    };
  }

  // Priority 3 — THB column (may be string with optional currency
  // prefix and/or "/month" suffix). Treat a numeric 0 as "no value"
  // — HR's template has formula-derived 0s when the USD source cell
  // is blank.
  const thbText = normaliseCell(thbCell);
  const thbBareNumber = thbText ? coerceImportNumber(thbText) : null;
  if (thbText && !shouldSkip(thbText) && thbBareNumber !== 0) {
    const parsed = parseCurrencyText(thbText, "THB");
    if (parsed) {
      if ("error" in parsed) {
        errors.push(`${typeText} → Equity in THB: ${parsed.error}`);
      } else {
        return {
          kind: "grant",
          grant: {
            kind: "currency",
            grantType,
            currencyCode: parsed.code,
            currencyAmount: parsed.amount,
            sourceColumn: typeText,
            rawValue: thbText,
            extraNotes,
            ...periods,
          },
        };
      }
    }
  }

  if (errors.length > 0) return { kind: "error", errors };
  return { kind: "skip" };
}

export interface V1ParseResult {
  rows: ParsedRow[];
  parseErrors: { rowNumber: number; errors: string[] }[];
}

interface DashboardGrant {
  grantType: EsopGrantType;
  shares: number | null;
  allocationStartMonth: Date | null;
  allocationEndMonth: Date | null;
  vestedToDateOverride: number | null;
}

function readDashboardGrant(row: unknown[]): DashboardGrant | null {
  const typeText = normaliseCell(getCell(row, DASHBOARD_COL.EQUITY_TYPE));
  if (!typeText) return null;
  const grantType = V1_EQUITY_TYPE_MAP[typeText.toLowerCase()];
  if (!grantType) return null;

  return {
    grantType,
    shares: readNumericCell(getCell(row, DASHBOARD_COL.SHARES)),
    allocationStartMonth: parseMonthCell(getCell(row, DASHBOARD_COL.START)),
    allocationEndMonth: parseMonthCell(getCell(row, DASHBOARD_COL.END)),
    vestedToDateOverride: readNumericCell(
      getCell(row, DASHBOARD_COL.VESTED_TO_DATE),
    ),
  };
}

function mergeDashboardGrant(row: ParsedRow, dashboardGrant: DashboardGrant) {
  const existing = row.grants.find(
    (g) =>
      g.grantType === dashboardGrant.grantType &&
      (dashboardGrant.shares === null ||
        (g.kind === "shares" &&
          g.shares === Math.round(dashboardGrant.shares))),
  );

  const patch = {
    allocationStartMonth: dashboardGrant.allocationStartMonth ?? undefined,
    allocationEndMonth: dashboardGrant.allocationEndMonth ?? undefined,
    vestedToDateOverride:
      dashboardGrant.vestedToDateOverride !== null
        ? Math.round(dashboardGrant.vestedToDateOverride)
        : undefined,
  };

  if (existing) {
    Object.assign(existing, patch);
    return;
  }

  if (dashboardGrant.shares !== null && dashboardGrant.shares > 0) {
    row.grants.push({
      kind: "shares",
      grantType: dashboardGrant.grantType,
      shares: Math.round(dashboardGrant.shares),
      sourceColumn: "Dashboard",
      rawValue: `${dashboardGrant.shares} Shares`,
      ...patch,
    });
  }
}

function applyDashboardOverrides(aoa: unknown[][], rows: ParsedRow[]) {
  // Dashboard rows do not carry an employee name. Apply them only when the
  // workbook parse yielded a single person, otherwise the match would be
  // ambiguous.
  if (rows.length !== 1) return;
  const row = rows[0]!;

  for (const raw of aoa) {
    const dashboardGrant = readDashboardGrant(raw);
    if (!dashboardGrant) continue;
    if (
      dashboardGrant.allocationStartMonth === null &&
      dashboardGrant.allocationEndMonth === null &&
      dashboardGrant.vestedToDateOverride === null
    ) {
      continue;
    }
    mergeDashboardGrant(row, dashboardGrant);
  }
}

/**
 * Walk the V1 sheet (as array-of-arrays) and emit one ParsedRow per
 * person. The sheet contains:
 *   • Title / assumptions / blank rows before the header row.
 *   • A header row "Name of Staff | Equity Type | ..." that anchors
 *     the data band.
 *   • Repeating blocks of [section header?][person header][5 grant
 *     rows][total row].
 *   • A grand-total row at the bottom.
 */
export function parseV1Workbook(aoa: unknown[][]): V1ParseResult {
  const rows: ParsedRow[] = [];
  const parseErrors: { rowNumber: number; errors: string[] }[] = [];

  let headerIdx = -1;
  for (let i = 0; i < aoa.length; i++) {
    const a = normaliseCell(getCell(aoa[i]!, 0)).toLowerCase();
    const b = normaliseCell(getCell(aoa[i]!, 1)).toLowerCase();
    if (a === "name of staff" && b === "equity type") {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) return { rows, parseErrors };

  // Resolve column positions from the header row so inserted columns
  // (e.g. the Start Lock/Vesting Date pair) map to the right fields.
  const cols = resolveV1Columns(aoa[headerIdx] ?? []);

  let current: { row: ParsedRow; rowNumber: number } | null = null;
  const flush = () => {
    if (current) rows.push(current.row);
    current = null;
  };

  for (let i = headerIdx + 1; i < aoa.length; i++) {
    const raw = aoa[i] ?? [];
    const rowNumber = i + 1; // 1-based for human-readable error messages
    const aText = normaliseCell(getCell(raw, 0));
    const bText = normaliseCell(getCell(raw, 1));

    if (!aText && !bText) continue;

    // Per-person total row — close the current person.
    if (/^total\b/i.test(aText)) {
      flush();
      continue;
    }

    // Grand total at the bottom — close and stop.
    if (/^grand\s+total/i.test(aText)) {
      flush();
      break;
    }

    // Header rows have no Equity Type cell.
    if (!bText) {
      const personHeader = parsePersonHeaderV1(aText);
      if (personHeader) {
        flush();
        const personErrors: string[] = [...personHeader.extraErrors];
        current = {
          rowNumber,
          row: {
            rowNumber,
            employeeName: personHeader.employeeName,
            position: personHeader.position,
            team: null,
            grants: [...personHeader.extras],
          },
        };
        if (personErrors.length > 0) {
          parseErrors.push({ rowNumber, errors: personErrors });
        }
      }
      // Plain section headers ("CEO Office") are ignored — no useful
      // signal to capture beyond what's already in the row block.
      continue;
    }

    // Grant row — must belong to a person.
    if (!current) continue;
    const result = parseV1GrantRow(raw, cols);
    if (result.kind === "grant") {
      current.row.grants.push(result.grant);
    } else if (result.kind === "error") {
      parseErrors.push({ rowNumber, errors: result.errors });
    }
  }
  flush();
  applyDashboardOverrides(aoa, rows);
  return { rows, parseErrors };
}

/**
 * Detect template version. The V1 sheet name takes priority because
 * HR may keep both sheets in transition workbooks. Falls back to a
 * header-row sniff on the first sheet so admins who renamed a tab
 * still get the right parser.
 */
export function detectEsopTemplateVersion(
  sheetNames: readonly string[],
  firstSheetAoa: unknown[][] | null,
): "v1" | "v0" {
  if (sheetNames.includes(ESOP_IMPORT_SHEET_V1)) return "v1";
  if (sheetNames.includes(ESOP_IMPORT_SHEET)) return "v0";
  if (firstSheetAoa) {
    for (let i = 0; i < Math.min(10, firstSheetAoa.length); i++) {
      const a = normaliseCell(getCell(firstSheetAoa[i]!, 0)).toLowerCase();
      const b = normaliseCell(getCell(firstSheetAoa[i]!, 1)).toLowerCase();
      if (a === "name of staff" && b === "equity type") return "v1";
    }
  }
  return "v0";
}
