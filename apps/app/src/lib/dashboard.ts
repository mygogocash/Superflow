export type DashboardKpis = {
  totalEmployees: number;
  activeProjects: number;
  pendingLeaves: number;
  pendingTravels: number;
  pendingExpenses: number;
  expensesThisMonth: number;
};

export type DashboardPendingAction = {
  kind: string;
  id: string;
  title: string;
  subtitle: string;
  href: string;
  createdAt: string;
};

export type DashboardUrgentItem = {
  label: string;
  severity: "urgent" | "pending" | string;
};

export type DashboardNewsItem = {
  id: string;
  title: string;
  createdAt: string;
};

export type DashboardWallPost = {
  id: string;
  content: string;
  author: string;
  createdAt: string;
};

export type DashboardCompanyDate = {
  id: string;
  title: string;
  date: string;
};

export type DashboardStats = {
  kpis: DashboardKpis;
  pendingActions: DashboardPendingAction[];
  urgentItems: DashboardUrgentItem[];
  recentNews: DashboardNewsItem[];
  recentWallPosts: DashboardWallPost[];
  upcomingDates: DashboardCompanyDate[];
};

export function greetingForHour(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function firstNameOf(name: string | null | undefined): string {
  const trimmed = name?.trim();
  if (!trimmed) return "there";
  return trimmed.split(/\s+/)[0] ?? "there";
}

export function formatMoneyThb(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "THB",
    maximumFractionDigits: 0,
  }).format(amount);
}

export function formatRelativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const mins = Math.floor((now - then) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
}

export function dashboardRecap(stats: Pick<DashboardStats, "pendingActions" | "urgentItems">): string {
  const urgent = stats.urgentItems.length;
  const pending = stats.pendingActions.length;
  if (urgent === 0 && pending === 0) return "Nothing needs your attention right now.";
  const parts: string[] = [];
  if (urgent > 0) parts.push(`${urgent} urgent ${urgent === 1 ? "item" : "items"}`);
  if (pending > 0) parts.push(`${pending} pending ${pending === 1 ? "approval" : "approvals"}`);
  return `Since you last checked: ${parts.join(" and ")}.`;
}

/**
 * Urgent items from the API are label-only (no href). Infer a sensible
 * destination from the copy so attention rows don't all dump to /leave.
 */
export function urgentItemHref(label: string): string {
  const lower = label.toLowerCase();
  if (lower.includes("visa")) return "/visa";
  if (lower.includes("expense")) return "/expenses";
  if (lower.includes("travel")) return "/travel";
  if (lower.includes("leave")) return "/leave";
  return "/dashboard";
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function unwrapDashboardStats(body: unknown): DashboardStats | null {
  if (!body || typeof body !== "object") return null;
  const data = "data" in body ? (body as { data: unknown }).data : body;
  if (!data || typeof data !== "object") return null;
  const raw = data as Partial<DashboardStats> & { kpis?: Partial<DashboardKpis> };
  // Missing `kpis` used to blank the whole home screen. Treat absent KPIs as
  // zeros so a partial edge payload still renders.
  const kpis: Partial<DashboardKpis> =
    raw.kpis && typeof raw.kpis === "object" ? raw.kpis : {};
  return {
    kpis: {
      totalEmployees: Number(kpis.totalEmployees) || 0,
      activeProjects: Number(kpis.activeProjects) || 0,
      pendingLeaves: Number(kpis.pendingLeaves) || 0,
      pendingTravels: Number(kpis.pendingTravels) || 0,
      pendingExpenses: Number(kpis.pendingExpenses) || 0,
      expensesThisMonth: Number(kpis.expensesThisMonth) || 0,
    },
    pendingActions: asArray<DashboardPendingAction>(raw.pendingActions),
    urgentItems: asArray<DashboardUrgentItem>(raw.urgentItems),
    recentNews: asArray<DashboardNewsItem>(raw.recentNews),
    recentWallPosts: asArray<DashboardWallPost>(raw.recentWallPosts),
    upcomingDates: asArray<DashboardCompanyDate>(raw.upcomingDates),
  };
}
