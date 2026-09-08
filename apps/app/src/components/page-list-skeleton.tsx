import { View } from "react-native";
import { PageScreen } from "@/components/page-screen";
import { Skeleton } from "@/components/ui/skeleton";

/** Brand-aligned list loading state — replaces bare ActivityIndicator. */
export function PageListSkeleton({
  title,
  rows = 6,
}: {
  title: string;
  rows?: number;
}) {
  return (
    <PageScreen title={title}>
      <View className="overflow-hidden rounded-xl border border-border bg-card">
        {Array.from({ length: rows }, (_, index) => (
          <View
            key={index}
            className={`gap-2 border-b border-border px-4 py-3.5 ${index === rows - 1 ? "border-b-0" : ""}`}
          >
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-56" />
          </View>
        ))}
      </View>
    </PageScreen>
  );
}

export function CenteredPageSkeleton() {
  return (
    <View className="flex-1 gap-3 bg-background px-4 py-8">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-4 w-64" />
      <View className="mt-4 overflow-hidden rounded-xl border border-border bg-card">
        {Array.from({ length: 5 }, (_, index) => (
          <View
            key={index}
            className={`gap-2 border-b border-border px-4 py-3.5 ${index === 4 ? "border-b-0" : ""}`}
          >
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-3 w-60" />
          </View>
        ))}
      </View>
    </View>
  );
}
