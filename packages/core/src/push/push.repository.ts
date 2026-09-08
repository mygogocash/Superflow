import { and, count, eq } from "drizzle-orm";
import type { Db } from "@nexora/db";
import { schema } from "@nexora/db";

export async function countForUser(db: Db, userId: string) {
  const [countRow] = await db.select({ n: count() }).from(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.userId, userId));
  return Number(countRow?.n ?? 0);
}

export async function upsertSubscription(db: Db, data: {
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}) {
  const now = new Date().toISOString();
  const [existing] = await db.select().from(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.endpoint, data.endpoint)).limit(1);
  if (existing) {
    await db
      .update(schema.pushSubscriptions)
      .set({
        userId: data.userId,
        p256Dh: data.p256dh,
        auth: data.auth,
        userAgent: data.userAgent ?? null,
        failureCount: 0,
        updatedAt: now,
      })
      .where(eq(schema.pushSubscriptions.id, existing.id));
    return { ...existing, userId: data.userId, updatedAt: now };
  }
  const id = crypto.randomUUID();
  await db.insert(schema.pushSubscriptions).values({
    id,
    userId: data.userId,
    endpoint: data.endpoint,
    p256Dh: data.p256dh,
    auth: data.auth,
    userAgent: data.userAgent ?? null,
    createdAt: now,
    updatedAt: now,
  });
  const [row] = await db.select().from(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.id, id)).limit(1);
  return row!;
}

export async function deleteByEndpoint(db: Db, userId: string, endpoint: string) {
  // Must scope by userId: endpoint URLs are guessable/replayable; never let
  // one authenticated user unsubscribe another user's device.
  const deleted = await db
    .delete(schema.pushSubscriptions)
    .where(
      and(
        eq(schema.pushSubscriptions.endpoint, endpoint),
        eq(schema.pushSubscriptions.userId, userId),
      ),
    )
    .returning({ id: schema.pushSubscriptions.id });
  return { removed: deleted.length > 0, count: deleted.length };
}

export async function deleteAllForUser(db: Db, userId: string) {
  await db.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.userId, userId));
  return { removed: true };
}
