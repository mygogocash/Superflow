# ARIA training-data pipeline

Design + phased plan for capturing structured, governed interaction data so the
ARIA agent can be improved and, in future, trained (RAG tuning, eval sets,
preference tuning, SFT, tool-use fine-tuning).

Status: **Phase 0 + Phase 1 landed** (schema + capture behind a fail-closed
flag). Later phases are scoped below, not yet built.

---

## Why

ARIA already has a mature RAG + feedback + eval foundation:

- Conversations / messages / summaries / memory, attachments.
- `AriaFeedback` (thumbs + reason, admin review → knowledge article).
- `AriaKnowledgeArticle` corpus (permission-gated, auto-synced + feedback-sourced).
- `AriaQueryLog` per-turn **aggregate** telemetry (retrieval distances, tokens,
  latency, model, tool count/names) with a 30-day PII purge.
- Eval suites: `aria-retrieval.eval`, `aria-sync.eval`, `aria-tools.eval`.

The gap for *training* is that turns are not captured as **complete, replayable
records**. `AriaQueryLog` keeps aggregates (tool count + names, distances) — not
the exact prompt revision, the RBAC context the turn ran under, the tool
**args + results**, or the produced output. Those are the substrate every
training method needs. Capturing them is the highest-leverage first step
regardless of which training we eventually do.

## What "training" can mean (data shape differs by target)

| Target | Data it needs | Cost |
|---|---|---|
| RAG / retrieval tuning (in place) | corpus + retrieval logs + feedback | low |
| Eval-driven prompt/policy | graded Q→expected sets | low |
| Preference tuning (DPO) | (prompt, chosen, rejected) | medium |
| Supervised fine-tune (SFT) | (full input context → ideal output) | high |
| Tool-use / function-calling FT | full tool-call traces + correctness | high |

**Strategy:** capture complete traces now (prerequisite for DPO/SFT/tool-use and
richer RAG/evals), bank early value with RAG + evals + DPO-from-feedback (reuses
the thumbs signal already collected), defer SFT/tool-use fine-tuning until trace
volume + labels justify it.

## The canonical record — `aria_interaction_traces`

One immutable, append-only row per assistant turn (Prisma model
`AriaInteractionTrace`, `packages/database/prisma/schema/comms.prisma`). Distinct
from `AriaQueryLog` (which stays for the admin insights page). Key fields:

- **Identity / versioning:** `conversationId`, `userId`, `assistantMessageId`
  (join key to `AriaFeedback`), `turnKind` (`send`/`edit`/`retry` — edit/retry
  are preference signal), `promptVersion` (digest of the system prompt),
  `model`, `maxTokens`.
- **Input:** `userMessage`, **`permissionsSnapshot`** (the actor's permission
  codes at turn time → RBAC-aware dataset filtering), `offeredTools`,
  `retrievedArticleIds` + `retrievedDistances` + `topDistance` + `retrievalMode`,
  `workspaceBytes`, `knowledgeBytes`.
- **Output:** `assistantText`, `stopReason`, **`toolCalls`** (JSON:
  `[{ name, input, ok, isError, resultPreview }]` — the args + results the query
  log discards; result payloads capped at 8 KB), `toolUseCount`, `toolNames`.
- **Cost / status:** `tokensIn/Out`, `cacheReadTokens/cacheCreateTokens`,
  `latencyMs`, `error`, `errorMessage`.
- **Governance:** `piiRedacted` (redaction transform runs in Phase 2),
  `createdAt`.

Feedback is **not** copied onto the trace — it is joined at dataset-build time
via `assistantMessageId` → `AriaFeedback`, keeping the trace immutable.

## Capture (Phase 1, landed)

`aria.service.chatStream` emits a trace after the assistant message is persisted,
**best-effort** (its own try/catch — a failure never affects chat) and gated
behind the fail-closed flag **`ARIA_TRACE_CAPTURE`** (`=== "true"`; unset = off).
It reuses the proven `AriaQueryLog` write discipline. `promptVersion` is a
sha256 digest of the system prompt so a trace is attributable to an exact prompt
revision without inlining the prompt.

Enable per environment via `ARIA_TRACE_CAPTURE=true` (Worker `vars` / API env);
it is in `turbo.json` `globalEnv`.

## Pipeline stages (target)

capture → **raw trace store** (this table; later also an append-only export to
object storage/warehouse as JSONL/Parquet, partitioned by day + tenant, to keep
the ERP OLTP DB lean) → **redact / pseudonymize** (extend the existing PII-purge
cron into a redaction transform; flip `piiRedacted`) → **normalize** →
**label / curate** (join feedback + admin corrections; auto-label groundedness +
tool-correctness) → **dataset builder** (versioned, split, provenance; emits SFT
JSONL / DPO pairs / eval sets / retrieval-tuning sets) → export → **train +
eval** (external trainer; register candidate) → **eval gate** (reuse the ARIA
eval suites + a held-out set; block promotion on regression) → deploy prompt /
model version → loop.

## Governance

- **RBAC-aware datasets** — `permissionsSnapshot` lets the dataset builder filter
  to what the acting role could legitimately see; never train on data a role
  couldn't access.
- Per-tenant isolation + opt-out/consent; **redaction before any export**;
  tiered retention (raw PII short, redacted trace long) — extends
  `aria-pii-purge`.
- Provenance + dataset versioning for reproducibility and audit.

## Roadmap

- **Phase 0** — schema + governance policy. *(landed)*
- **Phase 1** — capture full traces behind `ARIA_TRACE_CAPTURE`. *(landed)*
- **Phase 2** — redaction transform + `piiRedacted` retention cron; dataset
  builder + versioning + export (JSONL/Parquet); feedback/correction join.
- **Phase 3** — eval gate + DPO-from-feedback + retrieval tuning.
- **Phase 4** — SFT / tool-use fine-tune; register + eval-gate + canary.
- **Phase 5** — closed loop + monitoring (PostHog LLM analytics), drift + cost
  dashboards.

## Open decisions

- Trace sink beyond Postgres (object storage / warehouse — the CLAUDE.md notes
  mention a Databricks / Depot ERP-export direction).
- Which training target(s) to prioritize first (recommendation:
  RAG + evals + DPO before any fine-tune).
