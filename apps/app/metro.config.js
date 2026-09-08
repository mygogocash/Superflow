const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = withNativeWind(getDefaultConfig(projectRoot), {
  input: "./global.css",
  inlineRem: 16,
});

config.watchFolders = [...new Set([...(config.watchFolders ?? []), workspaceRoot])];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
const appReact = path.resolve(projectRoot, "node_modules/react");
const appReactDom = path.resolve(projectRoot, "node_modules/react-dom");

config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules ?? {}),
  "react-native-css-interop": path.resolve(projectRoot, "node_modules/react-native-css-interop"),
  // Monorepo can hoist a second React (e.g. 19.2.x via Next/web). Two copies
  // in the web export blank the SPA: ExpoRoot's useMemo hits a null dispatcher.
  react: appReact,
  "react-dom": appReactDom,
};

// pnpm + Metro cannot follow css-interop's nested jsx-runtime/package.json
// (`main: "../dist/runtime/jsx-runtime"`). NativeWind babel injects that
// specifier into every JSX file.
const previousResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    moduleName === "react-native-css-interop/jsx-runtime" ||
    moduleName === "react-native-css-interop/jsx-dev-runtime"
  ) {
    return {
      type: "sourceFile",
      filePath: require.resolve(moduleName, { paths: [projectRoot] }),
    };
  }
  // Force every `react` / `react-dom` (and subpath) import onto the app copy.
  if (moduleName === "react" || moduleName.startsWith("react/")) {
    return {
      type: "sourceFile",
      filePath: require.resolve(moduleName, { paths: [projectRoot] }),
    };
  }
  if (moduleName === "react-dom" || moduleName.startsWith("react-dom/")) {
    return {
      type: "sourceFile",
      filePath: require.resolve(moduleName, { paths: [projectRoot] }),
    };
  }
  if (previousResolveRequest) {
    return previousResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
