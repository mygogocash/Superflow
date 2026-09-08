#!/usr/bin/env node
/**
 * Neon ERP snapshot → local files (and optional S3) for Databricks bronze.
 *
 * Depot v1 path (no Worker binding). Reads via STAGING_DIRECT_URL / DATABASE_URL.
 * Default is dry-run (counts only). Write mode emits CSV under OUT_DIR/as_of_date=…
 *
 * Usage:
 *   node scripts/export-erp-snapshot.mjs --dry-run --slice=p0
 *   OUT_DIR=/tmp/erp node scripts/export-erp-snapshot.mjs --slice=p0
 *   OUT_DIR=/tmp/erp S3_BUCKET=… AWS_REGION=… node scripts/export-erp-snapshot.mjs --slice=all
 *
 * Env:
 *   DATABASE_URL | DIRECT_URL | STAGING_DIRECT_URL — Neon unpooled URL
 *   OUT_DIR — required when not --dry-run (local landing zone)
 *   AS_OF_DATE — YYYY-MM-DD partition (default: today UTC)
 *   S3_BUCKET / S3_PREFIX — optional upload after write (aws CLI)
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import postgres from "postgres";
import { isDeniedTable, resolveExportTables } from "./erp-snapshot-tables.mjs";

const args = process.argv.slice(2).filter((a) => a !== "--");
const dryRun = args.includes("--dry-run") || !args.includes("--write");
const sliceArg = args.find((a) => a.startsWith("--slice="));
const slice = /** @type {'p0'|'p1'|'all'} */ (
  sliceArg ? sliceArg.slice("--slice=".length) : "p0"
);

const url =
  process.env.DIRECT_URL ??
  process.env.DATABASE_URL ??
  process.env.STAGING_DIRECT_URL;
if (!url) {
  console.error("DATABASE_URL, DIRECT_URL, or STAGING_DIRECT_URL required");
  process.exit(1);
}

// Depot workflow_dispatch may pass AS_OF_DATE="" — treat blank as unset.
const asOfRaw = (process.env.AS_OF_DATE ?? "").trim();
const asOf = asOfRaw || new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
  console.error(`AS_OF_DATE must be YYYY-MM-DD, got '${asOf}'`);
  process.exit(1);
}

const outDir = process.env.OUT_DIR;
if (!dryRun && !outDir) {
  console.error("OUT_DIR required unless --dry-run (default without --write)");
  process.exit(1);
}

let tables;
try {
  tables = resolveExportTables(slice);
} catch (err) {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
}

// Neon rejects plaintext; force TLS even if the URL omitted sslmode.
const sql = postgres(url, { max: 1, prepare: false, ssl: "require" });

/**
 * @param {unknown} value
 * @returns {string}
 */
function csvCell(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    return `"${JSON.stringify(value).replaceAll('"', '""')}"`;
  }
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {string[]} [fallbackCols] — when rows are empty, still emit a header if known
 * @returns {string}
 */
function toCsv(rows, fallbackCols = []) {
  if (!rows.length) {
    if (!fallbackCols.length) return "";
    return fallbackCols.join(",") + "\n";
  }
  const cols = Object.keys(rows[0]);
  const lines = [cols.join(",")];
  for (const row of rows) {
    lines.push(cols.map((c) => csvCell(row[c])).join(","));
  }
  return lines.join("\n") + "\n";
}

/**
 * @param {string} table
 * @returns {Promise<{ table: string, count: number, path?: string }>}
 */
async function exportOne(table) {
  if (isDeniedTable(table)) {
    throw new Error(`refusing denied table: ${table}`);
  }
  // Identifier-only: table names come from the allowlist, never from input.
  const countRows = await sql.unsafe(
    `SELECT COUNT(*)::int AS n FROM "${table}"`,
  );
  const count = Number(countRows[0]?.n ?? 0);

  if (dryRun) {
    return { table, count };
  }

  const rows = await sql.unsafe(`SELECT * FROM "${table}"`);
  const partitionDir = join(outDir, `as_of_date=${asOf}`);
  await mkdir(partitionDir, { recursive: true });
  const path = join(partitionDir, `${table}.csv`);
  // Empty tables still need a header for Databricks bronze.
  let headerCols = /** @type {string[]} */ ([]);
  if (!rows.length) {
    const colRows = await sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${table}
      ORDER BY ordinal_position
    `;
    headerCols = colRows.map((r) => String(r.column_name));
  }
  await writeFile(path, toCsv(rows, headerCols), "utf8");
  return { table, count, path };
}

try {
  console.log(
    JSON.stringify({
      mode: dryRun ? "dry-run" : "write",
      slice,
      asOf,
      tables: tables.length,
    }),
  );

  /** @type {{ table: string, count: number, path?: string }[]} */
  const results = [];
  for (const table of tables) {
    const r = await exportOne(table);
    results.push(r);
    console.log(
      `${r.table}\t${r.count}${r.path ? `\t${r.path}` : ""}`,
    );
  }

  const total = results.reduce((n, r) => n + r.count, 0);
  console.log(`total_rows\t${total}`);

  const bucket = process.env.S3_BUCKET;
  const requireS3 = process.env.ERP_SNAPSHOT_REQUIRE_S3 === "true";
  if (!dryRun && bucket) {
    const prefix = (process.env.S3_PREFIX ?? "manut/staging/erp").replace(
      /\/$/,
      "",
    );
    const dest = `s3://${bucket}/${prefix}/as_of_date=${asOf}/`;
    const region = process.env.AWS_REGION ?? "ap-southeast-1";
    console.log(`Uploading ${outDir}/as_of_date=${asOf} → ${dest}`);
    const up = spawnSync(
      "aws",
      [
        "s3",
        "sync",
        join(outDir, `as_of_date=${asOf}`),
        dest,
        "--region",
        region,
        "--only-show-errors",
      ],
      { encoding: "utf8" },
    );
    if (up.status !== 0) {
      console.error(up.stderr || up.stdout || "aws s3 sync failed");
      process.exit(1);
    }
    console.log("s3_upload\tok");
  } else if (!dryRun && !bucket) {
    if (requireS3) {
      console.error("S3_BUCKET required when ERP_SNAPSHOT_REQUIRE_S3=true (write mode in CI)");
      process.exit(1);
    }
    console.log("s3_upload\tskipped (S3_BUCKET unset)");
  }
} finally {
  await sql.end({ timeout: 5 });
}
