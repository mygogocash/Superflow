# Intranet — employee platform ([`mygogocash/Manut`](https://github.com/mygogocash/Manut))

Internal management platform. One workspace for HR operations (leave,
payroll, expenses, travel, visa, ESOP, agreements), finance (accounting,
invoicing, revenue), CRM (partners, sales, leads, opportunities), and
people ops (org directory, performance, learning, benefits, onboarding).

**This repository** is [`mygogocash/Manut`](https://github.com/mygogocash/Manut).
Product name is **Intranet**. Workspace packages stay `@nexora/*`.

| Branch | Role |
| --- | --- |
| `main` | Default trunk. Feature PRs land here. Does not deploy Cloud Run or Vercel. |
| `preview` | Staging: Cloud Run staging + Cloudflare edge staging. Schema via `pnpm db:push`. |
| `production` | Prod: Cloud Run + Vercel. Schema via `prisma migrate deploy`. |

Promote `main` → `preview` and `main` → `production` with a **merge commit**.
See [docs/RELEASE_PROCESS.md](docs/RELEASE_PROCESS.md).

The codebase is a Turborepo monorepo: TypeScript Express 5 (Prisma/Supabase),
an Expo official web client, a Next.js 16 legacy UI (Cloud Run / Vercel /
Playwright), and a Hono Cloudflare Workers edge (Drizzle). Auth on Express is
Supabase JWT; per-request authorization is resolved against a permission table
seeded from `apps/api/src/common/constants/permissions.ts`.

---

## Table of Contents

1. [Architecture](#architecture)
2. [Repository Layout](#repository-layout)
3. [Tech Stack](#tech-stack)
4. [Domain Modules](#domain-modules)
5. [Authentication & RBAC](#authentication--rbac)
6. [Data & Storage](#data--storage)
7. [Local Development](#local-development)
8. [Environment Variables](#environment-variables)
9. [Daily Commands](#daily-commands)
10. [Testing & PR Checks](#testing--pr-checks)
11. [Production Deploy](#production-deploy)
12. [Migrations](#migrations)
13. [Conventions](#conventions)
14. [Troubleshooting](#troubleshooting)

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│              Browser (Expo official web — apps/app, :8081)             │
│  Expo Router · React 19 · Bearer JWT + `X-Client: expo`                │
└──────────────────────────────┬─────────────────────────────────────────┘
                               │  HTTPS (Authorization: Bearer)
                               ▼
┌────────────────────────────────────────────────────────────────────────┐
│                    Expo SPA (apps/app)                                 │
│  Dashboard shell + module lists via `src/lib/api-client.ts`.           │
│  Next.js (`apps/web`, :3000) stays the Cloud Run / Vercel / Playwright │
│  client (`pnpm dev:web:next`) until screens are ported.                │
└──────────────────────────────┬─────────────────────────────────────────┘
                               │  /api/* (Bearer or cookies)
                               ▼
┌────────────────────────────────────────────────────────────────────────┐
│                    Express 5 (apps/api, port 3001)                     │
│  authenticate → requireActive → requirePermission(...)                 │
│  modules/<feature>/{controller,service,repository,validation}.ts       │
│  Zod input parsing · winston logging · audit trail · email service     │
└────────────┬─────────────────────────────────┬─────────────────────────┘
             │                                 │
             │  Prisma 6                       │  Supabase Auth (JWT)
             ▼                                 ▼  Supabase Storage
┌──────────────────────────────┐  ┌────────────────────────────────────┐
│  PostgreSQL (Supabase, SG)   │  │  Supabase project (auth + files)   │
│  packages/database/prisma/   │  │  Buckets: avatars, article, blog,  │
│  • schema/*.prisma (sharded) │  │           uploads (public)         │
│  • migrations/* (timestamped)│  │           documents, receipts      │
│  • seed.ts / seed-prod.ts    │  │           (private, signed URLs)   │
└──────────────────────────────┘  └────────────────────────────────────┘
```

Request lifecycle:

1. Browser sends a cookie-bound Supabase JWT.
2. `authenticate` middleware (`apps/api/src/core/guards/auth.guard.ts`)
   verifies the token via `supabaseAdmin.auth.getUser()`, loads the
   Prisma `User` (matched on `id = supabase auth uid`), and attaches a
   slim `AuthUser` to `req.user` (id, email, name, isActive, entityId,
   `permissions: []`).
3. `requireActive` rejects deactivated accounts.
4. `requirePermission(...codes)` calls `resolvePermissions(userId)`
   which expands the user's roles (admin gets a wildcard bypass) and
   sets `req.user.permissions`. Subsequent service code reads
   `req.user.permissions` directly — no extra DB hits.
5. Controllers parse input with Zod, hand off to service methods
   (`<module>.service.ts`), which compose repository calls
   (`<module>.repository.ts`) and shared infra (`prisma`, email,
   storage, audit, tracking).
6. Errors thrown as `BadRequestException` / `NotFoundException` /
   `ForbiddenException` / `ConflictException` from
   `common/exceptions/http-exception` are caught by the error
   middleware and shaped into `{ error: { code, message, details? } }`.

---

## Repository Layout

```
.
├── apps/
│   ├── api/                        Express 5 + TS backend (port 3001)
│   │   └── src/
│   │       ├── app.ts              app wiring, middleware stack
│   │       ├── core/
│   │       │   ├── guards/         authenticate, requireActive, requirePermission
│   │       │   └── middleware/     error-handler, request-logger
│   │       ├── common/
│   │       │   ├── constants/      permissions.ts (single source of truth)
│   │       │   ├── exceptions/     HTTP exception classes
│   │       │   └── utils/          data-scope, params, etc.
│   │       ├── infrastructure/
│   │       │   ├── database/       prisma client singleton
│   │       │   ├── email/          email-service transport + templates
│   │       │   ├── storage/        Supabase storage helpers (signed URLs)
│   │       │   ├── ai/             Anthropic / Gemini clients
│   │       │   └── supabase/       admin client
│   │       ├── modules/            <feature>/{controller,service,repository,validation}.ts
│   │       │                       (99 modules — see Domain Modules below)
│   │       └── lib/                events, portal-url, tracking
│   ├── web/                        Next.js 16 legacy UI (port 3000)
│   │   └── src/
│   │       ├── app/
│   │       │   ├── (dashboard)/    authenticated routes (Home, HRMS, …)
│   │       │   ├── (auth)/         sign-in / sign-up
│   │       │   └── my-portal/      employee-only landing
│   │       ├── components/         feature-scoped React components
│   │       ├── services/           one file per backend module — wraps `lib/api-client`
│   │       ├── providers/          AuthProvider (user/roles/permissions)
│   │       ├── hooks/              shared hooks (use-debounce, use-pagination, …)
│   │       └── lib/                api-client, utils
│   ├── edge/                       Hono on Cloudflare Workers
│   ├── edge-jobs/                  Cron Triggers + Queue fan-out
│   └── app/                        Expo official web (port 8081) + native
├── packages/
│   ├── database/                   Prisma schema, migrations, seed
│   │   └── prisma/
│   │       ├── schema/             sharded *.prisma files (core, hr, finance, …)
│   │       ├── migrations/         timestamped folders, never edit committed ones
│   │       ├── seed.ts             local seed
│   │       └── seed-prod.ts        prod-safe seed (roles + perms only, no fake users)
│   ├── db/                         Drizzle schema for the edge
│   ├── core/                       Shared domain services for the edge
│   ├── auth/                       Better Auth helpers
│   ├── contracts/                  Shared route / DTO contracts
│   ├── types/                      shared TS types
│   ├── ui/                         shared shadcn components
│   ├── utils/                      shared helpers
│   └── eslint-config/              shared ESLint config
├── docker/                         Cloud Run images (Dockerfile.api, Dockerfile.web)
├── docs/                           human-curated PRDs + specs (PROJECT_OVERVIEW.md,
│                                   MODULES_SPECIFICATION.md, AUTH_RBAC.md, …)
├── .github/workflows/
│   ├── deploy.yml                  push-to-production → GCP Cloud Run
│   ├── deploy-staging.yml          push-to-preview → staging Cloud Run
│   ├── deploy-edge-staging.yml     push-to-preview → edge worker
│   ├── deploy-vercel.yml           push-to-production → Vercel
│   └── pr-checks.yml               PR gate: type-check + lint + test + brand-drift
├── turbo.json                      task pipeline & globalEnv
└── pnpm-workspace.yaml             workspace package list
```

Workspace package names: `@nexora/api`, `@nexora/web`, `@nexora/database`, `@nexora/edge`, `@nexora/app`, `@nexora/db`,
`@nexora/types`, `@nexora/ui`, `@nexora/utils`, `@nexora/eslint-config`.
The `@nexora/*` prefix is an implementation detail of the monorepo and
is intentionally kept stable even though the user-facing product was
renamed from "Nexora" to "Intranet" — don't rename it.

---

## Tech Stack

| Layer | Tech |
|------|------|
| Frontend | Expo 54 + Expo Router + NativeWind v4 + Reusables + TanStack Query/Table (`apps/app`, official web on :8081). Next.js 16 (`apps/web`) is the legacy Cloud Run / Vercel / Playwright UI |
| Backend | Express 5, TypeScript 5, Zod, winston logger, multer (uploads), helmet, cors, cookie-parser, compression, express-rate-limit |
| Database | PostgreSQL 15+ (Supabase, `aws-1-ap-southeast-1`), Prisma 6 |
| Auth | Supabase Auth (JWT in HTTP-only cookie); permissions resolved server-side per request |
| Storage | Supabase Storage (`avatars`/`article`/`blog`/`uploads` = public; `documents`/`receipts` = private with signed URLs) |
| Email | Resend (`RESEND_API_KEY`); HTML rendered in-app (`apps/api/src/infrastructure/email/templates.ts`) |
| AI | Gemini (default), Anthropic (optional) — feeds the ARIA assistant |
| Analytics | PostHog (server + client) |
| Edge | Hono + Hono RPC on Cloudflare Workers. Hyperdrive → Postgres (ERP SoT). Sidecar: D1, Durable Objects, Queues, Workflows, R2, optional Vectorize + Workers AI, Cloudflare Access |
| Infra | GCP Cloud Run (API + Web), Artifact Registry, Workload Identity Federation |
| CI/CD | GitHub Actions: `pr-checks.yml` (PR gate), `deploy.yml` (push-to-main) |
| Build | Turborepo + pnpm 10 |

---

## Domain Modules

The API mounts **95 route families** under `apps/api/src/modules/`. Each module
follows the same controller / service / repository / validation shape. The
high-level groups:

**People**
- `users` — employees, roles, profile
- `directory` — searchable org directory
- `leave` — types, balances, requests, approvals, public holidays, **org-wide approval chain**
- `payroll` — runs, payslips, bulk import (XLSX)
- `hrms` — ESOP grants (sheet-aligned KPIs + per-employee breakdown), agreements, onboarding tasks, **attendance** (timezone-correct check-in/out, corrections, shifts, missed/manager cron alerts)
- `learning` — courses, completion tracking
- `visa` — visa records + signed-URL document store
- `benefits` — benefit catalog + enrollments
- `office` — meeting room booking
- `policies` — company policy & handbook documents (HR uploads, employees view)
- `career` / `applications` — job postings + applicants
- `certificates` — recognition certificates: PDF generation, signature images, emailed to the employee

**Finance**
- `accounting` — full Thai accounting suite: GL posting engine, AR/AP, invoices/quotes/POs/credit + statutory debit notes, WHT 50-Bis, payment runs, bank reconciliation + FX revaluation, tax filings with month locks, maker-checker, audit log, and the **Fixed Asset Register** (flag-gated, see below)
- `expenses` — expense claims, monthly reports, **org-wide approval chain**, FX rates
- `cash-advance` — advances with their own approval chain, unsubmit-and-resubmit, line-item receipts
- `payroll` — runs + payslip import/export
- `revenue` — revenue analytics
- `exchange-rates` — daily Bank of Thailand FX sync (`<CUR>` → THB) powering multi-currency conversion

**CRM**
- `partners`, `deals`, `leads`, `lead-sources`, `lost-reasons`
- `accounts`, `contacts`, `opportunities`
- `crm-activities`, `crm-tasks`
- `sales-revenue/*` — an independent Sales Revenue CRM with its own accounts, contacts, leads, opportunities, activities and tasks
- board CRMs — `it-crm`, `legal-crm`, `qa-crm`, `product-crm`, `accounting-crm`, `voucher-crm`, each with Active / Archived tabs

**Marketing**
- `marketing` / `marketing-analytics` / `marketing-campaigns` — OneWave engagement analytics over the BNII Analytics API: DAU/MAU workbook exhibits, Traffic Dashboard, partner workspaces, Raw Data explorer, and a daily drift check. See [docs/MARKETING_ANALYTICS.md](docs/MARKETING_ANALYTICS.md)

**Investor & data**
- `investors` — investor CRM
- `investor-updates` — investor newsletters
- `dataroom` — document data room
- `legal` — legal tracker with DocuSign-style sign flow

**Workspace**
- `home` (dashboard) — KPIs, recent activity, pending actions
- `wall` / `news` / `articles` / `blogs` — internal publishing
- `messages` — chat (Socket.IO)
- `aria` — AI assistant, with chat attachments: images, PDFs and text; Office documents (docx/xlsx/pptx); video and audio via Gemini transcription
- `projects` — project tracker (task Assignee picker lists all workspace users), plus the **linear approval workflow** (Request Tracking board, admin-configurable stage reviewers, send-back, PM-gated escalation)
- `proposals` / `approval-chains` — two-tier proposal decisions with non-blocking information requests, over configurable approval chains snapshotted per record on submit
- `survey` / `survey-forms` — pulse surveys (xlsx-wave) + Google-Forms-style builder with announce-on-publish, scheduling, archive
- `travel` — travel requests, **org-wide approval chain**
- `performance` — reviews + goals
- `cron` — scheduled jobs (X-Cron-Secret gated)
- `uploads` — multipart + base64 endpoints

Each module's permission set is defined in
`apps/api/src/common/constants/permissions.ts` and surfaced as
`PERMISSIONS.MODULE_ACTION` constants for use in
`requirePermission(...)` gates.

---

## Authentication & RBAC

**Sign-in flow.** `apps/web/src/app/(auth)` calls Supabase Auth which
issues a JWT. The frontend posts the token to `/api/auth/session`
which sets it as an HTTP-only cookie. All subsequent API calls
forward the cookie.

**Permission model.** Codes are `module:action` strings (e.g.
`expense:read`, `leave:approve`, `policy:manage`). The full catalogue
lives in `apps/api/src/common/constants/permissions.ts` and is the
single source of truth — the seed inserts these rows into
`permissions`, and `Role` → `RolePermission` → `Permission` joins
back to assign them.

**System Admin role.** A role with `isSystem = true` and
`name = "Admin"` is treated as a wildcard bypass inside
`auth.service.resolvePermissions`. Don't gate "is admin" checks on
`permissions.includes("admin:manage")` — custom roles can hold that
permission. Use the `Admin` role identity instead.

**Approval chains.** Three modules share the same pattern:
- `travel_approval_steps` + `travel_approval_decisions`
- `expense_approval_steps` + `expense_approval_decisions`
- `leave_approval_steps` + `leave_approval_decisions`

Admin (`*:assign-approver`) configures an ordered chain. On submit,
the chain is **snapshotted** into a per-request decision rows table
so editing the chain later does not retroactively rewrite in-flight
requests. Each step is `manager` (route to submitter's reportingTo)
or `user` (route to a specific user). The submitter's direct manager
is always allowed as a parallel approver — a defensive fallback so
stale snapshots after a chain edit don't strand requests.

**RBAC scoping ("owner sees own / admin sees all").** Pattern set by
Investors (#202) and HRMS Agreements (#204):
1. Define a `*:read-all` permission alongside `*:read`. Admin gets it;
   nobody else should.
2. The list service compares
   `actorPermissions.includes(<module>:read-all)`. If false, force the
   row filter to `addedBy = req.user.id` (or `employeeId` for HR docs).
3. Same ownership check on `getById`, `update`, `delete` — return 403
   if the actor is neither the owner nor a `*:read-all` holder.
4. For the admin path, **require an explicit `employeeId` filter** so
   a missing query param can't fall back to "every row in the table".

---

## Data & Storage

**Database** — PostgreSQL on Supabase Singapore (`aws-1-ap-southeast-1`).
GitHub Actions runners are US, but the shared pooler handles long-haul
fine; expect occasional P1001s during transient pooler reboots.

- Transaction pooler (port `6543`) — runtime app traffic.
- Direct connection (port `5432`) — migrations + Prisma Studio.

**Prisma schema** lives in `packages/database/prisma/schema/` sharded
by domain (`core.prisma` for User/Entity, `hr.prisma`, `finance.prisma`,
`crm.prisma`, etc.). Run `pnpm db:generate` after any schema edit.

**Storage buckets** (Supabase):
- `avatars`, `article`, `blog`, `uploads` — public; URL is directly
  fetchable.
- `documents`, `receipts` — private; the API exposes a
  `GET /<resource>/:id/download` endpoint that re-checks ownership and
  returns a 5-minute signed URL. **Never link the raw `fileUrl`
  client-side for these buckets.** Pattern shipped in HRMS agreements,
  expense receipts, visa documents, and company policies.

**XLSX imports** (payroll, agreements roster, ESOP). HR's templates
ship numeric cells like `" 300,000.00 "`. Always coerce via the
`coerceNumber` helper — strip whitespace (incl. NBSP / thin-space),
drop digit-group separators (`,` `'` `_`), then `Number(...)`. Plain
`Number(v)` returns `NaN` for HR's spreadsheets.

**Soft delete** (users, accounting, leave, travel, expenses,
cash-advance, visa). These models carry a `deletedAt` column. Lists and
counts filter with `excludeDeleted()`; the delete action sets `deletedAt`
via `softDeleteUpdate()` instead of removing the row. Each module exposes
`POST /<resource>/:id/restore` and `DELETE /<resource>/:id/permanent`.
Restore/permanent re-fetch through a `find*ByIdIncludingDeleted` repository
method (the default finders hide deleted rows) and enforce **owner-or-HR**
ownership in the service — never gate these on `requirePermission` alone.
Helpers live in `apps/api/src/infrastructure/soft-delete.ts`.

---

## Local Development

### Prerequisites

- Node.js ≥ 20
- pnpm ≥ 10.33.0 (`npm install -g pnpm@10.33.0`)
- PostgreSQL — either a local Postgres instance or a Supabase project

### 1. Clone and install

```bash
git clone https://github.com/mygogocash/Manut.git
cd Manut
pnpm install
```

### 2. Configure environment

Create two env files. The web app does **not** read parent-dir env
files — `NEXT_PUBLIC_*` and `API_URL` must be mirrored under
`apps/web/`.

Root `.env.development`:
```env
NODE_ENV=development

# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key>
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>

# Database
DATABASE_URL="postgresql://postgres.xxx:[PASSWORD]@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true"
DIRECT_URL="postgresql://postgres.xxx:[PASSWORD]@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres"

# API
PORT=3001
ALLOWED_ORIGINS=http://localhost:3000
PORTAL_URL=http://localhost:3000

# Email (Resend; optional in dev — leave unset to skip sending)
RESEND_API_KEY=
EMAIL_FROM=Manut <noreply@manut.xyz>

# AI
GEMINI_API_KEY=
ANTHROPIC_API_KEY=

# Tracking (optional)
POSTHOG_API_KEY=
POSTHOG_HOST=
```

`apps/web/.env.development`:
```env
NEXT_PUBLIC_SUPABASE_URL=<same as root>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<same as root>
NEXT_PUBLIC_API_URL=http://localhost:3001
API_URL=http://localhost:3001
NEXT_PUBLIC_PORTAL_URL=http://localhost:3000
```

All `.env*` files are gitignored. When adding a new secret:
1. Update root `.env.development`.
2. Mirror in `apps/web/.env.development` if web-facing.
3. Add to `turbo.json` `globalEnv`.
4. Add to GitHub Secrets + `deploy.yml` `--set-env-vars` for prod.

### 3. Database setup

```bash
pnpm db:generate    # regen Prisma client
pnpm db:migrate     # apply migrations
pnpm db:seed        # roles, permissions, dev sample data
```

`db:*` scripts cascade `.env.development` → `.env`. Prod variants live
under `db:migrate:prod:*` and read `.env.production`.

### 4. Run the stack

```bash
pnpm dev:api        # Express on :3001
pnpm dev:web        # Expo official web on :8081
pnpm dev:web:next   # Next.js legacy UI on :3000
```

Or run both at once with `pnpm dev` (Turborepo parallelises).

Open <http://localhost:8081>, sign in with a seeded user (see
`packages/database/prisma/seed.ts` for default emails / passwords).

---

## Environment Variables

| Variable | Where used | Notes |
|---|---|---|
| `DATABASE_URL` | API + Prisma | Pooler URL (port 6543) for runtime |
| `DIRECT_URL` | Prisma migrate | Direct URL (port 5432) for migrations |
| `NEXT_PUBLIC_SUPABASE_URL` | Web + API | Public Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Web + API | Public anon key (RLS-bounded) |
| `SUPABASE_SERVICE_ROLE_KEY` | API only | Bypasses RLS; never expose to client |
| `EXPO_PUBLIC_APP_URL` | Expo (`apps/app`) | API origin. Defaults to `http://localhost:3001`. Set `http://localhost:8787` for the edge Worker |
| `NEXT_PUBLIC_API_URL` | Web | Base URL for browser fetches |
| `API_URL` | Web (server) | Base URL for server-side fetches |
| `PORT` | API | Defaults to 3001 |
| `ALLOWED_ORIGINS` | API | Comma-separated CORS allowlist |
| `PORTAL_URL` | API | Used in email links |
| `RESEND_API_KEY` | API + Edge | Resend API key for transactional email |
| `EMAIL_FROM` | API + Edge | Resend-verified sender (e.g. `Manut <noreply@manut.xyz>`) |
| `GEMINI_API_KEY` | API | ARIA assistant (default model) |
| `ANTHROPIC_API_KEY` | API | ARIA assistant (optional fallback) |
| `POSTHOG_API_KEY` | API + Web | Event tracking |
| `CRON_SECRET` | API | Shared secret for `/api/cron/*` |
| `GCS_BUCKET`, `GCP_PROJECT_ID` | API (optional) | Legacy GCS uploads |
| `MARKETING_ANALYTICS_API_URL` | API (optional) | BNII Analytics base URL. **An override, not a prerequisite** — the module defaults to the live URL in code, because an unset variable silently disabling the only data source is a failure mode this module has already had |
| `MARKETING_ANALYTICS_PARTNER_IDS` | API (optional) | Partner override, accepted as `slug:uuid` pairs or JSON. Falls back to the nine-partner registry |
| `MARKETING_ANALYTICS_BACKFILL_FROM` | API (optional) | Earliest date the OneWave ingest pulls (default `2026-05-01`) |
| `BOT_FX_CURRENCIES`, `BOT_FX_UNITS` | API (optional) | Bank of Thailand FX sync overrides. Defaults are shared with the web claim form via `@nexora/utils` so the currencies you can *file* in and the ones we hold a *rate* for cannot drift apart |
| `BOT_API_CLIENT_ID` | API (optional) | BOT FX credentials; the sync no-ops without it |
| `ACCOUNTING_FIXED_ASSETS` | API | Fail-closed flag (`=== "true"`) mounting the Fixed Asset routes |
| `NEXT_PUBLIC_ACCOUNTING_FIXED_ASSETS` | Web (build-time) | The web half of the same flag. **Inlined at `next build`**, so it travels `--build-arg` → `Dockerfile.web`, never runtime `--set-env-vars` |

---

## Daily Commands

```bash
# Dev
pnpm dev               # run all apps (Turborepo)
pnpm dev:api           # Express only
pnpm dev:web           # Expo official web on :8081
pnpm dev:web:next      # Next.js legacy UI on :3000
pnpm dev:edge          # Hono worker (wrangler)
pnpm dev:app           # alias for Expo

# Database
pnpm db:generate       # regen Prisma client
pnpm db:migrate        # create + apply local migration
pnpm db:push           # push schema without migration (local / staging)
pnpm route-parity      # Express vs Hono coverage
pnpm db:seed           # run seed.ts
pnpm db:studio         # Prisma Studio (port 5555)

# Quality gates
pnpm type-check        # tsc --noEmit across all workspaces
pnpm lint              # eslint (api) + next lint (web)
pnpm lint:fix          # auto-fix
pnpm test              # vitest run, all workspaces
pnpm test:e2e          # Playwright

# Build / clean
pnpm build             # build all apps
pnpm clean             # remove node_modules and build artifacts
```

---

## Testing & PR Checks

The `pr-checks.yml` GitHub Actions workflow blocks merge until all of
the following pass on the PR branch:

1. **type-check** — `tsc --noEmit` across the monorepo.
2. **lint** — `eslint` (api) + `next lint` (web). Warnings allowed;
   errors block.
3. **test** — `vitest run` (api + web). All suites must pass.
4. **brand-drift** — grep gate against forbidden brand strings.

Before opening a PR:
```bash
pnpm type-check && pnpm lint && pnpm test
```

**Branch naming**: `claude/<short-slug>` for AI-authored work,
`feat/...`, `fix/...`, `ci/...` otherwise.

**Commit / PR titles** follow conventional commits:
`fix(scope): …`, `feat(scope): …`, `ci(scope): …`.

**PR body** should have a `Summary` section and a `Test plan`
checklist.

---

## Production Deploy

`production` push → `Deploy to GCP Cloud Run` workflow
(`.github/workflows/deploy.yml`). A push to `main` does not deploy.

1. **Resolve historically failed migrations** — `prisma migrate
   resolve --rolled-back <name> || true` for a hard-coded list of
   migrations known to occasionally stick in `_prisma_migrations` as
   failed. Idempotent.
2. **Apply Prisma migrations** to the prod DB
   (`prisma migrate deploy`). Failure here aborts the deploy — watch
   P3009 (`failed migration in target database`).
3. **Authenticate to GCP** via Workload Identity Federation
   (`WIF_PROVIDER`, `GCP_SERVICE_ACCOUNT` secrets).
4. **Build & push** Docker images to Artifact Registry
   (`asia-southeast1-docker.pkg.dev/tbh-nexora/nexora/{api,web}`).
   Dockerfiles in `docker/Dockerfile.api`, `docker/Dockerfile.web`.
5. **Deploy to Cloud Run**:
   - API service: `nexora-api` on port 3001, 512 MiB.
   - Web service: `nexora-web` on port 3000.
   - Env vars supplied via `--set-env-vars` from GitHub Secrets.

### Staging (`preview` branch)

`preview` push → `Deploy to Staging` (`.github/workflows/deploy-staging.yml`)
and `Deploy Edge Staging` (`.github/workflows/deploy-edge-staging.yml`):
Cloud Run `nexora-api-staging` / `nexora-web-staging` plus the edge worker,
pointed at a **separate Supabase project** via `STAGING_*` secrets.

> **Schema on staging is synced with `pnpm db:push`, not `prisma migrate
> deploy`.** Migrations are **not** applied on staging, so any data-migration
> SQL embedded in a migration does not run there — a column that depends on a
> backfill will be empty on staging until seeded by hand. `pr-checks.yml`
> gates PRs targeting `main`, `preview`, and `production`.

Cron jobs hit `/api/cron/*` with `X-Cron-Secret: ${CRON_SECRET}`.
Cloud Scheduler is provisioned manually — coordinate with infra
before adding new cron endpoints. Jobs live in project `tbh-nexora`,
location `asia-southeast1`, and **all of them target the production
service** — staging has no scheduler jobs at all.

| Job | Schedule (Asia/Bangkok) | Purpose |
|---|---|---|
| `aria-purge-pii-daily` | 02:30 | Redact aged `aria_query_logs.user_message` |
| `aria-knowledge-sync-daily` | 03:00 | Pull operational tables into the knowledge corpus |
| `storage-snapshot-daily` | 04:30 | Per-bucket Supabase Storage usage snapshot |
| `crm-deadline-reminders` | 08:00 | Go-live + task deadline emails across every enabled board CRM |
| `marketing-drift-check` | 09:00 | Reconcile the two readers of the BNII API — **currently PAUSED** |
| `expense-monthly-reminders` | 09:00 on the 22nd | Monthly expense submission reminders |

`marketing-drift-check` is paused deliberately. Resume it after the next
`production` deploy that contains the endpoint — do not re-create it.
See CLAUDE.md for the exact command.

Several documented cron endpoints have **no scheduler job yet**, including
`ow-snapshot-refresh`, `accounting-status`, `it-billing-reminders`, the
attendance alerts and the FX sync. Check `gcloud scheduler jobs list`
before assuming an endpoint actually runs on a timer.

**Region**: `asia-southeast1` (Singapore). DB is in the same region
to minimise latency.

**Rollback**: re-run the previous successful workflow run from the
GitHub Actions UI ("Re-run all jobs"), or roll back via Cloud Run
console → Revisions → select older revision → "Serve traffic".

---

## Migrations

```bash
# Local dev migration
pnpm db:migrate -- --name <slug>

# Apply a migration to prod manually (rare — usually CI does it)
pnpm --filter @nexora/database exec prisma migrate deploy
```

**Rules:**
- Never edit a committed migration. New change → new migration.
- Migrations must be **idempotent** where reasonably possible. Use
  `IF NOT EXISTS` / `IF EXISTS` for `ALTER TABLE … ADD COLUMN` and
  `DROP …`. A migration that's safe to re-run survives partial-apply
  incidents.
- **Staging never runs migrations.** `deploy-staging.yml` syncs schema with
  `pnpm db:push`, so a *schema* change lands on staging but a **data
  migration embedded in a migration file does not run there**. Don't rely on
  a backfill to populate staging — seed it manually if you need the data.
- Don't write data migrations that depend on tables a later
  consolidation will drop. If a migration references a table not in
  the current schema, retire it before that consolidation lands.
- Resolve a stuck failed migration on prod with:
  ```bash
  pnpm --filter @nexora/database exec prisma migrate resolve \
    --rolled-back <migration-name>
  ```
  Then add the name to the `deploy.yml` resolve loop so future
  re-deploys are idempotent.

---

## Conventions

### Backend (`apps/api`)

- Controllers in `src/modules/<module>/<module>.controller.ts`; service
  logic in `<module>.service.ts`; Prisma access in
  `<module>.repository.ts`.
- Routes register on the `Router()` at the bottom of the controller.
  **Literal paths must come before `:param` routes** — Express matches
  in order; `/import-template` will be eaten by `/:id` if listed
  second.
- Validate inputs with Zod schemas in `<module>.validation.ts`; export
  the inferred `*Input` types.
- Use `BadRequestException`, `NotFoundException`,
  `ForbiddenException`, `ConflictException` from
  `src/common/exceptions/http-exception`. Never `throw new Error(...)`.
- Permission gates: `requirePermission("module:action")`. Admin role
  bypasses every gate via `auth.service.resolvePermissions`. Don't
  replicate that bypass in route guards — the resolver handles it.
- Logger is winston (`apps/api/src/common/utils/logger.ts`). Use
  `logger.info("msg", { … })` with object metadata. Don't log secrets.

### Frontend (`apps/app` — official local web)

- Expo Router + NativeWind v4 + React Native Reusables + TanStack Query
  + TanStack Table v8. `'use dom'` lives in `src/components/dom` for
  web-only HTML (sanitize first). Do not run Reusables `init` here.
- API calls go through `src/lib/api-client.ts` (`api` / `useApiQuery`)
  with `X-Client: expo` and a Bearer token. Never cookie `fetch`.

### Frontend (`apps/web`)

- Routes in `src/app/(dashboard)/…`. Server components only when the
  data is server-fetchable; otherwise `"use client"`.
- API calls go through `src/services/<module>.service.ts` using the
  shared `api` helper from `@/lib/api-client`. Never `fetch` directly
  in components.
- Forms: react-hook-form + zodResolver + shadcn `Form` primitives.
  Reset via `useEffect(() => form.reset(…), [open, payload, form])` —
  and remember `UserListItem ≠ UserDetail`. If a list item lacks a
  field, fetch the detail before resetting.
- Auth state: `useAuth()` exposes `user`, `roles`, `permissions`,
  `hasPermission`, `hasRole`, `refreshUser`. Call `refreshUser()`
  after any role / permission change that affects the current user.
- Sidebar / route guards read from `state.permissions` only; don't
  gate UI on JWT claims directly.

### Database (`packages/database`)

- One schema file per domain in `prisma/schema/*.prisma`.
  Run `pnpm db:generate` after edits.
- Migrations: never edit a committed migration.
- The `User.id` matches the Supabase auth uid — Prisma uses
  `findUnique({ where: { id: supabaseUser.id }})` in the auth guard,
  so the IDs must stay aligned.

### Branding

- Product name: **Intranet** (#210). Don't rename `@nexora/*`
  workspace packages — that's an implementation detail.
- Design tokens: cream / bronze / gold (live on
  `manut.xyz`). Local `globals.css` may differ — when in
  doubt, match the live site.

---

## Troubleshooting

### `Environment variable not found: DATABASE_URL`

Make sure `.env.development` (or `.env`) is in the project root, **not**
inside `packages/database/`. The Prisma scripts cascade from the root.

```bash
# Right
cd /path/to/Manut
pnpm db:seed

# Wrong
cd packages/database
pnpm run db:seed
```

### Database connection errors (P1001)

1. Verify `DATABASE_URL` and `DIRECT_URL` in `.env.development`.
2. Whitelist your IP in Supabase if RLS network rules are active.
3. Escape special characters in the password (`@`, `#`, `/`) with
   URL-encoding (`%40`, `%23`, `%2F`).
4. The pooler in Singapore reboots occasionally — retry after 30s
   before assuming a real outage.

### `Cannot find module '@nexora/database'`

Run `pnpm db:generate` after every schema change. Prisma client lives
under `packages/database/src/generated/prisma`.

### Sidebar entry missing after a role change

`AuthProvider` reloads `/me` on mount, login, visibility-return, and a
periodic timer. After granting a new permission, either wait for the
next reload, sign out & back in, or call `refreshUser()`. Don't gate
sidebar items on stale JWT claims.

### `P3009 failed migration` on prod deploy

The deploy aborted mid-migration. Run locally against prod:
```bash
DATABASE_URL=$PROD_DIRECT_URL \
  pnpm --filter @nexora/database exec prisma migrate resolve \
  --rolled-back <stuck-migration-name>
```
Then add the name to the `Resolve historically failed migrations`
loop in `deploy.yml` so re-deploys stay idempotent.

### Form silently overwrites real data after editing an employee

The parent passed a slim `UserListItem`. Fetch `UserDetail` on dialog
open before calling `form.reset(...)` — see
`employee-form-dialog.tsx` for the canonical pattern.

### Permission denied after granting a role

Admin role bypasses checks via `isSystem && name === "Admin"`. For
non-admin roles, the user must (1) have the permission seeded into
`role_permission`, (2) reload `/me`. Stale permissions cache is the
most common cause.

---

## License

See the GitHub repository: https://github.com/mygogocash/Manut
