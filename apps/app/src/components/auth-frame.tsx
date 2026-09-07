import { Link, type Href } from "expo-router";
import type { ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { ManutSymbol } from "@/components/brand/manut-symbol";
import { Text } from "@/components/ui/text";

export function AuthLink({ href, children }: { href: Href; children: string }) {
  return (
    <Link href={href}>
      <Text className="text-sm font-medium text-primary">{children}</Text>
    </Link>
  );
}

export function AuthFrame({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="min-h-full items-center justify-center px-4 py-8"
      contentContainerStyle={{ flexGrow: 1 }}
      keyboardShouldPersistTaps="handled"
    >
      <View className="w-full max-w-[440px] rounded-[14px] border border-border bg-card p-6 sm:p-8">
        <View className="mb-8 flex-row items-center gap-3">
          <ManutSymbol size={42} />
          <Text className="font-display text-[32px] leading-none tracking-tight text-foreground">Manut</Text>
        </View>
        <Text className="text-xl font-semibold text-foreground">{title}</Text>
        {subtitle ? <Text className="mt-1 text-[13px] leading-5 text-muted-foreground">{subtitle}</Text> : null}
        <View className="mt-6 gap-3">{children}</View>
      </View>
    </ScrollView>
  );
}
