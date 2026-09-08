import { describe, expect, it, vi } from "vitest";

import { ForbiddenException, NotFoundException } from "../http-exception.js";
import * as repo from "./upload.repository.js";
import { getSignedUrl } from "./upload.service.js";

vi.mock("./upload.repository.js", () => ({
  findById: vi.fn(),
  findAll: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
  softRemove: vi.fn(),
}));

describe("getSignedUrl ownership", () => {
  it("404s when the upload is missing or soft-deleted", async () => {
    vi.mocked(repo.findById).mockResolvedValueOnce(null);
    await expect(
      getSignedUrl({} as never, "up-1", "user-a", {
        put: vi.fn(),
        delete: vi.fn(),
        getSignedUrl: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);

    vi.mocked(repo.findById).mockResolvedValueOnce({
      id: "up-1",
      uploadedBy: "user-a",
      deletedAt: "2026-01-01T00:00:00.000Z",
      path: "r2:documents:user-a/file.pdf",
    } as never);
    await expect(
      getSignedUrl({} as never, "up-1", "user-a", {
        put: vi.fn(),
        delete: vi.fn(),
        getSignedUrl: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("forbids signed URLs for uploads owned by another user", async () => {
    vi.mocked(repo.findById).mockResolvedValueOnce({
      id: "up-1",
      uploadedBy: "user-owner",
      deletedAt: null,
      path: "r2:documents:user-owner/secret.pdf",
    } as never);

    await expect(
      getSignedUrl({} as never, "up-1", "user-other", {
        put: vi.fn(),
        delete: vi.fn(),
        getSignedUrl: vi.fn().mockResolvedValue("https://signed.example/x"),
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("returns a signed URL when the caller owns a private upload", async () => {
    vi.mocked(repo.findById).mockResolvedValueOnce({
      id: "up-1",
      uploadedBy: "user-a",
      deletedAt: null,
      path: "r2:documents:user-a/file.pdf",
    } as never);
    const getSigned = vi.fn().mockResolvedValue("https://signed.example/ok");

    await expect(
      getSignedUrl({} as never, "up-1", "user-a", {
        put: vi.fn(),
        delete: vi.fn(),
        getSignedUrl: getSigned,
      }),
    ).resolves.toEqual({ url: "https://signed.example/ok" });
    expect(getSigned).toHaveBeenCalledWith("user-a/file.pdf");
  });
});
