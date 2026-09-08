import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const dist = resolve("dist");
const index = resolve(dist, "index.html");
mkdirSync(dist, { recursive: true });
try {
  // Atomic create-if-absent ("wx") instead of existsSync-then-write, avoiding a
  // check-then-act TOCTOU (CodeQL js/file-system-race). A real Expo export must
  // never be clobbered by this placeholder.
  writeFileSync(
    index,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Manut</title></head><body><main><h1>Manut</h1><p>Run pnpm --filter @nexora/app export:web</p></main></body></html>\n`,
    { flag: "wx" },
  );
  console.log("wrote placeholder dist/index.html");
} catch (err) {
  if (err.code === "EEXIST") process.exit(0);
  throw err;
}
