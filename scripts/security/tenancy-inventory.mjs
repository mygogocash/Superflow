#!/usr/bin/env node
/**
 * Inventory Prisma models with vs without `organizationId`.
 *
 * Wave 3 tenancy readiness: only OrganizationMembership (+ optional Entity)
 * are org-scoped today. Everything else is tenancy debt until backfilled.
 *
 * Usage:
 *   node scripts/security/tenancy-inventory.mjs
 *   node scripts/security/tenancy-inventory.mjs --json
 *   node scripts/security/tenancy-inventory.mjs --fail-if-empty-with
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "../..");
const schemaDir = join(root, "packages/database/prisma/schema");
const asJson = process.argv.includes("--json");
const failIfEmptyWith = process.argv.includes("--fail-if-empty-with");

/** @type {{ model: string; file: string; hasOrganizationId: boolean }[]} */
const models = [];

for (const name of readdirSync(schemaDir).sort()) {
  if (!name.endsWith(".prisma")) continue;
  const file = join(schemaDir, name);
  const text = readFileSync(file, "utf8");
  let current = null;
  let hasOrg = false;
  for (const line of text.split("\n")) {
    const start = line.match(/^model\s+(\w+)\s*\{/);
    if (start) {
      if (current) {
        models.push({
          model: current,
          file: relative(root, file),
          hasOrganizationId: hasOrg,
        });
      }
      current = start[1];
      hasOrg = false;
      continue;
    }
    if (current && /^\s*\}/.test(line)) {
      models.push({
        model: current,
        file: relative(root, file),
        hasOrganizationId: hasOrg,
      });
      current = null;
      hasOrg = false;
      continue;
    }
    if (current && /(^|\s)organizationId(\s|$)/.test(line)) {
      hasOrg = true;
    }
  }
}

const withOrg = models.filter((m) => m.hasOrganizationId);
const withoutOrg = models.filter((m) => !m.hasOrganizationId);

if (asJson) {
  console.log(
    JSON.stringify(
      {
        total: models.length,
        withOrganizationId: withOrg.map((m) => m.model),
        withoutOrganizationId: withoutOrg.map((m) => m.model),
      },
      null,
      2,
    ),
  );
} else {
  console.log(`Prisma models: ${models.length}`);
  console.log(`With organizationId (${withOrg.length}):`);
  for (const m of withOrg) console.log(`  - ${m.model}  (${m.file})`);
  console.log(`Without organizationId (${withoutOrg.length}) — tenancy debt`);
  console.log(
    `  (first 25) ${withoutOrg
      .slice(0, 25)
      .map((m) => m.model)
      .join(", ")}${withoutOrg.length > 25 ? ", …" : ""}`,
  );
}

if (failIfEmptyWith && withOrg.length === 0) {
  console.error("Expected at least one model with organizationId");
  process.exit(1);
}
