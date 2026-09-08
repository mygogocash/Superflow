import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { View } from "react-native";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

const badgeVariants = cva("flex-row items-center self-start rounded-md border px-2 py-0.5", {
  variants: {
    variant: {
      default: "border-transparent bg-primary",
      secondary: "border-transparent bg-secondary",
      outline: "border-border bg-card",
      success: "border-transparent bg-success/15",
      warning: "border-transparent bg-warning/15",
      destructive: "border-transparent bg-destructive/15",
      intelligence: "border-transparent bg-intelligence-50",
    },
  },
  defaultVariants: { variant: "secondary" },
});

const badgeTextVariants = cva("text-[11px] font-medium uppercase tracking-wide", {
  variants: {
    variant: {
      default: "text-primary-foreground",
      secondary: "text-secondary-foreground",
      outline: "text-foreground",
      success: "text-success",
      warning: "text-warning",
      destructive: "text-destructive",
      intelligence: "text-intelligence-900",
    },
  },
  defaultVariants: { variant: "secondary" },
});

type BadgeProps = ComponentProps<typeof View> &
  VariantProps<typeof badgeVariants> & {
    children: string;
  };

function Badge({ className, variant, children, ...props }: BadgeProps) {
  return (
    <View className={cn(badgeVariants({ variant }), className)} {...props}>
      <Text className={badgeTextVariants({ variant })}>{children}</Text>
    </View>
  );
}

export { Badge, badgeVariants };
export type { BadgeProps };
