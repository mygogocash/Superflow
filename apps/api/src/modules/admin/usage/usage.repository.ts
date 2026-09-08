import { Prisma } from "@nexora/database";

import { prisma } from "@/infrastructure/database/prisma";

/**
 * Storage rollups query both DB-tracked uploads and per-user file counts.
 * Each upload model carries `fileSize` (bytes) and an uploader FK; we union
 * them here, group by uploader, and let the service convert BigInt → number.
 *
 * Sources today:
 *   - file_uploads (general, every module that goes through the uploader)
 *   - employee_agreements (HR)
 *   - data_room_documents (investor data room)
 *
 * Expense receipts are intentionally excluded — `expenses.receipt_url` has no
 * stored fileSize column. Phase 2 either adds that column or pulls from the
 * Supabase storage admin API.
 */
export interface PerUserStorageRow {
  userId: string;
  name: string;
  email: string;
  totalBytes: bigint;
  fileCount: number;
  generalBytes: bigint;
  hrBytes: bigint;
  dataroomBytes: bigint;
  lastUploadAt: Date | null;
}

export interface WorkspaceStorageTotals {
  totalBytes: bigint;
  fileCount: number;
  filesAdded30d: number;
}

export interface BucketSnapshotRow {
  bucket: string;
  bytes: bigint;
  objectCount: number;
  capturedAt: Date;
}

/**
 * Per-user activity rollups read from `audit_log`. Every authenticated mutation
 * lands a row there with `(user_id, action, resource, timestamp)`, so it's a
 * decent first-pass activity feed without requiring PostHog. Phase 3 will
 * switch this to HogQL once event volume is stable.
 */
export interface PerUserActivityRow {
  userId: string;
  name: string;
  email: string;
  events30d: number;
  activeDays30d: number;
  leaveEvents30d: number;
  expenseEvents30d: number;
  ariaEvents30d: number;
  topAction: string | null;
  lastActiveAt: Date | null;
}

export const usageRepository = {
  async findPerUserStorage(params: {
    page: number;
    limit: number;
    search?: string;
  }): Promise<{ rows: PerUserStorageRow[]; total: number }> {
    const offset = (params.page - 1) * params.limit;
    const search = params.search?.trim();
    const searchPattern = search ? `%${search.toLowerCase()}%` : null;

    const totalResult = await prisma.$queryRaw<Array<{ total: bigint }>>(
      Prisma.sql`
        SELECT COUNT(*)::bigint AS total
        FROM users u
        WHERE u.is_active = true
          AND u.deleted_at IS NULL
          AND (
            ${searchPattern}::text IS NULL
            OR LOWER(u.name) LIKE ${searchPattern}
            OR LOWER(u.email) LIKE ${searchPattern}
          )
      `,
    );
    const total = Number(totalResult[0]?.total ?? 0n);

    const rows = await prisma.$queryRaw<
      Array<{
        user_id: string;
        name: string;
        email: string;
        total_bytes: bigint | null;
        file_count: bigint | null;
        general_bytes: bigint | null;
        hr_bytes: bigint | null;
        dataroom_bytes: bigint | null;
        last_upload_at: Date | null;
      }>
    >(Prisma.sql`
      WITH fu AS (
        SELECT uploaded_by AS uid,
               SUM(size)::bigint  AS bytes,
               COUNT(*)::bigint   AS cnt,
               MAX(created_at)    AS last_at
        FROM file_uploads
        WHERE deleted_at IS NULL
        GROUP BY uploaded_by
      ),
      ea AS (
        SELECT uploaded_by_id AS uid,
               SUM(file_size)::bigint AS bytes,
               COUNT(*)::bigint       AS cnt,
               MAX(created_at)        AS last_at
        FROM employee_agreements
        WHERE uploaded_by_id IS NOT NULL AND file_size IS NOT NULL
        GROUP BY uploaded_by_id
      ),
      drm AS (
        SELECT uploaded_by AS uid,
               SUM(file_size)::bigint AS bytes,
               COUNT(*)::bigint       AS cnt,
               MAX(uploaded_at)       AS last_at
        FROM data_room_documents
        WHERE file_size IS NOT NULL
        GROUP BY uploaded_by
      )
      SELECT
        u.id   AS user_id,
        u.name AS name,
        u.email AS email,
        (COALESCE(fu.bytes, 0) + COALESCE(ea.bytes, 0) + COALESCE(drm.bytes, 0))::bigint AS total_bytes,
        (COALESCE(fu.cnt,   0) + COALESCE(ea.cnt,   0) + COALESCE(drm.cnt,   0))::bigint AS file_count,
        COALESCE(fu.bytes,  0)::bigint AS general_bytes,
        COALESCE(ea.bytes,  0)::bigint AS hr_bytes,
        COALESCE(drm.bytes, 0)::bigint AS dataroom_bytes,
        GREATEST(fu.last_at, ea.last_at, drm.last_at) AS last_upload_at
      FROM users u
      LEFT JOIN fu  ON fu.uid  = u.id
      LEFT JOIN ea  ON ea.uid  = u.id
      LEFT JOIN drm ON drm.uid = u.id
      WHERE u.is_active = true
        AND u.deleted_at IS NULL
        AND (
          ${searchPattern}::text IS NULL
          OR LOWER(u.name) LIKE ${searchPattern}
          OR LOWER(u.email) LIKE ${searchPattern}
        )
      ORDER BY total_bytes DESC NULLS LAST, u.name ASC
      LIMIT ${params.limit} OFFSET ${offset}
    `);

    return {
      rows: rows.map((r) => ({
        userId: r.user_id,
        name: r.name,
        email: r.email,
        totalBytes: r.total_bytes ?? 0n,
        fileCount: Number(r.file_count ?? 0n),
        generalBytes: r.general_bytes ?? 0n,
        hrBytes: r.hr_bytes ?? 0n,
        dataroomBytes: r.dataroom_bytes ?? 0n,
        lastUploadAt: r.last_upload_at,
      })),
      total,
    };
  },

  async findPerUserActivity(params: {
    page: number;
    limit: number;
    search?: string;
  }): Promise<{ rows: PerUserActivityRow[]; total: number }> {
    const offset = (params.page - 1) * params.limit;
    const search = params.search?.trim();
    const searchPattern = search ? `%${search.toLowerCase()}%` : null;

    const totalResult = await prisma.$queryRaw<Array<{ total: bigint }>>(
      Prisma.sql`
        SELECT COUNT(*)::bigint AS total
        FROM users u
        WHERE u.is_active = true
          AND u.deleted_at IS NULL
          AND (
            ${searchPattern}::text IS NULL
            OR LOWER(u.name) LIKE ${searchPattern}
            OR LOWER(u.email) LIKE ${searchPattern}
          )
      `,
    );
    const total = Number(totalResult[0]?.total ?? 0n);

    const rows = await prisma.$queryRaw<
      Array<{
        user_id: string;
        name: string;
        email: string;
        events_30d: bigint | null;
        active_days_30d: bigint | null;
        leave_events_30d: bigint | null;
        expense_events_30d: bigint | null;
        aria_events_30d: bigint | null;
        top_action: string | null;
        last_active_at: Date | null;
      }>
    >(Prisma.sql`
      SELECT
        u.id    AS user_id,
        u.name  AS name,
        u.email AS email,
        COUNT(al.id)::bigint                                                AS events_30d,
        COUNT(DISTINCT DATE(al.timestamp))::bigint                          AS active_days_30d,
        COUNT(*) FILTER (WHERE al.resource = 'leave')::bigint               AS leave_events_30d,
        COUNT(*) FILTER (WHERE al.resource IN ('expense', 'expense-report'))::bigint
                                                                            AS expense_events_30d,
        COUNT(*) FILTER (WHERE al.resource LIKE 'aria%')::bigint            AS aria_events_30d,
        MAX(al.timestamp)                                                   AS last_active_at,
        ta.action                                                           AS top_action
      FROM users u
      LEFT JOIN audit_log al
        ON al.user_id = u.id
       AND al.timestamp > NOW() - INTERVAL '30 days'
      LEFT JOIN LATERAL (
        SELECT al2.action
        FROM audit_log al2
        WHERE al2.user_id = u.id
          AND al2.timestamp > NOW() - INTERVAL '30 days'
        GROUP BY al2.action
        ORDER BY COUNT(*) DESC
        LIMIT 1
      ) ta ON TRUE
      WHERE u.is_active = true
        AND u.deleted_at IS NULL
        AND (
          ${searchPattern}::text IS NULL
          OR LOWER(u.name) LIKE ${searchPattern}
          OR LOWER(u.email) LIKE ${searchPattern}
        )
      GROUP BY u.id, u.name, u.email, ta.action
      ORDER BY events_30d DESC NULLS LAST, u.name ASC
      LIMIT ${params.limit} OFFSET ${offset}
    `);

    return {
      rows: rows.map((r) => ({
        userId: r.user_id,
        name: r.name,
        email: r.email,
        events30d: Number(r.events_30d ?? 0n),
        activeDays30d: Number(r.active_days_30d ?? 0n),
        leaveEvents30d: Number(r.leave_events_30d ?? 0n),
        expenseEvents30d: Number(r.expense_events_30d ?? 0n),
        ariaEvents30d: Number(r.aria_events_30d ?? 0n),
        topAction: r.top_action,
        lastActiveAt: r.last_active_at,
      })),
      total,
    };
  },

  async findLatestBucketSnapshots(): Promise<BucketSnapshotRow[]> {
    const rows = await prisma.$queryRaw<
      Array<{
        bucket: string;
        bytes: bigint;
        object_count: number;
        captured_at: Date;
      }>
    >(Prisma.sql`
      SELECT DISTINCT ON (bucket)
        bucket, bytes, object_count, captured_at
      FROM storage_snapshots
      ORDER BY bucket, captured_at DESC
    `);
    return rows.map((r) => ({
      bucket: r.bucket,
      bytes: r.bytes,
      objectCount: r.object_count,
      capturedAt: r.captured_at,
    }));
  },

  async findWorkspaceStorageTotals(): Promise<WorkspaceStorageTotals> {
    const rows = await prisma.$queryRaw<
      Array<{
        total_bytes: bigint | null;
        file_count: bigint | null;
        files_30d: bigint | null;
      }>
    >(Prisma.sql`
      WITH all_uploads AS (
        SELECT size::bigint AS bytes, created_at FROM file_uploads WHERE deleted_at IS NULL
        UNION ALL
        SELECT file_size::bigint, created_at FROM employee_agreements WHERE file_size IS NOT NULL
        UNION ALL
        SELECT file_size::bigint, uploaded_at FROM data_room_documents WHERE file_size IS NOT NULL
      )
      SELECT
        COALESCE(SUM(bytes), 0)::bigint AS total_bytes,
        COUNT(*)::bigint                AS file_count,
        COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days')::bigint AS files_30d
      FROM all_uploads
    `);

    const r = rows[0];
    return {
      totalBytes: r?.total_bytes ?? 0n,
      fileCount: Number(r?.file_count ?? 0n),
      filesAdded30d: Number(r?.files_30d ?? 0n),
    };
  },
};
