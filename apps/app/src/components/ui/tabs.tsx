import { createContext, use, useMemo, type ReactNode } from "react";
import { Platform, Pressable, View } from "react-native";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

type TabsContextValue = {
  value: string;
  onValueChange: (value: string) => void;
};

const TabsContext = createContext<TabsContextValue | null>(null);

function Tabs({
  value,
  onValueChange,
  children,
  className,
}: {
  value: string;
  onValueChange: (value: string) => void;
  children: ReactNode;
  className?: string;
}) {
  const ctx = useMemo(() => ({ value, onValueChange }), [value, onValueChange]);
  return (
    <TabsContext.Provider value={ctx}>
      <View className={cn("gap-3", className)}>{children}</View>
    </TabsContext.Provider>
  );
}

function TabsList({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <View
      accessibilityRole="tablist"
      className={cn("flex-row gap-1 self-start rounded-[10px] border border-border bg-muted p-1", className)}
    >
      {children}
    </View>
  );
}

function TabsTrigger({
  value,
  children,
}: {
  value: string;
  children: string;
}) {
  const ctx = use(TabsContext);
  if (!ctx) throw new Error("TabsTrigger must be used within Tabs");
  const active = ctx.value === value;
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      onPress={() => ctx.onValueChange(value)}
      className={cn(
        "h-8 items-center justify-center rounded-md px-3",
        active ? "bg-card" : undefined,
        Platform.select({
          web: cn(
            "transition-colors duration-fast ease-manut",
            active ? undefined : "hover:bg-card/70",
          ),
        }),
      )}
    >
      <Text
        className={cn(
          "text-[13px]",
          active ? "font-semibold text-foreground" : "font-medium text-muted-foreground",
        )}
      >
        {children}
      </Text>
    </Pressable>
  );
}

function TabsContent({
  value,
  children,
  className,
}: {
  value: string;
  children: ReactNode;
  className?: string;
}) {
  const ctx = use(TabsContext);
  if (!ctx) throw new Error("TabsContent must be used within Tabs");
  if (ctx.value !== value) return null;
  return <View className={cn("min-h-0 flex-1", className)}>{children}</View>;
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
