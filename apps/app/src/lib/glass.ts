import { Platform, type ViewStyle } from "react-native";

export type GlassTone = "chrome" | "control" | "sheet";

export {
  DOCK_CONTENT_HEIGHT,
  RAIL_WIDTH,
  SIDEBAR_WIDTH,
} from "@/lib/glass-tokens";

const FILL: Record<GlassTone, string> = {
  chrome: "var(--glass-chrome)",
  control: "var(--glass-control)",
  sheet: "var(--glass-sheet)",
};

const BLUR: Record<GlassTone, string> = {
  chrome: "var(--glass-blur-chrome)",
  control: "var(--glass-blur-control)",
  sheet: "var(--glass-blur-sheet)",
};

/** Opaque native fallbacks when CSS variables / backdrop-filter are unavailable. */
const NATIVE_FILL: Record<GlassTone, string> = {
  chrome: "rgba(255,255,255,0.94)",
  control: "rgba(255,255,255,0.9)",
  sheet: "rgba(255,255,255,0.96)",
};

/**
 * Manut Liquid Glass styles — frosted chrome only (docs/LIQUID_GLASS.md).
 * Web uses CSS vars + backdrop-filter; native uses a near-opaque white fill.
 */
export function glassStyle(tone: GlassTone = "chrome"): ViewStyle {
  if (Platform.OS !== "web") {
    return {
      backgroundColor: NATIVE_FILL[tone],
      borderColor: "rgba(227,226,220,0.9)",
    };
  }

  const blur = `blur(${BLUR[tone]})`;
  return {
    backgroundColor: FILL[tone],
    borderColor: "var(--glass-border)",
    backdropFilter: blur,
    ...( { WebkitBackdropFilter: blur } as object ),
  } as ViewStyle;
}
