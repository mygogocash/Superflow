import { PERMISSIONS } from "@nexora/contracts";
import type { CreateNewsInput, UpdateNewsInput } from "@nexora/contracts/modules/news/news.validation";
import type { Db } from "@nexora/db";
import { ForbiddenException, NotFoundException } from "../http-exception";
import * as repo from "./news.repository";

export async function listNews(db: Db, page: number, limit: number) {
  const { data, total } = await repo.findAllNews(db, page, limit);
  return { data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 } };
}

export async function getNewsById(db: Db, id: string) {
  const news = await repo.findNewsById(db, id);
  if (!news) throw new NotFoundException("News not found");
  return news;
}

export async function createNews(db: Db, authorId: string, input: CreateNewsInput) {
  return repo.createNews(db, {
    authorId,
    title: input.title,
    content: input.content,
    category: input.category,
    isPinned: input.isPinned,
    attachments: input.attachments && input.attachments.length > 0 ? input.attachments : undefined,
  });
}

/**
 * Authors may edit their own posts. Moderators with `news:delete` may
 * edit any post (same privilege that already lets them remove it).
 * Bare `news:create` alone must not update a colleague's article.
 */
export async function updateNews(
  db: Db,
  id: string,
  actor: { userId: string; permissions: readonly string[] },
  input: UpdateNewsInput,
) {
  const existing = await repo.findNewsById(db, id);
  if (!existing) throw new NotFoundException("News not found");
  const isAuthor = existing.authorId === actor.userId;
  const canModerate = actor.permissions.includes(PERMISSIONS.NEWS_DELETE);
  if (!isAuthor && !canModerate) {
    throw new ForbiddenException("You can only update your own news posts");
  }
  return repo.updateNews(db, id, input);
}

export async function deleteNews(db: Db, id: string) {
  const existing = await repo.findNewsById(db, id);
  if (!existing) throw new NotFoundException("News not found");
  await repo.deleteNews(db, id);
}
