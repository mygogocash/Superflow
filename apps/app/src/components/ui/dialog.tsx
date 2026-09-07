import type { ReactNode } from "react";
import { Modal, Platform, Pressable, ScrollView, View } from "react-native";
import { Text } from "@/components/ui/text";
import { shadowMd } from "@/lib/shadow";
import { cn } from "@/lib/utils";

function Dialog({
  open,
  onOpenChange,
  children,
  dismissible = true,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  /** When false, backdrop / Android back cannot close (e.g. while submitting). */
  dismissible?: boolean;
}) {
  return (
    <Modal
      visible={open}
      transparent
      animationType="fade"
      onRequestClose={() => {
        if (dismissible) onOpenChange(false);
      }}
    >
      <View className="flex-1 items-center justify-center bg-black/40 px-4 py-8">
        <Pressable
          accessibilityLabel="Dismiss dialog"
          className="absolute inset-0"
          disabled={!dismissible}
          onPress={() => {
            if (dismissible) onOpenChange(false);
          }}
        />
        {children}
      </View>
    </Modal>
  );
}

function DialogContent({
  children,
  className,
  title,
  description,
  footer,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
  description?: string;
  footer?: ReactNode;
}) {
  return (
    <View
      className={cn(
        "z-10 w-full max-w-[440px] overflow-hidden rounded-2xl border border-border bg-card",
        className,
      )}
      style={shadowMd}
    >
      {(title || description) && (
        <View className="gap-1 border-b border-border px-5 py-4">
          {title ? <Text className="text-lg font-semibold text-foreground">{title}</Text> : null}
          {description ? (
            <Text className="text-[13px] leading-5 text-muted-foreground">{description}</Text>
          ) : null}
        </View>
      )}
      <ScrollView
        className="max-h-[70vh]"
        contentContainerClassName="gap-3 px-5 py-4"
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
      {footer}
    </View>
  );
}

function DialogFooter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <View
      className={cn(
        "flex-row flex-wrap justify-end gap-2 border-t border-border px-5 py-3",
        Platform.select({ web: "bg-muted/40" }),
        className,
      )}
    >
      {children}
    </View>
  );
}

export { Dialog, DialogContent, DialogFooter };
