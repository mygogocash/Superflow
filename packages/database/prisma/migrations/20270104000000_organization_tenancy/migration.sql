-- Multi-org tenancy foundation (docs/ORG_TENANCY_RBAC_PLAN.md).
-- ADDITIVE + idempotent. Creates Organization tenant above Entity,
-- membership + org roles, and platformRole on users. Backfills one home
-- org ("manut") for the current single-tenant deployment.
-- Safe to re-run: IF NOT EXISTS / ON CONFLICT / guarded FK adds.

-- 1. Org role enum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'org_role') THEN
    CREATE TYPE "org_role" AS ENUM ('user', 'admin', 'super_admin');
  END IF;
END $$;

-- 2. Organizations
CREATE TABLE IF NOT EXISTS "organizations" (
    "id"         TEXT NOT NULL,
    "name"       TEXT NOT NULL,
    "slug"       TEXT NOT NULL,
    "status"     TEXT NOT NULL DEFAULT 'active',
    "deleted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "organizations_slug_key"
  ON "organizations" ("slug");

CREATE INDEX IF NOT EXISTS "organizations_status_idx"
  ON "organizations" ("status");

CREATE INDEX IF NOT EXISTS "organizations_deleted_at_idx"
  ON "organizations" ("deleted_at");

-- 3. Organization memberships
CREATE TABLE IF NOT EXISTS "organization_memberships" (
    "id"              TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "user_id"         UUID NOT NULL,
    "org_role"        "org_role" NOT NULL DEFAULT 'user',
    "is_active"       BOOLEAN NOT NULL DEFAULT true,
    "invited_by_id"   UUID,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "organization_memberships_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "organization_memberships_organization_id_user_id_key"
  ON "organization_memberships" ("organization_id", "user_id");

CREATE INDEX IF NOT EXISTS "organization_memberships_user_id_idx"
  ON "organization_memberships" ("user_id");

CREATE INDEX IF NOT EXISTS "organization_memberships_organization_id_is_active_idx"
  ON "organization_memberships" ("organization_id", "is_active");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organization_memberships_organization_id_fkey'
  ) THEN
    ALTER TABLE "organization_memberships"
      ADD CONSTRAINT "organization_memberships_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organization_memberships_user_id_fkey'
  ) THEN
    ALTER TABLE "organization_memberships"
      ADD CONSTRAINT "organization_memberships_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organization_memberships_invited_by_id_fkey'
  ) THEN
    ALTER TABLE "organization_memberships"
      ADD CONSTRAINT "organization_memberships_invited_by_id_fkey"
      FOREIGN KEY ("invited_by_id") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- 4. Entity → organization
ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "organization_id" TEXT;

CREATE INDEX IF NOT EXISTS "entities_organization_id_idx"
  ON "entities" ("organization_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'entities_organization_id_fkey'
  ) THEN
    ALTER TABLE "entities"
      ADD CONSTRAINT "entities_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- 5. User platform + active org
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "active_organization_id" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "platform_role" TEXT;

CREATE INDEX IF NOT EXISTS "users_active_organization_id_idx"
  ON "users" ("active_organization_id");

CREATE INDEX IF NOT EXISTS "users_platform_role_idx"
  ON "users" ("platform_role");

-- 6. Backfill home org (idempotent fixed id for local/seed stability)
INSERT INTO "organizations" ("id", "name", "slug", "status", "created_at", "updated_at")
VALUES (
  'org_manut_home',
  'Manut',
  'manut',
  'active',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("slug") DO NOTHING;

-- Prefer the fixed-id row; if slug already existed with another id, use that.
UPDATE "entities" e
SET "organization_id" = o."id"
FROM "organizations" o
WHERE o."slug" = 'manut'
  AND e."organization_id" IS NULL
  AND e."deleted_at" IS NULL;

-- Memberships: every active user → home org.
-- System Admin role holders → org super_admin + platform_admin.
-- Everyone else → org user (elevated mapping can be refined in seed/admin UI).
INSERT INTO "organization_memberships" (
  "id", "organization_id", "user_id", "org_role", "is_active", "created_at", "updated_at"
)
SELECT
  gen_random_uuid()::text,
  o."id",
  u."id",
  CASE
    WHEN EXISTS (
      SELECT 1
      FROM "user_roles" ur
      JOIN "roles" r ON r."id" = ur."role_id"
      WHERE ur."user_id" = u."id"
        AND r."is_system" = true
        AND r."name" = 'Admin'
        AND r."deleted_at" IS NULL
    ) THEN 'super_admin'::"org_role"
    ELSE 'user'::"org_role"
  END,
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "users" u
CROSS JOIN "organizations" o
WHERE o."slug" = 'manut'
  AND u."deleted_at" IS NULL
ON CONFLICT ("organization_id", "user_id") DO NOTHING;

UPDATE "users" u
SET
  "active_organization_id" = COALESCE(u."active_organization_id", o."id"),
  "platform_role" = CASE
    WHEN EXISTS (
      SELECT 1
      FROM "user_roles" ur
      JOIN "roles" r ON r."id" = ur."role_id"
      WHERE ur."user_id" = u."id"
        AND r."is_system" = true
        AND r."name" = 'Admin'
        AND r."deleted_at" IS NULL
    ) THEN COALESCE(u."platform_role", 'platform_admin')
    ELSE u."platform_role"
  END
FROM "organizations" o
WHERE o."slug" = 'manut'
  AND u."deleted_at" IS NULL;
