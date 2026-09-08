import { usePathname, useRouter, type Href } from "expo-router";
import { X } from "lucide-react-native";
import { useMemo, useState, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppDock } from "@/components/app-dock";
import { AppRail } from "@/components/app-rail";
import { ManutSymbol } from "@/components/brand/manut-symbol";
import { GlassSurface } from "@/components/ui/glass-surface";
import { Text } from "@/components/ui/text";
import { useLayoutMode } from "@/hooks/use-layout-mode";
import { BRAND } from "@/lib/brand";
import { buildTabletRail, DOCK_DESTINATIONS, filterDockDestinations } from "@/lib/dock-nav";
import { DOCK_CONTENT_HEIGHT, SIDEBAR_WIDTH } from "@/lib/glass";
import { EMPLOYEE_NAV_GROUPS, NAV_GROUPS, filterNavGroups, navItemActive } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { useAuth } from "@/store/auth";

export function DashboardShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const mode = useLayoutMode();
  const insets = useSafeAreaInsets();
  const [sheetOpen, setSheetOpen] = useState(false);
  const { user, hasPermission, isEmployeeOnly, logout } = useAuth();

  const groups = useMemo(
    () => filterNavGroups(isEmployeeOnly ? EMPLOYEE_NAV_GROUPS : NAV_GROUPS, hasPermission),
    [hasPermission, isEmployeeOnly],
  );

  const dockItems = useMemo(
    () => filterDockDestinations(DOCK_DESTINATIONS, hasPermission),
    [hasPermission],
  );

  const railItems = useMemo(() => buildTabletRail(hasPermission), [hasPermission]);

  function go(href: string) {
    setSheetOpen(false);
    router.push(href as Href);
  }

  const sidebarWidth = SIDEBAR_WIDTH;

  const navList = (
    <ScrollView className="min-h-0 flex-1" contentContainerClassName="px-3 pb-6">
      {groups.map((group) => (
        <View key={group.label} className="mb-4">
          <Text className="mb-1.5 px-2.5 text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground">
            {group.label}
          </Text>
          <View className="gap-0.5">
            {group.items.map((item) => {
              const active = navItemActive(pathname, item.href);
              return (
                <Pressable
                  key={item.href}
                  accessibilityRole="link"
                  accessibilityLabel={`${item.label} navigation`}
                  accessibilityState={{ selected: active }}
                  onPress={() => go(item.href)}
                  className={cn(
                    "rounded-lg px-2.5 py-2",
                    active ? "bg-intelligence-50/90" : undefined,
                    Platform.select({ web: active ? undefined : "hover:bg-accent/50 transition-colors duration-fast ease-manut" }),
                  )}
                >
                  <Text
                    className={cn(
                      "text-[13px] leading-5",
                      active ? "font-semibold text-intelligence-600" : "text-sidebar-strong",
                    )}
                  >
                    {item.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ))}
    </ScrollView>
  );

  const sidebar = (
    <GlassSurface
      tone="chrome"
      accessibilityLabel="Main navigation"
      className="h-full shrink-0 overflow-hidden border-b-0 border-l-0 border-t-0"
      style={{ width: sidebarWidth, maxWidth: sidebarWidth, flexBasis: sidebarWidth }}
      {...(Platform.OS === "web" ? ({ role: "navigation" } as object) : {})}
    >
      <View className="flex-row items-center gap-3 px-5 pb-4 pt-6">
        <ManutSymbol size={38} />
        <View className="min-w-0 flex-1">
          <Text className="font-display text-[22px] leading-6 text-sidebar-strong">Manut</Text>
          <Text className="text-[11px] text-sidebar-foreground" numberOfLines={1}>
            {user?.name ?? user?.email ?? "Intelligence workspace"}
          </Text>
        </View>
      </View>
      {navList}
      <View className="border-t border-border/60 px-3 py-3">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Sign out"
          className={cn("rounded-lg px-2.5 py-2", Platform.select({ web: "hover:bg-accent/50" }))}
          onPress={async () => {
            await logout();
            router.replace("/(auth)/login");
          }}
        >
          <Text className="text-[13px] text-sidebar-foreground">Sign out</Text>
        </Pressable>
      </View>
    </GlassSurface>
  );

  const sheet = sheetOpen ? (
    <View className="absolute inset-0 z-40 flex-row">
      <GlassSurface
        tone="sheet"
        className="h-full overflow-hidden border-b-0 border-l-0 border-t-0"
        style={{ width: Math.min(sidebarWidth, 300) }}
      >
        <View className="flex-row items-center justify-between gap-3 px-5 pb-3 pt-6">
          <View className="min-w-0 flex-1 flex-row items-center gap-3">
            <ManutSymbol size={32} />
            <Text className="font-display text-[20px] text-sidebar-strong">Manut</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close menu"
            onPress={() => setSheetOpen(false)}
            className="h-10 w-10 items-center justify-center rounded-lg border border-border/70 bg-background/50"
          >
            <X size={18} color={BRAND.ink} />
          </Pressable>
        </View>
        {navList}
        <View className="border-t border-border/60 px-3 py-3">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Sign out"
            className="rounded-lg px-2.5 py-2"
            onPress={async () => {
              await logout();
              router.replace("/(auth)/login");
            }}
          >
            <Text className="text-[13px] text-sidebar-foreground">Sign out</Text>
          </Pressable>
        </View>
      </GlassSurface>
      <Pressable
        accessibilityLabel="Close menu overlay"
        className="min-w-0 flex-1 bg-black/35"
        onPress={() => setSheetOpen(false)}
      />
    </View>
  ) : null;

  const phoneTopBar = (
    <GlassSurface
      tone="chrome"
      accessibilityLabel="Top bar"
      className="z-10 flex-row items-center gap-3 border-b border-l-0 border-r-0 border-t-0 px-4 py-3"
      style={{ paddingTop: Math.max(insets.top, 12) }}
    >
      <ManutSymbol size={30} />
      <View className="min-w-0 flex-1">
        <Text className="text-[15px] font-semibold text-foreground" numberOfLines={1}>
          Manut
        </Text>
        <Text className="text-[11px] text-muted-foreground" numberOfLines={1}>
          {user?.name ? `Hello, ${user.name.split(" ")[0]}` : "Stay clear."}
        </Text>
      </View>
    </GlassSurface>
  );

  const dockBottomInset = DOCK_CONTENT_HEIGHT + Math.max(insets.bottom, 8);

  return (
    <View
      className="flex-1 flex-row bg-background"
      style={Platform.select({
        web: { height: "100%", minHeight: "100%", width: "100%" },
        default: { flex: 1 },
      })}
    >
      {mode === "desktop" ? sidebar : null}
      {mode === "tablet" ? (
        <AppRail
          items={railItems}
          activeHref={pathname}
          onNavigate={go}
          onMore={() => setSheetOpen(true)}
        />
      ) : null}

      <View className="relative min-w-0 flex-1 overflow-hidden bg-background">
        {mode === "phone" ? phoneTopBar : null}
        <View
          className="min-h-0 flex-1"
          style={mode === "phone" ? { paddingBottom: dockBottomInset } : undefined}
          {...(Platform.OS === "web" ? ({ role: "main" } as object) : {})}
        >
          {children}
        </View>

        {mode === "phone" ? (
          <AppDock
            items={dockItems}
            activeHref={pathname}
            onNavigate={go}
            onMore={() => setSheetOpen(true)}
          />
        ) : null}

        {mode !== "desktop" ? sheet : null}
      </View>
    </View>
  );
}
