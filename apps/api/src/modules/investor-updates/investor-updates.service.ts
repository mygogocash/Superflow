import { PERMISSIONS } from "@/common/constants/permissions";
import {
  BadRequestException,
  NotFoundException,
} from "@/common/exceptions/http-exception";
import { investorUpdateRepository } from "@/modules/investor-updates/investor-updates.repository";
import type {
  CreateUpdateInput,
  ListUpdatesQuery,
  UpdateUpdateInput,
} from "@/modules/investor-updates/investor-updates.validation";

/** create/send holders see drafts; bare read is published (sent) only. */
export function canManageInvestorUpdates(permissions: string[]): boolean {
  return (
    permissions.includes(PERMISSIONS.INVESTOR_UPDATES_CREATE) ||
    permissions.includes(PERMISSIONS.INVESTOR_UPDATES_SEND)
  );
}

export class InvestorUpdateService {
  async list(query: ListUpdatesQuery, permissions: string[]) {
    const { page, limit, ...filters } = query;
    if (!canManageInvestorUpdates(permissions)) {
      filters.status = "sent";
    }
    const { data, total } = await investorUpdateRepository.findMany(
      filters,
      page,
      limit,
    );
    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async getById(id: string, permissions: string[]) {
    const update = await investorUpdateRepository.findById(id);
    // Hide drafts from read-only callers (404, not 403 — avoid existence leak).
    if (
      !update ||
      (!canManageInvestorUpdates(permissions) && update.status !== "sent")
    ) {
      throw new NotFoundException("Investor update not found");
    }
    return update;
  }

  async create(input: CreateUpdateInput) {
    return investorUpdateRepository.create({
      title: input.title,
      content: input.content,
      period: input.period,
      status: input.status ?? "draft",
    });
  }

  async update(id: string, input: UpdateUpdateInput, permissions: string[]) {
    const existing = await this.getById(id, permissions);
    if (existing.status === "sent") {
      throw new BadRequestException("Cannot edit a sent update");
    }

    return investorUpdateRepository.update(id, {
      ...(input.title !== undefined && { title: input.title }),
      ...(input.content !== undefined && { content: input.content }),
      ...(input.period !== undefined && { period: input.period }),
      ...(input.status !== undefined && { status: input.status }),
    });
  }

  async delete(id: string, permissions: string[]) {
    await this.getById(id, permissions);
    return investorUpdateRepository.delete(id);
  }

  async send(id: string, sentBy: string, permissions: string[]) {
    const existing = await this.getById(id, permissions);
    if (existing.status === "sent") {
      throw new BadRequestException("Update has already been sent");
    }

    return investorUpdateRepository.markAsSent(id, sentBy);
  }
}

export const investorUpdateService = new InvestorUpdateService();
