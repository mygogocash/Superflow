import { useRouter, type Href } from "expo-router";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";
import { EmptyState } from "@/components/empty-state";
import { CenteredPageSkeleton } from "@/components/page-list-skeleton";
import { PageScreen } from "@/components/page-screen";
import { Text } from "@/components/ui/text";
import { useApiQuery } from "@/hooks/use-api-query";
import { DESKTOP_MIN, TABLET_MIN, useViewportWidth } from "@/hooks/use-viewport-width";
import {
  dashboardRecap,
  firstNameOf,
  formatMoneyThb,
  formatRelativeTime,
  greetingForHour,
  unwrapDashboardStats,
  urgentItemHref,
  type DashboardStats,
} from "@/lib/dashboard";
import { DASHBOARD_HOME, EMPLOYEE_NAV_GROUPS, NAV_GROUPS, filterNavGroups } from "@/lib/nav";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import { useAuth } from "@/store/auth";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View className="mb-6">
      <Text className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</Text>
      {children}
    </View>
  );
}

function CardLink({
  title,
  meta,
  href,
  width,
}: {
  title: string;
  meta?: string;
  href: string;
  width: `${number}%` | number;
}) {
  const router = useRouter();
  return (
    <Pressable
      accessibilityRole="link"
      onPress={() => router.push(href as Href)}
      style={{ width, minWidth: width, flexGrow: 1 }}
      className="rounded-xl border border-border bg-card px-4 py-3.5 active:bg-accent"
    >
      <Text className="text-[22px] font-bold tracking-tight text-foreground">{title}</Text>
      {meta ? <Text className="mt-1 text-[13px] text-muted-foreground">{meta}</Text> : null}
    </Pressable>
  );
}

function ActivityRow({ title, meta, href }: { title: string; meta?: string; href: string }) {
  const router = useRouter();
  return (
    <Pressable
      accessibilityRole="link"
      onPress={() => router.push(href as Href)}
      className="border-b border-border px-4 py-3.5 last:border-b-0 active:bg-accent"
    >
      <Text className="text-[15px] font-semibold text-foreground">{title}</Text>
      {meta ? <Text className="mt-0.5 text-[13px] text-muted-foreground">{meta}</Text> : null}
    </Pressable>
  );
}

function metricWidth(viewport: number): `${number}%` {
  if (viewport >= DESKTOP_MIN) return "24%";
  if (viewport >= TABLET_MIN) return "48%";
  return "48%";
}

export default function DashboardHome() {
  const router = useRouter();
  const viewport = useViewportWidth();
  const { user, hasPermission, isEmployeeOnly } = useAuth();
  const query = useApiQuery<unknown>(queryKeys.dashboard.stats(), "/dashboard/stats");
  const stats = unwrapDashboardStats(query.data);
  const groups = filterNavGroups(isEmployeeOnly ? EMPLOYEE_NAV_GROUPS : NAV_GROUPS, hasPermission);
  const col = metricWidth(viewport);
  const hour = new Date().getHours();

  if (query.isLoading) {
    return <CenteredPageSkeleton />;
  }

  if (query.error || !stats) {
    return (
      <PageScreen title="Dashboard">
        <View className="overflow-hidden rounded-xl border border-border bg-card">
          <EmptyState
            variant="error"
            heading="Couldn't load your dashboard"
            description={query.error?.message ?? "Check your connection and try again."}
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
    <DashboardBody
      stats={stats}
      userName={user?.name}
      hour={hour}
      col={col}
      groups={groups}
      hasPermission={hasPermission}
      onOpen={(href) => router.push(href as Href)}
    />
  );
}

function DashboardBody({
  stats,
  userName,
  hour,
  col,
  groups,
  hasPermission,
  onOpen,
}: {
  stats: DashboardStats;
  userName?: string;
  hour: number;
  col: `${number}%`;
  groups: ReturnType<typeof filterNavGroups>;
  hasPermission: (code: string) => boolean;
  onOpen: (href: string) => void;
}) {
  const canLeave = hasPermission("leave:read") || hasPermission("leave:approve") || hasPermission("leave:hr-read");
  const canTravel = hasPermission("travel:read") || hasPermission("travel:approve") || hasPermission("travel:hr-read");
  const canExpense = hasPermission("expense:read") || hasPermission("expense:approve") || hasPermission("expense:hr-read");
  const canProjects = hasPermission("projects:read");
  const canEmployees = hasPermission("user:read");
  const canMessages = hasPermission("messages:read");
  const recap = dashboardRecap(stats);
  const attention = [
    ...stats.urgentItems.map((item) => ({
      key: `urgent-${item.label}`,
      title: item.label,
      meta: item.severity === "urgent" ? "Urgent" : "Pending",
      href: urgentItemHref(item.label),
    })),
    ...stats.pendingActions.map((item) => ({
      key: item.id,
      title: item.title,
      meta: item.subtitle,
      href: item.href,
    })),
  ];
  const activity = [
    ...stats.recentNews.map((item) => ({
      title: item.title,
      meta: `News · ${formatRelativeTime(item.createdAt)}`,
      href: "/news",
    })),
    ...stats.recentWallPosts.map((item) => ({
      title: item.content,
      meta: `${item.author || "Wall"} · ${formatRelativeTime(item.createdAt)}`,
      href: "/wall",
    })),
    ...stats.upcomingDates.map((item) => ({
      title: item.title,
      meta: `Date · ${item.date}`,
      href: "/company-dates",
    })),
  ].slice(0, 8);
  const shortcuts = [
    canLeave ? { href: "/leave", label: "Request leave" } : null,
    canExpense ? { href: "/expenses", label: "Submit expense" } : null,
    canTravel ? { href: "/travel", label: "Travel request" } : null,
    canMessages ? { href: "/messages", label: "Open messages" } : null,
  ].filter((item): item is { href: string; label: string } => item != null);

  return (
    <PageScreen title={`${greetingForHour(hour)}, ${firstNameOf(userName)}`} subtitle={recap}>
      <Section title="Key metrics">
        <View className="flex-row flex-wrap gap-3">
          {canExpense ? (
            <CardLink title={formatMoneyThb(stats.kpis.expensesThisMonth)} meta="Expenses this month" href="/expenses" width={col} />
          ) : null}
          {canLeave ? (
            <CardLink
              title={String(stats.kpis.pendingLeaves)}
              meta={stats.kpis.pendingLeaves > 0 ? "Pending leave" : "Leave queue clear"}
              href="/leave"
              width={col}
            />
          ) : null}
          {canProjects ? (
            <CardLink title={String(stats.kpis.activeProjects)} meta="Active projects" href="/projects" width={col} />
          ) : null}
          {canEmployees ? (
            <CardLink title={String(stats.kpis.totalEmployees)} meta="Active employees" href="/hrms" width={col} />
          ) : null}
          {canTravel ? (
            <CardLink title={String(stats.kpis.pendingTravels)} meta="Pending travel" href="/travel" width={col} />
          ) : null}
          {canExpense ? (
            <CardLink title={String(stats.kpis.pendingExpenses)} meta="Pending expenses" href="/expenses" width={col} />
          ) : null}
        </View>
      </Section>

      <Section title="Needs attention">
        <View className="overflow-hidden rounded-xl border border-border bg-card">
          {attention.length === 0 ? (
            <EmptyState heading="You're all caught up" description="Approvals and urgent items will land here when they need you." />
          ) : (
            attention.slice(0, 8).map((item) => (
              <ActivityRow key={item.key} title={item.title} meta={item.meta} href={item.href} />
            ))
          )}
        </View>
      </Section>

      <Section title="Recent activity">
        <View className="overflow-hidden rounded-xl border border-border bg-card">
          {activity.length === 0 ? (
            <EmptyState heading="No recent activity" description="News, wall posts, and upcoming dates will show here." />
          ) : (
            activity.map((item) => <ActivityRow key={`${item.href}-${item.title}`} title={item.title} meta={item.meta} href={item.href} />)
          )}
        </View>
      </Section>

      {shortcuts.length > 0 ? (
        <Section title="Quick actions">
          <View className="flex-row flex-wrap gap-3">
            {shortcuts.map((item) => (
              <Pressable
                key={item.href}
                accessibilityRole="link"
                onPress={() => onOpen(item.href)}
                style={{ width: col, minWidth: col, flexGrow: 1 }}
                className="rounded-xl border border-border bg-card px-4 py-3.5 active:bg-accent"
              >
                <Text className="text-[15px] font-semibold text-foreground">{item.label}</Text>
              </Pressable>
            ))}
          </View>
        </Section>
      ) : null}

      <Section title="All modules">
        {groups.map((group) => (
          <View key={group.label} className="mb-4">
            <Text className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{group.label}</Text>
            <View className="flex-row flex-wrap gap-2">
              {group.items
                .filter((item) => item.href !== DASHBOARD_HOME)
                .map((item) => (
                  <Pressable
                    key={item.href}
                    accessibilityRole="link"
                    onPress={() => onOpen(item.href)}
                    className={cn("rounded-lg border border-border bg-card px-3 py-2.5 active:bg-accent")}
                    style={{ minWidth: 120 }}
                  >
                    <Text className="text-[13px] font-medium text-foreground">{item.label}</Text>
                  </Pressable>
                ))}
            </View>
          </View>
        ))}
      </Section>
    </PageScreen>
  );
}
