import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  not,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { normalizePermissionCode } from "@nexora/contracts/common/constants/permissions";
import type { ListUsersQuery } from "@nexora/contracts/modules/users/users.validation";
import type { Db } from "@nexora/db";
import { schema } from "@nexora/db";
import { alias } from "drizzle-orm/pg-core";

const manager = alias(schema.users, "users_manager");
const entity = alias(schema.entities, "users_entity");

function buildListWhere(query: ListUsersQuery): SQL | undefined {
  const parts: SQL[] = [isNull(schema.users.deletedAt)];

  if (query.search) {
    const q = `%${query.search}%`;
    parts.push(
      or(
        ilike(schema.users.name, q),
        ilike(schema.users.email, q),
        ilike(schema.users.employeeId, q),
      )!,
    );
  }
  if (query.entityId) parts.push(eq(schema.users.entityId, query.entityId));
  if (query.department) parts.push(eq(schema.users.department, query.department));
  if (query.employmentType) parts.push(eq(schema.users.employmentType, query.employmentType));
  if (query.isActive !== undefined) parts.push(eq(schema.users.isActive, query.isActive));
  if (query.userIds) {
    if (query.userIds.length === 0) {
      // Force empty result without a bogus IN ().
      parts.push(sql`false`);
    } else {
      parts.push(inArray(schema.users.id, query.userIds));
    }
  }
  if (!query.includePlaceholders) {
    parts.push(not(ilike(schema.users.email, sql`'%@placeholder.local'`)));
  }

  return and(...parts);
}

async function attachRelations(db: Db, userIds: string[]) {
  if (userIds.length === 0) {
    return {
      entities: new Map<string, { id: string; name: string }>(),
      managers: new Map<string, { id: string; name: string; email: string }>(),
      roles: new Map<string, Array<{ id: string; name: string; description: string | null }>>(),
    };
  }

  const entityRows = await db
    .select({
      userId: schema.users.id,
      entityId: entity.id,
      entityName: entity.name,
    })
    .from(schema.users)
    .leftJoin(entity, eq(schema.users.entityId, entity.id))
    .where(inArray(schema.users.id, userIds));

  const managerRows = await db
    .select({
      userId: schema.users.id,
      managerId: manager.id,
      managerName: manager.name,
      managerEmail: manager.email,
    })
    .from(schema.users)
    .leftJoin(manager, eq(schema.users.reportingTo, manager.id))
    .where(inArray(schema.users.id, userIds));

  const roleRows = await db
    .select({
      userId: schema.userRoles.userId,
      roleId: schema.roles.id,
      roleName: schema.roles.name,
      roleDescription: schema.roles.description,
    })
    .from(schema.userRoles)
    .innerJoin(schema.roles, eq(schema.userRoles.roleId, schema.roles.id))
    .where(inArray(schema.userRoles.userId, userIds));

  const entities = new Map<string, { id: string; name: string }>();
  const managers = new Map<string, { id: string; name: string; email: string }>();
  const roles = new Map<string, Array<{ id: string; name: string; description: string | null }>>();

  for (const r of entityRows) {
    if (r.entityId) entities.set(r.userId, { id: r.entityId, name: r.entityName! });
  }
  for (const r of managerRows) {
    if (r.managerId) managers.set(r.userId, { id: r.managerId, name: r.managerName!, email: r.managerEmail! });
  }
  for (const r of roleRows) {
    const list = roles.get(r.userId) ?? [];
    list.push({ id: r.roleId, name: r.roleName, description: r.roleDescription });
    roles.set(r.userId, list);
  }

  return { entities, managers, roles };
}

function mapListRow(
  row: typeof schema.users.$inferSelect,
  rel: Awaited<ReturnType<typeof attachRelations>>,
) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatarUrl,
    phone: row.phone,
    department: row.department,
    jobTitle: row.jobTitle,
    employeeId: row.employeeId,
    employmentType: row.employmentType,
    startDate: row.startDate,
    location: row.location,
    country: row.country,
    isActive: row.isActive,
    entity: rel.entities.get(row.id) ?? null,
    manager: rel.managers.get(row.id) ?? null,
    roles: rel.roles.get(row.id) ?? [],
    createdAt: row.createdAt,
  };
}

export async function findMany(db: Db, query: ListUsersQuery) {
  const where = buildListWhere(query);
  const offset = (query.page - 1) * query.limit;

  let idFilter: SQL | undefined;
  if (query.roleId) {
    const roleUserRows = await db
      .select({ userId: schema.userRoles.userId })
      .from(schema.userRoles)
      .where(eq(schema.userRoles.roleId, query.roleId));
    const ids = roleUserRows.map((r) => r.userId);
    if (ids.length === 0) return { users: [], total: 0 };
    idFilter = inArray(schema.users.id, ids);
  }

  const fullWhere = idFilter ? and(where, idFilter) : where;

  const order =
    query.sortBy === "email"
      ? query.sortOrder === "desc"
        ? desc(schema.users.email)
        : asc(schema.users.email)
      : query.sortBy === "createdAt"
        ? query.sortOrder === "desc"
          ? desc(schema.users.createdAt)
          : asc(schema.users.createdAt)
        : query.sortBy === "employeeId"
          ? query.sortOrder === "desc"
            ? desc(schema.users.employeeId)
            : asc(schema.users.employeeId)
          : query.sortOrder === "desc"
            ? desc(schema.users.name)
            : asc(schema.users.name);

  const [rows, totalRow] = await Promise.all([
    db.select().from(schema.users).where(fullWhere).orderBy(order).limit(query.limit).offset(offset),
    db.select({ n: count() }).from(schema.users).where(fullWhere),
  ]);

  const rel = await attachRelations(
    db,
    rows.map((r) => r.id),
  );

  return {
    users: rows.map((r) => mapListRow(r, rel)),
    total: Number(totalRow[0]?.n ?? 0),
  };
}

export async function findById(db: Db, id: string) {
  const [row] = await db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
  if (!row) return null;

  const rel = await attachRelations(db, [id]);
  const roles = rel.roles.get(id) ?? [];

  let entityRow: { id: string; name: string } | null = null;
  if (row.entityId) {
    const [e] = await db
      .select({ id: schema.entities.id, name: schema.entities.name })
      .from(schema.entities)
      .where(eq(schema.entities.id, row.entityId))
      .limit(1);
    entityRow = e ?? null;
  }

  let managerRow: { id: string; name: string; email: string } | null = null;
  if (row.reportingTo) {
    const [m] = await db
      .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, row.reportingTo))
      .limit(1);
    managerRow = m ?? null;
  }

  return {
    ...row,
    entity: entityRow,
    manager: managerRow,
    roles: roles.map((r) => ({ id: r.id, name: r.name, description: r.description })),
  };
}

export async function findByEmployeeId(db: Db, employeeId: string) {
  const [row] = await db
    .select({ id: schema.users.id, employeeId: schema.users.employeeId })
    .from(schema.users)
    .where(and(eq(schema.users.employeeId, employeeId), isNull(schema.users.deletedAt)))
    .limit(1);
  return row ?? null;
}

export async function update(db: Db, id: string, patch: Record<string, unknown>) {
  const now = new Date().toISOString();
  await db
    .update(schema.users)
    .set({ ...patch, updatedAt: now })
    .where(eq(schema.users.id, id));
  return findById(db, id);
}

export async function softDelete(db: Db, id: string) {
  const now = new Date().toISOString();
  await db
    .update(schema.users)
    .set({ deletedAt: now, updatedAt: now })
    .where(eq(schema.users.id, id));
}

export async function restore(db: Db, id: string) {
  const now = new Date().toISOString();
  await db
    .update(schema.users)
    .set({ deletedAt: null, updatedAt: now })
    .where(eq(schema.users.id, id));
  return findById(db, id);
}

export async function stats(db: Db) {
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);
  const startIso = startOfMonth.toISOString();

  const excludePlaceholders = and(
    isNull(schema.users.deletedAt),
    not(ilike(schema.users.email, sql`'%@placeholder.local'`)),
  );

  const [totalRow, activeRow, inactiveRow, newRow, byTypeRows] = await Promise.all([
    db.select({ n: count() }).from(schema.users).where(excludePlaceholders),
    db
      .select({ n: count() })
      .from(schema.users)
      .where(and(excludePlaceholders, eq(schema.users.isActive, true))),
    db
      .select({ n: count() })
      .from(schema.users)
      .where(and(excludePlaceholders, eq(schema.users.isActive, false))),
    db
      .select({ n: count() })
      .from(schema.users)
      .where(and(excludePlaceholders, sql`${schema.users.createdAt} >= ${startIso}`)),
    db
      .select({ employmentType: schema.users.employmentType, n: count() })
      .from(schema.users)
      .where(excludePlaceholders)
      .groupBy(schema.users.employmentType),
  ]);

  const byEmploymentType: Record<string, number> = {};
  for (const r of byTypeRows) {
    byEmploymentType[r.employmentType] = Number(r.n);
  }

  return {
    total: Number(totalRow[0]?.n ?? 0),
    active: Number(activeRow[0]?.n ?? 0),
    inactive: Number(inactiveRow[0]?.n ?? 0),
    newThisMonth: Number(newRow[0]?.n ?? 0),
    byEmploymentType,
  };
}

export async function formLookups(db: Db) {
  const [entities, roles, rolePermCounts, userCounts] = await Promise.all([
    db
      .select({
        id: schema.entities.id,
        name: schema.entities.name,
        code: schema.entities.code,
        country: schema.entities.country,
        currency: schema.entities.currency,
      })
      .from(schema.entities)
      .where(eq(schema.entities.isActive, true))
      .orderBy(asc(schema.entities.name)),
    db
      .select({
        id: schema.roles.id,
        name: schema.roles.name,
        description: schema.roles.description,
        isSystem: schema.roles.isSystem,
        createdAt: schema.roles.createdAt,
      })
      .from(schema.roles)
      .orderBy(asc(schema.roles.name)),
    db
      .select({
        roleId: schema.rolePermissions.roleId,
        permissionCode: schema.rolePermissions.permissionCode,
      })
      .from(schema.rolePermissions),
    db
      .select({ roleId: schema.userRoles.roleId, n: count() })
      .from(schema.userRoles)
      .groupBy(schema.userRoles.roleId),
  ]);

  const permByRole = new Map<string, string[]>();
  for (const r of rolePermCounts) {
    const list = permByRole.get(r.roleId) ?? [];
    list.push(r.permissionCode);
    permByRole.set(r.roleId, list);
  }
  const userCountByRole = new Map(userCounts.map((r) => [r.roleId, Number(r.n)]));

  return {
    entities,
    roles: roles.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      isSystem: r.isSystem,
      permissionCount: permByRole.get(r.id)?.length ?? 0,
      permissions: permByRole.get(r.id) ?? [],
      userCount: userCountByRole.get(r.id) ?? 0,
      createdAt: r.createdAt,
    })),
  };
}

export async function userHasPermission(db: Db, userId: string, permissionCode: string) {
  const canonical = normalizePermissionCode(permissionCode);
  const [row] = await db
    .select({ userId: schema.userRoles.userId })
    .from(schema.userRoles)
    .innerJoin(schema.roles, eq(schema.userRoles.roleId, schema.roles.id))
    .innerJoin(schema.rolePermissions, eq(schema.rolePermissions.roleId, schema.roles.id))
    .where(and(eq(schema.userRoles.userId, userId), eq(schema.rolePermissions.permissionCode, canonical)))
    .limit(1);
  return Boolean(row);
}

export async function rolesWithAdminManage(db: Db, roleIds: string[]) {
  if (roleIds.length === 0) return [];
  const canonical = normalizePermissionCode("admin:manage");
  const rows = await db
    .select({ roleId: schema.roles.id, roleName: schema.roles.name })
    .from(schema.roles)
    .innerJoin(schema.rolePermissions, eq(schema.rolePermissions.roleId, schema.roles.id))
    .where(and(inArray(schema.roles.id, roleIds), eq(schema.rolePermissions.permissionCode, canonical)));
  return rows.map((r) => ({ id: r.roleId, name: r.roleName }));
}

export async function replaceRoles(db: Db, userId: string, roleIds: string[], assignedBy?: string) {
  await db.delete(schema.userRoles).where(eq(schema.userRoles.userId, userId));
  if (roleIds.length > 0) {
    await db.insert(schema.userRoles).values(
      roleIds.map((roleId) => ({
        userId,
        roleId,
        assignedBy: assignedBy ?? null,
      })),
    );
  }
  const rows = await db
    .select({ id: schema.roles.id, name: schema.roles.name })
    .from(schema.userRoles)
    .innerJoin(schema.roles, eq(schema.userRoles.roleId, schema.roles.id))
    .where(eq(schema.userRoles.userId, userId));
  return rows.map((r) => ({ id: r.id, name: r.name }));
}
