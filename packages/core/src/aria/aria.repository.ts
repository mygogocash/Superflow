import { and, desc, eq, ilike, or } from "drizzle-orm";
import type { Db } from "@nexora/db";
import { schema } from "@nexora/db";

export async function listConversations(db: Db, userId: string) {
  return db
    .select({
      id: schema.manutAiConversations.id,
      title: schema.manutAiConversations.title,
      createdAt: schema.manutAiConversations.createdAt,
      updatedAt: schema.manutAiConversations.updatedAt,
    })
    .from(schema.manutAiConversations)
    .where(eq(schema.manutAiConversations.userId, userId))
    .orderBy(desc(schema.manutAiConversations.updatedAt));
}

export async function findConversation(db: Db, userId: string, id: string) {
  const [row] = await db
    .select()
    .from(schema.manutAiConversations)
    .where(and(eq(schema.manutAiConversations.id, id), eq(schema.manutAiConversations.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function createConversation(db: Db, userId: string, title: string | null) {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  await db.insert(schema.manutAiConversations).values({ id, userId, title, createdAt: now, updatedAt: now });
  return { id, userId, title, createdAt: now, updatedAt: now };
}

export async function deleteConversation(db: Db, userId: string, id: string) {
  await db
    .delete(schema.manutAiConversations)
    .where(and(eq(schema.manutAiConversations.id, id), eq(schema.manutAiConversations.userId, userId)));
}

export async function listMessages(db: Db, conversationId: string) {
  return db
    .select()
    .from(schema.manutAiMessages)
    .where(eq(schema.manutAiMessages.conversationId, conversationId))
    .orderBy(schema.manutAiMessages.createdAt);
}

export async function listKnowledge(db: Db, query: { category?: string; isActive?: boolean; search?: string }) {
  const conditions = [];
  if (query.category) conditions.push(eq(schema.manutAiKnowledgeArticles.category, query.category));
  if (query.isActive !== undefined) conditions.push(eq(schema.manutAiKnowledgeArticles.isActive, query.isActive));
  if (query.search?.trim()) {
    const q = `%${query.search.trim()}%`;
    conditions.push(or(ilike(schema.manutAiKnowledgeArticles.title, q), ilike(schema.manutAiKnowledgeArticles.slug, q))!);
  }
  const where = conditions.length ? and(...conditions) : undefined;
  return db
    .select()
    .from(schema.manutAiKnowledgeArticles)
    .where(where)
    .orderBy(desc(schema.manutAiKnowledgeArticles.updatedAt));
}

export async function findKnowledgeById(db: Db, id: string) {
  const [row] = await db.select().from(schema.manutAiKnowledgeArticles).where(eq(schema.manutAiKnowledgeArticles.id, id)).limit(1);
  return row ?? null;
}

export async function findKnowledgeBySlug(db: Db, slug: string) {
  const [row] = await db.select().from(schema.manutAiKnowledgeArticles).where(eq(schema.manutAiKnowledgeArticles.slug, slug)).limit(1);
  return row ?? null;
}

export async function createKnowledge(
  db: Db,
  input: {
    id: string;
    category: string;
    title: string;
    slug: string;
    body: string;
    keywords: string[];
    tags: string[];
    requiredPermissions: string[];
    isActive: boolean;
    createdById: string | null;
  },
) {
  const now = new Date().toISOString();
  await db.insert(schema.manutAiKnowledgeArticles).values({
    id: input.id,
    category: input.category,
    title: input.title,
    slug: input.slug,
    body: input.body,
    keywords: input.keywords,
    tags: input.tags,
    requiredPermissions: input.requiredPermissions,
    isActive: input.isActive,
    createdById: input.createdById,
    createdAt: now,
    updatedAt: now,
  });
  return findKnowledgeById(db, input.id);
}

export async function updateKnowledge(db: Db, id: string, patch: Record<string, unknown>) {
  const now = new Date().toISOString();
  await db.update(schema.manutAiKnowledgeArticles).set({ ...patch, updatedAt: now }).where(eq(schema.manutAiKnowledgeArticles.id, id));
  return findKnowledgeById(db, id);
}

export async function deleteKnowledge(db: Db, id: string) {
  await db.delete(schema.manutAiKnowledgeArticles).where(eq(schema.manutAiKnowledgeArticles.id, id));
}
