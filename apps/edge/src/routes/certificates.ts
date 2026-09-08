import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { PERMISSIONS } from "@nexora/contracts";
import {
  createCertificateSchema,
  listCertificatesSchema,
} from "@nexora/contracts/modules/certificates/certificates.validation";
import { certificatesService } from "@nexora/core";
import type { AppEnv } from "../lib/context";
import { requireAuth } from "../middleware/auth";
import { requirePermission } from "../middleware/rbac";
import { NotFoundException } from "../lib/errors";

function r2Storage(c: { env: AppEnv["Bindings"] }) {
  return {
    async put(key: string, bytes: Uint8Array, contentType: string) {
      await c.env.R2_PRIVATE.put(key, bytes, { httpMetadata: { contentType } });
    },
    async delete(key: string) {
      await c.env.R2_PRIVATE.delete(key);
    },
  };
}

export const certificates = new Hono<AppEnv>()
  .get(
    "/",
    requirePermission(PERMISSIONS.CERTIFICATE_READ),
    zValidator("query", listCertificatesSchema),
    async (c) =>
      c.json(
        await certificatesService.list(
          c.var.db,
          c.req.valid("query"),
          c.var.user!.id,
          c.var.user!.permissions,
        ),
      ),
  )
  .post(
    "/",
    requirePermission(PERMISSIONS.CERTIFICATE_MANAGE),
    zValidator("json", createCertificateSchema),
    async (c) => {
      const data = await certificatesService.createAndIssue(
        c.var.db,
        c.var.user!.id,
        c.req.valid("json"),
        r2Storage(c),
      );
      return c.json({ data }, 201);
    },
  )
  .get("/:id/download", requireAuth, async (c) => {
    const id = c.req.param("id");
    const data = await certificatesService.getDownloadUrl(
      c.var.db,
      id,
      c.var.user!.id,
      c.var.user!.permissions,
      `/api/certificates/${id}/file`,
    );
    return c.json({ data });
  })
  .get("/:id/file", requireAuth, async (c) => {
    const cert = await certificatesService.assertCanDownload(
      c.var.db,
      c.req.param("id"),
      c.var.user!.id,
      c.var.user!.permissions,
    );
    const key = certificatesService.parseR2PrivateKey(cert.fileUrl);
    if (!key) throw new NotFoundException("Certificate file is not available");
    const obj = await c.env.R2_PRIVATE.get(key);
    if (!obj) throw new NotFoundException("Certificate file is not available");
    return new Response(obj.body, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="certificate-${cert.id}.pdf"`,
      },
    });
  })
  .post("/:id/restore", requirePermission(PERMISSIONS.CERTIFICATE_MANAGE), async (c) => {
    const data = await certificatesService.restore(c.var.db, c.req.param("id"));
    return c.json({ data });
  })
  .delete("/:id/permanent", requirePermission(PERMISSIONS.CERTIFICATE_MANAGE), async (c) => {
    const data = await certificatesService.remove(c.var.db, c.req.param("id"), r2Storage(c));
    return c.json({ data });
  })
  .delete("/:id", requirePermission(PERMISSIONS.CERTIFICATE_MANAGE), async (c) => {
    const data = await certificatesService.revert(c.var.db, c.req.param("id"));
    return c.json({ data });
  });
