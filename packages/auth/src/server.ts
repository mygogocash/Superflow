import { dash } from "@better-auth/infra";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthMiddleware } from "better-auth/api";
import { magicLink } from "better-auth/plugins";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import type { Db } from "@nexora/db";
import { schema } from "@nexora/db";
import { isMagicLinkEligible } from "./magic-link";

export type AuthEnv = {
  BETTER_AUTH_SECRET: string;
  /** Better Auth Dash (dash.better-auth.com) API key. Unset = dash plugin off. */
  BETTER_AUTH_API_KEY?: string;
  /** Public origin of the app, e.g. https://manut.xyz */
  APP_URL: string;
  /** Extra trusted origins (native app scheme, staging hosts). */
  TRUSTED_ORIGINS?: string;
  /** Comma-separated role names allowed to request magic links (empty = disabled). */
  MAGIC_LINK_ALLOWED_ROLES?: string;
  /** LINE Login channel (LINE Developers Console). Unset = LINE Login off. */
  LINE_LOGIN_CHANNEL_ID?: string;
  LINE_LOGIN_CHANNEL_SECRET?: string;
};

export type AuthEmailSender = {
  sendMagicLink(input: { email: string; url: string }): Promise<void>;
  sendResetPassword(input: { email: string; url: string }): Promise<void>;
};

export type SecondaryStorage = {
  get(key: string): Promise<string | null>;
  getAndDelete(key: string): Promise<string | null>;
  /** Atomically (+approx on KV) increment; TTL applied only when key is created. */
  increment(key: string, ttl: number): Promise<number>;
  set(key: string, value: string, ttl?: number): Promise<void>;
  delete(key: string): Promise<void>;
};

/** Adapts a Workers KV namespace to Better Auth's secondaryStorage contract. */
export function kvSecondaryStorage(kv: KVNamespace): SecondaryStorage {
  return {
    get: (key) => kv.get(key),
    async getAndDelete(key) {
      const value = await kv.get(key);
      if (value !== null) await kv.delete(key);
      return value;
    },
    async increment(key, ttl) {
      const current = Number((await kv.get(key)) ?? "0");
      const next = (Number.isFinite(current) ? current : 0) + 1;
      const opts = next === 1 && ttl ? { expirationTtl: Math.max(60, ttl) } : undefined;
      await kv.put(key, String(next), opts);
      return next;
    },
    set: (key, value, ttl) => kv.put(key, value, ttl ? { expirationTtl: Math.max(60, ttl) } : undefined),
    delete: (key) => kv.delete(key),
  };
}

const LEGACY_BCRYPT_PREFIX = "$2";

export function parseMagicLinkAllowedRoles(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function syncLineUserId(
  db: Db,
  input: { userId: string; providerId: string; accountId: string },
) {
  if (input.providerId !== "line" || !input.accountId) return;
  // Clear any other Manut user that currently holds this LINE subject.
  await db
    .update(schema.users)
    .set({ lineUserId: null, updatedAt: new Date().toISOString() })
    .where(eq(schema.users.lineUserId, input.accountId));
  await db
    .update(schema.users)
    .set({ lineUserId: input.accountId, updatedAt: new Date().toISOString() })
    .where(eq(schema.users.id, input.userId));
}

/**
 * Better Auth server bound to the EXISTING `users` table (ids preserved from
 * Supabase Auth). Migrated Supabase users carry bcrypt hashes in
 * `account.password`; they are verified with bcrypt and re-hashed to Better
 * Auth's scrypt after the first successful sign-in.
 */
export function createAuth(
  env: AuthEnv,
  db: Db,
  secondaryStorage?: SecondaryStorage,
  email?: AuthEmailSender,
) {
  const trusted = (env.TRUSTED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const magicRoles = parseMagicLinkAllowedRoles(env.MAGIC_LINK_ALLOWED_ROLES);
  const lineLoginConfigured = Boolean(
    env.LINE_LOGIN_CHANNEL_ID?.trim() && env.LINE_LOGIN_CHANNEL_SECRET?.trim(),
  );

  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        users: schema.users,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
      },
    }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.APP_URL,
    basePath: "/api/auth",
    trustedOrigins: [env.APP_URL, ...trusted],
    secondaryStorage,
    // Better Auth omits `session` / `verification` from its internal schema when
    // secondaryStorage is set and these flags are false — then sign-in / magic-link
    // / dash hooks that still touch the adapter throw
    // `Model "session" not found in schema` (better-auth#9370). Dual-write to
    // Postgres + KV keeps the schema intact; KV remains the fast path.
    session: {
      storeSessionInDatabase: true,
    },
    verification: {
      storeInDatabase: true,
    },
    user: {
      modelName: "users",
      fields: {
        emailVerified: "email_verified",
        image: "avatar_url",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ["line"],
        // Admin-provisioned users may not have email_verified stamped; LINE
        // still needs to attach to the existing invite-only row.
        allowDifferentEmails: false,
      },
    },
    socialProviders: lineLoginConfigured
      ? {
          line: {
            clientId: env.LINE_LOGIN_CHANNEL_ID!.trim(),
            clientSecret: env.LINE_LOGIN_CHANNEL_SECRET!.trim(),
            // Invite-only: never mint a new users row from LINE Login.
            disableSignUp: true,
          },
        }
      : {},
    advanced: {
      database: { generateId: () => crypto.randomUUID() },
      useSecureCookies: env.APP_URL.startsWith("https://"),
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      password: {
        hash: (password) => hashPassword(password),
        verify: ({ hash, password }) =>
          hash.startsWith(LEGACY_BCRYPT_PREFIX) ? bcrypt.compare(password, hash) : verifyPassword({ hash, password }),
      },
      sendResetPassword: email
        ? async ({ user, url }) => {
            await email.sendResetPassword({ email: user.email, url });
          }
        : undefined,
    },
    databaseHooks: {
      account: {
        create: {
          after: async (account) => {
            await syncLineUserId(db, {
              userId: account.userId,
              providerId: account.providerId,
              accountId: account.accountId,
            });
          },
        },
        update: {
          after: async (account) => {
            if (!account.userId || !account.providerId || !account.accountId) return;
            await syncLineUserId(db, {
              userId: account.userId,
              providerId: account.providerId,
              accountId: account.accountId,
            });
          },
        },
      },
    },
    plugins: [
      magicLink({
        disableSignUp: true,
        sendMagicLink: async ({ email: to, url }) => {
          // Anti-enumeration: silently no-op when ineligible or email is unset
          // (matches Express auth.service requestEmailAuthLink).
          if (!email) return;
          const [user] = await db
            .select({ id: schema.users.id, isActive: schema.users.isActive })
            .from(schema.users)
            .where(eq(schema.users.email, to.toLowerCase()))
            .limit(1);
          if (!user?.isActive) return;
          const roleRows = await db
            .select({ name: schema.roles.name, isSystem: schema.roles.isSystem })
            .from(schema.userRoles)
            .innerJoin(schema.roles, eq(schema.roles.id, schema.userRoles.roleId))
            .where(eq(schema.userRoles.userId, user.id));
          if (!isMagicLinkEligible(roleRows, magicRoles)) return;
          await email.sendMagicLink({ email: to, url });
        },
      }),
      // Better Auth Dash connection (dashboard analytics / user management).
      // The key comes from the BETTER_AUTH_API_KEY binding — process.env does
      // not exist on Workers, so it is passed explicitly. Off when unset so
      // local dev without a dash project keeps working.
      ...(env.BETTER_AUTH_API_KEY ? [dash({ apiKey: env.BETTER_AUTH_API_KEY })] : []),
    ],
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-in/email" || !ctx.context.newSession) return;
        const password = (ctx.body as { password?: string } | undefined)?.password;
        if (!password) return;
        const userId = ctx.context.newSession.user.id;
        const accounts = await ctx.context.internalAdapter.findAccounts(userId);
        const credential = accounts.find((a) => a.providerId === "credential");
        if (credential?.password?.startsWith(LEGACY_BCRYPT_PREFIX)) {
          await ctx.context.internalAdapter.updatePassword(userId, await hashPassword(password));
        }
      }),
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
export type SessionUser = Auth["$Infer"]["Session"]["user"];
