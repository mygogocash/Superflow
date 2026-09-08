import * as XLSX from "xlsx";

/**
 * One exportable column: a header label + a cell accessor. Keeping the
 * accessor as a function (rather than a key) lets call sites flatten
 * nested fields (e.g. `owner.name`) and coerce types in one place.
 */
export interface ExportColumn<T> {
  header: string;
  value: (row: T) => string | number | null | undefined;
}

export type ExportFormat = "csv" | "xlsx";

/**
 * Spreadsheet formula-injection guard. A string cell that opens with
 * = + - @ (or a tab / carriage return) can be executed as a formula
 * when the CSV is opened in Excel / Sheets (a campaign named
 * `=IMPORTXML(...)` would run on open). Prefix it with a single quote
 * so the spreadsheet treats it as text. Mirrors the server-side
 * `neutralizeFormula` (apps/api/.../common/utils/csv.ts) and the survey
 * export's `neutralize`. Only strings are touched — numbers are safe.
 */
function neutralize(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/**
 * Build a worksheet from rows + column spec and trigger a download.
 * XLSX.writeFile picks the encoder from the file extension, so the
 * same array-of-objects produces a clean CSV or a real .xlsx with no
 * format-specific branching. Shared across every CRM list so export
 * behaves identically everywhere.
 */
export function exportRows<T>(
  baseName: string,
  columns: ExportColumn<T>[],
  rows: T[],
  format: ExportFormat,
): void {
  const aoa: (string | number)[][] = [
    columns.map((c) => c.header),
    ...rows.map((row) =>
      columns.map((c) => {
        const v = c.value(row);
        if (v === null || v === undefined) return "";
        return typeof v === "string" ? neutralize(v) : v;
      }),
    ),
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Export");
  const stamp = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `${baseName}-${stamp}.${format}`, {
    bookType: format,
  });
}

/**
 * Pick the row most likely to be a header inside the first ~15 rows
 * of a sheet. Real-world xlsx files (Pipeline Master, L&D Program
 * List, …) often have a title banner + a metadata row before the
 * actual column headers — naively using row 0 means every imported
 * row drops every field, and the dialog toasts "Need 'X' column"
 * even though the file is valid.
 *
 * Heuristic: scan the first 15 rows, score each by (non-empty cell
 * count, penalty for cells longer than 60 chars). Highest score that
 * also has at least 3 non-empty cells wins. Falls back to row 0 when
 * nothing scores higher (clean files behave identically to before).
 */
function detectHeaderRow(aoa: unknown[][]): number {
  const limit = Math.min(15, aoa.length);
  let bestIdx = 0;
  let bestScore = -1;
  for (let i = 0; i < limit; i++) {
    const row = aoa[i] ?? [];
    let nonEmpty = 0;
    let longCells = 0;
    for (const cell of row) {
      const s = String(cell ?? "").trim();
      if (!s) continue;
      nonEmpty++;
      if (s.length > 60) longCells++;
    }
    if (nonEmpty < 3) continue;
    // Long cells are a sign this is a sentence-style banner row,
    // not a header row. Subtract twice their count so a banner with
    // 1 long cell scoring 3 non-empty loses to a real header row
    // scoring 5 short cells.
    const score = nonEmpty - longCells * 2;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Parse an uploaded CSV/XLSX file into row objects keyed by the
 * detected header row. `xlsx` reads both formats, so one path covers
 * the "Both" requirement. Returns raw string-ish cells; the caller
 * maps + validates against its own schema.
 *
 * Header-row detection lets us absorb files with a title banner above
 * the real columns (e.g. Pipeline Master.xlsx where rows 0 + 1
 * are merged-cell prose and row 2 is the actual `Org Name | Category
 * | …` header).
 */
export async function parseImportFile(
  file: File,
): Promise<Record<string, unknown>[]> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const firstSheet = wb.SheetNames[0];
  if (!firstSheet) return [];
  const ws = wb.Sheets[firstSheet];
  if (!ws) return [];

  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    defval: "",
    raw: false,
  });
  if (aoa.length === 0) return [];

  const headerRowIdx = detectHeaderRow(aoa);
  const headerRow = aoa[headerRowIdx] ?? [];
  const headers = headerRow.map((c) => String(c ?? "").trim());

  const dataRows = aoa.slice(headerRowIdx + 1);
  return dataRows.map((row) => {
    const obj: Record<string, unknown> = {};
    headers.forEach((h, i) => {
      if (!h) return;
      const v = row[i];
      obj[h] = v ?? "";
    });
    return obj;
  });
}
