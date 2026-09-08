#!/usr/bin/env node
/**
 * Fail closed after `expo export -p web` if the web bundle looks broken.
 * Staging went blank when Metro embedded two React copies (19.1.0 + 19.2.8) —
 * ExpoRoot then calls useMemo against a null dispatcher ("Cannot read
 * properties of null (reading 'useMemo')") and #root stays empty.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const dist = resolve("dist");
const indexPath = resolve(dist, "index.html");
const jsDir = resolve(dist, "_expo/static/js/web");

function fail(msg) {
  console.error(`verify-spa-bundle: ${msg}`);
  process.exit(1);
}

/** Keep in sync with `src/lib/spa-react-versions.ts` (tests import the TS copy). */
export function collectReactVersions(body) {
  const versions = new Set();
  for (const m of body.matchAll(/\.version\s*=\s*["'](19\.\d+\.\d+)["']/g)) {
    versions.add(m[1]);
  }
  return [...versions].sort();
}

function main() {
  if (!existsSync(indexPath)) fail("dist/index.html missing — export did not produce an SPA");

  const index = readFileSync(indexPath, "utf8");
  if (index.includes("Run pnpm --filter @nexora/app export:web")) {
    fail("dist/index.html is the ensure-spa-dist placeholder, not a real export");
  }
  if (!index.includes('id="root"') && !index.includes("id='root'")) {
    fail("dist/index.html has no #root mount node");
  }

  if (!existsSync(jsDir)) fail("_expo/static/js/web missing");
  const entries = readdirSync(jsDir).filter((f) => /^entry-.*\.js$/.test(f));
  if (entries.length === 0) fail("no entry-*.js web bundle");

  for (const name of entries) {
    const body = readFileSync(resolve(jsDir, name), "utf8");
    if (body.length < 100_000) {
      fail(`${name} is suspiciously small (${body.length} bytes)`);
    }
    const versions = collectReactVersions(body);
    if (versions.length === 0) {
      fail(`${name} has no React 19 version marker — unexpected Metro output`);
    }
    if (versions.length > 1) {
      fail(
        `${name} embeds multiple React copies (${versions.join(", ")}). ` +
          "Duplicate React breaks Expo Router hooks on web (null dispatcher / useMemo).",
      );
    }
  }

  console.log(`verify-spa-bundle: ok (${entries.join(", ")})`);
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectRun) main();
