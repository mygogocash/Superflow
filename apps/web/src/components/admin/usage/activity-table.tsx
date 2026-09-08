"use client";

import { formatDistanceToNow } from "date-fns";

import { Avatar } from "@/components/shared/avatar";
import { Badge } from "@/components/shared/badge";
import { DataTable } from "@/components/shared/data-table";
import type {
  ActivitySource,
  PerUserActivity,
} from "@/services/admin-usage.service";

interface ActivityTableProps {
  rows: PerUserActivity[];
  source?: ActivitySource;
  loading?: boolean;
  pagination?: React.ReactNode;
  actions?: React.ReactNode;
}

const SOURCE_LABEL: Record<
  ActivitySource,
  { label: string; variant: "blue" | "gold" }
> = {
  audit_log: { label: "Audit Log", variant: "blue" },
  posthog: { label: "PostHog", variant: "gold" },
};

function MiniStat({ label, value }: { label: string; value: number }) {
  if (value <= 0) {
    return (
      <div
        className={`
          text-muted-foreground/60 flex items-center gap-1 text-[11px]
        `}
      >
        <span className="font-medium">{label}</span>
        <span>—</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1 text-[11px]">
      <span className="text-muted-foreground font-medium">{label}</span>
      <span className="text-foreground font-semibold tabular-nums">
        {value.toLocaleString()}
      </span>
    </div>
  );
}

export function ActivityTable({
  rows,
  source,
  loading,
  pagination,
  actions,
}: ActivityTableProps) {
  const sourceMeta = source ? SOURCE_LABEL[source] : null;
  return (
    <DataTable
      title="Activity by user (last 30 days)"
      actions={
        <div className="flex items-center gap-2">
          {sourceMeta ? (
            <Badge variant={sourceMeta.variant}>
              source · {sourceMeta.label}
            </Badge>
          ) : null}
          {actions}
        </div>
      }
      loading={loading}
      data={rows}
      pagination={pagination}
      emptyMessage="No audit activity recorded yet"
      columns={[
        {
          key: "user",
          header: "User",
          render: (row) => (
            <div className="flex items-center gap-3">
              <Avatar name={row.name} size="sm" />
              <div className="min-w-0">
                <div className="text-foreground truncate text-sm font-medium">
                  {row.name}
                </div>
                <div className="text-muted-foreground truncate text-xs">
                  {row.email}
                </div>
              </div>
            </div>
          ),
        },
        {
          key: "events",
          header: "Events",
          className: "tabular-nums",
          render: (row) => (
            <div className="text-foreground text-sm font-semibold">
              {row.events30d.toLocaleString()}
            </div>
          ),
        },
        {
          key: "activeDays",
          header: "Active days",
          className: "tabular-nums",
          render: (row) => (
            <div className="text-foreground text-sm">
              {row.activeDays30d}
              <span className="text-muted-foreground/60 ml-1 text-xs">
                / 30
              </span>
            </div>
          ),
        },
        {
          key: "breakdown",
          header: "Breakdown",
          className: "min-w-[200px]",
          render: (row) => (
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              <MiniStat label="Leave" value={row.breakdown.leaveEvents30d} />
              <MiniStat
                label="Expense"
                value={row.breakdown.expenseEvents30d}
              />
              <MiniStat label="Manut AI" value={row.breakdown.ariaEvents30d} />
            </div>
          ),
        },
        {
          key: "topAction",
          header: "Top action",
          render: (row) =>
            row.topAction ? (
              <Badge variant="grey" className="font-mono">
                {row.topAction}
              </Badge>
            ) : (
              <span className="text-muted-foreground text-xs">—</span>
            ),
        },
        {
          key: "lastActive",
          header: "Last active",
          render: (row) =>
            row.lastActiveAt ? (
              <span
                className="text-muted-foreground text-xs"
                title={new Date(row.lastActiveAt).toLocaleString()}
              >
                {formatDistanceToNow(new Date(row.lastActiveAt), {
                  addSuffix: true,
                })}
              </span>
            ) : (
              <span className="text-muted-foreground text-xs">—</span>
            ),
        },
      ]}
    />
  );
}
