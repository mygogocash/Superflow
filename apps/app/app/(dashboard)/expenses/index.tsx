import type { ColumnDef } from "@tanstack/react-table";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import { Platform, View } from "react-native";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { Field } from "@/components/field";
import { PageListSkeleton } from "@/components/page-list-skeleton";
import { PageScreen } from "@/components/page-screen";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SelectChips } from "@/components/ui/select";
import { Text } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import { useApiQuery } from "@/hooks/use-api-query";
import { api, ApiError } from "@/lib/api-client";
import { BRAND } from "@/lib/brand";
import { unwrapList } from "@/lib/list";
import { queryKeys } from "@/lib/query-keys";
import { toast } from "@/lib/toast";
import { useAuth } from "@/store/auth";

type ExpenseReport = {
  id: string;
  title: string;
  period: string;
  status: string;
  category?: string | null;
  employee?: { name: string } | null;
};

const CATEGORY_OPTIONS = [
  { value: "general", label: "General" },
  { value: "business_or_bd", label: "Business / BD" },
  { value: "allowance", label: "Allowance" },
  { value: "office", label: "Office" },
];

function currentPeriod(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function statusVariant(status: string): "secondary" | "success" | "warning" | "destructive" | "outline" {
  const s = status.toLowerCase();
  if (s.includes("reimbursed") || s.includes("approved")) return "success";
  if (s.includes("reject")) return "destructive";
  if (s.includes("pending") || s.includes("submitted") || s.includes("draft")) return "warning";
  return "outline";
}

const columns: ColumnDef<ExpenseReport>[] = [
  { accessorKey: "title", header: "Title" },
  {
    id: "status",
    header: "Status",
    size: 120,
    cell: ({ row }) => (
      <Badge variant={statusVariant(row.original.status)}>{row.original.status}</Badge>
    ),
  },
  { accessorKey: "period", header: "Period", size: 100 },
  { accessorFn: (row) => row.category ?? "general", header: "Category" },
  { accessorFn: (row) => row.employee?.name ?? "—", header: "Employee" },
];

function CreateExpenseReportDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const memberships = useAuth((s) => s.memberships);
  const activeEntityId = useAuth((s) => s.activeEntityId);
  const entityOptions = useMemo(
    () =>
      memberships.map((m) => ({
        value: m.entityId,
        label: m.entity?.name ?? m.entity?.code ?? m.entityId,
      })),
    [memberships],
  );

  const [entityId, setEntityId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [period, setPeriod] = useState(currentPeriod);
  const [category, setCategory] = useState("general");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setEntityId(activeEntityId ?? entityOptions[0]?.value ?? null);
    setTitle("");
    setPeriod(currentPeriod());
    setCategory("general");
    setNotes("");
    setError(null);
  }, [open, activeEntityId, entityOptions]);

  async function submit() {
    if (!entityId) {
      setError("Select an entity");
      return;
    }
    if (!title.trim()) {
      setError("Title is required");
      return;
    }
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
      setError("Period must be YYYY-MM");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post("/expenses/reports", {
        entityId,
        title: title.trim(),
        period,
        category,
        notes: notes.trim() || undefined,
      });
      onOpenChange(false);
      toast("Expense report created", "success");
      onCreated();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Create failed";
      setError(msg);
      toast(msg, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} dismissible={!busy} onOpenChange={onOpenChange}>
      <DialogContent
        title="New expense report"
        description="Create a report for this period, then add line items from the web portal or a follow-up."
        footer={
          <DialogFooter>
            <Button variant="outline" disabled={busy} onPress={() => onOpenChange(false)}>
              <Text>Cancel</Text>
            </Button>
            <Button disabled={busy || entityOptions.length === 0} onPress={() => void submit()}>
              <Text>{busy ? "Creating…" : "Create report"}</Text>
            </Button>
          </DialogFooter>
        }
      >
        {entityOptions.length > 1 ? (
          <Field label="Entity">
            <SelectChips value={entityId} onValueChange={setEntityId} options={entityOptions} />
          </Field>
        ) : null}
        <Field label="Title">
          <Input
            accessibilityLabel="Report title"
            placeholder="e.g. March client travel"
            value={title}
            onChangeText={setTitle}
          />
        </Field>
        <Field label="Period (YYYY-MM)">
          <Input
            accessibilityLabel="Period"
            autoCapitalize="none"
            placeholder="2026-09"
            {...Platform.select({ web: { type: "month" as const } })}
            value={period}
            onChangeText={setPeriod}
          />
        </Field>
        <Field label="Category">
          <SelectChips value={category} onValueChange={setCategory} options={CATEGORY_OPTIONS} />
        </Field>
        <Field label="Notes (optional)">
          <Textarea
            accessibilityLabel="Notes"
            placeholder="Anything approvers should know"
            value={notes}
            onChangeText={setNotes}
          />
        </Field>
        {entityOptions.length === 0 ? (
          <Text className="text-[13px] text-destructive">No entity membership found for your account.</Text>
        ) : null}
        {error ? <Text className="text-[13px] text-destructive">{error}</Text> : null}
      </DialogContent>
    </Dialog>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View className="gap-0.5">
      <Text className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</Text>
      <Text className="text-[14px] text-foreground">{value}</Text>
    </View>
  );
}

function ExpenseDetailDialog({
  report,
  open,
  onOpenChange,
}: {
  report: ExpenseReport | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={report?.title ?? "Expense report"}
        description="Report summary. Line items stay on the full expense portal for now."
        footer={
          <DialogFooter>
            <Button variant="outline" onPress={() => onOpenChange(false)}>
              <Text>Close</Text>
            </Button>
          </DialogFooter>
        }
      >
        {report ? (
          <View className="gap-3">
            <DetailRow label="Status" value={report.status} />
            <DetailRow label="Period" value={report.period} />
            <DetailRow label="Category" value={report.category ?? "general"} />
            <DetailRow label="Employee" value={report.employee?.name ?? "—"} />
          </View>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export default function ExpensesPage() {
  const queryClient = useQueryClient();
  const canCreate = useAuth((s) => s.hasPermission("expense:create"));
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<ExpenseReport | null>(null);
  const query = useApiQuery<{ data: ExpenseReport[] }>(
    queryKeys.expenses.reports(),
    "/expenses/reports",
  );
  const items = unwrapList<ExpenseReport>(query.data);

  if (query.isLoading) {
    return <PageListSkeleton title="Expenses" />;
  }

  if (query.error) {
    return (
      <PageScreen title="Expenses">
        <View className="overflow-hidden rounded-xl border border-border bg-card">
          <EmptyState
            variant="error"
            heading="Couldn't load expense reports"
            description={query.error.message}
            actionLabel="Try again"
            onAction={() => {
              void query.refetch();
            }}
          />
        </View>
      </PageScreen>
    );
  }

  return (
    <>
      <PageScreen
        title="Expenses"
        subtitle="Create reports and track reimbursement status."
        scroll={false}
        actions={
          canCreate ? (
            <Button size="sm" onPress={() => setOpen(true)}>
              <Plus size={14} color={BRAND.paper} />
              <Text>New report</Text>
            </Button>
          ) : undefined
        }
      >
        <DataTable
          columns={columns}
          data={items}
          empty="No expense reports yet"
          emptyDescription={
            canCreate ? "Tap New report to start your first period." : "No expense reports to show."
          }
          onRowPress={setSelected}
        />
      </PageScreen>
      {canCreate ? (
        <CreateExpenseReportDialog
          open={open}
          onOpenChange={setOpen}
          onCreated={() => {
            void (async () => {
              try {
                await queryClient.invalidateQueries({ queryKey: queryKeys.expenses.reports() });
              } catch {
                toast("Created, but the list failed to refresh", "error");
              }
            })();
          }}
        />
      ) : null}
      <ExpenseDetailDialog
        report={selected}
        open={selected != null}
        onOpenChange={(next) => {
          if (!next) setSelected(null);
        }}
      />
    </>
  );
}
