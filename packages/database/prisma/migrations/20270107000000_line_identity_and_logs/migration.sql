-- LINE Login + Messaging identity on users, plus inbound message audit log.
-- Idempotent: safe to re-run on staging (db push) and prod (migrate deploy).

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "line_user_id" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "users_line_user_id_key"
  ON "users" ("line_user_id");

CREATE TABLE IF NOT EXISTS "line_message_logs" (
  "id" TEXT PRIMARY KEY,
  "line_user_id" TEXT NOT NULL,
  "user_id" UUID,
  "event_type" TEXT NOT NULL,
  "direction" TEXT NOT NULL DEFAULT 'inbound',
  "message_type" TEXT,
  "preview" TEXT,
  "raw" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "line_message_logs_line_user_id_idx"
  ON "line_message_logs" ("line_user_id");

CREATE INDEX IF NOT EXISTS "line_message_logs_user_id_idx"
  ON "line_message_logs" ("user_id");

CREATE INDEX IF NOT EXISTS "line_message_logs_created_at_idx"
  ON "line_message_logs" ("created_at");

DO $$ BEGIN
  ALTER TABLE "line_message_logs"
    ADD CONSTRAINT "line_message_logs_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
