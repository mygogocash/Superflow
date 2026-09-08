/**
 * Metro minifies React as `e.version="19.x.y"` — one unique version per copy.
 * Used by `scripts/verify-spa-bundle.mjs` (keep the regex in sync) and unit tests.
 */
export function collectReactVersions(body: string): string[] {
  const versions = new Set<string>();
  for (const m of body.matchAll(/\.version\s*=\s*["'](19\.\d+\.\d+)["']/g)) {
    versions.add(m[1]!);
  }
  return [...versions].sort();
}
