import { usePathname, useRouter, type Href } from "expo-router";
import { ChevronDown, LogOut, Menu, Search, X } from "lucide-react-native";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, TextInput, View } from "react-native";
import { ManutSymbol } from "@/components/brand/manut-symbol";
import { ToastHost } from "@/components/toast-host";
import { Text } from "@/components/ui/text";
import { TABLET_MIN, useViewportWidth } from "@/hooks/use-viewport-width";
import { BRAND } from "@/lib/brand";
import { cn } from "@/lib/utils";
import {
  EMPLOYEE_NAV_GROUPS,
  NAV_GROUPS,
  filterNavGroups,
  navItemActive,
  type NavGroup,
} from "@/lib/nav";
import { useAuth } from "@/store/auth";

const SIDEBAR_WIDTH = 264;
const COLLAPSE_STORAGE_KEY = "manut.nav.collapsed.v1";

function readStoredCollapse(): Record<string, boolean> {
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(COLLAPSE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      localStorage.removeItem(COLLAPSE_STORAGE_KEY);
      return {};
    }
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "boolean") out[k] = v;
    }
    return out;
  } catch {
    try {
      localStorage.removeItem(COLLAPSE_STORAGE_KEY);
    } catch {
      // ignore
    }
    return {};
  }
}

function writeStoredCollapse(value: Record<string, boolean>) {
  if (Platform.OS !== "web" || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // ignore quota / private mode
  }
}

function filterGroupsByQuery(groups: NavGroup[], query: string): NavGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) =>
          item.label.toLowerCase().includes(q) ||
          item.href.toLowerCase().includes(q) ||
          group.label.toLowerCase().includes(q),
      ),
    }))
    .filter((group) => group.items.length > 0);
}

function NavGroupBlock({
  group,
  pathname,
  collapsed,
  onToggle,
  onNavigate,
}: {
  group: NavGroup;
  pathname: string;
  collapsed: boolean;
  onToggle: () => void;
  onNavigate: (href: string) => void;
}) {
  return (
    <View className="mb-3">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: !collapsed }}
        onPress={onToggle}
        className={cn(
          "mb-1 flex-row items-center justify-between rounded-md px-2.5 py-1.5",
          Platform.select({ web: "hover:bg-accent/50 transition-colors duration-fast ease-manut" }),
        )}
      >
        <Text className="text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground">
          {group.label}
        </Text>
        <ChevronDown
          size={14}
          color={BRAND.stone700}
          style={{ transform: [{ rotate: collapsed ? "-90deg" : "0deg" }] }}
        />
      </Pressable>
      {collapsed ? null : (
        <View className="gap-0.5">
          {group.items.map((item) => {
            const active = navItemActive(pathname, item.href);
            const Icon = item.icon;
            return (
              <Pressable
                key={item.href}
                accessibilityRole="link"
                accessibilityLabel={item.label}
                accessibilityState={{ selected: active }}
                {...(Platform.OS === "web"
                  ? ({ "aria-current": active ? "page" : undefined } as object)
                  : {})}
                onPress={() => onNavigate(item.href)}
                className={cn(
                  "flex-row items-center gap-2.5 rounded-md px-2.5 py-2",
                  active ? "bg-accent" : undefined,
                  Platform.select({
                    web: cn(
                      "transition-colors duration-fast ease-manut",
                      active ? undefined : "hover:bg-accent/60",
                    ),
                  }),
                )}
              >
                {Icon ? (
                  <Icon
                    size={16}
                    color={active ? BRAND.intelligence : BRAND.stone700}
                    strokeWidth={active ? 2.25 : 1.75}
                  />
                ) : null}
                <Text
                  className={cn(
                    "flex-1 text-[13px] leading-5",
                    active ? "font-semibold text-sidebar-primary" : "text-sidebar-strong",
                  )}
                  numberOfLines={1}
                >
                  {item.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}
    </View>
  );
}

export function DashboardShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const viewportWidth = useViewportWidth();
  const isWide = viewportWidth >= TABLET_MIN;
  const sidebarWidth = isWide ? SIDEBAR_WIDTH : Math.min(280, Math.max(240, viewportWidth - 56));
  const [open, setOpen] = useState(false);
  const [navQuery, setNavQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const { user, hasPermission, isEmployeeOnly, logout } = useAuth();

  const groups = useMemo(
    () => filterNavGroups(isEmployeeOnly ? EMPLOYEE_NAV_GROUPS : NAV_GROUPS, hasPermission),
    [hasPermission, isEmployeeOnly],
  );

  const visibleGroups = useMemo(() => filterGroupsByQuery(groups, navQuery), [groups, navQuery]);

  const [collapsedByLabel, setCollapsedByLabel] = useState<Record<string, boolean>>(() =>
    readStoredCollapse(),
  );

  useEffect(() => {
    setCollapsedByLabel((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const group of groups) {
        if (next[group.label] === undefined) {
          next[group.label] = Boolean(group.defaultCollapsed);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [groups]);

  useEffect(() => {
    writeStoredCollapse(collapsedByLabel);
  }, [collapsedByLabel]);

  function go(href: string) {
    setOpen(false);
    setSearchOpen(false);
    setNavQuery("");
    router.push(href as Href);
  }

  const searching = navQuery.trim().length > 0;

  const sidebar = (
    <View
      accessibilityLabel="Main navigation"
      className="h-full shrink-0 overflow-hidden border-r border-sidebar-border bg-sidebar"
      style={{ width: sidebarWidth, maxWidth: sidebarWidth, flexBasis: sidebarWidth }}
      {...(Platform.OS === "web" ? ({ role: "navigation" } as object) : {})}
    >
      <View className="flex-row items-center gap-3 px-5 pb-3 pt-6">
        <ManutSymbol size={36} />
        <View className="min-w-0 flex-1">
          <Text className="font-display text-[22px] leading-6 text-sidebar-strong">Manut</Text>
          <Text className="text-[11px] text-sidebar-foreground" numberOfLines={1}>
            Intelligence workspace
          </Text>
        </View>
      </View>
      <View className="mb-2 px-3">
        <View className="flex-row items-center gap-2 rounded-md border border-sidebar-border bg-background/60 px-2.5 py-1.5">
          <Search size={14} color={BRAND.stone700} />
          <TextInput
            accessibilityLabel="Filter navigation"
            value={navQuery}
            onChangeText={setNavQuery}
            placeholder="Filter nav…"
            placeholderTextColor={BRAND.stone500}
            className="min-h-8 flex-1 text-[13px] text-sidebar-strong"
            {...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {})}
          />
          {navQuery ? (
            <Pressable accessibilityLabel="Clear nav filter" onPress={() => setNavQuery("")}>
              <X size={14} color={BRAND.stone700} />
            </Pressable>
          ) : null}
        </View>
      </View>
      <ScrollView className="min-h-0 flex-1" contentContainerClassName="px-3 pb-6">
        {visibleGroups.length === 0 ? (
          <Text className="px-2 py-4 text-[13px] text-sidebar-foreground">No matching pages</Text>
        ) : (
          visibleGroups.map((group) => (
            <NavGroupBlock
              key={group.label}
              group={group}
              pathname={pathname}
              collapsed={searching ? false : Boolean(collapsedByLabel[group.label])}
              onToggle={() =>
                setCollapsedByLabel((prev) => ({
                  ...prev,
                  [group.label]: !prev[group.label],
                }))
              }
              onNavigate={go}
            />
          ))
        )}
      </ScrollView>
      <View className="border-t border-sidebar-border px-3 py-3">
        <View className="mb-2 px-2.5">
          <Text className="text-[12px] font-medium text-sidebar-strong" numberOfLines={1}>
            {user?.name ?? "Signed in"}
          </Text>
          <Text className="text-[11px] text-sidebar-foreground" numberOfLines={1}>
            {user?.email}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Sign out"
          className={cn(
            "flex-row items-center gap-2 rounded-md px-2.5 py-2",
            Platform.select({ web: "hover:bg-accent/60 transition-colors duration-fast ease-manut" }),
          )}
          onPress={async () => {
            await logout();
            router.replace("/(auth)/login");
          }}
        >
          <LogOut size={16} color={BRAND.stone700} />
          <Text className="text-[13px] text-sidebar-foreground">Sign out</Text>
        </Pressable>
      </View>
    </View>
  );

  return (
    <View
      className="flex-1 flex-row bg-background"
      style={Platform.select({
        web: { height: "100%", minHeight: "100%", width: "100%" },
        default: { flex: 1 },
      })}
    >
      {isWide ? sidebar : null}
      <View className="relative min-w-0 flex-1 overflow-hidden bg-background">
        <View
          accessibilityLabel="Top bar"
          className="z-10 flex-row items-center gap-3 border-b border-border bg-card/95 px-4 py-3"
          style={
            Platform.OS === "web"
              ? ({ backdropFilter: "blur(8px)" } as object)
              : undefined
          }
        >
          {isWide ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={open ? "Close menu" : "Open menu"}
              onPress={() => setOpen((v) => !v)}
              className="h-10 w-10 items-center justify-center rounded-md border border-border bg-background"
            >
              {open ? <X size={18} color={BRAND.ink} /> : <Menu size={18} color={BRAND.ink} />}
            </Pressable>
          )}
          <View className="min-w-0 flex-1">
            <Text className="text-[15px] font-semibold text-foreground" numberOfLines={1}>
              {user?.name ? `Hello, ${user.name.split(" ")[0]}` : "Manut"}
            </Text>
            <Text className="text-[12px] text-muted-foreground" numberOfLines={1}>
              Stay clear. Act with confidence.
            </Text>
          </View>
          {searchOpen && isWide ? (
            <View className="h-10 w-56 flex-row items-center gap-2 rounded-md border border-border bg-background px-3">
              <Search size={16} color={BRAND.stone700} />
              <TextInput
                accessibilityLabel="Filter navigation"
                autoFocus
                value={navQuery}
                onChangeText={setNavQuery}
                placeholder="Filter nav…"
                placeholderTextColor={BRAND.stone500}
                className="min-h-8 flex-1 text-[13px] text-foreground"
                {...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {})}
              />
              <Pressable
                accessibilityLabel="Close search"
                onPress={() => {
                  setSearchOpen(false);
                  setNavQuery("");
                }}
              >
                <X size={14} color={BRAND.stone700} />
              </Pressable>
            </View>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Search navigation"
              onPress={() => {
                if (!isWide) {
                  setOpen(true);
                  return;
                }
                setSearchOpen(true);
              }}
              className="h-10 flex-row items-center gap-2 rounded-md border border-border bg-background px-3"
            >
              <Search size={16} color={BRAND.stone700} />
              {isWide ? (
                <Text className="text-[13px] text-muted-foreground">Search</Text>
              ) : null}
            </Pressable>
          )}
        </View>
        <View
          className="min-h-0 flex-1"
          {...(Platform.OS === "web" ? ({ role: "main" } as object) : {})}
        >
          {children}
        </View>
        <ToastHost />
        {!isWide && open ? (
          <View className="absolute inset-0 z-20 flex-row">
            {sidebar}
            <Pressable
              accessibilityLabel="Close menu overlay"
              className="min-w-0 flex-1 bg-black/40"
              onPress={() => setOpen(false)}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}
