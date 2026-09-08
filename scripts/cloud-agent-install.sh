#!/usr/bin/env bash
#
# Cloud Agent install phase for the Manut monorepo.
#
# Idempotent: safe to run repeatedly and against a warm snapshot. Brings up a
# self-contained local development environment backed by a local PostgreSQL
# (no Supabase project required — the API's local-dev credential auth path is
# used, see apps/api/src/modules/auth/local-dev-auth.ts).
#
# Lifecycle: this is the INSTALL phase (durable, source-derived setup). The
# PostgreSQL *process* is (re)started per boot by scripts/cloud-agent-start.sh.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PG_VER="${PG_VER:-16}"
PG_DB="${PG_DB:-intranet_dev}"
PG_DSN="postgresql://postgres:postgres@127.0.0.1:5432/${PG_DB}"
ADMIN_EMAIL="${SEED_ADMIN_EMAIL:-admin@manut.xyz}"
ADMIN_PASSWORD="${SEED_ADMIN_PASSWORD:-DevPass123!}"

log() { printf '\n\033[1;36m[install]\033[0m %s\n' "$*"; }

# ── 1. Local env files (gitignored; no real secrets — local dev only) ────────
if [ ! -f .env ]; then
  log "Writing .env (Prisma/seed)"
  cat > .env <<EOF
NODE_ENV=development
DATABASE_URL="${PG_DSN}"
DIRECT_URL="${PG_DSN}"
DEV_AUTH_SECRET=intranet-local-dev-auth
EOF
fi
if [ ! -f .env.development ]; then
  log "Writing .env.development (API)"
  cat > .env.development <<EOF
NODE_ENV=development
DATABASE_URL="${PG_DSN}"
DIRECT_URL="${PG_DSN}"
PORT=3001
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:8081
CORS_ALLOWED_ORIGINS=http://localhost:3000,http://localhost:8081
PORTAL_URL=http://localhost:3000
NEXT_PUBLIC_APP_URL=http://localhost:3000
DEV_AUTH_SECRET=intranet-local-dev-auth
CRON_SECRET=local-dev-cron-secret
EOF
fi
if [ ! -f apps/web/.env.development ]; then
  log "Writing apps/web/.env.development (Next.js)"
  cat > apps/web/.env.development <<EOF
NEXT_PUBLIC_API_URL=http://localhost:3001
API_URL=http://localhost:3001
NEXT_PUBLIC_PORTAL_URL=http://localhost:3000
NEXT_PUBLIC_APP_URL=http://localhost:3000
EOF
fi

# ── 2. PostgreSQL (install if missing; start; create DB) ─────────────────────
if ! command -v pg_ctlcluster >/dev/null 2>&1; then
  log "Installing PostgreSQL ${PG_VER}"
  sudo apt-get update -y
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql postgresql-contrib
fi
bash "$REPO_ROOT/scripts/cloud-agent-start.sh"

log "Ensuring database '${PG_DB}' + pgcrypto"
sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
ALTER USER postgres WITH PASSWORD 'postgres';
SELECT 'CREATE DATABASE ${PG_DB}'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${PG_DB}')\gexec
SQL
sudo -u postgres psql -d "${PG_DB}" -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"

# ── 3. Dependencies + Prisma client ──────────────────────────────────────────
log "pnpm install"
pnpm install --frozen-lockfile
log "Prisma generate"
pnpm db:generate

# ── 4. Schema (db push — vanilla-PG safe; migrate deploy carries Supabase-isms)
# The Better Auth tables (account/session/verification) are NOT Prisma models,
# so `prisma db push` treats them as extra tables and wants to drop them. Drop
# them first so push runs non-interactively with no data-loss prompt; step 5
# recreates them immediately after.
log "Dropping Better Auth tables before push (recreated in step 5)"
PGPASSWORD=postgres psql -h 127.0.0.1 -U postgres -d "${PG_DB}" -v ON_ERROR_STOP=1 \
  -c 'DROP TABLE IF EXISTS "session", "verification", "account" CASCADE;'
log "Prisma db push"
pnpm db:push

# ── 5. Better Auth tables (hand-written; not Prisma models) ──────────────────
log "Ensuring Better Auth tables (account/session/verification)"
PGPASSWORD=postgres psql -h 127.0.0.1 -U postgres -d "${PG_DB}" -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE IF NOT EXISTS "account" (
  "id" uuid PRIMARY KEY,
  "userId" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "issuer" text NOT NULL,
  "accessToken" text, "refreshToken" text, "idToken" text,
  "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz,
  "scope" text, "password" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account"("userId");
CREATE TABLE IF NOT EXISTS "session" (
  "id" uuid PRIMARY KEY,
  "userId" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token" text NOT NULL UNIQUE,
  "expiresAt" timestamptz NOT NULL,
  "ipAddress" text, "userAgent" text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session"("userId");
CREATE TABLE IF NOT EXISTS "verification" (
  "id" uuid PRIMARY KEY,
  "identifier" text NOT NULL, "value" text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification"("identifier");
SQL

# ── 6. Seed roles/permissions/users/sample data ──────────────────────────────
log "Seeding database"
pnpm db:seed

# ── 7. Local-dev credential for the seeded admin (idempotent) ────────────────
log "Ensuring local-dev credential for ${ADMIN_EMAIL}"
PGPASSWORD=postgres psql -h 127.0.0.1 -U postgres -d "${PG_DB}" -v ON_ERROR_STOP=1 \
  -v email="${ADMIN_EMAIL}" -v pw="${ADMIN_PASSWORD}" <<'SQL'
WITH u AS (SELECT id FROM users WHERE email = :'email')
DELETE FROM account a USING u WHERE a."userId" = u.id AND a."providerId" = 'credential';
INSERT INTO account (id, "userId", "accountId", "providerId", issuer, password, "createdAt", "updatedAt")
SELECT gen_random_uuid(), u.id, u.id::text, 'credential', 'local:credential',
       crypt(:'pw', gen_salt('bf')), now(), now()
FROM users u WHERE u.email = :'email';
SQL

# ── 8. Expo web export (the edge Worker + its vitest pool serve apps/app/dist)
log "Expo web export (apps/app/dist)"
pnpm --filter @nexora/app export:web

log "Install complete. Dev login: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD}"
