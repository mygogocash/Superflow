import { z } from "zod";

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format");

// Document category buckets per HR feedback (Tanny, May 2026). Stored as
// free strings on the row so HR can add a new category without a
// migration; "other" is the catch-all.
const DOC_CATEGORIES = [
  "passport_front",
  "visa_page",
  "work_permit",
  "other",
] as const;

const visaDocumentSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  type: z.string().optional(),
  category: z.enum(DOC_CATEGORIES).default("other"),
});

// Holder-type variants:
//   - "employee": `employeeId` is the holder themselves; `holderName`
//     and `holderRelationship` stay null.
//   - "dependent": `employeeId` is the SPONSOR employee (so the
//     reminder cron's existing employee-id query path still mails a
//     Manut inbox), `holderName` carries the dependent's real name, and
//     `holderRelationship` is a free string ("spouse", "child", …).
const HOLDER_TYPES = ["employee", "dependent"] as const;

const visaBodySchema = z.object({
  employeeId: z.string().uuid("Invalid employee ID"),
  holderType: z.enum(HOLDER_TYPES).default("employee"),
  holderName: z.string().trim().max(200).optional(),
  holderRelationship: z.string().trim().max(60).optional(),
  visaType: z.string().min(1, "Visa type is required"),
  country: z.string().min(1, "Country is required"),
  nationality: z.string().max(100).optional(),
  issueDate: dateString.optional(),
  expiryDate: dateString,
  workPermitNumber: z.string().max(100).optional(),
  workPermitIssueDate: dateString.optional(),
  workPermitExpiryDate: dateString.optional(),
  status: z.string().default("active"),
  // Legacy single-URL field kept for backwards-compat with bulk import
  // rows that haven't been migrated. New writes should populate
  // `documents` instead.
  documentUrl: z.string().url().optional().or(z.literal("")),
  documents: z.array(visaDocumentSchema).max(20).optional(),
  notes: z.string().max(5000).optional(),
  entityId: z.string().optional(),
});

const visaIssueExpiryRefine = (data: {
  issueDate?: string | undefined;
  expiryDate?: string | undefined;
}) => {
  if (!data.issueDate) return true;
  if (!data.expiryDate) return true;
  return data.expiryDate >= data.issueDate;
};

const workPermitIssueExpiryRefine = (data: {
  workPermitIssueDate?: string | undefined;
  workPermitExpiryDate?: string | undefined;
}) => {
  if (!data.workPermitIssueDate) return true;
  if (!data.workPermitExpiryDate) return true;
  return data.workPermitExpiryDate >= data.workPermitIssueDate;
};

// Dependent rows must carry a holder name — without it, lists /
// reminders would surface "[sponsor]'s family member" with no way to
// distinguish the wife from the child.
const dependentNameRefine = (data: {
  holderType?: "employee" | "dependent";
  holderName?: string;
}) => {
  if (data.holderType !== "dependent") return true;
  return Boolean(data.holderName && data.holderName.trim().length > 0);
};

export const createVisaSchema = visaBodySchema
  .refine(visaIssueExpiryRefine, {
    message: "Expiry date must not be before issue date",
    path: ["expiryDate"],
  })
  .refine(workPermitIssueExpiryRefine, {
    message: "Work permit expiry date must not be before issue date",
    path: ["workPermitExpiryDate"],
  })
  .refine(dependentNameRefine, {
    message: "Holder name is required for a dependent record",
    path: ["holderName"],
  });

export const updateVisaSchema = visaBodySchema
  .partial()
  .omit({ employeeId: true })
  .refine(visaIssueExpiryRefine, {
    message: "Expiry date must not be before issue date",
    path: ["expiryDate"],
  })
  .refine(workPermitIssueExpiryRefine, {
    message: "Work permit expiry date must not be before issue date",
    path: ["workPermitExpiryDate"],
  })
  .refine(dependentNameRefine, {
    message: "Holder name is required for a dependent record",
    path: ["holderName"],
  });

// OCR autofill — the FE sends a private-bucket document URL it just
// uploaded; the API downloads it server-side and runs Gemini vision.
export const parseScanSchema = z.object({
  fileUrl: z.string().url(),
  docCategory: z.enum(DOC_CATEGORIES).optional(),
});

export const visaQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
  employeeId: z.string().uuid().optional(),
  status: z.string().optional(),
  country: z.string().optional(),
  entityId: z.string().optional(),
});

export type CreateVisaInput = z.infer<typeof createVisaSchema>;
export type UpdateVisaInput = z.infer<typeof updateVisaSchema>;
export type ParseScanInput = z.infer<typeof parseScanSchema>;
export type VisaQuery = z.infer<typeof visaQuerySchema>;
export type VisaDocumentInput = z.infer<typeof visaDocumentSchema>;
export const VISA_DOCUMENT_CATEGORIES = DOC_CATEGORIES;
export const VISA_HOLDER_TYPES = HOLDER_TYPES;
export type VisaHolderType = (typeof HOLDER_TYPES)[number];
