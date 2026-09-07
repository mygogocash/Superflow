import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import type { ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { EmptyState } from "@/components/empty-state";
import { Text } from "@/components/ui/text";
import { BRAND } from "@/lib/brand";
import { cn } from "@/lib/utils";

function CellValue({ value }: { value: ReactNode }) {
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return <Text className="text-sm text-foreground">{value == null ? "" : String(value)}</Text>;
  }
  return value;
}

export function DataTable<TData>({
  columns,
  data,
  empty = "No rows.",
  emptyDescription,
  className,
  onRowPress,
}: {
  columns: ColumnDef<TData, unknown>[];
  data: TData[];
  empty?: string;
  emptyDescription?: string;
  className?: string;
  onRowPress?: (row: TData) => void;
}) {
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  if (table.getRowModel().rows.length === 0) {
    return (
      <View className={cn("w-full overflow-hidden rounded-xl border border-border bg-card", className)} style={{ width: "100%" }}>
        <EmptyState heading={empty} description={emptyDescription} />
      </View>
    );
  }

  return (
    <View
      className={cn("min-h-0 w-full flex-1 overflow-hidden rounded-xl border border-border bg-card", className)}
      style={{ width: "100%", flex: 1, minHeight: 0 }}
    >
      <ScrollView
        horizontal
        style={{ width: "100%", flex: 1 }}
        contentContainerStyle={{ minWidth: "100%", flexGrow: 1 }}
      >
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ minWidth: "100%", flexGrow: 1 }} nestedScrollEnabled>
          <View style={{ minWidth: "100%", width: "100%", flexGrow: 1 }}>
            {table.getHeaderGroups().map((headerGroup) => (
              <View key={headerGroup.id} className="flex-row border-b border-border bg-muted" style={{ minWidth: "100%", width: "100%" }}>
                {headerGroup.headers.map((header) => (
                  <View key={header.id} className="min-w-[160px] flex-1 px-4 py-3">
                    {header.isPlaceholder ? null : (
                      <Text
                        className="text-[11px] font-semibold uppercase"
                        style={{ color: BRAND.stone700, letterSpacing: 0.8 }}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                      </Text>
                    )}
                  </View>
                ))}
              </View>
            ))}
            {table.getRowModel().rows.map((row) => {
              const cells = row.getVisibleCells().map((cell) => (
                <View key={cell.id} className="min-w-[160px] flex-1 justify-center px-4 py-3.5">
                  <CellValue value={flexRender(cell.column.columnDef.cell, cell.getContext())} />
                </View>
              ));
              if (onRowPress) {
                return (
                  <Pressable
                    key={row.id}
                    accessibilityRole="button"
                    className="flex-row border-b border-border active:bg-muted/60"
                    style={{ minWidth: "100%", width: "100%" }}
                    onPress={() => onRowPress(row.original)}
                  >
                    {cells}
                  </Pressable>
                );
              }
              return (
                <View key={row.id} className="flex-row border-b border-border last:border-b-0">
                  {cells}
                </View>
              );
            })}
          </View>
        </ScrollView>
      </ScrollView>
    </View>
  );
}
