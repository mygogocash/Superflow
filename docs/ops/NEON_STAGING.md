# Neon staging (APAC) — greenfield Hyperdrive

**Project ID:** `patient-mode-86465099` (Depot var `NEON_PROJECT_ID`)  
**Primary branch:** `production` (`br-billowing-shadow-b35zxukk`)  
**Region:** `aws-ap-southeast-1`  
**DB name:** `neondb`  
**Hyperdrive (staging):** `2531da29a59f4890bf8817697f5d350d` (`staging-manut-edge-neon`, GoGoCash account)  
**Ledger:** Drizzle-only (`drizzle.__drizzle_migrations`) — do **not** run Prisma migrate on this database.  
**Data:** greenfield (empty business data; seed Better Auth users separately).

## Connection strings

Neon gives two URLs. Map them like this:

| Neon label | Use for | Depot / local env |
|---|---|---|
| **Unpooled** (`ep-….aws.neon.tech`, no `-pooler`) | Drizzle migrate, bootstrap, Hyperdrive origin | `STAGING_DIRECT_URL` / `DIRECT_URL` |
| **Pooled** (`ep-…-pooler.…`) | Optional direct app use (not Hyperdrive) | `STAGING_DATABASE_URL` if needed |

Strip `channel_binding=require` for Workers / `postgres.js` / Hyperdrive. Keep `sslmode=require`. Use a real query-string parser (Python `urllib.parse`) — naive sed that deletes `?channel_binding=require` leaves `…/neondb&sslmode=require`, which `postgres.js` treats as the database name and migrate fails with `3D000`.

Hyperdrive already pools — point it at the **unpooled** Neon URL so you do not double-pool.

## One-time schema bootstrap (already done on this project)

On an empty Neon DB:

```bash
cd packages/db
DATABASE_URL="$STAGING_DIRECT_URL" pnpm db:bootstrap-greenfield
DATABASE_URL="$STAGING_DIRECT_URL" pnpm db:migrate
# second migrate must be a no-op
DATABASE_URL="$STAGING_DIRECT_URL" pnpm db:migrate
```

`db:bootstrap-greenfield` applies the commented `0000_*` DDL **without** editing the file on disk (preserves baseline hashes for existing Supabase DBs). It rewrites known bad introspect defaults (`{"RAY"}`, wrong index opclasses).

Do **not** run `db:migrate-auth` / `migrate-supabase-auth.mjs` — Neon has no `auth.users`.

## Hyperdrive (done)

Created via Cloudflare API on account GoGoCash:

- name: `staging-manut-edge-neon`
- id: `2531da29a59f4890bf8817697f5d350d` (committed in `apps/edge` + `apps/edge-jobs` wrangler staging)

Origin is the **unpooled** Neon host. Caching disabled (OLTP).

Re-create only if the origin password rotates again:

```bash
cd apps/edge
npx wrangler hyperdrive create staging-manut-edge-neon \
  --connection-string "$STAGING_DIRECT_URL"
```

Then paste the new id into both wrangler staging `hyperdrive` bindings.

Set Depot secret `STAGING_DIRECT_URL` to the current unpooled Neon URL (password was rotated 2026-09-07 — update the secret if it still has the old password).

## Seed users (Better Auth admin)

Greenfield Neon has no `auth.users`. After schema bootstrap + migrate:

```bash
cd packages/db
SEED_ADMIN_PASSWORD='…min 12 chars…' \
  DATABASE_URL="$STAGING_DIRECT_URL" \
  pnpm db:seed-better-auth-admin
# second run is idempotent (rotates credential password hash)
SEED_ADMIN_PASSWORD='…' DATABASE_URL="$STAGING_DIRECT_URL" pnpm db:seed-better-auth-admin
```

Creates (or updates):

| Row | Notes |
|---|---|
| `entities` code `TH` | TBH Thailand |
| `roles` name `Admin` | `is_system=true` (Admin bypass) |
| `users` `admin@manut.xyz` | TBH Admin, email verified, active |
| `user_roles` | Admin ↔ user |
| `account` | `providerId=credential`, `issuer=local:credential`, bcrypt password |

Override email/name with `SEED_ADMIN_EMAIL` / `SEED_ADMIN_NAME`. Do **not** commit the password. First successful edge sign-in re-hashes bcrypt → Better Auth scrypt.

### Project CRM chains + demo proposals

Prisma migration seed SQL does **not** run on this Neon DB (Drizzle ledger only). After the admin user exists:

```bash
cd packages/db
DATABASE_URL="$STAGING_DIRECT_URL" pnpm db:seed-project-crm-chains
DATABASE_URL="$STAGING_DIRECT_URL" pnpm db:seed-staging-proposals
```

Creates (or updates):

| Row | Notes |
|---|---|
| `system_settings` `proposals.first_reviewer` / `proposals.final_approver` / `project-workflow.default_approver` | Point at the admin user |
| `approval_chains` scopes `proposal` + `project_request` | Stages named + `is_system` |
| `proposals` titled `[STAGING] …` | Two in-flight rows so `/proposals` is not empty |

Without the chain seed, `GET /api/approval-chains/proposal` returns 404 and proposal create cannot snapshot decisions.

Staging Worker still needs `BETTER_AUTH_SECRET` (`wrangler secret put --env staging`) before login works on `https://staging.manut.xyz`.

## PR database branches (Depot)

Workflow: `.depot/workflows/neon-pr-branches.yml` (Neon REST API via curl on Depot runners — **not** `neondatabase/*` GitHub Actions; those fail to download on Depot because Neon’s GitHub org IP-allowlists releases).

| Event | Action |
|---|---|
| PR opened / reopened / synchronize | Create (or reuse) Neon branch `preview-pr-<n>-<git-branch>` (≤63 chars), expire +14d, run `pnpm --filter @nexora/db db:migrate` **twice** on the **unpooled** URL from `GET …/connection_uri?pooled=false` |
| PR closed | Delete that Neon branch (`DELETE …/branches/{id}`; 404 = already gone) |

Parent is the Neon project primary (already bootstrapped). Do **not** run `db:bootstrap-greenfield` on PR branches.

### Depot secrets / vars

| Name | Kind | Notes |
|---|---|---|
| `NEON_API_KEY` | secret | Set 2026-09-07 (org `rf185j2sr5`, repo-scoped `mygogocash/Manut`) |
| `NEON_PROJECT_ID` | variable | `patient-mode-86465099` |
| `STAGING_DIRECT_URL` | secret | Unpooled Neon URL (post password-rotate; deploy migrate + Hyperdrive origin) |
| `CLOUDFLARE_API_TOKEN` | secret | **Still required for Worker deploy** — Manut-scoped; existing org `CF_STAGING_API_TOKEN` is locked to `mygogocash/gogocash-doc` + `staging.yml` and will not inject into this repo |
| `CLOUDFLARE_ACCOUNT_ID` | secret | GoGoCash `187ab61ed9dbc6e616cb23e6b95aa8f1` (already present as default variant) |
| `BETTER_AUTH_API_KEY` | secret | Better Auth Dash key — Depot holds it; `deploy-edge-staging.yml` runs `wrangler secret put` after the first Worker deploy |
| `BETTER_AUTH_SECRET` | secret | Session signing secret — set 2026-09-07; deploy fails closed if unset and puts it on the Worker after wrangler deploy |

Parent is always the Neon project primary (`production`). If you need a non-default parent, add `parent_branch` to the create step in the workflow.

If either `NEON_PROJECT_ID` or `NEON_API_KEY` is missing, the workflow no-ops with a notice (same pattern as unset `CLOUDFLARE_API_TOKEN` on staging deploy).

Schema-diff PR comments (`neondatabase/schema-diff-action`) are commented out in the workflow; enable when you want review noise and add `pull-requests: write`.

## Staging go-live checklist (remaining)

Infra on Neon + Hyperdrive is done; Workers deploy via Depot on `preview`. Remaining:

1. **Promote `main` → `preview` with a merge commit** (or `workflow_dispatch` Deploy Edge Staging) so this PR's auth + secret fail-closed land  
2. Confirm deploy put `BETTER_AUTH_SECRET` on `intranet-edge-staging` (Depot secret is set; workflow fails closed if missing)  
3. **Re-seed admin password** if unknown:  
   `SEED_ADMIN_PASSWORD=… DATABASE_URL="$STAGING_DIRECT_URL" pnpm --filter @nexora/db db:seed-better-auth-admin`  
4. **Smoke in a browser** `https://staging.manut.xyz` — password login as `admin@manut.xyz` (Bot Fight Mode challenges bare curl)  
5. Optional: `RESEND_API_KEY` Worker secret before magic-link / reset email works  
6. Optional: set `EDGE_API_URL` + `CRON_SECRET` on edge-jobs, then flip staging `JOBS_ENABLED` to `"true"`

Parallel (does not unblock login): Databricks AWS workspace + `.depot/workflows/erp-snapshot-export.yml` (see `docs/ops/DATABRICKS_ERP_EXPORT.md`).

## Security

If a Neon password was pasted into chat or a ticket, **rotate it in the Neon console** and update Hyperdrive + Depot secrets.
