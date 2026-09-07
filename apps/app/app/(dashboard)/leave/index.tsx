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
import { SelectChips, SelectEmpty } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import { useApiQuery } from "@/hooks/use-api-query";
import { api, ApiError } from "@/lib/api-client";
import { BRAND } from "@/lib/brand";
import { unwrapList } from "@/lib/list";
import { queryKeys } from "@/lib/query-keys";
import { toast } from "@/lib/toast";
import { useAuth } from "@/store/auth";

type LeaveRequest = {
  id: string;
  status: string;
  startDate: string;
  endDate: string;
  days: number;
  leaveType?: { name: string; code?: string };
  employee?: { name: string };
};

type LeaveType = {
  id: string;
  name: string;
  code?: string;
  isActive?: boolean;
};

function statusVariant(
  status: string,
): "secondary" | "success" | "warning" | "destructive" | "outline" {
  const s = status.toLowerCase();
  if (s.includes("approved") || s.includes("taken")) return "success";
  if (s.includes("reject") || s.includes("cancel")) return "destructive";
  if (s.includes("pending") || s.includes("submitted")) return "warning";
  return "outline";
}

const columns: ColumnDef<LeaveRequest>[] = [
  { accessorFn: (row) => row.leaveType?.name ?? "Leave", header: "Type" },
  {
    id: "status",
    header: "Status",
    size: 120,
    cell: ({ row }) => (
      <Badge variant={statusVariant(row.original.status)}>{row.original.status}</Badge>
    ),
  },
  { accessorFn: (row) => row.employee?.name ?? "—", header: "Employee" },
  { accessorFn: (row) => `${row.startDate} – ${row.endDate}`, header: "Dates" },
  { accessorKey: "days", header: "Days", size: 72 },
];

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function RequestLeaveDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const typesQuery = useApiQuery<{ data: LeaveType[] }>(queryKeys.leave.types(), "/leave/types", {
    enabled: open,
  });
  const types = useMemo(
    () => unwrapList<LeaveType>(typesQuery.data).filter((t) => t.isActive !== false),
    [typesQuery.data],
  );
  const typeOptions = useMemo(
    () => types.map((t) => ({ value: t.id, label: t.name })),
    [types],
  );

  const [leaveTypeId, setLeaveTypeId] = useState<string | null>(null);
  const [startDate, setStartDate] = useState(todayIso);
  const [endDate, setEndDate] = useState(todayIso);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLeaveTypeId(null);
    setReason("");
    setStartDate(todayIso());
    setEndDate(todayIso());
    setError(null);
  }, [open]);

  async function submit() {
    if (!leaveTypeId) {
      setError("Select a leave type");
      return;
    }
    if (endDate < startDate) {
      setError("End date must not be before start date");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.post("/leave/requests", {
        leaveTypeId,
        startDate,
        endDate,
        durationType: "full_day",
        reason: reason.trim() || undefined,
      });
      onOpenChange(false);
      toast("Leave request submitted", "success");
      onCreated();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Request failed";
      setError(msg);
      toast(msg, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} dismissible={!busy} onOpenChange={onOpenChange}>
      <DialogContent
        title="Request leave"
        description="Choose a leave type and the dates you need off."
        footer={
          <DialogFooter>
            <Button variant="outline" disabled={busy} onPress={() => onOpenChange(false)}>
              <Text>Cancel</Text>
            </Button>
            <Button disabled={busy || typesQuery.isLoading} onPress={() => void submit()}>
              <Text>{busy ? "Submitting…" : "Submit request"}</Text>
            </Button>
          </DialogFooter>
        }
      >
        {typesQuery.isLoading ? (
          <View className="gap-2">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-56" />
          </View>
        ) : typesQuery.error ? (
          <Text className="text-[13px] text-destructive">{typesQuery.error.message}</Text>
        ) : (
          <Field label="Leave type">
            {typeOptions.length === 0 ? (
              <SelectEmpty>No leave types available.</SelectEmpty>
            ) : (
              <SelectChips value={leaveTypeId} onValueChange={setLeaveTypeId} options={typeOptions} />
            )}
          </Field>
        )}
        <Field label="Start date">
          <Input
            accessibilityLabel="Start date"
            autoCapitalize="none"
            placeholder="YYYY-MM-DD"
            {...Platform.select({ web: { type: "date" as const } })}
            value={startDate}
            onChangeText={setStartDate}
          />
        </Field>
        <Field label="End date">
          <Input
            accessibilityLabel="End date"
            autoCapitalize="none"
            placeholder="YYYY-MM-DD"
            {...Platform.select({ web: { type: "date" as const } })}
            value={endDate}
            onChangeText={setEndDate}
          />
        </Field>
        <Field label="Reason (optional)">
          <Textarea
            accessibilityLabel="Reason"
            placeholder="Brief reason for your request"
            value={reason}
            onChangeText={setReason}
          />
        </Field>
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

function LeaveDetailDialog({
  request,
  open,
  onOpenChange,
  canCancel,
  onCancelled,
}: {
  request: LeaveRequest | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canCancel: boolean;
  onCancelled: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = request?.status.toLowerCase().includes("pending") ?? false;

  async function cancel() {
    if (!request || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.put(`/leave/requests/${request.id}/cancel`, {});
      toast("Leave request cancelled", "success");
      onOpenChange(false);
      onCancelled();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Cancel failed";
      setError(msg);
      toast(msg, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} dismissible={!busy} onOpenChange={onOpenChange}>
      <DialogContent
        title={request?.leaveType?.name ?? "Leave request"}
        description="Review this request."
        footer={
          <DialogFooter>
            <Button variant="outline" disabled={busy} onPress={() => onOpenChange(false)}>
              <Text>Close</Text>
            </Button>
            {canCancel && pending ? (
              <Button variant="destructive" disabled={busy} onPress={() => void cancel()}>
                <Text>{busy ? "Cancelling…" : "Cancel request"}</Text>
              </Button>
            ) : null}
          </DialogFooter>
        }
      >
        {request ? (
          <View className="gap-3">
            <DetailRow label="Status" value={request.status} />
            <DetailRow label="Employee" value={request.employee?.name ?? "—"} />
            <DetailRow label="Dates" value={`${request.startDate} – ${request.endDate}`} />
            <DetailRow label="Days" value={String(request.days)} />
            {error ? <Text className="text-[13px] text-destructive">{error}</Text> : null}
          </View>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export default function LeavePage() {
  const queryClient = useQueryClient();
  const canRequest = useAuth((s) => s.hasPermission("leave:request"));
  const [requestOpen, setRequestOpen] = useState(false);
  const [selected, setSelected] = useState<LeaveRequest | null>(null);
  const query = useApiQuery<{ data: LeaveRequest[] }>(queryKeys.leave.requests(), "/leave/requests");
  const items = unwrapList<LeaveRequest>(query.data);

  if (query.isLoading) {
    return <PageListSkeleton title="Leave" />;
  }

  if (query.error) {
    return (
      <PageScreen title="Leave">
        <View className="overflow-hidden rounded-xl border border-border bg-card">
          <EmptyState
            variant="error"
            heading="Couldn't load leave requests"
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
        title="Leave"
        subtitle="Submit time off and track requests awaiting approval."
        scroll={false}
        actions={
          canRequest ? (
            <Button size="sm" onPress={() => setRequestOpen(true)}>
              <Plus size={14} color={BRAND.paper} />
              <Text>Request leave</Text>
            </Button>
          ) : undefined
        }
      >
        <DataTable
          columns={columns}
          data={items}
          empty="No leave requests yet"
          emptyDescription={
            canRequest
              ? "Tap Request leave to submit your first request."
              : "No leave requests to show."
          }
          onRowPress={setSelected}
        />
      </PageScreen>
      {canRequest ? (
        <RequestLeaveDialog
          open={requestOpen}
          onOpenChange={setRequestOpen}
          onCreated={() => {
            void (async () => {
              try {
                await queryClient.invalidateQueries({ queryKey: queryKeys.leave.requests() });
              } catch {
                toast("Submitted, but the list failed to refresh", "error");
              }
            })();
          }}
        />
      ) : null}
      <LeaveDetailDialog
        request={selected}
        open={selected != null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        canCancel={canRequest}
        onCancelled={() => {
          void (async () => {
            try {
              await queryClient.invalidateQueries({ queryKey: queryKeys.leave.requests() });
            } catch {
              toast("Cancelled, but the list failed to refresh", "error");
            }
          })();
        }}
      />
    </>
  );
}
