import { PERMISSIONS } from "@nexora/contracts";
import type {
  CreateUpdateInput,
  ListUpdatesQuery,
  UpdateUpdateInput,
} from "@nexora/contracts/modules/investor-updates/investor-updates.validation";
import type { Db } from "@nexora/db";
import { BadRequestException, NotFoundException } from "../http-exception";
import * as repo from "./investor-updates.repository";

/** create/send holders see drafts; bare read is published (sent) only. */
export function canManageInvestorUpdates(permissions: string[]): boolean {
  return (
    permissions.includes(PERMISSIONS.INVESTOR_UPDATES_CREATE) ||
    permissions.includes(PERMISSIONS.INVESTOR_UPDATES_SEND)
  );
}

export async function list(db: Db, query: ListUpdatesQuery, permissions: string[]) {
  const { page, limit, ...filters } = query;
  if (!canManageInvestorUpdates(permissions)) {
    filters.status = "sent";
  }
  const { data, total } = await repo.findMany(db, filters, page, limit);
  return { data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 } };
}

export async function getById(db: Db, id: string, permissions: string[]) {
  const row = await repo.findById(db, id);
  // Hide drafts from read-only callers (404, not 403 — avoid existence leak).
  if (!row || (!canManageInvestorUpdates(permissions) && row.status !== "sent")) {
    throw new NotFoundException("Investor update not found");
  }
  return row;
}

export async function create(db: Db, input: CreateUpdateInput) {
  return repo.create(db, {
    title: input.title,
    content: input.content,
    period: input.period,
    status: input.status ?? "draft",
  });
}

export async function update(db: Db, id: string, input: UpdateUpdateInput, permissions: string[]) {
  const existing = await getById(db, id, permissions);
  if (existing.status === "sent") throw new BadRequestException("Cannot edit a sent update");
  return repo.update(db, id, {
    ...(input.title !== undefined && { title: input.title }),
    ...(input.content !== undefined && { content: input.content }),
    ...(input.period !== undefined && { period: input.period }),
    ...(input.status !== undefined && { status: input.status }),
  });
}

export async function remove(db: Db, id: string, permissions: string[]) {
  await getById(db, id, permissions);
  await repo.remove(db, id);
}

/** Stub — email dispatch lands in a follow-up PR; marks sent in DB only. */
export async function send(db: Db, id: string, sentBy: string, permissions: string[]) {
  const existing = await getById(db, id, permissions);
  if (existing.status === "sent") throw new BadRequestException("Update has already been sent");
  return repo.markAsSent(db, id, sentBy);
}
