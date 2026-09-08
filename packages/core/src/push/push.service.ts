import type { Db } from "@nexora/db";
import { BadRequestException } from "../http-exception.js";
import * as repo from "./push.repository.js";

export type PushEnv = {
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
};

export function isEnabled(env: PushEnv = {}) {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
}

export function getPublicKey(env: PushEnv = {}) {
  if (!isEnabled(env)) throw new BadRequestException("Push notifications are not configured");
  return env.VAPID_PUBLIC_KEY!;
}

export async function getConfig(db: Db, userId: string, env: PushEnv = {}) {
  const enabled = isEnabled(env);
  return {
    enabled,
    publicKey: enabled ? env.VAPID_PUBLIC_KEY! : null,
    deviceCount: await repo.countForUser(db, userId),
  };
}

export async function subscribe(
  db: Db,
  userId: string,
  input: { endpoint: string; keys: { p256dh: string; auth: string }; userAgent?: string | null },
) {
  const row = await repo.upsertSubscription(db, {
    userId,
    endpoint: input.endpoint,
    p256dh: input.keys.p256dh,
    auth: input.keys.auth,
    userAgent: input.userAgent,
  });
  // Never echo push auth / p256dh material back to the client.
  return {
    id: row.id,
    endpoint: row.endpoint,
    userAgent: row.userAgent ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function unsubscribe(db: Db, userId: string, endpoint: string) {
  return repo.deleteByEndpoint(db, userId, endpoint);
}

export async function unsubscribeAll(db: Db, userId: string) {
  return repo.deleteAllForUser(db, userId);
}

/** Edge stub — web-push delivery not wired on Workers yet. */
export async function sendToUsers(
  _db: Db,
  _userIds: string[],
  _payload: { title: string; body: string; url?: string; tag?: string },
  _env: PushEnv = {},
) {
  return { sent: 0, failed: 0, skipped: true, reason: "push delivery stubbed on edge" };
}
