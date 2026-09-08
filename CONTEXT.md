# CONTEXT.md — Intranet repo orientation

Quick reference for engineers (and AI agents) joining the codebase. Lives alongside CLAUDE.md (rules) + docs/ (deep references). Read this first when you need to find where something lives or how a slice talks to the next one.

---

## What this project is

This GitHub repository is [`mygogocash/Manut`](https://github.com/mygogocash/Manut). Default branch `main`; env branches `preview` (staging) and `production` (prod).

**Intranet** is the product — an internal ERP covering HR, Finance, Operations, Sales, Investor Relations, Communication. Multi-entity (TH / AE / SG / PT) with localised payroll + compliance. Brand name is **Intranet**; workspace packages stay `@nexora/*` (monorepo implementation detail, never user-visible).

Do not claim a public URL is this repo's live deploy until a `production` (or `preview`) workflow has actually run.

For product framing, read `docs/PROJECT_OVERVIEW.md`. For module-by-module scope, `docs/MODULES_SPECIFICATION.md`. For permission semantics, `docs/AUTH_RBAC.md`. For DB shape, `docs/DATABASE_SCHEMA.md`.

---

## Stack at a glance

| Layer    | Tech                                                                              |
|----------|-----------------------------------------------------------------------------------|
| Backend  | Express 5 + TypeScript, Prisma 6, PostgreSQL (Supabase SG `aws-1-ap-southeast-1`) |
| Edge     | Hono + Hono RPC on Cloudflare Workers. Hyperdrive → Postgres is the ERP SoT. D1/DO/Queues/Workflows/R2/Vectorize/Access are sidecar primitives. Better Auth + `apps/edge-jobs` |
| Auth     | Supabase Auth (JWT) on Express; Better Auth on the edge                           |
| Frontend | Expo 54 + Expo Router + NativeWind v4 + Reusables + TanStack Query/Table (`apps/app`, official web on :8081); Next.js 16 (`apps/web`) is the legacy Cloud Run / Vercel / Playwright UI |
| Forms    | react-hook-form + zod (`@hookform/resolvers/zod`) — shared validation shape       |
| State    | Expo: TanStack Query + zustand auth. Next.js: React state + module-level caches (see `useLeadSources`) |
| Email    | Resend (transactional)                                                            |
| AI       | Anthropic (ARIA assistant) + Gemini for select flows                              |
| Build    | Turborepo + pnpm 10                                                               |
| Infra    | GCP Cloud Run on `production`; staging Cloud Run + edge on `preview`              |
| Telemetry | PostHog (`packages/database` + `apps/api/src/modules/telemetry`)                 |

---

## Repo layout

```
apps/
  api/         # Express server — :3001 locally, Cloud Run on production
  web/         # Next.js legacy UI — :3000 (`pnpm dev:web:next`)
  edge/        # Hono Cloudflare Worker (Express port)
  edge-jobs/   # Cron Triggers + Queue fan-out
  app/         # Expo official web — :8081 (`pnpm dev:web`)
packages/
  database/      # Prisma schema (split per domain) + migrations + seed
  db/            # Drizzle schema for the edge
  core/          # Shared domain services for the edge
  auth/          # Better Auth helpers
  contracts/     # Shared route / DTO contracts
  ui/            # Shared utils + re-exports only. The shadcn components
                 # live in apps/web/src/components/ui/ (56 files).
  types/         # Shared TS types
  utils/         # Shared helpers
  ops/           # Ops scripts (one-shots, not shipped to runtime)
  eslint-config/ # Shared lint config
docker/   # Cloud Run images (Dockerfile.api / Dockerfile.web)
docs/     # PRDs, specs, handoffs (human-curated, mostly read-only for AI)
e2e/      # Playwright suites
.agents/  # Agent prompts + CLAUDE.md drop-ins
.github/workflows/   # production + preview deploys + pr-checks
```

Workspace package names: `@nexora/api`, `@nexora/web`, `@nexora/database`, `@nexora/edge`, `@nexora/app`, `@nexora/db`, `@nexora/ui`, `@nexora/types`, `@nexora/utils`.

---

## How a request flows

Expo (`apps/app`) talks to Express `:3001` by default, or the Hono Worker `:8787` when `EXPO_PUBLIC_APP_URL` is set. Use `createEdgeClient()` for Hono RPC against the Worker. ERP reads/writes stay on Hyperdrive → Postgres; D1/DO/Workflows are sidecar only.

```
Browser → apps/web (Next 16 App Router)
  page component (server or "use client")
    → src/services/<module>.service.ts (typed wrapper)
      → src/lib/api-client.ts (fetch + httpOnly session cookie, credentials: "include")
        → apps/api/src/modules/<module>/<module>.controller.ts
          → authenticate middleware (resolves user, roles, perms from JWT)
            → requirePermission("<scope>:<action>") guard
              → <module>.service.ts (business logic + scoping)
                → <module>.repository.ts (Prisma calls only)
                  → PostgreSQL (Supabase)
```

**Don't `fetch` directly in components** — always go through `apps/web/src/services/*`. Don't `throw new Error("...")` in controllers — use the typed exceptions in `apps/api/src/common/exceptions/http-exception`.

---

## Module conventions (backend)

For each domain `<m>` in `apps/api/src/modules/<m>/`:

| File                  | Responsibility                                                                                |
|-----------------------|-----------------------------------------------------------------------------------------------|
| `<m>.controller.ts`   | Express route handlers + `Router()` registration. Parses query / body, calls service.         |
| `<m>.service.ts`      | Business logic + RBAC scoping (`canReadAll` etc). Throws typed exceptions.                    |
| `<m>.repository.ts`   | Prisma access ONLY. No business logic — keeps tests + future ORM swap easy.                   |
| `<m>.validation.ts`   | Zod schemas + inferred `*Input` types. Single source of truth for body shape.                 |
| `<m>.constants.ts`    | Module-scoped enums / sentinel values (if needed).                                            |

**Route order pitfall** (bitten twice): literal paths must register BEFORE `:id` patterns. `/import`, `/reorder`, `/dashboard`, `/inbox-count` all go first; Express otherwise eats the literal as an id. See `investors.controller.ts` for a recent example.

**RBAC scoping pattern** (see CLAUDE.md "RBAC scoping conventions" for the canonical text):
- Module needs a `<scope>:read-all` permission. Admin role has it via seed.
- List service compares `actorPermissions.includes("<scope>:read-all")` — if false, forces `addedBy = userId` (or equivalent owner filter).
- Same check on `getById`, `update`, `delete` — 403 when actor isn't owner and lacks `read-all`.

---

## Module conventions (frontend)

For each route group `apps/web/src/app/(dashboard)/<m>/`:

- `page.tsx` — typically `"use client"` (most pages need form state + react-query-ish patterns)
- Per-feature dialogs / sheets in `apps/web/src/components/<m>/` — e.g. `investor-form-dialog.tsx`, `investor-detail-sheet.tsx`
- API calls go through `apps/web/src/services/<m>.service.ts`
- Forms: react-hook-form + `zodResolver(formSchema)` + shadcn `Form` primitives
- Reset form via `useEffect(() => form.reset(...), [open, payload, form])`. `UserListItem` ≠ `UserDetail` — fetch detail on open if you need fields the list omits (see `employee-form-dialog.tsx`).
- Auth state: `useAuth()` → `{ user, roles, permissions, hasPermission, hasRole, refreshUser }`. Call `refreshUser()` after role/permission mutations affecting the current user.

**Shared CRM patterns** (already factored — reuse, don't reinvent):
- `components/shared/data-table.tsx` — generic table (used by smaller modules)
- `components/shared/sortable-column-head.tsx` — drag+resize+sort header cell (#732)
- `components/shared/use-column-order.ts` — persisted column reorder (localStorage)
- `components/shared/use-column-widths.ts` — persisted column resize
- `components/shared/crm-import-dialog.tsx` — xlsx/csv import dialog with field-spec aliases
- `components/shared/permission-button.tsx`, `permission-dropdown-menu-item.tsx` — gated UI
- `components/shared/data-pagination.tsx` + `hooks/use-pagination.ts` — page/limit state
- `lib/crm-export.ts` — CSV/xlsx export with sniffed header row support
- `components/shared/form-date-picker.tsx` — brand-styled date input (Tailwind v4 friendly)

**dnd-kit reference**: see `apps/web/src/components/accounts/accounts-tab.tsx` for the canonical row+column reorder + resize implementation. `apps/web/src/app/(dashboard)/investors/page.tsx` mirrors it.

---

## Database

- One Prisma schema file per domain in `packages/database/prisma/schema/*.prisma`. Total ~4,600 lines across 14 files.
- Aggregated client via `prisma.config.ts` at the package root.
- `pnpm db:generate` after schema edits. `pnpm db:migrate -- --name <slug>` for new migrations.
- **Never edit a committed migration.** New change → new migration. Migrations are also **idempotent** when reasonably possible (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`).
- Data migrations: explicit `created_at = NOW(), updated_at = NOW()` for tables with `@updatedAt` columns (raw SQL doesn't trigger Prisma defaults — see PR #734 P3018 fix).

Schema files:

| File              | Domains covered                                                              |
|-------------------|------------------------------------------------------------------------------|
| `base.prisma`     | Datasource + generator config                                                |
| `core.prisma`     | User / Entity / Role / Permission / Session                                  |
| `rbac.prisma`     | Role-Permission joins                                                        |
| `hr.prisma`       | Employee / Department / Leave / Payroll / Benefits / Performance support / Attendance (policy, record, correction, shift, exception, audit log) / ESOP grants / Survey Forms (form, question, response, answer) |
| `sales-crm.prisma`| Lead / Account / Opportunity / LeadSource / Activity                         |
| `legal.prisma`    | LegalProject / Document / Agreement                                          |
| `investors.prisma`| Investor / Investment / DataRoomDocument / InvestorUpdate + Investor CRM: InvestorPipelineStage / InvestorLead / InvestorAccount / InvestorContact / InvestorTask / InvestorActivity |
| `operations.prisma`| Project / Task / Office / Booking / IT helpdesk / QA                       |
| `finance.prisma`  | Account / Transaction / Expense / Revenue / Exchange rate / Cash advance     |
| `helpdesk.prisma` | IT helpdesk tickets + categories                                             |
| `content.prisma`  | Blog / Article / News / Wall                                                 |
| `comms.prisma`    | Message / Notification / Email log                                           |
| `performance.prisma`| Performance review / 90-day plans / Goals                                  |
| `integrations.prisma`| Google OAuth tokens, Resend, etc                                          |
| `system.prisma`   | App settings + feature flags                                                 |

---

## Environment files

| File                         | Purpose                                                              |
|------------------------------|----------------------------------------------------------------------|
| `.env.development` (root)    | Local dev. Loaded by `apps/api/src/env.ts` when `NODE_ENV=development`. |
| `apps/web/.env.development`  | Next.js mirror of `NEXT_PUBLIC_*` + `API_URL` (Next doesn't read parent `.env`). |
| `.env.production` (root)     | Prod keys. **Never committed.** Cloud Run gets them via `--set-env-vars` from GitHub Secrets. |
| `apps/web/.env.production`   | Web mirror for prod build.                                           |
| `.env`                       | Legacy fallback (`ANTHROPIC_API_KEY` only).                          |

Adding a new secret: root `.env.development` → mirror in web if `NEXT_PUBLIC_*` → add to `turbo.json` `globalEnv` → add to GitHub Secrets → add to `deploy.yml` `--set-env-vars`.

---

## Daily commands

```bash
pnpm dev:api        # Express on :3001
pnpm dev:web        # Expo official web on :8081
pnpm dev:web:next   # Next.js legacy UI on :3000
pnpm dev:edge       # wrangler dev
pnpm dev:app        # alias for Expo
pnpm dev            # turbo

pnpm db:generate    # regenerate Prisma client
pnpm db:migrate     # create + apply local migration
pnpm db:seed        # run seed.ts
pnpm db:studio      # Prisma Studio
pnpm db:push        # push schema without migration (local / staging only)

pnpm type-check     # all workspaces
pnpm lint           # all workspaces
pnpm test           # vitest, all workspaces
pnpm test:e2e       # playwright
pnpm route-parity   # Express vs Hono coverage
```

Prod variants are gated: `db:migrate:prod:deploy`, `db:migrate:prod:resolve-baseline-rolled-back`. Use sparingly — `deploy.yml` runs migrations automatically on push to `production`.

---

## CI / Deploy

- **PR checks** (`.github/workflows/pr-checks.yml`) gate merges on: type-check, lint, test (vitest), brand-drift grep. Warnings allowed; errors block. Runs on PRs targeting **`main`, `preview`, and `production`**. Manut branch protection still names the required check `Validate`.
- **`main`** is the trunk. Pushing it does not deploy Cloud Run or Vercel.
- **Prod deploy** (`.github/workflows/deploy.yml` + `deploy-vercel.yml`) fires on push to `production` → Cloud Run `nexora-api` / `nexora-web`:
  1. Apply Prisma migrations via `prisma migrate deploy` (with auto-resolve step for known-stuck names — failed migration names are listed in the `for name in \ ...` loop, `|| true` keeps it idempotent)
  2. Build Docker image for API
  3. Push to Artifact Registry + deploy to Cloud Run (with 3× retry on AR propagation)
  4. Same flow for Web
  5. Provision / refresh Cloud Scheduler cron jobs
- **Staging deploy** (`.github/workflows/deploy-staging.yml` + `deploy-edge-staging.yml`) fires on push to `preview` → Cloud Run `nexora-api-staging` / `nexora-web-staging` plus the edge worker, separate Supabase via `STAGING_*` secrets. **Schema is synced with `pnpm db:push`, NOT `prisma migrate deploy`** — so migrations don't run on staging and any data-migration SQL inside a migration is skipped there.
- **Cloud Run region**: `asia-southeast1` (Singapore). DB is Supabase SG; staying in the same region keeps p50 latency under 5ms.
- **Cron endpoints**: `apps/api/src/modules/cron/*` auth via `X-Cron-Secret: ${CRON_SECRET}`. Add new cron names to deploy.yml + coordinate with infra.
- Promote env branches with a merge commit. See `docs/RELEASE_PROCESS.md`.

When a migration breaks prod: add the name to the resolve loop in `deploy.yml`, push, the next deploy clears the failed row and re-applies the corrected SQL. See the 2026-05-28 P3018 incident.

---

## Auth / RBAC

JWT issued by Supabase Auth → Express middleware (`apps/api/src/core/guards/auth.guard.ts`) resolves the Prisma user + their roles + flattened permission codes per request. Permissions are `<module>:<action>` strings (e.g. `crm:read`, `investors:read-all`).

Guards:
- `requirePermission("scope:action")` on routes
- Admin role bypasses every gate via `auth.service.resolvePermissions` — do not replicate that bypass elsewhere
- `useAuth().hasPermission("scope:action")` on the client; UI gates derived from this only (not from raw JWT claims)
- `PermissionButton`, `PermissionDropdownMenuItem` wrap the common UI cases

Permission rule of thumb: if a module has owner vs admin visibility, add a `<scope>:read-all` permission alongside `<scope>:read`. Admin role gets it via the seed. Non-`read-all` callers see only their own rows.

---

## Notable shared services / hooks

- `services/crm-lead-source.service.ts` + `hooks/use-lead-sources.ts` — admin-managed lookup table for lead sources. Module-level cache. `invalidateLeadSourceCache()` after CRUD.
- `services/auth.service.ts` — login / refresh / logout. `refreshUser()` is the primary callback after permission changes.
- `components/layout/notification-bell.tsx` — bell items, grouped `approval` / `urgent` / `survey` / `news`. Backed by a per-id seen set in localStorage (`seen-ids-v2`) — the older timestamp-threshold approach re-showed urgent items every 2-3 hours (#bug from 2026-05-26). The feed is a **server read-model**: the dashboard stats payload computes each group on demand (e.g. `dashboard.repository.ts` `getOpenSurveyFormsForUser` returns published, non-anonymous, in-window forms the user is targeted by and hasn't answered) — there is no `Notification` table the bell reads from.
- `lib/crm-export.ts` — exports CSV / xlsx; pairs with `crm-import-dialog.tsx` which has the symmetric importer + `detectHeaderRow` heuristic for xlsx files with banner rows above the header.

---

## Conventions to keep in mind

- **No emojis in source code** (except `console.log` / build output that's already there). User-facing UI is fine.
- **No `// removed` comments** — delete the code.
- **No unused `_var` renames** — delete unused params + tighten signatures.
- **One commit, one feature**. PR titles in conventional-commit form (`feat(investors):`, `fix(leads):`, `chore(lint):`).
- **Branch naming**: `claude/<slug>` for AI-authored, `feat/...` / `fix/...` otherwise.
- **PR body** = Summary + Test plan checklist.
- **Co-authored-by** trailer on AI-authored commits: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- **No `--no-verify`**, no `--amend` on pushed commits, no force-push to main.

---

## Common pitfalls (read these once)

1. **Express route order** — literal before `:id`. Re-stated because it's been hit twice.
2. **Permissions cache** — `AuthProvider` reloads `/me` on mount, login, visibility-return, periodic timer. Mutate role assignments outside those windows → stale state. `refreshUser()` after.
3. **Form-dialog reopen** — parents pass slim `*ListItem`. Always re-fetch detail on open if your form touches detail-only fields.
4. **System Admin check** — `isSystem && name === "Admin"`. Don't gate "is admin" on `permissions.includes("admin:manage")`; custom roles can hold that perm.
5. **Migration consolidation** — squashing migrations into a fresh `0000_init` requires deleting every later migration whose schema now lives in `0000_init`. Leftovers will re-attempt their CREATE / ALTER and fail.
6. **Singapore region** — Supabase pooler reboots occasionally surface as P1001 from US-based GH runners. Re-run the deploy.
7. **xlsx imports** — numeric cells arrive as `" 300,000.00 "`. Use `coerceNumber` (strip whitespace incl. NBSP, drop separators, `Number(...)`). Plain `Number(v)` returns NaN.
8. **Two-row header xlsx** (payroll) — composite keys `row1[i] || row2[i]`. Skip rows with no Employee Name.
9. **Soft-delete pattern** — deactivating departments / lead sources sets `isActive=false`. Existing string FKs (`Lead.source` is a code, not an id) still resolve.
10. **Branding** — surface name is "Intranet". Workspace packages stay `@nexora/*`. Don't rename.

---

## Where to look first

| Question                                                 | Read                                                           |
|----------------------------------------------------------|----------------------------------------------------------------|
| What's the product scope of module X?                    | `docs/MODULES_SPECIFICATION.md`                                |
| What perm codes exist?                                   | `docs/AUTH_RBAC.md` + `apps/api/src/common/constants/permissions.ts` |
| Schema for table X?                                      | `packages/database/prisma/schema/<domain>.prisma`              |
| How do I add a new CRM module?                           | Copy `apps/api/src/modules/leads` + `apps/web/.../leads`. Match patterns. |
| Why does the deploy run a "resolve historically failed migrations" step? | `.github/workflows/deploy.yml` (commented inline)           |
| What's the canonical drag-reorder + resize pattern?      | `apps/web/src/components/accounts/accounts-tab.tsx`            |
| How do CRM imports handle the xlsx weirdness?            | `apps/web/src/components/shared/crm-import-dialog.tsx` + `lib/crm-export.ts` |
| AI assistant (ARIA) internals?                           | `apps/api/src/modules/aria/` + `docs/HANDOFF_*` for context per-handoff |

---

## Recent shape (as of 2026-06-16)

- 70+ API modules, ~50 web route groups, ~5,000 lines of Prisma schema across 14 domain files
- **Env branches** — `preview` deploys staging Cloud Run + edge; `production` deploys prod Cloud Run + Vercel. Staging syncs schema with **`pnpm db:push`** (no `prisma migrate deploy`), so migrations — and any data-migration SQL embedded in them — do NOT run on staging. `pr-checks.yml` gates PRs into `main`, `preview`, and `production`.
- **Soft delete across modules** — `users`, `accounting`, `leave`, `travel`, `expenses`, `cash-advance`, `visa` carry a `deletedAt` column (`@@index([deletedAt])` on the hot ones). Shared helpers in `apps/api/src/infrastructure/soft-delete.ts`: `excludeDeleted()` (where-fragment `{ deletedAt: null }` for list/count), `softDeleteUpdate()` (sets `deletedAt = now`), `restoreUpdate()` (nulls it). Delete is now soft by default; restore + permanent-delete routes expose `POST /:id/restore` + `DELETE /:id/permanent` per module. Restore/remove re-fetch via a `find*ByIdIncludingDeleted` repo method and enforce owner-or-HR ownership in the service (leave/travel/expenses/cash-advance check `employeeId === actor || permissions.includes(<hr-perm>)`; users gate cross-admin edits via `assertActorMayManageAdminUser`).
- **Attendance** (inside the `hrms` module + `/hrms` route, three controllers: `attendance`, `attendance-phase2`, `attendance-phase3`). Timezone-correct — `attendance-timezone.util.ts` resolves the employee's IANA zone (default `Asia/Bangkok`), converts wall-clock to UTC (`zonedLocalToUtc`), snapshots `employeeTimezone` per record, and computes late-minutes in zone. Cron alerts: `POST /api/cron/attendance-missed-checks` (missed check-in/out reminders) + `POST /api/cron/attendance-manager-alerts` (daily manager summary). Corrections: `AttendanceCorrection` request → `POST /attendance/corrections/:id/approve|reject` (gated `hrms:attendance-correction-approve`). Models in `hr.prisma`: `AttendancePolicy`, `AttendanceRecord`, `AttendanceCorrection`, `AttendanceShift`, `AttendanceEmployeeShift`, `AttendanceException`, `AttendanceAuditLog`.
- **Survey Forms (`/survey-forms`, sidebar "Survey Forms")** — Google-Forms-style builder; module `apps/api/src/modules/survey-forms/` at `/api/survey-forms`, gated on `survey:manage-wave` (distinct from the older xlsx-wave `survey` module). Models in `hr.prisma`: `SurveyForm` / `SurveyFormQuestion` / `SurveyFormResponse` / `SurveyFormAnswer`. Built-in form templates ship client-side (`components/survey-forms/survey-form-templates.ts`). **Announce-on-publish** (`POST /:id/publish` with an `announce` block, or the manual `POST /:id/announce`) writes a Company Wall post + Company News item + a Company Date (deadline) — each stamped with `linkUrl = /survey-forms/{id}/respond` for dashboard deep-links — and the form also surfaces in the notification bell's "survey" group (server read-model, see below). Announcement defaults are an admin-editable `SystemSetting` (`survey.announcement_defaults`, GET/PUT `/announcement-settings`). Lifecycle: `PUT /:id/schedule` (start/end window), `POST /:id/close`, `POST /:id/archive` + `/unarchive` (orthogonal `archivedAt`). Availability gating via `isOpenNow()` blocks responses outside `[startDate, endDate]`. Analytics via `GET /:id/analytics`; raw rows via `GET /:id/responses`.
- **HRMS ESOP** — sheet-aligned KPI cards computed by `rollupGrants()` in `apps/api/src/modules/hrms/esop-vesting.ts` over `EsopGrant` rows: **Grand Total** = Σ all `shares`; **Vesting** = Σ shares of scheduled grants (`vestingMonths > 0`); **Vested** = Σ shares of unscheduled grants (`vestingMonths ≤ 0`); **Total Vesting to date** = Σ `vestedSharesToDate()` of scheduled grants. Pool summary at `GET /esop-pool` (gated `hrms:esop-manage`); per-employee breakdown page `apps/web/src/app/(dashboard)/hrms/esop/[employeeId]/page.tsx` calls `GET /esop-grants/by-employee/:employeeId`.
- **Projects task Assignee (owner) picker lists ALL workspace users** — sourced from `GET /directory/assignable` (returns every `isActive` user, lean HR-safe projection, no permission gate and no project-membership filter); the task detail sheet picker connects the owner to any `User`. `PUT /:projectId/tasks/:taskId/assignees` accepts any workspace user id.
- Active feature work: Sales / Legal / IT / Project / HR / QA / Investor CRMs each have their own dnd-kit table with column reorder + resize + row reorder
- **Investor CRM (`/investors`)** is now a Sales-CRM-style tabbed workspace — tabs: Pipeline · Investors · Leads · Accounts · Contacts · Activities · Tasks (no Dashboard tab; its KPIs moved to per-column pipeline totals). Notable pieces:
  - **Pipeline** kanban with server-configurable stages (`InvestorPipelineStage` + `/api/investor/pipeline-stages` CRUD/reorder): columns reorder (dnd-kit), rename/add/delete inline; cards drag between columns (native HTML5, optimistic+revert). `Investor.status` is an open stage key, not an enum.
  - Per-column **Est + Act** roll-ups come from `GET /api/investors/pipeline-totals` (server parses the free-text amounts across the WHOLE stage — never sum loaded cards client-side).
  - **5 investor-scoped entities** — Leads / Accounts / Contacts / Tasks / Activities — each its own `/api/investor/<entity>` module, all gated on the existing `investors:*` perms (no new perm codes).
  - **Bulk actions** on the Investors list: row checkboxes + select-all + "select all N matching"; bulk set status / type / owner / delete via `POST /api/investors/bulk-update` + `/bulk-delete` (selection = explicit ids OR `allMatching`+filter through the shared `buildInvestorWhere`; owner-scoped unless `investors:read-all`).
  - **Configurable investor types** (`InvestorTypeOption` + `/api/investor/types`) — Family Office / PE / VC / SWF / Corporate / State Capital / Growth / Individual, seeded from the investor Pipeline Master sheet; the type column is an open key fed through a `useInvestorTypes` hook + Manage types dialog.
  - Rich-text render sinks sanitize via `sanitizeRichHtml` (`sanitize-html`) — mitigates the unpatched Quill 2.0.3 export XSS (GHSA-v3m3-f69x-jf25).
- **Cash Advance (`/cash-advance`)** has a Travel-style **conditional approval chain** — `CashAdvanceApprovalStep` + per-request `CashAdvanceApprovalDecision` + `currentStepOrder`; `/api/cash-advance/approval-steps` CRUD/reorder + `/notification-recipients`. Steps carry conditions (amount band vs requested total in the request currency, payout-mode filter, submitter skip/only-when); submit emails the first approver, each approval advances + emails the next, finalising emails the employee + HR/Finance recipients to disburse. Authz via `assertCanActOnStep` (step's manager/user or HR-with-`cash-advance:approve`). Config page at `/cash-advance/approval`.
- **IT CRM Intelligence dashboard (`/it-crm/dashboard`)** is a McKinsey-style exhibit report off a single read-only snapshot (`it-crm.service.ts` `dashboard()`). Powered by **transition-stamped** lifecycle fields added in `20261006000000_it_crm_intelligence_fields`: `ItProject`/`ItProjectTask.statusChangedAt`, task `completedAt`, `HelpdeskTicket.firstResponseAt`/`reopenedCount` (+ `healthStatus`/`effortPoints`) — stamped only on real status changes, never on every edit. Surfaces lead/cycle time, stage-aging, schedule-slippage, RAG health, and **helpdesk SLA attainment** (response/resolution/first-fix) measured against the tunable per-priority policy in `apps/api/src/modules/helpdesk/helpdesk.sla.ts`. Pattern catalogued in CLAUDE.md → "Dashboard intelligence (flow metrics + SLA)".
- **AI-agent guidance** lives in `AGENTS.md` (how we work + patterns playbook) → `CLAUDE.md` (binding rules + reusable-patterns catalogue) → `CONTEXT.md` (this map). Read in that order.
- ARIA evals (`apps/api/src/modules/aria/__tests__/*.eval.test.ts`) gate PRD-tracked retrieval thresholds — when adding new ARIA tools, add a happy-path + permission-denied case to `aria-tools.eval.test.ts`

---

## When in doubt

1. Search recent commits — `git log --oneline -50` covers the last week of changes; the codebase moves fast and conventions are still settling.
2. Open a draft PR — `pr-checks.yml` will tell you what's wrong faster than any local heuristic.
3. CLAUDE.md is the contract; docs/ has the product reasoning; this file (CONTEXT.md) is the map.
