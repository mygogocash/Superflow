import type { ComponentProps } from "react";
import { Platform, TextInput } from "react-native";
import { BRAND } from "@/lib/brand";
import { cn } from "@/lib/utils";

function Input({ className, style, ...props }: ComponentProps<typeof TextInput>) {
  return (
    <TextInput
      placeholderTextColor={BRAND.stone500}
      className={cn(
        "flex h-11 w-full min-w-0 flex-row items-center rounded-md border border-input bg-card px-3 py-2 text-base leading-5 text-foreground",
        props.editable === false &&
          cn("opacity-50", Platform.select({ web: "disabled:pointer-events-none disabled:cursor-not-allowed" })),
        Platform.select({
          web: cn(
            "outline-none transition-[color,box-shadow] selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground md:text-sm",
            "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
            "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
          ),
        }),
        className,
      )}
      style={style}
      {...props}
    />
  );
}

export { Input };
