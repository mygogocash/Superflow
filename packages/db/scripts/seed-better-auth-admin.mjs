#!/usr/bin/env node
/**
 * Idempotent Better Auth admin bootstrap for greenfield Neon (no Supabase Auth).
 *
 * Seeds TH entity + system Admin role + admin@manut.xyz with a credential
 * account (issuer = local:credential). Password is bcrypt ($2…) so Better Auth
 * accepts it on first sign-in and re-hashes to scrypt (see packages/auth).
 *
 * Usage:
 *   DATABASE_URL=… SEED_ADMIN_PASSWORD='…' node scripts/seed-better-auth-admin.mjs
 *   DATABASE_URL=… SEED_ADMIN_PASSWORD='…' node scripts/seed-better-auth-admin.mjs --dry-run
 *
 * Env:
 *   DATABASE_URL | DIRECT_URL | STAGING_DIRECT_URL — Postgres URL (unpooled preferred)
 *   SEED_ADMIN_PASSWORD — required (min 12 chars); never commit
 *   SEED_ADMIN_EMAIL — default admin@manut.xyz
 *   SEED_ADMIN_NAME — default Manut Admin
 */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import postgres from "postgres";

const dryRun = process.argv.includes("--dry-run");
const url =
  process.env.DIRECT_URL ??
  process.env.DATABASE_URL ??
  process.env.STAGING_DIRECT_URL;
if (!url) {
  console.error("DATABASE_URL, DIRECT_URL, or STAGING_DIRECT_URL required");
  process.exit(1);
}

const email = (process.env.SEED_ADMIN_EMAIL ?? "admin@manut.xyz").toLowerCase();
const name = process.env.SEED_ADMIN_NAME ?? "Manut Admin";
const password = process.env.SEED_ADMIN_PASSWORD;
if (!password || password.length < 12) {
  console.error("SEED_ADMIN_PASSWORD required (min 12 characters)");
  process.exit(1);
}

const ISSUER = "local:credential";

function hashPassword(plain) {
  const py = spawnSync(
    "python3",
    ["-c", "import sys,bcrypt; print(bcrypt.hashpw(sys.argv[1].encode(), bcrypt.gensalt(rounds=10)).decode())", plain],
    { encoding: "utf8" },
  );
  if (py.status !== 0) {
    throw new Error(
      `bcrypt hash failed: ${py.stderr || py.stdout || "python3/bcrypt missing"}`,
    );
  }
  const hash = py.stdout.trim();
  if (!hash.startsWith("$2")) {
    throw new Error(`unexpected bcrypt hash: ${hash.slice(0, 8)}…`);
  }
  return hash;
}

const sql = postgres(url, { max: 1, prepare: false, ssl: "require" });
const now = new Date().toISOString();

try {
  const passwordHash = hashPassword(password);

  // ── entity TH ──────────────────────────────────────────────
  let entityId;
  const existingEntity = await sql`
    SELECT id FROM entities WHERE code = 'TH' LIMIT 1
  `;
  if (existingEntity.length) {
    entityId = existingEntity[0].id;
  } else if (dryRun) {
    entityId = "dry-run-entity-th";
  } else {
    entityId = randomUUID();
    await sql`
      INSERT INTO entities (
        id, name, code, country, currency, accounting_std,
        is_active, fiscal_year_start_month, default_rate_source,
        enabled_currencies, setup_state, created_at, updated_at
      ) VALUES (
        ${entityId}, 'Manut Thailand', 'TH', 'Thailand', 'THB', 'TFRS for NPAEs',
        true, 1, 'bot',
        ARRAY['THB']::text[], 'active', ${now}::timestamptz, ${now}::timestamptz
      )
    `;
  }

  // ── system Admin role ──────────────────────────────────────
  let roleId;
  const existingRole = await sql`
    SELECT id FROM roles WHERE name = 'Admin' LIMIT 1
  `;
  if (existingRole.length) {
    roleId = existingRole[0].id;
    if (!dryRun) {
      await sql`
        UPDATE roles
        SET is_system = true,
            description = COALESCE(description, 'Full system access'),
            default_route = COALESCE(default_route, '/dashboard'),
            updated_at = ${now}::timestamptz
        WHERE id = ${roleId}::uuid
      `;
    }
  } else if (dryRun) {
    roleId = randomUUID();
  } else {
    roleId = randomUUID();
    await sql`
      INSERT INTO roles (
        id, name, description, is_system, default_route, created_at, updated_at
      ) VALUES (
        ${roleId}::uuid, 'Admin', 'Full system access', true, '/dashboard',
        ${now}::timestamptz, ${now}::timestamptz
      )
    `;
  }

  // ── user ───────────────────────────────────────────────────
  let userId;
  let userCreated = false;
  const existingUser = await sql`
    SELECT id FROM users WHERE email = ${email} LIMIT 1
  `;
  if (existingUser.length) {
    userId = existingUser[0].id;
    if (!dryRun) {
      await sql`
        UPDATE users SET
          name = ${name},
          email_verified = true,
          is_active = true,
          entity_id = ${entityId},
          active_entity_id = ${entityId},
          department = COALESCE(department, 'Operations'),
          job_title = COALESCE(job_title, 'System Administrator'),
          employee_id = COALESCE(employee_id, 'MNT-001'),
          country = COALESCE(country, 'Thailand'),
          timezone = COALESCE(timezone, 'Asia/Bangkok'),
          deleted_at = NULL,
          updated_at = ${now}::timestamptz
        WHERE id = ${userId}::uuid
      `;
    }
  } else if (dryRun) {
    userId = randomUUID();
    userCreated = true;
  } else {
    userId = randomUUID();
    userCreated = true;
    await sql`
      INSERT INTO users (
        id, email, name, email_verified, entity_id, active_entity_id,
        department, job_title, employee_id, employment_type,
        country, timezone, is_active, must_change_password,
        created_at, updated_at
      ) VALUES (
        ${userId}::uuid, ${email}, ${name}, true, ${entityId}, ${entityId},
        'Operations', 'System Administrator', 'MNT-001', 'full_time',
        'Thailand', 'Asia/Bangkok', true, false,
        ${now}::timestamptz, ${now}::timestamptz
      )
    `;
  }

  // ── user_roles ─────────────────────────────────────────────
  let roleLinked = false;
  const existingLink = await sql`
    SELECT 1 FROM user_roles
    WHERE user_id = ${userId}::uuid AND role_id = ${roleId}::uuid
    LIMIT 1
  `;
  if (!existingLink.length) {
    roleLinked = true;
    if (!dryRun) {
      await sql`
        INSERT INTO user_roles (user_id, role_id, assigned_at, assigned_by)
        VALUES (${userId}::uuid, ${roleId}::uuid, ${now}::timestamptz, ${userId}::uuid)
      `;
    }
  }

  // ── Better Auth credential account ─────────────────────────
  let accountAction = "unchanged";
  const existingAccount = await sql`
    SELECT id FROM account
    WHERE "userId" = ${userId}::uuid AND "providerId" = 'credential'
    LIMIT 1
  `;
  if (existingAccount.length) {
    accountAction = "password_rotated";
    if (!dryRun) {
      await sql`
        UPDATE account SET
          issuer = ${ISSUER},
          password = ${passwordHash},
          "accountId" = ${userId},
          "updatedAt" = now()
        WHERE "userId" = ${userId}::uuid AND "providerId" = 'credential'
      `;
    }
  } else {
    accountAction = "created";
    if (!dryRun) {
      await sql`
        INSERT INTO account (
          id, "userId", "accountId", "providerId", issuer, password,
          "createdAt", "updatedAt"
        ) VALUES (
          gen_random_uuid(), ${userId}::uuid, ${userId}, 'credential',
          ${ISSUER}, ${passwordHash}, now(), now()
        )
      `;
    }
  }

  console.log(
    JSON.stringify(
      {
        dryRun,
        email,
        userId,
        entityId,
        roleId,
        userCreated,
        roleLinked,
        accountAction,
        passwordHashAlgo: "bcrypt",
      },
      null,
      2,
    ),
  );
} finally {
  await sql.end({ timeout: 1 });
}
