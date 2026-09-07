import { Pressable, View } from "react-native";
import { Text } from "@/components/ui/text";
import { shadowMd } from "@/lib/shadow";
import { useToastStore } from "@/lib/toast";
import { cn } from "@/lib/utils";

export function ToastHost() {
  const items = useToastStore((s) => s.items);
  const dismiss = useToastStore((s) => s.dismiss);
  if (items.length === 0) return null;

  return (
    <View
      pointerEvents="box-none"
      className="absolute bottom-6 left-0 right-0 z-50 items-center gap-2 px-4"
    >
      {items.map((item) => (
        <Pressable
          key={item.id}
          accessibilityRole="button"
          accessibilityLabel={item.message}
          onPress={() => dismiss(item.id)}
          style={shadowMd}
          className={cn(
            "max-w-md rounded-xl border px-4 py-3",
            item.variant === "error"
              ? "border-destructive/30 bg-destructive"
              : item.variant === "success"
                ? "border-border bg-primary"
                : "border-border bg-card",
          )}
        >
          <Text
            className={cn(
              "text-center text-[13px] font-medium",
              item.variant === "error" || item.variant === "success"
                ? "text-primary-foreground"
                : "text-foreground",
            )}
          >
            {item.message}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
