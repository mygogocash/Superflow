import type { ComponentProps } from "react";
import { View } from "react-native";
import { glassStyle, type GlassTone } from "@/lib/glass";
import { cn } from "@/lib/utils";

type GlassSurfaceProps = ComponentProps<typeof View> & {
  tone?: GlassTone;
};

/**
 * Frosted chrome surface for shell / dock / floating controls.
 * Content cards should stay opaque `Card` — do not wrap tables in this.
 */
function GlassSurface({ tone = "chrome", className, style, ...props }: GlassSurfaceProps) {
  return (
    <View
      className={cn("border", className)}
      style={[glassStyle(tone), style]}
      {...props}
    />
  );
}

export { GlassSurface };
export type { GlassSurfaceProps };
