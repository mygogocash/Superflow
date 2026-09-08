#!/usr/bin/env node
/**
 * Idempotent Project CRM approval-chain bootstrap for greenfield Neon.
 *
 * Staging uses Drizzle migrate / schema push — it never runs Prisma migration
 * seed SQL. Without these rows, GET /api/approval-chains/proposal 404s and
 * proposal create cannot snapshot a decision chain.
 *
 * Usage:
 *   DATABASE_URL=… node scripts/seed-project-crm-chains.mjs
 *   DATABASE_URL=… SEED_CHAIN_ADMIN_EMAIL=admin@manut.xyz node scripts/seed-project-crm-chains.mjs
 *   DATABASE_URL=… node scripts/seed-project-crm-chains.mjs --dry-run
 *
 * Env:
 *   DATABASE_URL | DIRECT_URL | STAGING_DIRECT_URL — Postgres URL (unpooled preferred)
 *   SEED_CHAIN_ADMIN_EMAIL — default admin@manut.xyz (approver for seeded stages)
 */
import { randomUUID } from "node:crypto";
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

const adminEmail = (
  process.env.SEED_CHAIN_ADMIN_EMAIL ?? "admin@manut.xyz"
).toLowerCase();

const sql = postgres(url, { max: 1, prepare: false, ssl: "require" });

try {
  const [admin] = await sql`
    SELECT id FROM users WHERE lower(email) = ${adminEmail} LIMIT 1
  `;
  if (!admin) {
    console.error(
      `No user ${adminEmail} — run db:seed-better-auth-admin first`,
    );
    process.exit(1);
  }
  const adminId = admin.id;

  const settings = [
    {
      key: "proposals.first_reviewer",
      value: { userId: adminId },
    },
    {
      key: "proposals.final_approver",
      value: { userId: adminId },
    },
    {
      key: "project-workflow.default_approver",
      value: { userId: adminId },
    },
  ];

  const settingActions = [];
  for (const row of settings) {
    const existing = await sql`
      SELECT key FROM system_settings WHERE key = ${row.key} LIMIT 1
    `;
    if (existing.length) {
      if (!dryRun) {
        await sql`
          UPDATE system_settings
          SET value = ${sql.json(row.value)}, updated_at = now()
          WHERE key = ${row.key}
        `;
      }
      settingActions.push({ key: row.key, action: "updated" });
    } else {
      if (!dryRun) {
        await sql`
          INSERT INTO system_settings (key, value, updated_at)
          VALUES (${row.key}, ${sql.json(row.value)}, now())
        `;
      }
      settingActions.push({ key: row.key, action: "created" });
    }
  }

  async function ensureChain(spec) {
    const existing = await sql`
      SELECT id FROM approval_chains WHERE scope = ${spec.scope} LIMIT 1
    `;
    if (existing.length) {
      const chainId = existing[0].id;
      // Re-point empty stages at the admin so greenfield stays usable.
      if (!dryRun) {
        await sql`
          UPDATE approval_chain_steps
          SET approver_user_id = ${adminId}::uuid,
              updated_at = now()
          WHERE chain_id = ${chainId}
            AND approver_user_id IS NULL
        `;
      }
      return { scope: spec.scope, action: "unchanged", chainId };
    }

    const chainId = randomUUID();
    if (!dryRun) {
      await sql`
        INSERT INTO approval_chains (id, scope, name, description, is_active, updated_at)
        VALUES (
          ${chainId}, ${spec.scope}, ${spec.name}, ${spec.description},
          true, now()
        )
      `;
      for (const step of spec.steps) {
        await sql`
          INSERT INTO approval_chain_steps (
            id, chain_id, "order", name, description,
            approver_user_id, is_active, is_system, updated_at
          ) VALUES (
            ${randomUUID()}, ${chainId}, ${step.order}, ${step.name},
            ${step.description}, ${adminId}::uuid, true, true, now()
          )
        `;
      }
    }
    return { scope: spec.scope, action: "created", chainId };
  }

  const chains = [];
  chains.push(
    await ensureChain({
      scope: "project_request",
      name: "Project request approval",
      description:
        "Stages a project request passes before development can start.",
      steps: [
        {
          order: 1,
          name: "Project Manager approval",
          description:
            "The single gate. Escalation to a named person stays available at this stage.",
        },
      ],
    }),
  );
  chains.push(
    await ensureChain({
      scope: "proposal",
      name: "Proposal approval",
      description: "Stages a proposal passes before it is approved.",
      steps: [
        {
          order: 1,
          name: "First review",
          description:
            "Sees every new proposal, and is copied on everything that happens after.",
        },
        {
          order: 2,
          name: "Final approval",
          description: "Decides once the first reviewer has passed it on.",
        },
      ],
    }),
  );

  console.log(
    JSON.stringify(
      {
        dryRun,
        adminEmail,
        adminId,
        settings: settingActions,
        chains,
      },
      null,
      2,
    ),
  );
} finally {
  await sql.end({ timeout: 1 });
}
