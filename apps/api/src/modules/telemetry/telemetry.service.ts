import { logger } from "@/common/utils/logger";
import { prisma } from "@/infrastructure/database/prisma";
import { tracking } from "@/lib/tracking";

/**
 * Daily snapshot sync — refreshes person + group traits in PostHog.
 *
 * Wired through POST /api/cron/sync-telemetry. Intended to run once per
 * day from Cloud Scheduler, with the standard X-Cron-Secret header. The
 * trait list mirrors `tracking-plan.yaml#snapshot_sync`.
 */

const ROLLING_WINDOW_DAYS = 30;

export async function runSnapshotSync() {
  const since = new Date(
    Date.now() - ROLLING_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  );

  const users = await prisma.user.findMany({
    where: { isActive: true },
    select: {
      id: true,
      _count: {
        select: {
          leaveRequestsSubmitted: { where: { createdAt: { gt: since } } },
          expensesSubmitted: { where: { createdAt: { gt: since } } },
        },
      },
    },
  });

  // ManutAiMessage has no direct userId — count via the conversation owner.
  // Single grouped query is cheaper than n queries for ~50 users.
  const ariaCounts = await prisma.manutAiMessage.groupBy({
    by: ["conversationId"],
    where: { role: "user", createdAt: { gt: since } },
    _count: { _all: true },
  });
  const conversationOwners = ariaCounts.length
    ? await prisma.manutAiConversation.findMany({
        where: { id: { in: ariaCounts.map((c) => c.conversationId) } },
        select: { id: true, userId: true },
      })
    : [];
  const ownerByConversation = new Map(
    conversationOwners.map((c) => [c.id, c.userId]),
  );
  const ariaByUser = new Map<string, number>();
  for (const row of ariaCounts) {
    const userId = ownerByConversation.get(row.conversationId);
    if (!userId) continue;
    ariaByUser.set(userId, (ariaByUser.get(userId) ?? 0) + row._count._all);
  }

  for (const u of users) {
    tracking.identify(u.id, {
      leave_requests_30d: u._count.leaveRequestsSubmitted,
      expenses_30d: u._count.expensesSubmitted,
      aria_messages_30d: ariaByUser.get(u.id) ?? 0,
    });
  }

  const entities = await prisma.entity.findMany({
    select: {
      id: true,
      code: true,
      name: true,
      _count: { select: { users: { where: { isActive: true } } } },
    },
  });

  for (const e of entities) {
    tracking.groupIdentify("entity", e.id, {
      code: e.code,
      name: e.name,
      headcount: e._count.users,
    });
  }

  // Cron containers exit immediately after the response — flush the queue
  // synchronously or events go to /dev/null.
  await tracking.shutdown();

  logger.info("Telemetry snapshot sync complete", {
    users: users.length,
    entities: entities.length,
  });

  return { users: users.length, entities: entities.length };
}

export const telemetryService = { runSnapshotSync };
