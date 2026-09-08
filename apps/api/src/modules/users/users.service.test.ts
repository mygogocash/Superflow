import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@/common/exceptions/http-exception";
import { sendWelcomeTemplateEmail } from "@/infrastructure/email/email.service";
import { supabaseAdmin } from "@/infrastructure/supabase/admin";
import { usersRepository } from "@/modules/users/users.repository";
import { UsersService } from "@/modules/users/users.service";

vi.mock("./users.repository", () => ({
  usersRepository: {
    findMany: vi.fn(),
    findById: vi.fn(),
    findByEmail: vi.fn(),
    findByEmployeeId: vi.fn(),
    allocateNextEmployeeId: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    deleteWithCleanup: vi.fn(),
    softDelete: vi.fn(),
    softDeleteMany: vi.fn(),
    restore: vi.fn(),
    restoreMany: vi.fn(),
    permanentDelete: vi.fn(),
    replaceRoles: vi.fn(),
  },
}));

vi.mock("../../infrastructure/supabase/admin", () => ({
  supabaseAdmin: {
    auth: {
      admin: {
        createUser: vi.fn(),
        updateUserById: vi.fn(),
        deleteUser: vi.fn(),
      },
    },
  },
}));

vi.mock("@/infrastructure/email/email.service", () => ({
  sendWelcomeTemplateEmail: vi.fn().mockResolvedValue(undefined),
}));

const mockUserRoleFindFirst = vi.fn();
const mockRoleFindUnique = vi.fn();
const mockEntityFindMany = vi.fn();
const mockRoleFindMany = vi.fn();
const mockUserFindUnique = vi.fn();
const mockOrgMembershipFindFirst = vi.fn();

vi.mock("@/infrastructure/database/prisma", () => ({
  prisma: {
    user: {
      findUnique: (...args: unknown[]) => mockUserFindUnique(...args),
    },
    organizationMembership: {
      findFirst: (...args: unknown[]) => mockOrgMembershipFindFirst(...args),
      findMany: vi.fn(),
    },
    userRole: {
      findFirst: (...args: unknown[]) => mockUserRoleFindFirst(...args),
    },
    role: {
      findUnique: (...args: unknown[]) => mockRoleFindUnique(...args),
      findMany: (...args: unknown[]) => mockRoleFindMany(...args),
    },
    entity: {
      findMany: (...args: unknown[]) => mockEntityFindMany(...args),
    },
  },
}));

describe("UsersService", () => {
  let usersService: UsersService;
  const sendWelcomeTemplateEmailMock =
    sendWelcomeTemplateEmail as unknown as Mock;

  beforeEach(() => {
    usersService = new UsersService();
    vi.clearAllMocks();
    mockUserRoleFindFirst.mockResolvedValue(null);
    mockRoleFindUnique.mockResolvedValue(null);
    mockEntityFindMany.mockResolvedValue([]);
    mockRoleFindMany.mockResolvedValue([]);
    mockUserFindUnique.mockResolvedValue(null);
    mockOrgMembershipFindFirst.mockResolvedValue(null);
  });

  describe("list", () => {
    it("should return paginated users list", async () => {
      const mockUsers = [
        {
          id: "user-1",
          email: "user1@example.com",
          name: "User 1",
          avatarUrl: null,
          phone: "123456",
          department: "Engineering",
          jobTitle: "Developer",
          employeeId: "EMP001",
          employmentType: "full_time",
          startDate: new Date("2024-01-15"),
          location: "Dubai",
          country: "AE",
          isActive: true,
          entity: { id: "entity-1", name: "TBH" },
          manager: null,
          userRoles: [{ role: { id: "role-1", name: "Employee" } }],
          createdAt: new Date(),
        },
      ];

      (usersRepository.findMany as Mock).mockResolvedValue({
        users: mockUsers,
        total: 1,
      });

      const result = await usersService.list({ page: 1, limit: 10 });

      expect(result.data).toHaveLength(1);
      expect(result.data[0].email).toBe("user1@example.com");
      expect(result.data[0].startDate).toEqual(mockUsers[0].startDate);
      expect(result.data[0].location).toBe("Dubai");
      expect(result.data[0].country).toBe("AE");
      expect(result.meta.total).toBe(1);
      expect(result.meta.page).toBe(1);
    });
  });

  describe("getById", () => {
    it("should return user by ID", async () => {
      const mockUser = {
        id: "user-123",
        email: "test@example.com",
        name: "Test User",
        avatarUrl: null,
        phone: "123456",
        department: "Engineering",
        jobTitle: "Developer",
        employeeId: "EMP001",
        reportingTo: null,
        employmentType: "full_time",
        startDate: new Date(),
        endDate: null,
        salary: 50000,
        currency: "USD",
        location: "Remote",
        country: "US",
        timezone: "UTC",
        isActive: true,
        entity: { id: "entity-1", name: "TBH" },
        manager: null,
        userRoles: [{ role: { id: "role-1", name: "Employee" } }],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      (usersRepository.findById as Mock).mockResolvedValue(mockUser);

      const result = await usersService.getById("user-123");

      expect(result.data.id).toBe("user-123");
      expect(result.data.email).toBe("test@example.com");
    });

    it("should throw NotFoundException when user not found", async () => {
      (usersRepository.findById as Mock).mockResolvedValue(null);

      await expect(usersService.getById("non-existent")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("rejects org-scoped actors without an active organization", async () => {
      mockUserFindUnique.mockResolvedValue({
        platformRole: "member",
        activeOrganizationId: null,
      });
      await expect(usersService.getById("user-123", "actor-1")).rejects.toThrow(
        /Active organization required/,
      );
      expect(usersRepository.findById).not.toHaveBeenCalled();
    });

    it("404s when target user is outside the actor organization", async () => {
      mockUserFindUnique.mockResolvedValue({
        platformRole: "member",
        activeOrganizationId: "org-1",
      });
      mockOrgMembershipFindFirst.mockResolvedValue(null);
      await expect(usersService.getById("outsider", "actor-1")).rejects.toThrow(
        NotFoundException,
      );
      expect(usersRepository.findById).not.toHaveBeenCalled();
    });

    it("returns user when target is an org member", async () => {
      const mockUser = {
        id: "user-123",
        email: "test@example.com",
        name: "Test User",
        avatarUrl: null,
        phone: null,
        department: null,
        jobTitle: null,
        employeeId: "EMP001",
        reportingTo: null,
        employmentType: null,
        startDate: null,
        endDate: null,
        dateOfBirth: null,
        salary: 50000,
        currency: "USD",
        location: null,
        country: null,
        timezone: null,
        passportNumber: null,
        thaiId: null,
        taxId: null,
        aadhaarNumber: null,
        panCardNumber: null,
        workPermitType: null,
        visaType: null,
        permitNumber: null,
        isActive: true,
        entity: null,
        manager: null,
        userRoles: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockUserFindUnique.mockResolvedValue({
        platformRole: "member",
        activeOrganizationId: "org-1",
      });
      mockOrgMembershipFindFirst.mockResolvedValue({ userId: "user-123" });
      (usersRepository.findById as Mock).mockResolvedValue(mockUser);
      const result = await usersService.getById("user-123", "actor-1");
      expect(result.data.id).toBe("user-123");
      expect(result.data.salary).toBe(50000);
    });
  });

  describe("create", () => {
    const createInput = {
      email: "new@example.com",
      password: "SecurePass123!",
      name: "New User",
      entityId: "entity-1",
      department: "HR",
      jobTitle: "Manager",
    };

    it("should create user successfully", async () => {
      (usersRepository.findByEmail as Mock).mockResolvedValue(null);
      (usersRepository.allocateNextEmployeeId as Mock).mockResolvedValue(
        "MNT-042",
      );
      (supabaseAdmin.auth.admin.createUser as Mock).mockResolvedValue({
        data: { user: { id: "new-user-123" } },
        error: null,
      });
      (usersRepository.create as Mock).mockResolvedValue({
        id: "new-user-123",
        email: "new@example.com",
        name: "New User",
      });

      const result = await usersService.create(createInput);

      expect(result.data.id).toBe("new-user-123");
      expect(usersRepository.allocateNextEmployeeId).toHaveBeenCalled();
      expect(supabaseAdmin.auth.admin.createUser).toHaveBeenCalled();
      expect(usersRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ employeeId: "MNT-042" }),
        undefined,
      );
      expect(sendWelcomeTemplateEmailMock).toHaveBeenCalledWith({
        to: "new@example.com",
        name: "New User",
        email: "new@example.com",
        temporaryPassword: "SecurePass123!",
        portalUrl: expect.any(String),
      });
    });

    it("should throw ConflictException when email already exists", async () => {
      (usersRepository.findByEmail as Mock).mockResolvedValue({
        id: "existing",
      });

      await expect(usersService.create(createInput)).rejects.toThrow(
        ConflictException,
      );
    });

    it("should throw ConflictException when employee ID already exists", async () => {
      (usersRepository.findByEmail as Mock).mockResolvedValue(null);
      (usersRepository.findByEmployeeId as Mock).mockResolvedValue({
        id: "existing",
      });

      await expect(
        usersService.create({ ...createInput, employeeId: "EMP001" }),
      ).rejects.toThrow(ConflictException);
      expect(usersRepository.allocateNextEmployeeId).not.toHaveBeenCalled();
    });

    it("should use provided employee ID without allocating", async () => {
      (usersRepository.findByEmail as Mock).mockResolvedValue(null);
      (usersRepository.findByEmployeeId as Mock).mockResolvedValue(null);
      (supabaseAdmin.auth.admin.createUser as Mock).mockResolvedValue({
        data: { user: { id: "new-user-456" } },
        error: null,
      });
      (usersRepository.create as Mock).mockResolvedValue({
        id: "new-user-456",
        email: "new@example.com",
        name: "New User",
      });

      await usersService.create({ ...createInput, employeeId: "EMP-777" });

      expect(usersRepository.allocateNextEmployeeId).not.toHaveBeenCalled();
      expect(usersRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ employeeId: "EMP-777" }),
        undefined,
      );
    });

    it("should throw BadRequestException when Supabase fails", async () => {
      (usersRepository.findByEmail as Mock).mockResolvedValue(null);
      (usersRepository.allocateNextEmployeeId as Mock).mockResolvedValue(
        "MNT-001",
      );
      (supabaseAdmin.auth.admin.createUser as Mock).mockResolvedValue({
        data: null,
        error: { message: "Auth error" },
      });

      await expect(usersService.create(createInput)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should delete Supabase user when DB creation fails", async () => {
      (usersRepository.findByEmail as Mock).mockResolvedValue(null);
      (usersRepository.allocateNextEmployeeId as Mock).mockResolvedValue(
        "MNT-001",
      );
      (supabaseAdmin.auth.admin.createUser as Mock).mockResolvedValue({
        data: { user: { id: "temp-user" } },
        error: null,
      });
      (usersRepository.create as Mock).mockRejectedValue(new Error("DB error"));

      await expect(usersService.create(createInput)).rejects.toThrow(
        "DB error",
      );
      expect(supabaseAdmin.auth.admin.deleteUser).toHaveBeenCalledWith(
        "temp-user",
      );
    });

    it("skips the welcome template email when requested", async () => {
      (usersRepository.findByEmail as Mock).mockResolvedValue(null);
      (usersRepository.allocateNextEmployeeId as Mock).mockResolvedValue(
        "MNT-043",
      );
      (supabaseAdmin.auth.admin.createUser as Mock).mockResolvedValue({
        data: { user: { id: "new-user-789" } },
        error: null,
      });
      (usersRepository.create as Mock).mockResolvedValue({
        id: "new-user-789",
        email: "new@example.com",
        name: "New User",
      });

      await usersService.create({ ...createInput, skipWelcomeEmail: true });

      expect(sendWelcomeTemplateEmailMock).not.toHaveBeenCalled();
    });
  });

  describe("update", () => {
    it("should update user successfully", async () => {
      (usersRepository.findById as Mock).mockResolvedValue({ id: "user-123" });
      (usersRepository.update as Mock).mockResolvedValue({
        id: "user-123",
        name: "Updated Name",
        userRoles: [],
      });

      const result = await usersService.update("user-123", {
        name: "Updated Name",
      });

      expect(result.data.name).toBe("Updated Name");
    });

    it("should throw NotFoundException when user not found", async () => {
      (usersRepository.findById as Mock).mockResolvedValue(null);

      await expect(
        usersService.update("non-existent", { name: "Test" }),
      ).rejects.toThrow(NotFoundException);
    });

    it("rejects an employeeId already taken by another user", async () => {
      (usersRepository.findById as Mock).mockResolvedValue({
        id: "user-123",
        employeeId: "MNT-001",
      });
      (usersRepository.findByEmployeeId as Mock).mockResolvedValue({
        id: "user-other",
        employeeId: "MNT-042",
      });

      await expect(
        usersService.update("user-123", { employeeId: "MNT-042" }),
      ).rejects.toThrow(ConflictException);
      expect(usersRepository.update).not.toHaveBeenCalled();
    });

    it("allows keeping the same employeeId without a conflict check", async () => {
      (usersRepository.findById as Mock).mockResolvedValue({
        id: "user-123",
        employeeId: "MNT-001",
      });
      (usersRepository.update as Mock).mockResolvedValue({
        id: "user-123",
        userRoles: [],
      });

      await usersService.update("user-123", { employeeId: "MNT-001" });

      expect(usersRepository.findByEmployeeId).not.toHaveBeenCalled();
      expect(usersRepository.update).toHaveBeenCalledWith(
        "user-123",
        expect.objectContaining({ employeeId: "MNT-001" }),
      );
    });
  });

  describe("remove", () => {
    const actorId = "actor-1";

    it("should soft delete user successfully", async () => {
      (usersRepository.findById as Mock).mockResolvedValue({ id: "user-123" });
      (usersRepository.softDelete as Mock).mockResolvedValue({
        id: "user-123",
        deletedAt: new Date(),
      });

      const result = await usersService.remove("user-123", actorId);

      expect(result.data.id).toBe("user-123");
      expect(usersRepository.softDelete).toHaveBeenCalledWith("user-123");
    });

    it("should throw NotFoundException when user not found", async () => {
      (usersRepository.findById as Mock).mockResolvedValue(null);

      await expect(
        usersService.remove("non-existent", actorId),
      ).rejects.toThrow(NotFoundException);
    });

    it("should throw BadRequestException when deleting own account", async () => {
      (usersRepository.findById as Mock).mockResolvedValue({ id: actorId });

      await expect(usersService.remove(actorId, actorId)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe("resetPassword", () => {
    it("should reset password successfully", async () => {
      (usersRepository.findById as Mock).mockResolvedValue({ id: "user-123" });
      (supabaseAdmin.auth.admin.updateUserById as Mock).mockResolvedValue({
        error: null,
      });
      (usersRepository.update as Mock).mockResolvedValue({});

      const result = await usersService.resetPassword("user-123", {
        newPassword: "NewPassword123!",
      });

      expect(result.data.id).toBe("user-123");
      expect(supabaseAdmin.auth.admin.updateUserById).toHaveBeenCalledWith(
        "user-123",
        { password: "NewPassword123!" },
      );
    });

    it("should throw NotFoundException when user not found", async () => {
      (usersRepository.findById as Mock).mockResolvedValue(null);

      await expect(
        usersService.resetPassword("non-existent", { newPassword: "test" }),
      ).rejects.toThrow(NotFoundException);
    });

    it("provisions a Supabase auth user when one is missing", async () => {
      (usersRepository.findById as Mock).mockResolvedValue({
        id: "user-123",
        email: "seed@example.com",
      });
      (supabaseAdmin.auth.admin.updateUserById as Mock).mockResolvedValue({
        error: { message: "User not found", status: 404 },
      });
      (supabaseAdmin.auth.admin.createUser as Mock).mockResolvedValue({
        data: { user: { id: "user-123" } },
        error: null,
      });
      (usersRepository.update as Mock).mockResolvedValue({});

      const result = await usersService.resetPassword("user-123", {
        newPassword: "NewPassword123!",
      });

      expect(result.data.id).toBe("user-123");
      expect(supabaseAdmin.auth.admin.createUser).toHaveBeenCalledWith({
        id: "user-123",
        email: "seed@example.com",
        password: "NewPassword123!",
        email_confirm: true,
      });
      expect(usersRepository.update).toHaveBeenCalledWith("user-123", {
        mustChangePassword: true,
      });
    });

    it("surfaces non-missing Supabase errors as BadRequest", async () => {
      (usersRepository.findById as Mock).mockResolvedValue({
        id: "user-123",
        email: "real@example.com",
      });
      (supabaseAdmin.auth.admin.updateUserById as Mock).mockResolvedValue({
        error: { message: "Password too weak", status: 422 },
      });

      await expect(
        usersService.resetPassword("user-123", { newPassword: "x" }),
      ).rejects.toThrow(BadRequestException);
      expect(supabaseAdmin.auth.admin.createUser).not.toHaveBeenCalled();
    });
  });

  describe("assignRoles", () => {
    it("should assign roles to user", async () => {
      (usersRepository.findById as Mock).mockResolvedValue({ id: "user-123" });
      (usersRepository.replaceRoles as Mock).mockResolvedValue([
        { role: { id: "role-1", name: "Admin" } },
        { role: { id: "role-2", name: "Manager" } },
      ]);

      const result = await usersService.assignRoles(
        "user-123",
        {
          roleIds: ["role-1", "role-2"],
        },
        "actor-1",
      );

      expect(result.data.userId).toBe("user-123");
      expect(result.data.roles).toHaveLength(2);
    });

    it("should throw NotFoundException when user not found", async () => {
      (usersRepository.findById as Mock).mockResolvedValue(null);

      await expect(
        usersService.assignRoles(
          "non-existent",
          { roleIds: ["role-1"] },
          "actor-1",
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
