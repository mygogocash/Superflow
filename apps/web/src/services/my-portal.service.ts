import { api } from "@/lib/api-client";
import type { ApiSuccessResponse } from "@/types/api.type";

export interface MyProfile {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
  phone: string | null;
  phonePublic: boolean;
  department: string | null;
  jobTitle: string | null;
  employeeId: string | null;
  employmentType: string;
  startDate: string | null;
  endDate: string | null;
  location: string | null;
  country: string | null;
  timezone: string | null;
  locale: string | null;
  entity: { id: string; name: string; code: string } | null;
  roles: Array<{ id: string; name: string }>;
}

export interface UpdateMyProfileInput {
  phone?: string;
  phonePublic?: boolean;
  location?: string;
  country?: string;
  timezone?: string;
  locale?: string;
  avatarUrl?: string;
}

export async function getMyProfile(): Promise<
  ApiSuccessResponse<{ profile: MyProfile }>
> {
  return api.get("/auth/me/profile");
}

export async function updateMyProfile(
  input: UpdateMyProfileInput,
): Promise<
  ApiSuccessResponse<
    Pick<
      MyProfile,
      | "id"
      | "email"
      | "name"
      | "avatarUrl"
      | "phone"
      | "phonePublic"
      | "location"
      | "country"
      | "timezone"
    >
  >
> {
  return api.patch("/auth/me/profile", input);
}
