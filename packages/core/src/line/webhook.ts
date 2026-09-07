import { eq } from "drizzle-orm";
import type { Db } from "@nexora/db";
import { schema } from "@nexora/db";
import { replyMessage, type LineMessagingEnv } from "./messaging.js";

export type LineWebhookEvent = {
  type: string;
  replyToken?: string;
  source?: { type?: string; userId?: string };
  message?: { type?: string; text?: string; id?: string };
  timestamp?: number;
};

export type LineWebhookBody = {
  destination?: string;
  events?: LineWebhookEvent[];
};

export type LineLinkStore = {
  get(key: string): Promise<string | null>;
  getAndDelete(key: string): Promise<string | null>;
  set(key: string, value: string, ttl?: number): Promise<void>;
};

const LINK_PREFIX = "line:link:";
const LINK_TTL_SEC = 10 * 60;

function helpText(linked: boolean): string {
  if (!linked) {
    return [
      "Welcome to Manut on LINE.",
      "",
      "Your LINE account is not linked yet.",
      "1. Open Manut → Profile → Link LINE",
      "2. Copy the 6-digit code",
      "3. Send: link 123456",
      "",
      "Commands: help",
    ].join("\n");
  }
  return [
    "Manut LINE bot",
    "",
    "Commands:",
    "• help — this message",
    "• status — link status",
    "• unlink — remove LINE link",
    "",
    "Approvals and leave pushes arrive here when enabled.",
  ].join("\n");
}

async function findUserByLineId(db: Db, lineUserId: string) {
  const [row] = await db
    .select({ id: schema.users.id, name: schema.users.name, isActive: schema.users.isActive })
    .from(schema.users)
    .where(eq(schema.users.lineUserId, lineUserId))
    .limit(1);
  return row ?? null;
}

async function logEvent(
  db: Db,
  input: {
    lineUserId: string;
    userId?: string | null;
    eventType: string;
    messageType?: string | null;
    preview?: string | null;
    raw?: unknown;
  },
) {
  await db.insert(schema.lineMessageLogs).values({
    id: crypto.randomUUID(),
    lineUserId: input.lineUserId,
    userId: input.userId ?? null,
    eventType: input.eventType,
    direction: "inbound",
    messageType: input.messageType ?? null,
    preview: input.preview?.slice(0, 280) ?? null,
    raw: input.raw ?? null,
  });
}

export async function createLineLinkCode(
  store: LineLinkStore,
  userId: string,
): Promise<{ code: string; expiresInSec: number }> {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await store.set(`${LINK_PREFIX}${code}`, userId, LINK_TTL_SEC);
  return { code, expiresInSec: LINK_TTL_SEC };
}

export async function handleLineWebhook(
  db: Db,
  env: LineMessagingEnv,
  body: LineWebhookBody,
  store: LineLinkStore,
): Promise<{ handled: number }> {
  const events = body.events ?? [];
  let handled = 0;

  for (const event of events) {
    const lineUserId = event.source?.userId;
    if (!lineUserId) continue;

    const user = await findUserByLineId(db, lineUserId);
    await logEvent(db, {
      lineUserId,
      userId: user?.id,
      eventType: event.type,
      messageType: event.message?.type,
      preview: event.message?.text ?? event.type,
      raw: { type: event.type, messageType: event.message?.type },
    });

    if (event.type === "follow" && event.replyToken) {
      await replyMessage(env, event.replyToken, [{ type: "text", text: helpText(Boolean(user)) }]);
      handled += 1;
      continue;
    }

    if (event.type !== "message" || event.message?.type !== "text" || !event.replyToken) {
      continue;
    }

    const text = (event.message.text ?? "").trim();
    const lower = text.toLowerCase();

    if (lower === "help" || lower === "?" || lower === "คำสั่ง") {
      await replyMessage(env, event.replyToken, [{ type: "text", text: helpText(Boolean(user)) }]);
      handled += 1;
      continue;
    }

    const linkMatch = text.match(/^(?:link|เชื่อม)\s*[:=\s]?\s*(\d{6})\s*$/i);
    if (linkMatch) {
      const code = linkMatch[1]!;
      const userId = await store.getAndDelete(`${LINK_PREFIX}${code}`);
      if (!userId) {
        await replyMessage(env, event.replyToken, [
          { type: "text", text: "That link code is invalid or expired. Generate a new one in Manut → Profile." },
        ]);
        handled += 1;
        continue;
      }
      await db
        .update(schema.users)
        .set({ lineUserId, updatedAt: new Date().toISOString() })
        .where(eq(schema.users.id, userId));
      await replyMessage(env, event.replyToken, [
        { type: "text", text: "Linked. You will receive Manut notifications here when enabled." },
      ]);
      handled += 1;
      continue;
    }

    if (lower === "unlink" || lower === "ยกเลิกการเชื่อม") {
      if (!user) {
        await replyMessage(env, event.replyToken, [{ type: "text", text: "This LINE account is not linked." }]);
      } else {
        await db
          .update(schema.users)
          .set({ lineUserId: null, updatedAt: new Date().toISOString() })
          .where(eq(schema.users.id, user.id));
        await replyMessage(env, event.replyToken, [{ type: "text", text: "Unlinked. Send a new link code anytime." }]);
      }
      handled += 1;
      continue;
    }

    if (lower === "status") {
      await replyMessage(env, event.replyToken, [
        {
          type: "text",
          text: user
            ? `Linked as ${user.name} (${user.isActive ? "active" : "inactive"}).`
            : "Not linked. Send: link 123456",
        },
      ]);
      handled += 1;
      continue;
    }

    await replyMessage(env, event.replyToken, [{ type: "text", text: helpText(Boolean(user)) }]);
    handled += 1;
  }

  return { handled };
}
