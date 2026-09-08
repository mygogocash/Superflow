import type { Prisma } from "@nexora/database";

import { PERMISSIONS } from "@/common/constants/permissions";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@/common/exceptions/http-exception";
import { isValidEmail } from "@/common/utils/email";
import { logger } from "@/common/utils/logger";
import { prisma } from "@/infrastructure/database/prisma";
import { sendEmail } from "@/infrastructure/email/email.service";
import { visaExpiryReminderEmail } from "@/infrastructure/email/templates";
import {
  createSignedUrl,
  downloadToBuffer,
  parseStorageUrl,
} from "@/infrastructure/storage/supabase-storage";
import { actorFromId, trackVisaRequestSubmittedServer } from "@/lib/events";
import { PORTAL_URL } from "@/lib/portal-url";
import { ariaDocumentParseService } from "@/modules/aria/aria-document-parse.service";
import { visaRepository } from "@/modules/visa/visa.repository";
import type {
  CreateVisaInput,
  ParseScanInput,
  UpdateVisaInput,
  VisaQuery,
} from "@/modules/visa/visa.validation";
import { visaChecklistService } from "@/modules/visa-checklist/visa-checklist.service";

// Milestone buckets HR asked for (May 2026): re-ping the employee at
// 3 months, 2 months, 1 month, 2 weeks, and 1 week before expiry. The
// cron fires once daily; a record only re-sends when its days-left
// crosses into a closer bucket than the one last stamped on the row.
// Defaults below; admin can override via SystemSetting (see
// `visa.notification_lead_days`).
const DEFAULT_REMINDER_MILESTONES_DAYS = [90, 60, 30, 14, 7] as const;

const VISA_RECIPIENTS_KEY = "visa.notification_recipients";
const VISA_LEAD_DAYS_KEY = "visa.notification_lead_days";
const VISA_NOTIFY_EMPLOYEE_KEY = "visa.notify_employee";

async function loadVisaNotificationRecipients(): Promise<string[]> {
  const row = await prisma.systemSetting.findUnique({
    where: { key: VISA_RECIPIENTS_KEY },
  });
  if (!row) return [];
  const value = row.value;
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  return [];
}

// Whether the cron should mail the visa holder (employee or sponsor for
// dependent rows). Default true to match pre-#447 behaviour. HR can
// flip this off when they want a HR-only digest — e.g. for sensitive
// expat cases where the employee shouldn't see milestone pings.
async function loadVisaNotifyEmployee(): Promise<boolean> {
  const row = await prisma.systemSetting.findUnique({
    where: { key: VISA_NOTIFY_EMPLOYEE_KEY },
  });
  if (!row) return true;
  if (typeof row.value === "boolean") return row.value;
  return true;
}

async function loadVisaNotificationLeadDays(): Promise<number[]> {
  const row = await prisma.systemSetting.findUnique({
    where: { key: VISA_LEAD_DAYS_KEY },
  });
  if (!row) return [...DEFAULT_REMINDER_MILESTONES_DAYS];
  const value = row.value;
  if (Array.isArray(value)) {
    const cleaned = value
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n) && n > 0)
      .map((n) => Math.floor(n));
    if (cleaned.length === 0) return [...DEFAULT_REMINDER_MILESTONES_DAYS];
    return Array.from(new Set(cleaned)).sort((a, b) => b - a);
  }
  return [...DEFAULT_REMINDER_MILESTONES_DAYS];
}

function makeCurrentMilestone(milestones: readonly number[]) {
  return (daysLeft: number): number | null => {
    if (daysLeft < 0) return null;
    let bucket: number | null = null;
    for (const m of milestones) {
      if (daysLeft <= m && (bucket === null || m < bucket)) bucket = m;
    }
    return bucket;
  };
}

function daysUntil(target: Date, today = new Date()): number {
  const startOfToday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  );
  const startOfTarget = new Date(
    target.getFullYear(),
    target.getMonth(),
    target.getDate(),
  );
  const ms = startOfTarget.getTime() - startOfToday.getTime();
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pickString(row: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (s.length > 0) return s;
  }
  return "";
}

function normaliseName(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

// Excel cells with `cellDates: true` come back as Date objects; with
// `raw: false` they come back as locale-formatted strings. Accept both
// plus plain ISO strings.
function pickDate(
  row: Record<string, unknown>,
  ...keys: string[]
): { iso: string; raw: string } | null {
  for (const k of keys) {
    const v = row[k];
    if (v === null || v === undefined || v === "") continue;
    if (v instanceof Date && !isNaN(v.getTime())) {
      return { iso: v.toISOString(), raw: v.toISOString().slice(0, 10) };
    }
    const raw = String(v).trim();
    if (!raw) continue;
    const d = new Date(raw);
    if (!isNaN(d.getTime())) {
      return { iso: d.toISOString(), raw };
    }
    // Fall back to dd/mm/yyyy or dd-mm-yyyy parsing — Excel locales often
    // emit one of these and `new Date()` interprets ambiguously.
    const m = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
    if (m) {
      const [, dd, mm, yyyy] = m;
      const year = yyyy!.length === 2 ? `20${yyyy}` : yyyy;
      const iso = `${year}-${mm!.padStart(2, "0")}-${dd!.padStart(2, "0")}`;
      const parsed = new Date(iso);
      if (!isNaN(parsed.getTime())) return { iso: parsed.toISOString(), raw };
    }
    return null;
  }
  return null;
}

interface ParsedRow {
  rowNumber: number;
  employeeIdRaw: string;
  employeeEmail: string;
  employeeName: string;
  employeeCode: string;
  visaType: string;
  country: string;
  expiryDateIso: string;
  issueDateIso: string | null;
  status: string;
  notes: string;
}

interface ResolvedRow extends ParsedRow {
  employeeId: string;
}

// Best-effort MIME from a storage path extension, used only as a fallback
// when Supabase doesn't report a content type. Unknown → octet-stream so the
// parser's allow-list rejects it with a clear message.
function mimeFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    pdf: "application/pdf",
  };
  return map[ext] ?? "application/octet-stream";
}

type VisaRecordRow = NonNullable<
  Awaited<ReturnType<typeof visaRepository.findById>>
>;

function dayIso(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

// Diff an existing visa record against an update payload and produce one
// timeline entry per meaningful change. Only fields the user can edit that
// matter for an audit trail are tracked (status, the three lifecycle dates,
// notes, document attachments).
function buildDiffEvents(
  visaRecordId: string,
  actorId: string | undefined,
  existing: VisaRecordRow,
  input: UpdateVisaInput,
): Prisma.VisaEventLogCreateManyInput[] {
  const events: Prisma.VisaEventLogCreateManyInput[] = [];
  const base = { visaRecordId, actorId: actorId ?? null, actorType: "user" };

  if (input.status !== undefined && input.status !== existing.status) {
    events.push({
      ...base,
      kind: "status_change",
      field: "status",
      oldValue: existing.status,
      newValue: input.status,
    });
  }

  const dateFields: Array<{
    key: "expiryDate" | "issueDate" | "workPermitExpiryDate";
    kind: string;
    current: Date | null;
  }> = [
    { key: "expiryDate", kind: "expiry_updated", current: existing.expiryDate },
    { key: "issueDate", kind: "issue_updated", current: existing.issueDate },
    {
      key: "workPermitExpiryDate",
      kind: "work_permit_updated",
      current: existing.workPermitExpiryDate,
    },
  ];
  for (const f of dateFields) {
    const next = input[f.key];
    if (next === undefined) continue;
    const oldIso = dayIso(f.current);
    const newIso = next || null;
    if (oldIso !== newIso) {
      events.push({
        ...base,
        kind: f.kind,
        field: f.key,
        oldValue: oldIso,
        newValue: newIso,
      });
    }
  }

  if (
    input.notes !== undefined &&
    (input.notes || "") !== (existing.notes || "")
  ) {
    events.push({ ...base, kind: "note_added", field: "notes" });
  }

  if (input.documents !== undefined) {
    const oldLen = Array.isArray(existing.documents)
      ? existing.documents.length
      : 0;
    const newLen = Array.isArray(input.documents) ? input.documents.length : 0;
    if (newLen > oldLen) {
      events.push({
        ...base,
        kind: "document_added",
        field: "documents",
        oldValue: String(oldLen),
        newValue: String(newLen),
      });
    }
  }

  return events;
}

export class VisaService {
  async list(userId: string, userPermissions: string[], query: VisaQuery) {
    const { page, limit, ...filters } = query;
    const hasHrRead = userPermissions.includes(PERMISSIONS.VISA_HR_READ);

    if (!hasHrRead) {
      filters.employeeId = userId;
    }

    const { data, total } = await visaRepository.findMany(filters, page, limit);
    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async getById(id: string, actorId?: string, actorPermissions?: string[]) {
    const record = await visaRepository.findById(id);
    if (!record) throw new NotFoundException("Visa record not found");
    if (actorId && actorPermissions) {
      const hasHrRead =
        actorPermissions.includes(PERMISSIONS.VISA_HR_READ) ||
        actorPermissions.includes(PERMISSIONS.VISA_MANAGE);
      if (!hasHrRead && record.employeeId !== actorId) {
        throw new ForbiddenException("You can only view your own visa record");
      }
    }
    return record;
  }

  // The `documents` Supabase bucket is private, so the URLs stored on
  // `documentUrl` / `documents[].url` return 404 when fetched directly.
  // Mint a short-lived signed URL on demand. `docIndex` picks an item
  // from the `documents` array; omit it to fall back to the legacy
  // `documentUrl` column.
  async getDocumentDownloadUrl(
    id: string,
    actorId: string,
    actorPermissions: string[],
    docIndex?: number,
  ) {
    const record = await this.getById(id, actorId, actorPermissions);
    const docs = Array.isArray(record.documents)
      ? (record.documents as Array<{
          name?: string;
          url?: string;
          category?: string;
        }>)
      : [];
    let target: { name: string; url: string; category?: string } | null = null;
    if (typeof docIndex === "number") {
      const item = docs[docIndex];
      if (!item || !item.url) {
        throw new NotFoundException("Document not found on this record");
      }
      target = {
        name: item.name ?? "document",
        url: item.url,
        category: item.category,
      };
    } else if (record.documentUrl) {
      target = { name: "document", url: record.documentUrl };
    } else {
      throw new NotFoundException("No document attached");
    }

    const parsed = parseStorageUrl(target.url);
    if (!parsed) {
      // Externally-hosted URL — return as-is.
      return { url: target.url, name: target.name };
    }
    const signed = await createSignedUrl(parsed.bucket, parsed.path, 300);
    return { url: signed, name: target.name };
  }

  async create(input: CreateVisaInput, actorId?: string) {
    // For employee-type rows the holder fields stay null; the FE's
    // existing path always sends `holderType = "employee"` so legacy
    // submits keep working untouched.
    const isDependent = input.holderType === "dependent";
    const created = await visaRepository.create({
      employeeId: input.employeeId,
      holderType: input.holderType ?? "employee",
      holderName: isDependent ? (input.holderName ?? null) : null,
      holderRelationship: isDependent
        ? (input.holderRelationship ?? null)
        : null,
      visaType: input.visaType,
      country: input.country,
      nationality: input.nationality,
      issueDate: input.issueDate ? new Date(input.issueDate) : undefined,
      expiryDate: new Date(input.expiryDate),
      workPermitNumber: input.workPermitNumber,
      workPermitIssueDate: input.workPermitIssueDate
        ? new Date(input.workPermitIssueDate)
        : undefined,
      workPermitExpiryDate: input.workPermitExpiryDate
        ? new Date(input.workPermitExpiryDate)
        : undefined,
      status: input.status,
      documentUrl: input.documentUrl || undefined,
      documents: input.documents ?? [],
      notes: input.notes,
      entityId: input.entityId,
    });

    try {
      const trackingActor = await actorFromId(actorId);
      if (trackingActor) {
        trackVisaRequestSubmittedServer(trackingActor, {
          visa_type: input.visaType,
        });
      }
    } catch {
      // analytics is best-effort
    }

    // Seed the timeline with a creation entry (best-effort).
    try {
      await visaRepository.createEventLogs([
        {
          visaRecordId: created.id,
          actorId: actorId ?? null,
          actorType: actorId ? "user" : "system",
          kind: "created",
          field: null,
          oldValue: null,
          newValue: input.status ?? "active",
        },
      ]);
    } catch (err) {
      logger.warn("visa create event log failed", {
        err: err instanceof Error ? err.message : String(err),
        visaRecordId: created.id,
      });
    }

    // Instantiate the matching checklist template (best-effort — never blocks
    // record creation; no-op when no template matches the visa type).
    await visaChecklistService.hydrateChecklist(
      created.id,
      created.visaType,
      created.country,
    );

    return created;
  }

  async update(id: string, input: UpdateVisaInput, actorId?: string) {
    const existing = await this.getById(id);
    const statusChanged =
      input.status !== undefined && input.status !== existing.status;
    const updated = await visaRepository.update(id, {
      // Stamp the transition moment only when status actually changes, never
      // on an unrelated field edit.
      ...(statusChanged && { statusChangedAt: new Date() }),
      ...(input.visaType !== undefined && { visaType: input.visaType }),
      ...(input.country !== undefined && { country: input.country }),
      ...(input.nationality !== undefined && {
        nationality: input.nationality || null,
      }),
      ...(input.issueDate !== undefined && {
        issueDate: input.issueDate ? new Date(input.issueDate) : null,
      }),
      ...(input.expiryDate !== undefined && {
        expiryDate: new Date(input.expiryDate),
      }),
      ...(input.workPermitNumber !== undefined && {
        workPermitNumber: input.workPermitNumber || null,
      }),
      ...(input.workPermitIssueDate !== undefined && {
        workPermitIssueDate: input.workPermitIssueDate
          ? new Date(input.workPermitIssueDate)
          : null,
      }),
      ...(input.workPermitExpiryDate !== undefined && {
        workPermitExpiryDate: input.workPermitExpiryDate
          ? new Date(input.workPermitExpiryDate)
          : null,
      }),
      ...(input.status !== undefined && { status: input.status }),
      ...(input.holderType !== undefined && { holderType: input.holderType }),
      // Holder name / relationship are only meaningful for dependent
      // rows. Switching back to employee-type wipes them, switching
      // to dependent persists whatever HR typed.
      ...(input.holderType === "employee" && {
        holderName: null,
        holderRelationship: null,
      }),
      ...(input.holderType === "dependent" &&
        input.holderName !== undefined && {
          holderName: input.holderName || null,
        }),
      ...(input.holderType === "dependent" &&
        input.holderRelationship !== undefined && {
          holderRelationship: input.holderRelationship || null,
        }),
      ...(input.documentUrl !== undefined && {
        documentUrl: input.documentUrl || null,
      }),
      ...(input.documents !== undefined && {
        documents: input.documents,
      }),
      ...(input.notes !== undefined && { notes: input.notes }),
      ...(input.entityId !== undefined && { entityId: input.entityId }),
    });

    // Best-effort timeline log — never block the update if logging fails.
    try {
      await visaRepository.createEventLogs(
        buildDiffEvents(id, actorId, existing, input),
      );
    } catch (err) {
      logger.warn("visa event log failed", {
        err: err instanceof Error ? err.message : String(err),
        visaRecordId: id,
      });
    }

    return updated;
  }

  // Per-record chronological event log. Route is gated on visa:manage, so a
  // record-existence check is all that's needed here.
  async getTimeline(id: string) {
    await this.getById(id);
    return visaRepository.listEventLogs(id);
  }

  async delete(id: string) {
    await this.getById(id);
    return visaRepository.softDelete(id);
  }

  async restore(id: string) {
    const existing = await visaRepository.findById(id);
    if (!existing) {
      const restored = await visaRepository.restore(id);
      return restored;
    }
    throw new ConflictException("Record is not deleted");
  }

  async permanentDelete(id: string) {
    await this.getById(id);
    return visaRepository.permanentDelete(id);
  }

  // OCR autofill — download a just-uploaded visa/passport scan from the
  // private bucket (service-role key, server-side only) and run Gemini
  // vision to extract structured fields. The caller already has the stored
  // URL from the upload response; we never trust client-supplied bytes.
  async parseDocumentScan(input: ParseScanInput) {
    const parsed = parseStorageUrl(input.fileUrl);
    if (!parsed) {
      throw new BadRequestException(
        "Document must be an uploaded file before it can be scanned.",
      );
    }
    const { buffer, contentType } = await downloadToBuffer(
      parsed.bucket,
      parsed.path,
    );
    // Prefer the storage-reported MIME; fall back to the file extension.
    const mime = contentType || mimeFromPath(parsed.path);
    return ariaDocumentParseService.parseVisaDocument(buffer, mime);
  }

  async previewImport(rows: Array<Record<string, unknown>>) {
    const errors: Array<{ row: number; message: string }> = [];
    const parsed: ParsedRow[] = [];

    for (let i = 0; i < rows.length; i++) {
      const rowNumber = i + 1;
      const row = rows[i]!;

      const employeeIdRaw = pickString(
        row,
        "employeeId",
        "employee_id",
        "Employee ID",
        "Employee Id",
      );
      const employeeEmail = pickString(
        row,
        "employeeEmail",
        "Email",
        "email",
      ).toLowerCase();
      const employeeName = pickString(
        row,
        "employeeName",
        "Employee Name",
        "Name",
        "name",
      );
      // employeeIdRaw may be either a UUID or the User.employeeId code
      // (e.g. "MNT-001"). Treat anything non-UUID as a code.
      const employeeCode =
        employeeIdRaw && !UUID_REGEX.test(employeeIdRaw) ? employeeIdRaw : "";

      if (!employeeIdRaw && !employeeEmail && !employeeName) {
        errors.push({
          row: rowNumber,
          message: "Missing employee — provide ID, email, or full name",
        });
        continue;
      }

      const visaType = pickString(row, "visaType", "visa_type", "Visa Type");
      if (!visaType) {
        errors.push({ row: rowNumber, message: "Missing visa type" });
        continue;
      }

      const expiry = pickDate(row, "expiryDate", "expiry_date", "Expiry Date");
      if (!expiry) {
        errors.push({
          row: rowNumber,
          message: "Missing or invalid expiry date (use YYYY-MM-DD)",
        });
        continue;
      }

      const issue = pickDate(row, "issueDate", "issue_date", "Issue Date");

      const country = pickString(row, "country", "Country") || "Thailand";
      const status =
        pickString(row, "status", "Status").toLowerCase() || "active";
      const notes = pickString(row, "notes", "Notes");

      parsed.push({
        rowNumber,
        employeeIdRaw,
        employeeEmail,
        employeeName,
        employeeCode,
        visaType,
        country,
        expiryDateIso: expiry.iso,
        issueDateIso: issue ? issue.iso : null,
        status,
        notes,
      });
    }

    const valid: ResolvedRow[] = [];
    if (parsed.length > 0) {
      const ids = Array.from(
        new Set(
          parsed
            .map((p) => p.employeeIdRaw)
            .filter((v) => v && UUID_REGEX.test(v)),
        ),
      );
      const emails = Array.from(
        new Set(parsed.map((p) => p.employeeEmail).filter(Boolean)),
      );
      const codes = Array.from(
        new Set(parsed.map((p) => p.employeeCode).filter(Boolean)),
      );
      const needsNameLookup = parsed.some(
        (p) =>
          !p.employeeIdRaw &&
          !p.employeeEmail &&
          !p.employeeCode &&
          p.employeeName,
      );

      const [byId, byEmail, byCode, allActive] = await Promise.all([
        visaRepository.findUsersByIds(ids),
        visaRepository.findUsersByEmails(emails),
        visaRepository.findUsersByEmployeeCodes(codes),
        needsNameLookup
          ? visaRepository.findActiveUsersForBulkMatch()
          : Promise.resolve(
              [] as Array<{
                id: string;
                name: string;
                email: string;
                employeeId: string | null;
              }>,
            ),
      ]);

      const userById = new Map(byId.map((u) => [u.id, u] as const));
      const userByEmail = new Map(
        byEmail.map((u) => [u.email.toLowerCase(), u] as const),
      );
      const userByCode = new Map(
        byCode
          .filter((u) => u.employeeId)
          .map((u) => [u.employeeId as string, u] as const),
      );
      const userByNormalisedName = new Map(
        allActive.map((u) => [normaliseName(u.name), u] as const),
      );

      for (const p of parsed) {
        let user:
          | {
              id: string;
              name: string;
              email: string;
              employeeId: string | null;
            }
          | undefined;

        if (p.employeeIdRaw && UUID_REGEX.test(p.employeeIdRaw)) {
          user = userById.get(p.employeeIdRaw);
        }
        if (!user && p.employeeCode) user = userByCode.get(p.employeeCode);
        if (!user && p.employeeEmail) user = userByEmail.get(p.employeeEmail);
        if (!user && p.employeeName) {
          user = userByNormalisedName.get(normaliseName(p.employeeName));
        }
        if (!user) {
          errors.push({
            row: p.rowNumber,
            message: `Could not match employee — ${
              p.employeeIdRaw || p.employeeEmail || p.employeeName || "(blank)"
            }`,
          });
          continue;
        }
        valid.push({ ...p, employeeId: user.id });
      }
    }

    return {
      valid: valid.map((v) => ({
        rowIndex: v.rowNumber,
        employeeId: v.employeeId,
        visaType: v.visaType,
        country: v.country,
        expiryDate: v.expiryDateIso,
        issueDate: v.issueDateIso,
        status: v.status,
        notes: v.notes,
      })),
      errors,
      totalRows: rows.length,
      validCount: valid.length,
      errorCount: errors.length,
    };
  }

  async commitImport(rows: Array<Record<string, unknown>>) {
    const preview = await this.previewImport(rows);
    if (preview.errorCount > 0) {
      throw new BadRequestException(
        `${preview.errorCount} rows have errors. Fix them and try again.`,
      );
    }

    let imported = 0;
    const failures: Array<{ row: number; message: string }> = [];

    for (const row of preview.valid) {
      // Defensive: every row must resolve to a real Prisma User UUID
      // before we attempt the create — otherwise Postgres rejects with
      // a foreign-key error and the request returns "Internal server
      // error" which is what the user reported.
      if (!row.employeeId || !UUID_REGEX.test(row.employeeId)) {
        failures.push({
          row: row.rowIndex,
          message: `Row ${row.rowIndex}: resolved employee id is not a valid UUID (${row.employeeId})`,
        });
        continue;
      }

      try {
        await visaRepository.create({
          employeeId: row.employeeId,
          visaType: row.visaType,
          country: row.country,
          expiryDate: new Date(row.expiryDate),
          issueDate: row.issueDate ? new Date(row.issueDate) : undefined,
          status: row.status || "active",
          notes: row.notes || undefined,
        });
        imported++;
      } catch (err) {
        // Surface the per-row failure instead of a 500. Most common is
        // a stale employee id (FK constraint) or a duplicate (unique
        // constraint, if one ever gets added).
        failures.push({
          row: row.rowIndex,
          message:
            err instanceof Error
              ? `Row ${row.rowIndex}: ${err.message}`
              : `Row ${row.rowIndex}: failed to import`,
        });
      }
    }

    if (failures.length > 0 && imported === 0) {
      throw new BadRequestException(
        `Import failed — ${failures
          .slice(0, 5)
          .map((f) => f.message)
          .join("; ")}${failures.length > 5 ? "; …" : ""}`,
      );
    }

    return {
      imported,
      failed: failures.length,
      failures,
      message:
        failures.length > 0
          ? `${imported} imported, ${failures.length} row(s) failed`
          : `${imported} visa records imported successfully`,
    };
  }

  /**
   * Daily reminder dispatcher.
   *
   * Walks every active visa record and emails the employee (cc HR) when
   * the visa or work permit crosses into one of the milestone buckets
   * (90/60/30/14/7 days). We stamp `lastReminderMilestoneDays` after a
   * send so the cron only re-pings when the row enters a *closer*
   * bucket, never when it stays in the same one.
   */
  async processExpiryReminders() {
    const today = new Date();
    const milestones = await loadVisaNotificationLeadDays();
    const windowDays = milestones[0] ?? DEFAULT_REMINDER_MILESTONES_DAYS[0];
    const currentMilestone = makeCurrentMilestone(milestones);
    const windowEnd = new Date(today);
    windowEnd.setDate(windowEnd.getDate() + windowDays);

    const records = await prisma.visaRecord.findMany({
      where: {
        status: "active",
        OR: [
          { expiryDate: { lte: windowEnd, gte: today } },
          { workPermitExpiryDate: { lte: windowEnd, gte: today } },
        ],
      },
      include: {
        employee: { select: { id: true, name: true, email: true } },
      },
    });

    // Admin-configurable HR distribution list (SystemSetting). Legacy
    // env var `VISA_REMINDER_CC` still honoured as a fallback so an
    // ops bootstrap before the UI lands keeps working.
    const settingRecipients = await loadVisaNotificationRecipients();
    const envFallback = (process.env.VISA_REMINDER_CC ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const hrCcSet = new Set<string>([...settingRecipients, ...envFallback]);
    const hrCc = Array.from(hrCcSet);
    const notifyEmployee = await loadVisaNotifyEmployee();

    let sent = 0;
    let skipped = 0;

    for (const r of records) {
      const visaDays = daysUntil(r.expiryDate, today);
      const wpDays = r.workPermitExpiryDate
        ? daysUntil(r.workPermitExpiryDate, today)
        : null;

      const visaDue = visaDays >= 0 && visaDays <= windowDays;
      const wpDue = wpDays !== null && wpDays >= 0 && wpDays <= windowDays;
      if (!visaDue && !wpDue) {
        skipped++;
        continue;
      }

      // Smallest milestone the record sits in (across visa + WP).
      const candidates = [
        visaDue ? currentMilestone(visaDays) : null,
        wpDue && wpDays !== null ? currentMilestone(wpDays) : null,
      ].filter((v): v is number => v !== null);
      const milestone = candidates.length > 0 ? Math.min(...candidates) : null;
      if (milestone === null) {
        skipped++;
        continue;
      }

      // Only re-fire when crossing into a closer bucket.
      if (
        r.lastReminderMilestoneDays !== null &&
        r.lastReminderMilestoneDays !== undefined &&
        r.lastReminderMilestoneDays <= milestone
      ) {
        skipped++;
        continue;
      }

      // Build recipient list honouring the per-org `notifyEmployee`
      // toggle. When the flag is off we mail only the HR distribution
      // list; if both are empty there is no one to mail, so skip.
      const employeeEmail =
        notifyEmployee && r.employee?.email ? r.employee.email : null;
      const recipients: string[] = [];
      if (employeeEmail) recipients.push(employeeEmail);
      for (const cc of hrCc) {
        if (!recipients.includes(cc)) recipients.push(cc);
      }
      if (recipients.length === 0) {
        skipped++;
        continue;
      }

      const email = visaExpiryReminderEmail({
        employeeName: r.employee.name,
        country: r.country,
        visa:
          visaDue && r.expiryDate
            ? {
                expiryDate: fmtDate(r.expiryDate),
                daysLeft: visaDays,
                visaType: r.visaType,
              }
            : null,
        workPermit:
          wpDue && r.workPermitExpiryDate && wpDays !== null
            ? {
                expiryDate: fmtDate(r.workPermitExpiryDate),
                daysLeft: wpDays,
                permitNumber: r.workPermitNumber ?? undefined,
              }
            : null,
        portalUrl: `${PORTAL_URL}/visa`,
      });

      try {
        await sendEmail({
          to: recipients.length === 1 ? recipients[0] : recipients,
          ...email,
        });
        await prisma.visaRecord.update({
          where: { id: r.id },
          data: {
            lastReminderSentAt: new Date(),
            lastReminderMilestoneDays: milestone,
          },
        });
        sent++;
      } catch (err) {
        logger.error("Visa reminder dispatch failed", {
          recordId: r.id,
          error: err instanceof Error ? err.message : err,
        });
        skipped++;
      }
    }

    return {
      checked: records.length,
      sent,
      skipped,
      windowDays,
      milestones,
    };
  }

  async getNotificationConfig() {
    const [emails, leadDays, notifyEmployee] = await Promise.all([
      loadVisaNotificationRecipients(),
      loadVisaNotificationLeadDays(),
      loadVisaNotifyEmployee(),
    ]);
    return { emails, leadDays, notifyEmployee };
  }

  async setNotificationRecipients(rawEmails: string[]) {
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const raw of rawEmails) {
      const trimmed = raw.trim().toLowerCase();
      if (!trimmed) continue;
      if (!isValidEmail(trimmed)) {
        throw new BadRequestException(`Invalid email: ${raw}`);
      }
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      cleaned.push(trimmed);
    }
    await prisma.systemSetting.upsert({
      where: { key: VISA_RECIPIENTS_KEY },
      update: { value: cleaned },
      create: { key: VISA_RECIPIENTS_KEY, value: cleaned },
    });
    return { emails: cleaned };
  }

  async setNotificationLeadDays(rawDays: unknown[]) {
    const cleaned: number[] = [];
    for (const raw of rawDays) {
      const n = Math.floor(Number(raw));
      if (!Number.isFinite(n) || n <= 0 || n > 3650) {
        throw new BadRequestException(`Invalid lead day: ${String(raw)}`);
      }
      cleaned.push(n);
    }
    if (cleaned.length === 0) {
      throw new BadRequestException(
        "At least one lead day is required (e.g. [90, 60, 30, 14, 7])",
      );
    }
    const sorted = Array.from(new Set(cleaned)).sort((a, b) => b - a);
    await prisma.systemSetting.upsert({
      where: { key: VISA_LEAD_DAYS_KEY },
      update: { value: sorted },
      create: { key: VISA_LEAD_DAYS_KEY, value: sorted },
    });
    return { leadDays: sorted };
  }

  async setNotificationNotifyEmployee(value: unknown) {
    if (typeof value !== "boolean") {
      throw new BadRequestException("notifyEmployee must be a boolean");
    }
    await prisma.systemSetting.upsert({
      where: { key: VISA_NOTIFY_EMPLOYEE_KEY },
      update: { value },
      create: { key: VISA_NOTIFY_EMPLOYEE_KEY, value },
    });
    return { notifyEmployee: value };
  }
}

export const visaService = new VisaService();
