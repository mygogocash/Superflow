import type { Prisma } from "@nexora/database";

import { PERMISSIONS } from "@/common/constants/permissions";
import {
  ForbiddenException,
  NotFoundException,
} from "@/common/exceptions/http-exception";
import { newsRepository } from "@/modules/news/news.repository";
import type {
  CreateNewsInput,
  UpdateNewsInput,
} from "@/modules/news/news.validation";

export const newsService = {
  async listNews(page: number, limit: number) {
    const { data, total } = await newsRepository.findAll(page, limit);
    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  },

  async getNewsById(id: string) {
    const news = await newsRepository.findById(id);
    if (!news) throw new NotFoundException("News not found");
    return news;
  },

  async createNews(authorId: string, input: CreateNewsInput) {
    return newsRepository.create({
      title: input.title,
      content: input.content,
      category: input.category,
      isPinned: input.isPinned,
      authorId,
      attachments:
        input.attachments && input.attachments.length > 0
          ? (input.attachments as unknown as Prisma.InputJsonValue)
          : undefined,
    });
  },

  /**
   * Authors may edit their own posts. Moderators with `news:delete` may
   * edit any post (same privilege that already lets them remove it).
   * Bare `news:create` alone must not update a colleague's article.
   */
  async updateNews(
    id: string,
    actor: { userId: string; permissions: readonly string[] },
    input: UpdateNewsInput,
  ) {
    const news = await newsRepository.findById(id);
    if (!news) throw new NotFoundException("News not found");
    const isAuthor = news.authorId === actor.userId;
    const canModerate = actor.permissions.includes(PERMISSIONS.NEWS_DELETE);
    if (!isAuthor && !canModerate) {
      throw new ForbiddenException("You can only update your own news posts");
    }
    return newsRepository.update(id, input);
  },

  async deleteNews(id: string) {
    const news = await newsRepository.findById(id);
    if (!news) throw new NotFoundException("News not found");
    return newsRepository.delete(id);
  },
};
