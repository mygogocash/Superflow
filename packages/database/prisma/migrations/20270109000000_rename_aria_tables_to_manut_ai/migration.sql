-- Rebrand: rename the assistant's tables aria_* -> manut_ai_* (data preserved;
-- Postgres RENAME keeps rows, indexes, and constraints attached — only the
-- table name changes, matching the Prisma @@map / Drizzle pgTable rename).
-- `IF EXISTS` makes each rename a no-op once applied, so a re-run / partial
-- apply is safe. Constraint + index names are intentionally left as aria_*_
-- (they still describe the same objects and the Drizzle mirror references them
-- by those names); only the table identifier is rebranded.
--
-- NOTE: on prod this runs via `prisma migrate deploy` and preserves data. On
-- staging (`db push`, no migrate deploy) Prisma reconciles the schema by
-- dropping the old aria_* tables and creating empty manut_ai_* ones — staging
-- assistant history is not migrated (acceptable for the UAT env; prod is safe).
ALTER TABLE IF EXISTS "aria_conversations" RENAME TO "manut_ai_conversations";
ALTER TABLE IF EXISTS "aria_conversation_summaries" RENAME TO "manut_ai_conversation_summaries";
ALTER TABLE IF EXISTS "aria_conversation_memory" RENAME TO "manut_ai_conversation_memory";
ALTER TABLE IF EXISTS "aria_messages" RENAME TO "manut_ai_messages";
ALTER TABLE IF EXISTS "aria_attachments" RENAME TO "manut_ai_attachments";
ALTER TABLE IF EXISTS "aria_feedback" RENAME TO "manut_ai_feedback";
ALTER TABLE IF EXISTS "aria_knowledge_articles" RENAME TO "manut_ai_knowledge_articles";
ALTER TABLE IF EXISTS "aria_query_logs" RENAME TO "manut_ai_query_logs";
ALTER TABLE IF EXISTS "aria_interaction_traces" RENAME TO "manut_ai_interaction_traces";
ALTER TABLE IF EXISTS "aria_training_datasets" RENAME TO "manut_ai_training_datasets";
ALTER TABLE IF EXISTS "aria_model_versions" RENAME TO "manut_ai_model_versions";
ALTER TABLE IF EXISTS "aria_brief_subscriptions" RENAME TO "manut_ai_brief_subscriptions";
ALTER TABLE IF EXISTS "aria_brief_deliveries" RENAME TO "manut_ai_brief_deliveries";
