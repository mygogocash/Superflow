import { isAdminSettingKey } from "@nexora/contracts/modules/admin/admin.validation";
import type {
  CreateDepartmentInput,
  CreateUserGroupInput,
  ManageGroupMembersInput,
  UpdateDepartmentInput,
  UpdateModuleAccessInput,
  UpdateSettingsInput,
  UpdateUserGroupInput,
} from "@nexora/contracts/modules/admin/admin.validation";
import type { Db } from "@nexora/db";
import { asc, desc, eq } from "drizzle-orm";
import { schema } from "@nexora/db";
import { ForbiddenException, NotFoundException } from "../http-exception";
import { assertActorCanAccessUser } from "../users/service";
import * as repo from "./admin.repository";

export async function listAuditLogs(
  db: Db,
  page: number,
  limit: number,
  filters?: { resource?: string; userId?: string; action?: string },
) {
  const { data, total } = await repo.findAuditLogs(db, page, limit, filters);
  return { data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 } };
}

export async function listEntities(db: Db) {
  const entities = await db
    .select({
      id: schema.entities.id,
      name: schema.entities.name,
      code: schema.entities.code,
      country: schema.entities.country,
      currency: schema.entities.currency,
    })
    .from(schema.entities)
    .where(eq(schema.entities.isActive, true))
    .orderBy(asc(schema.entities.name));
  return { data: entities };
}

export async function getSettings(db: Db) {
  const settings = await repo.findAllSettings(db);
  const result: Record<string, unknown> = {};
  for (const s of settings) {
    if (isAdminSettingKey(s.key)) result[s.key] = s.value;
  }
  return result;
}

export async function updateSettings(
  db: Db,
  input: UpdateSettingsInput,
  options: { isSystemAdmin?: boolean } = {},
) {
  const securityWrites = input.settings.filter((s) => s.key.startsWith("security."));
  if (securityWrites.length > 0 && !options.isSystemAdmin) {
    throw new ForbiddenException("System administrator required to change security settings");
  }
  await repo.upsertSettings(
    db,
    input.settings.map((s) => ({ key: s.key, value: s.value })),
  );
  return getSettings(db);
}

export async function getModuleAccess(db: Db, userId: string, actorId: string) {
  await assertActorCanAccessUser(db, actorId, userId);
  const [user] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
  if (!user) throw new NotFoundException("User not found");
  const access = await repo.findModuleAccessByUser(db, userId);
  return { data: access };
}

export async function updateModuleAccess(db: Db, input: UpdateModuleAccessInput, actorId: string) {
  await assertActorCanAccessUser(db, actorId, input.userId);
  const [user] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, input.userId)).limit(1);
  if (!user) throw new NotFoundException("User not found");
  await repo.upsertModuleAccess(db, input.userId, input.modules, actorId);
  const updated = await repo.findModuleAccessByUser(db, input.userId);
  return { data: updated };
}

export async function listUserGroups(db: Db) {
  return { data: await repo.findUserGroups(db) };
}

export async function getUserGroup(db: Db, id: string) {
  const group = await repo.findUserGroupById(db, id);
  if (!group) throw new NotFoundException("User group not found");
  return group;
}

export async function createUserGroup(db: Db, input: CreateUserGroupInput, createdBy: string) {
  return repo.createUserGroup(db, { name: input.name, description: input.description, createdBy });
}

export async function updateUserGroup(db: Db, id: string, input: UpdateUserGroupInput) {
  const existing = await repo.findUserGroupById(db, id);
  if (!existing) throw new NotFoundException("User group not found");
  return repo.updateUserGroup(db, id, input);
}

export async function deleteUserGroup(db: Db, id: string) {
  const existing = await repo.findUserGroupById(db, id);
  if (!existing) throw new NotFoundException("User group not found");
  await repo.deleteUserGroup(db, id);
}

export async function addGroupMembers(db: Db, groupId: string, input: ManageGroupMembersInput, addedBy: string) {
  const group = await repo.findUserGroupById(db, groupId);
  if (!group) throw new NotFoundException("User group not found");
  await repo.addGroupMembers(db, groupId, input.userIds, addedBy);
  return repo.findUserGroupById(db, groupId);
}

export async function removeGroupMembers(db: Db, groupId: string, input: ManageGroupMembersInput) {
  const group = await repo.findUserGroupById(db, groupId);
  if (!group) throw new NotFoundException("User group not found");
  await repo.removeGroupMembers(db, groupId, input.userIds);
  return repo.findUserGroupById(db, groupId);
}

export async function listDepartments(db: Db) {
  const data = await db
    .select({
      id: schema.departments.id,
      name: schema.departments.name,
      code: schema.departments.code,
      description: schema.departments.description,
      isActive: schema.departments.isActive,
      createdAt: schema.departments.createdAt,
      updatedAt: schema.departments.updatedAt,
    })
    .from(schema.departments)
    .orderBy(desc(schema.departments.isActive), asc(schema.departments.name));
  return { data };
}

export async function createDepartment(db: Db, input: CreateDepartmentInput) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(schema.departments).values({
    id,
    name: input.name,
    code: input.code ?? null,
    description: input.description ?? null,
    createdAt: now,
    updatedAt: now,
  });
  const [row] = await db.select().from(schema.departments).where(eq(schema.departments.id, id)).limit(1);
  return { data: row };
}

export async function updateDepartment(db: Db, id: string, input: UpdateDepartmentInput) {
  const [existing] = await db.select({ id: schema.departments.id }).from(schema.departments).where(eq(schema.departments.id, id)).limit(1);
  if (!existing) throw new NotFoundException("Department not found");
  const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.code !== undefined) patch.code = input.code || null;
  if (input.description !== undefined) patch.description = input.description || null;
  if (input.isActive !== undefined) patch.isActive = input.isActive;
  await db.update(schema.departments).set(patch).where(eq(schema.departments.id, id));
  const [row] = await db.select().from(schema.departments).where(eq(schema.departments.id, id)).limit(1);
  return { data: row };
}

export async function deleteDepartment(db: Db, id: string) {
  const [existing] = await db.select({ id: schema.departments.id }).from(schema.departments).where(eq(schema.departments.id, id)).limit(1);
  if (!existing) throw new NotFoundException("Department not found");
  await db.delete(schema.departments).where(eq(schema.departments.id, id));
}
