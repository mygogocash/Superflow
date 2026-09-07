import { Router } from "express";
import multer from "multer";
import * as XLSX from "xlsx";

import { PERMISSIONS } from "@/common/constants/permissions";
import { logger } from "@/common/utils/logger";
import { getRequiredParam } from "@/common/utils/params";
import {
  authenticate,
  requireActive,
  requirePermission,
} from "@/core/guards/auth.guard";
import { asyncHandler } from "@/core/middleware/async-handler";
import { logAudit } from "@/infrastructure/audit/audit.service";
import {
  type BulkImportRow,
  usersService,
} from "@/modules/users/users.service";
import {
  addMembershipSchema,
  assignRolesSchema,
  createUserSchema,
  listUsersQuerySchema,
  resetPasswordSchema,
  updateUserSchema,
} from "@/modules/users/users.validation";

const router = Router();

router.use(authenticate, requireActive);

const csvUpload = multer({
  storage: multer.memoryStorage(),
  // 5 MB cap is plenty for an employee roster — well above any realistic
  // headcount, well below anything that'd OOM the API container.
  limits: { fileSize: 5 * 1024 * 1024 },
});

// PRD addendum — the bulk-import template lists every column the
// importer accepts in the order it expects them. Optional columns are
// noted in the description row at the top of the sheet rendered by the
// template-download endpoint.
const IMPORT_COLUMNS = [
  "email",
  "name",
  "phone",
  "entityCode",
  "department",
  "jobTitle",
  "employeeId",
  "employmentType",
  "startDate",
  "dateOfBirth",
  "location",
  "country",
] as const;

type ImportColumn = (typeof IMPORT_COLUMNS)[number];

router.get(
  "/",
  requirePermission(PERMISSIONS.USER_READ),
  asyncHandler(async (req, res) => {
    const query = listUsersQuerySchema.parse(req.query);
    const result = await usersService.list(query, req.user!.id);
    res.json(result);
  }),
);

router.get(
  "/stats",
  requirePermission(PERMISSIONS.USER_READ),
  asyncHandler(async (_req, res) => {
    const result = await usersService.stats();
    res.json(result);
  }),
);

// "Never-activated" cohort — active Prisma users with no Supabase
// last_sign_in_at. Admin uses this to preview before triggering
// bulk invite emails.
router.get(
  "/unactivated",
  requirePermission(PERMISSIONS.USER_UPDATE),
  asyncHandler(async (_req, res) => {
    const result = await usersService.listUnactivated();
    res.json(result);
  }),
);

router.post(
  "/resend-invites",
  requirePermission(PERMISSIONS.USER_UPDATE),
  asyncHandler(async (req, res) => {
    const body = req.body as { userIds?: unknown };
    const userIds = Array.isArray(body.userIds)
      ? (body.userIds as unknown[]).filter(
          (v): v is string => typeof v === "string",
        )
      : [];
    const result = await usersService.resendInvites(userIds, req.user!.id);
    void logAudit({
      action: "resend-invite",
      resource: "user",
      details: { count: userIds.length, sent: result.data.sent },
      req,
    });
    res.json(result);
  }),
);

router.get(
  "/form-lookups",
  requirePermission(PERMISSIONS.USER_READ),
  asyncHandler(async (_req, res) => {
    const result = await usersService.getFormLookups();
    res.json(result);
  }),
);

router.post(
  "/",
  requirePermission(PERMISSIONS.USER_CREATE),
  asyncHandler(async (req, res) => {
    const input = createUserSchema.parse(req.body);
    const result = await usersService.create(input, req.user!.id);
    logger.info(`User created: ${input.email} by ${req.user!.email}`);
    void logAudit({
      action: "create",
      resource: "user",
      resourceId: result.data.id,
      details: { email: input.email, name: input.name },
      req,
    });
    res.status(201).json(result);
  }),
);

// ─── Bulk import (CSV / XLSX) ────────────────────────────
//
// Literal-path routes MUST come before `/:id` — Express matches in
// declaration order. Earlier we placed these at the bottom, which made
// `/import-template` resolve as `/:id` and 404 with "User not found".

router.get(
  "/import-template",
  requirePermission(PERMISSIONS.USER_CREATE),
  asyncHandler(async (req, res) => {
    // One-row sample so admins see the expected shape without opening
    // a separate doc.
    const sample = {
      email: "jane.doe@manut.xyz",
      name: "Jane Doe",
      phone: "+971 50 000 0000",
      entityCode: "AE",
      department: "Marketing",
      jobTitle: "Content Lead",
      employeeId: "TBH-100",
      employmentType: "full_time",
      startDate: "2026-05-07",
      dateOfBirth: "1998-10-31",
      location: "Dubai",
      country: "UAE",
    };

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet([sample], {
      header: IMPORT_COLUMNS as unknown as string[],
    });
    XLSX.utils.book_append_sheet(wb, ws, "Employees");

    const format = (req.query.format as string) ?? "xlsx";
    if (format === "csv") {
      const csv = XLSX.utils.sheet_to_csv(ws);
      res
        .header(
          "Content-Disposition",
          'attachment; filename="employees-import-template.csv"',
        )
        .header("Content-Type", "text/csv; charset=utf-8")
        .send(csv);
      return;
    }

    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    res
      .header(
        "Content-Disposition",
        'attachment; filename="employees-import-template.xlsx"',
      )
      .header(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      )
      .send(buf);
  }),
);

router.post(
  "/bulk-import",
  requirePermission(PERMISSIONS.USER_CREATE),
  csvUpload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      res.status(400).json({
        error: 'No file uploaded. Send multipart/form-data with field "file".',
      });
      return;
    }

    const wb = XLSX.read(req.file.buffer, { type: "buffer" });
    const firstSheet = wb.SheetNames[0];
    if (!firstSheet) {
      res.status(400).json({ error: "Workbook has no sheets" });
      return;
    }
    const sheet = wb.Sheets[firstSheet]!;
    const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
      defval: "",
      raw: false,
    });

    const rows: BulkImportRow[] = raw
      .map((row) => {
        const get = (key: ImportColumn): string | undefined => {
          const v = row[key];
          if (v === undefined || v === null) return undefined;
          const s = String(v).trim();
          return s.length > 0 ? s : undefined;
        };
        return {
          email: get("email") ?? "",
          name: get("name") ?? "",
          phone: get("phone"),
          entityCode: get("entityCode"),
          department: get("department"),
          jobTitle: get("jobTitle"),
          employeeId: get("employeeId"),
          employmentType: get("employmentType"),
          startDate: get("startDate"),
          dateOfBirth: get("dateOfBirth"),
          location: get("location"),
          country: get("country"),
        };
      })
      .filter((r) => r.email && r.name);

    if (rows.length === 0) {
      res.status(400).json({
        error:
          "No usable rows found. Make sure the file has email + name columns and at least one data row.",
      });
      return;
    }

    const result = await usersService.bulkImport(rows, req.user!.id);
    logger.info(
      `Bulk-imported employees: ${result.successCount} ok, ${result.failureCount} failed by ${req.user!.email}`,
    );
    void logAudit({
      action: "bulk_import",
      resource: "user",
      details: {
        successCount: result.successCount,
        failureCount: result.failureCount,
      },
      req,
    });
    res.json({ data: result });
  }),
);

router.get(
  "/:id",
  requirePermission(PERMISSIONS.USER_READ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const result = await usersService.getById(id);
    res.json(result);
  }),
);

router.put(
  "/:id",
  requirePermission(PERMISSIONS.USER_UPDATE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = updateUserSchema.parse(req.body);
    const result = await usersService.update(id, input, req.user!.id);
    logger.info(`User updated: ${id} by ${req.user!.email}`);
    void logAudit({
      action: "update",
      resource: "user",
      resourceId: id,
      req,
    });
    res.json(result);
  }),
);

router.delete(
  "/:id",
  requirePermission(PERMISSIONS.USER_DELETE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const result = await usersService.remove(id, req.user!.id);
    logger.info(`User deleted: ${id} by ${req.user!.email}`);
    void logAudit({
      action: "delete",
      resource: "user",
      resourceId: id,
      req,
    });
    res.json(result);
  }),
);

router.post(
  "/:id/reset-password",
  requirePermission(PERMISSIONS.USER_UPDATE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = resetPasswordSchema.parse(req.body);
    const result = await usersService.resetPassword(id, input, req.user!.id);
    logger.info(`Password reset for user: ${id} by ${req.user!.email}`);
    void logAudit({
      action: "reset-password",
      resource: "user",
      resourceId: id,
      req,
    });
    res.json(result);
  }),
);

router.put(
  "/:id/roles",
  requirePermission(PERMISSIONS.USER_ASSIGN_ROLE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = assignRolesSchema.parse(req.body);
    const result = await usersService.assignRoles(id, input, req.user!.id);
    logger.info(`Roles assigned to user: ${id} by ${req.user!.email}`);
    void logAudit({
      action: "assign-roles",
      resource: "user",
      resourceId: id,
      details: { roleIds: input.roleIds },
      req,
    });
    res.json(result);
  }),
);

// ── Multi-company memberships (PRD Rule 7, admin surface) ──────────────
// Manage which entities a user belongs to + the stored per-company role.
// Read gated on USER_READ, writes on USER_UPDATE (existing user-management
// perms). These are stored now and ENFORCED in a later chunk — nothing
// here affects permission resolution or login.
router.get(
  "/:id/memberships",
  requirePermission(PERMISSIONS.USER_READ),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const result = await usersService.listMemberships(id);
    res.json(result);
  }),
);

router.post(
  "/:id/memberships",
  requirePermission(PERMISSIONS.USER_UPDATE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const input = addMembershipSchema.parse(req.body);
    const result = await usersService.addMembership(
      id,
      input.entityId,
      input.roleId,
    );
    void logAudit({
      action: "add-membership",
      resource: "user",
      resourceId: id,
      details: { entityId: input.entityId, roleId: input.roleId ?? null },
      req,
    });
    res.status(201).json(result);
  }),
);

router.delete(
  "/:id/memberships/:entityId",
  requirePermission(PERMISSIONS.USER_UPDATE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const entityId = getRequiredParam(req.params, "entityId");
    const result = await usersService.removeMembership(id, entityId);
    void logAudit({
      action: "remove-membership",
      resource: "user",
      resourceId: id,
      details: { entityId },
      req,
    });
    res.json(result);
  }),
);

router.post(
  "/:id/restore",
  requirePermission(PERMISSIONS.USER_DELETE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const result = await usersService.restore(id, req.user!.id);
    logger.info(`User restored: ${id} by ${req.user!.email}`);
    void logAudit({
      action: "restore",
      resource: "user",
      resourceId: id,
      req,
    });
    res.json(result);
  }),
);

router.delete(
  "/:id/permanent",
  requirePermission(PERMISSIONS.USER_DELETE),
  asyncHandler(async (req, res) => {
    const id = getRequiredParam(req.params, "id");
    const result = await usersService.permanentDelete(id, req.user!.id);
    logger.info(`User permanently deleted: ${id} by ${req.user!.email}`);
    void logAudit({
      action: "permanent-delete",
      resource: "user",
      resourceId: id,
      req,
    });
    res.json(result);
  }),
);

export default router;
