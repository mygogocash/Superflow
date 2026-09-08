import type { ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Text } from "@/components/ui/text";
import { useLayoutMode } from "@/hooks/use-layout-mode";
import { DOCK_CONTENT_HEIGHT } from "@/lib/glass";
import { cn } from "@/lib/utils";

export function PageScreen({
  title,
  subtitle,
  children,
  scroll = true,
  className,
  actions,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  scroll?: boolean;
  className?: string;
  /** Primary page actions rendered beside the title. */
  actions?: ReactNode;
}) {
  const mode = useLayoutMode();
  const insets = useSafeAreaInsets();
  const compact = mode === "phone";
  const pad = compact ? "px-4 py-5" : "px-6 py-6";
  // Shell already pads the main column for the dock; only add light scroll end space.
  const scrollEndPad = mode === "phone" ? Math.max(insets.bottom, 8) + 8 : 0;
  const header = (
    <View className="mb-5 flex-row items-start justify-between gap-3">
      <View className="min-w-0 flex-1 gap-1">
        <Text className={cn("font-bold tracking-tight text-foreground", compact ? "text-[22px]" : "text-[26px]")}>
          {title}
        </Text>
        {subtitle ? <Text className="max-w-[42rem] text-[15px] leading-6 text-muted-foreground">{subtitle}</Text> : null}
      </View>
      {actions ? <View className="shrink-0 pt-0.5">{actions}</View> : null}
    </View>
  );

  if (!scroll) {
    return (
      <View className={cn("flex-1 bg-background", pad, className)}>
        {header}
        <View className="min-h-0 flex-1">{children}</View>
      </View>
    );
  }

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName={cn(pad, className)}
      contentContainerStyle={scrollEndPad ? { paddingBottom: scrollEndPad } : undefined}
    >
      {header}
      {children}
    </ScrollView>
  );
}

/** Re-export for callers that need dock clearance outside PageScreen. */
export { DOCK_CONTENT_HEIGHT };
