import { DESKTOP_MIN, TABLET_MIN } from "@/lib/breakpoints";

export type LayoutMode = "phone" | "tablet" | "desktop";

export function layoutModeForWidth(width: number): LayoutMode {
  if (width >= DESKTOP_MIN) return "desktop";
  if (width >= TABLET_MIN) return "tablet";
  return "phone";
}
