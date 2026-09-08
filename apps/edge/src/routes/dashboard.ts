import { Hono } from "hono";
import { PERMISSIONS } from "@nexora/contracts";
import { schema } from "@nexora/db";
import { and, count, eq, isNull, sql } from "drizzle-orm";
import type { AppEnv } from "../lib/context";
import { requirePermission } from "../middleware/rbac";

/**
 * Dashboard stats for the Expo home shell.
 *
 * Expo `unwrapDashboardStats` requires a `kpis` object — the previous
 * notification-only skeleton returned 200 without `kpis`, so the client
 * treated a successful response as "Couldn't load your dashboard".
 */
export const dashboard = new Hono<AppEnv>().get(
  "/stats",
  requirePermission(PERMISSIONS.HOME_READ),
  async (c) => {
    const user = c.var.user!;
    const db = c.var.db;

    const safeCount = async (query: Promise<{ n: number }[]>) => {
      try {
        const [row] = await query;
        return Number(row?.n ?? 0);
      } catch {
        return 0;
      }
    };

    const [
      totalEmployees,
      activeProjects,
      pendingLeaves,
      pendingTravels,
      pendingExpenses,
      expensesThisMonth,
    ] = await Promise.all([
      safeCount(
        db
          .select({ n: count() })
          .from(schema.users)
          .where(and(eq(schema.users.isActive, true), isNull(schema.users.deletedAt))),
      ),
      safeCount(
        db
          .select({ n: count() })
          .from(schema.projects)
          .where(isNull(schema.projects.archivedAt)),
      ),
      safeCount(
        db
          .select({ n: count() })
          .from(schema.leaveRequests)
          .where(
            and(eq(schema.leaveRequests.status, "pending"), isNull(schema.leaveRequests.deletedAt)),
          ),
      ),
      safeCount(
        db
          .select({ n: count() })
          .from(schema.travelRequests)
          .where(
            and(
              eq(schema.travelRequests.status, "pending"),
              isNull(schema.travelRequests.deletedAt),
            ),
          ),
      ),
      safeCount(
        db
          .select({ n: count() })
          .from(schema.expenseReports)
          .where(
            and(
              eq(schema.expenseReports.status, "pending"),
              isNull(schema.expenseReports.deletedAt),
            ),
          ),
      ),
      safeCount(
        db
          .select({
            n: sql<number>`coalesce(sum(${schema.expenseReports.approvedTotal}), 0)`,
          })
          .from(schema.expenseReports)
          .where(
            and(
              isNull(schema.expenseReports.deletedAt),
              sql`date_trunc('month', ${schema.expenseReports.createdAt}::timestamp) = date_trunc('month', now())`,
            ),
          ),
      ),
    ]);

    return c.json({
      user: { id: user.id, name: user.name, email: user.email },
      kpis: {
        totalEmployees,
        activeProjects,
        pendingLeaves,
        pendingTravels,
        pendingExpenses,
        expensesThisMonth,
      },
      notifications: {
        approval: [],
        urgent: [],
        survey: [],
        "it-crm": [],
        news: [],
      },
      pendingActions: [],
      urgentItems: [],
      recentNews: [],
      recentWallPosts: [],
      upcomingDates: [],
    });
  },
);
