import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db } from "@nexora/db";

type RecordInsert = Omit<typeof schema.attendanceRecords.$inferInsert, "id" | "createdAt" | "updatedAt">;
type AuditInsert = Omit<typeof schema.attendanceAuditLogs.$inferInsert, "id" | "createdAt">;
import { schema } from "@nexora/db";

const emp = alias(schema.users, "attendance_employee");

async function attachEmployee(
  db: Db,
  record: typeof schema.attendanceRecords.$inferSelect,
) {
  const [employee] = await db
    .select({
      id: schema.users.id,
      name: schema.users.name,
      email: schema.users.email,
      department: schema.users.department,
      employeeId: schema.users.employeeId,
      timezone: schema.users.timezone,
    })
    .from(schema.users)
    .where(eq(schema.users.id, record.employeeId))
    .limit(1);
  return { ...record, employee: employee ?? null };
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function findPolicyForEntity(db: Db, entityId: string | null | undefined) {
  if (entityId) {
    const [entityPolicy] = await db
      .select()
      .from(schema.attendancePolicies)
      .where(and(eq(schema.attendancePolicies.entityId, entityId), eq(schema.attendancePolicies.isActive, true)))
      .limit(1);
    if (entityPolicy) return entityPolicy;
  }
  const [globalPolicy] = await db
    .select()
    .from(schema.attendancePolicies)
    .where(and(isNull(schema.attendancePolicies.entityId), eq(schema.attendancePolicies.isActive, true)))
    .limit(1);
  return globalPolicy ?? null;
}

export async function findRecordById(db: Db, id: string) {
  const [row] = await db
    .select()
    .from(schema.attendanceRecords)
    .where(eq(schema.attendanceRecords.id, id))
    .limit(1);
  if (!row) return null;
  return attachEmployee(db, row);
}

export async function findRecordByEmployeeAndDate(db: Db, employeeId: string, attendanceDate: Date) {
  const dateStr = formatDate(attendanceDate);
  const [row] = await db
    .select()
    .from(schema.attendanceRecords)
    .where(and(eq(schema.attendanceRecords.employeeId, employeeId), eq(schema.attendanceRecords.attendanceDate, dateStr)))
    .limit(1);
  if (!row) return null;
  return attachEmployee(db, row);
}

export async function createRecord(db: Db, data: RecordInsert) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(schema.attendanceRecords).values({ ...data, id, createdAt: now, updatedAt: now });
  const created = await findRecordByEmployeeAndDate(db, data.employeeId, new Date(String(data.attendanceDate)));
  if (created) return created;
  const [row] = await db.select().from(schema.attendanceRecords).where(eq(schema.attendanceRecords.id, id)).limit(1);
  return row ? attachEmployee(db, row) : null;
}

export async function updateRecord(
  db: Db,
  id: string,
  data: Partial<typeof schema.attendanceRecords.$inferInsert>,
) {
  await db
    .update(schema.attendanceRecords)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(eq(schema.attendanceRecords.id, id));
  const [row] = await db.select().from(schema.attendanceRecords).where(eq(schema.attendanceRecords.id, id)).limit(1);
  return row ? attachEmployee(db, row) : null;
}

export async function findRecordsForDate(db: Db, attendanceDate: Date, employeeIds?: string[]) {
  const dateStr = formatDate(attendanceDate);
  const conditions = [eq(schema.attendanceRecords.attendanceDate, dateStr)];
  if (employeeIds?.length) conditions.push(inArray(schema.attendanceRecords.employeeId, employeeIds));

  const rows = await db
    .select({ record: schema.attendanceRecords, employee: emp })
    .from(schema.attendanceRecords)
    .leftJoin(emp, eq(schema.attendanceRecords.employeeId, emp.id))
    .where(and(...conditions))
    .orderBy(asc(emp.name));

  return rows.map((r) => ({ ...r.record, employee: r.employee }));
}

export async function findRecords(
  db: Db,
  filters: {
    employeeId?: string;
    from?: Date;
    to?: Date;
    status?: string;
    department?: string;
  },
  page: number,
  limit: number,
) {
  const conditions = [];
  if (filters.employeeId) conditions.push(eq(schema.attendanceRecords.employeeId, filters.employeeId));
  if (filters.status) conditions.push(eq(schema.attendanceRecords.status, filters.status));
  if (filters.from) conditions.push(gte(schema.attendanceRecords.attendanceDate, formatDate(filters.from)));
  if (filters.to) conditions.push(lte(schema.attendanceRecords.attendanceDate, formatDate(filters.to)));
  if (filters.department) conditions.push(eq(emp.department, filters.department));
  const whereClause = conditions.length ? and(...conditions) : undefined;

  const rows = await db
    .select({ record: schema.attendanceRecords, employee: emp })
    .from(schema.attendanceRecords)
    .leftJoin(emp, eq(schema.attendanceRecords.employeeId, emp.id))
    .where(whereClause)
    .orderBy(desc(schema.attendanceRecords.attendanceDate), asc(emp.name))
    .limit(limit)
    .offset((page - 1) * limit);

  const [totalRow] = await db
    .select({ total: count() })
    .from(schema.attendanceRecords)
    .leftJoin(emp, eq(schema.attendanceRecords.employeeId, emp.id))
    .where(whereClause);

  return {
    data: rows.map((r) => ({ ...r.record, employee: r.employee })),
    total: totalRow?.total ?? 0,
  };
}

export async function countActiveEmployees(db: Db, department?: string) {
  const conditions = [eq(schema.users.isActive, true)];
  if (department) conditions.push(eq(schema.users.department, department));
  const [row] = await db.select({ total: count() }).from(schema.users).where(and(...conditions));
  return row?.total ?? 0;
}

export async function findActiveEmployees(db: Db, department?: string) {
  const conditions = [eq(schema.users.isActive, true)];
  if (department) conditions.push(eq(schema.users.department, department));
  return db
    .select({
      id: schema.users.id,
      name: schema.users.name,
      email: schema.users.email,
      department: schema.users.department,
      employeeId: schema.users.employeeId,
      entityId: schema.users.entityId,
    })
    .from(schema.users)
    .where(and(...conditions))
    .orderBy(asc(schema.users.name));
}

export async function hasApprovedLeaveOnDate(db: Db, employeeId: string, date: Date) {
  const rows = await db.execute(sql`
    SELECT id FROM leave_requests
    WHERE employee_id = ${employeeId}::uuid
      AND status = 'approved'
      AND deleted_at IS NULL
      AND start_date <= ${formatDate(date)}::date
      AND end_date >= ${formatDate(date)}::date
    LIMIT 1
  `);
  return (Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? []).length > 0;
}

export async function findApprovedLeavesInRange(
  db: Db,
  employeeIds: string[],
  from: Date,
  to: Date,
): Promise<Array<{ employeeId: string; startDate: string; endDate: string }>> {
  if (!employeeIds.length) return [];
  const rows = await db.execute(sql`
    SELECT employee_id AS "employeeId", start_date AS "startDate", end_date AS "endDate"
    FROM leave_requests
    WHERE employee_id = ANY(${employeeIds}::uuid[])
      AND status = 'approved'
      AND deleted_at IS NULL
      AND start_date <= ${formatDate(to)}::date
      AND end_date >= ${formatDate(from)}::date
  `);
  return (Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? []) as Array<{ employeeId: string; startDate: string; endDate: string }>;
}


export async function findLastRecordWithCheckIn(db: Db, employeeId: string) {
  const rows = await db
    .select()
    .from(schema.attendanceRecords)
    .where(eq(schema.attendanceRecords.employeeId, employeeId))
    .orderBy(desc(schema.attendanceRecords.attendanceDate))
    .limit(20);
  const row = rows.find((r) => r.checkIn != null);
  if (!row) return null;
  return attachEmployee(db, row);
}

export async function createAuditLog(db: Db, data: AuditInsert) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await db.insert(schema.attendanceAuditLogs).values({ ...data, id, createdAt: now });
  const [row] = await db.select().from(schema.attendanceAuditLogs).where(eq(schema.attendanceAuditLogs.id, id)).limit(1);
  return row ?? null;
}

export async function aggregateMonthlyStats(
  db: Db,
  from: Date,
  to: Date,
  filters?: { employeeId?: string; department?: string },
) {
  const conditions = [
    gte(schema.attendanceRecords.attendanceDate, formatDate(from)),
    lte(schema.attendanceRecords.attendanceDate, formatDate(to)),
  ];
  if (filters?.employeeId) conditions.push(eq(schema.attendanceRecords.employeeId, filters.employeeId));
  if (filters?.department) conditions.push(eq(emp.department, filters.department));

  const rows = await db
    .select({
      status: schema.attendanceRecords.status,
      workMode: schema.attendanceRecords.workMode,
      total: count(),
    })
    .from(schema.attendanceRecords)
    .leftJoin(emp, eq(schema.attendanceRecords.employeeId, emp.id))
    .where(and(...conditions))
    .groupBy(schema.attendanceRecords.status, schema.attendanceRecords.workMode);

  return rows.map((r) => ({ status: r.status, workMode: r.workMode, _count: { _all: r.total } }));
}

export async function findRecordsInRange(
  db: Db,
  from: Date,
  to: Date,
  filters?: { employeeId?: string; employeeIds?: string[]; department?: string },
) {
  const conditions = [
    gte(schema.attendanceRecords.attendanceDate, formatDate(from)),
    lte(schema.attendanceRecords.attendanceDate, formatDate(to)),
  ];
  if (filters?.employeeId) conditions.push(eq(schema.attendanceRecords.employeeId, filters.employeeId));
  if (filters?.employeeIds?.length) conditions.push(inArray(schema.attendanceRecords.employeeId, filters.employeeIds));
  if (filters?.department) conditions.push(eq(emp.department, filters.department));

  const rows = await db
    .select({ record: schema.attendanceRecords, employee: emp })
    .from(schema.attendanceRecords)
    .leftJoin(emp, eq(schema.attendanceRecords.employeeId, emp.id))
    .where(and(...conditions))
    .orderBy(asc(schema.attendanceRecords.attendanceDate));

  return rows.map((r) => ({ ...r.record, employee: r.employee }));
}

export async function countLateInRange(
  db: Db,
  from: Date,
  to: Date,
  filters?: { employeeId?: string; department?: string },
) {
  const conditions = [
    gte(schema.attendanceRecords.attendanceDate, formatDate(from)),
    lte(schema.attendanceRecords.attendanceDate, formatDate(to)),
    eq(schema.attendanceRecords.status, "late"),
  ];
  if (filters?.employeeId) conditions.push(eq(schema.attendanceRecords.employeeId, filters.employeeId));
  if (filters?.department) conditions.push(eq(emp.department, filters.department));
  const [row] = await db
    .select({ total: count() })
    .from(schema.attendanceRecords)
    .leftJoin(emp, eq(schema.attendanceRecords.employeeId, emp.id))
    .where(and(...conditions));
  return row?.total ?? 0;
}

export async function countAbsentInRange(
  db: Db,
  from: Date,
  to: Date,
  filters?: { employeeId?: string; department?: string },
) {
  const conditions = [
    gte(schema.attendanceRecords.attendanceDate, formatDate(from)),
    lte(schema.attendanceRecords.attendanceDate, formatDate(to)),
    eq(schema.attendanceRecords.status, "absent"),
  ];
  if (filters?.employeeId) conditions.push(eq(schema.attendanceRecords.employeeId, filters.employeeId));
  if (filters?.department) conditions.push(eq(emp.department, filters.department));
  const [row] = await db
    .select({ total: count() })
    .from(schema.attendanceRecords)
    .leftJoin(emp, eq(schema.attendanceRecords.employeeId, emp.id))
    .where(and(...conditions));
  return row?.total ?? 0;
}

export async function groupByDepartmentForDate(db: Db, attendanceDate: Date) {
  const dateStr = formatDate(attendanceDate);
  const records = await findRecordsForDate(db, attendanceDate);
  const employees = await db
    .select({ id: schema.users.id, department: schema.users.department })
    .from(schema.users)
    .where(eq(schema.users.isActive, true));
  return { records, employees };
}
