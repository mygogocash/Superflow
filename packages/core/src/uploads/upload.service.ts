import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "../http-exception.js";
import {
  assertBucket,
  buildObjectKey,
  encodeR2Path,
  isPublicBucket,
  parseR2Path,
  resolveDisplayUrl,
  validateUpload,
  type BucketName,
  type R2Storage,
} from "../lib/r2-storage.js";
import type { Db } from "@nexora/db";
import * as repo from "./upload.repository.js";

const ACCOUNTING_LINKS = new Set(["invoice", "payment", "journal_entry"]);

export async function list(db: Db, userId: string, page: number, limit: number) {
  const { data, total } = await repo.findAll(db, userId, page, limit);
  return { data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

export async function upload(
  db: Db,
  userId: string,
  appUrl: string,
  input: {
    base64: string;
    originalName: string;
    mimeType: string;
    bucket?: string;
    purpose?: string;
    linkedTo?: string;
    linkedId?: string;
  },
  storage: R2Storage,
) {
  const bucket = assertBucket(input.bucket ?? "uploads");
  const bytes = Uint8Array.from(atob(input.base64), (c) => c.charCodeAt(0));
  validateUpload(bucket, input.mimeType, bytes.byteLength, {
    purpose: input.purpose,
  });
  const key = buildObjectKey(userId, input.originalName);
  await storage.put(key, bytes, input.mimeType);
  const path = encodeR2Path(bucket, key);
  const record = await repo.create(db, {
    id: crypto.randomUUID(),
    filename: input.originalName.replace(/[^a-zA-Z0-9._-]/g, "_"),
    originalName: input.originalName,
    mimeType: input.mimeType,
    size: bytes.byteLength,
    path,
    bucket,
    uploadedBy: userId,
    purpose: input.purpose ?? null,
    linkedTo: input.linkedTo ?? null,
    linkedId: input.linkedId ?? null,
  });
  const url = await resolveDisplayUrl(appUrl, bucket, path, record.id);
  return { ...record, url };
}

export async function getSignedUrl(db: Db, uploadId: string, userId: string, storage: R2Storage) {
  const upload = await repo.findById(db, uploadId);
  if (!upload || upload.deletedAt) throw new NotFoundException("Upload not found");
  if (upload.uploadedBy !== userId) throw new ForbiddenException("You do not have access to this upload");
  const parsed = parseR2Path(upload.path);
  if (!parsed) throw new BadRequestException("Invalid upload path");
  if (isPublicBucket(parsed.bucket as BucketName)) {
    return { url: upload.path };
  }
  if (!storage.getSignedUrl) throw new BadRequestException("Signed URLs are not available");
  const url = await storage.getSignedUrl(parsed.key);
  return { url };
}

export async function getPublicFile(db: Db, uploadId: string) {
  const upload = await repo.findById(db, uploadId);
  if (!upload || upload.deletedAt) throw new NotFoundException("Upload not found");
  const parsed = parseR2Path(upload.path);
  if (!parsed || !isPublicBucket(parsed.bucket as BucketName)) {
    throw new ForbiddenException("This upload is not publicly accessible");
  }
  return { upload, key: parsed.key, bucket: parsed.bucket as BucketName };
}

export async function remove(db: Db, uploadId: string, userId: string, storage: R2Storage) {
  const upload = await repo.findById(db, uploadId);
  if (!upload || upload.deletedAt) throw new NotFoundException("Upload not found");
  if (upload.uploadedBy !== userId) throw new ForbiddenException("You do not have access to delete this upload");
  if (upload.linkedTo && ACCOUNTING_LINKS.has(upload.linkedTo)) {
    await repo.softRemove(db, uploadId, userId);
    return;
  }
  const parsed = parseR2Path(upload.path);
  if (parsed) await storage.delete(parsed.key);
  await repo.remove(db, uploadId);
}
