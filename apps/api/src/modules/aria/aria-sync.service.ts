import { logger } from "@/common/utils/logger";
import { prisma } from "@/infrastructure/database/prisma";
import { ariaRepository } from "@/modules/aria/aria.repository";
import {
  articleEmbeddingInput,
  generateEmbedding,
  vectorLiteral,
} from "@/modules/aria/aria-embedding.service";

/**
 * ARIA Phase 4 — auto-sync curated content into the knowledge corpus.
 *
 * The chat-time knowledge lookup reads from `aria_knowledge_articles`,
 * but until Phase 4 admins had to hand-write every article. This
 * module pulls active rows from the operational tables that employees
 * already maintain (leave types, public holidays, partners, projects,
 * company policies) and upserts them as auto-generated articles.
 *
 * Conventions for every auto-synced row:
 * - `slug` is deterministic: `auto-<source>-<id>` (or `auto-<source>-<entity-year>`).
 *   Re-running the sync upserts in place.
 * - `tags` contain "auto-synced" plus the source key. Admins must not
 *   hand-edit these rows — the next sync run overwrites the body.
 * - `requiredPermissions` is set per source so private content
 *   (partners, projects) only surfaces to users with the right perm.
 * - Embedding regeneration is best-effort and runs inline so the
 *   article is immediately searchable on the next chat turn.
 *
 * Orphan handling: rows previously synced from a source but no longer
 * present (or now inactive) are soft-deactivated (`isActive = false`)
 * rather than deleted, so admins can audit what changed.
 */

const AUTO_TAG = "auto-synced";

type SourceKey =
  | "leave-type"
  | "public-holiday"
  | "partner"
  | "project"
  | "company-policy";

interface SyncStats {
  source: SourceKey;
  upserted: number;
  deactivated: number;
}

interface ArticleUpsertInput {
  slug: string;
  category: string;
  title: string;
  body: string;
  keywords: string[];
  tags: string[];
  requiredPermissions: string[];
}

/**
 * Upsert one auto-synced article and refresh its embedding. Returns
 * the row's id so callers can collect the set of "still alive" ids
 * for orphan deactivation.
 */
async function upsertAutoArticle(input: ArticleUpsertInput): Promise<string> {
  const existing = await prisma.ariaKnowledgeArticle.findUnique({
    where: { slug: input.slug },
    select: { id: true, body: true, title: true, keywords: true },
  });

  const article = await prisma.ariaKnowledgeArticle.upsert({
    where: { slug: input.slug },
    create: {
      slug: input.slug,
      category: input.category,
      title: input.title,
      body: input.body,
      keywords: input.keywords,
      tags: input.tags,
      requiredPermissions: input.requiredPermissions,
      isActive: true,
    },
    update: {
      category: input.category,
      title: input.title,
      body: input.body,
      keywords: input.keywords,
      tags: input.tags,
      requiredPermissions: input.requiredPermissions,
      isActive: true,
    },
    select: { id: true },
  });

  const contentChanged =
    !existing ||
    existing.body !== input.body ||
    existing.title !== input.title ||
    existing.keywords.join("|") !== input.keywords.join("|");

  if (contentChanged) {
    try {
      const text = articleEmbeddingInput({
        title: input.title,
        body: input.body,
        keywords: input.keywords,
      });
      const vec = await generateEmbedding(text);
      if (vec) {
        await ariaRepository.setKnowledgeEmbedding(
          article.id,
          vectorLiteral(vec),
        );
      }
    } catch (err) {
      logger.warn("ARIA auto-sync embed failed", {
        slug: input.slug,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return article.id;
}

/**
 * Soft-deactivate any auto-synced article from `source` whose id is
 * not in `aliveIds`. We keep the row (and its embedding) so historical
 * chats that referenced the article still resolve, but the gate flips
 * to inactive so the chat-time lookup skips it.
 */
async function deactivateOrphans(
  source: SourceKey,
  aliveIds: string[],
): Promise<number> {
  const result = await prisma.ariaKnowledgeArticle.updateMany({
    where: {
      tags: { hasEvery: [AUTO_TAG, source] },
      isActive: true,
      id: {
        notIn:
          aliveIds.length > 0
            ? aliveIds
            : ["00000000-0000-0000-0000-000000000000"],
      },
    },
    data: { isActive: false },
  });
  return result.count;
}

// ── Per-source workers ──────────────────────────────────────────────

async function syncLeaveTypes(): Promise<SyncStats> {
  const rows = await prisma.leaveType.findMany({
    where: { isActive: true },
    include: { entity: { select: { name: true, code: true } } },
  });

  const aliveIds: string[] = [];
  for (const row of rows) {
    const entityLabel = row.entity
      ? `${row.entity.name} (${row.entity.code})`
      : "All entities";
    const slug = `auto-leave-type-${row.id}`;
    const title = `Leave policy — ${row.name} (${entityLabel})`;
    const lines = [
      `Leave type: ${row.name}`,
      `Code: ${row.code}`,
      `Category: ${row.category}`,
      `Applies to: ${entityLabel}`,
      `Default days per year: ${row.daysPerYear}`,
      `Paid: ${row.isPaid ? "yes" : "no"}`,
      `Requires approval: ${row.requiresApproval ? "yes" : "no"}`,
    ];
    if (row.description) lines.push("", row.description.trim());
    const id = await upsertAutoArticle({
      slug,
      category: "hr",
      title,
      body: lines.join("\n"),
      keywords: [
        row.name,
        row.code,
        row.category,
        "leave policy",
        row.entity?.code ?? "",
      ].filter(Boolean),
      tags: [AUTO_TAG, "leave-type"],
      requiredPermissions: [],
    });
    aliveIds.push(id);
  }

  const deactivated = await deactivateOrphans("leave-type", aliveIds);
  return { source: "leave-type", upserted: aliveIds.length, deactivated };
}

async function syncPublicHolidays(): Promise<SyncStats> {
  // Group active holidays by (entity, year) and emit one article per
  // bucket. A per-row article would be noisy and miss the "list all
  // holidays for the TH entity in 2026" use case.
  const rows = await prisma.publicHoliday.findMany({
    where: { isActive: true },
    include: { entity: { select: { id: true, name: true, code: true } } },
    orderBy: { date: "asc" },
  });

  type Bucket = {
    entityId: string;
    entityName: string;
    entityCode: string;
    year: number;
    holidays: Array<{ date: Date; name: string; notes: string | null }>;
  };
  const buckets = new Map<string, Bucket>();
  for (const row of rows) {
    const year = row.date.getFullYear();
    const key = `${row.entity.id}:${year}`;
    if (!buckets.has(key)) {
      buckets.set(key, {
        entityId: row.entity.id,
        entityName: row.entity.name,
        entityCode: row.entity.code,
        year,
        holidays: [],
      });
    }
    buckets.get(key)!.holidays.push({
      date: row.date,
      name: row.name,
      notes: row.notes,
    });
  }

  const aliveIds: string[] = [];
  for (const b of Array.from(buckets.values())) {
    const slug = `auto-public-holiday-${b.entityCode.toLowerCase()}-${b.year}`;
    const title = `${b.year} public holidays — ${b.entityName} (${b.entityCode})`;
    const dateLines = b.holidays.map((h) => {
      const iso = h.date.toISOString().slice(0, 10);
      const extra = h.notes ? ` — ${h.notes.trim()}` : "";
      return `- ${iso}: ${h.name}${extra}`;
    });
    const body = [
      `${b.entityName} (${b.entityCode}) public holidays for ${b.year}.`,
      `Total: ${b.holidays.length}`,
      "",
      ...dateLines,
    ].join("\n");
    const id = await upsertAutoArticle({
      slug,
      category: "hr",
      title,
      body,
      keywords: [
        "public holiday",
        "holidays",
        b.entityName,
        b.entityCode,
        String(b.year),
      ],
      tags: [AUTO_TAG, "public-holiday"],
      requiredPermissions: [],
    });
    aliveIds.push(id);
  }

  const deactivated = await deactivateOrphans("public-holiday", aliveIds);
  return {
    source: "public-holiday",
    upserted: aliveIds.length,
    deactivated,
  };
}

async function syncPartners(): Promise<SyncStats> {
  // Cap per run so a tenant with thousands of partners doesn't pin the
  // embedder. Most active partners are well under 200; if a tenant
  // grows past that we can extend with a `cursor` here.
  const rows = await prisma.partner.findMany({
    where: { status: { not: "archived" } },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });

  const aliveIds: string[] = [];
  for (const p of rows) {
    const slug = `auto-partner-${p.id}`;
    const title = `${p.company} (${p.type})`;
    const lines = [
      `Partner: ${p.company}`,
      `Type: ${p.type}`,
      `Status: ${p.status}`,
    ];
    if (p.region) lines.push(`Region: ${p.region}`);
    if (p.country) lines.push(`Country: ${p.country}`);
    if (p.website) lines.push(`Website: ${p.website}`);
    if (p.contractValue) {
      lines.push(`Contract value: ${p.contractValue.toString()}`);
    }
    if (p.contractStart) {
      lines.push(
        `Contract start: ${p.contractStart.toISOString().slice(0, 10)}`,
      );
    }
    if (p.contractEnd) {
      lines.push(`Contract end: ${p.contractEnd.toISOString().slice(0, 10)}`);
    }
    if (p.description) lines.push("", p.description.trim());
    if (p.notes) lines.push("", `Notes: ${p.notes.trim()}`);

    const id = await upsertAutoArticle({
      slug,
      category: "other",
      title,
      body: lines.join("\n"),
      keywords: [p.company, p.type, p.country ?? "", p.region ?? ""].filter(
        Boolean,
      ),
      tags: [AUTO_TAG, "partner"],
      requiredPermissions: ["partners:read"],
    });
    aliveIds.push(id);
  }

  const deactivated = await deactivateOrphans("partner", aliveIds);
  return { source: "partner", upserted: aliveIds.length, deactivated };
}

async function syncProjects(): Promise<SyncStats> {
  const rows = await prisma.project.findMany({
    where: { status: { not: "archived" } },
    include: {
      owner: { select: { name: true, email: true } },
      partner: { select: { company: true } },
    },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });

  const aliveIds: string[] = [];
  for (const p of rows) {
    const slug = `auto-project-${p.id}`;
    const title = `Project — ${p.name}`;
    const lines = [
      `Project: ${p.name}`,
      `Slug: ${p.slug}`,
      `Status: ${p.status}`,
      `Progress: ${p.progress}%`,
      `Owner: ${p.owner?.name ?? "—"} <${p.owner?.email ?? "—"}>`,
    ];
    if (p.partner?.company) lines.push(`Partner: ${p.partner.company}`);
    if (p.startDate) {
      lines.push(`Start: ${p.startDate.toISOString().slice(0, 10)}`);
    }
    if (p.endDate) {
      lines.push(`End: ${p.endDate.toISOString().slice(0, 10)}`);
    }
    if (p.productionLiveDate) {
      lines.push(
        `Production live: ${p.productionLiveDate.toISOString().slice(0, 10)}`,
      );
    }
    if (p.budget) lines.push(`Budget: ${p.budget.toString()}`);
    if (p.description) lines.push("", p.description.trim());

    const id = await upsertAutoArticle({
      slug,
      category: "other",
      title,
      body: lines.join("\n"),
      keywords: [
        p.name,
        p.slug,
        p.status,
        p.partner?.company ?? "",
        "project",
      ].filter(Boolean),
      tags: [AUTO_TAG, "project"],
      requiredPermissions: ["projects:read"],
    });
    aliveIds.push(id);
  }

  const deactivated = await deactivateOrphans("project", aliveIds);
  return { source: "project", upserted: aliveIds.length, deactivated };
}

async function syncCompanyPolicies(): Promise<SyncStats> {
  // Company policies live as uploaded documents (PDF, DOCX). We can't
  // extract their full text from inside this service, so the auto
  // article carries the metadata + admin-supplied description. That
  // alone is usually enough for vector lookup to surface the right
  // policy in response to a question; the model can then advise the
  // user to open the document for the binding text.
  const rows = await prisma.companyPolicy.findMany({
    where: { isActive: true },
    include: { entity: { select: { name: true, code: true } } },
    orderBy: { updatedAt: "desc" },
  });

  const aliveIds: string[] = [];
  for (const p of rows) {
    const slug = `auto-company-policy-${p.id}`;
    const scope = p.entity
      ? `${p.entity.name} (${p.entity.code})`
      : "All entities";
    const title = `Policy — ${p.title}`;
    const lines = [
      `Title: ${p.title}`,
      `Category: ${p.category}`,
      `Applies to: ${scope}`,
    ];
    if (p.version) lines.push(`Version: ${p.version}`);
    if (p.effectiveDate) {
      lines.push(
        `Effective date: ${p.effectiveDate.toISOString().slice(0, 10)}`,
      );
    }
    lines.push(`Document: ${p.fileName}`);
    if (p.description) lines.push("", p.description.trim());
    lines.push(
      "",
      "Note: the binding policy text lives in the uploaded document; this article is a metadata summary for lookup. Refer the user to the document on the Company Policies page.",
    );
    const id = await upsertAutoArticle({
      slug,
      category: "policy",
      title,
      body: lines.join("\n"),
      keywords: [
        p.title,
        p.category,
        p.entity?.name ?? "",
        p.entity?.code ?? "",
        "policy",
      ].filter(Boolean),
      tags: [AUTO_TAG, "company-policy"],
      requiredPermissions: [],
    });
    aliveIds.push(id);
  }

  const deactivated = await deactivateOrphans("company-policy", aliveIds);
  return {
    source: "company-policy",
    upserted: aliveIds.length,
    deactivated,
  };
}

export interface SyncRunReport {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  perSource: SyncStats[];
  errors: Array<{ source: SourceKey; message: string }>;
}

export async function runAllSyncs(): Promise<SyncRunReport> {
  const startedAt = Date.now();
  const perSource: SyncStats[] = [];
  const errors: Array<{ source: SourceKey; message: string }> = [];

  // Sequential to avoid hammering the embedder. The combined cost is
  // dominated by the embedding round-trips, not the DB queries.
  const tasks: Array<{ source: SourceKey; run: () => Promise<SyncStats> }> = [
    { source: "leave-type", run: syncLeaveTypes },
    { source: "public-holiday", run: syncPublicHolidays },
    { source: "partner", run: syncPartners },
    { source: "project", run: syncProjects },
    { source: "company-policy", run: syncCompanyPolicies },
  ];

  for (const task of tasks) {
    try {
      const stats = await task.run();
      perSource.push(stats);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`ARIA auto-sync ${task.source} failed`, { err: message });
      errors.push({ source: task.source, message });
    }
  }

  const finishedAt = Date.now();
  return {
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs: finishedAt - startedAt,
    perSource,
    errors,
  };
}
