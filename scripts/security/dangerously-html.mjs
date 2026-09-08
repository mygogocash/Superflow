#!/usr/bin/env node
/**
 * Inventory dangerouslySetInnerHTML / RichHtml call sites and whether a
 * sanitizer appears on the same line / nearby in the same file.
 *
 * Usage:
 *   node scripts/security/dangerously-html.mjs
 *   node scripts/security/dangerously-html.mjs --json
 *   node scripts/security/dangerously-html.mjs --fail   # exit 1 if any "unsanitized" hits
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "../..");
const asJson = process.argv.includes("--json");
const fail = process.argv.includes("--fail");

const SCAN_ROOTS = [
  join(root, "apps/web/src"),
  join(root, "apps/app/src"),
  join(root, "apps/app/app"),
];

const FILE_RE = /\.(tsx|ts|jsx|js)$/;
const SINK_RE =
  /dangerouslySetInnerHTML|RichHtml\s*[<(]|from\s+['"][^'"]*rich-html['"]/g;
const SANITIZER_RE =
  /sanitizeRichHtml|sanitizeHtml|DOMPurify|escapeHtml|escapeHTML/;

/** @param {string} dir */
function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) {
      continue;
    }
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (FILE_RE.test(name)) out.push(p);
  }
  return out;
}

/** @type {{ file: string; line: number; snippet: string; sanitizedNearby: boolean; kind: string }[]} */
const hits = [];

for (const scanRoot of SCAN_ROOTS) {
  for (const file of walk(scanRoot)) {
    const text = readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/);
    const fileHasSanitizer = SANITIZER_RE.test(text);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (
        !line.includes("dangerouslySetInnerHTML") &&
        !/\bRichHtml\b/.test(line)
      ) {
        continue;
      }
      // Skip type-only / comments that mention the API without using it
      if (/^\s*(\/\/|\*|\/\*)/.test(line) && !line.includes("__html")) {
        continue;
      }

      const window = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 3)).join("\n");
      const sanitizedNearby =
        SANITIZER_RE.test(window) ||
        (fileHasSanitizer && line.includes("sanitizeRichHtml"));

      let kind = "dangerouslySetInnerHTML";
      if (/\bRichHtml\b/.test(line)) kind = "RichHtml";

      hits.push({
        file: relative(root, file),
        line: i + 1,
        snippet: line.trim().slice(0, 160),
        sanitizedNearby,
        kind,
      });
    }
  }
}

const unsanitized = hits.filter((h) => !h.sanitizedNearby);

const report = {
  generatedAt: new Date().toISOString(),
  totalHits: hits.length,
  withSanitizerNearby: hits.filter((h) => h.sanitizedNearby).length,
  unsanitizedNearby: unsanitized.length,
  hits,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("Security inventory — HTML sinks (Wave 0)\n");
  console.log(
    `Found ${report.totalHits} sink(s); ${report.withSanitizerNearby} with sanitizer nearby; ${report.unsanitizedNearby} without.\n`,
  );
  for (const h of hits) {
    const flag = h.sanitizedNearby ? "ok " : "REVIEW";
    console.log(`[${flag}] ${h.file}:${h.line} (${h.kind})`);
    console.log(`         ${h.snippet}`);
  }
  if (unsanitized.length > 0) {
    console.log(
      "\nWave 5: confirm REVIEW rows are static CSS, caller-sanitized, or need sanitizeRichHtml.",
    );
  }
}

if (fail && unsanitized.length > 0) {
  console.error(
    `\n--fail: ${unsanitized.length} HTML sink(s) without nearby sanitizer.`,
  );
  process.exit(1);
}
