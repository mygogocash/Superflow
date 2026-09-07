-- Phase 2/4 registries for the ARIA training pipeline: versioned datasets
-- built from interaction traces, and a registry of candidate/promoted
-- fine-tunes (training runs externally; this records lineage + eval + gate).
-- Idempotent so a partial-apply re-run is a no-op.

CREATE TABLE IF NOT EXISTS "aria_training_datasets" (
  "id"            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "kind"          TEXT         NOT NULL,
  "version"       INTEGER      NOT NULL,
  "format"        TEXT         NOT NULL DEFAULT 'jsonl',
  "row_count"     INTEGER      NOT NULL,
  "filters"       JSONB        NOT NULL DEFAULT '{}'::JSONB,
  "stats"         JSONB        NOT NULL DEFAULT '{}'::JSONB,
  "checksum"      TEXT         NOT NULL,
  "created_by_id" UUID         NULL,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "aria_training_datasets_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "aria_training_datasets_kind_version_key"
  ON "aria_training_datasets" ("kind", "version");
CREATE INDEX IF NOT EXISTS "aria_training_datasets_kind_created_at_idx"
  ON "aria_training_datasets" ("kind", "created_at");

CREATE TABLE IF NOT EXISTS "aria_model_versions" (
  "id"            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"          TEXT         NOT NULL,
  "base_model"    TEXT         NOT NULL,
  "method"        TEXT         NOT NULL,
  "dataset_id"    UUID         NULL,
  "status"        TEXT         NOT NULL DEFAULT 'draft',
  "eval_summary"  JSONB        NOT NULL DEFAULT '{}'::JSONB,
  "external_ref"  TEXT         NULL,
  "notes"         TEXT         NULL,
  "created_by_id" UUID         NULL,
  "promoted_at"   TIMESTAMP(3) NULL,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "aria_model_versions_dataset_id_fkey"
    FOREIGN KEY ("dataset_id") REFERENCES "aria_training_datasets"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "aria_model_versions_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "aria_model_versions_name_key"
  ON "aria_model_versions" ("name");
CREATE INDEX IF NOT EXISTS "aria_model_versions_status_created_at_idx"
  ON "aria_model_versions" ("status", "created_at");
