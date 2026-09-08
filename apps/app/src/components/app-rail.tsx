import { Pressable, View } from "react-native";
import { GlassSurface } from "@/components/ui/glass-surface";
import { Text } from "@/components/ui/text";
import { BRAND } from "@/lib/brand";
import { DOCK_ICONS } from "@/lib/dock-icons";
import type { DockDestinationDef } from "@/lib/dock-nav";
import { RAIL_WIDTH } from "@/lib/glass";
import { cn } from "@/lib/utils";

export function AppRail({
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
  return (
    <GlassSurface
      tone="chrome"
      accessibilityLabel="Primary navigation rail"
      className="h-full shrink-0 overflow-hidden border-b-0 border-l-0 border-t-0"
      style={{ width: RAIL_WIDTH, maxWidth: RAIL_WIDTH, flexBasis: RAIL_WIDTH }}
    >
      <View className="flex-1 items-center gap-1 px-1.5 pb-4 pt-4">
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
              accessibilityRole="button"
              accessibilityState={{ selected: Boolean(active) }}
              accessibilityLabel={item.label}
              onPress={() => {
                if (item.opensMore) onMore();
                else if (item.href) onNavigate(item.href);
              }}
              className={cn(
                "w-full items-center gap-0.5 rounded-xl px-1 py-2",
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
                  "text-[9px] font-medium",
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
