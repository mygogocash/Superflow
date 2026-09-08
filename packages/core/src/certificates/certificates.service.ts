import { PERMISSIONS } from "@nexora/contracts";
import type { Db } from "@nexora/db";
import { eq } from "drizzle-orm";
import { schema } from "@nexora/db";
import type {
  CreateCertificateInput,
  ListCertificatesQuery,
} from "@nexora/contracts/modules/certificates/certificates.validation";
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "../http-exception";
import { buildCertificatePdf } from "./certificate.generator";
import * as repo from "./certificates.repository";

/** Private R2 object key prefix stored as `r2:private:<key>`. */
export const R2_PRIVATE_PREFIX = "r2:private:";

export type CertificateStorage = {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  delete?(key: string): Promise<void>;
};

export function parseR2PrivateKey(fileUrl: string | null | undefined): string | null {
  if (!fileUrl?.startsWith(R2_PRIVATE_PREFIX)) return null;
  return fileUrl.slice(R2_PRIVATE_PREFIX.length);
}

export async function list(
  db: Db,
  query: ListCertificatesQuery,
  actorId: string,
  actorPermissions: string[],
) {
  // certificate:read = access own certificates; certificate:manage = org-wide.
  const canManage = actorPermissions.includes(PERMISSIONS.CERTIFICATE_MANAGE);
  const recipientId = canManage ? query.recipientId : actorId;
  const { data, total } = await repo.list(
    db,
    {
      recipientId,
      status: query.status,
      view: query.view,
    },
    query.page,
    query.limit,
  );
  return {
    data,
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit) || 1,
    },
  };
}

export async function createAndIssue(
  db: Db,
  actorId: string,
  input: CreateCertificateInput,
  storage: CertificateStorage,
) {
  const [recipient] = await db
    .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, input.recipientId))
    .limit(1);
  if (!recipient) throw new BadRequestException("Recipient not found");

  const signatories = (input.signatories ?? []).map((s) => ({
    name: s.name ?? "",
    title: s.title ?? "",
    ...(s.signatureUrl ? { signatureUrl: s.signatureUrl } : {}),
  }));

  // Signature image fetch from R2/uploads lands with the uploads module;
  // issue still works with name/title blocks only.
  const pdf = await buildCertificatePdf({
    recipientName: recipient.name,
    title: input.title,
    message: input.message,
    type: input.type,
    issuedDate: new Date(),
    signatories: signatories.map((s) => ({ name: s.name, title: s.title, signatureImage: null })),
  });

  const now = new Date().toISOString();
  const cert = await repo.create(db, {
    recipientId: recipient.id,
    recipientName: recipient.name,
    recipientEmail: recipient.email,
    title: input.title,
    message: input.message ?? null,
    type: input.type,
    signatories,
    fileUrl: null,
    status: "issued",
    issuedById: actorId,
    issuedAt: now,
  });
  if (!cert) throw new BadRequestException("Failed to create certificate");

  const key = `documents/${actorId}/certificate-${cert.id}.pdf`;
  await storage.put(key, pdf, "application/pdf");
  return repo.updateFileUrl(db, cert.id, `${R2_PRIVATE_PREFIX}${key}`);
}

export async function assertCanDownload(
  db: Db,
  id: string,
  actorId: string,
  actorPermissions: string[],
) {
  const cert = await repo.findById(db, id);
  if (!cert) throw new NotFoundException("Certificate not found");

  const canManage = actorPermissions.includes(PERMISSIONS.CERTIFICATE_MANAGE);
  if (cert.recipientId !== actorId && !canManage) {
    throw new ForbiddenException("You cannot access this certificate");
  }
  if (!cert.fileUrl) throw new NotFoundException("Certificate file is not available");
  return cert;
}

/** Portal download: same-origin Worker stream URL (presigned R2 GET comes later). */
export async function getDownloadUrl(
  db: Db,
  id: string,
  actorId: string,
  actorPermissions: string[],
  filePath: string,
) {
  await assertCanDownload(db, id, actorId, actorPermissions);
  return { url: filePath };
}

export async function revert(db: Db, id: string) {
  const cert = await repo.findByIdIncludingDeleted(db, id);
  if (!cert) throw new NotFoundException("Certificate not found");
  if (cert.deletedAt) throw new BadRequestException("Certificate is already reverted");
  return repo.softDelete(db, id);
}

export async function restore(db: Db, id: string) {
  const cert = await repo.findByIdIncludingDeleted(db, id);
  if (!cert) throw new NotFoundException("Certificate not found");
  if (!cert.deletedAt) throw new BadRequestException("Certificate is not reverted");
  return repo.restore(db, id);
}

export async function remove(db: Db, id: string, storage?: CertificateStorage) {
  const cert = await repo.findByIdIncludingDeleted(db, id);
  if (!cert) throw new NotFoundException("Certificate not found");
  const key = parseR2PrivateKey(cert.fileUrl);
  if (key && storage?.delete) {
    try {
      await storage.delete(key);
    } catch {
      // best-effort cleanup
    }
  }
  await repo.hardDelete(db, id);
  return { success: true };
}
