"use client";

import type { LucideIcon } from "lucide-react";
import {
  Award,
  BookOpen,
  Briefcase,
  Bug,
  Building,
  Building2,
  Calculator,
  CalendarOff,
  ChevronRight,
  ClipboardList,
  Code2,
  Contact,
  Cpu,
  FileSignature,
  FileText,
  FolderKanban,
  Globe,
  GraduationCap,
  HardDrive,
  Headset,
  Heart,
  IdCard,
  Inbox,
  LayoutDashboard,
  LogOut,
  Mail,
  Megaphone,
  MessageSquare,
  Newspaper,
  PenTool,
  PieChart,
  Plane,
  Receipt,
  Scale,
  Send,
  Settings,
  Shield,
  Sparkles,
  Ticket,
  TrendingUp,
  User,
  Users,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { ManutSymbol } from "@/components/brand/manut-symbol";
import { IT_SURFACES } from "@/components/it/it-workspace-tabs";
import { AccountMenuItems } from "@/components/layout/account-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { useBusinessUnits } from "@/hooks/use-business-units";
import { MARKETING_ANALYTICS_ENABLED } from "@/lib/feature-flags";
import { useAuth } from "@/providers/auth-provider";
import { BUSINESS_UNIT_UNASSIGNED } from "@/services/crm-business-unit.service";
import { getHelpdeskInboxCount } from "@/services/helpdesk.service";
import { getMessagesUnreadCount } from "@/services/message.service";

interface NavChild {
  id: string;
  label: string;
  href: string;
  permissions?: string[];
  /**
   * Query params that must match the current URL for this child to read as
   * active. Lets several children share one pathname and differ only by a
   * filter — e.g. the Sales CRM business-unit views, all on `/sales`. An
   * empty-string value means "the param must be absent or empty".
   */
  matchParams?: Record<string, string>;
}

interface NavItem {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
  badge?: string;
  permissions?: string[];
  /**
   * Optional nested items. When present the row becomes a collapsible
   * parent (chevron) rather than a direct link; each child is
   * permission-filtered independently.
   */
  children?: NavChild[];
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

/**
 * IT CRM children, derived from the SAME `IT_SURFACES` list the in-page tab
 * strip renders from.
 *
 * Derived rather than re-declared on purpose: the nav and the strip now show
 * the same five surfaces, and two hand-kept lists would drift the first time
 * somebody adds a surface to one of them. Labels, hrefs and per-child
 * permissions all come from that single source.
 */
export function buildItCrmChildren(): NavChild[] {
  return IT_SURFACES.map((surface) => ({
    id: `it-crm-${surface.id}`,
    label: surface.label,
    href: surface.href,
    permissions: [...surface.permissions],
  }));
}

/**
 * Union of every IT surface's permissions — what the IT CRM parent row must
 * carry so an actor who can reach only ONE surface still sees the group.
 *
 * Derived from the same list for the same reason as the children. Note this
 * union is deliberately wider than `/it-crm`'s own gate, which is pinned back
 * in the dashboard layout's ROUTE_PATTERN_OVERRIDES.
 */
export function itCrmParentPermissions(): string[] {
  return [...new Set(IT_SURFACES.flatMap((s) => s.permissions))];
}

/** People self-service modules — shared between full nav and employee-only nav. */
const HR_SELF_SERVICE_NAV_ITEMS: NavItem[] = [
  {
    id: "hrms",
    label: "HRMS",
    href: "/hrms",
    icon: IdCard,
    permissions: [
      "hrms:read",
      "hrms:esop-manage",
      "hrms:onboarding-manage",
      "hrms:attendance-read",
      "hrms:attendance-manage",
      "hrms:attendance-policy-manage",
      "hrms:attendance-correction-approve",
      "hrms:attendance-report-export",
    ],
  },
  {
    id: "learning",
    label: "Learning",
    href: "/learning",
    icon: GraduationCap,
    permissions: [
      "learning:read",
      "learning:manage",
      "learning:hr-read",
      "learning:complete",
    ],
  },
  {
    id: "visa",
    label: "Visa",
    href: "/visa",
    icon: Globe,
    permissions: ["visa:read", "visa:hr-read", "visa:manage"],
  },
  {
    id: "benefits",
    label: "Benefits",
    href: "/benefits",
    icon: Heart,
    permissions: ["benefits:read", "benefits:enroll", "benefits:manage"],
  },
  {
    id: "office",
    label: "Office",
    href: "/office",
    icon: Building,
    permissions: ["office:read", "office:book", "office:manage"],
  },
  {
    id: "policies",
    label: "Policy & Handbook",
    href: "/policies",
    icon: BookOpen,
    permissions: ["policy:read", "policy:manage"],
  },
  {
    id: "directory",
    label: "Directory",
    href: "/directory",
    icon: Contact,
    permissions: ["directory:read", "directory:view-sensitive"],
  },
];

const EMPLOYEE_NAV_GROUPS: NavGroup[] = [
  {
    label: "Personal",
    items: [
      {
        id: "my-portal",
        label: "My Portal",
        href: "/my-portal",
        icon: User,
      },
      {
        id: "messages",
        label: "Messaging",
        href: "/messages",
        icon: MessageSquare,
        permissions: ["messages:read"],
      },
      {
        id: "leave",
        label: "Leave",
        href: "/leave",
        icon: CalendarOff,
        permissions: ["leave:read"],
      },
      {
        id: "travel",
        label: "Travel",
        href: "/travel",
        icon: Plane,
        permissions: ["travel:read"],
      },
      {
        id: "expenses",
        label: "Expenses",
        href: "/expenses",
        icon: Receipt,
        permissions: ["expense:read"],
      },
      {
        id: "cash-advance",
        label: "Cash Advance",
        href: "/cash-advance",
        icon: Wallet,
        permissions: [
          "cash-advance:read",
          "cash-advance:read-all",
          "cash-advance:create",
          "cash-advance:approve",
        ],
      },
      {
        id: "it-helpdesk",
        label: "IT Helpdesk",
        href: "/it-helpdesk",
        icon: Headset,
        permissions: ["it:read", "it:read-all", "it:create"],
      },
      {
        // Ungated — employee-only accounts are the main audience for org-wide
        // surveys and must be able to reach the respond flow.
        id: "survey",
        label: "Survey",
        href: "/survey",
        icon: ClipboardList,
      },
      { id: "settings", label: "Settings", href: "/settings", icon: Settings },
      ...HR_SELF_SERVICE_NAV_ITEMS,
    ],
  },
];

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Workspace",
    items: [
      {
        id: "home",
        label: "Home",
        href: "/dashboard",
        icon: LayoutDashboard,
        permissions: ["home:read"],
      },
      {
        id: "aria",
        label: "Manut AI",
        href: "/aria",
        icon: Sparkles,
        badge: "AI",
        permissions: ["aria:use"],
      },
      {
        id: "messages",
        label: "Messaging",
        href: "/messages",
        icon: MessageSquare,
        permissions: ["messages:read"],
      },
      {
        id: "docs",
        label: "Repository",
        href: "/docs",
        icon: BookOpen,
        permissions: ["docs:read"],
      },
      {
        id: "projects",
        label: "Integration CRM",
        href: "/projects",
        icon: FolderKanban,
        // Widened to include proposals, so somebody granted only
        // `proposals:read` still sees the parent and reaches its one child.
        // `projects:manage` is the Project CRM super-grant the proposals API
        // also honours, so it appears here for the same reason.
        permissions: ["projects:read", "proposals:read", "projects:manage"],
        children: [
          {
            id: "projects-board",
            label: "Projects",
            href: "/projects",
            permissions: ["projects:read"],
          },
          {
            id: "projects-requests",
            label: "Requests",
            href: "/projects/requests",
            permissions: ["projects:read"],
          },
          {
            id: "projects-proposals",
            label: "Proposals",
            href: "/projects/proposals",
            permissions: ["proposals:read", "projects:manage"],
          },
        ],
      },
      {
        id: "partners",
        label: "Marketing CRM",
        href: "/partners",
        icon: Building2,
        // Visible if the user can see any child (Partners / Analytics / Campaigns).
        permissions: [
          "partners:read",
          "marketing:dashboard:view",
          "marketing:raw:view",
          "marketing:campaign:view",
          "marketing:reports:view",
        ],
        children: [
          {
            id: "partners-list",
            label: "Partners",
            href: "/partners",
            permissions: ["partners:read"],
          },
          // The six entries below are the Marketing Analytics family and are
          // filtered out entirely when the flag is off — see
          // MARKETING_ANALYTICS_CHILD_IDS at the bottom of this block. Partners
          // above is the original module and keeps the parent visible.
          {
            id: "marketing-analytics",
            label: "Marketing Analytics",
            href: "/marketing-analytics",
            permissions: ["marketing:dashboard:view", "marketing:raw:view"],
          },
          {
            id: "marketing-partners",
            label: "Partner Workspaces",
            href: "/marketing-analytics/partners",
            permissions: ["marketing:dashboard:view", "marketing:raw:view"],
          },
          {
            id: "marketing-traffic",
            label: "Traffic Dashboard",
            href: "/marketing-analytics/traffic",
            permissions: ["marketing:dashboard:view", "marketing:raw:view"],
          },
          {
            id: "marketing-dau-mau",
            label: "DAU / MAU",
            href: "/marketing-analytics/dau-mau",
            permissions: ["marketing:dashboard:view", "marketing:raw:view"],
          },
          {
            id: "marketing-campaigns",
            label: "Campaign CRM",
            href: "/marketing-analytics/campaigns",
            permissions: [
              "marketing:campaign:view",
              "marketing:campaign:create",
              "marketing:campaign:update",
              "marketing:campaign:delete",
            ],
          },
          {
            id: "marketing-reports",
            label: "Analytics & Reports",
            href: "/marketing-analytics/reports",
            permissions: ["marketing:reports:view", "marketing:campaign:view"],
          },
        ],
      },
      {
        id: "sales",
        label: "Sales CRM",
        href: "/sales",
        icon: Briefcase,
        permissions: ["crm:read", "deals:read"],
      },
      {
        id: "product-crm",
        label: "Product CRM",
        href: "/product-crm",
        icon: Code2,
        permissions: [
          "product-crm:read",
          "product-crm:read-all",
          "projects:read",
        ],
      },
      {
        id: "it-crm",
        label: "IT CRM",
        href: "/it-crm",
        icon: Cpu,
        // Union of the children's perms, so somebody who can ONLY reach one
        // surface still gets the parent. On production the Employee role
        // holds `it:access:request` and NOTHING from the IT CRM set — 50
        // users whose only route to the access-request form was the old
        // top-level IT Operations row. Without the union they lose the nav
        // entirely. `/it-crm` itself is pinned back to its own narrower gate
        // in ROUTE_PATTERN_OVERRIDES; without that pin it would inherit this
        // union by longest-prefix and hand the project board to all of them.
        permissions: itCrmParentPermissions(),
        children: buildItCrmChildren(),
      },
      {
        id: "legal-crm",
        label: "Legal CRM",
        href: "/legal-crm",
        icon: Scale,
        permissions: ["legal-crm:read", "legal-crm:read-all", "projects:read"],
      },
      {
        id: "hr-crm",
        label: "HR CRM",
        href: "/hr-crm",
        icon: Users,
        permissions: ["hr-crm:read", "hr-crm:read-all", "projects:read"],
      },
      {
        id: "qa-crm",
        label: "QA CRM",
        href: "/qa-crm",
        icon: Bug,
        permissions: ["qa-crm:read", "qa-crm:read-all"],
      },
      {
        id: "voucher-crm",
        label: "Voucher CRM",
        href: "/voucher-crm",
        icon: Ticket,
        permissions: ["voucher-crm:read", "voucher-crm:read-all"],
      },
      {
        id: "it-helpdesk",
        label: "IT Helpdesk",
        href: "/it-helpdesk",
        icon: Headset,
        permissions: ["it:read", "it:read-all", "it:create"],
      },
    ],
  },
  {
    label: "People",
    items: [
      {
        id: "employees",
        label: "Employees",
        href: "/employees",
        icon: Users,
        permissions: ["user:read"],
      },
      {
        id: "certificates",
        label: "Certificates",
        href: "/certificates",
        icon: Award,
        permissions: ["certificate:manage"],
      },
      {
        id: "leave",
        label: "Leave",
        href: "/leave",
        icon: CalendarOff,
        permissions: ["leave:read"],
      },
      {
        id: "travel",
        label: "Travel",
        href: "/travel",
        icon: Plane,
        permissions: ["travel:read"],
      },
      {
        id: "careers",
        label: "Careers",
        href: "/careers",
        icon: Briefcase,
        permissions: ["career:read"],
      },
      {
        // Visible to everyone — the list shows surveys targeted to the viewer
        // and the respond route must be reachable. Create/manage actions are
        // gated inside the page on survey:manage (mirrors Awards below).
        id: "survey",
        label: "Survey",
        href: "/survey",
        icon: ClipboardList,
      },
      {
        // Employee-facing form builder/responder (Google-Forms-style). Visible
        // to everyone — the list shows forms targeted to the viewer; the
        // create/manage actions are gated inside the page (survey:manage-wave).
        id: "survey-forms",
        label: "Awards",
        href: "/survey-forms",
        icon: FileText,
      },
      {
        id: "payroll",
        label: "Payroll",
        href: "/payroll",
        icon: Wallet,
        permissions: ["payroll:read"],
      },
      {
        id: "legal",
        label: "Legal",
        href: "/legal",
        icon: FileSignature,
        permissions: ["legal:read"],
      },
      {
        id: "legal-announcements",
        label: "Announcements",
        href: "/legal/announcements",
        icon: Megaphone,
        permissions: ["legal:announcement-read"],
      },
      {
        id: "legal-shared",
        label: "Shared documents",
        href: "/legal/shared",
        icon: Inbox,
        permissions: ["legal:view-shared"],
      },
      ...HR_SELF_SERVICE_NAV_ITEMS,
    ],
  },
  {
    label: "Finance",
    items: [
      {
        id: "accounting",
        label: "Accounting",
        href: "/accounting",
        icon: Calculator,
        permissions: ["accounting:read"],
      },
      {
        id: "accounting-crm",
        label: "Accounting CRM",
        href: "/accounting-crm",
        icon: PieChart,
        permissions: [
          "accounting-crm:read",
          "accounting-crm:read-all",
          "projects:read",
        ],
      },
      {
        id: "expenses",
        label: "Expenses",
        href: "/expenses",
        icon: Receipt,
        permissions: ["expense:read"],
      },
      {
        id: "cash-advance",
        label: "Cash Advance",
        href: "/cash-advance",
        icon: Wallet,
        permissions: [
          "cash-advance:read",
          "cash-advance:read-all",
          "cash-advance:create",
          "cash-advance:approve",
        ],
      },
      {
        id: "revenue",
        label: "Revenue",
        href: "/revenue",
        icon: TrendingUp,
        permissions: ["revenue:read"],
      },
    ],
  },
  {
    label: "Fundraising",
    items: [
      {
        id: "investor-dashboard",
        label: "Dashboard",
        href: "/investors",
        icon: PieChart,
        permissions: ["investor-dashboard:read"],
      },
      {
        id: "investor-crm",
        label: "Investor CRM",
        href: "/investor-crm",
        icon: Users,
        permissions: ["investor-crm:read"],
      },
      {
        id: "dataroom",
        label: "Data Room",
        href: "/dataroom",
        icon: FileText,
        permissions: ["dataroom:read"],
      },
      {
        id: "investor-updates",
        label: "Updates",
        href: "/investor-updates",
        icon: Send,
        permissions: ["investor-updates:read"],
      },
    ],
  },
  {
    label: "Content",
    items: [
      {
        id: "blog-management",
        label: "Blogs",
        href: "/blog-management",
        icon: PenTool,
        permissions: ["blog:read"],
      },
      {
        id: "pr-management",
        label: "PR Articles",
        href: "/pr-management",
        icon: Newspaper,
        permissions: ["pr:read"],
      },
    ],
  },
  {
    label: "Integrations",
    items: [
      {
        id: "gmail",
        label: "Gmail",
        href: "/gmail",
        icon: Mail,
        permissions: ["integrations:use"],
      },
      {
        id: "drive",
        label: "Drive",
        href: "/drive",
        icon: HardDrive,
        permissions: ["integrations:use"],
      },
    ],
  },
  {
    label: "System",
    items: [
      {
        id: "admin",
        label: "Admin",
        href: "/admin",
        icon: Shield,
        // User management, role assignment, and audit logs live behind
        // this entry. Read access to the admin dashboard (`admin:read`)
        // includes IT for visa / hardware tickets — they shouldn't see
        // the workspace governance surface. Gate on `admin:manage` so
        // only workspace admins see the nav entry.
        permissions: ["admin:manage"],
      },
      {
        id: "roles",
        label: "Roles",
        href: "/roles",
        icon: Shield,
        permissions: ["role:read"],
      },
      {
        id: "settings",
        label: "Settings",
        href: "/settings",
        icon: Settings,
        // No permission gate — the page surfaces Profile / Preferences /
        // Security / Integrations to every authenticated user. The System
        // tab self-gates via `admin:manage` inside the page.
      },
    ],
  },
];

export { EMPLOYEE_NAV_GROUPS, NAV_GROUPS };
export type { NavGroup, NavItem };

// Cap displayed unread badge at 99 so the sidebar pill stays narrow.
function formatBadgeCount(n: number): string | undefined {
  if (n <= 0) return undefined;
  return n > 99 ? "99+" : String(n);
}

/** A child href may carry a query string; route matching is pathname-only. */
export function childPathname(href: string): string {
  return href.split("?")[0] ?? href;
}

/**
 * A child is active when its pathname is the best route match AND every
 * param in `matchParams` agrees with the current URL. Without the param
 * check, sibling views of one board would all light up at once.
 */
export function childIsActive(
  child: NavChild,
  bestMatchHref: string | null,
  params: URLSearchParams | null,
): boolean {
  if (childPathname(child.href) !== bestMatchHref) return false;
  if (!child.matchParams) return true;
  return Object.entries(child.matchParams).every(
    ([key, want]) => (params?.get(key) ?? "") === want,
  );
}

/**
 * Sales CRM children: "All deals", one filtered view per admin-editable
 * business unit, then "Unassigned" — the deals nobody has claimed yet.
 *
 * There is no "ARIA Revenue" child any more. The separate /sales-revenue
 * module was retired and its deals migrated onto THIS board tagged `aria`
 * (its `revenue_*` tables are parked, not dropped — see CLAUDE.md); a
 * next.config redirect catches old bookmarks. The two-things-called-ARIA
 * story (#1124 and its reversal) ends here: ARIA is a business unit, full
 * stop.
 *
 * Unassigned is a fixed child, not a catalog row: it exists whether or not
 * the unit fetch succeeded, because "no unit yet" is a property of deals,
 * not of the catalog. It reuses the same reserved sentinel the board's
 * dropdown already understands.
 *
 * Exported and pure so the no-duplicate-labels invariant is testable: the
 * duplicate-ARIA bug lived here precisely because this was inline in the
 * component, where the NAV_GROUPS tests could not see it.
 */
export function buildSalesCrmChildren(
  units: { code: string; label: string }[],
): NavChild[] {
  return [
    {
      id: "sales-all",
      label: "All deals",
      href: "/sales?tab=pipeline",
      // Active only when no unit filter is applied.
      matchParams: { bu: "" },
      permissions: ["crm:read", "deals:read"],
    },
    // Every unit, ARIA included. A unit that also has a module is still a tag
    // on Sales CRM deals, and those deals need a nav row of their own.
    ...units.map((u) => ({
      id: `sales-bu-${u.code}`,
      label: u.label,
      href: `/sales?tab=pipeline&bu=${encodeURIComponent(u.code)}`,
      matchParams: { bu: u.code },
      permissions: ["crm:read", "deals:read"],
    })),
    {
      id: "sales-bu-unassigned",
      label: "Unassigned",
      // The reserved sentinel, not a code — codes can't contain underscores,
      // so no admin-created unit can ever collide with it.
      href: `/sales?tab=pipeline&bu=${BUSINESS_UNIT_UNASSIGNED}`,
      matchParams: { bu: BUSINESS_UNIT_UNASSIGNED },
      permissions: ["crm:read", "deals:read"],
    },
  ];
}

export function AppSidebar() {
  const pathname = usePathname() ?? "";
  const searchParams = useSearchParams();
  const { user, logout, hasAnyPermission, isEmployeeOnly } = useAuth();
  const { isMobile, setOpenMobile } = useSidebar();

  // Close the mobile drawer once navigation has happened.
  //
  // On mobile the nav lives in a Sheet over the content, and the items are
  // plain `<Link>`s — so tapping one navigated *behind* the still-open drawer
  // and the user had to dismiss it by hand to see the page they had asked for.
  // Keyed on `pathname` rather than on a click handler so it also covers the
  // logo, the nested children and any future entry point, and it is a no-op on
  // desktop where the sidebar is docked.
  useEffect(() => {
    if (isMobile) setOpenMobile(false);
  }, [pathname, isMobile, setOpenMobile]);

  // Total unread DM/channel count, polled every 30s. Cheap aggregate
  // on the server; we re-fetch on `pathname` change too so navigating
  // away from `/messages` (where the user just read everything) clears
  // the badge immediately. `GlobalMessageNotifier` also dispatches
  // `intranet:unread-bump` on every fresh `message.created` socket
  // event so the badge updates in real time without waiting for the
  // next tick.
  const canSeeMessages = hasAnyPermission("messages:read");
  const [unreadMessages, setUnreadMessages] = useState(0);
  useEffect(() => {
    if (!canSeeMessages) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await getMessagesUnreadCount();
        if (!cancelled) setUnreadMessages(res.data.total);
      } catch {
        // Sidebar badge is best-effort. Silently drop transient errors
        // so a flaky network never lights up an error toast on every
        // page load.
      }
    };
    void tick();
    const id = setInterval(tick, 30_000);
    const onBump = () => {
      void tick();
    };
    if (typeof window !== "undefined") {
      window.addEventListener("intranet:unread-bump", onBump);
    }
    return () => {
      cancelled = true;
      clearInterval(id);
      if (typeof window !== "undefined") {
        window.removeEventListener("intranet:unread-bump", onBump);
      }
    };
  }, [canSeeMessages, pathname]);

  // IT Helpdesk inbox badge — count of unresolved tickets visible to
  // the caller. `it:read-all` holders see every open ticket; everyone
  // else sees only the rows they created / are assigned (mirrors the
  // server-side scope). Re-fetched on `pathname` change so closing a
  // ticket on `/it-helpdesk` clears the badge immediately.
  const canSeeHelpdesk = hasAnyPermission(
    "it:read",
    "it:read-all",
    "it:create",
  );
  const [helpdeskInbox, setHelpdeskInbox] = useState(0);
  useEffect(() => {
    if (!canSeeHelpdesk) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await getHelpdeskInboxCount();
        if (!cancelled) setHelpdeskInbox(res.data.total);
      } catch {
        // Best-effort — same rationale as the messages badge.
      }
    };
    void tick();
    const id = setInterval(tick, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [canSeeHelpdesk, pathname]);

  const userInitials = user?.name
    ? user.name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : "U";
  const userName = user?.name || "User";

  const sourceGroups = isEmployeeOnly ? EMPLOYEE_NAV_GROUPS : NAV_GROUPS;

  // Sales CRM's children are the admin-editable business units (Onewave /
  // Onewave Revenue / ARIA …), not a hardcoded list — adding a unit in the
  // Manage business units dialog adds a nav view with no code change. Each
  // child is one filtered view of the SAME board, so they all point at
  // /sales and differ only by `?bu=`.
  //
  // ARIA is its own module (`/sales-revenue`, own tables + `sales-revenue:*`
  // perms), not a filtered view of the Sales board, so it is a fixed child
  // rather than one of the admin-editable units. It used to be a top-level
  // entry; folding it in is Vivek's requested Sales CRM grouping.
  const { units: businessUnits } = useBusinessUnits();
  const groupsWithBusinessUnits = sourceGroups.map((group) => ({
    ...group,
    items: group.items.map((item) =>
      item.id === "sales"
        ? { ...item, children: buildSalesCrmChildren(businessUnits) }
        : item,
    ),
  }));

  const filteredGroups = groupsWithBusinessUnits
    .map((group) => ({
      ...group,
      items: group.items
        .filter(
          (item) => !item.permissions || hasAnyPermission(...item.permissions),
        )
        .map((item) => {
          if (!item.children) return item;
          // Ship-dark filter runs BEFORE the permission filter so a gated
          // child can never be revealed by a permission the user happens to
          // hold — Admin holds every permission, so permissions alone would
          // show the whole family in production.
          const children = filterShipDarkChildren(item.children).filter(
            (c) => !c.permissions || hasAnyPermission(...c.permissions),
          );
          return { ...item, children };
        })
        // Drop a collapsible parent whose children are all permission-hidden.
        .filter((item) => !item.children || item.children.length > 0),
    }))
    .filter((group) => group.items.length > 0);

  // Highlight only the *most specific* nav item that matches the
  // current route. Plain `pathname.startsWith(item.href)` lights up
  // both `Legal` (`/legal`) and `Announcements` (`/legal/announcements`)
  // when the user opens the announcements page; computing the longest
  // matching href across every visible item picks exactly one.
  const allHrefs = filteredGroups.flatMap((g) =>
    g.items.flatMap((i) =>
      i.children && i.children.length > 0
        ? i.children.map((c) => childPathname(c.href))
        : [i.href],
    ),
  );

  // Team-CRM origin override: opening a project from a team CRM list
  // (e.g. IT CRM → /it-crm) navigates to the generic /projects/<id>
  // detail page with `?from=it-crm`. Without an override the longest
  // matching href would light up "Project CRM" since `/projects` is
  // the only match. Honour the `from` hint while on a project-detail
  // route so the sidebar stays anchored to the CRM the user came
  // from.
  const fromParam = searchParams?.get("from") ?? null;
  const fromHref = fromParam ? `/${fromParam}` : null;
  const onProjectDetail =
    pathname.startsWith("/projects/") && pathname !== "/projects";
  const overrideHref =
    onProjectDetail && fromHref && allHrefs.includes(fromHref)
      ? fromHref
      : null;

  const bestMatchHref =
    overrideHref ??
    allHrefs
      .filter(
        (href) =>
          pathname === href ||
          (href !== "/dashboard" && pathname.startsWith(`${href}/`)),
      )
      .sort((a, b) => b.length - a.length)[0] ??
    null;

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-sidebar-border border-b">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" className="gap-3" asChild>
              <Link
                href={isEmployeeOnly ? "/my-portal" : "/dashboard"}
                aria-label="Go to home"
              >
                <ManutSymbol
                  className="text-foreground w-8 shrink-0"
                  title=""
                  ariaHidden
                />
                <div className="flex flex-col gap-0.5">
                  <span
                    className={`
                      text-sidebar-primary font-serif text-base leading-none
                      font-normal tracking-tight
                    `}
                  >
                    Manut
                  </span>
                  <span
                    className={`
                      text-sidebar-foreground text-[9px] tracking-[0.18em]
                      uppercase
                    `}
                  >
                    Intelligence Workspace
                  </span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {filteredGroups.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel
              className={`
                text-sidebar-foreground/50 text-[10px] tracking-widest uppercase
              `}
            >
              {group.label}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const isActive = item.href === bestMatchHref;
                  // Live badges injected at render time. Static badges
                  // declared on the nav item still take precedence so
                  // hard-coded counters (if any) keep their meaning.
                  const liveBadge =
                    item.id === "messages"
                      ? formatBadgeCount(unreadMessages)
                      : item.id === "it-helpdesk"
                        ? formatBadgeCount(helpdeskInbox)
                        : undefined;
                  const badge = item.badge ?? liveBadge;

                  // Collapsible parent (e.g. Marketing CRM -> Partners +
                  // Marketing Analytics). Renders a chevron trigger and a
                  // nested sub-menu; defaults open when a child is active.
                  if (item.children && item.children.length > 0) {
                    const childActive = item.children.some((c) =>
                      childIsActive(c, bestMatchHref, searchParams),
                    );
                    return (
                      <Collapsible
                        key={item.id}
                        asChild
                        defaultOpen={childActive}
                        className="group/collapsible"
                      >
                        <SidebarMenuItem>
                          <CollapsibleTrigger asChild>
                            <SidebarMenuButton tooltip={item.label}>
                              <item.icon />
                              <span>{item.label}</span>
                              <ChevronRight
                                className={`
                                  ml-auto transition-transform
                                  group-data-[state=open]/collapsible:rotate-90
                                `}
                              />
                            </SidebarMenuButton>
                          </CollapsibleTrigger>
                          <CollapsibleContent>
                            <SidebarMenuSub>
                              {item.children.map((child) => (
                                <SidebarMenuSubItem key={child.id}>
                                  <SidebarMenuSubButton
                                    asChild
                                    isActive={childIsActive(
                                      child,
                                      bestMatchHref,
                                      searchParams,
                                    )}
                                  >
                                    <Link href={child.href}>
                                      <span>{child.label}</span>
                                    </Link>
                                  </SidebarMenuSubButton>
                                </SidebarMenuSubItem>
                              ))}
                            </SidebarMenuSub>
                          </CollapsibleContent>
                        </SidebarMenuItem>
                      </Collapsible>
                    );
                  }

                  return (
                    <SidebarMenuItem key={item.id}>
                      <SidebarMenuButton
                        asChild
                        isActive={isActive}
                        tooltip={item.label}
                      >
                        <Link href={item.href}>
                          <item.icon />
                          <span>{item.label}</span>
                        </Link>
                      </SidebarMenuButton>
                      {badge && (
                        <SidebarMenuBadge>
                          <Badge
                            variant="destructive"
                            className="h-4 min-w-4 px-1 text-[8px]"
                          >
                            {badge}
                          </Badge>
                        </SidebarMenuBadge>
                      )}
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter className="border-sidebar-border border-t">
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  size="lg"
                  className={`
                    data-[state=open]:bg-sidebar-accent
                    data-[state=open]:text-sidebar-accent-foreground
                  `}
                >
                  <Avatar className="size-8">
                    {user?.avatarUrl ? (
                      <AvatarImage src={user.avatarUrl} alt={userName} />
                    ) : null}
                    <AvatarFallback
                      className={`
                        text-sidebar-primary-foreground text-[10px] font-bold
                      `}
                      style={{
                        background:
                          "linear-gradient(135deg, hsl(var(--primary)), hsl(var(--primary-light)))",
                      }}
                    >
                      {userInitials}
                    </AvatarFallback>
                  </Avatar>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span
                      className={`
                        text-sidebar-foreground-strong truncate font-semibold
                      `}
                    >
                      {userName}
                    </span>
                    <span className="text-sidebar-foreground truncate text-xs">
                      {user?.email ?? ""}
                    </span>
                  </div>
                  <ChevronRight className="ml-auto" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="w-56"
                side="right"
                align="end"
                sideOffset={4}
              >
                {/* Shared with the topbar's avatar menu — see account-menu.tsx. */}
                <AccountMenuItems onLogout={logout} />
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

/**
 * Sidebar ids belonging to the ship-dark Marketing Analytics family.
 *
 * Filtered out of the nav when NEXT_PUBLIC_MARKETING_ANALYTICS_ENABLED is not
 * "true". `partners-list` is deliberately absent: the original Marketing
 * module is in production, and keeping it is what leaves the "Marketing CRM"
 * parent reachable while the family is dark.
 */
export const MARKETING_ANALYTICS_CHILD_IDS = [
  "marketing-analytics",
  "marketing-partners",
  "marketing-traffic",
  "marketing-dau-mau",
  "marketing-campaigns",
  "marketing-reports",
] as const;

/** Drop the gated children when the flag is off. Pure, so it is testable. */
export function filterShipDarkChildren<T extends { id: string }>(
  children: T[],
  marketingEnabled = MARKETING_ANALYTICS_ENABLED,
): T[] {
  if (marketingEnabled) return children;
  const gated = new Set<string>(MARKETING_ANALYTICS_CHILD_IDS);
  return children.filter((child) => !gated.has(child.id));
}
