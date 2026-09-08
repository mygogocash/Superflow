// Parser for HR's "Equity Monthly Salary" workbook. The sheet has a
// two-row header — row 1 carries column families (Employee Name,
// Position, Start date, "Equity Allocation YYYY (Number of Share)"),
// row 2 carries the per-month sub-headers (Jan, Feb, ..., Dec) under
// the equity-allocation column. Mirrors the two-row-header pattern
// already used by payroll #207 / #209.

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const MONTH_LOOKUP = new Set(MONTH_NAMES.map((m) => m.toLowerCase()));

export const EQUITY_MONTHLY_SHEET_HINT = "Monthly Salary";

export interface ParsedEquitySalaryRow {
  employeeName: string;
  position: string | null;
  startDate: string | null;
  currency: string | null;
  monthlyShares: Record<string, number>;
}

export interface ParsedEquitySalaryWorkbook {
  year: number;
  rows: ParsedEquitySalaryRow[];
  parseErrors: { rowNumber: number; errors: string[] }[];
}

// Strip whitespace including NBSP / thin-space, drop digit-group
// separators, then Number(). Mirrors the payroll `coerceNumber` helper
// CLAUDE.md flagged for HR-authored xlsx cells.
function coerceNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const cleaned = String(raw)
    .replace(/[\s\u00A0\u2009]+/g, "")
    .replace(/[,'_]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function coerceString(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  return s === "" ? null : s;
}

// Excel serial date → ISO YYYY-MM-DD. Excel epoch is 1899-12-30
// (off-by-one for the 1900 leap-year bug).
function excelSerialToISO(serial: number): string | null {
  if (!Number.isFinite(serial)) return null;
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function coerceDate(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return null;
    return raw.toISOString().slice(0, 10);
  }
  if (typeof raw === "number") {
    return excelSerialToISO(raw);
  }
  const s = String(raw).trim();
  if (s === "") return null;
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return null;
}

// Pull the trailing currency suffix off "Manit Parikh (THB)" → "THB".
// Returns null when no parenthesised suffix is present.
function extractCurrencyFromName(name: string): string | null {
  // Bound length before the `\s*$`-anchored regexes to avoid polynomial
  // backtracking on a pathological cell (CodeQL js/polynomial-redos).
  const match = name.slice(0, 500).match(/\(([A-Z]{2,4})\)\s*$/);
  return match ? (match[1] ?? null) : null;
}

function stripCurrencySuffix(name: string): string {
  return name
    .slice(0, 500)
    .replace(/\s*\([A-Z]{2,4}\)\s*$/, "")
    .trim();
}

// Year extracted from "Equity Allocation 2026 (Number of Share)" or
// similar. Falls back to the current year if no 4-digit number is
// found in any row-1 header cell.
function extractYear(headerRow: unknown[]): number {
  for (const cell of headerRow) {
    const s = String(cell ?? "");
    const m = s.match(/(20\d{2})/);
    if (m) return Number(m[1]);
  }
  return new Date().getFullYear();
}

export function parseEquitySalaryWorkbook(
  aoa: unknown[][],
): ParsedEquitySalaryWorkbook {
  if (aoa.length < 3) {
    return { year: new Date().getFullYear(), rows: [], parseErrors: [] };
  }
  const row1 = aoa[0] ?? [];
  const row2 = aoa[1] ?? [];
  const year = extractYear(row1);

  // Build month column index — any row-2 cell whose normalised text
  // matches a known month abbrev. Position by index in the row so
  // data-row cells line up.
  const monthCols: { idx: number; month: string }[] = [];
  for (let i = 0; i < row2.length; i++) {
    const s = String(row2[i] ?? "")
      .trim()
      .slice(0, 3);
    if (s && MONTH_LOOKUP.has(s.toLowerCase())) {
      const canonical = MONTH_NAMES.find(
        (m) => m.toLowerCase() === s.toLowerCase(),
      );
      if (canonical) monthCols.push({ idx: i, month: canonical });
    }
  }

  const rows: ParsedEquitySalaryRow[] = [];
  const parseErrors: { rowNumber: number; errors: string[] }[] = [];

  for (let i = 2; i < aoa.length; i++) {
    const row = aoa[i] ?? [];
    const rowNumber = i + 1; // 1-based for error reporting

    const rawName = coerceString(row[0]);
    if (!rawName) continue; // blank or note-only row
    // Heuristic: skip the trailing "Note: ..." rows the HR template
    // uses for the FX conversion footnote.
    if (/^note\s*:/i.test(rawName)) continue;

    const currency = extractCurrencyFromName(rawName);
    const employeeName = stripCurrencySuffix(rawName);
    const position = coerceString(row[1]);
    const startDate = coerceDate(row[2]);

    const monthlyShares: Record<string, number> = {};
    const cellErrors: string[] = [];
    for (const { idx, month } of monthCols) {
      const raw = row[idx];
      if (raw === null || raw === undefined || raw === "") continue;
      const n = coerceNumber(raw);
      if (n === null) {
        cellErrors.push(`${month}: could not parse "${String(raw)}"`);
        continue;
      }
      monthlyShares[month] = n;
    }

    if (cellErrors.length > 0) {
      parseErrors.push({ rowNumber, errors: cellErrors });
    }

    rows.push({
      employeeName,
      position,
      startDate,
      currency,
      monthlyShares,
    });
  }

  return { year, rows, parseErrors };
}
