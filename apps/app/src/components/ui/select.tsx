import type { ReactNode } from "react";
import { Platform, Pressable, View } from "react-native";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

export type SelectOption = { value: string; label: string };

function SelectChips({
  value,
  onValueChange,
  options,
  className,
}: {
  value: string | null;
  onValueChange: (value: string) => void;
  options: SelectOption[];
  className?: string;
}) {
  return (
    <View className={cn("flex-row flex-wrap gap-2", className)}>
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={() => onValueChange(opt.value)}
            className={cn(
              "rounded-full border px-3 py-1.5",
              selected ? "border-primary bg-primary" : "border-border bg-card",
              Platform.select({
                web: cn(
                  "transition-colors duration-fast ease-manut",
                  selected ? undefined : "hover:bg-accent",
                ),
              }),
            )}
          >
            <Text
              className={cn(
                "text-[13px] font-medium",
                selected ? "text-primary-foreground" : "text-foreground",
              )}
            >
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function SelectEmpty({ children }: { children: ReactNode }) {
  return <Text className="text-[13px] text-muted-foreground">{children}</Text>;
}

export { SelectChips, SelectEmpty };
