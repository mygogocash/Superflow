"use client";

import { usePathname } from "next/navigation";

import { LanguageSwitcher } from "@/components/i18n/language-switcher";
import { AccountMenuItems } from "@/components/layout/account-menu";
import { CompanySwitcher } from "@/components/layout/company-switcher";
import { NotificationBell } from "@/components/layout/notification-bell";
import { NAV_GROUPS } from "@/components/layout/sidebar";
import { ThemeSwitcher } from "@/components/layout/theme-switcher";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useAuth } from "@/providers/auth-provider";
import { updateMyProfile } from "@/services/my-portal.service";

const PAGE_TITLES: Record<string, string> = {
  "/dashboard": "Home",
  "/messages": "Messages",
  "/projects": "Integration CRM",
  "/partners": "Marketing CRM",
  "/deals": "Sales CRM",
  "/leave": "Leave Management",
  "/payroll": "Payroll",
  "/hrms": "HRMS",
  "/learning": "Learning",
  "/visa": "Visa & Immigration",
  "/office": "Office",
  "/policies": "Policy & Handbook",
  "/directory": "Directory",
  "/accounting": "Accounting",
  "/expenses": "Expenses",
  "/revenue": "Revenue Analytics",
  "/investors": "Investor Dashboard",
  "/investor-crm": "Investor CRM",
  "/dataroom": "Data Room",
  "/investor-updates": "Investor Updates",
  "/admin": "Administration",
  "/settings": "Settings",
  "/aria": "Manut AI",
};

/**
 * Longest-prefix title lookup, sourced from the sidebar.
 *
 * `PAGE_TITLES` above covers 23 paths; there are 53 route segments, so every
 * other page rendered the header as a bare "Manut" — tolerable beside a
 * sidebar that showed you where you were, useless on a phone where the drawer
 * is closed and the header is the only orientation you have.
 *
 * `NAV_GROUPS` already holds a label for every navigable route and is the same
 * source the layout derives route permissions from, so titles cannot drift from
 * navigation. The explicit map still wins where it disagrees, since those are
 * deliberately friendlier than the sidebar labels.
 */
function resolveTitle(pathname: string): string {
  const exact = PAGE_TITLES[pathname];
  if (exact) return exact;

  let bestHref = "";
  let bestLabel = "";
  const consider = (href: string, label: string) => {
    if (href === "/dashboard" && pathname !== "/dashboard") return;
    if (pathname !== href && !pathname.startsWith(`${href}/`)) return;
    if (href.length <= bestHref.length) return;
    bestHref = href;
    bestLabel = label;
  };

  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      consider(item.href, item.label);
      for (const child of item.children ?? []) {
        consider(child.href, child.label);
      }
    }
  }

  if (!bestHref) return "Manut";
  // A matched route may still have a friendlier name in the explicit map.
  return PAGE_TITLES[bestHref] ?? bestLabel;
}

export function Topbar() {
  // `?? ""` is main's guard (#1189, nullable Next navigation hooks) and is
  // still required: dev's resolveTitle takes a non-nullable string. Empty
  // matches no route, so it falls through to "Manut" — the same fallback
  // main's `PAGE_TITLES[pathname] || "Manut"` gave.
  const pathname = usePathname() ?? "";
  const { user, logout } = useAuth();
  const title = resolveTitle(pathname);
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const userInitials = user?.name
    ? user.name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : "U";

  return (
    <header
      className={`
        border-border bg-surface h-topbar min-h-topbar pt-safe px-safe flex
        w-full shrink-0 items-center gap-1.5 border-b px-3
        sm:gap-3 sm:px-5
      `}
    >
      <SidebarTrigger
        className={`
          size-9 shrink-0
          md:-ml-1 md:size-7
        `}
      />
      <div className="flex min-w-0 flex-1 items-baseline gap-3">
        <span
          className={`
            text-foreground truncate text-sm font-medium tracking-tight
            sm:text-[15px]
          `}
        >
          {title}
        </span>
        {/* The date is orientation, not information — first thing to go when
            the header has to share ~320px with four controls. */}
        <span
          className={`
            text-muted-foreground hidden text-[10px] tracking-[0.08em] uppercase
            lg:inline
          `}
        >
          {today}
        </span>
      </div>
      <div
        className={`
          hidden shrink-0 items-center gap-2
          md:flex
        `}
      >
        <CompanySwitcher />
        <LanguageSwitcher
          className="h-7 w-auto gap-1.5 text-xs"
          onChange={(locale) => {
            // Persist to the profile so the preference follows the user across
            // devices. Fire-and-forget: the switcher already applied it locally.
            void updateMyProfile({ locale });
          }}
        />
        <ThemeSwitcher />
      </div>
      <NotificationBell />
      {/* The avatar opens the account menu rather than linking straight to
          Settings.

          On a phone the only account menu used to live in the sidebar footer,
          so signing out meant: open the drawer, scroll past 50-odd nav items,
          tap the avatar, tap Sign out. The header is where people look for it.
          Same actions, same handler, one shared definition — the sidebar footer
          renders the identical list. */}
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Account menu"
          className={`
            ring-offset-background flex size-9 shrink-0 items-center
            justify-center rounded-full transition-all
            focus-visible:ring-ring focus-visible:ring-2
            focus-visible:ring-offset-2 focus-visible:outline-none
            hover:opacity-90
            md:size-7
          `}
        >
          <Avatar className="size-7">
            {user?.avatarUrl ? (
              <AvatarImage src={user.avatarUrl} alt="" />
            ) : null}
            <AvatarFallback
              className="text-sidebar-primary-foreground text-[9px] font-bold"
              style={{
                background:
                  "linear-gradient(135deg, hsl(var(--primary)), hsl(var(--primary-light)))",
              }}
            >
              {userInitials}
            </AvatarFallback>
          </Avatar>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {/* Who you are signed in as — the sidebar footer shows this beside
              its avatar, but that is off-screen on a phone. */}
          <DropdownMenuLabel className="min-w-0 font-normal">
            <span className="block truncate text-sm font-medium">
              {user?.name ?? "Signed in"}
            </span>
            {user?.email && (
              <span className="text-muted-foreground block truncate text-xs">
                {user.email}
              </span>
            )}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <AccountMenuItems onLogout={logout} />
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
