-- Preferred UI language per user (BCP-47 primary subtag, e.g. 'en' / 'th').
-- Nullable: NULL means follow the org (app.locale) / browser default.
-- Idempotent so a partial-apply re-run is a no-op.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "locale" TEXT;
