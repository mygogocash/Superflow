# Databricks ERP export (v1) — Depot snapshot → bronze

**Status:** Code path ready (Depot manual workflow). Databricks AWS workspace + S3/UC landing still founder-provisioned.  
**Source of truth:** Neon staging (`STAGING_DIRECT_URL`), Drizzle ledger only.  
**Out of scope:** Marketing / BNII / `ow_*` / parked `revenue_*` tables.

## Architecture

```
Depot workflow (erp-snapshot-export.yml)
  → Neon unpooled (COUNT / SELECT *)
  → CSV under as_of_date=YYYY-MM-DD/
  → optional aws s3 sync → S3 / UC external location
  → Databricks notebook / COPY INTO bronze.<table>   (manual / Jobs — not in Worker)
```

Workers never bind Databricks. Re-runs for the same `as_of_date` overwrite the partition files (idempotent landing).

## Table slices

Defined in `packages/db/scripts/erp-snapshot-tables.mjs`:

| Slice | Domains |
|---|---|
| `p0` | entities, users, roles, role_permissions, user_roles, leave / travel / expenses / cash-advance (+ decisions / steps) |
| `p1` | crm_leads / accounts / contacts / opportunities, projects, project_tasks |
| `all` | p0 + p1 |

Deny rules (hard): `ow_*`, `revenue_*`, any name containing `marketing`, `bnii*`, plus an explicit denylist.

## Local / CI usage

```bash
# Counts only (safe default)
STAGING_DIRECT_URL='…' pnpm --filter @nexora/db db:export-erp-snapshot -- --dry-run --slice=p0

# Write CSV locally
OUT_DIR=/tmp/erp STAGING_DIRECT_URL='…' \
  pnpm --filter @nexora/db db:export-erp-snapshot -- --write --slice=p0

# Write + S3 (needs AWS CLI + creds)
OUT_DIR=/tmp/erp S3_BUCKET=manut-erp-landing S3_PREFIX=manut/staging/erp \
  AWS_REGION=ap-southeast-1 STAGING_DIRECT_URL='…' \
  pnpm --filter @nexora/db db:export-erp-snapshot -- --write --slice=all
```

Depot: dispatch `.depot/workflows/erp-snapshot-export.yml` (`dry_run=true` by default).

### Depot secrets (optional until S3 is ready)

| Name | Required for |
|---|---|
| `STAGING_DIRECT_URL` | Always (already set for Neon) |
| `ERP_SNAPSHOT_S3_BUCKET` | S3 sync |
| `ERP_SNAPSHOT_S3_PREFIX` | S3 key prefix (default in script: `manut/staging/erp`) |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` | S3 sync |

If `S3_BUCKET` is unset, write mode still emits local CSV (Depot runner temp) and skips upload.

## Founder checklist (Databricks AWS)

1. Create **Databricks on AWS** workspace (`ap-southeast-1` preferred; else `us-east-1`).
2. Unity Catalog schema `manut_staging_erp` + volume / external location for the S3 prefix above.
3. SQL warehouse **2X-Small**, auto-stop **≤10 min**.
4. Job notebook: `COPY INTO` / Autoloader from `as_of_date=*` into `bronze.*` then SCD1 overwrite to `silver.*`.
5. Verify dry-run row counts match `SELECT COUNT(*)` on Neon for each P0 table.
6. Re-run same `as_of_date` — landing files replaced; bronze append-by-date or overwrite partition per notebook policy.

## Related

- Plan: `docs/superpowers/plans/2026-09-07-neon-databricks-stack.md` (Phase 3)
- Neon staging: `docs/ops/NEON_STAGING.md`
- Pattern sibling: `.depot/workflows/db-backfill.yml`
