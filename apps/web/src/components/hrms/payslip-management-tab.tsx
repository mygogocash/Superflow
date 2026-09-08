"use client";

import {
  Building2,
  ChevronDown,
  ChevronRight,
  Download,
  FileDown,
  FileSpreadsheet,
  FileText,
  FileUp,
  Loader2,
  Plus,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

import { PayslipCompanyDialog } from "@/components/hrms/payslip-company-dialog";
import { PayslipCreateDialog } from "@/components/hrms/payslip-create-dialog";
import { PayrollBulkImportDialog } from "@/components/payroll/payroll-bulk-import-dialog";
import { downloadPayslipImportTemplate } from "@/components/payroll/payroll-import-template";
import { Badge } from "@/components/shared/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table } from "@/components/ui/table";
import { ApiError } from "@/lib/api-client";
import {
  bulkDeletePayslips,
  downloadGeneratedPayslip,
  downloadGeneratedRunPayslips,
  downloadPayslipsExport,
  getHrPayslipDownloadUrl,
  type HrPayslip,
  listHrPayslips,
  removePayslipDocument,
  uploadPayslipDocument,
} from "@/services/payroll.service";

const ALL = "__all__";
const HAS_DOC = "__yes__";
const NO_DOC = "__no__";

// Versioned key so a future shape change (e.g. per-user namespacing) can
// invalidate stale entries without colliding with the old format.
const EXPANDED_STORAGE_KEY = "intranet:payslip-mgmt:expanded-months:v1";

interface PayslipGroup {
  period: string; // YYYY-MM key, raw value from payrollRun.period
  label: string; // "April 2026" — pre-formatted for header display
  rows: HrPayslip[];
  count: number;
  totalGrossByCurrency: Record<string, number>;
  statusCounts: Record<string, number>;
  // Distinct payrollRun ids inside this period. Single-run groups can
  // safely call the run-scoped bulk-generate endpoint; multi-run groups
  // (same month, different entities) must disambiguate first.
  runIds: string[];
}

function readExpandedFromStorage(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(EXPANDED_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    return new Set();
  }
}

function writeExpandedToStorage(periods: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      EXPANDED_STORAGE_KEY,
      JSON.stringify(Array.from(periods)),
    );
  } catch {
    // Quota / privacy mode disabled — fail silently. In-memory state
    // still works for the current session.
  }
}

// Renders the per-currency gross-total summary in the group header.
// Mixed-currency months are common (Manut operates across THB / INR / VND
// / USD), so a single number wouldn't be meaningful.
function formatGroupTotals(totals: Record<string, number>): string {
  const entries = Object.entries(totals);
  if (entries.length === 0) return "—";
  return entries.map(([cur, n]) => formatCurrency(String(n), cur)).join(" · ");
}

function formatPeriod(yyyyMm: string): string {
  const m = yyyyMm.match(/^(\d{4})-(\d{2})$/);
  if (!m) return yyyyMm;
  const year = Number(m[1]);
  const monthIdx = Number(m[2]) - 1;
  if (!Number.isFinite(year) || monthIdx < 0 || monthIdx > 11) return yyyyMm;
  return new Date(Date.UTC(year, monthIdx, 1)).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatCurrency(value: string, currency: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  try {
    // `currencyDisplay: "code"` forces a 3-letter ISO code (THB / VND /
    // INR / USD) instead of the locale symbol so finance reviewing
    // mixed-currency runs can't confuse ₹ with ฿ at a glance.
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      currencyDisplay: "code",
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${currency} ${n.toLocaleString()}`;
  }
}

interface Props {
  /**
   * HR write actions (upload / replace / remove) require `payroll:create`.
   * Read-only viewers (`payroll:read`) still see the table and can
   * download attached PDFs through the HR signed-URL endpoint.
   */
  canManage: boolean;
}

export function PayslipManagementTab({ canManage }: Props) {
  const [rows, setRows] = useState<HrPayslip[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [periodFilter, setPeriodFilter] = useState<string>(ALL);
  const [docFilter, setDocFilter] = useState<string>(ALL);
  const [busyRowId, setBusyRowId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [companyOpen, setCompanyOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  // Map rowId -> hidden file input node so each row's "Upload" button
  // triggers its own picker without colliding with the others.
  const fileInputs = useRef<Map<string, HTMLInputElement | null>>(new Map());

  const fetchRows = useCallback(async () => {
    try {
      setLoading(true);
      const res = await listHrPayslips({
        period: periodFilter === ALL ? undefined : periodFilter,
        hasDocument:
          docFilter === HAS_DOC
            ? true
            : docFilter === NO_DOC
              ? false
              : undefined,
      });
      setRows(res.data);
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message : "Failed to load payslips";
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [periodFilter, docFilter]);

  useEffect(() => {
    void fetchRows();
  }, [fetchRows]);

  // "Export data" — full-breakdown Excel / CSV honouring the period + PDF
  // filters (the client-only search box doesn't scope the export).
  async function handleExport(format: "xlsx" | "csv") {
    try {
      setExporting(true);
      await downloadPayslipsExport(format, {
        period: periodFilter === ALL ? undefined : periodFilter,
        hasDocument:
          docFilter === HAS_DOC
            ? true
            : docFilter === NO_DOC
              ? false
              : undefined,
      });
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to export payslips",
      );
    } finally {
      setExporting(false);
    }
  }

  // Distinct period options sourced from the list itself so HR doesn't
  // have to guess what's in the system. Sorted DESC so the freshest
  // run lands at the top of the dropdown.
  const periodOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) set.add(r.payrollRun.period);
    return Array.from(set).sort((a, b) => b.localeCompare(a));
  }, [rows]);

  // Client-side search across employee name + entity. Cheap because
  // the dataset is bounded by the period / hasDocument server filters.
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const hay =
        `${r.employee.name} ${r.payrollRun.entity.name}`.toLowerCase();
      return hay.includes(q);
    });
  }, [rows, search]);

  // Group filtered rows by payroll period so HR scans one month at a
  // time instead of an undifferentiated flat list. Sorted DESC so the
  // most recent month sits at the top.
  const groups = useMemo<PayslipGroup[]>(() => {
    const map = new Map<string, PayslipGroup>();
    for (const r of filteredRows) {
      const p = r.payrollRun.period;
      let g = map.get(p);
      if (!g) {
        g = {
          period: p,
          label: formatPeriod(p),
          rows: [],
          count: 0,
          totalGrossByCurrency: {},
          statusCounts: {},
          runIds: [],
        };
        map.set(p, g);
      }
      g.rows.push(r);
      g.count += 1;
      const gross = Number(r.grossPay);
      if (Number.isFinite(gross)) {
        g.totalGrossByCurrency[r.currency] =
          (g.totalGrossByCurrency[r.currency] ?? 0) + gross;
      }
      g.statusCounts[r.payrollRun.status] =
        (g.statusCounts[r.payrollRun.status] ?? 0) + 1;
      if (!g.runIds.includes(r.payrollRun.id)) g.runIds.push(r.payrollRun.id);
    }
    return Array.from(map.values()).sort((a, b) =>
      b.period.localeCompare(a.period),
    );
  }, [filteredRows]);

  // Expansion state for the per-month collapse. Empty initial set keeps
  // SSR/hydration deterministic; the second effect hydrates from
  // localStorage on mount and the third persists subsequent changes.
  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(
    () => new Set(),
  );

  useEffect(() => {
    setExpandedMonths(readExpandedFromStorage());
  }, []);

  useEffect(() => {
    writeExpandedToStorage(expandedMonths);
  }, [expandedMonths]);

  function toggleMonth(period: string) {
    setExpandedMonths((prev) => {
      const next = new Set(prev);
      if (next.has(period)) next.delete(period);
      else next.add(period);
      return next;
    });
  }

  function groupSelectionState(group: PayslipGroup): boolean | "indeterminate" {
    let selectedCount = 0;
    for (const r of group.rows) if (selected.has(r.id)) selectedCount += 1;
    if (selectedCount === 0) return false;
    if (selectedCount === group.rows.length) return true;
    return "indeterminate";
  }

  function toggleGroupSelection(group: PayslipGroup) {
    const allSelected = group.rows.every((r) => selected.has(r.id));
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        for (const r of group.rows) next.delete(r.id);
      } else {
        for (const r of group.rows) next.add(r.id);
      }
      return next;
    });
  }

  async function handleDownload(slip: HrPayslip) {
    if (!slip.documentUrl) return;
    try {
      setBusyRowId(slip.id);
      const res = await getHrPayslipDownloadUrl(slip.id);
      const win = window.open(res.data.url, "_blank");
      if (win) win.opener = null;
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Failed to fetch download URL";
      toast.error(msg);
    } finally {
      setBusyRowId(null);
    }
  }

  // Generate a fresh Excel / PDF payslip from the persisted payroll
  // numbers — no upload needed. Works even when `documentUrl` is null.
  async function handleGenerate(slip: HrPayslip, format: "xlsx" | "pdf") {
    try {
      setBusyRowId(slip.id);
      await downloadGeneratedPayslip(slip.id, format);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to generate payslip";
      toast.error(msg);
    } finally {
      setBusyRowId(null);
    }
  }

  // Per-group bulk generate. The run-scoped endpoint takes a single
  // payrollRunId, so multi-entity months (same period, different runs)
  // can't be generated in one click — the header button disables and
  // hints the user to filter to a single entity first. busyGroupKey
  // tracks which group's spinner should light up.
  const [bulkGenerating, setBulkGenerating] = useState<{
    period: string;
    format: "xlsx" | "pdf";
  } | null>(null);

  async function handleGroupBulkGenerate(
    group: PayslipGroup,
    format: "xlsx" | "pdf",
  ) {
    if (group.runIds.length !== 1) {
      toast.error(
        "Multiple entities in this month — filter to a single entity first",
      );
      return;
    }
    const runId = group.runIds[0];
    try {
      setBulkGenerating({ period: group.period, format });
      await downloadGeneratedRunPayslips(runId, format);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to generate payslips";
      toast.error(msg);
    } finally {
      setBulkGenerating(null);
    }
  }

  async function handleUpload(slip: HrPayslip, file: File) {
    try {
      setBusyRowId(slip.id);
      const res = await uploadPayslipDocument(
        slip.payrollRun.id,
        slip.id,
        file,
      );
      // Patch the row in place so HR doesn't watch the whole table
      // refetch on every PDF action.
      setRows((prev) =>
        prev.map((r) =>
          r.id === slip.id
            ? { ...r, documentUrl: res.data.documentUrl ?? null }
            : r,
        ),
      );
      toast.success(`PDF attached for ${slip.employee.name}`);
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Failed to upload PDF";
      toast.error(msg);
    } finally {
      setBusyRowId(null);
      const node = fileInputs.current.get(slip.id);
      if (node) node.value = "";
    }
  }

  // Selection is bounded to the currently filtered rows so toggling a
  // filter clears the staged ids that no longer apply — prevents
  // "delete 30 hidden rows" surprises.
  const visibleIds = useMemo(
    () => filteredRows.map((r) => r.id),
    [filteredRows],
  );
  const selectedVisibleCount = useMemo(
    () => visibleIds.filter((id) => selected.has(id)).length,
    [visibleIds, selected],
  );
  const allVisibleSelected =
    visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;
  const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;

  // Drop stale ids whenever the filtered set shrinks below them. The
  // user can't see those rows anymore so they shouldn't ship in the
  // bulk-delete payload either.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(visibleIds);
      const next = new Set<string>();
      for (const id of prev) if (visible.has(id)) next.add(id);
      return next.size === prev.size ? prev : next;
    });
  }, [visibleIds]);

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelected((prev) => {
      if (allVisibleSelected) {
        const next = new Set(prev);
        for (const id of visibleIds) next.delete(id);
        return next;
      }
      const next = new Set(prev);
      for (const id of visibleIds) next.add(id);
      return next;
    });
  }

  async function handleBulkDelete() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    try {
      setBulkDeleting(true);
      const res = await bulkDeletePayslips(ids);
      toast.success(
        `Deleted ${res.data.deletedCount} payslip${
          res.data.deletedCount === 1 ? "" : "s"
        }`,
      );
      setSelected(new Set());
      setConfirmBulkDelete(false);
      await fetchRows();
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Failed to delete payslips";
      toast.error(msg);
    } finally {
      setBulkDeleting(false);
    }
  }

  async function handleRemove(slip: HrPayslip) {
    try {
      setBusyRowId(slip.id);
      await removePayslipDocument(slip.payrollRun.id, slip.id);
      setRows((prev) =>
        prev.map((r) => (r.id === slip.id ? { ...r, documentUrl: null } : r)),
      );
      toast.success("PDF removed");
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Failed to remove PDF";
      toast.error(msg);
    } finally {
      setBusyRowId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div
        className={`
          border-border bg-surface flex flex-wrap items-center gap-2 rounded-lg
          border p-3 shadow-sm
        `}
      >
        <div className="relative w-full max-w-xs">
          <Search
            className={`
              text-muted-foreground pointer-events-none absolute top-1/2 left-3
              size-3.5 -translate-y-1/2
            `}
          />
          <Input
            placeholder="Search employee or entity…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 pl-9 text-xs"
          />
        </div>
        <Select value={periodFilter} onValueChange={setPeriodFilter}>
          <SelectTrigger
            className="h-9 w-[160px] text-xs"
            aria-label="Filter by period"
          >
            <SelectValue placeholder="Period" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All periods</SelectItem>
            {periodOptions.map((p) => (
              <SelectItem key={p} value={p}>
                {formatPeriod(p)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={docFilter} onValueChange={setDocFilter}>
          <SelectTrigger
            className="h-9 w-[160px] text-xs"
            aria-label="Filter by PDF availability"
          >
            <SelectValue placeholder="PDF" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All payslips</SelectItem>
            <SelectItem value={HAS_DOC}>With PDF</SelectItem>
            <SelectItem value={NO_DOC}>Missing PDF</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex-1" />
        <p className="text-muted-foreground text-[11px]">
          {canManage
            ? "Upload PDFs per employee. Removed PDFs disappear from /my-portal immediately."
            : "Read-only — payroll managers can attach / replace / remove PDFs."}
        </p>
        {canManage ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setCompanyOpen(true)}
              className="h-9"
            >
              <Building2 className="size-3.5" />
              Company details
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => downloadPayslipImportTemplate("xlsx")}
              className="h-9"
              title="Download the blank payroll import template (.xlsx) — fill it in, then Import xlsx"
            >
              <FileDown className="size-3.5" />
              Template
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setImportOpen(true)}
              className="h-9"
            >
              <FileUp className="size-3.5" />
              Import xlsx
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-9"
                  disabled={exporting}
                >
                  {exporting ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Download className="size-3.5" />
                  )}
                  Export
                  <ChevronDown className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => void handleExport("xlsx")}>
                  <FileSpreadsheet className="size-3.5" />
                  Excel (.xlsx)
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void handleExport("csv")}>
                  <FileText className="size-3.5" />
                  CSV (.csv)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-9"
                >
                  <FileSpreadsheet className="size-3.5" />
                  Template
                  <ChevronDown className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onSelect={() => downloadPayslipImportTemplate("xlsx")}
                >
                  <FileSpreadsheet className="size-3.5" />
                  Excel (.xlsx)
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => downloadPayslipImportTemplate("csv")}
                >
                  <FileText className="size-3.5" />
                  CSV (.csv)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              type="button"
              size="sm"
              onClick={() => setCreateOpen(true)}
              className="h-9"
            >
              <Plus className="size-3.5" />
              New payslip
            </Button>
          </>
        ) : null}
      </div>

      {canManage && selected.size > 0 ? (
        <div
          className={`
            border-destructive/30 bg-destructive/5 flex flex-wrap items-center
            gap-2 rounded-lg border px-3 py-2
          `}
        >
          <span className="text-foreground text-xs font-medium">
            {selected.size} selected
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            onClick={() => setSelected(new Set())}
          >
            Clear
          </Button>
          <div className="flex-1" />
          <Button
            type="button"
            size="sm"
            variant="destructive"
            className="h-7 text-xs"
            onClick={() => setConfirmBulkDelete(true)}
            disabled={bulkDeleting}
          >
            <Trash2 className="size-3.5" />
            Delete selected
          </Button>
        </div>
      ) : null}

      {/* `overflow-hidden` CLIPPED this table below 768px -- measured at
          320-430px, the Status, PDF and Actions columns were unreachable.
          Using the shared `Table` rather than a bare <div><table> also brings
          Phase 8D's contained scrolling, conditional tab stop, region role and
          focus ring; the grouped rows inside are unchanged. */}
      <Table
        className="w-full text-xs"
        containerClassName="border-border rounded-md border"
        aria-label="Payslips"
      >
        <thead className="bg-muted/40 text-muted-foreground">
          <tr>
            {canManage ? (
              <th className="w-9 px-3 py-2 text-left font-medium">
                <Checkbox
                  checked={
                    allVisibleSelected
                      ? true
                      : someVisibleSelected
                        ? "indeterminate"
                        : false
                  }
                  onCheckedChange={toggleAllVisible}
                  aria-label="Select all visible payslips"
                  disabled={visibleIds.length === 0}
                />
              </th>
            ) : null}
            <th className="px-3 py-2 text-left font-medium">Employee</th>
            <th className="px-3 py-2 text-left font-medium">Entity</th>
            <th className="px-3 py-2 text-right font-medium">Gross</th>
            <th className="px-3 py-2 text-right font-medium">Net</th>
            <th className="px-3 py-2 text-left font-medium">Status</th>
            <th className="px-3 py-2 text-left font-medium">PDF</th>
            <th className="px-3 py-2 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td
                colSpan={canManage ? 8 : 7}
                className="text-muted-foreground py-12 text-center"
              >
                <Loader2 className="mx-auto mb-2 size-4 animate-spin" />
                Loading…
              </td>
            </tr>
          ) : groups.length === 0 ? (
            <tr>
              <td
                colSpan={canManage ? 8 : 7}
                className="text-muted-foreground py-12 text-center"
              >
                No payslips match the current filters.
              </td>
            </tr>
          ) : (
            groups.map((group) => {
              const expanded = expandedMonths.has(group.period);
              const selectState = groupSelectionState(group);
              const canGroupBulk = group.runIds.length === 1;
              const groupBulkBusy = bulkGenerating?.period === group.period;
              const statusEntries = Object.entries(group.statusCounts);
              return (
                <Fragment key={group.period}>
                  <tr
                    className={`
                      bg-muted/30 border-border/60 cursor-pointer border-t
                      hover:bg-muted/50
                    `}
                    onClick={() => toggleMonth(group.period)}
                  >
                    {canManage ? (
                      <td
                        className="px-3 py-2 align-middle"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Checkbox
                          checked={selectState}
                          onCheckedChange={() => toggleGroupSelection(group)}
                          aria-label={`Select all payslips for ${group.label}`}
                        />
                      </td>
                    ) : null}
                    <td colSpan={7} className="px-3 py-2">
                      <div className="flex flex-wrap items-center gap-3">
                        {expanded ? (
                          <ChevronDown
                            className={`text-muted-foreground size-4 shrink-0`}
                          />
                        ) : (
                          <ChevronRight
                            className={`text-muted-foreground size-4 shrink-0`}
                          />
                        )}
                        <span className="text-foreground font-semibold">
                          {group.label}
                        </span>
                        <span className="text-muted-foreground text-[11px]">
                          {group.count} payslip
                          {group.count === 1 ? "" : "s"}
                        </span>
                        <span
                          className={`
                            text-muted-foreground text-[11px] tabular-nums
                          `}
                        >
                          {formatGroupTotals(group.totalGrossByCurrency)}
                        </span>
                        <div className="flex items-center gap-1">
                          {statusEntries.map(([status, n]) => (
                            <Badge key={status} status={status}>
                              {n} {status}
                            </Badge>
                          ))}
                        </div>
                        {canManage ? (
                          <div
                            className="ml-auto flex items-center gap-1"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                handleGroupBulkGenerate(group, "xlsx")
                              }
                              disabled={!canGroupBulk || !!bulkGenerating}
                              className="h-7 text-[11px]"
                              title={
                                canGroupBulk
                                  ? `Generate Excel for ${group.label}`
                                  : "Multiple entities in this month — filter to a single entity first"
                              }
                            >
                              {groupBulkBusy &&
                              bulkGenerating?.format === "xlsx" ? (
                                <Loader2 className="size-3 animate-spin" />
                              ) : (
                                <FileSpreadsheet className="size-3" />
                              )}
                              xlsx
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                handleGroupBulkGenerate(group, "pdf")
                              }
                              disabled={!canGroupBulk || !!bulkGenerating}
                              className="h-7 text-[11px]"
                              title={
                                canGroupBulk
                                  ? `Generate PDF for ${group.label}`
                                  : "Multiple entities in this month — filter to a single entity first"
                              }
                            >
                              {groupBulkBusy &&
                              bulkGenerating?.format === "pdf" ? (
                                <Loader2 className="size-3 animate-spin" />
                              ) : (
                                <FileText className="size-3" />
                              )}
                              PDF
                            </Button>
                          </div>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                  {expanded
                    ? group.rows.map((slip) => {
                        const busy = busyRowId === slip.id;
                        const checked = selected.has(slip.id);
                        return (
                          <tr
                            key={slip.id}
                            className="border-border/60 border-t"
                          >
                            {canManage ? (
                              <td className="px-3 py-2 align-middle">
                                <Checkbox
                                  checked={checked}
                                  onCheckedChange={() => toggleRow(slip.id)}
                                  aria-label={`Select payslip for ${slip.employee.name}`}
                                />
                              </td>
                            ) : null}
                            <td className="px-3 py-2">
                              <div className="flex flex-col">
                                <span className="text-foreground font-medium">
                                  {slip.employee.name}
                                </span>
                                {slip.employee.department && (
                                  <span
                                    className={`
                                      text-muted-foreground text-[10px]
                                      uppercase
                                    `}
                                  >
                                    {slip.employee.department}
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="text-muted-foreground px-3 py-2">
                              {slip.payrollRun.entity.name}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {formatCurrency(slip.grossPay, slip.currency)}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">
                              {formatCurrency(slip.netPay, slip.currency)}
                            </td>
                            <td className="px-3 py-2">
                              <Badge status={slip.payrollRun.status}>
                                {slip.payrollRun.status}
                              </Badge>
                            </td>
                            <td className="px-3 py-2">
                              {slip.documentUrl ? (
                                <span
                                  className={`
                                    flex items-center gap-1.5 text-emerald-600
                                  `}
                                >
                                  <FileText className="size-3.5" />
                                  Attached
                                </span>
                              ) : (
                                <span
                                  className={`text-muted-foreground text-[11px]`}
                                >
                                  Missing
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right">
                              <div
                                className={`flex items-center justify-end gap-1`}
                              >
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  onClick={() => handleGenerate(slip, "xlsx")}
                                  disabled={busy}
                                  title="Generate Excel payslip"
                                >
                                  {busy ? (
                                    <Loader2 className="size-3.5 animate-spin" />
                                  ) : (
                                    <FileSpreadsheet className="size-3.5" />
                                  )}
                                </Button>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon-sm"
                                  onClick={() => handleGenerate(slip, "pdf")}
                                  disabled={busy}
                                  title="Generate PDF payslip"
                                >
                                  {busy ? (
                                    <Loader2 className="size-3.5 animate-spin" />
                                  ) : (
                                    <FileText className="size-3.5" />
                                  )}
                                </Button>
                                {slip.documentUrl ? (
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-sm"
                                    onClick={() => handleDownload(slip)}
                                    disabled={busy}
                                    title="Download attached PDF"
                                  >
                                    {busy ? (
                                      <Loader2
                                        className={`size-3.5 animate-spin`}
                                      />
                                    ) : (
                                      <Download className="size-3.5" />
                                    )}
                                  </Button>
                                ) : null}
                                {canManage ? (
                                  <>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon-sm"
                                      onClick={() =>
                                        fileInputs.current.get(slip.id)?.click()
                                      }
                                      disabled={busy}
                                      title={
                                        slip.documentUrl
                                          ? "Replace PDF"
                                          : "Upload PDF"
                                      }
                                    >
                                      <Upload className="size-3.5" />
                                    </Button>
                                    <input
                                      ref={(node) => {
                                        fileInputs.current.set(slip.id, node);
                                      }}
                                      type="file"
                                      accept="application/pdf"
                                      className="hidden"
                                      onChange={(e) => {
                                        const file = e.target.files?.[0];
                                        if (file) {
                                          void handleUpload(slip, file);
                                        }
                                      }}
                                    />
                                    {slip.documentUrl ? (
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon-sm"
                                        onClick={() => handleRemove(slip)}
                                        disabled={busy}
                                        title="Remove PDF"
                                      >
                                        <Trash2
                                          className={`text-destructive size-3.5`}
                                        />
                                      </Button>
                                    ) : null}
                                  </>
                                ) : null}
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    : null}
                </Fragment>
              );
            })
          )}
        </tbody>
      </Table>

      <PayslipCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => void fetchRows()}
      />

      <PayslipCompanyDialog open={companyOpen} onOpenChange={setCompanyOpen} />

      <PayrollBulkImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={() => void fetchRows()}
      />

      <AlertDialog
        open={confirmBulkDelete}
        onOpenChange={(open) => {
          if (!bulkDeleting) setConfirmBulkDelete(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {selected.size} payslip{selected.size === 1 ? "" : "s"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the selected payslip rows and any
              attached PDFs. Employees will lose access via /my-portal
              immediately. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkDeleting}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleBulkDelete();
              }}
              disabled={bulkDeleting}
              className={`
                bg-destructive
                hover:bg-destructive/90
              `}
            >
              {bulkDeleting ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  Deleting…
                </>
              ) : (
                "Delete"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
