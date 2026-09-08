# Security review log

Program plan: [`docs/superpowers/plans/2026-09-08-security-hardening-review.md`](../superpowers/plans/2026-09-08-security-hardening-review.md)

Inventory commands (Wave 0):

```bash
pnpm security:inventory
pnpm security:ungated-routes [--json] [--fail]
pnpm security:dangerously-html [--json] [--fail]
pnpm route-parity
```

Allowlist for intentional public / alt-auth surfaces: `scripts/security/allowlist.json`.

| id | wave | severity | surface | status | notes | PR |
|----|------|----------|---------|--------|-------|-----|
| SEC-000 | 0 | — | inventory harness | done | Scripts + allowlist + this log | #319 |
| SEC-001 | 0 | P3 | HTML sinks without nearby sanitizer | done | Wave 5: `sanitizeRichHtml` style allowlist + Expo `RichHtml` sanitizes in-component; print/chart CSS remain static (allowlisted). Email free-text escaped; avatar SVG uploads banned except `avatar-generator`; signed-URL ownership tests | |
| SEC-002 | 0 | P2 | Workflow email-action public controller | open | `projects/workflow/workflow-public.controller.ts` uses `verifyActionToken`. Wave 4: replay/expiry/binding audit | |
| SEC-003 | 0 | P2 | Expo session in web storage | mitigated | Wave 1: logout clears `intranet.session.v1` + legacy keys; residual XSS blast radius remains (Bearer-in-storage for Expo) | |
| SEC-004 | 0 | P1 | Soft-delete restore IDOR pattern | done | Wave 2: owner-or-HR/read-all in service for accounting restore + permanent delete IncludingDeleted | |
| SEC-005 | 0 | P0/P1 | Org tenancy incomplete on ERP rows | mitigated | Wave 3: `assertSameOrg` + users/membership scoping + `ORG_TENANCY_ENFORCED` fail-closed (users/org only). ERP column backfill still debt — see Wave 3 tenancy debt below | |
| SEC-006 | 0 | P1 | Cron/webhook secret compare | done | Wave 4: timing-safe + fail-closed empty/short secret (≥32) | |
| SEC-007 | 0 | P2 | CF Access fail-open when AUD unset | accepted | Wave 1: documented residual risk + compensating controls; set `CF_ACCESS_AUD` when Zero Trust is cut over | |
| SEC-008 | 0 | P3 | No CI audit/secret-scan gate | done | Wave 7: `security-audit` (warn), `secret-scan` (gitleaks fail-closed), `security-inventory` (--fail) on Depot Validate; deploy requires `BETTER_AUTH_SECRET` + `CRON_SECRET` (≥32) | |
| SEC-009 | 1 | P2 | RBAC KV not invalidated on role assign | done | `PUT /api/users/:id/roles` now calls `invalidateUserPermissions` | |

## Wave 1 — session / perimeter (2026-09-08)

### Session model decision

| Client | Credential storage | Notes |
|--------|-------------------|--------|
| Expo web / native (`apps/app`) | Bearer token in `intranet.session.v1` (localStorage or sessionStorage) | Required for React Native; XSS ⇒ account takeover. Logout must clear memory + both storages + legacy keys. Prefer migrating web-only surfaces to httpOnly cookies later. |
| Better Auth cookie session | httpOnly Secure cookies when `APP_URL` is https | Preferred for browser-only clients; Expo still dual-writes Bearer for native. |
| Legacy Express JWT (`apps/web` / api) | Cookie or Bearer depending on path | Parity surface only; edge is live. |

### Cloudflare Access env matrix

| Env | `CF_ACCESS_AUD` | Behavior | Residual risk / controls |
|-----|-----------------|----------|---------------------------|
| local (`wrangler.dev`) | empty | Fail-open | Expected for local DX |
| staging | empty (today) | Fail-open | Compensating: Turnstile on sign-in/magic-link, login + global rate limits, `TRUSTED_ORIGINS`, Bot Fight Mode |
| production | empty (today) | Fail-open | **Accepted until Zero Trust cutover.** Same compensating controls. When Access is enabled, set `CF_ACCESS_AUD` (+ optional `CF_ACCESS_TEAM_DOMAIN`) so `requireAccess` fails closed. |

### `TRUSTED_ORIGINS` audit

Better Auth `trustedOrigins` = `[APP_URL, ...TRUSTED_ORIGINS]`.

| Env | `APP_URL` | Extra `TRUSTED_ORIGINS` | Covers |
|-----|-----------|-------------------------|--------|
| local | `http://localhost:8787` | `intranet://,http://localhost:8081` | Worker origin, Expo scheme, Expo web |
| staging | `https://staging.manut.xyz` | `intranet://` | Staging host + native scheme |
| production | `https://manut.xyz` | `intranet://` | Prod host + native scheme |

Do **not** use `*` origins. Add any new Expo web preview host explicitly before shipping it.

### Permission cache

- KV key `rbac:{userId}`, TTL **60s**.
- `PUT /api/users/:id/roles` invalidates immediately via `invalidateUserPermissions`.
- Role-permission CRUD is not yet on edge (list-only); when it lands, invalidate all members of that role (or accept ≤60s window with a ticket).


### Ungated routes (`pnpm security:ungated-routes`)

- Edge: **92/94** files have auth markers; allowlisted public: `health.ts`, `index.ts`. Unexpected: **none**.
- Alt-auth (detected as gated): `cron.ts` (`verifyCron`), `line.ts` (`verifyLineSignature`).
- API: **95/99** controllers have auth markers; allowlisted session/alt: auth, organizations, push, uploads. Unexpected: **none** after recognizing `verifyActionToken` on workflow-public.

### HTML sinks (`pnpm security:dangerously-html`)

- 6 sinks; 2 use `sanitizeRichHtml` nearby; 4 REVIEW (static CSS ×2, Expo `RichHtml` escape hatch ×2).

### Route parity (`pnpm route-parity`)

- Express controller routes: **1316**; edge handlers: **1166**; ratio **0.886** (threshold 0.80) — **PASS**.

### Expected public allowlist (summary)

| Surface | Auth model |
|---------|------------|
| `/health` | None |
| `/api/auth/*` | Better Auth |
| `/api/cron/*` | Shared secret (`verifyCron` / cron controller) |
| `/api/line/webhook` | LINE HMAC (`verifyLineSignature`) |
| Workflow email-action | Signed token (`verifyActionToken`) |
| Helpdesk / legal public webhooks | Provider HMAC |
| PostHog `/ingest` proxy | Unauthenticated by design (`app.ts`) |

## Wave 2 — authz / soft-delete IDOR (2026-09-08)

### Findings closed

| Module | Gap | Fix |
|--------|-----|-----|
| Accounting journals/invoices | Restore lacked owner-or-read-all (esp. edge `ACCOUNTING_CREATE`) | `assertJournalAccess` / `assertInvoiceAccess` on restore; API + core + edge pass `actorId` + `permissions` |
| Travel / cash-advance / expenses | Permanent delete used live finder (404 on soft-deleted) and weak service authz | `*IncludingDeleted` lookup + HR/approver permission check in service; controllers pass `permissions` |

### Tests

- Accounting restore: owner OK, foreign actor 403, read-all OK, missing 404.
- Cash-advance permanent delete: approve OK, create-only 403.

### Residual

- Leave/visa restore paths were already owner-or-HR; spot-checked, no change.
- Approval-chain `assertCanActOnStep` identity checks unchanged this wave (already service-enforced).
- Cross-tenant IDOR for ERP rows addressed in Wave 3 readiness (invariants + debt list); full column backfill remains ORG plan work.

## Wave 3 — org tenancy readiness (2026-09-08)

### Landed

| Surface | Change |
|---------|--------|
| `@nexora/auth` `org-rbac` | `isSameOrg` / `assertSameOrg` / `OrgScopeError` / `isOrgTenancyEnforced` |
| Organizations service | `assertOrgResourceScope` on get/list-members/upsert/update when `tenancyEnforced` |
| Users service | Non–platform-admin list/get scoped to active-org members; IDOR on `getById`; fail-closed when `tenancyEnforced` and no active org |
| Edge | `ORG_TENANCY_ENFORCED` (default `false`) wired through users + organizations routes |
| Inventory | `pnpm security:tenancy-inventory` — Prisma models with vs without `organizationId` |

### Flag semantics

| `ORG_TENANCY_ENFORCED` | Behavior |
|------------------------|----------|
| unset / `false` | Soft: no active org → empty user list; get still denies cross-org members |
| `true` | Fail-closed on users + org membership: missing active org → 403 |

Platform admin (`platform_admin`) bypasses org scope. Org Super Admin does **not** get platform bypass.

### Tenancy debt (ordered by PII / finance sensitivity)

`pnpm security:tenancy-inventory` (2026-09-08): **2 / 281** models have `organizationId` (`Entity`, `OrganizationMembership`). Everything else is application-layer debt until backfilled per `docs/ORG_TENANCY_RBAC_PLAN.md`.

| Priority | Domain | Why first | Notes |
|----------|--------|-----------|-------|
| P0 | Payroll / compensation | Salary, tax IDs, bank-adjacent fields on users + payslips | Highest cross-tenant blast radius |
| P0 | Expenses / cash-advance / travel | Finance PII + approval artifacts | Soft-delete IDOR hardened in Wave 2; still no `organizationId` |
| P1 | Accounting (journals / invoices / FA) | Statutory ledgers, amounts | Restore authz Wave 2; column still global |
| P1 | Leave / attendance / visa | HR PII | Owner-or-HR today; not org-keyed |
| P2 | CRM (sales / investor / project boards) | Customer + deal data | Large surface; stage after HR/finance |
| P3 | Content / comms / wall / news | Lower sensitivity | Last for column backfill |
| — | Auth / org tables | Already scoped | Membership + Entity only today |

Do **not** claim multi-org ERP is done until debt rows above carry `organizationId` (or equivalent RLS) and handlers filter on active org.

## Wave 4 — webhooks / cron secrets (2026-09-08)

### Landed

| Surface | Change |
|---------|--------|
| `@nexora/auth` `secrets` | `timingSafeEqualString` + `verifySharedSecret` (fail-closed empty/short, min 32) |
| Edge cron | Uses `verifySharedSecret`; empty/short `CRON_SECRET` → 401 |
| Express cron | Node `timingSafeEqual` + min length 32 (local copy; no api→auth dep) |
| Edge-jobs HTTP cron | Refuses to call edge unless `CRON_SECRET.length >= 32` |
| LINE / GitHub / DocuSign | Already HMAC + fail-closed when secret unset (spot-checked) |

### Webhook verification matrix

| Provider | Raw body | Signature header | Compare | Empty secret | Rotation owner |
|----------|----------|------------------|---------|--------------|----------------|
| Cron (edge + Express) | n/a (shared bearer) | `x-cron-secret` or `Authorization: Bearer` | Timing-safe string equal | Reject (401 / not configured) | Platform eng — Worker secret / Depot |
| LINE Messaging | Request text | `x-line-signature` | HMAC-SHA256 → base64, const-time | 503 `NOT_CONFIGURED` | Platform eng — `LINE_MESSAGING_CHANNEL_SECRET` |
| GitHub (helpdesk) | `req.rawBody` | `x-hub-signature-256` | HMAC-SHA256 hex, `timingSafeEqual` | 503 not configured | IT Helpdesk admin (per-workspace secret) |
| DocuSign Connect | Raw body | `x-docusign-signature-1` | HMAC-SHA256 base64, const-time | 500 `DOCUSIGN_HMAC_SECRET` missing | Legal / platform eng |
| Stripe (planned) | Raw body | `Stripe-Signature` | Stripe SDK constructEvent | Must fail-closed when unset | Billing — see `docs/STRIPE_BILLING_PLAN.md` |

### Edge-jobs allowlist

`apps/edge-jobs` HTTP cron consumer posts only to `/api/cron/<JobName>` for the fixed `ALL_JOBS` list with `X-Cron-Secret`. No arbitrary path fan-out.

### Residual

- Staging/prod operators must rotate any `CRON_SECRET` shorter than 32 chars before Wave 4 deploy (fail-closed).
- Workflow email-action token replay/expiry audit remains SEC-002 (not cron HMAC).

## Wave 5 — XSS / HTML / uploads / signed URLs (2026-09-08)

### Landed

| Surface | Change |
|---------|--------|
| `sanitizeRichHtml` (web utils + Expo `apps/app`) | `allowedStyles` whitelist (color/bg/align/font/decoration); anchors get `rel=noopener noreferrer`; Expo `RichHtml` sanitizes before `dangerouslySetInnerHTML` |
| Email templates (`apps/api` `templates.ts`) | Free-text `${data.*}` HTML interpolations wrapped in `escapeHtml`; subjects left plain-text (no HTML entities) |
| Avatar uploads (`validateUpload`) | Public `avatars` MIME = jpeg/png/webp only; `image/svg+xml` only when `purpose === "avatar-generator"` |
| Signed URLs (`getSignedUrl`) | Ownership check (`uploadedBy`); regression tests for 404 / Forbidden / owner OK |
| HTML inventory | `pnpm security:dangerously-html` → 6 sinks, 0 REVIEW |

### Residual

- Expo Bearer-in-storage XSS blast radius remains (SEC-003) — sanitizing HTML sinks reduces injection paths but does not remove token-in-storage risk.
- Static CSS sinks (print invoice, chart) remain intentional; documented in `htmlSinkNotes`.

## Wave 6 — raw SQL / soft-delete / RLS (2026-09-08)

### Landed

| Surface | Change |
|---------|--------|
| Attendance leave raw SQL (API + `@nexora/core`) | `hasApprovedLeaveOnDate` / `findApprovedLeavesInRange` add `AND deleted_at IS NULL` on `leave_requests` |
| Admin usage rollups | Soft-deleted users excluded (`u.deleted_at IS NULL`); soft-deleted `file_uploads` excluded from per-user + workspace storage CTEs |
| RLS docs (`packages/db/drizzle/0002_rls.sql`) | Header documents Hyperdrive owner bypass → **application-layer tenancy only** for ERP |
| Ban review | No attacker-controlled SQL fragment found; `$queryRawUnsafe` / `sql.raw` sites use `$n` binds or module table allowlists (`BUSINESS_UNIT_TABLES`, ARIA vectors) |

### Accepted / residual

| id | Finding | Disposition |
|----|---------|-------------|
| SEC-010 | Soft-deleted leave counted as attendance leave | **fixed** |
| SEC-011 | Soft-deleted users/uploads inflated admin usage | **fixed** |
| SEC-012 | ARIA `$queryRawUnsafe` for embeddings | **accepted** — SQL fixed; vector + limit bound as `$1`/`$2` |
| SEC-013 | `sql.raw` table names in business-unit strip | **accepted** — table list is module constant, not request input |
| SEC-014 | RLS enabled but Hyperdrive is DB owner | **accepted / documented** — ERP isolation is app-layer (Wave 3); do not claim RLS enforces Worker tenancy |

### Tests

- `attendance.repository.soft-delete.test.ts` asserts leave raw SQL includes `deleted_at IS NULL`.

## Wave 7 — CI security baseline (2026-09-08)

### Landed

| Surface | Change |
|---------|--------|
| Depot `pr-checks.yml` | Jobs `security-audit` (warn-only `pnpm audit --prod --audit-level=high`), `secret-scan` (gitleaks working-tree, fail-closed), `security-inventory` (`security:ungated-routes` + `security:dangerously-html` with `--fail`); all wired into Validate |
| `.gitleaks.toml` | Allowlists docs/agents/build artifacts + investor localStorage false positives; **working-tree scan only** (`--no-git`) — full-history findings in retired paths remain residual debt |
| Deploy staging / production | Fail-closed require `BETTER_AUTH_SECRET` + `CRON_SECRET` (min 32 chars); staging also puts `CRON_SECRET` on edge + edge-jobs Workers |
| GitHub `pr-checks.yml` | Parity jobs (Actions disabled; kept for future re-enable) |

### Residual

| id | Finding | Disposition |
|----|---------|-------------|
| SEC-008 | No CI audit/secret-scan | **fixed** (audit warn-only until advisories triaged; then ratchet to fail-closed) |
| SEC-015 | `pnpm audit --prod` high advisories (transitive `image-size` via Expo metro) | **accepted / warn** — triage + upgrade path before fail-closed |
| SEC-016 | Full-history gitleaks noise in retired paths | **accepted** — Wave 7 gates working tree; history cleanup is separate debt |

### Verify

- Local: `gitleaks detect --no-git --config .gitleaks.toml` → no leaks.
- Local: `pnpm security:ungated-routes -- --fail` + `pnpm security:dangerously-html -- --fail` → clean.

## Wave 8 — Finance deep-dive (2026-09-08)

### Findings fixed

| id | Sev | Finding | Fix |
|----|-----|---------|-----|
| SEC-017 | P0 | Company-wide payslip list/export/download gated only on `payroll:read`, which every employee seed role holds for `/my-payslips*` → salary-PII IDOR | Edge + Express: manager gate (`payroll:create` \| `payroll:approve` \| `payroll:hr-admin`) on flat HR payslip surfaces; `/my-payslips*` stays auth-only |
| SEC-018 | P1 | Journals / quotes listed and mutated without own-document scoping (invoices already scoped) | Edge (`@nexora/core`) + Express: `createdBy` filter on list; assert access helpers on get/update/delete/send/convert |

### Residual (Finance batch)

| id | Finding | Disposition |
|----|---------|-------------|
| SEC-019 | Expenses / cash-advance / vendors still lack `organizationId` tenancy | deferred — org tenancy plan; Wave 3 debt |
| SEC-020 | Soft-delete restore IDOR already covered for journals/invoices; quotes soft-delete path not separately audited this batch | follow-up in Finance residual or Wave 8 CRM if quotes gain soft-delete |

### Verify

- `pnpm --filter @nexora/api exec vitest run src/modules/accounting/accounting.service.test.ts` (own-doc + Wave 8 journal/quote cases).

## Wave 8 — HR deep-dive (2026-09-08)

### Findings fixed

| id | Sev | Finding | Fix |
|----|-----|---------|-----|
| SEC-021 | P1 | `certificate:read` treated as org-wide list/download (seed historically HR-only, but custom roles with read would see all) | Edge + Express: `certificate:manage` = org-wide; `certificate:read` = own recipient only; download auth-only path still owner-or-manage |
| SEC-022 | P1 | Travel get-by-id / decisions / linked expenses only allowed owner or `travel:hr-read`, while list already includes manager team — managers & assigned approvers got 403 on detail | Edge (`@nexora/core`) + Express: `assertCanViewTravelRequest` allows HR-all-read, owner, `employee.reportingTo`, or decision `approverUserId` |
| SEC-023 | P1 | `hrms:attendance-read` treated as org-wide for live/dashboard/department/correction `scope=all` (+ analytics/executive dumps) | Manage-only for org dumps; read\|manage for another employee's monthly/calendar report |

### Residual (HR batch)

| id | Finding | Disposition |
|----|---------|-------------|
| SEC-024 | Leave / visa already owner-or-HR; not re-audited beyond spot-check | accepted for this batch |
| SEC-025 | ESOP / agreements signed-URL ownership covered in Wave 5; no new finding | n/a |

### Verify

- `pnpm --filter @nexora/api exec vitest run src/modules/travel/travel.service.test.ts` (Wave 8 manager/approver/stranger getRequestById cases).

## Wave 8 — CRM / projects deep-dive (2026-09-08)

### Findings fixed

| id | Sev | Finding | Fix |
|----|-----|---------|-----|
| SEC-026 | P0 | Team CRM `/dashboard` + `/reminder-settings` GET accepted `*:crm:read` / `projects:read` (employee seed) while services return org-wide aggregates/settings | Edge (it/product/legal/accounting/qa): org-read gate = `*:crm:read-all` \| `*:crm:manage` \| `projects:read-all` \| `projects:manage`; Express IT CRM same; Express shared CRM reminder settings drop bare module/`projects:read` (sales → `crm:settings-manage` only) |
| SEC-027 | P0 | `investor-updates:read` (employee seed) listed/fetched **drafts** with no create/send check | Edge (`@nexora/core`) + Express: bare read forces `status=sent` on list; draft get → 404; update/delete/send go through scoped get |
| SEC-028 | P1 | Approval-chain GET used `projects:read` while writes were system-admin — leaked approver identities / step order to every employee | Edge: GET `/` and `/:scope` require `requireSystemAdmin` |

### Residual (CRM batch)

| id | Finding | Disposition |
|----|---------|-------------|
| SEC-029 | Deals `canSeeAll` uses `crm:team-read` (manager seed) rather than `deals:manage` — intentional team visibility; tightening to manage-only would regress managers | accepted; document, do not flip without product sign-off |
| SEC-030 | Partners / dataroom permission-only (no owner scope); proposals already pass actor in places | follow-up if product wants owner-scoped partners/dataroom |
| SEC-031 | CRM / project tables still lack `organizationId` | deferred — Wave 3 org tenancy debt |

### Verify

- Manual: employee with only `projects:read` / `*:crm:read` → 403 on team CRM dashboard + reminder-settings GET; 200 on membership-scoped list.
- Manual: `investor-updates:read` only → list/get drafts 404/empty; create/send holders still see drafts.
- Manual: non-admin → 403 on approval-chain GET.

## Wave 8 — Content / comms deep-dive (2026-09-08)

### Findings fixed

| id | Sev | Finding | Fix |
|----|-----|---------|-----|
| SEC-032 | P0 | Company news `PUT` allowed any holder of `news:create` to edit any post (author IDOR) | Edge (`@nexora/core`) + Express: update requires author **or** `news:delete` (moderation) |
| SEC-033 | P1 | Docs wiki: bare `docs:read` could pass `includeUnpublished` / open drafts by id/slug | Edge + Express: unpublished list/tree/get only for `docs:create` \| `docs:update` (or system admin); others get drafts forced off / 404 (creator still sees own draft) |
| SEC-034 | P1 | Policies list was entity-scoped but get + attachment download were not | Edge + Express: get/download assert readable (active + global or viewer's entity; manage bypass); miss → 404 |
| SEC-035 | P1 | Legal announcements get/attachment/ack ignored entity + publish gates that list already applied | Express: `assertReadable` on get, attachment signed URL, and ack (published + entity match for non-manage) |

### Residual (Content batch)

| id | Finding | Disposition |
|----|---------|-------------|
| SEC-036 | Edge `packages/core` legal-announcements service remains a stub (empty list / `{ id }` get); Express is source of truth for SEC-035 | follow-up when edge legal is fully ported — stub cannot leak real rows today |
| SEC-037 | Wall / surveys / messages / uploads spot-check: owner or membership gates already present | accepted; no change this batch |
| SEC-038 | Blogs / PR not on employee permission seed | accepted; out of employee blast radius |

### Verify

- Manual: `news:create` only → update own post 200; update colleague's post 403; `news:delete` can moderate.
- Manual: `docs:read` only → `includeUnpublished=true` ignored; draft id/slug → 404; editors still see drafts.
- Manual: `policy:read` on entity A → get/download entity B policy → 404.
- Manual: legal announcement-read on entity A → get/download/ack entity B or draft → 404.
- `pnpm --filter @nexora/core --filter @nexora/api --filter @nexora/edge exec tsc --noEmit`

## Wave 8 — AI / ARIA deep-dive (2026-09-08)

### Findings fixed

| id | Sev | Finding | Fix |
|----|-----|---------|-----|
| SEC-039 | P0 | `list_expiring_visas` ARIA tool advertised/ran with only `visa:read` (self-scoped elsewhere) → org-wide visa expiry dump | Advertise + run only for `visa:hr-read` \| `visa:manage` (Express tools + `@nexora/core` registry) |
| SEC-040 | P0 | `lookup_project` returned unscoped org projects to any `projects:read` holder | Mirror ProjectService.list: without `projects:read-all`, filter to owner **or** membership |
| SEC-041 | P1 | `/insights`, `/improvement-queue`, draft-article, feedback review under `aria:knowledge-manage` exposed other users' chat text | Gate those four routes with `requireSystemAdmin()` (same bar as aria-training) |
| SEC-042 | P2 | Conversation get/delete/chat + knowledge ACL miss returned **403** (existence oracle) | Ownership / ACL miss → **404** (parity with edge conversation helpers) |

### Residual (AI batch)

| id | Finding | Disposition |
|----|---------|-------------|
| SEC-043 | Edge `streamChat` still stubs until AI keys / runtime are wired; does not yet bind tool RBAC on the Worker path | follow-up when edge AI runtime lands — Express remains SoT for chat tools today |
| SEC-044 | Knowledge corpus CRUD stays on `aria:knowledge-manage` (article bodies, not live chat) | accepted; chat-exposing admin surfaces are system-admin only (SEC-041) |
| SEC-045 | Prompt-injection / PII-in-logs review deferred to `ai-prompts.ts` hardening pass | follow-up; not a new IDOR this batch |

### Verify

- Manual / eval: `visa:read` only → `list_expiring_visas` not advertised; handler denies; `visa:hr-read` can run.
- Manual: `projects:read` without `projects:read-all` → `lookup_project` only returns owned/member projects.
- Manual: non-system-admin with `aria:knowledge-manage` → 403 on insights / improvement-queue / draft-article / review.
- Manual: stranger conversation id → 404 on get/delete/chat; knowledge ACL miss → 404.
- `pnpm --filter @nexora/core --filter @nexora/api --filter @nexora/edge exec tsc --noEmit`
- `pnpm --filter @nexora/api exec vitest run src/modules/aria/__tests__/aria-tools.eval.test.ts src/modules/aria/__tests__/aria-feedback.test.ts`

## Wave 8 — Admin / telemetry / push deep-dive (2026-09-08)

### Findings fixed

| id | Sev | Finding | Fix |
|----|-----|---------|-----|
| SEC-046 | P1 | Edge push `deleteByEndpoint` ignored `userId` — any auth user could unsubscribe another device | Scope delete with `and(endpoint, userId)`; return `{ removed, count }` |
| SEC-047 | P1 | Org `admin:manage` could edit any user’s module access + write `security.*` settings with no system-admin gate | Module-access goes through `assertActorCanAccessUser`; `security.*` settings require `isSystemAdmin` |
| SEC-048 | P1 | Express `users.getById` had no actor/org check (salary / passport / tax PII) | Pass `req.user.id`; assert active-org membership (404 out-of-org, same as list) |
| SEC-049 | P2 | Edge `POST /push/test` always registered in production | Return 404 when `NODE_ENV === "production"` (Express parity) |
| SEC-050 | P2 | Push subscribe echoed `auth` / `p256dh` secrets | Strip secrets from subscribe response |
| SEC-051 | P2 | Express `GET /integrations/google/probe` leaked live Google token diagnostics | Remove diagnostic route |
| SEC-052 | P2 | Marketing drift-settings GET readable with dashboard perms (recipient emails) | Gate GET on `ADMIN_MANAGE` |

### Residual (Admin batch)

| id | Finding | Disposition |
|----|---------|-------------|
| SEC-053 | Telemetry ingest still auth-gated but payload schema may accept free-form client fields | accepted for this batch; tighten field allowlist in a follow-up if PII shows up in warehouses |
| SEC-054 | Express push module (if still mounted) should keep the same ownership + secret-stripping invariants as edge | follow-up if Express push remains in the dual-stack window |

### Verify

- Manual: user A cannot unsubscribe user B’s push endpoint (removed=false).
- Manual: non-system-admin with `admin:manage` → 403 on `security.*` settings write; cannot read/write module-access for users outside active org.
- Manual: org member → `GET /users/:id` for outsider → 404; in-org colleague with salary fields → 200.
- Manual: production `POST /push/test` → 404; subscribe response has no auth/p256dh.
- Manual: `GET /integrations/google/probe` → 404/gone; drift-settings GET without `admin:manage` → 403.
- `pnpm --filter @nexora/core --filter @nexora/api --filter @nexora/edge exec tsc --noEmit`
- `pnpm --filter @nexora/core exec vitest run src/push/push.service.test.ts src/admin/admin.service.test.ts`
- `pnpm --filter @nexora/api exec vitest run src/modules/users/users.service.test.ts`

