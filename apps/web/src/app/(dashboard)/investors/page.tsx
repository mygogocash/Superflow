"use client";

import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  horizontalListSortingStrategy,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Activity,
  Archive,
  ArchiveRestore,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Contact2,
  Download,
  GripVertical,
  KanbanSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Tag,
  Target,
  Trash2,
  Upload,
  Users,
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

import { InvestorBulkTagsDialog } from "@/components/investor-crm/investor-bulk-tags-dialog";
import { InvestorTagChips } from "@/components/investor-crm/investor-tag-chips";
import { InvestorTagsManagerDialog } from "@/components/investor-crm/investor-tags-manager-dialog";
import { DeleteInvestorDialog } from "@/components/investors/delete-investor-dialog";
import { FundraisingEntitySwitcher } from "@/components/investors/fundraising-entity-switcher";
import { InvestorAccountsTab } from "@/components/investors/investor-accounts-tab";
import { InvestorActivitiesTab } from "@/components/investors/investor-activities-tab";
import { InvestorContactsTab } from "@/components/investors/investor-contacts-tab";
import { InvestorDetailSheet } from "@/components/investors/investor-detail-sheet";
import { InvestorFormDialog } from "@/components/investors/investor-form-dialog";
import { InvestorLeadsTab } from "@/components/investors/investor-leads-tab";
import { InvestorPipelineKanban } from "@/components/investors/investor-pipeline-kanban";
import { InvestorTasksTab } from "@/components/investors/investor-tasks-tab";
import { InvestorTypesManagerDialog } from "@/components/investors/investor-types-manager-dialog";
import { Badge } from "@/components/shared/badge";
import { CrmImportDialog } from "@/components/shared/crm-import-dialog";
import { DataPagination } from "@/components/shared/data-pagination";
import { PageHeader } from "@/components/shared/page-header";
import { PermissionButton } from "@/components/shared/permission-button";
import { PermissionDropdownMenuItem } from "@/components/shared/permission-dropdown-menu-item";
import { SortableColumnHead } from "@/components/shared/sortable-column-head";
import { Tabs as ArchiveTabs } from "@/components/shared/tabs";
import { useColumnOrder } from "@/components/shared/use-column-order";
import { useColumnWidths } from "@/components/shared/use-column-widths";
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
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useDebounce } from "@/hooks/use-debounce";
import { useInvestorTags } from "@/hooks/use-investor-tags";
import { useInvestorTypes } from "@/hooks/use-investor-types";
import { usePagination } from "@/hooks/use-pagination";
import { useTabParam } from "@/hooks/use-tab-param";
import { ApiError } from "@/lib/api-client";
import { type ExportFormat, exportRows } from "@/lib/crm-export";
import { useAuth } from "@/providers/auth-provider";
import {
  FundraisingEntityProvider,
  useFundraisingEntity,
} from "@/providers/fundraising-entity-provider";
import {
  type AssignableUser,
  listAssignableUsers,
} from "@/services/directory.service";
import {
  archiveInvestor,
  bulkDeleteInvestors,
  bulkSetInvestorTags,
  bulkUpdateInvestors,
  type CreateInvestorInput,
  formatInvestmentAmount,
  importInvestors,
  type Investor,
  INVESTOR_STATUSES,
  type InvestorBulkSelection,
  investorStatusLabel,
  listInvestors,
  normalizeInvestorStatus,
  reorderInvestors,
  unarchiveInvestor,
} from "@/services/investor.service";
import {
  type InvestorPipelineStage,
  listInvestorStages,
} from "@/services/investor-pipeline-stage.service";
import { INVESTOR_TAG_UNTAGGED } from "@/services/investor-tag.service";

const ALL_FILTER = "__all__";
const NO_GROUP = "__none__";

type GroupByKey = "status" | "type" | "region" | "owner";

// Resolve the group bucket (key + display label) for an investor under
// the active Group-by field. Used to fold the list into collapsible
// sections on the Investors tab.
function groupValueFor(
  investor: Investor,
  groupBy: GroupByKey,
): { key: string; label: string } {
  switch (groupBy) {
    case "status":
      return {
        key: investor.status,
        label: investorStatusLabel(investor.status),
      };
    case "type":
      // Label resolved dynamically by the caller (configurable types).
      return { key: investor.type || "—", label: investor.type || "—" };
    case "region":
      return {
        key: investor.region || "—",
        label: investor.region || "No region",
      };
    case "owner":
      return {
        key: investor.adder?.id ?? "—",
        label: investor.adder?.name ?? "Unassigned",
      };
  }
}

// Sales-CRM-style workspace tabs. Pipeline (kanban) is the landing tab;
// the est./act. roll-ups that used to live on a Dashboard tab now show
// per-column on the pipeline. Investors (list) + the investor-scoped
// Leads / Accounts / Contacts / Activities / Tasks entities follow.
const INVESTOR_TABS = [
  { value: "pipeline", label: "Pipeline", icon: KanbanSquare },
  { value: "investors", label: "Investors", icon: Users },
  { value: "leads", label: "Leads", icon: Sparkles },
  { value: "accounts", label: "Accounts", icon: Target },
  { value: "contacts", label: "Contacts", icon: Contact2 },
  { value: "activities", label: "Activities", icon: Activity },
  { value: "tasks", label: "Tasks", icon: CheckSquare },
] as const;

type InvestorTabValue = (typeof INVESTOR_TABS)[number]["value"];

// Shape the import dialog hands the submit handler. Mirrors the
// scalar fields on `CreateInvestorInput`; `notes` is intentionally
// excluded (server takes a JSON record, not a flat cell) and reps
// fill it in via the form after the row lands.
interface InvestorImportRow {
  name?: string;
  type?: string;
  status?: string;
  visibility?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  website?: string;
  location?: string;
  // Pipeline-master columns (2026-05-28).
  title?: string;
  linkedinUrl?: string;
  revenueStream?: string;
  lastContactDate?: string;
  nextAction?: string;
  actInvestment?: string;
  estInvestment?: string;
  crossSell?: string;
  region?: string;
  notesText?: string;
  // Fundraising vehicle, as the label or key the sheet carries. Resolved
  // against the catalog on submit; anything unrecognised falls back to
  // the active tab.
  entity?: string;
  // Comma- or semicolon-separated tag codes. The API has always accepted
  // `tags` on an import row (createInvestorSchema carries it) but this
  // interface never mapped the column, so nothing sent them and a tagged
  // import silently arrived untagged.
  tags?: string;
}

/**
 * Split a Tags cell into codes.
 *
 * Accepts commas or semicolons, and slugifies each entry so a sheet may write
 * either the machine code ("golden-gate-ventures") or the human label
 * ("Golden Gate Ventures") — both resolve to the same tag. Entries that cannot
 * become a code are dropped rather than failing the whole row.
 */
function parseImportTags(raw: unknown): string[] | undefined {
  if (raw === null || raw === undefined) return undefined;
  const codes = String(raw)
    .split(/[,;]/)
    .map((part) =>
      part
        .trim()
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, ""),
    )
    .filter(Boolean);
  return codes.length > 0 ? [...new Set(codes)] : undefined;
}

// Parse the assorted date shapes the source xlsx ships ("2025-05-15",
// "5/15/2025", or a serial number when xlsx is read in raw mode). Empty
// + unparseable cells fall through to undefined so the field clears.
function parseImportDate(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const s = String(raw).trim();
  if (!s || /^tbd$/i.test(s)) return undefined;
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/);
  if (iso) {
    return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  }
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    return `${mdy[3]}-${mdy[1].padStart(2, "0")}-${mdy[2].padStart(2, "0")}`;
  }
  const fallback = new Date(s);
  if (!Number.isNaN(fallback.getTime())) {
    return fallback.toISOString().slice(0, 10);
  }
  return undefined;
}

// Map the free-text "Category" cell from the pipeline-master sheet onto a
// configurable investor-type key. Unknown values fall through to "other"
// (the rep can re-tag via the Investors tab "Set type" bulk action or the
// type picker). Keys match the seeded InvestorTypeOption set.
function normaliseInvestorType(raw: string | undefined): string {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return "other";
  if (s.includes("family")) return "family_office";
  if (s.includes("sovereign") || s === "swf") return "sovereign_wealth_fund";
  if (s.includes("state capital") || s.includes("soe")) {
    return "state_capital_soe";
  }
  if (s.includes("corporate vc") || s === "cvc") return "corporate_vc";
  if (s.includes("corporate")) return "corporate_capital";
  if (s.includes("growth") || s.includes("late")) return "growth_late";
  if (s.includes("private equity") || s === "pe" || s.includes("/ am")) {
    return "private_equity";
  }
  if (s.includes("venture") || s === "vc") return "venture_capital";
  if (s.includes("angel")) return "angel";
  if (s.includes("individual")) return "individual";
  return "other";
}

function normaliseInvestorVisibility(raw: string | undefined): string {
  const s = (raw ?? "").trim().toLowerCase();
  if (s === "private" || s === "public") return s;
  return "team";
}

// Real-world xlsx ships "TBD" / "—" / "N/A" in the Email + Website
// columns when the rep hasn't filled them in. The server's zod
// validators (`z.string().email()` / `z.string().url()`) reject those
// strings, so every row gets dropped under `skipped` even though the
// rest of the data is fine. Coerce non-conforming cells to undefined
// before sending so the row imports and reps fill in the contact
// fields later via the form.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Resolve an Entity cell against the catalog. Accepts either the display
// label ("The Binary Labs") or the stored key ("tbl"), case-insensitively.
// A blank or unrecognised cell falls back to the active tab rather than
// failing the row — same tolerance as the status / visibility coercions
// above, and the row stays visible where the rep imported it.
function resolveImportEntity(
  raw: string | undefined,
  entities: { key: string; label: string }[],
  fallback: string,
): string {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s) return fallback;
  const hit = entities.find(
    (e) => e.key.toLowerCase() === s || e.label.toLowerCase() === s,
  );
  return hit?.key ?? fallback;
}

function coerceEmail(raw: string | undefined): string | undefined {
  const s = (raw ?? "").trim();
  if (!s || !EMAIL_RE.test(s)) return undefined;
  return s;
}
function coerceUrl(raw: string | undefined): string | undefined {
  const s = (raw ?? "").trim();
  if (!s) return undefined;
  try {
    // URL() throws on invalid input; only the parse path returns
    // the validated string. Schemes that aren't http(s) still parse
    // (e.g. `linkedin://`), which matches the server's permissive
    // `z.string().url()`.
    new URL(s);
    return s;
  } catch {
    return undefined;
  }
}

// Column meta for the dnd-kit-enabled Investor table. Mirrors the
// accounts-tab / partners / legal-crm pattern (#665 era) — short kebab
// keys are stable storage / sort identifiers; labels are display only.
type InvColKey =
  | "name"
  | "type"
  | "status"
  | "contact"
  | "location"
  | "region"
  | "title"
  | "linkedin"
  | "revenueStream"
  | "lastContact"
  | "nextAction"
  | "actInvestment"
  | "estInvestment"
  | "crossSell"
  | "investments";

const INV_COL_ORDER_KEY = "investors-col-order-v1";
const INV_COL_WIDTH_KEY = "investors-col-width-v1";

const INV_COL_DEFAULT_ORDER: readonly InvColKey[] = [
  "name",
  "type",
  "status",
  "contact",
  "location",
  "region",
  "title",
  "linkedin",
  "revenueStream",
  "lastContact",
  "nextAction",
  "actInvestment",
  "estInvestment",
  "crossSell",
  "investments",
];

// Keys that the backend SORTABLE whitelist accepts — others render
// without the sort-toggle indicator. Kept in sync with the repo file.
const INV_SORTABLE_KEYS: ReadonlySet<InvColKey> = new Set([
  "name",
  "type",
  "status",
  "contact",
  "location",
  "region",
  "title",
  "revenueStream",
  "lastContact",
  "nextAction",
  "actInvestment",
  "estInvestment",
  "crossSell",
]);

const INV_COL_META: Record<
  InvColKey,
  { label: string; headClassName?: string }
> = {
  name: { label: "Org Name" },
  type: { label: "Type" },
  status: { label: "Status" },
  contact: { label: "Contact" },
  location: { label: "Location" },
  region: { label: "Region" },
  title: { label: "Title" },
  linkedin: { label: "LinkedIn" },
  revenueStream: { label: "Revenue stream" },
  lastContact: { label: "Last contact" },
  nextAction: { label: "Next action" },
  actInvestment: { label: "Act. investment" },
  estInvestment: { label: "Est. investment" },
  crossSell: { label: "Cross-sell" },
  investments: { label: "Investments", headClassName: "text-center" },
};

const INV_COL_DEFAULT_WIDTHS: Record<InvColKey, number> = {
  name: 200,
  type: 110,
  status: 200,
  contact: 200,
  location: 140,
  region: 120,
  title: 160,
  linkedin: 90,
  revenueStream: 170,
  lastContact: 130,
  nextAction: 220,
  actInvestment: 140,
  estInvestment: 140,
  crossSell: 140,
  investments: 110,
};

export default function InvestorsPage() {
  return (
    <FundraisingEntityProvider>
      <InvestorsWorkspace />
    </FundraisingEntityProvider>
  );
}

function InvestorsWorkspace() {
  const [investors, setInvestors] = useState<Investor[]>([]);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 350);
  const [typeFilter, setTypeFilter] = useState<string>(ALL_FILTER);
  const [statusFilter, setStatusFilter] = useState<string>(ALL_FILTER);
  // Searchable label facet. ALL_FILTER = no constraint; the reserved
  // `__none__` code means "untagged".
  const [tagFilter, setTagFilter] = useState<string>(ALL_FILTER);
  const { tags: investorTags, refresh: refreshInvestorTags } =
    useInvestorTags();
  const [tagsManagerOpen, setTagsManagerOpen] = useState(false);
  // Active | Archived view for the Investors list. Archived is orthogonal to
  // the pipeline stage — it shows archived investors regardless of status.
  // The Pipeline kanban always shows active-only (backend default).
  const [archived, setArchived] = useState(false);
  // Column sort — undefined means "use the server's default manual
  // order". Clicking a sortable header toggles asc → desc → undefined
  // so reps can fall back to the manual order without a page reload.
  const [sortBy, setSortBy] = useState<string | undefined>(undefined);
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("asc");

  const pagination = usePagination();
  const {
    page,
    pageSize,
    setPage,
    setPageSize,
    setTotalCount,
    totalPages,
    totalCount,
  } = pagination;

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages, setPage]);

  const [formOpen, setFormOpen] = useState(false);
  const [editingInvestor, setEditingInvestor] = useState<Investor | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Investor | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  // Right-rail quick-view sheet — row click opens; "Edit" inside the
  // sheet hands off to the form dialog. Sheet stays open behind the
  // form so closing the dialog returns the rep to the detail view.
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailInvestorId, setDetailInvestorId] = useState<string | null>(null);

  // Workspace tab + a refresh key the Pipeline kanban watches so it
  // refetches after a create / edit / delete on the Investors tab.
  const [tab, setTab] = useTabParam("pipeline");
  const [pipelineRefreshKey, setPipelineRefreshKey] = useState(0);

  // Investors-tab grouping: fold the current page into collapsible
  // sections by status / type / region / owner. Collapsed group keys are
  // tracked so a rep can quickly open just the bucket they want.
  const [groupBy, setGroupBy] = useState<string>(NO_GROUP);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    new Set(),
  );
  const grouped = groupBy !== NO_GROUP;
  const investorGroups = useMemo(() => {
    if (!grouped) return [];
    const map = new Map<string, { label: string; items: Investor[] }>();
    for (const inv of investors) {
      const { key, label } = groupValueFor(inv, groupBy as GroupByKey);
      const bucket = map.get(key);
      if (bucket) bucket.items.push(inv);
      else map.set(key, { label, items: [inv] });
    }
    return [...map.entries()].map(([key, v]) => ({ key, ...v }));
  }, [grouped, groupBy, investors]);

  const toggleGroup = useCallback((key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Configurable investor types (filter / form / bulk / group labels).
  const {
    types: investorTypes,
    typeLabel,
    refresh: refreshTypes,
  } = useInvestorTypes();
  const [manageTypesOpen, setManageTypesOpen] = useState(false);

  // ── Bulk selection ──
  const { hasPermission } = useAuth();
  const { entities, entityKey, entityLabel } = useFundraisingEntity();
  const canBulkReassign = hasPermission("investors:read-all");
  const canManageTypes = hasPermission("investors:update");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Gmail-style "select all N matching the current filter" — supersedes
  // the per-row id set when on.
  const [selectAllMatching, setSelectAllMatching] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkTagsOpen, setBulkTagsOpen] = useState(false);
  // Stages for the bulk "Update status" picker + users for "Reassign
  // owner" (admins only).
  const [stages, setStages] = useState<InvestorPipelineStage[]>([]);
  const [assignableUsers, setAssignableUsers] = useState<AssignableUser[]>([]);

  const toggleSelectMany = useCallback((ids: string[], checked: boolean) => {
    setSelectAllMatching(false);
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const toggleSelectOne = useCallback(
    (id: string, checked: boolean) => toggleSelectMany([id], checked),
    [toggleSelectMany],
  );

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setSelectAllMatching(false);
  }, []);

  function openDetail(i: Investor) {
    setDetailInvestorId(i.id);
    setDetailOpen(true);
  }

  const { colOrder, isColumnId, reorderColumns } = useColumnOrder(
    INV_COL_ORDER_KEY,
    INV_COL_DEFAULT_ORDER,
  );
  const { widths, setWidth } = useColumnWidths(
    INV_COL_WIDTH_KEY,
    INV_COL_DEFAULT_WIDTHS,
  );

  // Row drag is disabled while any filter / search / sort is active —
  // a partial or re-sorted view can't safely write the global order.
  // Mirrors the legal-crm + sales-crm guard.
  const reorderEnabled = useMemo(
    () =>
      !debouncedSearch.trim() &&
      typeFilter === ALL_FILTER &&
      statusFilter === ALL_FILTER &&
      tagFilter === ALL_FILTER &&
      !sortBy &&
      !archived &&
      !loading,
    [
      debouncedSearch,
      typeFilter,
      statusFilter,
      tagFilter,
      sortBy,
      archived,
      loading,
    ],
  );
  // Snapshot the pre-drag order so a failed reorder POST can roll the
  // UI back without a refetch.
  const prePersistOrder = useRef<Investor[] | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const fetchInvestors = useCallback(async () => {
    try {
      setLoading(true);
      const result = await listInvestors({
        page,
        limit: pageSize,
        search: debouncedSearch || undefined,
        type: typeFilter !== ALL_FILTER ? typeFilter : undefined,
        status: statusFilter !== ALL_FILTER ? statusFilter : undefined,
        tag: tagFilter !== ALL_FILTER ? tagFilter : undefined,
        sortBy,
        sortOrder,
        archived: archived || undefined,
        fundraisingEntity: entityKey,
      });

      setInvestors(result.data);
      setTotalCount(result.meta.total);
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : "Failed to load investors";
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [
    page,
    pageSize,
    debouncedSearch,
    typeFilter,
    statusFilter,
    tagFilter,
    sortBy,
    sortOrder,
    archived,
    entityKey,
    setTotalCount,
  ]);

  useEffect(() => {
    void fetchInvestors();
  }, [fetchInvestors]);

  useEffect(() => {
    setPage(1);
  }, [
    debouncedSearch,
    typeFilter,
    statusFilter,
    tagFilter,
    archived,
    entityKey,
    setPage,
  ]);

  const handleCreate = useCallback(() => {
    setEditingInvestor(null);
    setFormOpen(true);
  }, []);

  const handleEdit = useCallback((investor: Investor) => {
    setEditingInvestor(investor);
    setFormOpen(true);
  }, []);

  const handleDelete = useCallback((investor: Investor) => {
    setDeleteTarget(investor);
    setDeleteOpen(true);
  }, []);

  const handleInvestorSaved = useCallback(
    (saved: Investor) => {
      if (editingInvestor) {
        setInvestors((prev) =>
          prev.map((i) => (i.id === saved.id ? saved : i)),
        );
      } else if (!archived) {
        // A newly created investor is active — it belongs to the Active view
        // only. On the Archived tab, skip the optimistic insert + count bump.
        setTotalCount((c) => c + 1);
        if (page === 1) {
          setInvestors((prev) => {
            const next = [saved, ...prev];
            return next.length > pageSize ? next.slice(0, pageSize) : next;
          });
        }
      }
      setPipelineRefreshKey((k) => k + 1);
    },
    [editingInvestor, archived, page, pageSize, setTotalCount],
  );

  const handleInvestorDeleted = useCallback(
    (deleted: Investor) => {
      setInvestors((prev) => prev.filter((i) => i.id !== deleted.id));
      setTotalCount((c) => Math.max(0, c - 1));
      setDeleteTarget(null);
      setPipelineRefreshKey((k) => k + 1);
    },
    [setTotalCount],
  );

  // Archive / restore. The current view (active vs archived) is the opposite
  // of the row's new state, so the row leaves the current list either way —
  // drop it optimistically and adjust the total. Bump the pipeline refresh key
  // so the kanban drops (archive) or regains (restore) the card.
  const handleArchive = useCallback(
    async (investor: Investor) => {
      try {
        await archiveInvestor(investor.id);
        setInvestors((prev) => prev.filter((i) => i.id !== investor.id));
        setTotalCount((c) => Math.max(0, c - 1));
        setPipelineRefreshKey((k) => k + 1);
        toast.success("Investor archived");
      } catch (err) {
        toast.error(
          err instanceof ApiError ? err.message : "Failed to archive investor",
        );
      }
    },
    [setTotalCount],
  );

  const handleUnarchive = useCallback(
    async (investor: Investor) => {
      try {
        await unarchiveInvestor(investor.id);
        setInvestors((prev) => prev.filter((i) => i.id !== investor.id));
        setTotalCount((c) => Math.max(0, c - 1));
        setPipelineRefreshKey((k) => k + 1);
        toast.success("Investor restored");
      } catch (err) {
        toast.error(
          err instanceof ApiError ? err.message : "Failed to restore investor",
        );
      }
    },
    [setTotalCount],
  );

  const filtersDirty = useMemo(
    () =>
      Boolean(
        debouncedSearch ||
        typeFilter !== ALL_FILTER ||
        statusFilter !== ALL_FILTER ||
        tagFilter !== ALL_FILTER,
      ),
    [debouncedSearch, typeFilter, statusFilter, tagFilter],
  );

  function clearFilters() {
    setSearch("");
    setTypeFilter(ALL_FILTER);
    setStatusFilter(ALL_FILTER);
    setTagFilter(ALL_FILTER);
    // Reset sort to manual-order default so "Clear" gets the rep back
    // to the drag-arranged baseline in one click.
    setSortBy(undefined);
    setSortOrder("asc");
  }

  // Tri-state toggle so clicking a header cycles asc → desc →
  // manual-order. Same column re-click flips direction; new column
  // starts at asc; third click on the same column clears the sort.
  function handleSortChange(key: string) {
    if (sortBy !== key) {
      setSortBy(key);
      setSortOrder("asc");
      return;
    }
    if (sortOrder === "asc") {
      setSortOrder("desc");
      return;
    }
    setSortBy(undefined);
    setSortOrder("asc");
  }

  // Pull every investor the active filter / scope allows (capped at
  // 1000) and emit a CSV / xlsx of every Investor column. Non-`read-all`
  // users only see their own records (the same scope the table uses),
  // so the export respects their visibility.
  const handleExport = useCallback(
    async (formatType: ExportFormat) => {
      setExporting(true);
      try {
        const result = await listInvestors({
          page: 1,
          limit: 1000,
          search: debouncedSearch || undefined,
          type: typeFilter !== ALL_FILTER ? typeFilter : undefined,
          status: statusFilter !== ALL_FILTER ? statusFilter : undefined,
          tag: tagFilter !== ALL_FILTER ? tagFilter : undefined,
          archived: archived || undefined,
          fundraisingEntity: entityKey,
        });
        if (result.data.length === 0) {
          toast.error("Nothing to export");
          return;
        }
        // Header set mirrors the "Pipeline Master.xlsx" so reps
        // can export → edit → re-import without renaming columns.
        // Extra audit columns (Investments / Added By / Created /
        // Notes JSON / Phone / Website / Visibility) are appended
        // after the pipeline set since the source file doesn't carry
        // them.
        exportRows(
          "investors",
          [
            { header: "Org Name", value: (i: Investor) => i.name },
            {
              header: "Entity",
              value: (i: Investor) => entityLabel(i.fundraisingEntity),
            },
            { header: "Category", value: (i: Investor) => i.type },
            // Exported so a tagged batch round-trips through xlsx — the
            // import mapper reads the same header back.
            {
              header: "Tags",
              value: (i: Investor) => (i.tags ?? []).join(", "),
            },
            { header: "Location", value: (i: Investor) => i.location ?? "" },
            {
              header: "Key Contact",
              value: (i: Investor) => i.contactName ?? "",
            },
            { header: "Title", value: (i: Investor) => i.title ?? "" },
            {
              header: "Email",
              value: (i: Investor) => i.contactEmail ?? "",
            },
            {
              header: "LinkedIn URL",
              value: (i: Investor) => i.linkedinUrl ?? "",
            },
            {
              header: "Revenue Stream",
              value: (i: Investor) => i.revenueStream ?? "",
            },
            { header: "Pipeline Status", value: (i: Investor) => i.status },
            {
              header: "Last Contact",
              value: (i: Investor) =>
                i.lastContactDate ? i.lastContactDate.slice(0, 10) : "",
            },
            {
              header: "Next Action",
              value: (i: Investor) => i.nextAction ?? "",
            },
            {
              header: "Act Investment",
              value: (i: Investor) => i.actInvestment ?? "",
            },
            {
              header: "Est Investment",
              value: (i: Investor) => i.estInvestment ?? "",
            },
            {
              header: "Cross-Sell",
              value: (i: Investor) => i.crossSell ?? "",
            },
            { header: "Notes", value: (i: Investor) => i.notesText ?? "" },
            { header: "Region", value: (i: Investor) => i.region ?? "" },
            // Audit columns
            { header: "Visibility", value: (i: Investor) => i.visibility },
            {
              header: "Contact Phone",
              value: (i: Investor) => i.contactPhone ?? "",
            },
            { header: "Website", value: (i: Investor) => i.website ?? "" },
            {
              header: "Investments",
              value: (i: Investor) => i._count?.investments ?? 0,
            },
            {
              header: "Added By",
              value: (i: Investor) => i.adder?.name ?? "",
            },
            { header: "Created", value: (i: Investor) => i.createdAt },
            {
              header: "Notes (JSON)",
              value: (i: Investor) => (i.notes ? JSON.stringify(i.notes) : ""),
            },
          ],
          result.data,
          formatType,
        );
      } catch (err) {
        const message =
          err instanceof ApiError ? err.message : "Failed to export";
        toast.error(message);
      } finally {
        setExporting(false);
      }
    },
    [
      debouncedSearch,
      typeFilter,
      statusFilter,
      tagFilter,
      archived,
      entityKey,
      entityLabel,
    ],
  );

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    // Header drag → column reorder. Column ids are short literal
    // strings, distinct from investor cuids used for row drag.
    if (isColumnId(active.id)) {
      if (isColumnId(over.id)) reorderColumns(active.id, over.id);
      return;
    }

    if (!reorderEnabled) return;
    const oldIndex = investors.findIndex((i) => i.id === active.id);
    const newIndex = investors.findIndex((i) => i.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;

    prePersistOrder.current = investors;
    const next = arrayMove(investors, oldIndex, newIndex);
    setInvestors(next);

    try {
      await reorderInvestors(next.map((i) => i.id));
    } catch (err) {
      if (prePersistOrder.current) setInvestors(prePersistOrder.current);
      const message =
        err instanceof ApiError ? err.message : "Failed to reorder investors";
      toast.error(message);
    } finally {
      prePersistOrder.current = null;
    }
  }

  // Per-investor row + cell renderer. Inlined here (instead of a
  // separate component file) since the cell switch is tightly coupled
  // to the page's edit / delete handlers + permission checks.
  function renderCell(i: Investor, key: InvColKey) {
    switch (key) {
      case "name":
        return (
          <div className="min-w-0">
            <span
              className="text-foreground block truncate text-xs font-medium"
              title={i.name}
            >
              {i.name}
            </span>
            {/*
              Chips under the name rather than a column of their own: this
              table's columns are a reorderable registry keyed by InvColKey,
              and tags are a set, not a sortable scalar. The filter Select
              above is what makes them queryable. Same placement the kanban
              cards use for business units.
            */}
            <InvestorTagChips codes={i.tags} max={2} className="mt-0.5" />
          </div>
        );
      case "type":
        return (
          <span className="block truncate text-xs">{typeLabel(i.type)}</span>
        );
      case "status":
        return <Badge status={i.status}>{investorStatusLabel(i.status)}</Badge>;
      case "contact":
        return (
          <div className="min-w-0">
            {i.contactName && (
              <p className="truncate text-xs">{i.contactName}</p>
            )}
            {i.contactEmail && (
              <p className="text-muted-foreground truncate text-[11px]">
                {i.contactEmail}
              </p>
            )}
            {!i.contactName && !i.contactEmail && "-"}
          </div>
        );
      case "location":
        return (
          <span className="block truncate text-xs">{i.location ?? "-"}</span>
        );
      case "region":
        return (
          <span className="block truncate text-xs">{i.region ?? "-"}</span>
        );
      case "title":
        return <span className="block truncate text-xs">{i.title ?? "-"}</span>;
      case "linkedin":
        return i.linkedinUrl ? (
          <a
            href={i.linkedinUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={`
              text-primary text-[11px]
              hover:underline
            `}
            onClick={(e) => e.stopPropagation()}
          >
            link
          </a>
        ) : (
          "-"
        );
      case "revenueStream":
        return (
          <span className="block truncate text-xs">
            {i.revenueStream ?? "-"}
          </span>
        );
      case "lastContact":
        return (
          <span className="block truncate text-xs">
            {i.lastContactDate
              ? new Date(i.lastContactDate).toLocaleDateString("en-GB", {
                  day: "2-digit",
                  month: "short",
                  year: "numeric",
                })
              : "-"}
          </span>
        );
      case "nextAction":
        return i.nextAction ? (
          <span
            className="line-clamp-2 max-w-[220px] text-[11px]"
            title={i.nextAction}
          >
            {i.nextAction}
          </span>
        ) : (
          "-"
        );
      case "actInvestment":
        return (
          <span className="block truncate text-xs tabular-nums">
            {formatInvestmentAmount(i.actInvestment)}
          </span>
        );
      case "estInvestment":
        return (
          <span className="block truncate text-xs tabular-nums">
            {formatInvestmentAmount(i.estInvestment)}
          </span>
        );
      case "crossSell":
        return (
          <span className="block truncate text-xs">{i.crossSell ?? "-"}</span>
        );
      case "investments":
        return (
          <span className="block text-center text-xs tabular-nums">
            {i._count?.investments ?? 0}
          </span>
        );
    }
  }

  // Skeleton row count for the loading state — matches the page-size
  // limit cap; the rep almost never sees more than 5-10 in a single
  // viewport, but keeping it generous prevents jank when the page
  // first loads.
  const skeletonRows = Array.from({ length: Math.min(pageSize, 8) });

  // ── Bulk selection derived state + actions ──
  const pageIds = investors.map((i) => i.id);
  const pageAllSelected =
    pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
  const pageSomeSelected =
    !pageAllSelected && pageIds.some((id) => selectedIds.has(id));
  const selectedCount = selectAllMatching ? totalCount : selectedIds.size;
  const hasSelection = selectAllMatching || selectedIds.size > 0;

  function toggleSelectPage(checked: boolean) {
    toggleSelectMany(pageIds, checked);
  }

  // Load stages (bulk status picker) + assignable users (owner reassign,
  // admins only). Stages refresh implicitly via the page mount.
  useEffect(() => {
    listInvestorStages()
      .then((r) => setStages(r.data))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (!canBulkReassign) return;
    listAssignableUsers()
      .then((r) => setAssignableUsers(r.data ?? []))
      .catch(() => undefined);
  }, [canBulkReassign]);

  // Reset selection when the matching set changes underneath it.
  useEffect(() => {
    clearSelection();
  }, [
    debouncedSearch,
    typeFilter,
    statusFilter,
    tagFilter,
    archived,
    entityKey,
    clearSelection,
  ]);

  // Build the payload for the active selection mode.
  function bulkSelectionPayload(): InvestorBulkSelection {
    if (selectAllMatching) {
      return {
        allMatching: true,
        filter: {
          search: debouncedSearch || undefined,
          type: typeFilter !== ALL_FILTER ? typeFilter : undefined,
          status: statusFilter !== ALL_FILTER ? statusFilter : undefined,
          tag: tagFilter !== ALL_FILTER ? tagFilter : undefined,
          // Scope "all matching" to the view the rep is looking at so a bulk
          // action in the Archived view can't hit active rows.
          archived: archived || undefined,
          fundraisingEntity: entityKey,
        },
      };
    }
    return { ids: [...selectedIds] };
  }

  async function runBulk(
    fn: () => Promise<{
      data: { updated?: number; deleted?: number; skipped?: number };
    }>,
    verb: string,
  ) {
    try {
      setBulkBusy(true);
      const res = await fn();
      const n = res.data.updated ?? res.data.deleted ?? 0;
      // Report skipped rows explicitly. Archive/restore narrows its where to
      // rows not already in the target state, so "Archived 7" against a
      // selection of 10 reads as a partial failure unless the other 3 are
      // named as deliberately untouched.
      const skipped = res.data.skipped ?? 0;
      // "unchanged" reads correctly for both directions — already archived
      // when archiving, already active when restoring.
      const suffix = skipped > 0 ? `, ${skipped} unchanged` : "";
      toast.success(`${verb} ${n} investor${n === 1 ? "" : "s"}${suffix}`);
      clearSelection();
      await fetchInvestors();
      setPipelineRefreshKey((k) => k + 1);
    } catch (err) {
      const m =
        err instanceof ApiError
          ? err.message
          : `Failed to ${verb.toLowerCase()}`;
      toast.error(m);
    } finally {
      setBulkBusy(false);
    }
  }

  function bulkSetStatus(status: string) {
    void runBulk(
      () => bulkUpdateInvestors({ ...bulkSelectionPayload(), set: { status } }),
      "Updated",
    );
  }
  function bulkSetType(type: string) {
    void runBulk(
      () => bulkUpdateInvestors({ ...bulkSelectionPayload(), set: { type } }),
      "Updated",
    );
  }
  function bulkSetEntity(fundraisingEntity: string) {
    void runBulk(
      () =>
        bulkUpdateInvestors({
          ...bulkSelectionPayload(),
          set: { fundraisingEntity },
        }),
      "Moved",
    );
  }
  function bulkSetOwner(addedBy: string) {
    void runBulk(
      () =>
        bulkUpdateInvestors({ ...bulkSelectionPayload(), set: { addedBy } }),
      "Reassigned",
    );
  }
  // Archive / restore. The API narrows its own where so an already-archived
  // row keeps its original archivedAt — re-archiving is a no-op, not a
  // silent re-stamp.
  function bulkArchive(next: boolean) {
    void runBulk(
      () =>
        bulkUpdateInvestors({
          ...bulkSelectionPayload(),
          set: { archived: next },
        }),
      next ? "Archived" : "Restored",
    );
  }

  function bulkDelete() {
    if (
      !window.confirm(
        `Delete ${selectedCount} investor${selectedCount === 1 ? "" : "s"}? This cannot be undone.`,
      )
    ) {
      return;
    }
    void runBulk(() => bulkDeleteInvestors(bulkSelectionPayload()), "Deleted");
  }

  return (
    <div>
      <PageHeader
        title="Investor Dashboard"
        subtitle="Cap table and investor relations"
      >
        <div className="flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" disabled={exporting}>
                <Download className="size-3.5" />
                Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => void handleExport("csv")}>
                CSV
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void handleExport("xlsx")}>
                Excel (.xlsx)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <PermissionButton
            variant="outline"
            permission="investors:update"
            onClick={() => setTagsManagerOpen(true)}
          >
            <Tag className="size-3.5" />
            Tag management
          </PermissionButton>
          <PermissionButton
            variant="outline"
            permission="investors:create"
            onClick={() => setImportOpen(true)}
          >
            <Upload className="size-3.5" />
            Import
          </PermissionButton>
          <PermissionButton
            variant="accent"
            permission="investors:create"
            onClick={handleCreate}
          >
            <Plus className="size-3.5" />
            Add investor
          </PermissionButton>
        </div>
      </PageHeader>

      <FundraisingEntitySwitcher />

      <Tabs value={tab} onValueChange={(v) => setTab(v as InvestorTabValue)}>
        {/*
          `group-data-[orientation=horizontal]/tabs:h-auto` comes from the
          responsive work (#1188): TabsList's own height is set by that same
          variant, and twMerge only dedupes classes carrying the SAME variant,
          so a bare `h-auto` would not conflict and the seven-tab strip would
          stay a fixed 32px box while wrapping to three rows inside it.
        */}
        <TabsList
          className={`
            mb-6 flex flex-wrap
            group-data-[orientation=horizontal]/tabs:h-auto
          `}
        >
          {INVESTOR_TABS.map(({ value, label, icon: Icon }) => (
            <TabsTrigger key={value} value={value} className="gap-1.5">
              <Icon className="size-3.5" />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="pipeline">
          <InvestorPipelineKanban
            refreshKey={pipelineRefreshKey}
            onOpenInvestor={(id) => {
              setDetailInvestorId(id);
              setDetailOpen(true);
            }}
          />
        </TabsContent>

        <TabsContent value="leads">
          <InvestorLeadsTab />
        </TabsContent>
        <TabsContent value="accounts">
          <InvestorAccountsTab />
        </TabsContent>
        <TabsContent value="contacts">
          <InvestorContactsTab />
        </TabsContent>
        <TabsContent value="activities">
          <InvestorActivitiesTab />
        </TabsContent>
        <TabsContent value="tasks">
          <InvestorTasksTab />
        </TabsContent>

        <TabsContent value="investors">
          <div className="flex flex-col gap-4">
            <ArchiveTabs
              tabs={[
                { id: "active", label: "Active" },
                { id: "archived", label: "Archived" },
              ]}
              active={archived ? "archived" : "active"}
              onChange={(v) => setArchived(v === "archived")}
            />

            <div
              className={`
                border-border bg-surface flex flex-col gap-2 rounded-lg border
                p-3 shadow-sm
                md:flex-row md:items-center
              `}
            >
              <div className="relative flex-1">
                <Search
                  className={`
                    text-muted-foreground absolute top-1/2 left-2.5 size-3.5
                    -translate-y-1/2
                  `}
                />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by name, contact or email…"
                  className="h-8 pl-8 text-xs"
                />
              </div>

              <div
                className={`
                  grid grid-cols-2 gap-2
                  md:flex md:items-center
                `}
              >
                <Select value={typeFilter} onValueChange={setTypeFilter}>
                  <SelectTrigger className="h-10 min-w-[140px] text-xs">
                    <SelectValue placeholder="Type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_FILTER}>All types</SelectItem>
                    {investorTypes.map((t) => (
                      <SelectItem key={t.key} value={t.key}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="h-10 min-w-[120px] text-xs">
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_FILTER}>All statuses</SelectItem>
                    {INVESTOR_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {investorStatusLabel(s)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {/*
                  Tag facet. Rendered only when the catalog has rows, so a
                  workspace that has never created a tag sees no dead
                  control. "Untagged" uses the reserved __none__ sentinel.
                */}
                {investorTags.length > 0 ? (
                  <Select value={tagFilter} onValueChange={setTagFilter}>
                    <SelectTrigger className="h-10 min-w-[120px] text-xs">
                      <SelectValue placeholder="Tag" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL_FILTER}>All tags</SelectItem>
                      <SelectItem value={INVESTOR_TAG_UNTAGGED}>
                        Untagged
                      </SelectItem>
                      {investorTags.map((t) => (
                        <SelectItem key={t.code} value={t.code}>
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}

                <Select value={groupBy} onValueChange={setGroupBy}>
                  <SelectTrigger className="h-10 min-w-[130px] text-xs">
                    <SelectValue placeholder="Group by" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_GROUP}>No grouping</SelectItem>
                    <SelectItem value="status">Group by status</SelectItem>
                    <SelectItem value="type">Group by type</SelectItem>
                    <SelectItem value="region">Group by region</SelectItem>
                    <SelectItem value="owner">Group by owner</SelectItem>
                  </SelectContent>
                </Select>

                {canManageTypes ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="text-xs"
                    onClick={() => setManageTypesOpen(true)}
                  >
                    Manage types
                  </Button>
                ) : null}
              </div>

              {filtersDirty && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={clearFilters}
                  className="text-xs"
                >
                  Clear
                </Button>
              )}
            </div>

            {hasSelection ? (
              <div
                className={`
                  border-border bg-surface sticky top-0 z-20 mb-2 flex flex-wrap
                  items-center gap-2 rounded-lg border p-2 shadow-sm
                `}
              >
                <span className="text-sm font-medium">
                  {selectedCount} selected
                </span>
                {pageAllSelected &&
                !selectAllMatching &&
                totalCount > pageIds.length ? (
                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    onClick={() => setSelectAllMatching(true)}
                  >
                    Select all {totalCount} matching
                  </Button>
                ) : null}
                {selectAllMatching ? (
                  <span className="text-muted-foreground text-xs">
                    All matching the current filter
                  </span>
                ) : null}

                <div className="ml-auto flex flex-wrap items-center gap-1.5">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm" disabled={bulkBusy}>
                        Set status
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="end"
                      className="max-h-72 overflow-auto"
                    >
                      {stages.map((s) => (
                        <DropdownMenuItem
                          key={s.key}
                          onClick={() => bulkSetStatus(s.key)}
                        >
                          {s.label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm" disabled={bulkBusy}>
                        Set type
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="end"
                      className="max-h-72 overflow-auto"
                    >
                      {investorTypes.map((t) => (
                        <DropdownMenuItem
                          key={t.key}
                          onClick={() => bulkSetType(t.key)}
                        >
                          {t.label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm" disabled={bulkBusy}>
                        Move to entity
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="end"
                      className="max-h-72 overflow-auto"
                    >
                      {entities.map((e) => (
                        <DropdownMenuItem
                          key={e.key}
                          onClick={() => bulkSetEntity(e.key)}
                        >
                          {e.label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>

                  {canBulkReassign ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="outline" size="sm" disabled={bulkBusy}>
                          Reassign owner
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        className="max-h-72 overflow-auto"
                      >
                        {assignableUsers.map((u) => (
                          <DropdownMenuItem
                            key={u.id}
                            onClick={() => bulkSetOwner(u.id)}
                          >
                            {u.name}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}

                  <PermissionButton
                    permission="investors:update"
                    variant="outline"
                    size="sm"
                    onClick={() => setBulkTagsOpen(true)}
                    disabled={bulkBusy}
                  >
                    Set tags
                  </PermissionButton>

                  {/* Offered per view so a no-op button never sits beside a
                      real one: Archive in Active, Restore in Archived. */}
                  <PermissionButton
                    permission="investors:update"
                    variant="outline"
                    size="sm"
                    onClick={() => bulkArchive(!archived)}
                    disabled={bulkBusy}
                  >
                    {archived ? "Restore" : "Archive"}
                  </PermissionButton>

                  <PermissionButton
                    permission="investors:delete"
                    variant="outline"
                    size="sm"
                    className="text-destructive"
                    onClick={bulkDelete}
                    disabled={bulkBusy}
                  >
                    <Trash2 className="mr-1 size-3.5" />
                    Delete
                  </PermissionButton>

                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={clearSelection}
                  >
                    Clear
                  </Button>
                </div>
              </div>
            ) : null}

            {!reorderEnabled && !loading ? (
              <p className="text-muted-foreground mb-2 text-[11px]">
                Drag-to-reorder rows is disabled while a filter, search, sort,
                or selection is active. Column reorder + resize still work.
              </p>
            ) : null}

            <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
              <Table
                className="table-fixed"
                containerClassName={`
              max-h-[60svh] md:max-h-[calc(100vh-280px)] overflow-auto rounded-lg border
            `}
              >
                <TableHeader className="bg-background sticky top-0 z-10">
                  <TableRow>
                    <TableHead className="w-[36px]">
                      <Checkbox
                        checked={
                          pageAllSelected
                            ? true
                            : pageSomeSelected
                              ? "indeterminate"
                              : false
                        }
                        onCheckedChange={(c) => toggleSelectPage(c === true)}
                        aria-label="Select all on this page"
                      />
                    </TableHead>
                    <TableHead className="w-[36px]" />
                    <SortableContext
                      items={colOrder}
                      strategy={horizontalListSortingStrategy}
                    >
                      {colOrder.map((key) => (
                        <SortableColumnHead
                          key={key}
                          colKey={key}
                          label={INV_COL_META[key].label}
                          className={INV_COL_META[key].headClassName}
                          width={widths[key]}
                          onResize={(k, w) => setWidth(k as InvColKey, w)}
                          sortable={INV_SORTABLE_KEYS.has(key)}
                          sortBy={sortBy}
                          sortOrder={sortOrder}
                          onSortClick={handleSortChange}
                        />
                      ))}
                    </SortableContext>
                    <TableHead />
                    <TableHead className="w-[40px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading ? (
                    skeletonRows.map((_, idx) => (
                      <TableRow key={`skeleton-${idx}`}>
                        <TableCell colSpan={colOrder.length + 4}>
                          <Skeleton className="h-6 w-full" />
                        </TableCell>
                      </TableRow>
                    ))
                  ) : investors.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={colOrder.length + 4}
                        className={`
                          text-muted-foreground py-10 text-center text-xs
                        `}
                      >
                        No investors found
                      </TableCell>
                    </TableRow>
                  ) : grouped ? (
                    investorGroups.map((g) => {
                      const isCollapsed = collapsedGroups.has(g.key);
                      return (
                        <Fragment key={g.key}>
                          <TableRow
                            className={`
                              bg-muted/40 cursor-pointer
                              hover:bg-muted/60
                            `}
                            onClick={() => toggleGroup(g.key)}
                          >
                            <TableCell
                              className="w-[36px]"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <Checkbox
                                checked={
                                  g.items.every((i) => selectedIds.has(i.id))
                                    ? true
                                    : g.items.some((i) => selectedIds.has(i.id))
                                      ? "indeterminate"
                                      : false
                                }
                                onCheckedChange={(c) =>
                                  toggleSelectMany(
                                    g.items.map((i) => i.id),
                                    c === true,
                                  )
                                }
                                aria-label={`Select group ${g.label}`}
                              />
                            </TableCell>
                            <TableCell
                              colSpan={colOrder.length + 3}
                              className="py-2"
                            >
                              <span
                                className={`
                                  flex items-center gap-2 text-xs font-semibold
                                `}
                              >
                                {isCollapsed ? (
                                  <ChevronRight className="size-3.5" />
                                ) : (
                                  <ChevronDown className="size-3.5" />
                                )}
                                {groupBy === "type"
                                  ? typeLabel(g.key)
                                  : g.label}
                                <span
                                  className={`text-muted-foreground font-normal`}
                                >
                                  {g.items.length}
                                </span>
                              </span>
                            </TableCell>
                          </TableRow>
                          {!isCollapsed &&
                            g.items.map((i) => (
                              <SortableInvestorRow
                                key={i.id}
                                investor={i}
                                colOrder={colOrder}
                                canDrag={false}
                                selected={selectedIds.has(i.id)}
                                onToggleSelect={toggleSelectOne}
                                renderCell={renderCell}
                                onRowClick={() => openDetail(i)}
                                onEdit={() => handleEdit(i)}
                                onDelete={() => handleDelete(i)}
                                isArchivedView={archived}
                                onArchive={() => void handleArchive(i)}
                                onUnarchive={() => void handleUnarchive(i)}
                              />
                            ))}
                        </Fragment>
                      );
                    })
                  ) : (
                    <SortableContext
                      items={investors.map((i) => i.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      {investors.map((i) => (
                        <SortableInvestorRow
                          key={i.id}
                          investor={i}
                          colOrder={colOrder}
                          canDrag={reorderEnabled && selectedIds.size === 0}
                          selected={selectedIds.has(i.id)}
                          onToggleSelect={toggleSelectOne}
                          renderCell={renderCell}
                          onRowClick={() => openDetail(i)}
                          onEdit={() => handleEdit(i)}
                          onDelete={() => handleDelete(i)}
                          isArchivedView={archived}
                          onArchive={() => void handleArchive(i)}
                          onUnarchive={() => void handleUnarchive(i)}
                        />
                      ))}
                    </SortableContext>
                  )}
                </TableBody>
              </Table>
            </DndContext>

            <div className="mt-3">
              <DataPagination
                page={page}
                pageSize={pageSize}
                totalCount={totalCount}
                totalPages={totalPages}
                onPageChange={setPage}
                onPageSizeChange={setPageSize}
              />
            </div>
          </div>
        </TabsContent>
      </Tabs>

      <InvestorDetailSheet
        open={detailOpen}
        onOpenChange={setDetailOpen}
        investorId={detailInvestorId}
        onEdit={(inv) => {
          setDetailOpen(false);
          handleEdit(inv);
        }}
      />

      <InvestorFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        investor={editingInvestor}
        fundraisingEntity={entityKey}
        onSaved={handleInvestorSaved}
      />

      <InvestorTypesManagerDialog
        open={manageTypesOpen}
        onOpenChange={setManageTypesOpen}
        onChanged={() => {
          void refreshTypes();
          void fetchInvestors();
        }}
      />

      {/*
        Refetches the rows as well as the catalog: deleting a tag strips it
        from investors server-side, so the chips on screen are stale until
        the list is re-read.
      */}
      <InvestorBulkTagsDialog
        open={bulkTagsOpen}
        onOpenChange={setBulkTagsOpen}
        count={selectedCount}
        selection={bulkSelectionPayload()}
        submit={bulkSetInvestorTags}
        onDone={() => {
          clearSelection();
          void fetchInvestors();
          setPipelineRefreshKey((k) => k + 1);
        }}
      />

      <InvestorTagsManagerDialog
        open={tagsManagerOpen}
        onOpenChange={setTagsManagerOpen}
        onChanged={() => {
          void refreshInvestorTags();
          void fetchInvestors();
        }}
      />

      <DeleteInvestorDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        investor={deleteTarget}
        onDeleted={handleInvestorDeleted}
      />

      <CrmImportDialog<InvestorImportRow>
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={() => {
          void fetchInvestors();
          setPipelineRefreshKey((k) => k + 1);
        }}
        title="Import investors"
        entityLabel="investors"
        templateName="investors-import-template"
        fields={[
          // Accept the common header variants reps ship from their
          // spreadsheets / CRM exports — pure "Name" is the template
          // default, but real files arrive as "Investor Name",
          // "Company", "Fund", etc. CrmImportDialog matches headers
          // case-insensitively against this list, so the first hit
          // wins and the rest fall through to undefined.
          // Aligned with the "Pipeline Master.xlsx" column set
          // (Org Name | Category | Location | Key Contact | Title |
          // Email | LinkedIn URL | Revenue Stream | Pipeline Status |
          // Last Contact | Next Action | Est Commission | Cross-Sell |
          // Notes | Region). Header matching is case-insensitive +
          // first-hit-wins inside CrmImportDialog so older exports
          // (Name / Investor Name / etc.) still resolve.
          {
            key: "name",
            headers: [
              "Org Name",
              "Name",
              "Investor Name",
              "Investor",
              "Company",
              "Fund",
            ],
            type: "string",
            required: true,
          },
          {
            key: "tags",
            headers: ["Tags", "Tag", "Groups", "Group"],
            type: "string",
          },
          {
            key: "entity",
            headers: ["Entity", "Fundraising Entity", "Vehicle"],
            type: "string",
          },
          {
            key: "type",
            headers: ["Category", "Type", "Investor Type"],
            type: "string",
          },
          {
            key: "status",
            headers: ["Pipeline Status", "Status", "Stage"],
            type: "string",
          },
          { key: "visibility", headers: ["Visibility"], type: "string" },
          {
            key: "contactName",
            headers: [
              "Key Contact",
              "Contact Name",
              "Contact",
              "POC",
              "Primary Contact",
            ],
            type: "string",
          },
          {
            key: "title",
            headers: ["Title", "Role", "Position"],
            type: "string",
          },
          {
            key: "contactEmail",
            headers: ["Email", "Contact Email"],
            type: "string",
          },
          {
            key: "contactPhone",
            headers: ["Contact Phone", "Phone", "Mobile"],
            type: "string",
          },
          {
            key: "linkedinUrl",
            headers: ["LinkedIn URL", "LinkedIn"],
            type: "string",
          },
          {
            key: "website",
            headers: ["Website", "URL", "Site"],
            type: "string",
          },
          {
            key: "location",
            headers: ["Location", "Country", "City"],
            type: "string",
          },
          { key: "region", headers: ["Region"], type: "string" },
          {
            key: "revenueStream",
            headers: ["Revenue Stream", "Service"],
            type: "string",
          },
          {
            key: "lastContactDate",
            headers: ["Last Contact", "Last Contact Date"],
            type: "string",
          },
          {
            key: "nextAction",
            headers: ["Next Action", "Next Step"],
            type: "string",
          },
          {
            key: "actInvestment",
            headers: ["Act Investment", "Actual Investment", "Actual"],
            type: "string",
          },
          {
            // Accepts the new "Est Investment" header BD ships in the
            // 2026-05-28 template plus the legacy "Est Commission"
            // alias so older exports still resolve onto this field.
            key: "estInvestment",
            headers: [
              "Est Investment",
              "Estimated Investment",
              "Est Commission",
              "Estimated Commission",
              "Commission",
            ],
            type: "string",
          },
          {
            key: "crossSell",
            headers: ["Cross-Sell", "Cross Sell"],
            type: "string",
          },
          {
            key: "notesText",
            headers: ["Notes", "Pitch Notes", "Notes Text"],
            type: "string",
          },
        ]}
        submit={async (rows) => {
          // Coerce loose type/status/visibility cells to the server's
          // enum values, drop empty optionals (server's email/url
          // validators reject "") and forward the rest as-is.
          const payload: CreateInvestorInput[] = rows.map((r) => ({
            name: (r.name ?? "").trim(),
            type: normaliseInvestorType(r.type),
            status: normalizeInvestorStatus(r.status),
            visibility: normaliseInvestorVisibility(r.visibility),
            contactName: r.contactName?.trim() || undefined,
            // `coerceEmail` / `coerceUrl` filter the "TBD" / "—" /
            // "N/A" placeholders the real xlsx ships so the server's
            // strict `z.string().email() / .url()` doesn't reject the
            // whole row. Rep can fill in the real address later via
            // the form.
            contactEmail: coerceEmail(r.contactEmail),
            contactPhone: r.contactPhone?.trim() || undefined,
            website: coerceUrl(r.website),
            location: r.location?.trim() || undefined,
            title: r.title?.trim() || undefined,
            linkedinUrl: coerceUrl(r.linkedinUrl),
            revenueStream: r.revenueStream?.trim() || undefined,
            lastContactDate: parseImportDate(r.lastContactDate),
            nextAction: r.nextAction?.trim() || undefined,
            actInvestment: r.actInvestment?.trim() || undefined,
            estInvestment: r.estInvestment?.trim() || undefined,
            crossSell: r.crossSell?.trim() || undefined,
            region: r.region?.trim() || undefined,
            notesText: r.notesText?.trim() || undefined,
            fundraisingEntity: resolveImportEntity(
              r.entity,
              entities,
              entityKey,
            ),
            tags: parseImportTags(r.tags),
          }));
          const res = await importInvestors(payload);
          // The import UPSERTS now, so say how many were updated rather than
          // letting a re-import look like it did nothing.
          if ((res.data.updated ?? 0) > 0) {
            toast.message(
              `${res.data.updated} existing investor${res.data.updated === 1 ? "" : "s"} updated (matched on name + entity).`,
            );
          }
          if ((res.data.tagsCreated?.length ?? 0) > 0) {
            toast.message(
              `Added ${res.data.tagsCreated!.length} new tag${res.data.tagsCreated!.length === 1 ? "" : "s"} to the catalog: ${res.data.tagsCreated!.join(", ")}`,
            );
          }
          if (res.data.skipped > 0) {
            // The server now returns a reason per row. Naming the first few
            // beats the old blanket "invalid email / url or duplicate", which
            // was a guess printed as a fact.
            const detail = (res.data.errors ?? [])
              .slice(0, 3)
              .map((e) => `row ${e.row} (${e.name}): ${e.errors.join("; ")}`)
              .join(" · ");
            toast.message(
              `${res.data.skipped} row${res.data.skipped === 1 ? "" : "s"} skipped.${detail ? ` ${detail}` : ""}`,
            );
          }
          // Rows whose Entity cell named another vehicle land on THAT
          // tab, so they are invisible from here the moment the import
          // succeeds. Say so, or the count reads as rows that vanished.
          const elsewhere = payload.filter(
            (row) => row.fundraisingEntity !== entityKey,
          ).length;
          if (elsewhere > 0) {
            toast.message(
              `${elsewhere} row${elsewhere === 1 ? "" : "s"} imported to another entity — switch tabs to see ${elsewhere === 1 ? "it" : "them"}.`,
            );
          }
          return { created: res.data.created };
        }}
      />
    </div>
  );
}

function SortableInvestorRow({
  investor,
  colOrder,
  canDrag,
  selected,
  onToggleSelect,
  renderCell,
  onRowClick,
  onEdit,
  onDelete,
  isArchivedView,
  onArchive,
  onUnarchive,
}: {
  investor: Investor;
  colOrder: InvColKey[];
  canDrag: boolean;
  selected: boolean;
  onToggleSelect: (id: string, checked: boolean) => void;
  renderCell: (i: Investor, key: InvColKey) => React.ReactNode;
  onRowClick: () => void;
  onEdit: () => void;
  onDelete: () => void;
  isArchivedView: boolean;
  onArchive: () => void;
  onUnarchive: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: investor.id, disabled: !canDrag });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <TableRow
      ref={setNodeRef}
      style={style}
      onClick={onRowClick}
      className={
        isDragging
          ? "bg-muted/40"
          : `
            hover:bg-muted/40
            cursor-pointer
            ${selected ? "bg-accent/30" : ""}
          `
      }
    >
      <TableCell className="w-[36px]" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={selected}
          onCheckedChange={(c) => onToggleSelect(investor.id, c === true)}
          aria-label={`Select ${investor.name}`}
        />
      </TableCell>
      <TableCell
        className="w-[36px]"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          aria-label="Drag to reorder"
          disabled={!canDrag}
          className={`
            text-muted-foreground inline-flex size-6 items-center justify-center
            rounded transition-colors
            hover:text-foreground
            disabled:cursor-not-allowed disabled:opacity-30
            ${
              canDrag
                ? `
                  cursor-grab
                  active:cursor-grabbing
                `
                : ""
            }
          `}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-3.5" />
        </button>
      </TableCell>
      {colOrder.map((key) => (
        <TableCell key={key} className="overflow-hidden">
          {renderCell(investor, key)}
        </TableCell>
      ))}
      <TableCell />
      <TableCell className="w-[40px]" onClick={(e) => e.stopPropagation()}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm">
              <MoreHorizontal className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <PermissionDropdownMenuItem
              permission="investors:update"
              onClick={onEdit}
            >
              <Pencil className="mr-2 size-3.5" />
              Edit
            </PermissionDropdownMenuItem>
            {isArchivedView ? (
              <PermissionDropdownMenuItem
                permission="investors:update"
                onClick={onUnarchive}
              >
                <ArchiveRestore className="mr-2 size-3.5" />
                Restore
              </PermissionDropdownMenuItem>
            ) : (
              <PermissionDropdownMenuItem
                permission="investors:update"
                onClick={onArchive}
              >
                <Archive className="mr-2 size-3.5" />
                Archive
              </PermissionDropdownMenuItem>
            )}
            <PermissionDropdownMenuItem
              permission="investors:delete"
              className="text-destructive"
              onClick={onDelete}
            >
              <Trash2 className="mr-2 size-3.5" />
              Delete
            </PermissionDropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}
