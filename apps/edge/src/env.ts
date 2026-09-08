import type { LeaveApprovalParams } from "./workflows/leave-approval";

/** Worker bindings + vars. Keep in sync with wrangler.jsonc. */
export type Bindings = {
  ASSETS: Fetcher;
  HYPERDRIVE: Hyperdrive;
  KV_SESSIONS: KVNamespace;
  KV_CACHE: KVNamespace;
  R2_PUBLIC: R2Bucket;
  R2_PRIVATE: R2Bucket;
  JOBS_QUEUE: Queue;
  /** D1 sidecar (presence / workflow ids / handbook chunks). Not the ERP DB. */
  EDGE_DB?: D1Database;
  PRESENCE?: DurableObjectNamespace;
  LEAVE_APPROVAL?: Workflow<LeaveApprovalParams>;
  /** Optional — Vectorize has no local simulator; omit in wrangler.dev. */
  HANDBOOK?: VectorizeIndex;
  AI?: Ai;
  RATE_LIMITER_LOGIN?: RateLimit;
  RATE_LIMITER_GLOBAL?: RateLimit;
  // vars
  APP_URL: string;
  TRUSTED_ORIGINS?: string;
  POSTHOG_HOST: string;
  POSTHOG_ASSETS_HOST: string;
  MAGIC_LINK_ALLOWED_ROLES?: string;
  /** Empty = fail-open. Set both to enforce Cloudflare Access on /api/*. */
  CF_ACCESS_AUD?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  // secrets (wrangler secret put …)
  BETTER_AUTH_SECRET: string;
  /** Better Auth Dash (dash.better-auth.com) API key. Unset = dash plugin off. */
  BETTER_AUTH_API_KEY?: string;
  TURNSTILE_SECRET?: string;
  // Transactional email via Resend (https://api.resend.com/emails).
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  VALIDATOR_MONITOR_GITHUB_TOKEN?: string;
  VALIDATOR_MONITOR_REPO?: string;
  VALIDATOR_MONITOR_BRANCH?: string;
  VALIDATOR_MONITOR_FILE?: string;
  CRON_SECRET?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  MARKETING_ANALYTICS_ENABLED?: string;
  ANTHROPIC_API_KEY?: string;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  GEMINI_API_KEY?: string;
  BOT_API_CLIENT_ID?: string;
  BOT_API_BASE_URL?: string;
  BOT_FX_CURRENCIES?: string;
  BOT_FX_UNITS?: string;
  FX_FALLBACK_ENABLED?: string;
  FX_FALLBACK_API_KEY?: string;
  FX_FALLBACK_BASE_URL?: string;
  ACCOUNTING_FIXED_ASSETS?: string;
  ACCOUNTING_GL_POSTING?: string;
  /** Fail-closed: avatar generator routes only when === "true". */
  AVATAR_GENERATOR_ENABLED?: string;
  /** Fail-closed org scope for users + memberships when === "true". */
  ORG_TENANCY_ENFORCED?: string;
  /** LINE Login (Better Auth socialProviders.line). Unset = login button hidden. */
  LINE_LOGIN_CHANNEL_ID?: string;
  LINE_LOGIN_CHANNEL_SECRET?: string;
  /** LINE Messaging API (OA webhook + reply/push). */
  LINE_MESSAGING_CHANNEL_SECRET?: string;
  LINE_MESSAGING_CHANNEL_ACCESS_TOKEN?: string;
};

/** Minimal shape of the Rate Limiting binding (not yet in workers-types). */
export type RateLimit = { limit(options: { key: string }): Promise<{ success: boolean }> };
