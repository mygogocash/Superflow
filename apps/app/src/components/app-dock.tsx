import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GlassSurface } from "@/components/ui/glass-surface";
import { Text } from "@/components/ui/text";
import { BRAND } from "@/lib/brand";
import { DOCK_ICONS } from "@/lib/dock-icons";
import type { DockDestinationDef } from "@/lib/dock-nav";
import { DOCK_CONTENT_HEIGHT } from "@/lib/glass";
import { cn } from "@/lib/utils";

export function AppDock({
  items,
  activeHref,
  onNavigate,
  onMore,
}: {
  items: DockDestinationDef[];
  activeHref: string;
  onNavigate: (href: string) => void;
  onMore: () => void;
}) {
  const insets = useSafeAreaInsets();
  const bottomPad = Math.max(insets.bottom, 8);

  return (
    <GlassSurface
      tone="chrome"
      accessibilityLabel="Primary navigation dock"
      className="absolute bottom-0 left-0 right-0 z-30 border-b-0 border-l-0 border-r-0 border-t"
      style={{ paddingBottom: bottomPad }}
    >
      <View
        className="flex-row items-stretch justify-around px-1 pt-1"
        style={{ minHeight: DOCK_CONTENT_HEIGHT }}
        {...({ role: "tablist" } as object)}
      >
        {items.map((item) => {
          const active =
            !item.opensMore &&
            item.href != null &&
            (activeHref === item.href ||
              (item.href !== "/" && activeHref.startsWith(`${item.href}/`)) ||
              (item.href === "/dashboard" && (activeHref === "/" || activeHref === "/dashboard")));
          const Icon = DOCK_ICONS[item.id];
          return (
            <Pressable
              key={item.id}
              accessibilityRole="tab"
              accessibilityState={{ selected: Boolean(active) }}
              accessibilityLabel={item.label}
              onPress={() => {
                if (item.opensMore) onMore();
                else if (item.href) onNavigate(item.href);
              }}
              className={cn(
                "min-w-[64px] flex-1 items-center justify-center gap-0.5 rounded-lg px-1 py-1.5",
                active ? "bg-intelligence-50/80" : undefined,
              )}
            >
              <Icon
                size={22}
                color={active ? BRAND.intelligence : BRAND.stone700}
                strokeWidth={active ? 2.25 : 1.75}
              />
              <Text
                className={cn(
                  "text-[10px] font-medium",
                  active ? "text-intelligence-600" : "text-muted-foreground",
                )}
                numberOfLines={1}
              >
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </GlassSurface>
  );
}
