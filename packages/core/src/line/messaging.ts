export type LineReplyMessage =
  | { type: "text"; text: string }
  | { type: "sticker"; packageId: string; stickerId: string };

export type LineMessagingEnv = {
  LINE_MESSAGING_CHANNEL_ACCESS_TOKEN?: string;
};

async function lineFetch(
  env: LineMessagingEnv,
  path: string,
  body: unknown,
): Promise<{ ok: boolean; status: number }> {
  const token = env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN?.trim();
  if (!token) return { ok: false, status: 503 };
  const res = await fetch(`https://api.line.me/v2/bot${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status };
}

export async function replyMessage(
  env: LineMessagingEnv,
  replyToken: string,
  messages: LineReplyMessage[],
) {
  return lineFetch(env, "/message/reply", { replyToken, messages: messages.slice(0, 5) });
}

export async function pushMessage(
  env: LineMessagingEnv,
  to: string,
  messages: LineReplyMessage[],
) {
  return lineFetch(env, "/message/push", { to, messages: messages.slice(0, 5) });
}

export async function getLineProfile(
  env: LineMessagingEnv,
  lineUserId: string,
): Promise<{ displayName?: string; pictureUrl?: string; statusMessage?: string } | null> {
  const token = env.LINE_MESSAGING_CHANNEL_ACCESS_TOKEN?.trim();
  if (!token) return null;
  const res = await fetch(`https://api.line.me/v2/bot/profile/${encodeURIComponent(lineUserId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  return (await res.json()) as { displayName?: string; pictureUrl?: string; statusMessage?: string };
}
