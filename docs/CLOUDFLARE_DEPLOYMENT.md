# Cloudflare deployment — Manut edge

Provisioning and deploy notes for `apps/edge` + `apps/edge-jobs`. **The GCP
Cloud Run and Vercel pipelines were retired 2026-09** — the edge is the only
deploy target, deployed by Depot CI (`.depot/workflows/deploy-edge-*`) to
`staging.manut.xyz` / `manut.xyz`. Binding IDs in `wrangler.jsonc` are
placeholders (`REPLACE_WITH_*`) until the one-time provisioning in
`docs/ops/CLOUDFLARE_PROVISIONING.md` is run against the company Cloudflare
account.

## Prerequisites (founder)

1. Workers Paid on the Manut Cloudflare account.
2. Zone `manut.xyz` on Cloudflare (import GoDaddy DNS first; keep
   Vercel CNAMEs for `intranet.` / `staging-intranet.` until cutover).
3. `wrangler login` against that account.
4. Staging Supabase Postgres reachable for Hyperdrive (direct `5432` or
   Supavisor session mode).

## One-time staging provision

Run from repo root with wrangler authenticated. Capture each returned `id` into
`apps/edge/wrangler.jsonc` / `apps/edge-jobs/wrangler.jsonc` `env.staging`.

```bash
# Hyperdrive → staging Postgres (use DIRECT / session URL, not transaction pooler)
npx wrangler hyperdrive create intranet-staging \
  --connection-string="$STAGING_DIRECT_URL"

# KV
npx wrangler kv namespace create intranet-staging-sessions
npx wrangler kv namespace create intranet-staging-cache

# R2
npx wrangler r2 bucket create intranet-staging-public
npx wrangler r2 bucket create intranet-staging-private

# Queues (+ DLQ)
npx wrangler queues create intranet-jobs-staging
npx wrangler queues create intranet-jobs-dlq-staging

# D1 sidecar (NOT the ERP database — Hyperdrive → Postgres stays SoT)
npx wrangler d1 create intranet-edge-staging
npx wrangler d1 migrations apply EDGE_DB --local --env staging

# Rate limiting namespaces are configured in wrangler `unsafe.bindings`
# (RATE_LIMITER_LOGIN / RATE_LIMITER_GLOBAL). Confirm Workers Paid plan.

# Durable Objects + Workflows are declared in wrangler.jsonc and created on first deploy.

# Optional: Vectorize + Workers AI (no local simulator — omit from wrangler.dev)
# npx wrangler vectorize create intranet-handbook --dimensions=768 --metric=cosine
# Then bind HANDBOOK + AI with remote: true when the founder wants semantic search.

# Optional: Cloudflare Access / Zero Trust
# Set CF_ACCESS_AUD + CF_ACCESS_TEAM_DOMAIN on the Worker. Empty AUD = fail-open.
```

**Access fail-open (intentional until Zero Trust cutover):** when `CF_ACCESS_AUD`
is unset, `requireAccess` skips JWT checks so local/staging/prod keep working
without a team domain. Residual risk is accepted for now; compensating controls
are Bot Fight Mode, Turnstile on auth flows, login + global rate limits, and a
tight `TRUSTED_ORIGINS` list (`APP_URL` + `intranet://` / Expo localhost). Set
both Access vars when enabling Zero Trust so the Worker fails closed. See
`docs/ops/SECURITY_REVIEW_LOG.md` Wave 1 matrix.

### Secrets (staging)

Depot CI puts these after `wrangler deploy --env staging` (secrets cannot exist
before the Worker script exists). Required:

| Secret | Notes |
|---|---|
| `BETTER_AUTH_SECRET` | **Required** — deploy fails closed if unset |
| `BETTER_AUTH_API_KEY` | Optional — Better Auth Dash; skipped when unset |
| `EMAIL_SERVICE_API_KEY` | Optional until magic-link / reset email is used |

```bash
cd apps/edge
npx wrangler secret put BETTER_AUTH_SECRET --env staging
# optional:
npx wrangler secret put BETTER_AUTH_API_KEY --env staging
npx wrangler secret put EMAIL_SERVICE_API_KEY --env staging
```

Expo on `staging.manut.xyz` uses Better Auth (`authClient.signIn.email` →
cookie/Bearer session → `GET /api/auth/me`). Local Express `:3001` still uses
JWT `/auth/login`.

### Bot Fight Mode

Zone `manut.xyz` has **Bot Fight Mode** on (cannot be skipped per-hostname via
WAF). Browsers pass the JS challenge; bare `curl` to staging often gets **403**.
Use a real browser (or Cloudflare Access / Super Bot Fight Mode with Skip rules)
for API smoke tests — do **not** turn Bot Fight Mode off to make curl work.

### Custom domain (staging)

`staging.manut.xyz` is declared in
`apps/edge/wrangler.jsonc` `env.staging.routes`. After the zone is on Cloudflare:

```bash
pnpm --filter @nexora/edge deploy:staging
```

## Local development

```bash
pnpm --filter @nexora/app export:web   # writes apps/app/dist for ASSETS
pnpm --filter @nexora/edge dev
pnpm --filter @nexora/edge-jobs dev
```

`hyperdrive.localConnectionString` in `wrangler.jsonc` points at local Postgres.

## CI / deploy

| Workflow | Trigger | Action |
|---|---|---|
| `pr-checks.yml` | PR / push `main`\|`dev` | edge type-check, workers vitest, `drizzle-kit check`, `expo export`, `wrangler deploy --dry-run` |
| `deploy-edge-staging.yml` | push `dev` | migrate → Expo export → wrangler deploy staging (edge + edge-jobs) |
| Existing `deploy-staging.yml` / `deploy.yml` | unchanged until Phase 9 | Cloud Run + Vercel keep serving users |

## Production

Same provision with `intranet-prod-*` names. Leave `edge-jobs` Cron **disabled**
in production until Phase 9 step 2 so Cloud Scheduler does not double-fire.

## Scheduler snapshot (Phase 0 leftover)

```bash
gcloud auth login
gcloud scheduler jobs list --project=tbh-nexora --location=asia-southeast1 --format=json \
  > docs/ops/scheduler-snapshot-2026-09.json
```

Reconcile hours in `apps/edge-jobs/src/schedule.ts` against that file.

## Implementation progress

Last updated 2026-09-05 (branch `claude/cf-edge-migration`):

- **Phase 0** — spikes PASS (documented in plan).
- **Phase 1** — `packages/db|contracts|auth`, `apps/edge|edge-jobs|app` scaffold, CI dry-run + `deploy-edge-staging.yml`, RLS migration `0002_rls`, docs here.
- **Phase 2** — Better Auth (bcrypt rehash, magic-link role gate, Turnstile, email adapter), `/api/auth/me`, users/roles list, dashboard stats stub, Expo auth screens + `useAuth().refreshUser`.
- **Phase 3 (Wave B complete)** — all company/content modules on edge + Expo list pages: `wall`, `news`, `company-dates`, `holidays`, `articles`, `blogs`, `docs` (extract stubbed 501), `learning`, `career`, `applications`, `policies`, `benefits`, `certificates` (PDF→R2 private + stream download), `performance`, `survey`, `survey-forms` (announce→wall/news/dates; email notify stubbed), `office`.
- **Phase 4 (complete for code)** — `leave`, `cash-advance`, `travel`, `expenses`, `approval-chains`, `payroll` (encrypt stubbed), `hrms`, `exchange-rates`, `vendors`, `ninety-day`, `visa`, `visa-kb`, `visa-checklist`, `accounts`.
- **Phase 5 (complete for code)** — `projects` (native-mirror heal), `helpdesk`, full Sales/Investor CRM family, team CRMs (`it-crm`, `legal-crm`, `product-crm`, `qa-crm`, `accounting-crm`, `voucher-crm`), `proposals`, `partners`, `validator-monitor`, `business-units`, IT ops modules.
- **Phase 6 (phase-1 code)** — `/api/accounting` COA/journals/invoices/bills/quotes/fiscal periods; FA **read-only** behind fail-closed `ACCOUNTING_FIXED_ASSETS`. Many Express paths still 501; FA writes/reports deferred.
- **Phase 7 (complete for code)** — `uploads` (R2), `messages` (REST + `/ws/messages/:channelId` Presence DO + typing broadcast), `push` (CRUD; send stubbed), marketing family (partial), `aria` (CRUD/tools; chat 501 without AI keys), `cron` + edge-jobs `http-cron.ts` fan-out + sidecar queue names.
- **Sidecar stack (templates)** — D1 Drizzle (`packages/db/src/edge`), leave Workflow reminders (does not approve), handbook search (`/api/handbook`) with Vectorize/AI optional, Access middleware fail-open, Expo `createEdgeClient` (`hono/client`).
- **Phase 8 (tooling landed)** — `scripts/route-parity.mjs`, `packages/db/scripts/migrate-storage.mjs`, `docs/parity/`, ADR `docs/adr/0001-cloudflare-edge-rewrite.md`. Live staging UAT / load test / Logpush wait on founder CF provision.
- **Phase 9 (runbook only)** — `docs/ops/CUTOVER_RUNBOOK.md`. No live cutover without founder sign-off. `docs/GCP_DEPLOYMENT.md` marked retired.

Founder blockers still required for staging/cutover: company CF account/zone NS, Hyperdrive provision, `gcloud scheduler` snapshot.

## Route parity snapshot

Run `pnpm route-parity` anytime. Latest (2026-09-05): **Express 1304 vs Edge ~1150+ (~88%+)** — accounting 101, team CRMs ~23 each, it-access 17, users 15, legal attachments/shares live.
Missing depth concentrated in accounting (XL), DocuSign adapters, integrations OAuth, admin/usage, ARIA chat.

