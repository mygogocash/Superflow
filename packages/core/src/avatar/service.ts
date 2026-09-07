import { eq } from "drizzle-orm";
import type { Db } from "@nexora/db";
import { schema } from "@nexora/db";
import { BadRequestException, ForbiddenException } from "../http-exception.js";
import {
  type R2Storage,
} from "../lib/r2-storage.js";
import { uploadsService } from "../uploads/index.js";
import {
  generateAvatarSvg,
  type AvatarStyle,
  type GenerateAvatarInput,
} from "./generate.js";

export type AvatarGenerateEnv = {
  AVATAR_GENERATOR_ENABLED?: string;
  APP_URL: string;
};

export async function generateAndSetAvatar(
  db: Db,
  userId: string,
  env: AvatarGenerateEnv,
  storage: R2Storage,
  input: { style?: AvatarStyle } = {},
): Promise<{ avatarUrl: string; style: AvatarStyle }> {
  if (env.AVATAR_GENERATOR_ENABLED !== "true") {
    throw new ForbiddenException("Avatar generator is disabled");
  }

  const [user] = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      name: schema.users.name,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (!user) throw new BadRequestException("User not found");

  const nameParts = (user.name ?? "").trim().split(/\s+/).filter(Boolean);
  const genInput: GenerateAvatarInput = {
    firstName: nameParts[0] ?? null,
    lastName: nameParts.length > 1 ? nameParts[nameParts.length - 1] : null,
    email: user.email,
    style: input.style ?? "initials",
    seed: user.id,
  };
  const generated = generateAvatarSvg(genInput);
  // Workers-safe: base64 without Node Buffer.
  let binary = "";
  for (const b of generated.bytes) binary += String.fromCharCode(b);
  const base64 = btoa(binary);

  const uploaded = await uploadsService.upload(
    db,
    userId,
    env.APP_URL,
    {
      base64,
      originalName: generated.fileName,
      mimeType: generated.contentType,
      bucket: "avatars",
      purpose: "avatar-generator",
      linkedTo: "user",
      linkedId: userId,
    },
    storage,
  );

  await db
    .update(schema.users)
    .set({ avatarUrl: uploaded.url, updatedAt: new Date().toISOString() })
    .where(eq(schema.users.id, userId));

  return { avatarUrl: uploaded.url, style: generated.style };
}
