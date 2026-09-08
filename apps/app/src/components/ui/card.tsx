import type { ComponentProps } from "react";
import { View } from "react-native";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

function Card({ className, style, ...props }: ComponentProps<typeof View>) {
  // CI §12: cards are border + white surface — no shadow.
  return (
    <View
      className={cn("flex flex-col gap-4 rounded-xl border border-border bg-card p-6", className)}
      style={style}
      {...props}
    />
  );
}

function CardHeader({ className, ...props }: ComponentProps<typeof View>) {
  return <View className={cn("flex flex-col gap-1.5", className)} {...props} />;
}

function CardTitle({ className, ...props }: ComponentProps<typeof Text>) {
  return <Text className={cn("text-lg font-semibold leading-none text-card-foreground", className)} {...props} />;
}

function CardDescription({ className, ...props }: ComponentProps<typeof Text>) {
  return <Text className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

function CardContent({ className, ...props }: ComponentProps<typeof View>) {
  return <View className={cn("gap-3", className)} {...props} />;
}

export { Card, CardContent, CardDescription, CardHeader, CardTitle };
