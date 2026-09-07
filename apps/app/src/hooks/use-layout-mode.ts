import { layoutModeForWidth, type LayoutMode } from "@/lib/layout-mode";
import { useViewportWidth } from "@/hooks/use-viewport-width";

export type { LayoutMode };
export { layoutModeForWidth };

export function useLayoutMode(): LayoutMode {
  return layoutModeForWidth(useViewportWidth());
}
