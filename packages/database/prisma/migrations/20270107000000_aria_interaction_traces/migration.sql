-- Training-data substrate: one immutable, replayable trace per assistant turn.
-- Distinct from aria_query_logs (aggregates for the insights page) — this keeps
-- the full turn (versioned prompt, RBAC snapshot, retrieved context, tool calls
-- WITH args + results, and the produced output) for offline grading + training.
-- Written best-effort behind the fail-closed ARIA_TRACE_CAPTURE flag.
-- Idempotent so a partial-apply re-run is a no-op.
CREATE TABLE IF NOT EXISTS "aria_interaction_traces" (
  "id"                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "conversation_id"        UUID         NULL,
  "user_id"                UUID         NOT NULL,
  "assistant_message_id"   UUID         NULL,
  "turn_kind"              TEXT         NOT NULL DEFAULT 'send',
  "prompt_version"         TEXT         NOT NULL,
  "model"                  TEXT         NOT NULL,
  "max_tokens"             INTEGER      NULL,
  "user_message"           TEXT         NOT NULL,
  "permissions_snapshot"   TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
  "offered_tools"          TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
  "retrieved_article_ids"  UUID[]       NOT NULL DEFAULT ARRAY[]::UUID[],
  "retrieved_distances"    DOUBLE PRECISION[] NOT NULL DEFAULT ARRAY[]::DOUBLE PRECISION[],
  "top_distance"           DOUBLE PRECISION NULL,
  "retrieval_mode"         TEXT         NOT NULL DEFAULT 'vector',
  "workspace_bytes"        INTEGER      NOT NULL DEFAULT 0,
  "knowledge_bytes"        INTEGER      NOT NULL DEFAULT 0,
  "assistant_text"         TEXT         NOT NULL,
  "stop_reason"            TEXT         NULL,
  "tool_calls"             JSONB        NOT NULL DEFAULT '[]'::JSONB,
  "tool_use_count"         INTEGER      NOT NULL DEFAULT 0,
  "tool_names"             TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
  "tokens_in"              INTEGER      NULL,
  "tokens_out"             INTEGER      NULL,
  "cache_read_tokens"      INTEGER      NULL,
  "cache_create_tokens"    INTEGER      NULL,
  "latency_ms"             INTEGER      NOT NULL,
  "error"                  BOOLEAN      NOT NULL DEFAULT FALSE,
  "error_message"          TEXT         NULL,
  "pii_redacted"           BOOLEAN      NOT NULL DEFAULT FALSE,
  "created_at"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "aria_interaction_traces_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "aria_interaction_traces_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "aria_conversations"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "aria_interaction_traces_assistant_message_id_fkey"
    FOREIGN KEY ("assistant_message_id") REFERENCES "aria_messages"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "aria_interaction_traces_created_at_idx"
  ON "aria_interaction_traces" ("created_at");
CREATE INDEX IF NOT EXISTS "aria_interaction_traces_user_id_created_at_idx"
  ON "aria_interaction_traces" ("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "aria_interaction_traces_conversation_id_idx"
  ON "aria_interaction_traces" ("conversation_id");
CREATE INDEX IF NOT EXISTS "aria_interaction_traces_pii_redacted_created_at_idx"
  ON "aria_interaction_traces" ("pii_redacted", "created_at");
