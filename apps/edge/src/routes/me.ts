import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { schema } from "@nexora/db";
import { generateAndSetAvatar, getMe, organizationsService } from "@nexora/core";
import { setActiveOrganizationSchema } from "@nexora/contracts/modules/organizations/organizations.validation";
import type { AppEnv } from "../lib/context";
import { requireAuth } from "../middleware/auth";
import { UnauthorizedException } from "../lib/errors";
import { issueLineLinkCode } from "./line";

const avatarGenerateSchema = z.object({
  style: z.enum(["initials", "geometric", "soft"]).optional(),
});

function avatarStorage(c: { env: AppEnv["Bindings"] }) {
  return {
    async put(key: string, bytes: Uint8Array, contentType: string) {
      // Avatars are a public bucket — write to R2_PUBLIC so /file can serve them.
      await c.env.R2_PUBLIC.put(key, bytes, { httpMetadata: { contentType } });
    },
    async delete(key: string) {
      await c.env.R2_PUBLIC.delete(key);
    },
  };
}

/**
 * `/api/auth/me` — same payload as Express auth.controller GET /me so the
 * Expo AuthProvider / useAuth().refreshUser ports unchanged.
 *
 * Extra authenticated profile actions live under the same mount:
 *   PUT  /api/auth/me/active-organization
 *   POST /api/auth/me/line-link-code
 *   POST /api/auth/me/line-unlink
 *   POST /api/auth/me/avatar/generate
 */
export const me = new Hono<AppEnv>()
  .get("/", requireAuth, async (c) => {
    const user = c.var.user!;
    try {
      const payload = await getMe(c.var.db, user.id);
      return c.json(payload);
    } catch (e) {
      if (e instanceof Error && e.message === "USER_NOT_FOUND") {
        throw new UnauthorizedException("User not found");
      }
      throw e;
    }
  })
  .put(
    "/active-organization",
    requireAuth,
    zValidator("json", setActiveOrganizationSchema),
    async (c) => {
      const result = await organizationsService.setActiveOrganization(
        c.var.db,
        c.var.user!.id,
        c.req.valid("json").organizationId,
      );
      return c.json({ data: result });
    },
  )
  .post("/line-link-code", requireAuth, async (c) => {
    if (!c.env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN?.trim()) {
      return c.json(
        { error: { code: "NOT_CONFIGURED", message: "LINE Messaging is not configured" } },
        503,
      );
    }
    const data = await issueLineLinkCode({ env: c.env, var: { user: c.var.user! } });
    return c.json({ data });
  })
  .post("/line-unlink", requireAuth, async (c) => {
    await c.var.db
      .update(schema.users)
      .set({ lineUserId: null, updatedAt: new Date().toISOString() })
      .where(eq(schema.users.id, c.var.user!.id));
    return c.json({ data: { success: true } });
  })
  .post("/avatar/generate", requireAuth, zValidator("json", avatarGenerateSchema), async (c) => {
    const { style } = c.req.valid("json");
    const data = await generateAndSetAvatar(
      c.var.db,
      c.var.user!.id,
      {
        AVATAR_GENERATOR_ENABLED: c.env.AVATAR_GENERATOR_ENABLED,
        APP_URL: c.env.APP_URL,
      },
      avatarStorage(c),
      { style },
    );
    return c.json({ data });
  });
