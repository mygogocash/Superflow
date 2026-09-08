# Plan: Neon (Hyperdrive) + Databricks ERP lakehouse

**Date:** 2026-09-07  
**Status:** Phase 1 infra done on Neon (bootstrap + migrate + Hyperdrive + Depot `NEON_*`/`STAGING_DIRECT_URL` + Better Auth admin seed). Phase 3 **export code** landed (`erp-snapshot-export.yml` + allowlisted CSV exporter) — still needs Databricks AWS workspace + optional S3 secrets. **Blocked on staging smoke:** Manut-scoped `CLOUDFLARE_API_TOKEN` + `main`→`preview` merge-commit promote + Worker `BETTER_AUTH_SECRET` (Workers `intranet-edge-staging` not created yet).  
**Credits:** ~$1k Neon + ~$1k Databricks  
**Out of scope:** Marketing / BNII / OneWave analytics (explicitly excluded)

### Locked founder decisions (2026-09-07)

| Topic | Decision |
|---|---|
| Neon region | **APAC** (`aws-ap-southeast-1`) — project `patient-mode-86465099` (unpooled `ep-restless-truth-b3te5bwz`) |
| Staging data | **Greenfield** — `db:bootstrap-greenfield` + `db:migrate` (done on Neon) |
| Databricks cloud | **AWS** (cheapest for v1 Jobs Compute; avoid Azure 2× Jobs DBU) |
| Databricks region | Prefer **`ap-southeast-1`** if credit/workspace allows (near Neon APAC); else **`us-east-1`** for lowest list rates — document whichever the credit unlocks |
| Export v1 | **Depot workflow** (not edge-jobs) |

---

## Goal

1. **Neon** becomes the staging (then optionally prod) Postgres behind Cloudflare Hyperdrive — branchable, migrate-deployable, Hyperdrive-safe.
2. **Databricks** becomes an offline ERP lakehouse (CDC/export → Delta → SQL warehouse) for HR/Finance/CRM reporting, ARIA batch, and audit — never on the Worker hot path.
3. **D1** stays Worker-local sidecar only (`edge_presence`, `edge_workflow_instances`, `edge_handbook_chunks`). No ERP tables on D1.

---

## Non-goals

- Replacing D1 with Neon or Databricks
- Putting leave/users/CRM on D1
- Marketing / BNII pipelines on Databricks
- Querying Databricks from `apps/edge` request handlers
- Immediate prod Postgres cutover (staging first; prod is a later gate)

---

## Current state (baseline)

| Layer | Today | Target |
|---|---|---|
| Edge OLTP | Hyperdrive → Supabase Postgres (IDs still `REPLACE_WITH_*` in wrangler) | Hyperdrive → **Neon** (staging first) |
| Staging schema apply | Depot `deploy-edge-staging.yml` → Drizzle migrate via `STAGING_DIRECT_URL` | Same CI path; secret points at Neon direct |
| Prod schema apply | Drizzle + Prisma `migrate deploy` | Unchanged until prod Neon gate |
| Auth (edge) | Better Auth + KV sessions | Unchanged; staging users seeded without Supabase `auth.users` |
| Auth (Express legacy) | Supabase JWT | Leave alone until Phase 9 decommission |
| D1 | Sidecar 3 tables | Unchanged |
| Analytics warehouse | None in-repo | Databricks **AWS** Delta + SQL warehouse (auto-stop) |
| Jobs | `apps/edge-jobs` cron → `/api/cron/*` | ERP export v1 = **Depot workflow**; edge-jobs unchanged for reminders |

Authoritative wiring: `apps/edge/wrangler.jsonc`, `.depot/workflows/deploy-edge-staging.yml`, `docs/ops/CLOUDFLARE_PROVISIONING.md`, ADR `docs/adr/0001-cloudflare-edge-rewrite.md`.

---

## Architecture

```
Expo SPA → Workers (Hono)
              ├─ Hyperdrive ──► Neon Postgres          ← ERP SoT (Drizzle)
              ├─ D1                                      ← sidecar only
              ├─ KV / DO / Queues / Workflows / R2
              └─ (no Databricks binding)

Depot workflow (v1) ──► Neon (read) ──► S3 / UC volume ──► Databricks AWS (Delta)
                                                              └─ SQL warehouse (auto-stop)
```

**Rule:** Neon = transactional truth for the app. Databricks = derived, rebuildable analytics.

---

## Phase 0 — Decisions (LOCKED)

| # | Decision | Choice | Status |
|---|---|---|---|
| D1 | Neon region | **APAC** | Locked |
| D2 | Staging ledger | **Drizzle-only** on Neon (`drizzle.__drizzle_migrations`). Never Prisma history on this DB. | Locked |
| D3 | Staging data | **Greenfield seed** — empty Neon → `db:migrate` → seed Better Auth users / catalogs. No Supabase dump. | Locked |
| D4 | First Databricks domain slice | `core` + `rbac` + leave/travel/expense/cash-advance + sales-crm + shared projects | Locked |
| D5 | CDC mechanism v1 | Nightly **snapshot export** via **Depot workflow** (SQL → Parquet/CSV → volume) | Locked |
| D6 | Databricks cloud | **AWS** — Jobs Compute list ~$0.15/DBU vs Azure ~$0.30/DBU; stretch $1k on scheduled jobs + auto-stop SQL warehouse. Prefer Serverless Jobs / 2X-Small SQL with aggressive auto-stop; avoid always-on all-purpose clusters. | Locked |
| D7 | pgvector on Neon | Enable on greenfield if Drizzle `0000` / ARIA tables require it; otherwise skip until ARIA staging is needed | Eng at provision |
| D8 | Prod Neon timing | After Better Auth cutover rehearsal is green on staging | Still founder gate |

---

## Phase 1 — Neon staging project + Hyperdrive

**Outcome:** `staging.manut.xyz` Workers talk to Neon via Hyperdrive; Depot migrate uses Neon direct URL.

### 1.1 Provision (manual / founder)

1. Create Neon project (APAC) + `staging` database + role.
2. Enable extensions needed by schema (at least whatever `0000` / ARIA need — **pgvector** if embeddings tables are included).
3. Copy connection strings:
   - **Direct** → Depot secret `STAGING_DIRECT_URL` (migrations / DDL)
   - **Pooled** (or Neon Hyperdrive-recommended URL) → Hyperdrive create

```bash
# From apps/edge — see docs/ops/CLOUDFLARE_PROVISIONING.md
npx wrangler hyperdrive create staging-manut-edge-neon \
  --connection-string "<neon-hyperdrive-compatible-url>"
```

4. Paste Hyperdrive id into `apps/edge/wrangler.jsonc` and `apps/edge-jobs/wrangler.jsonc` staging env (replace `REPLACE_WITH_STAGING_HYPERDRIVE_ID`).
5. Set Depot secrets: `STAGING_DIRECT_URL` (Neon direct). Optionally keep `STAGING_DATABASE_URL` for backfill workflow aligned to same Neon.

### 1.2 Schema bootstrap (greenfield — locked)

1. Empty Neon database → `pnpm --filter @nexora/db db:migrate` via `STAGING_DIRECT_URL`.
2. Seed Better Auth users + required catalogs (existing seed / admin create). **Do not** run `migrate-supabase-auth.mjs` (no Supabase `auth.users` on Neon).
3. Expect empty business data on first cut — that is intentional; UAT fills via app or targeted seed scripts.
4. Apply D1 migrations separately (unchanged): `wrangler d1 migrations apply …`.

### 1.3 Verify

- [ ] `pnpm --filter @nexora/db db:migrate` against Neon direct (idempotent second run)
- [ ] Worker health: `https://staging.manut.xyz/api/auth/ok`
- [ ] Login + one ERP list read (leave or users) via Hyperdrive
- [ ] `edge-jobs` tick still posts cron with DB access

### 1.4 Docs / secrets matrix

Update in the same PR as wiring:

- `docs/ops/CLOUDFLARE_PROVISIONING.md` — Neon strings, not “Supabase only”
- `docs/CLOUDFLARE_DEPLOYMENT.md` — staging Neon note
- ADR addendum or short `docs/ops/NEON_STAGING.md` — direct vs pooled, no Prisma on Neon staging

**Exit criteria:** Staging edge deploy green with Neon Hyperdrive id committed; no `REPLACE_WITH_STAGING_HYPERDRIVE_ID` left.

---

## Phase 2 — Neon branching workflow

**Outcome:** Risky migrations and agent sandboxes use Neon branches instead of throwaway Docker-only verification.

### 2.1 Conventions

| Branch | Purpose |
|---|---|
| `staging` (primary) | `preview` deploy Hyperdrive target |
| `mig/<slug>` | One-off migrate verify (apply twice for idempotency) |
| `pr/<n>` or `agent/<id>` | Optional ephemeral DBs |

### 2.2 Engineer loop

1. Create Neon branch from staging.
2. Point local / CI `DATABASE_URL` + `DIRECT_URL` at branch.
3. Apply pending Drizzle migration(s) twice (idempotency).
4. Merge migration to `main` → promote → staging Neon primary migrates via Depot.

### 2.3 Automation

- Live: `.depot/workflows/neon-pr-branches.yml` (Neon REST API via curl for create/delete — not `neondatabase/*` Actions — + Drizzle migrate ×2 on unpooled URL; `channel_binding` stripped via `urllib.parse`).
- Needs Depot `NEON_API_KEY` + `NEON_PROJECT_ID` (see `docs/ops/NEON_STAGING.md`).
- Do **not** block Phase 1 Hyperdrive paste on this.

**Exit criteria:** Documented branch recipe used for at least one real migration PR; workflow green once secrets are set.

---

## Phase 3 — Databricks ERP lakehouse (v1 snapshot)

**Outcome:** Nightly (or on-demand) export of a first ERP slice into Delta; queryable via SQL warehouse. No Worker binding.

### 3.1 Workspace setup (manual) — AWS locked

1. Create **Databricks on AWS** workspace (use the cloud the $1k credit unlocks).
2. Region: `ap-southeast-1` if available under the credit; otherwise `us-east-1` and note cross-region egress from Neon APAC (acceptable for nightly P0 snapshots).
3. Unity Catalog schema: `manut_staging_erp`.
4. Landing: UC volume or S3 external location for Depot-uploaded Parquet/CSV.
5. SQL warehouse: **2X-Small**, auto-stop **≤10 min**; no always-on all-purpose cluster for v1.
6. Prefer **Jobs compute** (or serverless jobs) for ingest notebooks — not interactive clusters left running.

### 3.2 First table slice (no marketing)

From Prisma domains:

| Priority | Domain | Examples |
|---|---|---|
| P0 | core + rbac | `users`, entities, roles, permissions |
| P0 | HR requests | leave / travel request + decision tables |
| P0 | Finance requests | expenses, cash-advance (+ decisions) |
| P1 | Sales CRM | leads, opportunities, accounts, contacts |
| P1 | Projects | `projects`, `project_tasks` (+ IT/Legal native mirrors if needed) |
| P2 | Audit / auth logs | `auth_logs`, selected audit tables |
| Later | ARIA corpus | knowledge articles / embeddings (batch only) |

Explicitly **excluded:** marketing-crm, BNII, `ow_*` metrics.

### 3.3 Export job v1 (mirror existing patterns)

Prefer one of:

**A. Depot workflow — LOCKED for v1**  
- Manual + scheduled workflow (mirror `db-backfill.yml`)  
- Reads Neon via `STAGING_DIRECT_URL`  
- Writes Parquet/CSV to S3 / UC landing path  
- Idempotent by `as_of_date` partition  

**B. edge-jobs cron** — deferred (Phase 5 / only if Depot timing is insufficient)  
- Worker CPU/time limits make bulk ERP dumps a poor first fit

### 3.4 Lakehouse objects

- Raw: `bronze.<table>` (append-by-date)
- Clean: `silver.<table>` (latest snapshot or SCD1 overwrite)
- Few gold views: e.g. leave cycle-time, expense by entity — only after silver is stable

### 3.5 Verify

- [ ] Dry-run export row counts match Neon `COUNT(*)` for P0 tables
- [ ] Re-run same day is idempotent (overwrite partition or merge key)
- [ ] SQL warehouse query returns expected sample
- [ ] No Databricks credentials in Worker `env.ts`

**Exit criteria:** Documented runbook + one green scheduled/manual export of P0 tables.

---

## Phase 4 — Prod Neon gate (optional, separate PR)

Only after Phase 1–2 are boring:

1. Neon prod project (or prod branch policy)
2. Hyperdrive prod id in wrangler
3. Dual-run checklist: Better Auth login, migrate deploy, R2, edge-jobs still disabled until Phase 9
4. Cutover runbook update (`docs/ops/CUTOVER_RUNBOOK.md`)
5. Supabase Postgres retained as rollback until soak period ends

**Do not** combine prod Neon cutover with Databricks v1 in the same PR.

---

## Phase 5 — Databricks v2 (only if credits remain)

- Logical CDC (Neon logical replication → Databricks) instead of full snapshots
- ARIA eval batch jobs
- Audit log retention lake
- Still no marketing/BNII

---

## Work breakdown (implementation PRs)

| PR | Title | Depends on |
|---|---|---|
| **PR1** | `docs(ops): Neon + Databricks stack plan` (this file) | — |
| **PR2** | `chore(edge): wire staging Hyperdrive to Neon` + provisioning doc updates | Neon project + Hyperdrive id |
| **PR3** | `chore(db): Neon staging baseline / seed Better Auth users` | PR2 |
| **PR4** | `docs(ops): Neon branch migrate recipe` | PR3 |
| **PR5** | `feat(analytics): Depot ERP snapshot export → Databricks bronze` | PR3 (workspace/S3 optional for dry-run) |
| **PR6** | (later) Prod Neon Hyperdrive | Founder gate |

---

## Risk register

| Risk | Mitigation |
|---|---|
| Dual Prisma + Drizzle history on one Neon DB | Staging = Drizzle-only; document hard |
| Hyperdrive + transaction pooler breakage | Use CF-recommended Neon URL; keep `prepare: false` in `packages/db/src/client.ts` |
| Auth import assumes `auth.users` | Seed Better Auth; skip `migrate-supabase-auth` on Neon |
| Worker OOM on big export | Depot batch first; chunk + date partitions |
| Credit burn on always-on SQL warehouse | Auto-stop; bronze jobs on schedule only |
| Accidental marketing scope creep | Table allowlist in exporter; deny `ow_*` / marketing-crm |

---

## Test plan (definition of done per phase)

### Phase 1
- [x] Staging Hyperdrive id real (not placeholder) — `2531da29a59f4890bf8817697f5d350d`
- [x] Drizzle migrate ×2 against Neon direct succeeds
- [x] Better Auth admin seed (`pnpm db:seed-better-auth-admin`) on Neon
- [ ] Staging Worker deploy + login + one module list (needs `CLOUDFLARE_API_TOKEN` + `BETTER_AUTH_SECRET`)
- [ ] D1 handbook/presence paths unchanged (verify after deploy)

### Phase 3
- [x] Allowlist exporter + Depot workflow + deny marketing/`ow_*`/`revenue_*` (dry-run path)
- [ ] Databricks AWS workspace + S3/UC landing secrets
- [ ] P0 tables present in Databricks silver/bronze
- [ ] Row-count check script/job logged (Depot dry-run vs Neon `COUNT(*)`)
- [ ] Re-run idempotent
- [ ] No marketing tables in allowlist (unit-tested)

---

## Open questions (remaining)

1. Does the Databricks $1k credit unlock **AWS `ap-southeast-1`**, or only certain regions? (Affects workspace region only — cloud stays AWS.)

---

## Next action

1. Set Depot secret `CLOUDFLARE_API_TOKEN` (Manut-scoped; org `CF_STAGING_API_TOKEN` does not apply to this repo).
2. Promote `main` → `preview` with a **merge commit** (preview is behind; Workers still absent).
3. `wrangler secret put BETTER_AUTH_SECRET --env staging` after first deploy creates `intranet-edge-staging`.
4. Re-seed admin password if needed: `SEED_ADMIN_PASSWORD=… pnpm --filter @nexora/db db:seed-better-auth-admin`.
5. Smoke `https://staging.manut.xyz` login as `admin@manut.xyz`.
6. Provision Databricks AWS + set optional `ERP_SNAPSHOT_S3_*` / AWS secrets; dispatch `erp-snapshot-export.yml` dry-run then write.

---

## References

- ADR: `docs/adr/0001-cloudflare-edge-rewrite.md`
- Provisioning: `docs/ops/CLOUDFLARE_PROVISIONING.md`
- Deploy staging: `.depot/workflows/deploy-edge-staging.yml`
- DB client: `packages/db/src/client.ts`
- D1 schema: `packages/db/src/edge/schema.ts`
- Edge jobs schedule: `apps/edge-jobs/src/schedule.ts`
- Backfill pattern: `.depot/workflows/db-backfill.yml`, `packages/database/scripts/backfill-advance-side-vendor.mjs`
