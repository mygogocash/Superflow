import { Hono } from "hono";
import {
  createLineLinkCode,
  handleLineWebhook,
  verifyLineSignature,
  type LineWebhookBody,
} from "@nexora/core";
import { kvSecondaryStorage } from "@nexora/auth";
import type { AppEnv } from "../lib/context";
import { UnauthorizedException } from "../lib/errors";

/**
 * Public LINE surfaces (status + Messaging webhook).
 * Signature auth only — no session required on the webhook.
 */
export const line = new Hono<AppEnv>()
  .get("/status", (c) => {
    const login = Boolean(
      c.env.LINE_LOGIN_CHANNEL_ID?.trim() && c.env.LINE_LOGIN_CHANNEL_SECRET?.trim(),
    );
    const messaging = Boolean(
      c.env.LINE_MESSAGING_CHANNEL_SECRET?.trim() &&
        c.env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN?.trim(),
    );
    return c.json({
      login,
      messaging,
      avatarGenerator: c.env.AVATAR_GENERATOR_ENABLED === "true",
    });
  })
  .post("/webhook", async (c) => {
    const secret = c.env.LINE_MESSAGING_CHANNEL_SECRET?.trim();
    const token = c.env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN?.trim();
    if (!secret || !token) {
      return c.json({ error: { code: "NOT_CONFIGURED", message: "LINE Messaging is not configured" } }, 503);
    }

    const rawBody = await c.req.text();
    const signature = c.req.header("x-line-signature");
    const ok = await verifyLineSignature(rawBody, signature, secret);
    if (!ok) throw new UnauthorizedException("Invalid LINE signature");

    let body: LineWebhookBody;
    try {
      body = JSON.parse(rawBody) as LineWebhookBody;
    } catch {
      return c.json({ error: { code: "BAD_REQUEST", message: "Invalid JSON" } }, 400);
    }

    const store = kvSecondaryStorage(c.env.KV_SESSIONS);
    const result = await handleLineWebhook(
      c.var.db,
      { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: token },
      body,
      store,
    );
    return c.json({ ok: true, handled: result.handled });
  });

/** Authenticated helper used by /api/me/line-link-code. */
export async function issueLineLinkCode(c: {
  env: AppEnv["Bindings"];
  var: { user: { id: string } };
}) {
  const store = kvSecondaryStorage(c.env.KV_SESSIONS);
  return createLineLinkCode(store, c.var.user.id);
}
