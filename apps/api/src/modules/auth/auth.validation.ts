import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().email("Invalid email"),
  password: z.string().min(1, "Password is required"),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, "Password must be at least 8 characters"),
});

export const authEmailRequestSchema = z.object({
  email: z.string().email("Invalid email"),
});

export const recoverPasswordSchema = z.object({
  accessToken: z.string().min(1, "Access token is required"),
  refreshToken: z.string().min(1, "Refresh token is required"),
  newPassword: z.string().min(8, "Password must be at least 8 characters"),
});

export const exchangeSessionSchema = z.object({
  accessToken: z.string().min(1, "Access token is required"),
  refreshToken: z.string().min(1, "Refresh token is required"),
});

// Multi-company switcher (PRD Rule 7) — the entity the caller wants to
// make active. Membership is validated in the service.
export const setActiveEntitySchema = z.object({
  entityId: z.string().min(1, "Entity is required"),
});

export const setActiveOrganizationSchema = z.object({
  organizationId: z.string().min(1, "Organization is required"),
});

const emptyToUndefined = z
  .string()
  .transform((v) => (v === "" ? undefined : v));

export const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2).max(200),
  password: z.string().min(8),
  entityId: emptyToUndefined.pipe(z.string().min(1).optional()),
  department: emptyToUndefined.pipe(z.string().optional()),
  jobTitle: emptyToUndefined.pipe(z.string().optional()),
  roleIds: z.array(z.string()).optional(),
});

/**
 * Patch shape for `/auth/me/profile`. All fields optional — caller may
 * tweak a single property. Empty strings on text fields are passed
 * through and the service converts them to `NULL` so the user can
 * actually clear a previously-set value via the form.
 */
export const updateMyProfileSchema = z.object({
  phone: z.string().max(20).optional(),
  phonePublic: z.boolean().optional(),
  location: z.string().max(100).optional(),
  country: z.string().max(100).optional(),
  timezone: z.string().max(100).optional(),
  // Stored on `User.avatarUrl` — keep generous so signed-URL formats
  // with long query strings round-trip cleanly.
  avatarUrl: z.string().max(2000).optional(),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type AuthEmailRequestInput = z.infer<typeof authEmailRequestSchema>;
export type RecoverPasswordInput = z.infer<typeof recoverPasswordSchema>;
export type ExchangeSessionInput = z.infer<typeof exchangeSessionSchema>;
export type SetActiveEntityInput = z.infer<typeof setActiveEntitySchema>;
export type SetActiveOrganizationInput = z.infer<typeof setActiveOrganizationSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateMyProfileInput = z.infer<typeof updateMyProfileSchema>;
