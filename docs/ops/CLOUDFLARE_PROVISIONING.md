# Cloudflare provisioning — one-time runbook

Manut runs entirely on Cloudflare Workers. This is the one-time, per-environment
provisioning that has to happen before CI deploys can succeed: the wrangler
configs reference real resource IDs that only exist after these commands.

Run from `apps/edge` (or `apps/edge-jobs` where noted) with a wrangler that is
logged in (`npx wrangler login`) or `CLOUDFLARE_API_TOKEN` exported. Do it for
**staging** first, verify, then repeat for **production**.

> The account must own the `manut.xyz` zone — the `custom_domain: true` routes
> in the wrangler configs provision DNS + edge certs on first deploy.

## 1. Staging (`--env staging`)

```bash
# Hyperdrive → Neon APAC (staging). DONE: id 2531da29a59f4890bf8817697f5d350d
# Recreate only after a password rotate (unpooled URL — Hyperdrive pools).
# See docs/ops/NEON_STAGING.md. Do not use the -pooler hostname here.
npx wrangler hyperdrive create staging-manut-edge-neon \
  --connection-string "$STAGING_DIRECT_URL"
```

Greenfield Neon schema (once per empty DB):

```bash
DATABASE_URL="$STAGING_DIRECT_URL" pnpm --filter @nexora/db db:bootstrap-greenfield
DATABASE_URL="$STAGING_DIRECT_URL" pnpm --filter @nexora/db db:migrate
```

```bash
# KV
npx wrangler kv namespace create KV_SESSIONS --env staging
npx wrangler kv namespace create KV_CACHE --env staging

# R2 — names must match apps/edge/wrangler.jsonc env.staging.r2_buckets
npx wrangler r2 bucket create intranet-staging-public
npx wrangler r2 bucket create intranet-staging-private

# Queues (producer + consumer + DLQ)
npx wrangler queues create intranet-jobs-staging
npx wrangler queues create intranet-jobs-dlq-staging

# D1 (edge sidecar tables)
npx wrangler d1 create intranet-edge-staging
```

Then `wrangler d1 migrations apply intranet-edge-staging --env staging --remote`
to lay down `packages/db/d1/migrations`.

### Paste the IDs

Replace every `REPLACE_WITH_STAGING_*` in:
- `apps/edge/wrangler.jsonc` (hyperdrive, KV_SESSIONS/KV_CACHE, D1)
- `apps/edge-jobs/wrangler.jsonc` (hyperdrive, KV_CACHE)

R2 buckets and queues are referenced **by name** — no IDs to paste.

## 2. Staging secrets

`apps/edge` (see `src/env.ts` for the full list; the required/likely ones):

```bash
npx wrangler secret put BETTER_AUTH_SECRET --env staging
npx wrangler secret put BETTER_AUTH_API_KEY --env staging   # Better Auth Dash
npx wrangler secret put RESEND_API_KEY --env staging        # transactional email (Resend)
npx wrangler secret put EMAIL_FROM --env staging            # Resend-verified sender, e.g. "Manut <noreply@manut.xyz>"
npx wrangler secret put TURNSTILE_SECRET --env staging      # when captcha is enabled
npx wrangler secret put ANTHROPIC_API_KEY --env staging     # ARIA
npx wrangler secret put GEMINI_API_KEY --env staging        # ARIA
```

`apps/edge-jobs`: same secrets its jobs read — run `wrangler secret list
--env staging` after the first deploy and fill what's flagged missing.

## 3. First staging deploy

Either promote `main` → `preview` (Depot CI deploys) or run manually:

```bash
pnpm --filter @nexora/db db:migrate          # uses STAGING_DIRECT_URL (Neon unpooled)
pnpm --filter @nexora/app export:web
pnpm --filter @nexora/edge deploy:staging
pnpm --filter @nexora/edge-jobs deploy:staging
```

Verify: `https://staging.manut.xyz/api/auth/ok` and the SPA at
`https://staging.manut.xyz`. First hit on the custom domain provisions DNS +
the edge certificate — expect a short warm-up.

## 4. Production (`--env production`)

Repeat steps 1–3 with the prod names in the config (`intranet-edge`,
`manut-jobs-prod`, …) and:

```bash
npx wrangler secret put BETTER_AUTH_SECRET --env production
# …same secret list as staging
```

Production deploys run from CI on pushes to the `production` branch
(`.depot/workflows/deploy-edge-production.yml`), including
`prisma migrate deploy` against `DIRECT_URL`.

## 5. Done checklist

- [ ] No `REPLACE_WITH_*` left in either wrangler config
- [ ] `wrangler secret list` shows the required secrets per Worker per env
- [ ] `staging.manut.xyz` serves the SPA + answers `/api/auth/ok`
- [ ] `manut.xyz` does the same after the production promote
- [ ] Depot CI (`.depot/workflows/`) has `CLOUDFLARE_API_TOKEN` +
      `CLOUDFLARE_ACCOUNT_ID` + `STAGING_DIRECT_URL`/`DATABASE_URL`/`DIRECT_URL`
      imported so the deploy workflows run unattended
