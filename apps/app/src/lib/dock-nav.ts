import { DASHBOARD_HOME, type NavItem, itemVisible } from "@/lib/nav";

export type DockDestinationId = "home" | "aria" | "messages" | "more" | "leave" | "expenses";

export type DockDestinationDef = {
  id: DockDestinationId;
  href?: string;
  label: string;
  /** When true, opens the full-nav sheet instead of navigating. */
  opensMore?: boolean;
  permissions?: string[];
};

/** Primary phone / tablet destinations — keep ≤4 + More. */
export const DOCK_DESTINATIONS: DockDestinationDef[] = [
  { id: "home", href: DASHBOARD_HOME, label: "Home" },
  { id: "aria", href: "/aria", label: "ARIA", permissions: ["aria:use"] },
  {
    id: "messages",
    href: "/messages",
    label: "Messages",
    permissions: ["messages:read"],
  },
  { id: "more", label: "More", opensMore: true },
];

/** Extra tablet-rail shortcuts (permission-gated) when space allows. */
export const RAIL_EXTRA: DockDestinationDef[] = [
  { id: "leave", href: "/leave", label: "Leave", permissions: ["leave:read"] },
  { id: "expenses", href: "/expenses", label: "Expenses", permissions: ["expense:read"] },
];

export function filterDockDestinations(
  destinations: DockDestinationDef[],
  hasPermission: (code: string) => boolean,
): DockDestinationDef[] {
  return destinations.filter((item) => {
    if (item.opensMore) return true;
    const asNav: NavItem = {
      href: item.href ?? "#",
      label: item.label,
      permissions: item.permissions,
    };
    return itemVisible(asNav, hasPermission);
  });
}

export function buildTabletRail(
  hasPermission: (code: string) => boolean,
): DockDestinationDef[] {
  const primary = filterDockDestinations(
    DOCK_DESTINATIONS.filter((d) => !d.opensMore),
    hasPermission,
  );
  const extras = filterDockDestinations(RAIL_EXTRA, hasPermission);
  const more = DOCK_DESTINATIONS.find((d) => d.opensMore)!;
  return [...primary, ...extras.slice(0, 2), more];
}
