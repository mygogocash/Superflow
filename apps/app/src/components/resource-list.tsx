import { View } from "react-native";
import { EmptyState } from "@/components/empty-state";
import { PageListSkeleton } from "@/components/page-list-skeleton";
import { PageScreen } from "@/components/page-screen";
import { Text } from "@/components/ui/text";
import { useResourceList } from "@/hooks/use-resource-list";
import { defaultResourceRow, type ResourceRow } from "@/lib/resource-row";
import { cn } from "@/lib/utils";

export function ResourceList<T>({
  title,
  subtitle,
  items,
  loading,
  error,
  empty,
  emptyDescription,
  row,
  retry,
}: {
  title: string;
  subtitle?: string;
  items: T[];
  loading: boolean;
  error?: string | null;
  empty: string;
  emptyDescription?: string;
  row: (item: T) => ResourceRow;
  retry?: () => void;
}) {
  if (loading) {
    return <PageListSkeleton title={title} />;
  }

  return (
    <PageScreen title={title} subtitle={subtitle}>
      <View className="overflow-hidden rounded-xl border border-border bg-card">
        {error ? (
          <EmptyState
            variant="error"
            heading="Couldn't load this list"
            description={error}
            actionLabel={retry ? "Try again" : undefined}
            onAction={retry}
          />
        ) : items.length === 0 ? (
          <EmptyState
            heading={empty}
            description={emptyDescription ?? "Items will appear here once they're created or assigned to you."}
          />
        ) : (
          items.map((item, index) => {
            const rendered = row(item);
            const key = (item as { id?: string }).id ?? String(index);
            return (
              <View key={key} className={cn("border-b border-border px-4 py-3.5", index === items.length - 1 && "border-b-0")}>
                <Text className="text-[15px] font-semibold text-foreground">{rendered.title}</Text>
                {rendered.meta ? <Text className="mt-0.5 text-[13px] text-muted-foreground">{rendered.meta}</Text> : null}
                {rendered.body ? (
                  <Text className="mt-1 text-[14px] leading-5 text-foreground/80" numberOfLines={3}>
                    {rendered.body}
                  </Text>
                ) : null}
              </View>
            );
          })
        )}
      </View>
    </PageScreen>
  );
}

export function ResourceListPage<T extends { id?: string }>({
  title,
  subtitle,
  path,
  empty,
  emptyDescription,
  row,
}: {
  title: string;
  subtitle?: string;
  path: string;
  empty: string;
  emptyDescription?: string;
  row?: (item: T) => ResourceRow;
}) {
  const list = useResourceList<T>(path);
  return (
    <ResourceList
      title={title}
      subtitle={subtitle}
      empty={empty}
      emptyDescription={emptyDescription}
      {...list}
      row={row ?? ((item) => defaultResourceRow(item as Record<string, unknown>))}
    />
  );
}
