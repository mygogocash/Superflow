// Applies the commented-out 0000 introspected DDL on an EMPTY database, then
// marks it applied in drizzle.__drizzle_migrations with the SAME file hash
// that scripts/baseline.mjs uses (so we never uncomment 0000 on disk — that
// would invalidate hashes on already-baselined Supabase DBs).
//
// After this succeeds, run: pnpm --filter @nexora/db db:migrate
//
//   DATABASE_URL=postgres://... node scripts/bootstrap-greenfield.mjs [--dry-run]
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";

const dryRun = process.argv.includes("--dry-run");
const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error("DIRECT_URL or DATABASE_URL is required");

const journal = JSON.parse(
  readFileSync(resolve("drizzle/meta/_journal.json"), "utf8"),
);
const first = journal.entries[0];
if (!first || first.idx !== 0) {
  throw new Error("journal has no idx 0 baseline entry");
}

const sqlFile = readdirSync(resolve("drizzle")).find(
  (f) => f.startsWith("0000_") && f.endsWith(".sql"),
);
if (!sqlFile) throw new Error("0000_*.sql not found");

const raw = readFileSync(resolve("drizzle", sqlFile), "utf8");
const hash = createHash("sha256").update(raw).digest("hex");

const block = raw.match(/\/\*([\s\S]*)\*\//);
if (!block) {
  throw new Error(
    `${sqlFile} has no /* ... */ DDL block — if it was uncommented for greenfield, use drizzle-kit migrate instead`,
  );
}

// Drizzle introspect mangled Postgres empty-array / multi-value defaults into
// sentinel '{"RAY"}' / '{RAY}' (and one broken channels literal). Rewrite to
// valid defaults without editing 0000 on disk (preserves baseline hashes).
function sanitizeGreenfieldSql(ddl) {
  return (
    ddl
      .replaceAll(`DEFAULT '{"RAY"}'`, `DEFAULT '{}'`)
      .replaceAll(`DEFAULT '{RAY}'`, `DEFAULT '{}'`)
      .replaceAll(
        `DEFAULT '{"RAY['in_app'::text","'email'::tex"}'`,
        `DEFAULT ARRAY['in_app','email']::text[]`,
      )
      // Introspect emitted wrong opclasses (e.g. text_ops on uuid columns).
      // Drop explicit opclasses and let Postgres pick the default.
      .replace(
        /\s+(text_ops|uuid_ops|timestamp_ops|timestamptz_ops|date_ops|int2_ops|int4_ops|int8_ops|bool_ops|numeric_ops|float4_ops|float8_ops|jsonb_ops|jsonb_path_ops|array_ops|bpchar_ops|varchar_ops|name_ops|oid_ops)\b/g,
        "",
      )
  );
}

const statements = sanitizeGreenfieldSql(block[1])
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter(Boolean);

const sql = postgres(url, {
  max: 1,
  prepare: false,
  fetch_types: false,
  connect_timeout: 30,
  ssl: "require",
});

try {
  const [{ n }] = await sql`
    select count(*)::int as n
    from information_schema.tables
    where table_schema = 'public' and table_name = 'users'
  `;
  if (n > 0) {
    throw new Error(
      "refusing to bootstrap: users table already exists (use baseline.mjs on existing DBs)",
    );
  }

  console.log(
    `greenfield: applying ${statements.length} statements from ${sqlFile}`,
  );

  if (dryRun) {
    console.log(
      `greenfield: DRY RUN would apply DDL + mark hash ${hash.slice(0, 12)}…`,
    );
    process.exit(0);
  }

  // PG13+ has gen_random_uuid in core; pgcrypto is harmless if present.
  await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`;

  let i = 0;
  for (const statement of statements) {
    i += 1;
    try {
      await sql.unsafe(statement);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `greenfield: statement ${i}/${statements.length} failed: ${msg}\n---\n${statement.slice(0, 240)}`,
      );
    }
    if (i % 50 === 0 || i === statements.length) {
      console.log(`greenfield: ${i}/${statements.length}`);
    }
  }

  await sql`create schema if not exists drizzle`;
  await sql`
    create table if not exists drizzle.__drizzle_migrations (
      id serial primary key,
      hash text not null,
      created_at bigint
    )
  `;
  const existing = await sql`
    select id from drizzle.__drizzle_migrations where hash = ${hash}
  `;
  if (existing.length === 0) {
    await sql`
      insert into drizzle.__drizzle_migrations (hash, created_at)
      values (${hash}, ${first.when})
    `;
  }

  console.log(
    `greenfield: done — marked ${sqlFile} applied; run db:migrate for 0001+`,
  );
} finally {
  await sql.end();
}
