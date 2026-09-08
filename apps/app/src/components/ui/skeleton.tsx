import type { ComponentProps } from "react";
import { Platform, View } from "react-native";
import { cn } from "@/lib/utils";

function Skeleton({ className, ...props }: ComponentProps<typeof View>) {
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel="Loading"
      className={cn(
        "rounded-md bg-muted",
        Platform.select({ web: "animate-pulse" }),
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
