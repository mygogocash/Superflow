import type { LucideIcon } from "lucide-react-native";
import {
  BriefcaseBusiness,
  Building2,
  CalendarDays,
  CircleHelp,
  ClipboardList,
  FileText,
  FolderKanban,
  HandCoins,
  Home,
  Landmark,
  LayoutDashboard,
  MessageSquare,
  Newspaper,
  Plane,
  Scale,
  Settings2,
  Sparkles,
  Users,
  Wallet,
} from "lucide-react-native";
import { ASSISTANT_DISPLAY_NAME } from "@/lib/brand";

export type NavIcon = LucideIcon;

export type NavItem = {
  href: string;
  label: string;
  permissions?: string[];
  icon?: NavIcon;
};

export type NavGroup = {
  label: string;
  items: NavItem[];
  /** Collapse secondary groups by default on first paint. */
  defaultCollapsed?: boolean;
};

/** Public URL for the signed-in home. Matches Next.js `/dashboard`. */
export const DASHBOARD_HOME = "/dashboard";

/** Routes that exist under apps/app/app/(dashboard). Permission codes match the Next.js sidebar. */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Workspace",
    items: [
      { href: DASHBOARD_HOME, label: "Home", permissions: ["home:read"], icon: Home },
      { href: "/aria", label: ASSISTANT_DISPLAY_NAME, permissions: ["aria:use"], icon: Sparkles },
      { href: "/messages", label: "Messaging", permissions: ["messages:read"], icon: MessageSquare },
      { href: "/docs", label: "Repository", permissions: ["docs:read"], icon: FolderKanban },
      { href: "/projects", label: "Projects", permissions: ["projects:read"], icon: LayoutDashboard },
      { href: "/proposals", label: "Proposals", permissions: ["proposals:read", "projects:manage"], icon: FileText },
      { href: "/partners", label: "Partners", permissions: ["partners:read"], icon: Building2 },
      { href: "/deals", label: "Sales CRM", permissions: ["crm:read", "deals:read"], icon: BriefcaseBusiness },
      { href: "/leads", label: "Leads", permissions: ["crm:read"], icon: Users },
      { href: "/accounts", label: "Accounts", permissions: ["crm:read"], icon: Building2 },
      { href: "/contacts", label: "Contacts", permissions: ["crm:read"], icon: Users },
      { href: "/product-crm", label: "Product CRM", permissions: ["product-crm:read", "product-crm:read-all"], icon: ClipboardList },
      { href: "/it-crm", label: "IT CRM", permissions: ["it-crm:read", "it-crm:read-all"], icon: Settings2 },
      { href: "/legal-crm", label: "Legal CRM", permissions: ["legal-crm:read", "legal-crm:read-all"], icon: Scale },
      { href: "/qa-crm", label: "QA CRM", permissions: ["qa-crm:read", "qa-crm:read-all"], icon: CircleHelp },
      { href: "/voucher-crm", label: "Voucher CRM", permissions: ["voucher-crm:read", "voucher-crm:read-all"], icon: HandCoins },
      { href: "/helpdesk", label: "IT Helpdesk", permissions: ["it:read", "it:read-all", "it:create"], icon: CircleHelp },
    ],
  },
  {
    label: "People",
    defaultCollapsed: true,
    items: [
      { href: "/hrms", label: "HRMS", permissions: ["hrms:read", "hrms:esop-manage"], icon: Users },
      { href: "/leave", label: "Leave", permissions: ["leave:read"], icon: CalendarDays },
      { href: "/travel", label: "Travel", permissions: ["travel:read"], icon: Plane },
      { href: "/payroll", label: "Payroll", permissions: ["payroll:read"], icon: Wallet },
      { href: "/learning", label: "Learning", permissions: ["learning:read"], icon: FileText },
      { href: "/visa", label: "Visa", permissions: ["visa:read", "visa:hr-read"], icon: FileText },
      { href: "/benefits", label: "Benefits", permissions: ["benefits:read"], icon: HandCoins },
      { href: "/office", label: "Office", permissions: ["office:read"], icon: Building2 },
      { href: "/policies", label: "Policies", permissions: ["policy:read"], icon: FileText },
      { href: "/survey", label: "Survey", icon: ClipboardList },
      { href: "/survey-forms", label: "Awards", icon: ClipboardList },
      { href: "/certificates", label: "Certificates", permissions: ["certificate:manage"], icon: FileText },
      { href: "/career", label: "Careers", permissions: ["career:read"], icon: BriefcaseBusiness },
      { href: "/performance", label: "Performance", permissions: ["performance:read"], icon: LayoutDashboard },
    ],
  },
  {
    label: "Finance",
    defaultCollapsed: true,
    items: [
      { href: "/accounting", label: "Accounting", permissions: ["accounting:read"], icon: Landmark },
      { href: "/accounting-crm", label: "Accounting CRM", permissions: ["accounting-crm:read"], icon: Landmark },
      { href: "/expenses", label: "Expenses", permissions: ["expense:read"], icon: Wallet },
      { href: "/cash-advance", label: "Cash Advance", permissions: ["cash-advance:read"], icon: HandCoins },
      { href: "/vendors", label: "Vendors", permissions: ["vendor:read"], icon: Building2 },
      { href: "/exchange-rates", label: "Exchange rates", permissions: ["exchange-rate:read"], icon: Landmark },
    ],
  },
  {
    label: "Fundraising",
    defaultCollapsed: true,
    items: [
      { href: "/investors", label: "Investors", permissions: ["investor-dashboard:read", "investors:read"], icon: Landmark },
      { href: "/dataroom", label: "Data Room", permissions: ["dataroom:read"], icon: FolderKanban },
      { href: "/investor-updates", label: "Updates", permissions: ["investor-updates:read"], icon: Newspaper },
    ],
  },
  {
    label: "Content",
    defaultCollapsed: true,
    items: [
      { href: "/blogs", label: "Blogs", permissions: ["blog:read"], icon: Newspaper },
      { href: "/articles", label: "PR Articles", permissions: ["pr:read"], icon: Newspaper },
      { href: "/news", label: "News", permissions: ["news:read"], icon: Newspaper },
      { href: "/wall", label: "Wall", permissions: ["wall:read"], icon: MessageSquare },
    ],
  },
];

export const EMPLOYEE_NAV_GROUPS: NavGroup[] = [
  {
    label: "Personal",
    items: [
      { href: DASHBOARD_HOME, label: "Home", icon: Home },
      { href: "/aria", label: ASSISTANT_DISPLAY_NAME, permissions: ["aria:use"], icon: Sparkles },
      { href: "/messages", label: "Messaging", permissions: ["messages:read"], icon: MessageSquare },
      { href: "/leave", label: "Leave", permissions: ["leave:read"], icon: CalendarDays },
      { href: "/travel", label: "Travel", permissions: ["travel:read"], icon: Plane },
      { href: "/expenses", label: "Expenses", permissions: ["expense:read"], icon: Wallet },
      { href: "/cash-advance", label: "Cash Advance", permissions: ["cash-advance:read"], icon: HandCoins },
      { href: "/helpdesk", label: "IT Helpdesk", permissions: ["it:read", "it:create"], icon: CircleHelp },
      { href: "/survey", label: "Survey", icon: ClipboardList },
      { href: "/hrms", label: "HRMS", permissions: ["hrms:read"], icon: Users },
      { href: "/learning", label: "Learning", permissions: ["learning:read"], icon: FileText },
      { href: "/visa", label: "Visa", permissions: ["visa:read"], icon: FileText },
      { href: "/benefits", label: "Benefits", permissions: ["benefits:read"], icon: HandCoins },
      { href: "/office", label: "Office", permissions: ["office:read"], icon: Building2 },
      { href: "/policies", label: "Policies", permissions: ["policy:read"], icon: FileText },
    ],
  },
];

export function itemVisible(
  item: NavItem,
  hasPermission: (code: string) => boolean,
): boolean {
  if (!item.permissions?.length) return true;
  return item.permissions.some((code) => hasPermission(code));
}

export function navItemActive(pathname: string, href: string): boolean {
  if (href === DASHBOARD_HOME) return pathname === href || pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function filterNavGroups(
  groups: NavGroup[],
  hasPermission: (code: string) => boolean,
): NavGroup[] {
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => itemVisible(item, hasPermission)),
    }))
    .filter((group) => group.items.length > 0);
}
