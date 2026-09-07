import { z } from "zod";

const emptyToUndefined = z
  .string()
  .optional()
  .transform((v) => (v === "" || v === undefined ? undefined : v));
const optionalId = emptyToUndefined.pipe(z.string().min(1).optional());
const optionalString = emptyToUndefined.pipe(z.string().optional());

/** Trim; empty / whitespace-only becomes undefined (server assigns TBH-### when omitted). */
const optionalEmployeeId = z
  .string()
  .optional()
  .transform((v) => {
    if (v === undefined || v === "") return undefined;
    const t = v.trim();
    if (t === "") return undefined;
    return t;
  })
  .pipe(z.string().max(50).optional());

export const createUserSchema = z.object({
  email: z.string().email("Invalid email"),
  name: z.string().min(2, "Name must be at least 2 characters").max(200),
  password: z.string().min(8, "Password must be at least 8 characters"),
  phone: optionalString,
  avatarUrl: optionalString,
  entityId: optionalId,
  department: optionalString,
  jobTitle: optionalString,
  employeeId: optionalEmployeeId,
  reportingTo: optionalId,
  employmentType: z.string().default("full_time"),
  startDate: z.coerce.date().optional(),
  dateOfBirth: z.coerce.date().optional(),
  salary: z.number().positive().optional(),
  currency: optionalString,
  location: optionalString,
  country: optionalString,
  timezone: optionalString,
  passportNumber: optionalString,
  thaiId: optionalString,
  taxId: optionalString,
  aadhaarNumber: optionalString,
  panCardNumber: optionalString,
  workPermitType: optionalString,
  visaType: optionalString,
  permitNumber: optionalString,
  roleIds: z.array(z.string().uuid()).optional(),
  // Payroll quick-create flow (BD-feedback) mints a dormant employee so
  // the run can include a name HR couldn't match without polluting the
  // employee directory. `isActive=false` keeps them out of the active
  // listings; `skipWelcomeEmail=true` avoids spamming a placeholder
  // address with the welcome email + temp password.
  isActive: z.boolean().optional(),
  skipWelcomeEmail: z.boolean().optional(),
});

/** JSON clients often send explicit `null`; `z.string()` rejects that before transforms. */
function preprocessOmitEmptyToNull(val: unknown): unknown {
  if (val === undefined) return undefined;
  if (val === null || val === "") return null;
  return val;
}

const updateNullableString = z.preprocess(
  preprocessOmitEmptyToNull,
  z.union([z.string(), z.null()]).optional(),
);

const updateNullableId = z.preprocess(
  preprocessOmitEmptyToNull,
  z.union([z.string().min(1), z.null()]).optional(),
);

export const updateUserSchema = z
  .object({
    name: z.string().min(2).max(200).optional(),
    phone: updateNullableString,
    avatarUrl: updateNullableString,
    entityId: updateNullableId,
    department: updateNullableString,
    jobTitle: updateNullableString,
    employeeId: updateNullableString,
    reportingTo: updateNullableId,
    employmentType: z.string().optional(),
    startDate: z.coerce.date().nullable().optional(),
    dateOfBirth: z.coerce.date().nullable().optional(),
    endDate: z.coerce.date().nullable().optional(),
    salary: z.number().positive().nullable().optional(),
    currency: updateNullableString,
    location: updateNullableString,
    country: updateNullableString,
    timezone: updateNullableString,
    passportNumber: updateNullableString,
    thaiId: updateNullableString,
    taxId: updateNullableString,
    aadhaarNumber: updateNullableString,
    panCardNumber: updateNullableString,
    workPermitType: updateNullableString,
    visaType: updateNullableString,
    permitNumber: updateNullableString,
    isActive: z.boolean().optional(),
  })
  .refine(
    (data) => {
      if (data.startDate == null || data.endDate == null) return true;
      return data.endDate >= data.startDate;
    },
    {
      message: "End date must not be before start date",
      path: ["endDate"],
    },
  );

export const listUsersQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(500).default(20),
  search: z.string().optional(),
  entityId: z.string().min(1).optional(),
  /** Platform admin may filter by org; non-platform actors are forced to active org. */
  organizationId: z.string().min(1).optional(),
  roleId: z.string().uuid().optional(),
  isActive: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  department: z.string().optional(),
  employmentType: z.string().optional(),
  /**
   * Payroll imports create dormant placeholder users when the importer
   * can't match a name to an existing employee. Their emails are minted
   * as `payroll-<uuid>@placeholder.local`. Those rows belong on payslips
   * but pollute the Employees directory — exclude them by default. Set
   * `includePlaceholders=true` to see them (admin/HR use).
   */
  includePlaceholders: z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .optional(),
  sortBy: z.enum(["name", "email", "createdAt", "employeeId"]).default("name"),
  sortOrder: z.enum(["asc", "desc"]).default("asc"),
});

export const assignRolesSchema = z.object({
  roleIds: z.array(z.string().uuid()).min(1, "At least one role is required"),
});

export const resetPasswordSchema = z.object({
  newPassword: z.string().min(8, "Password must be at least 8 characters"),
});

// Multi-company membership (PRD Rule 7). `roleId` is the optional
// per-company role stored for later enforcement.
export const addMembershipSchema = z.object({
  entityId: z.string().min(1, "Entity is required"),
  roleId: optionalId,
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
/** Wire query + optional internal `userIds` scope (never accept from clients). */
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema> & {
  userIds?: string[];
};
export type AssignRolesInput = z.infer<typeof assignRolesSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type AddMembershipInput = z.infer<typeof addMembershipSchema>;
