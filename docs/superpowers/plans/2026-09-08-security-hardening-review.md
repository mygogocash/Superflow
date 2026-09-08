# Security Hardening + Bug Hunt — Program Plan

> **For agentic workers:** Execute **one wave at a time**. Each wave ends in a PR with tests. Prefer `superpowers:subagent-driven-development` or `superpowers:executing-plans` per wave. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Systematically review and harden Manut so authz, tenancy, webhooks, secrets, and client storage match production best practices — without a big-bang rewrite.

**Architecture:** Edge (`apps/edge`) is the live API + SPA host; Express (`apps/api`) is legacy parity source; domain logic lives in `packages/core`; Better Auth + RBAC in `packages/auth`; Prisma (`packages/database`) + Drizzle (`packages/db`) share Neon/Postgres. Org tenancy is **partially landed** (schema + org APIs) but **ERP rows are still globally scoped** — treat cross-tenant IDOR as the #1 risk as multi-org rolls out.

**Tech Stack:** Hono on Cloudflare Workers, Better Auth, Prisma 6, Drizzle, Expo Router (`apps/app`), Next.js legacy (`apps/web`), Depot CI (`.depot/workflows/`).

## Global Constraints

- Live surface = **edge** (`apps/edge` + `apps/edge-jobs`). Fix edge first; keep Express parity via `pnpm route-parity` when touching routes.
- Permission codes stay `module:action`. Do **not** invent parallel authz systems.
- Soft-delete restore/permanent: **owner-or-HR in the service**, never route-only (`CLAUDE.md` IDOR trap).
- System Admin bypass today is `isSystem && name === "Admin"` — do **not** give that bypass to org Admin (`docs/ORG_TENANCY_RBAC_PLAN.md`).
- Staging uses `db:push` (no data-migration SQL). Prod uses `prisma migrate deploy`.
- Fail-closed for secrets: missing cron/webhook secrets must **reject**, never skip verification.
- No drive-by refactors; every wave is scoped, tested, conventional-commit PRs (`fix(security):` / `chore(security):`).
- Do **not** claim multi-org is “done” until Wave 3 invariants hold for touched modules.

**Related docs (read before Wave 1):** `docs/ORG_TENANCY_RBAC_PLAN.md`, `docs/AUTH_RBAC.md` (legacy Supabase sections — edge/Better Auth is source of truth), `docs/STRIPE_BILLING_PLAN.md`, `CLAUDE.md` soft-delete + approval-chain pitfalls, `.agents/skills/security-review/` if present.

**Out of scope for this program:** Full org-column backfill of every ERP table (that is the ORG plan’s implementation track). This program **audits**, **hardens fail-closed gaps**, and **gates** tenancy so new code cannot regress.

---

## Wave map (execute in order)

| Wave | Theme | Severity focus | Ship as |
|------|--------|----------------|---------|
| 0 | Inventory + tooling baseline | Enable detection | chore PR |
| 1 | Authn / session / perimeter | Session theft, fail-open Access | fix PR(s) |
| 2 | Authz / IDOR / soft-delete | Horizontal privilege | fix PR(s) |
| 3 | Org-tenancy readiness | Cross-tenant data leak | fix + docs PR |
| 4 | Webhooks / cron / jobs | Forged jobs, secret abuse | fix PR |
| 5 | XSS / uploads / signed URLs | Client + storage | fix PR |
| 6 | Data layer / raw SQL / RLS | Injection + silent over-fetch | fix + verify PR |
| 7 | CI security gates + secrets hygiene | Supply chain | ci PR |
| 8 | Module deep-dives (finance → HR → CRM → AI) | Residual bugs | series of PRs |

Each wave below is independently reviewable. Do not start Wave N+1 until Wave N’s PR is green on Depot `Validate`.

---

## Wave 0 — Inventory + review harness

**Files:** `scripts/` (new audit scripts), `.depot/workflows/pr-checks.yml` (later Wave 7), `docs/ops/` (findings log).

### Tasks

- [x] Create `docs/ops/SECURITY_REVIEW_LOG.md` with columns: id, wave, severity, surface, status, PR.
- [x] Script `scripts/security/ungated-routes.mjs`: list edge routes and api controllers **without** `requirePermission` / explicit public allowlist annotation; fail CI later if new ungated routes appear without allowlist.
- [x] Script `scripts/security/dangerously-html.mjs`: list `dangerouslySetInnerHTML` / Expo `RichHtml` call sites and whether a sanitizer is in the same file.
- [x] Document current ungated allowlist (expected): `cron`, `health`, `line` webhook, `auth/*`, `me` (session), `push` (if intentional), `telemetry`, Better Auth handlers.
- [x] Run `pnpm route-parity` and record Express-only public/webhook routes missing on edge.
- [x] Commit: `chore(security): add review inventory harness + log`

### Verify

- [x] Scripts run locally and print actionable lists (exit 0 in Wave 0; Wave 7 can make them gate).

---

## Wave 1 — Authentication, session, perimeter

**Files (primary):**  
`packages/auth/src/server.ts`, `apps/edge/src/middleware/auth.ts`, `apps/edge/src/middleware/access.ts`, `apps/edge/src/lib/access.ts`, `apps/edge/src/app.ts`, `apps/app/src/lib/session.ts`, `apps/app/src/lib/api-client.ts`, `apps/web/src/lib/api-client.ts`.

### Threats

- Expo `intranet.session.v1` (or current key) in localStorage → XSS = account takeover.
- CF Access fail-open when `CF_ACCESS_AUD` empty.
- Stale permission cache after role revoke.
- Magic-link / recovery abuse (rate limits, allowlists).

### Tasks

- [x] Confirm production/staging: httpOnly Better Auth cookies vs Bearer-from-storage; write decision in SECURITY_REVIEW_LOG (prefer cookies for web; document native constraints).
- [x] Ensure logout clears **all** client session stores (cookie + any `*session.v1` keys).
- [x] Add tests: unauthenticated `/api/*` (except allowlist) → 401; revoked session rejected.
- [x] CF Access: document env matrix; for production, require `CF_ACCESS_AUD` **or** explicitly document residual risk + compensating controls (Turnstile, rate limit, Trusted Origins).
- [x] Audit `TRUSTED_ORIGINS` vs Expo web / staging / prod hosts.
- [x] Review permission KV/cache TTL; on role/permission mutation, invalidate cache (or document 60s window as accepted risk with ticket).
- [x] Commit: `fix(security): harden session logout + access perimeter docs/tests`

### Verify

- [x] Vitest edge auth/access tests green.
- [ ] Manual: login → logout → API call with old token fails.

---

## Wave 2 — Authorization, IDOR, soft-delete

**Files (primary):**  
`apps/edge/src/middleware/rbac.ts`, `packages/auth/src/rbac.ts`, soft-delete helpers under `apps/api/src/infrastructure/soft-delete.ts` (and edge/core equivalents), modules with restore/permanent (leave, travel, expenses, cash-advance, visa, users, accounting, investors — grep `IncludingDeleted` / `restore`).

### Threats

- Route grants `*:create` but restore lacks owner-or-HR service check → IDOR.
- `assertCanActOnStep` wrong on approval chains → cross-user approve.
- `findById` without ownership after list scoping.

### Tasks

- [x] Grep all `restore` / `permanent` / `IncludingDeleted` handlers; for each, assert service-level owner-or-HR (or module-specific) check exists + has a unit test.
- [x] Spot-check approval modules (travel, cash-advance, expenses, leave, proposals, approval-chains): route is read-gated; **authority** is `assertCanActOnStep` / identity.
- [x] Add negative tests: user A cannot restore/approve/delete user B’s resource (one test per module family).
- [x] Audit `requireSystemAdmin` usages — ensure none are reachable by org Admin post-tenancy.
- [x] Commit: `fix(security): close soft-delete and approval IDOR gaps`

### Verify

- [x] New IDOR tests fail before fix, pass after.
- [x] `pnpm --filter @nexora/api test` / edge equivalent for touched suites.

---

## Wave 3 — Org tenancy readiness (fail-closed path)

**Files:**  
`docs/ORG_TENANCY_RBAC_PLAN.md`, `packages/auth/src/org-rbac.ts`, `packages/core/src/organizations/*`, `apps/edge/src/routes/organizations.ts`, `apps/edge/src/routes/me.ts`, users list scoping, any service already filtering by `organizationId`.

### Threats

- Shipping multi-org UI while ERP queries ignore `activeOrganizationId` → cross-tenant read/write.
- Org Admin inheriting global Admin bypass.

### Tasks

- [ ] Inventory tables with `organizationId` vs without (script or SQL against schema).
- [ ] Codify invariant helper: `assertSameOrg(resource.organizationId, actor.activeOrganizationId)` for org-scoped resources; use in organizations + users first.
- [ ] Ensure Platform Admin vs Org Super Admin split is enforced in org routes (no customer Super Admin listing other orgs).
- [ ] Feature-flag or fail-closed: if `ORG_TENANCY_ENFORCED=true`, reject ERP handlers that lack org filter (start with users + org membership only; expand module-by-module — do not pretend whole ERP is done).
- [ ] Update SECURITY_REVIEW_LOG with “tenancy debt” list ordered by PII/finance sensitivity (payroll → expenses → CRM → content).
- [ ] Commit: `fix(security): org-scope invariants for memberships + users`

### Verify

- [ ] Tests: member of Org A cannot read Org B membership/users.
- [ ] Platform Admin path still works and is audited/logged.

---

## Wave 4 — Webhooks, cron, edge-jobs

**Files:**  
`apps/edge/src/routes/cron.ts`, `apps/edge-jobs/**`, `apps/edge/src/routes/line.ts`, helpdesk GitHub HMAC, DocuSign/legal webhooks, future Stripe (`docs/STRIPE_BILLING_PLAN.md`).

### Threats

- Missing/short `CRON_SECRET` → arbitrary job run (PII purge, reminders).
- Non-timing-safe secret compare.
- Webhook signature skipped when secret unset.
- Route-parity: webhook on Express only, not edge (or vice versa).

### Tasks

- [ ] Cron: require secret length ≥ 32 in prod guidance; compare with `crypto.timingSafeEqual` on equal-length buffers.
- [ ] Fail-closed: empty webhook secret → 401/500, never process body.
- [ ] Matrix in SECURITY_REVIEW_LOG: LINE, GitHub, DocuSign, Stripe (planned) — raw body, header, rotation owner.
- [ ] Confirm edge-jobs only calls allowlisted cron paths with secret header.
- [ ] Commit: `fix(security): timing-safe cron/webhook secret verification`

### Verify

- [ ] Unit tests: wrong secret / missing secret / valid secret.
- [ ] Staging dry-run of one cron with intentional bad secret → rejected.

---

## Wave 5 — XSS, HTML email, uploads, signed URLs

**Files:**  
`apps/web` rich HTML + `sanitizeRichHtml`, `apps/app` DOM rich HTML, email `escapeHtml` templates (api + edge), `apps/edge/src/routes/uploads.ts`, R2 public vs private buckets, agreement/document download signed-URL paths.

### Threats

- Unsanitized `dangerouslySetInnerHTML`.
- Email HTML injection (notes, names, bank details).
- Sensitive files on public R2 prefixes.
- Raw private `fileUrl` returned to client.

### Tasks

- [ ] Close every Wave 0 HTML inventory gap (sanitize or remove).
- [ ] Grep email templates for unescaped interpolations; standardize on `escapeHtml`.
- [ ] Uploads: assert content-type/size limits; public bucket allowlist only avatars/marketing assets.
- [ ] Document download: ownership check + short-lived signed URL only.
- [ ] Commit: `fix(security): sanitize HTML and lock down uploads/signed URLs`

### Verify

- [ ] Existing `sanitize-rich-html` tests + new XSS fixture tests.
- [ ] Attempt fetch of private object URL without signature fails.

---

## Wave 6 — Data layer, raw SQL, RLS

**Files:**  
Prisma `$queryRaw` call sites (~aria, accounting, admin usage, CRM), Drizzle `sql\`\`` in `packages/core`, `packages/database/scripts/apply-rls.ts` (or equivalent), soft-delete filters on raw SQL.

### Threats

- String-concat SQL (injection).
- Raw queries skipping `deletedAt` or org/owner filters.
- RLS scripts exist but not applied on Neon role used by Hyperdrive.

### Tasks

- [ ] Ban review: every `$queryRaw` / `sql\`\`` must use bound parameters; flag template-string user input.
- [ ] Confirm Hyperdrive DB role and whether RLS is enabled; if not, document “application-layer tenancy only” and prioritize Wave 3.
- [ ] Fix any raw query that returns soft-deleted or cross-owner rows.
- [ ] Commit: `fix(security): parameterize and scope raw SQL hotspots`

### Verify

- [ ] Targeted repository tests with another user’s id → empty/403.

---

## Wave 7 — CI security baseline

**Files:** `.depot/workflows/pr-checks.yml`, optional `scripts/security/*`, Dependabot/renovate config if used.

### Tasks

- [ ] Add `pnpm audit --prod` (or equivalent) job — start as **warn**, then ratchet to fail on high after triage.
- [ ] Add secret scan (gitleaks or depot-native) on PRs.
- [ ] Optionally gate `ungated-routes.mjs` / HTML inventory as required check.
- [ ] Ensure deploy workflows fail if `BETTER_AUTH_SECRET` / `CRON_SECRET` missing.
- [ ] Commit: `ci(security): audit + secret scan on PR checks`

### Verify

- [ ] PR shows new checks; intentional test secret in a branch is caught in dry-run.

---

## Wave 8 — Module deep-dive bug hunt (batched)

Run as **separate PRs** per domain, using Wave 0–2 checklists:

1. **Finance:** expenses, cash-advance, accounting, payroll, vendors  
2. **HR:** leave, travel, visa, attendance, ESOP/agreements  
3. **CRM / projects:** sales, investors, IT/legal CRM, proposals, approval-chains  
4. **Content / comms:** wall, news, survey, docs, uploads  
5. **AI / ARIA:** tools RBAC, PII in logs, prompt injection notes in `ai-prompts.ts`  
6. **Admin / telemetry / push:** ensure no PII over-exposure

### Per-module checklist (copy into each PR)

- [ ] Every mutating route: auth + permission + service ownership/org check  
- [ ] List endpoints: server-side scope (never trust client filter alone)  
- [ ] Soft-delete restore/permanent IDOR test  
- [ ] Email/notification paths escape user content  
- [ ] No new ungated route without allowlist entry  
- [ ] Parity: edge route exists if Express had it  

---

## Severity rubric (for SECURITY_REVIEW_LOG)

| Sev | Meaning | SLA to fix once found |
|-----|---------|------------------------|
| P0 | Auth bypass, cross-tenant read/write, RCE, secretless webhook | Immediate hotfix PR |
| P1 | IDOR on PII/finance, XSS session theft, cron forgery | Same wave / next PR |
| P2 | Cache delay, missing rate limit, defense-in-depth | Backlog in-wave |
| P3 | Docs drift, lint hygiene | chore |

---

## Definition of done (program)

- [ ] Waves 0–7 merged (or explicitly waived with written residual risk).  
- [ ] SECURITY_REVIEW_LOG has no open P0/P1.  
- [ ] Org tenancy debt list is prioritized and linked to `ORG_TENANCY_RBAC_PLAN.md` implementation issues.  
- [ ] CI runs audit + secret scan.  
- [ ] Soft-delete and webhook/cron hardening tests are required and green.

---

## Suggested first PR (start here)

**Wave 0 only** — inventory scripts + SECURITY_REVIEW_LOG. No behavior change. Unblocks every later wave with a shared findings file and automated surface lists.
