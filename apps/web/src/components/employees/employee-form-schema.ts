import { z } from "zod";

import { EMPLOYMENT_TYPES } from "@/services/user.service";

export const employeeFormSchema = z.object({
  name: z.string().min(2, "Name is required").max(200),
  email: z.string().email("Invalid email"),
  phone: z.string().max(40).optional().or(z.literal("")),
  entityId: z.string().optional().or(z.literal("")),
  department: z.string().min(1, "Department is required"),
  jobTitle: z.string().max(120).optional().or(z.literal("")),
  employeeId: z
    .string()
    .max(50)
    .regex(/^[A-Za-z0-9-]*$/, "Letters, digits, or - only")
    .optional()
    .or(z.literal("")),
  employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
  startDate: z.string().optional().or(z.literal("")),
  dateOfBirth: z.string().optional().or(z.literal("")),
  location: z.string().max(120).optional().or(z.literal("")),
  country: z.string().max(60).optional().or(z.literal("")),
  passportNumber: z.string().max(50).optional().or(z.literal("")),
  thaiId: z.string().max(20).optional().or(z.literal("")),
  taxId: z.string().max(20).optional().or(z.literal("")),
  aadhaarNumber: z.string().max(20).optional().or(z.literal("")),
  panCardNumber: z.string().max(20).optional().or(z.literal("")),
  workPermitType: z.string().optional().or(z.literal("")),
  visaType: z.string().optional().or(z.literal("")),
  permitNumber: z.string().max(50).optional().or(z.literal("")),
  reportingTo: z.string().optional().or(z.literal("")),
  roleIds: z.array(z.string()).min(1, "At least one role is required"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .optional()
    .or(z.literal("")),
});

export type EmployeeFormValues = z.infer<typeof employeeFormSchema>;

export const NONE_FILTER = "__none__";

export const EMPLOYEE_FORM_DEFAULTS: EmployeeFormValues = {
  name: "",
  email: "",
  phone: "",
  entityId: "",
  department: "",
  jobTitle: "",
  employeeId: "",
  employmentType: "full_time",
  startDate: "",
  dateOfBirth: "",
  location: "",
  country: "",
  passportNumber: "",
  thaiId: "",
  taxId: "",
  aadhaarNumber: "",
  panCardNumber: "",
  workPermitType: "",
  visaType: "",
  permitNumber: "",
  reportingTo: "",
  roleIds: [],
  password: "",
};

export function generatePassword(): string {
  const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%";
  // Rejection sampling avoids the modulo bias of `b % chars.length` (256 is
  // not a multiple of the alphabet length), keeping the distribution uniform.
  const max = Math.floor(256 / chars.length) * chars.length;
  let out = "";
  while (out.length < 14) {
    for (const b of crypto.getRandomValues(new Uint8Array(14))) {
      if (b < max) {
        out += chars[b % chars.length];
        if (out.length === 14) break;
      }
    }
  }
  return out;
}
