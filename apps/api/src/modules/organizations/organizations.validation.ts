import { z } from "zod";
import { ORG_ROLES } from "@/modules/auth/org-rbac";

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(1).max(200),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be lowercase kebab-case"),
  superAdminUserId: z.string().uuid(),
});

export const updateOrganizationSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  status: z.enum(["active", "suspended", "provisioning"]).optional(),
});

export const upsertOrgMembershipSchema = z.object({
  userId: z.string().uuid(),
  orgRole: z.enum(ORG_ROLES),
});

export const updateOrgMembershipSchema = z.object({
  orgRole: z.enum(ORG_ROLES).optional(),
  isActive: z.boolean().optional(),
});

export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;
export type UpsertOrgMembershipInput = z.infer<typeof upsertOrgMembershipSchema>;
export type UpdateOrgMembershipInput = z.infer<typeof updateOrgMembershipSchema>;
