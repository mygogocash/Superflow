import type { Prisma } from "@nexora/database";

import { PERMISSIONS } from "@/common/constants/permissions";
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@/common/exceptions/http-exception";
import { logger } from "@/common/utils/logger";
import { prisma } from "@/infrastructure/database/prisma";
import { sendEmail } from "@/infrastructure/email/email.service";
import { certificateIssuedEmail } from "@/infrastructure/email/templates";
import {
  createSignedUrl,
  deleteFile,
  downloadToBuffer,
  parseStorageUrl,
  STORAGE_BUCKETS,
  uploadFile,
} from "@/infrastructure/storage/supabase-storage";
import type { CertificateSignatureImage } from "@/modules/certificates/certificate.generator";
import { buildCertificatePdf } from "@/modules/certificates/certificate.generator";
import { certificatesRepository } from "@/modules/certificates/certificates.repository";
import type {
  CreateCertificateInput,
  ListCertificatesQuery,
} from "@/modules/certificates/certificates.validation";

// 7-day link in the email (recipient may not have a session); short-lived
// link for in-app re-download.
const DOWNLOAD_TTL_EMAIL = 60 * 60 * 24 * 7;
const DOWNLOAD_TTL_PORTAL = 300;

// Signature images may only come from buckets our own uploader writes to.
// This blocks a caller from pointing `signatureUrl` at an arbitrary private
// object (e.g. another user's receipt) and having it embedded into a PDF.
const SIGNATURE_ALLOWED_BUCKETS = new Set<string>([
  STORAGE_BUCKETS.DOCUMENTS,
  STORAGE_BUCKETS.AVATARS,
  STORAGE_BUCKETS.UPLOADS,
]);

/** Detect the real image format from magic bytes — never trust the MIME the
 * client claimed. Returns null for anything that isn't a PNG or JPEG. */
function sniffImageMime(buf: Buffer): "image/png" | "image/jpeg" | null {
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    buf.length >= 3 &&
    buf[0] === 0xff &&
    buf[1] === 0xd8 &&
    buf[2] === 0xff
  ) {
    return "image/jpeg";
  }
  return null;
}

/** Resolve a stored signature URL to embeddable image bytes. Throws
 * BadRequest on anything the caller got wrong (bad URL, disallowed bucket,
 * foreign object, non-image content) so the issuer gets clear feedback rather
 * than a certificate silently missing its signature.
 *
 * `actorId` scopes the reference to the caller's own uploads: our uploader
 * writes every object under a `<userId>/…` path prefix, so requiring that
 * prefix stops an issuer from pointing `signatureUrl` at another user's
 * object in the shared private `documents` bucket (downloadToBuffer uses the
 * service-role key and bypasses RLS). */
async function resolveSignatureImage(
  url: string,
  actorId: string,
): Promise<CertificateSignatureImage> {
  const parsed = parseStorageUrl(url);
  if (!parsed || !SIGNATURE_ALLOWED_BUCKETS.has(parsed.bucket)) {
    throw new BadRequestException("Signature image reference is invalid");
  }
  if (!parsed.path.startsWith(`${actorId}/`)) {
    throw new BadRequestException("Signature image must be one you uploaded");
  }

  let buffer: Buffer;
  try {
    ({ buffer } = await downloadToBuffer(parsed.bucket, parsed.path));
  } catch {
    throw new BadRequestException("Signature image could not be loaded");
  }

  const mime = sniffImageMime(buffer);
  if (!mime) {
    throw new BadRequestException("Signature must be a PNG or JPG image");
  }
  return { data: new Uint8Array(buffer), mime };
}

export class CertificatesService {
  // certificate:read lists the actor's own certificates; certificate:manage
  // is org-wide (HR/Admin). Seed historically put read on HR roles only —
  // this is defense-in-depth for custom roles that hold read without manage.
  async list(
    query: ListCertificatesQuery,
    actorId: string,
    actorPermissions: string[],
  ) {
    const where: Prisma.CertificateWhereInput = {};
    // certificate:read = own; certificate:manage = org-wide (HR/Admin).
    const canManage = actorPermissions.includes(PERMISSIONS.CERTIFICATE_MANAGE);
    if (canManage) {
      if (query.recipientId) where.recipientId = query.recipientId;
    } else {
      where.recipientId = actorId;
    }
    if (query.status) where.status = query.status;
    // Active list hides reverted certificates; the "reverted" view shows only
    // those (for restore / permanent delete).
    where.deletedAt = query.view === "reverted" ? { not: null } : null;

    const [data, total] = await certificatesRepository.list(
      where,
      (query.page - 1) * query.limit,
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

  // Generate the PDF, store it privately, persist the record, and email the
  // recipient a download link. The email is best-effort and never fails the
  // request (delivery also requires the OneWave "certificate-issued" template).
  async createAndIssue(actorId: string, input: CreateCertificateInput) {
    const recipient = await prisma.user.findUnique({
      where: { id: input.recipientId },
      select: { id: true, name: true, email: true },
    });
    if (!recipient) throw new BadRequestException("Recipient not found");

    const issuer = await prisma.user.findUnique({
      where: { id: actorId },
      select: { name: true },
    });

    // Normalize signatories to a concrete shape (Zod defaults leave the
    // inferred props optional).
    const signatories = (input.signatories ?? []).map((s) => ({
      name: s.name ?? "",
      title: s.title ?? "",
      signatureUrl: s.signatureUrl,
    }));

    // Fetch + validate any uploaded signature images so the generator can
    // embed the bytes. Done up front so a bad reference fails the request
    // before we write anything.
    const pdfSignatories = await Promise.all(
      signatories.map(async (s) => ({
        name: s.name,
        title: s.title,
        signatureImage: s.signatureUrl
          ? await resolveSignatureImage(s.signatureUrl, actorId)
          : null,
      })),
    );

    const pdf = await buildCertificatePdf({
      recipientName: recipient.name,
      title: input.title,
      message: input.message,
      type: input.type,
      issuedDate: new Date(),
      signatories: pdfSignatories,
    });

    const uploaded = await uploadFile(STORAGE_BUCKETS.DOCUMENTS, actorId, {
      buffer: pdf,
      originalName: `certificate-${recipient.id}.pdf`,
      mimeType: "application/pdf",
      size: pdf.length,
    });

    const cert = await certificatesRepository.create({
      recipientId: recipient.id,
      recipientName: recipient.name,
      recipientEmail: recipient.email,
      title: input.title,
      message: input.message ?? null,
      type: input.type,
      // Persist signatories as plain JSON. Omit `signatureUrl` entirely when
      // absent so no `undefined` reaches Prisma's JSON input.
      signatories: signatories.map((s) => ({
        name: s.name,
        title: s.title,
        ...(s.signatureUrl ? { signatureUrl: s.signatureUrl } : {}),
      })),
      fileUrl: uploaded.url,
      status: "issued",
      issuedById: actorId,
      issuedAt: new Date(),
    });

    try {
      const parsed = parseStorageUrl(uploaded.url);
      const downloadUrl = parsed
        ? await createSignedUrl(parsed.bucket, parsed.path, DOWNLOAD_TTL_EMAIL)
        : uploaded.url;
      const email = certificateIssuedEmail({
        recipientName: recipient.name,
        title: input.title,
        message: input.message ?? "",
        issuerName: issuer?.name ?? "Manut",
        downloadUrl,
      });
      void sendEmail({ to: recipient.email, ...email });
    } catch (err) {
      logger.error("Failed to email issued certificate", {
        error: err,
        certificateId: cert.id,
      });
    }

    return cert;
  }

  async getDownloadUrl(
    id: string,
    actorId: string,
    actorPermissions: string[],
  ) {
    const cert = await certificatesRepository.findById(id);
    if (!cert) throw new NotFoundException("Certificate not found");

    const canManage = actorPermissions.includes(PERMISSIONS.CERTIFICATE_MANAGE);
    if (cert.recipientId !== actorId && !canManage) {
      throw new ForbiddenException("You cannot access this certificate");
    }
    if (!cert.fileUrl) {
      throw new NotFoundException("Certificate file is not available");
    }

    const parsed = parseStorageUrl(cert.fileUrl);
    if (!parsed) {
      throw new BadRequestException("Certificate file URL is invalid");
    }
    const url = await createSignedUrl(
      parsed.bucket,
      parsed.path,
      DOWNLOAD_TTL_PORTAL,
    );
    return { url };
  }

  // Revert (soft delete): hide the certificate from the active list but keep
  // the record + stored PDF so it can be restored. Admin/HR only (gated at the
  // route by certificate:manage).
  async revert(id: string) {
    const cert = await certificatesRepository.findByIdIncludingDeleted(id);
    if (!cert) throw new NotFoundException("Certificate not found");
    if (cert.deletedAt) {
      throw new BadRequestException("Certificate is already reverted");
    }
    return certificatesRepository.softDelete(id);
  }

  // Restore a reverted certificate back to the active list.
  async restore(id: string) {
    const cert = await certificatesRepository.findByIdIncludingDeleted(id);
    if (!cert) throw new NotFoundException("Certificate not found");
    if (!cert.deletedAt) {
      throw new BadRequestException("Certificate is not reverted");
    }
    return certificatesRepository.restore(id);
  }

  // Permanently delete a certificate (record + stored PDF). Not recoverable.
  async remove(id: string) {
    const cert = await certificatesRepository.findByIdIncludingDeleted(id);
    if (!cert) throw new NotFoundException("Certificate not found");

    // Best-effort: remove the stored PDF so deleting a record doesn't orphan
    // a file in the bucket. Never block the delete on storage cleanup.
    if (cert.fileUrl) {
      const parsed = parseStorageUrl(cert.fileUrl);
      if (parsed) {
        try {
          await deleteFile(parsed.bucket, parsed.path);
        } catch (err) {
          logger.error("Failed to delete certificate file from storage", {
            error: err,
            certificateId: id,
          });
        }
      }
    }

    await certificatesRepository.delete(id);
    return { success: true };
  }
}

export const certificatesService = new CertificatesService();
