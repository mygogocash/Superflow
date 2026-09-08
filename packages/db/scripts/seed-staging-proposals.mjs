#!/usr/bin/env node
/**
 * Seed a minimal Proposals queue for greenfield staging (admin-only DB).
 *
 * Creates one in-flight proposal raised by admin@manut.xyz so /proposals is
 * not an empty shell after Neon bootstrap. Titles carry "[STAGING] " so
 * --clean only removes what this script wrote.
 *
 * Usage:
 *   DATABASE_URL=… node scripts/seed-staging-proposals.mjs
 *   DATABASE_URL=… node scripts/seed-staging-proposals.mjs --clean
 *   DATABASE_URL=… node scripts/seed-staging-proposals.mjs --dry-run
 */
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const dryRun = process.argv.includes("--dry-run");
const cleanOnly = process.argv.includes("--clean");
const url =
  process.env.DIRECT_URL ??
  process.env.DATABASE_URL ??
  process.env.STAGING_DIRECT_URL;
if (!url) {
  console.error("DATABASE_URL, DIRECT_URL, or STAGING_DIRECT_URL required");
  process.exit(1);
}

const PREFIX = "[STAGING] ";
const adminEmail = (
  process.env.SEED_ADMIN_EMAIL ?? "admin@manut.xyz"
).toLowerCase();

const sql = postgres(url, { max: 1, prepare: false, ssl: "require" });

try {
  const [admin] = await sql`
    SELECT id FROM users WHERE lower(email) = ${adminEmail} LIMIT 1
  `;
  if (!admin) {
    console.error(`No user ${adminEmail}`);
    process.exit(1);
  }

  if (!dryRun) {
    await sql`
      DELETE FROM proposals WHERE title LIKE ${PREFIX + "%"}
    `;
  }

  if (cleanOnly) {
    console.log(JSON.stringify({ dryRun, cleaned: true }, null, 2));
    process.exit(0);
  }

  const fixtures = [
    {
      title: `${PREFIX}Partner portal SSO`,
      description:
        "Partners keep a second password for the portal. Moving them onto the same identity provider we use internally would remove a support burden.",
      type: "idea",
      priority: "high",
      status: "pending_approval",
    },
    {
      title: `${PREFIX}Weekly partner payouts`,
      description:
        "Partners are asking for weekly payouts. Finance has flagged the reconciliation cost — needs a go / no-go.",
      type: "change_request",
      priority: "urgent",
      status: "pending_approval",
    },
  ];

  const created = [];
  for (const f of fixtures) {
    const id = randomUUID();
    if (!dryRun) {
      await sql`
        INSERT INTO proposals (
          id, title, description, type, priority, raised_by_id,
          status, status_changed_at, current_step_order, updated_at
        ) VALUES (
          ${id}, ${f.title}, ${f.description}, ${f.type}, ${f.priority},
          ${admin.id}::uuid, ${f.status}, now(), 1, now()
        )
      `;
      // Snapshot chain decisions when a proposal chain exists.
      const [chain] = await sql`
        SELECT id FROM approval_chains WHERE scope = 'proposal' LIMIT 1
      `;
      if (chain) {
        const steps = await sql`
          SELECT id, "order", name, approver_user_id
          FROM approval_chain_steps
          WHERE chain_id = ${chain.id} AND is_active = true
          ORDER BY "order" ASC
        `;
        for (const step of steps) {
          await sql`
            INSERT INTO approval_chain_decisions (
              id, scope, proposal_id, "order", name,
              approver_user_id, status
            ) VALUES (
              ${randomUUID()}, 'proposal', ${id}, ${step.order}, ${step.name},
              ${step.approver_user_id}, 'pending'
            )
          `;
        }
      }
      await sql`
        INSERT INTO proposal_transitions (
          id, proposal_id, from_status, to_status, actor_id, created_at
        ) VALUES (
          ${randomUUID()}, ${id}, NULL, ${f.status}, ${admin.id}::uuid, now()
        )
      `;
    }
    created.push({ id, title: f.title, status: f.status });
  }

  console.log(
    JSON.stringify({ dryRun, adminEmail, created }, null, 2),
  );
} finally {
  await sql.end({ timeout: 1 });
}
