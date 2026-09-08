import type { ReactNode } from "react";
import { View } from "react-native";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";

export function EmptyState({
  heading,
  description,
  actionLabel,
  onAction,
  variant = "empty",
  icon,
}: {
  heading: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  variant?: "empty" | "error";
  icon?: ReactNode;
}) {
  const isError = variant === "error";
  return (
    <View className="items-center px-6 py-10">
      <View
        className={
          isError
            ? "mb-3 h-12 w-12 items-center justify-center rounded-2xl bg-destructive/10"
            : "mb-3 h-12 w-12 items-center justify-center rounded-2xl bg-muted"
        }
      >
        {icon ?? (
          <Text
            className={
              isError ? "text-lg font-semibold text-destructive" : "text-lg font-semibold text-muted-foreground"
            }
          >
            {isError ? "!" : "–"}
          </Text>
        )}
      </View>
      <Text className="text-center text-[15px] font-semibold text-foreground">{heading}</Text>
      {description ? (
        <Text className="mt-1 max-w-sm text-center text-[13px] leading-5 text-muted-foreground">{description}</Text>
      ) : null}
      {actionLabel && onAction ? (
        <Button onPress={onAction} className="mt-4" variant={isError ? "outline" : "default"}>
          <Text>{actionLabel}</Text>
        </Button>
      ) : null}
    </View>
  );
}
