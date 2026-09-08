import { describe, expect, it } from "vitest";

import { BadRequestException } from "../http-exception.js";
import { validateUpload } from "./r2-storage.js";

describe("validateUpload", () => {
  it("rejects SVG on the public avatars bucket for normal uploads", () => {
    expect(() =>
      validateUpload("avatars", "image/svg+xml", 128, { purpose: "profile" }),
    ).toThrow(BadRequestException);
    expect(() => validateUpload("avatars", "image/svg+xml", 128)).toThrow(
      BadRequestException,
    );
  });

  it("allows SVG on avatars only for the trusted avatar-generator purpose", () => {
    expect(() =>
      validateUpload("avatars", "image/svg+xml", 128, {
        purpose: "avatar-generator",
      }),
    ).not.toThrow();
  });

  it("still allows raster avatar MIME types", () => {
    expect(() => validateUpload("avatars", "image/png", 128)).not.toThrow();
    expect(() => validateUpload("avatars", "image/jpeg", 128)).not.toThrow();
    expect(() => validateUpload("avatars", "image/webp", 128)).not.toThrow();
  });
});
