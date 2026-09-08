#!/usr/bin/env node
/**
 * Inventory edge route files + Express controllers that lack RBAC/session
 * markers. Exit 0 in Wave 0 (report only). Pass --fail to exit 1 when a
 * file is ungated and not on the allowlist (Wave 7).
 *
 * Usage:
 *   node scripts/security/ungated-routes.mjs
 *   node scripts/security/ungated-routes.mjs --json
 *   node scripts/security/ungated-routes.mjs --fail
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "../..");
const asJson = process.argv.includes("--json");
const fail = process.argv.includes("--fail");

const allowlist = JSON.parse(
  readFileSync(join(__dirname, "allowlist.json"), "utf8"),
);

const EDGE_MARKERS = [
  "requirePermission",
  "requireAuth",
  "requireSystemAdmin",
  "verifyCron",
  "verifyLineSignature",
];

const API_MARKERS = [
  "requirePermission",
  "requireAuth",
  "requireSystemAdmin",
  "verifyCronSecret",
  "verifyCron",
  "verifyActionToken",
  "timingSafeEqual",
  "x-hub-signature",
  "x-docusign",
  "webhook",
];

/** @param {string} dir @param {(n: string) => boolean} pred */
function walk(dir, pred, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, pred, out);
    else if (pred(name)) out.push(p);
  }
  return out;
}

function hasAnyMarker(text, markers) {
  return markers.some((m) => text.includes(m));
}

function analyzeEdge() {
  const dir = join(root, "apps/edge/src/routes");
  const files = walk(dir, (n) => n.endsWith(".ts"));
  const allowed = new Set(Object.keys(allowlist.edgeRouteFiles ?? {}));
  /** @type {{ file: string; gated: boolean; allowlisted: boolean; markers: string[] }[]} */
  const rows = [];

  for (const file of files) {
    const base = file.split(/[/\\]/).pop();
    const text = readFileSync(file, "utf8");
    const markers = EDGE_MARKERS.filter((m) => text.includes(m));
    const gated = markers.length > 0;
    const allowlisted = allowed.has(base);
    rows.push({
      file: relative(root, file),
      gated,
      allowlisted,
      markers,
    });
  }

  const unexpected = rows.filter((r) => !r.gated && !r.allowlisted);
  const allowlistedPublic = rows.filter((r) => !r.gated && r.allowlisted);
  return { rows, unexpected, allowlistedPublic };
}

function analyzeApi() {
  const dir = join(root, "apps/api/src/modules");
  const files = walk(dir, (n) => n.endsWith(".controller.ts"));
  const allowed = new Set(Object.keys(allowlist.apiControllers ?? {}));
  /** @type {{ file: string; gated: boolean; allowlisted: boolean; markers: string[] }[]} */
  const rows = [];

  for (const file of files) {
    const rel = relative(join(root, "apps/api/src/modules"), file).replace(
      /\\/g,
      "/",
    );
    const text = readFileSync(file, "utf8");
    const markers = API_MARKERS.filter((m) => text.includes(m));
    // requirePermission is the primary gate; webhook/cron may use other markers
    const gated = hasAnyMarker(text, API_MARKERS);
    const allowlisted = allowed.has(rel);
    rows.push({
      file: relative(root, file),
      gated,
      allowlisted,
      markers,
    });
  }

  const unexpected = rows.filter((r) => !r.gated && !r.allowlisted);
  const allowlistedPublic = rows.filter((r) => !r.gated && r.allowlisted);
  return { rows, unexpected, allowlistedPublic };
}

const edge = analyzeEdge();
const api = analyzeApi();

const report = {
  generatedAt: new Date().toISOString(),
  edge: {
    totalFiles: edge.rows.length,
    gated: edge.rows.filter((r) => r.gated).length,
    allowlistedPublic: edge.allowlistedPublic.map((r) => r.file),
    unexpectedUngated: edge.unexpected.map((r) => r.file),
  },
  api: {
    totalControllers: api.rows.length,
    gated: api.rows.filter((r) => r.gated).length,
    allowlistedPublic: api.allowlistedPublic.map((r) => r.file),
    unexpectedUngated: api.unexpected.map((r) => r.file),
  },
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("Security inventory — ungated routes (Wave 0)\n");
  console.log(
    `Edge route files: ${report.edge.gated}/${report.edge.totalFiles} have auth markers`,
  );
  console.log("  Allowlisted public:");
  for (const f of report.edge.allowlistedPublic) console.log(`    - ${f}`);
  if (report.edge.unexpectedUngated.length === 0) {
    console.log("  Unexpected ungated: (none)");
  } else {
    console.log("  Unexpected ungated:");
    for (const f of report.edge.unexpectedUngated) console.log(`    - ${f}`);
  }

  console.log(
    `\nAPI controllers: ${report.api.gated}/${report.api.totalControllers} have auth markers`,
  );
  console.log("  Allowlisted public / alt-auth:");
  for (const f of report.api.allowlistedPublic) console.log(`    - ${f}`);
  if (report.api.unexpectedUngated.length === 0) {
    console.log("  Unexpected ungated: (none)");
  } else {
    console.log("  Unexpected ungated:");
    for (const f of report.api.unexpectedUngated) console.log(`    - ${f}`);
  }

  console.log(
    "\nAllowlist: scripts/security/allowlist.json — update when adding intentional public surfaces.",
  );
}

const unexpectedCount =
  report.edge.unexpectedUngated.length + report.api.unexpectedUngated.length;

if (fail && unexpectedCount > 0) {
  console.error(
    `\n--fail: ${unexpectedCount} unexpected ungated file(s). Add to allowlist or gate with requirePermission/requireAuth.`,
  );
  process.exit(1);
}
