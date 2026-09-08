import type { ComponentProps } from "react";
import { Platform, TextInput } from "react-native";
import { BRAND } from "@/lib/brand";
import { cn } from "@/lib/utils";

function Textarea({ className, style, ...props }: ComponentProps<typeof TextInput>) {
  return (
    <TextInput
      multiline
      textAlignVertical="top"
      placeholderTextColor={BRAND.stone500}
      className={cn(
        "min-h-[96px] w-full rounded-md border border-input bg-card px-3 py-2.5 text-base leading-5 text-foreground",
        props.editable === false && "opacity-50",
        Platform.select({
          web: cn(
            "outline-none transition-[color,box-shadow] selection:bg-primary selection:text-primary-foreground placeholder:text-muted-foreground md:text-sm",
            "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
          ),
        }),
        className,
      )}
      style={style}
      {...props}
    />
  );
}

export { Textarea };
