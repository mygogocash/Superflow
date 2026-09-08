import { BadRequestException } from "../http-exception.js";

export const STORAGE_BUCKETS = {
  ARTICLE: "article",
  AVATARS: "avatars",
  BLOG: "blog",
  RECEIPTS: "receipts",
  DOCUMENTS: "documents",
  UPLOADS: "uploads",
} as const;

export type BucketName = (typeof STORAGE_BUCKETS)[keyof typeof STORAGE_BUCKETS];

const PUBLIC_BUCKETS = new Set<BucketName>(["article", "avatars", "blog", "uploads"]);

const MAX_FILE_SIZES: Record<BucketName, number> = {
  article: 10 * 1024 * 1024,
  avatars: 2 * 1024 * 1024,
  blog: 10 * 1024 * 1024,
  receipts: 10 * 1024 * 1024,
  documents: 50 * 1024 * 1024,
  uploads: 50 * 1024 * 1024,
};

export const MULTIPART_UPLOAD_MAX_BYTES = Math.max(...Object.values(MAX_FILE_SIZES));

const ALLOWED_MIME: Record<BucketName, string[]> = {
  article: ["image/jpeg", "image/png", "image/webp"],
  avatars: ["image/jpeg", "image/png", "image/webp", "image/svg+xml"],
  blog: ["image/jpeg", "image/png", "image/webp"],
  receipts: ["image/jpeg", "image/jpg", "image/png", "image/webp", "application/pdf"],
  documents: [
    "application/pdf", "image/jpeg", "image/png", "image/heic", "image/heif", "image/webp",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/vnd.ms-excel", "text/csv", "text/plain", "text/markdown", "text/x-markdown",
    "text/html", "application/zip", "application/x-zip-compressed",
  ],
  uploads: [
    "image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif",
    "application/pdf", "video/mp4", "video/quicktime", "audio/mpeg", "audio/mp4",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/csv", "text/plain",
  ],
};

export type R2Storage = {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
  getSignedUrl?(key: string, expiresInSeconds?: number): Promise<string>;
};

export function isPublicBucket(bucket: BucketName) {
  return PUBLIC_BUCKETS.has(bucket);
}

export function assertBucket(name: string): BucketName {
  const values = Object.values(STORAGE_BUCKETS) as string[];
  if (!values.includes(name)) {
    throw new BadRequestException(`Invalid bucket "${name}". Must be one of: ${values.join(", ")}`);
  }
  return name as BucketName;
}

export function validateUpload(bucket: BucketName, mimeType: string, size: number) {
  const max = MAX_FILE_SIZES[bucket];
  if (size > max) throw new BadRequestException(`File exceeds ${max} byte limit for bucket ${bucket}`);
  const allowed = ALLOWED_MIME[bucket];
  if (!allowed.includes(mimeType)) {
    throw new BadRequestException(`MIME type ${mimeType} is not allowed for bucket ${bucket}`);
  }
}

export function buildObjectKey(userId: string, originalName: string) {
  const safe = originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `${userId}/${Date.now()}-${safe}`;
}

/** Stored in file_uploads.path — prefix tells edge which bucket holds the object. */
export function encodeR2Path(bucket: BucketName, key: string) {
  return `r2:${bucket}:${key}`;
}

export function parseR2Path(path: string): { bucket: BucketName; key: string } | null {
  const m = /^r2:([^:]+):(.+)$/.exec(path);
  if (!m) return null;
  try {
    return { bucket: assertBucket(m[1]!), key: m[2]! };
  } catch {
    return null;
  }
}

export async function resolveDisplayUrl(
  appUrl: string,
  bucket: BucketName,
  path: string,
  uploadId: string,
): Promise<string> {
  const parsed = parseR2Path(path);
  if (!parsed) return path;
  if (isPublicBucket(parsed.bucket)) {
    return `${appUrl.replace(/\/$/, "")}/api/uploads/${uploadId}/file`;
  }
  return `${appUrl.replace(/\/$/, "")}/api/uploads/${uploadId}/signed-url`;
}
