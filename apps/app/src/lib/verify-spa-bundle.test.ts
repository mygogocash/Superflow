import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectReactVersions } from "./spa-react-versions";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "../..");

describe("verify-spa-bundle React version scan", () => {
  it("flags a dual-React Metro entry the way staging crashed", () => {
    const dual = [
      'e.useMemo=function(t,n){return H.H.useMemo(t,n)},e.version="19.1.0"',
      'e.useMemo=function(t,n){return C.H.useMemo(t,n)},e.version="19.2.8"',
    ].join("\n");
    expect(collectReactVersions(dual)).toEqual(["19.1.0", "19.2.8"]);
  });

  it("accepts a single React copy", () => {
    const single = 'e.useMemo=function(t,n){return H.H.useMemo(t,n)},e.version="19.1.0"';
    expect(collectReactVersions(single)).toEqual(["19.1.0"]);
  });
});

describe("metro singleton React pin", () => {
  it("resolves react and react-dom to the app package copies", () => {
    const appReact = resolve(appRoot, "node_modules/react/package.json");
    const appReactDom = resolve(appRoot, "node_modules/react-dom/package.json");
    expect(JSON.parse(readFileSync(appReact, "utf8")).version).toBe("19.1.0");
    expect(JSON.parse(readFileSync(appReactDom, "utf8")).version).toBe("19.1.0");

    const metro = require("../../metro.config.js") as {
      resolver: {
        extraNodeModules: Record<string, string>;
        resolveRequest: (
          context: unknown,
          moduleName: string,
          platform: string | null,
        ) => { type: string; filePath: string };
      };
    };
    expect(metro.resolver.extraNodeModules.react).toBe(resolve(appRoot, "node_modules/react"));
    expect(metro.resolver.extraNodeModules["react-dom"]).toBe(
      resolve(appRoot, "node_modules/react-dom"),
    );

    const resolved = metro.resolver.resolveRequest({}, "react", "web");
    expect(resolved.type).toBe("sourceFile");
    expect(resolved.filePath).toBe(require.resolve("react", { paths: [appRoot] }));
  });
});
